import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {
  PORTAL_LIST,
  isValidPortal,
  sanitizeCaptchaText,
  type PortalId,
} from '../src/utils/captchaLogic.ts';
import {
  computePortalConfusionHints,
  type PortalLearnedHints,
} from '../src/utils/portalRules.ts';

export type SampleOutcome = 'pending' | 'verified' | 'corrected' | 'rejected';

export interface DatasetSolveEvent {
  type: 'solve';
  sampleId: string;
  timestamp: string;
  portal: PortalId;
  model: string;
  speedMode: string;
  latencyMs: number;
  predicted: string;
  imageFile: string;
  imageHash: string;
}

export interface DatasetFeedbackEvent {
  type: 'feedback';
  sampleId: string;
  timestamp: string;
  outcome: Exclude<SampleOutcome, 'pending'>;
  finalLabel: string;
}

export type DatasetEvent = DatasetSolveEvent | DatasetFeedbackEvent;

export interface DatasetSample {
  sampleId: string;
  timestamp: string;
  portal: PortalId;
  model: string;
  speedMode: string;
  latencyMs: number;
  predicted: string;
  finalLabel: string;
  outcome: SampleOutcome;
  imageFile: string;
  imageHash: string;
}

export interface PortalDatasetProgress {
  portal: PortalId;
  total: number;
  usable: number;
  verified: number;
  corrected: number;
  rejected: number;
  pending: number;
  accuracyPercent: number | null;
}

export interface DatasetSummaryStats {
  total: number;
  usable: number;
  verified: number;
  corrected: number;
  rejected: number;
  pending: number;
  accuracyPercent: number | null;
  byPortal: PortalDatasetProgress[];
}

export function foldDatasetEvents(events: DatasetEvent[]): DatasetSample[] {
  const byId = new Map<string, DatasetSample>();
  const order: string[] = [];

  for (const ev of events) {
    if (ev.type === 'solve') {
      if (!byId.has(ev.sampleId)) {
        order.push(ev.sampleId);
      }
      byId.set(ev.sampleId, {
        sampleId: ev.sampleId,
        timestamp: ev.timestamp,
        portal: ev.portal,
        model: ev.model,
        speedMode: ev.speedMode,
        latencyMs: ev.latencyMs,
        predicted: ev.predicted,
        finalLabel: ev.predicted,
        outcome: 'pending',
        imageFile: ev.imageFile,
        imageHash: ev.imageHash,
      });
    } else if (ev.type === 'feedback') {
      const existing = byId.get(ev.sampleId);
      if (!existing) continue;
      existing.outcome = ev.outcome;
      if (ev.outcome === 'verified') {
        existing.finalLabel = ev.finalLabel || existing.predicted;
      } else if (ev.outcome === 'corrected') {
        existing.finalLabel = ev.finalLabel || existing.predicted;
      } else if (ev.outcome === 'rejected') {
        existing.finalLabel = ev.finalLabel || '';
      }
    }
  }

  // Return newest first
  const result: DatasetSample[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const item = byId.get(order[i]);
    if (item) result.push(item);
  }
  return result;
}

export function computeDatasetStats(samples: DatasetSample[]): DatasetSummaryStats {
  let verified = 0;
  let corrected = 0;
  let rejected = 0;
  let pending = 0;

  const portalMap = new Map<PortalId, PortalDatasetProgress>();
  for (const p of PORTAL_LIST) {
    portalMap.set(p.id, {
      portal: p.id,
      total: 0,
      usable: 0,
      verified: 0,
      corrected: 0,
      rejected: 0,
      pending: 0,
      accuracyPercent: null,
    });
  }

  for (const s of samples) {
    const bucket = portalMap.get(s.portal);
    if (bucket) bucket.total += 1;
    if (s.outcome === 'verified') {
      verified += 1;
      if (bucket) bucket.verified += 1;
    } else if (s.outcome === 'corrected') {
      corrected += 1;
      if (bucket) bucket.corrected += 1;
    } else if (s.outcome === 'rejected') {
      rejected += 1;
      if (bucket) bucket.rejected += 1;
    } else {
      pending += 1;
      if (bucket) bucket.pending += 1;
    }
  }

  for (const bucket of portalMap.values()) {
    bucket.usable = bucket.verified + bucket.corrected;
    bucket.accuracyPercent =
      bucket.usable > 0 ? Math.round((bucket.verified / bucket.usable) * 100) : null;
  }

  const usable = verified + corrected;
  const accuracyPercent = usable > 0 ? Math.round((verified / usable) * 100) : null;

  return {
    total: samples.length,
    usable,
    verified,
    corrected,
    rejected,
    pending,
    accuracyPercent,
    byPortal: Array.from(portalMap.values()),
  };
}

export function mimeToExtension(mimeType: string): 'png' | 'webp' | 'jpg' {
  const m = mimeType.toLowerCase();
  if (m === 'image/webp') return 'webp';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  return 'png';
}

export function isSafeDatasetFilename(filename: string): boolean {
  return /^[a-zA-Z0-9_-]+\.(png|webp|jpg)$/.test(filename);
}

