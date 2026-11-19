"""
TaxCap Studio - Bước 3B: Huấn luyện model CRNN + CTC nhẹ xuất ONNX (<150ms)
Chạy từ thư mục gốc dự án sau khi tích lũy >= 300-500 mẫu/cổng:
  pip install -r scripts/requirements-train.txt
  python scripts/train_ocr.py --portal hddt --dataset dataset/
  # Hoặc từ file zip đã xuất:
  python scripts/train_ocr.py --portal dvc --zip taxcap-dataset.zip
"""

import argparse
import io
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
BLANK_IDX = 0
CHAR_TO_IDX = {ch: i + 1 for i, ch in enumerate(CHARSET)}
IDX_TO_CHAR = {i + 1: ch for i, ch in enumerate(CHARSET)}
INPUT_WIDTH = 160
INPUT_HEIGHT = 48


def preprocess_pil(img: Image.Image) -> np.ndarray:
    gray = img.convert("L").resize((INPUT_WIDTH, INPUT_HEIGHT), Image.Resampling.BILINEAR)
    arr = np.asarray(gray, dtype=np.float32) / 255.0
    return arr[None, :, :]  # (1, H, W)


def load_records(portal: str, dataset_dir: str | None, zip_path: str | None):
    records = []
    if zip_path:
        with zipfile.ZipFile(zip_path, "r") as zf:
            lines = zf.read("labels.jsonl").decode("utf-8").splitlines()
            for line in lines:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("portal") != portal:
                    continue
                label = "".join(c for c in row.get("label", "") if c in CHAR_TO_IDX)
                if len(label) < 2:
                    continue
                img_bytes = zf.read(row["image"])
                records.append((img_bytes, label))
    elif dataset_dir:
        base = Path(dataset_dir)
        events_file = base / "events.jsonl"
        if not events_file.exists():
            raise FileNotFoundError(f"Không tìm thấy {events_file}")
        by_id = {}
        for line in events_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            ev = json.loads(line)
            if ev.get("type") == "solve":
                by_id[ev["sampleId"]] = {
                    "portal": ev["portal"],
                    "imageFile": ev["imageFile"],
                    "predicted": ev["predicted"],
                    "finalLabel": ev["predicted"],
                    "outcome": "pending",
                }
            elif ev.get("type") == "feedback" and ev.get("sampleId") in by_id:
                s = by_id[ev["sampleId"]]
                s["outcome"] = ev["outcome"]
                s["finalLabel"] = ev.get("finalLabel") or s["predicted"]
        for s in by_id.values():
            if s["portal"] != portal or s["outcome"] not in ("verified", "corrected"):
                continue
            label = "".join(c for c in s["finalLabel"] if c in CHAR_TO_IDX)
            img_path = base / "images" / s["imageFile"]
            if len(label) >= 2 and img_path.exists():
                records.append((img_path.read_bytes(), label))
    return records


class CaptchaDataset(Dataset):
    def __init__(self, items):
        self.items = items

    def __len__(self):
        return len(self.items)

    def __getitem__(self, idx):
        raw_bytes, label = self.items[idx]
        img = Image.open(io.BytesIO(raw_bytes))
        x = torch.from_numpy(preprocess_pil(img))
        y = torch.tensor([CHAR_TO_IDX[c] for c in label], dtype=torch.long)
        return x, y, label


def collate_fn(batch):
    xs = torch.stack([b[0] for b in batch], dim=0)
    targets = torch.cat([b[1] for b in batch], dim=0)
    target_lengths = torch.tensor([len(b[1]) for b in batch], dtype=torch.long)
    labels = [b[2] for b in batch]
    return xs, targets, target_lengths, labels


