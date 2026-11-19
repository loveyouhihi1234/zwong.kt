(() => {
  if (window.__taxcapCommonLoaded) return;
  window.__taxcapCommonLoaded = true;
  const MAX_AUTO_RETRIES = 3;
  const inputStates = new WeakMap();
  const inputWidgets = new WeakMap();
  const EXT_ID = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "taxcap-suite";

  function sendFeedback(st, outcome, finalLabel) {
    if (!st.lastSampleId || st.feedbackSent) return;
    st.feedbackSent = true;
    chrome.runtime
      .sendMessage({
        type: "TAXCAP_FEEDBACK",
        sampleId: st.lastSampleId,
        outcome,
        finalLabel,
      })
      .catch(() => {});
  }

  function getState(input) {
    let st = inputStates.get(input);
    if (!st) {
      st = {
        status: "idle",
        attempts: 0,
        lastKey: null,
        solving: false,
        lastSampleId: "",
        predictedCode: "",
        feedbackSent: false,
      };
      inputStates.set(input, st);
      input.addEventListener("input", (e) => {
        if (e.isTrusted) {
          st.attempts = 0;
          st.status = "idle";
          renderWidget(input, st);
        }
      });

      const form = input.form || input.closest("form");
      if (form) {
        form.addEventListener("submit", () => {
          const val = String(input.value || "").trim().replace(/[^A-Za-z0-9]/g, "");
          if (!st.lastSampleId || st.feedbackSent || val.length < 2) return;
          const outcome = val === st.predictedCode ? "verified" : "corrected";
          sendFeedback(st, outcome, val);
        });
      }
    }
    return st;
  }

  /**
   * Điền giá trị an toàn cho React / Ant Design / jQuery / JSP mà KHÔNG tự submit form.
   */
  function fillInputSafely(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function ensureWidget(input, onManualRetry) {
    let widget = inputWidgets.get(input);
    if (widget && widget.host.isConnected) return widget;

    const anchor =
      input.closest(".ant-input-affix-wrapper") ||
      input.closest(".input-group") ||
      input;

    // Dọn dẹp widget cũ còn sót lại của chính TaxCap Suite sau khi reload extension
    let sibling = anchor.nextElementSibling;
    while (sibling && sibling.dataset?.taxcapWidget === "1") {
      const next = sibling.nextElementSibling;
      if (sibling.dataset.taxcapExtId === EXT_ID) {
        sibling.remove();
      }
      sibling = next;
    }

    const host = document.createElement("div");
    host.dataset.taxcapWidget = "1";
    host.dataset.taxcapExtId = EXT_ID;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host {
          display: block;
          margin-top: 4px;
          font: 12px/1.35 "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        .bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 20px;
        }
        .msg {
          color: #475569;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .msg.reading { color: #0b6bcb; }
        .msg.filled { color: #15803d; font-weight: 500; }
        .msg.failed { color: #b45309; }
        .msg.locked { color: #b91c1c; font-weight: 500; }
        .retry-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          height: 22px;
          padding: 0 7px;
          border-radius: 999px;
          border: 1px solid #cbd5e1;
          background: #ffffff;
          color: #334155;
          font: inherit;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          flex-shrink: 0;
        }
        .retry-btn:hover { background: #f1f5f9; border-color: #94a3b8; }
        .retry-btn:disabled { opacity: 0.5; cursor: wait; }
        .spin {
          display: inline-block;
          animation: taxcap-spin 0.8s linear infinite;
        }
        @keyframes taxcap-spin { to { transform: rotate(360deg); } }
      </style>
      <div class="bar">
        <span class="msg"></span>
        <button type="button" class="retry-btn" title="Giải lại ảnh captcha này (TaxCap)">
          <span class="icon">↻</span>
          <span>Giải lại</span>
        </button>
      </div>
    `;

    const msgEl = root.querySelector(".msg");
    const retryBtn = root.querySelector(".retry-btn");
    const iconEl = root.querySelector(".icon");

    retryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onManualRetry();
    });

    // Chèn ngay sau wrapper của AntD/Bootstrap nếu có, tránh lọt vào trong flex input-group
    anchor.insertAdjacentElement("afterend", host);

    widget = { host, msgEl, retryBtn, iconEl };
    inputWidgets.set(input, widget);
    return widget;
  }

  function renderWidget(input, st) {
    const widget = inputWidgets.get(input);
    if (!widget) return;
    const { msgEl, retryBtn, iconEl } = widget;
    msgEl.className = `msg ${st.status}`;
    retryBtn.disabled = st.solving;
    iconEl.className = st.solving ? "icon spin" : "icon";

    if (st.status === "reading") {
      msgEl.textContent = "Đang đọc...";
    } else if (st.status === "filled") {
      msgEl.textContent = "Đã điền (kiểm tra lại)";
    } else if (st.status === "failed") {
      msgEl.textContent = st.errorText || "Không đọc được, bấm thử lại";
    } else if (st.status === "locked") {
      msgEl.textContent = `Đã tự thử lại ${st.attempts}/${MAX_AUTO_RETRIES} lần — tự nhập hoặc bấm Giải lại`;
    } else {
      msgEl.textContent = "";
    }
  }

  function canvasToCompactDataUrl(canvas) {
    const webp = canvas.toDataURL("image/webp", 0.88);
    if (webp.startsWith("data:image/webp")) return webp;
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  function enhanceCanvasPixels(ctx, width, height) {
    try {
      const imgData = ctx.getImageData(0, 0, width, height);
      const data = imgData.data;
      const total = width * height;
      if (!total) return;

      const lum = new Uint8Array(total);
      const hist = new Uint32Array(256);
      for (let i = 0; i < total; i++) {
        const p = i * 4;
        const alpha = data[p + 3];
        let l;
        if (alpha < 24) {
          l = 255;
        } else {
          const a = alpha / 255;
          const r = data[p] * a + 255 * (1 - a);
          const g = data[p + 1] * a + 255 * (1 - a);
          const b = data[p + 2] * a + 255 * (1 - a);
          l = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
        }
        lum[i] = l;
        hist[l] += 1;
      }

      const lowTarget = Math.max(1, Math.floor(total * 0.08));
      const highTarget = Math.max(lowTarget + 1, Math.floor(total * 0.72));
      let cum = 0;
      let darkFloor = 0;
      let bgCeiling = 255;
      let foundLow = false;
      for (let v = 0; v < 256; v++) {
        cum += hist[v];
        if (!foundLow && cum >= lowTarget) {
          darkFloor = v;
          foundLow = true;
        }
        if (cum >= highTarget) {
          bgCeiling = v;
          break;
        }
      }

      const cutoff = Math.min(248, Math.round(bgCeiling * 0.92));
      const span = cutoff - darkFloor;
      const gray = new Uint8Array(total);
      if (span < 16) {
        for (let i = 0; i < total; i++) {
          gray[i] = lum[i] > 235 ? 255 : lum[i];
        }
      } else {
        for (let i = 0; i < total; i++) {
          const l = lum[i];
          if (l >= cutoff) {
            gray[i] = 255;
          } else {
            const norm = Math.max(0, Math.min(1, (l - darkFloor) / span));
            gray[i] = Math.round(10 + Math.pow(norm, 1.15) * 226);
          }
        }
      }

      const cleaned = new Uint8Array(gray);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = y * width + x;
          const val = gray[idx];
          if (val > 130 && val < 255) {
            let whiteNeighbors = 0;
            if (gray[idx - width - 1] >= 245) whiteNeighbors++;
            if (gray[idx - width] >= 245) whiteNeighbors++;
            if (gray[idx - width + 1] >= 245) whiteNeighbors++;
            if (gray[idx - 1] >= 245) whiteNeighbors++;
            if (gray[idx + 1] >= 245) whiteNeighbors++;
            if (gray[idx + width - 1] >= 245) whiteNeighbors++;
            if (gray[idx + width] >= 245) whiteNeighbors++;
            if (gray[idx + width + 1] >= 245) whiteNeighbors++;
            if (whiteNeighbors >= 7) cleaned[idx] = 255;
          }
        }
      }

      for (let i = 0; i < total; i++) {
        const p = i * 4;
        const v = cleaned[i];
        data[p] = v;
        data[p + 1] = v;
        data[p + 2] = v;
        data[p + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
    } catch {
      // Giữ ảnh gốc nếu trình duyệt chặn đọc pixel
    }
  }

  /**
   * Đọc trực tiếp pixel từ thẻ <img> đang render (không fetch lại URL để tránh mất session).
   * Phóng đại 1.85x trên nền trắng, lọc nhiễu + tăng tương phản (Bước 2) và nén WebP/JPEG nhẹ.
   */
  async function readCanvasImage(img, enhance = true) {
    if (!img.complete) {
      await new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
        setTimeout(resolve, 2000);
      });
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    try {
      const scale = w < 220 ? 1.85 : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d", enhance ? { willReadFrequently: true } : undefined);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (enhance) {
        enhanceCanvasPixels(ctx, canvas.width, canvas.height);
      }
      return canvasToCompactDataUrl(canvas);
    } catch {
      return null;
    }
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function imageKeyFor(img) {
    const src = img.currentSrc || img.getAttribute("src") || "";
    if (!src) return "";
    return `${hashString(src)}:${src.length}:${img.naturalWidth}x${img.naturalHeight}`;
  }

  async function getPortalSettings() {
    let settings = null;
    try {
      settings = await chrome.runtime.sendMessage({ type: "TAXCAP_GET_SETTINGS" });
    } catch {
      settings = null;
    }
    if (!settings) {
      try {
        const res = await chrome.storage.local.get("taxcapSettings");
        settings = res?.taxcapSettings || { enabled: true, pausedUntil: 0, enhanceImage: true, portals: {} };
      } catch {
        return null;
      }
    }
    return settings;
  }

  function isSettingsPortalActive(settings, portal) {
    if (!settings?.licenseGate?.unlocked) return false;
    if (!settings?.enabled) return false;
    if (Date.now() < (settings.pausedUntil || 0)) return false;
    return settings.portals?.[portal] !== false;
  }

  window.taxcapWatchCaptchas = function ({ portal, findPairs, readImage = readCanvasImage, tryLocalSolve = null }) {
    let scanTimer = null;

    async function solvePair(img, input, manual = false, enhance = true) {
      const st = getState(input);
      ensureWidget(input, async () => {
        const latestSettings = await getPortalSettings();
        solvePair(img, input, true, latestSettings?.enhanceImage !== false);
      });

      const key = imageKeyFor(img);
      if (!key) return;

      if (manual) {
        if (st.lastSampleId && !st.feedbackSent) {
          const edited = String(input.value || "").trim().replace(/[^A-Za-z0-9]/g, "");
          if (edited && edited !== st.predictedCode) {
            sendFeedback(st, "corrected", edited);
          } else {
            sendFeedback(st, "rejected", "");
          }
        }
        st.attempts = 1;
      } else {
        if (st.solving) return;
        if (st.lastKey === key && st.status !== "idle") return;
        if (st.attempts >= MAX_AUTO_RETRIES) {
          st.status = "locked";
          st.lastKey = key;
          renderWidget(input, st);
          return;
        }
        st.attempts += 1;
      }

      st.lastKey = key;
      st.errorText = "";
      st.lastSampleId = "";
      st.predictedCode = "";
      st.feedbackSent = false;

      // Tầng 0 (vd. SVG mẫu font cho HĐĐT): giải tức thì trong trình duyệt khi chạy tự động;
      // bấm Giải lại (manual) hoặc trả về null sẽ tự động chuyển sang Proxy (Trí nhớ / ONNX / Gemini).
      if (!manual && typeof tryLocalSolve === "function") {
        let localRes = null;
        try {
          localRes = tryLocalSolve(img);
        } catch {
          localRes = null;
        }
        if (localRes?.captcha) {
          fillInputSafely(input, localRes.captcha);
          st.predictedCode = localRes.captcha;
          st.status = "filled";
          st.solving = false;
          renderWidget(input, st);

          // Ghi nhận thống kê & lưu mẫu vào Kho Dữ liệu (không chặn luồng điền, không báo lỗi nếu Proxy tắt)
          Promise.resolve(readImage(img, enhance))
            .then((compactImage) =>
              chrome.runtime.sendMessage({
                type: "TAXCAP_RECORD_LOCAL",
                portal,
                captcha: localRes.captcha,
                confidence: localRes.confidence,
                latencyMs: localRes.latencyMs,
                image: compactImage || "",
              }),
            )
            .then((res) => {
              if (res?.sampleId && st.predictedCode === localRes.captcha) {
                st.lastSampleId = res.sampleId;
              }
            })
            .catch(() => {});
          return;
        }
      }

      st.status = "reading";
      st.solving = true;
      renderWidget(input, st);

      try {
        const compactImage = await readImage(img, enhance);
        if (!compactImage) {
          st.status = st.attempts >= MAX_AUTO_RETRIES ? "locked" : "failed";
          st.errorText = "Không đọc được ảnh captcha";
          return;
        }
        const res = await chrome.runtime.sendMessage({
          type: "TAXCAP_SOLVE",
          portal,
          image: compactImage,
          bypassCache: manual,
        });
        if (res?.ok && res.captcha) {
          fillInputSafely(input, res.captcha);
          st.lastSampleId = res.sampleId || "";
          st.predictedCode = res.captcha;
          st.feedbackSent = false;
          st.status = "filled";
        } else {
          st.status = st.attempts >= MAX_AUTO_RETRIES ? "locked" : "failed";
          st.errorText = res?.message || "Không đọc được, bấm thử lại";
        }
      } catch {
        st.status = st.attempts >= MAX_AUTO_RETRIES ? "locked" : "failed";
        st.errorText = "Không đọc được, bấm thử lại";
      } finally {
        st.solving = false;
        renderWidget(input, st);
      }
    }

    async function scan() {
      const settings = await getPortalSettings();
      if (!isSettingsPortalActive(settings, portal)) return;
      const enhance = settings?.enhanceImage !== false;
      const pairs = findPairs();
      for (const { img, input } of pairs) {
        solvePair(img, input, false, enhance);
      }
    }

    const scheduleScan = () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 60);
    };

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style", "class"],
    });

    document.addEventListener("load", (e) => {
      if (e.target instanceof HTMLImageElement) scheduleScan();
    }, true);

    // Chạy ngay khi document_end để giải song song trong lúc người dùng nhập MST/mật khẩu
    scan();
    setTimeout(scan, 450);
  };

  window.taxcapReadCanvasImage = readCanvasImage;
})();
