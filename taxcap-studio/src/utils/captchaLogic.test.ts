import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUTO_RETRIES,
  buildSampleCaptchaSvg,
  canAutoSolve,
  createInitialRetryState,
  getModelForSpeedMode,
  isValidPortal,
  nextRetryState,
  parseCaptchaImageInput,
  resolveSolveMode,
  sanitizeCaptchaText,
} from './captchaLogic';

test('isValidPortal accepts only the 4 GDT portals', () => {
  assert.equal(isValidPortal('hddt'), true);
  assert.equal(isValidPortal('tdt'), true);
  assert.equal(isValidPortal('dvc'), true);
  assert.equal(isValidPortal('tracuunnt'), true);
  assert.equal(isValidPortal('unknown'), false);
});

test('resolveSolveMode defaults to fast Flash Lite and allows accurate Flash', () => {
  assert.equal(resolveSolveMode(undefined), 'fast');
  assert.equal(resolveSolveMode('weird'), 'fast');
  assert.equal(resolveSolveMode('accurate'), 'accurate');
  assert.equal(getModelForSpeedMode('fast'), 'gemini-3.1-flash-lite');
  assert.equal(getModelForSpeedMode('accurate'), 'gemini-4-hydrogen');
});

test('sanitizeCaptchaText strips whitespace, quotes, and non-alphanumerics', () => {
  assert.equal(sanitizeCaptchaText('  A7b9K \n'), 'A7b9K');
  assert.equal(sanitizeCaptchaText('`"X3M8P"`'), 'X3M8P');
  assert.equal(sanitizeCaptchaText('```txt\n9K2L\n```'), 'txt9K2L'.slice(0, 12));
  assert.equal(sanitizeCaptchaText('12-34_AB'), '1234AB');
});

test('parseCaptchaImageInput validates data URIs and raw base64', () => {
  const validPng = 'data:image/png;base64,' + 'A'.repeat(48);
  assert.deepEqual(parseCaptchaImageInput(validPng), {
    mimeType: 'image/png',
    data: 'A'.repeat(48),
  });

  const validJpg = 'data:image/jpg;base64,' + 'B'.repeat(48);
  assert.deepEqual(parseCaptchaImageInput(validJpg), {
    mimeType: 'image/jpeg',
    data: 'B'.repeat(48),
  });

  // Rejects SVG data URI directly (must be rasterized to PNG first)
  const svgUri = 'data:image/svg+xml;base64,' + 'C'.repeat(48);
  assert.equal(parseCaptchaImageInput(svgUri), null);

  assert.equal(parseCaptchaImageInput('too-short'), null);
});

test('retry state machine caps auto-retries at 3 and resets on manual retry or manual input', () => {
  let state = createInitialRetryState(MAX_AUTO_RETRIES);
  assert.equal(state.status, 'idle');

  // Attempt 1
  assert.equal(canAutoSolve(state, 'img-1'), true);
  state = nextRetryState(state, { type: 'IMAGE_DETECTED', imageKey: 'img-1' });
  assert.equal(state.status, 'reading');
  assert.equal(state.autoAttempts, 1);

  state = nextRetryState(state, { type: 'SOLVE_SUCCESS', code: 'AB12' });
  assert.equal(state.status, 'filled');
  assert.equal(state.message, 'Đã điền (kiểm tra lại)');

  // Same image does not re-trigger auto solve
  assert.equal(canAutoSolve(state, 'img-1'), false);

  // Image 2 (e.g. wrong captcha reloaded by portal)
  state = nextRetryState(state, { type: 'IMAGE_DETECTED', imageKey: 'img-2' });
  assert.equal(state.autoAttempts, 2);
  state = nextRetryState(state, { type: 'SOLVE_SUCCESS', code: 'CD34' });

  // Image 3
  state = nextRetryState(state, { type: 'IMAGE_DETECTED', imageKey: 'img-3' });
  assert.equal(state.autoAttempts, 3);
  state = nextRetryState(state, { type: 'SOLVE_FAILED' });
  assert.equal(state.status, 'locked');

  // Image 4 must stay locked (no infinite loop!)
  assert.equal(canAutoSolve(state, 'img-4'), false);
  state = nextRetryState(state, { type: 'IMAGE_DETECTED', imageKey: 'img-4' });
  assert.equal(state.status, 'locked');
  assert.equal(state.autoAttempts, 3);

  // Manual retry button unlocks and resets attempts to 1
  state = nextRetryState(state, { type: 'MANUAL_RETRY', imageKey: 'img-4' });
  assert.equal(state.status, 'reading');
  assert.equal(state.autoAttempts, 1);

  state = nextRetryState(state, { type: 'SOLVE_SUCCESS', code: 'EF56' });
  assert.equal(state.status, 'filled');

  // Manual typing resets counter cleanly
  state = nextRetryState(state, { type: 'MANUAL_INPUT' });
  assert.equal(state.autoAttempts, 0);
  assert.equal(state.status, 'idle');
});

test('buildSampleCaptchaSvg produces valid SVG containing each character', () => {
  const svg = buildSampleCaptchaSvg('HK79P', 'hddt');
  assert.equal(svg.startsWith('<svg'), true);
  for (const ch of 'HK79P') {
    assert.equal(svg.includes(`>${ch}<`), true);
  }
});
