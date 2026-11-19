import fs from 'node:fs/promises';
import path from 'node:path';
import type { PortalId } from '../src/utils/captchaLogic.ts';
import type { ConfusionPair, PortalLearnedHints } from '../src/utils/portalRules.ts';
import type { DatasetSample } from './dataset.ts';

export type FewShotMode = 'smart' | 'always' | 'off';

export interface MemoryExemplar {
  sampleId: string;
  portal: PortalId;
  imageFile: string;
  mimeType: string;
  predicted: string;
  label: string;
  hardNegative: boolean;
  timestamp: string;
}

export interface PortalMemoryEntry {
  portal: PortalId;
  usableCount: number;
  correctedCount: number;
  accuracyPercent: number | null;
  observedLengths: number[];
  confusions: ConfusionPair[];
  exemplars: MemoryExemplar[];
}

export interface MemorySnapshotFile {
  version: number;
  lastConsolidatedAt: string | null;
  lastReason: 'startup' | 'auto-samples' | 'auto-timer' | 'manual' | null;
  consolidatedSampleCount: number;
  fewShotMode: FewShotMode;
  autoScheduleMinutes: number;
  autoSampleThreshold: number;
  exactHashes: Record<string, { label: string; portal: PortalId; sampleId: string }>;
  portals: Record<PortalId, PortalMemoryEntry>;
}

export interface FewShotImageExample {
  sampleId: string;
  label: string;
  mimeType: string;
  base64Data: string;
}

const ALL_PORTALS: PortalId[] = ['hddt', 'tdt', 'dvc', 'tracuunnt'];
const DEFAULT_SCHEDULE_MINUTES = 15;
const DEFAULT_SAMPLE_THRESHOLD = 5;

function createEmptyPortalEntry(portal: PortalId): PortalMemoryEntry {
  return {
    portal,
    usableCount: 0,
    correctedCount: 0,
    accuracyPercent: null,
    observedLengths: [],
    confusions: [],
    exemplars: [],
  };
}

function createEmptyMemoryState(): MemorySnapshotFile {
  return {
    version: 0,
    lastConsolidatedAt: null,
    lastReason: null,
    consolidatedSampleCount: 0,
    fewShotMode: 'smart',
    autoScheduleMinutes: DEFAULT_SCHEDULE_MINUTES,
    autoSampleThreshold: DEFAULT_SAMPLE_THRESHOLD,
    exactHashes: {},
    portals: {
      hddt: createEmptyPortalEntry('hddt'),
      tdt: createEmptyPortalEntry('tdt'),
      dvc: createEmptyPortalEntry('dvc'),
      tracuunnt: createEmptyPortalEntry('tracuunnt'),
    },
  };
}