class TinyCRNN(nn.Module):
    def __init__(self, num_classes: int):
        super().__init__()
        self.cnn = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(32, 64, 3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(64, 128, 3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d((1, 40)),
        )
        self.rnn = nn.GRU(128, 128, num_layers=2, bidirectional=True, batch_first=False)
        self.fc = nn.Linear(256, num_classes)

    def forward(self, x):
        feat = self.cnn(x).squeeze(2)  # (B, 128, T=40)
        seq = feat.permute(2, 0, 1)  # (T, B, 128)
        out, _ = self.rnn(seq)
        return self.fc(out)  # (T, B, num_classes)


def ctc_greedy_decode(logits: torch.Tensor) -> list[str]:
    preds = logits.argmax(dim=-1).permute(1, 0).tolist()
    decoded = []
    for seq in preds:
        chars = []
        prev = BLANK_IDX
        for idx in seq:
            if idx != BLANK_IDX and idx != prev:
                chars.append(IDX_TO_CHAR.get(idx, ""))
            prev = idx
        decoded.append("".join(chars))
    return decoded


def main():
    parser = argparse.ArgumentParser(description="Train TaxCap local ONNX OCR model")
    parser.add_argument("--portal", required=True, choices=["hddt", "tdt", "dvc", "tracuunnt"])
    parser.add_argument("--dataset", default="dataset")
    parser.add_argument("--zip", default=None)
    parser.add_argument("--epochs", type=int, default=35)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--out-dir", default="models")
    args = parser.parse_args()

    records = load_records(args.portal, args.dataset, args.zip)
    if len(records) < 30:
        print(f"Cổng {args.portal} mới có {len(records)} mẫu sạch (khuyến nghị tối thiểu 300 mẫu).")
        if len(records) < 5:
            raise SystemExit(1)

    split = max(1, int(len(records) * 0.85))
    train_ds = CaptchaDataset(records[:split])
    val_ds = CaptchaDataset(records[split:] if split < len(records) else records[:])
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, collate_fn=collate_fn)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, collate_fn=collate_fn)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = TinyCRNN(len(CHARSET) + 1).to(device)
    criterion = nn.CTCLoss(blank=BLANK_IDX, zero_infinity=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)

    best_acc = 0.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for xs, targets, target_lengths, _ in train_loader:
            xs = xs.to(device)
            targets = targets.to(device)
            logits = model(xs)
            log_probs = logits.log_softmax(dim=-1)
            input_lengths = torch.full((xs.size(0),), logits.size(0), dtype=torch.long)
            loss = criterion(log_probs, targets, input_lengths, target_lengths)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        model.eval()
        correct = 0
        total = 0
        with torch.no_grad():
            for xs, _, _, labels in val_loader:
                preds = ctc_greedy_decode(model(xs.to(device)))
                for p, gt in zip(preds, labels):
                    total += 1
                    if p == gt:
                        correct += 1
        acc = (correct / total) * 100.0 if total else 0.0
        if acc >= best_acc:
            best_acc = acc
        if epoch % 5 == 0 or epoch == args.epochs:
            print(f"[Epoch {epoch}/{args.epochs}] Val exact match: {acc:.1f}%")

    os.makedirs(args.out_dir, exist_ok=True)
    onnx_path = Path(args.out_dir) / f"{args.portal}.onnx"
    meta_path = Path(args.out_dir) / f"{args.portal}.meta.json"
    dummy = torch.randn(1, 1, INPUT_HEIGHT, INPUT_WIDTH, device=device)
    model.eval()
    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch"}, "logits": {1: "batch"}},
        opset_version=17,
    )
    meta = {
        "portal": args.portal,
        "charset": CHARSET,
        "inputWidth": INPUT_WIDTH,
        "inputHeight": INPUT_HEIGHT,
        "confidenceThreshold": 0.9,
        "sampleCountTrained": len(records),
        "valAccuracyPercent": round(best_acc, 1),
        "trainedAt": datetime.now(timezone.utc).isoformat(),
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"Đã xuất model: {onnx_path} (Server Node sẽ tự nạp lại).")


if __name__ == "__main__":
    main()
