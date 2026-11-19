import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatasetStore } from './dataset.ts';
import { buildConsolidatedMemory, createMemoryStore } from './memory.ts';

test('buildConsolidatedMemory selects hard-negative exemplars and exact hashes', () => {
  const mem = buildConsolidatedMemory(
    [
      {
        sampleId: 's2',
        timestamp: '2026-11-14T02:00:00.000Z',
        portal: 'dvc',
        model: 'gemini-3.1-flash-lite',
        speedMode: 'fast',
        latencyMs: 900,
        predicted: 'eoao8',
        finalLabel: 'eoa08',
        outcome: 'corrected',
        imageFile: 'dvc_hash2.webp',
        imageHash: 'hash2',
      },
      {
        sampleId: 's1',
        timestamp: '2026-11-14T01:00:00.000Z',
        portal: 'dvc',
        model: 'gemini-3.1-flash-lite',
        speedMode: 'fast',
        latencyMs: 800,
        predicted: 'abc12',
        finalLabel: 'abc12',
        outcome: 'verified',
        imageFile: 'dvc_hash1.webp',
        imageHash: 'hash1',
      },
    ],
    {
      version: 0,
      lastConsolidatedAt: null,
      lastReason: null,
      consolidatedSampleCount: 0,
      fewShotMode: 'smart',
      autoScheduleMinutes: 15,
      autoSampleThreshold: 5,
      exactHashes: {},
      portals: {
        hddt: { portal: 'hddt', usableCount: 0, correctedCount: 0, accuracyPercent: null, observedLengths: [], confusions: [], exemplars: [] },
        tdt: { portal: 'tdt', usableCount: 0, correctedCount: 0, accuracyPercent: null, observedLengths: [], confusions: [], exemplars: [] },
        dvc: { portal: 'dvc', usableCount: 0, correctedCount: 0, accuracyPercent: null, observedLengths: [], confusions: [], exemplars: [] },
        tracuunnt: { portal: 'tracuunnt', usableCount: 0, correctedCount: 0, accuracyPercent: null, observedLengths: [], confusions: [], exemplars: [] },
      },
    },
    'manual',
  );

  assert.equal(mem.version, 1);
  assert.equal(mem.exactHashes['dvc:hash2']?.label, 'eoa08');
  assert.equal(mem.exactHashes['dvc:hash1']?.label, 'abc12');
  assert.equal(mem.portals.dvc.exemplars.length, 2);
  assert.equal(mem.portals.dvc.exemplars[0].hardNegative, true);
  assert.equal(mem.portals.dvc.exemplars[0].label, 'eoa08');
  assert.deepEqual(mem.portals.dvc.confusions, [{ from: 'o', to: '0', count: 1 }]);
});

test('createMemoryStore consolidates automatically after 5 feedback samples and loads few-shot images', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taxcap-mem-'));
  try {
    const dataset = createDatasetStore(tmpDir);
    const memory = createMemoryStore({
      baseDir: tmpDir,
      getAllSamples: () => dataset.getAllSamples(),
    });
    await memory.init();

    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    for (let i = 0; i < 5; i++) {
      const sampleId = await dataset.recordSolve({
        portal: 'hddt',
        model: 'gemini-3.1-flash-lite',
        speedMode: 'fast',
        latencyMs: 900,
        predicted: `AB12C${i}`,
        mimeType: 'image/png',
        base64Data: pngBase64 + '='.repeat(0),
      });
      await dataset.recordFeedback({
        sampleId,
        outcome: i === 0 ? 'corrected' : 'verified',
        finalLabel: i === 0 ? 'AB12X0' : `AB12C${i}`,
      });
      const triggered = await memory.notifyFeedbackRecorded();
      if (i < 4) assert.equal(triggered, false);
      else assert.equal(triggered, true);
    }

    const summary = await memory.getSummary();
    assert.equal(summary.lastReason, 'auto-samples');
    assert.equal(summary.consolidatedSampleCount, 5);

    const examplesFast = await memory.getFewShotExamples('hddt', { speedMode: 'fast', bypassCache: false });
    assert.equal(examplesFast.length, 0);

    const examplesAccurate = await memory.getFewShotExamples('hddt', { speedMode: 'accurate', bypassCache: false });
    assert.equal(examplesAccurate.length, 1);
    assert.ok(examplesAccurate[0].base64Data.length > 10);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