export function createDatasetStore(baseDir = path.resolve(process.cwd(), 'dataset')) {
  const imagesDir = path.join(baseDir, 'images');
  const eventsPath = path.join(baseDir, 'events.jsonl');

  let loaded = false;
  let events: DatasetEvent[] = [];
  let cachedHints: Record<PortalId, PortalLearnedHints> | null = null;
  let writeChain = Promise.resolve();

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    await fs.mkdir(imagesDir, { recursive: true });
    try {
      const raw = await fs.readFile(eventsPath, 'utf8');
      events = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as DatasetEvent];
          } catch {
            return [];
          }
        });
    } catch {
      events = [];
    }
    loaded = true;
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeChain.then(fn, fn);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function recordSolve(params: {
    portal: PortalId;
    model: string;
    speedMode: string;
    latencyMs: number;
    predicted: string;
    mimeType: string;
    base64Data: string;
  }): Promise<string> {
    return enqueue(async () => {
      await ensureLoaded();
      const imageHash = crypto.createHash('sha256').update(params.base64Data).digest('hex').slice(0, 24);
      const ext = mimeToExtension(params.mimeType);
      const imageFile = `${params.portal}_${imageHash}.${ext}`;
      const imagePath = path.join(imagesDir, imageFile);

      try {
        await fs.access(imagePath);
      } catch {
        await fs.writeFile(imagePath, Buffer.from(params.base64Data, 'base64'));
      }

      const sampleId = crypto.randomUUID();
      const event: DatasetSolveEvent = {
        type: 'solve',
        sampleId,
        timestamp: new Date().toISOString(),
        portal: isValidPortal(params.portal) ? params.portal : 'hddt',
        model: params.model,
        speedMode: params.speedMode,
        latencyMs: params.latencyMs,
        predicted: params.predicted,
        imageFile,
        imageHash,
      };
      events.push(event);
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
      return sampleId;
    });
  }

  async function recordFeedback(params: {
    sampleId: string;
    outcome: Exclude<SampleOutcome, 'pending'>;
    finalLabel?: string;
  }): Promise<DatasetSample | null> {
    return enqueue(async () => {
      await ensureLoaded();
      const current = foldDatasetEvents(events).find((s) => s.sampleId === params.sampleId);
      if (!current) return null;

      const cleanedLabel =
        params.outcome === 'rejected'
          ? ''
          : sanitizeCaptchaText(params.finalLabel || current.predicted) || current.predicted;

      const event: DatasetFeedbackEvent = {
        type: 'feedback',
        sampleId: params.sampleId,
        timestamp: new Date().toISOString(),
        outcome: params.outcome,
        finalLabel: cleanedLabel,
      };
      events.push(event);
      cachedHints = null;
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
      return foldDatasetEvents(events).find((s) => s.sampleId === params.sampleId) || null;
    });
  }

  async function getPortalHints(): Promise<Record<PortalId, PortalLearnedHints>> {
    await ensureLoaded();
    if (!cachedHints) {
      cachedHints = computePortalConfusionHints(foldDatasetEvents(events));
    }
    return cachedHints;
  }

  async function getAllSamples(): Promise<DatasetSample[]> {
    await ensureLoaded();
    return foldDatasetEvents(events);
  }

  async function getSnapshot(limit = 60): Promise<{
    stats: DatasetSummaryStats;
    samples: DatasetSample[];
    portalHints: Record<PortalId, PortalLearnedHints>;
  }> {
    await ensureLoaded();
    const all = foldDatasetEvents(events);
    if (!cachedHints) {
      cachedHints = computePortalConfusionHints(all);
    }
    return {
      stats: computeDatasetStats(all),
      samples: all.slice(0, limit),
      portalHints: cachedHints,
    };
  }

  async function getImagePath(filename: string): Promise<string | null> {
    if (!isSafeDatasetFilename(filename)) return null;
    await ensureLoaded();
    const target = path.join(imagesDir, filename);
    try {
      await fs.access(target);
      return target;
    } catch {
      return null;
    }
  }

  async function exportZipBuffer(): Promise<{ zipBuffer: Buffer; usableCount: number }> {
    await ensureLoaded();
    const all = foldDatasetEvents(events);
    const usable = all.filter(
      (s) => (s.outcome === 'verified' || s.outcome === 'corrected') && s.finalLabel.length >= 2,
    );

    const zip = new JSZip();
    const manifestLines: string[] = [];

    for (const sample of usable) {
      const imgPath = path.join(imagesDir, sample.imageFile);
      try {
        const imgBuf = await fs.readFile(imgPath);
        const zipImgPath = `images/${sample.imageFile}`;
        zip.file(zipImgPath, imgBuf);
        manifestLines.push(
          JSON.stringify({
            sampleId: sample.sampleId,
            portal: sample.portal,
            image: zipImgPath,
            label: sample.finalLabel,
            predicted: sample.predicted,
            outcome: sample.outcome,
            model: sample.model,
            timestamp: sample.timestamp,
          }),
        );
      } catch {
        // Skip if image file was deleted externally
      }
    }

    zip.file('labels.jsonl', manifestLines.join('\n') + (manifestLines.length ? '\n' : ''));
    zip.file(
      'README.txt',
      [
        'TaxCap Dataset Export',
        `Usable labeled samples: ${manifestLines.length}`,
        'Format: labels.jsonl (each line links image path + ground-truth captcha label)',
        'Ready for CRNN / ONNX / PyTorch OCR training or Gemini fine-tuning.',
      ].join('\n'),
    );

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { zipBuffer, usableCount: manifestLines.length };
  }

  async function clearAll(): Promise<void> {
    return enqueue(async () => {
      events = [];
      cachedHints = null;
      loaded = true;
      await fs.rm(baseDir, { recursive: true, force: true });
      await fs.mkdir(imagesDir, { recursive: true });
    });
  }

  return {
    recordSolve,
    recordFeedback,
    getAllSamples,
    getPortalHints,
    getSnapshot,
    getImagePath,
    exportZipBuffer,
    clearAll,
  };
}
