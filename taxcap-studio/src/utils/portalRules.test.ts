import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_PROFILES,
  buildAdaptivePortalPrompt,
  computePortalConfusionHints,
  enhanceCaptchaPixels,
} from './portalRules.ts';

test('computePortalConfusionHints extracts character misread pairs and observed lengths', () => {
  const hints = computePortalConfusionHints([
    { portal: 'dvc', predicted: 'eoa08', finalLabel: 'eoa08', outcome: 'verified' },
    { portal: 'dvc', predicted: 'eoao8', finalLabel: 'eoa08', outcome: 'corrected' },
    { portal: 'dvc', predicted: 'eoao9', finalLabel: 'eoa09', outcome: 'corrected' },
    { portal: 'dvc', predicted: 'abc12', finalLabel: '', outcome: 'rejected' },
    { portal: 'hddt', predicted: 'AB12CD', finalLabel: 'AB12CD', outcome: 'pending' },
  ]);

  assert.equal(hints.dvc.usableCount, 3);
  assert.equal(hints.dvc.correctedCount, 2);
  assert.deepEqual(hints.dvc.observedLengths, [5]);
  assert.deepEqual(hints.dvc.confusions, [{ from: 'o', to: '0', count: 2 }]);
  assert.equal(hints.hddt.usableCount, 0);
});

test('buildAdaptivePortalPrompt embeds portal guidance and learned misreads', () => {
  const basePrompt = buildAdaptivePortalPrompt('dvc', null);
  assert.match(basePrompt, /dichvucong\.gdt\.gov\.vn/);
  assert.match(basePrompt, /5 distorted characters/);

  const learnedPrompt = buildAdaptivePortalPrompt('dvc', {
    portal: 'dvc',
    usableCount: 12,
    correctedCount: 3,
    observedLengths: [5],
    confusions: [{ from: 'o', to: '0', count: 3 }],
  });
  assert.match(learnedPrompt, /12 labeled samples/);
  assert.match(learnedPrompt, /observed character counts: 5/);
  assert.match(learnedPrompt, /'o'->'0' \(3x\)/);
  assert.ok(PORTAL_PROFILES.hddt.expectedLengths.includes(6));
});

test('enhanceCaptchaPixels whitens light background and deepens dark text strokes', () => {
  // 4x4 image: mostly light gray (200) background with 2 dark ink pixels (40)
  const width = 4;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const isInk = i === 5 || i === 6;
    const v = isInk ? 40 : 200;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }

  enhanceCaptchaPixels(data, width, height);

  // Background pixels (index 0) should be whitened to 255
  assert.equal(data[0], 255);
  assert.equal(data[1], 255);
  assert.equal(data[2], 255);
  // Foreground ink pixels (index 5) should stay dark (< 60)
  assert.ok(data[5 * 4] < 60, `Expected dark foreground < 60, got ${data[5 * 4]}`);
});
