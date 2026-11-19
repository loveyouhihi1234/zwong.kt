import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  computeDatasetStats,
  createDatasetStore,
  foldDatasetEvents,
  isSafeDatasetFilename,
  type DatasetEvent,
} from './dataset.ts';

test('foldDatasetEvents and computeDatasetStats track verified, corrected, and accuracy', () => {
  const events: DatasetEvent[] = [
    {
      type: 'solve',
      sampleId: 's1',
      timestamp: '2026-11-14T00:00:00.000Z',
      portal: 'hddt',
      model: 'gemini-3.1-flash-lite',
      speedMode: 'fast',
      latencyMs: 900,
      predicted: 'AB12CD',
      imageFile: 'hddt_111.webp',
      imageHash: '111',
    },
    {
      type: 'solve',
      sampleId: 's2',
      timestamp: '2026-11-14T00:01:00.000Z',
      portal: 'dvc',
      model: 'gemini-3.1-flash-lite',
      speedMode: 'fast',
      latencyMs: 950,
      predicted: 'XY99Z',
      imageFile: 'dvc_222.webp',
      imageHash: '222',
    },
    {
      type: 'feedback',
      sampleId: 's1',
      timestamp: '2026-11-14T00:02:00.000Z',
      outcome: 'verified',
      finalLabel: 'AB12CD',
    },
    {
      type: 'feedback',
      sampleId: 's2',
      timestamp: '2026-11-14T00:03:00.000Z',
      outcome: 'corrected',
      finalLabel: 'XY98Z',
    },
  ];

  const folded = foldDatasetEvents(events);
  assert.equal(folded.length, 2);
  assert.equal(folded[0].sampleId, 's2'); // newest first
  assert.equal(folded[0].finalLabel, 'XY98Z');
  assert.equal(folded[0].outcome, 'corrected');

  const stats = computeDatasetStats(folded);
  assert.equal(stats.total, 2);
  assert.equal(stats.usable, 2);
  assert.equal(stats.verified, 1);
  assert.equal(stats.corrected, 1);
  assert.equal(stats.accuracyPercent, 50);
});

test('isSafeDatasetFilename rejects path traversal', () => {
  assert.equal(isSafeDatasetFilename('hddt_abc123.webp'), true);
  assert.equal(isSafeDatasetFilename('../secret.png'), false);
  assert.equal(isSafeDatasetFilename('a/b.png'), false);
  assert.equal(isSafeDatasetFilename('test.js'), false);
});

test('createDatasetStore persists samples, updates labels, and exports training zip', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taxcap-ds-'));
  try {
    const store = createDatasetStore(tmpDir);
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const s1 = await store.recordSolve({
      portal: 'tdt',
      model: 'gemini-3.1-flash-lite',
      speedMode: 'fast',
      latencyMs: 850,
      predicted: 'K7M2P',
      mimeType: 'image/png',
      base64Data: pngBase64,
    });
    const updated = await store.recordFeedback({
      sampleId: s1,
      outcome: 'corrected',
      finalLabel: 'K7N2P',
    });
    assert.equal(updated?.finalLabel, 'K7N2P');
    assert.equal(updated?.outcome, 'corrected');

    const { stats, samples } = await store.getSnapshot();
    assert.equal(stats.usable, 1);
    assert.equal(samples[0].finalLabel, 'K7N2P');

    const { zipBuffer, usableCount } = await store.exportZipBuffer();
    assert.equal(usableCount, 1);
    const zip = await JSZip.loadAsync(zipBuffer);
    const labelsText = await zip.file('labels.jsonl')!.async('string');
    const row = JSON.parse(labelsText.trim());
    assert.equal(row.label, 'K7N2P');
    assert.equal(row.portal, 'tdt');
    assert.ok(zip.file(row.image));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