export function mimeFromImageFile(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

/**
 * Pure memory consolidation function: computes exact lookup table, recency-weighted
 * confusion pairs (newer corrections carry higher weight so old resolved errors decay),
 * and up to 2 best multimodal exemplars per portal.
 */
export function buildConsolidatedMemory(
  samplesNewestFirst: DatasetSample[],
  prevState: MemorySnapshotFile,
  reason: NonNullable<MemorySnapshotFile['lastReason']>,
): MemorySnapshotFile {
  const exactHashes: MemorySnapshotFile['exactHashes'] = {};
  const portals = {
    hddt: createEmptyPortalEntry('hddt'),
    tdt: createEmptyPortalEntry('tdt'),
    dvc: createEmptyPortalEntry('dvc'),
    tracuunnt: createEmptyPortalEntry('tracuunnt'),
  } as Record<PortalId, PortalMemoryEntry>;

  const usableAll = samplesNewestFirst.filter(
    (s) => (s.outcome === 'verified' || s.outcome === 'corrected') && s.finalLabel.length >= 2,
  );

  // Store newest verified/corrected label per portal:imageHash for <5ms persistent memory hit
  for (let i = usableAll.length - 1; i >= 0; i--) {
    const s = usableAll[i];
    if (s.imageHash) {
      exactHashes[`${s.portal}:${s.imageHash}`] = {
        label: s.finalLabel,
        portal: s.portal,
        sampleId: s.sampleId,
      };
    }
  }

  for (const portal of ALL_PORTALS) {
    const relevant = usableAll.filter((s) => s.portal === portal);
    const verifiedCount = relevant.filter((s) => s.outcome === 'verified').length;
    const correctedCount = relevant.filter((s) => s.outcome === 'corrected').length;
    const accuracyPercent =
      relevant.length > 0 ? Math.round((verifiedCount / relevant.length) * 100) : null;

    const lengthCounts = new Map<number, number>();
    const weightedPairs = new Map<string, { score: number; rawCount: number }>();

    relevant.forEach((s, idx) => {
      lengthCounts.set(s.finalLabel.length, (lengthCounts.get(s.finalLabel.length) || 0) + 1);
      if (s.outcome === 'corrected' && s.predicted && s.predicted !== s.finalLabel) {
        // Recency weight: newest 20 samples count 1.5x, older ones decay cleanly
        const recencyWeight = idx < 20 ? 1.5 : idx < 60 ? 1.0 : 0.6;
        if (s.predicted.length === s.finalLabel.length) {
          for (let i = 0; i < s.predicted.length; i++) {
            const from = s.predicted[i];
            const to = s.finalLabel[i];
            if (from !== to) {
              const key = `${from}->${to}`;
              const cur = weightedPairs.get(key) || { score: 0, rawCount: 0 };
              cur.score += recencyWeight;
              cur.rawCount += 1;
              weightedPairs.set(key, cur);
            }
          }
        }
      }
    });

    const observedLengths = Array.from(lengthCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([len]) => len)
      .sort((a, b) => a - b);

    const confusions: ConfusionPair[] = Array.from(weightedPairs.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 6)
      .map(([key, val]) => {
        const [from, to] = key.split('->');
        return { from, to, count: val.rawCount };
      });

    // Select up to 2 visual exemplars (prefer diverse hard-negative corrected images first)
    const exemplars: MemoryExemplar[] = [];
    const seenHashes = new Set<string>();
    const seenLabels = new Set<string>();

    const corrected = relevant.filter((s) => s.outcome === 'corrected');
    for (const s of corrected) {
      if (exemplars.length >= 2) break;
      if (seenHashes.has(s.imageHash) || seenLabels.has(s.finalLabel)) continue;
      seenHashes.add(s.imageHash);
      seenLabels.add(s.finalLabel);
      exemplars.push({
        sampleId: s.sampleId,
        portal,
        imageFile: s.imageFile,
        mimeType: mimeFromImageFile(s.imageFile),
        predicted: s.predicted,
        label: s.finalLabel,
        hardNegative: true,
        timestamp: s.timestamp,
      });
    }

    if (exemplars.length < 2) {
      const verified = relevant.filter((s) => s.outcome === 'verified');
      for (const s of verified) {
        if (exemplars.length >= 2) break;
        if (seenHashes.has(s.imageHash) || seenLabels.has(s.finalLabel)) continue;
        seenHashes.add(s.imageHash);
        seenLabels.add(s.finalLabel);
        exemplars.push({
          sampleId: s.sampleId,
          portal,
          imageFile: s.imageFile,
          mimeType: mimeFromImageFile(s.imageFile),
          predicted: s.predicted,
          label: s.finalLabel,
          hardNegative: false,
          timestamp: s.timestamp,
        });
      }
    }

    portals[portal] = {
      portal,
      usableCount: relevant.length,
      correctedCount,
      accuracyPercent,
      observedLengths,
      confusions,
      exemplars,
    };
  }

  return {
    version: prevState.version + 1,
    lastConsolidatedAt: new Date().toISOString(),
    lastReason: reason,
    consolidatedSampleCount: usableAll.length,
    fewShotMode: prevState.fewShotMode,
    autoScheduleMinutes: prevState.autoScheduleMinutes,
    autoSampleThreshold: prevState.autoSampleThreshold,
    exactHashes,
    portals,
  };
}

export function createMemoryStore(options: {
  baseDir?: string;
  getAllSamples: () => Promise<DatasetSample[]>;
}) {
  const baseDir = options.baseDir || path.resolve(process.cwd(), 'dataset');
  const imagesDir = path.join(baseDir, 'images');
  const memoryPath = path.join(baseDir, 'memory.json');

  let state: MemorySnapshotFile = createEmptyMemoryState();
  let loaded = false;
  let pendingNewFeedback = 0;
  let exemplarBase64Cache = new Map<string, string>();
  let opChain = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = opChain.then(fn, fn);
    opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    await fs.mkdir(baseDir, { recursive: true });
    try {
      const raw = await fs.readFile(memoryPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MemorySnapshotFile>;
      if (parsed && typeof parsed.version === 'number' && parsed.portals) {
        state = {
          ...createEmptyMemoryState(),
          ...parsed,
          portals: {
            ...createEmptyMemoryState().portals,
            ...parsed.portals,
          },
          exactHashes: parsed.exactHashes || {},
        };
      }
    } catch {
      // No saved memory yet; keep clean initial state
    }
    loaded = true;
  }

  async function warmExemplarCache(): Promise<void> {
    const nextCache = new Map<string, string>();
    for (const portal of ALL_PORTALS) {
      const list = state.portals[portal]?.exemplars || [];
      for (const ex of list) {
        try {
          const buf = await fs.readFile(path.join(imagesDir, ex.imageFile));
          nextCache.set(ex.imageFile, buf.toString('base64'));
        } catch {
          // Image may not exist anymore
        }
      }
    }
    exemplarBase64Cache = nextCache;
  }

  async function consolidate(
    reason: NonNullable<MemorySnapshotFile['lastReason']> = 'manual',
  ): Promise<MemorySnapshotFile> {
    return enqueue(async () => {
      await ensureLoaded();
      const samples = await options.getAllSamples();
      state = buildConsolidatedMemory(samples, state, reason);
      pendingNewFeedback = 0;
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(memoryPath, JSON.stringify(state, null, 2), 'utf8');
      await warmExemplarCache();
      return state;
    });
  }

  async function init(): Promise<MemorySnapshotFile> {
    await ensureLoaded();
    const samples = await options.getAllSamples();
    const usableCount = samples.filter(
      (s) => (s.outcome === 'verified' || s.outcome === 'corrected') && s.finalLabel.length >= 2,
    ).length;
    if (usableCount !== state.consolidatedSampleCount || state.version === 0) {
      if (usableCount > 0 || state.version === 0) {
        return consolidate('startup');
      }
    }
    await warmExemplarCache();
    return state;
  }

  async function notifyFeedbackRecorded(): Promise<boolean> {
    await ensureLoaded();
    pendingNewFeedback += 1;
    if (pendingNewFeedback >= state.autoSampleThreshold) {
      await consolidate('auto-samples');
      return true;
    }
    return false;
  }

  async function lookupExact(
    portal: PortalId,
    imageHash24: string,
  ): Promise<{ label: string; sampleId: string } | null> {
    await ensureLoaded();
    const hit = state.exactHashes[`${portal}:${imageHash24}`];
    if (!hit) return null;
    return { label: hit.label, sampleId: hit.sampleId };
  }

  async function getAdaptiveHints(portal: PortalId): Promise<PortalLearnedHints> {
    await ensureLoaded();
    const entry = state.portals[portal] || createEmptyPortalEntry(portal);
    return {
      portal,
      usableCount: entry.usableCount,
      correctedCount: entry.correctedCount,
      observedLengths: entry.observedLengths,
      confusions: entry.confusions,
    };
  }

  async function getFewShotExamples(
    portal: PortalId,
    opts: { speedMode: 'fast' | 'accurate'; bypassCache: boolean },
  ): Promise<FewShotImageExample[]> {
    await ensureLoaded();
    if (state.fewShotMode === 'off') return [];
    if (state.fewShotMode === 'smart' && opts.speedMode === 'fast' && !opts.bypassCache) {
      return [];
    }
    const list = state.portals[portal]?.exemplars || [];
    const results: FewShotImageExample[] = [];
    for (const ex of list.slice(0, 2)) {
      let b64 = exemplarBase64Cache.get(ex.imageFile);
      if (!b64) {
        try {
          const buf = await fs.readFile(path.join(imagesDir, ex.imageFile));
          b64 = buf.toString('base64');
          exemplarBase64Cache.set(ex.imageFile, b64);
        } catch {
          continue;
        }
      }
      results.push({
        sampleId: ex.sampleId,
        label: ex.label,
        mimeType: ex.mimeType,
        base64Data: b64,
      });
    }
    return results;
  }

  async function setFewShotMode(mode: FewShotMode): Promise<MemorySnapshotFile> {
    return enqueue(async () => {
      await ensureLoaded();
      state = { ...state, fewShotMode: mode };
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(memoryPath, JSON.stringify(state, null, 2), 'utf8');
      return state;
    });
  }

  async function getSummary() {
    await ensureLoaded();
    return {
      version: state.version,
      lastConsolidatedAt: state.lastConsolidatedAt,
      lastReason: state.lastReason,
      consolidatedSampleCount: state.consolidatedSampleCount,
      pendingUntilAutoConsolidate: Math.max(0, state.autoSampleThreshold - pendingNewFeedback),
      autoScheduleMinutes: state.autoScheduleMinutes,
      autoSampleThreshold: state.autoSampleThreshold,
      fewShotMode: state.fewShotMode,
      exactEntriesCount: Object.keys(state.exactHashes).length,
      portals: ALL_PORTALS.map((p) => state.portals[p]),
    };
  }

  async function reset(): Promise<void> {
    return enqueue(async () => {
      const keepMode = state.fewShotMode;
      state = { ...createEmptyMemoryState(), fewShotMode: keepMode };
      pendingNewFeedback = 0;
      exemplarBase64Cache.clear();
      loaded = true;
      await fs.rm(memoryPath, { force: true }).catch(() => {});
    });
  }

  return {
    init,
    consolidate,
    notifyFeedbackRecorded,
    lookupExact,
    getAdaptiveHints,
    getFewShotExamples,
    setFewShotMode,
    getSummary,
    reset,
  };
}
