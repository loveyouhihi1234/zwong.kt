import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadDirectGemini() {
  const code = fs.readFileSync(path.resolve(process.cwd(), 'extension', 'direct-gemini.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.self = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.TaxCapDirect as {
    resolveDirectModel: (mode: string) => string;
    sanitizeCaptchaText: (raw: string) => string;
    parseImageDataUrl: (input: string) => { mimeType: string; data: string } | null;
    hashBase64Quick: (str: string) => string;
    createEmptyMemoryState: () => unknown;
    updateLocalLearningState: (prev: unknown, event: Record<string, unknown>) => unknown;
    getExactMemoryMatch: (state: unknown, portal: string, imageHash: string) => string | null;
    getAdaptiveHints: (
      state: unknown,
      portal: string,
    ) => {
      usableCount: number;
      correctedCount: number;
      observedLengths: number[];
      confusions: Array<{ from: string; to: string; count: number }>;
    } | null;
    getFewShotExamples: (
      state: unknown,
      portal: string,
      opts: { speedMode?: string; bypassCache?: boolean },
    ) => Array<{ label: string; data: string; mimeType: string }>;
    buildAdaptivePrompt: (portal: string, hints: unknown) => string;
    buildGeminiRequestBody: (opts: {
      portal: string;
      parsedImage: { mimeType: string; data: string };
      speedMode: string;
      hints: unknown;
      fewShots: Array<{ label: string; data: string; mimeType: string }>;
    }) => {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      generationConfig: { thinkingConfig: { thinkingLevel: string } };
    };
    extractGeminiCaptchaText: (apiJson: unknown) => string;
    maskCode: (code: string) => string;
    recordSampleInDataset: (prev: unknown[], entry: Record<string, unknown>) => Array<Record<string, unknown>>;
    applySampleFeedback: (
      prev: unknown[],
      fb: { sampleId: string; outcome: string; finalLabel: string },
    ) => { samples: Array<Record<string, unknown>>; updatedSample: Record<string, unknown> | null };
    computeDatasetSummary: (samples: unknown[]) => {
      total: number;
      usable: number;
      verified: number;
      corrected: number;
      pending: number;
      accuracyPercent: number | null;
      byPortal: Array<{ portal: string; usable: number; total: number }>;
    };
    createLogEntry: (opts: Record<string, unknown>) => Record<string, unknown>;
    appendSolveLog: (prev: unknown[], entry: Record<string, unknown>) => Array<Record<string, unknown>>;
    computeLogStats: (logs: unknown[]) => {
      total: number;
      successCount: number;
      errorCount: number;
      avgLatencyMs: number;
    };
  };
}

const SAMPLE_DATA_URL =
  'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

test('parseImageDataUrl and sanitizeCaptchaText handle valid and noisy inputs', () => {
  const d = loadDirectGemini();
  const parsed = d.parseImageDataUrl(SAMPLE_DATA_URL);
  assert.ok(parsed);
  assert.equal(parsed.mimeType, 'image/webp');
  assert.equal(d.parseImageDataUrl('not-an-image'), null);
  assert.equal(d.sanitizeCaptchaText('```AB12C``` \n'), 'AB12C');
});

test('local learning state caches exact hashes, learns character confusions, and builds few-shot prompts', () => {
  const d = loadDirectGemini();
  const parsed = d.parseImageDataUrl(SAMPLE_DATA_URL)!;
  const h1 = d.hashBase64Quick(`${parsed.mimeType}:${parsed.data}`);

  let state = d.createEmptyMemoryState();
  state = d.updateLocalLearningState(state, {
    portal: 'tdt',
    predicted: 'AB0O1',
    finalLabel: 'AB001',
    outcome: 'corrected',
    imageHash: h1,
    mimeType: parsed.mimeType,
    base64Data: parsed.data,
    timestamp: 1000,
  });

  assert.equal(d.getExactMemoryMatch(state, 'tdt', h1), 'AB001');
  assert.equal(d.getExactMemoryMatch(state, 'dvc', h1), null);

  const hints = d.getAdaptiveHints(state, 'tdt');
  assert.ok(hints);
  assert.equal(hints.usableCount, 1);
  assert.equal(hints.correctedCount, 1);
  assert.deepEqual(Array.from(hints.observedLengths), [5]);
  assert.equal(hints.confusions[0].from, 'O');
  assert.equal(hints.confusions[0].to, '0');

  const prompt = d.buildAdaptivePrompt('tdt', hints);
  assert.equal(prompt.includes("'O'->'0' (1x)"), true);

  assert.equal(d.getFewShotExamples(state, 'tdt', { speedMode: 'fast', bypassCache: false }).length, 0);
  const fewShots = d.getFewShotExamples(state, 'tdt', { speedMode: 'fast', bypassCache: true });
  assert.equal(fewShots.length, 1);
  assert.equal(fewShots[0].label, 'AB001');

  const body = d.buildGeminiRequestBody({
    portal: 'tdt',
    parsedImage: parsed,
    speedMode: 'fast',
    hints,
    fewShots,
  });
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.equal(body.contents[0].parts.length >= 5, true);

  state = d.updateLocalLearningState(state, {
    portal: 'tdt',
    outcome: 'rejected',
    imageHash: h1,
  });
  assert.equal(d.getExactMemoryMatch(state, 'tdt', h1), null);
});

test('extractGeminiCaptchaText parses REST generateContent response cleanly', () => {
  const d = loadDirectGemini();
  const text = d.extractGeminiCaptchaText({
    candidates: [
      {
        content: {
          parts: [{ text: '  `E6H3VA` \n' }],
        },
      },
    ],
  });
  assert.equal(text, 'E6H3VA');
  assert.equal(d.resolveDirectModel('fast'), 'gemini-3.1-flash-lite');
  assert.equal(d.resolveDirectModel('accurate'), 'gemini-4-hydrogen');
});

test('local Dataset and Logs helpers track samples, feedback edits, accuracy, and latency stats', () => {
  const d = loadDirectGemini();
  let samples = d.recordSampleInDataset([], {
    sampleId: 's1',
    portal: 'hddt',
    source: 'svg-local',
    predicted: 'E6H3VA',
    latencyMs: 4,
    imageDataUrl: SAMPLE_DATA_URL,
  });
  samples = d.recordSampleInDataset(samples, {
    sampleId: 's2',
    portal: 'tdt',
    source: 'gemini-3.1-flash-lite',
    predicted: 'AB0O1',
    latencyMs: 320,
    imageDataUrl: SAMPLE_DATA_URL,
  });

  const fb1 = d.applySampleFeedback(samples, { sampleId: 's1', outcome: 'verified', finalLabel: 'E6H3VA' });
  const fb2 = d.applySampleFeedback(fb1.samples, { sampleId: 's2', outcome: 'corrected', finalLabel: 'AB001' });
  const summary = d.computeDatasetSummary(fb2.samples);

  assert.equal(summary.total, 2);
  assert.equal(summary.usable, 2);
  assert.equal(summary.verified, 1);
  assert.equal(summary.corrected, 1);
  assert.equal(summary.accuracyPercent, 50);

  let logs = d.appendSolveLog([], d.createLogEntry({ portal: 'hddt', status: 'ok', code: 'E6H3VA', latencyMs: 4, message: 'SVG nội bộ' }));
  logs = d.appendSolveLog(logs, d.createLogEntry({ portal: 'tdt', status: 'error', code: '', latencyMs: 500, message: 'Timeout' }));
  const logStats = d.computeLogStats(logs);

  assert.equal(logStats.total, 2);
  assert.equal(logStats.successCount, 1);
  assert.equal(logStats.errorCount, 1);
  assert.equal(logStats.avgLatencyMs, 252);
  assert.equal(d.maskCode('E6H3VA'), 'E****A');
});
