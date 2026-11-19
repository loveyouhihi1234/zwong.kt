import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadLicenseModule() {
  const code = fs.readFileSync(path.resolve(process.cwd(), 'extension', 'license.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.self = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.TaxCapLicense as {
    LICENSE_CACHE_TTL_MS: number;
    USAGE_SYNC_BATCH_SIZE: number;
    getTodayDateKey: (nowMs?: number) => string;
    normalizeLicenseKey: (raw: string) => string;
    isValidAppsScriptUrl: (url: string) => boolean;
    createEmptyLicenseState: (defaultApiUrl?: string) => Record<string, unknown>;
    evaluateLocalLicense: (
      state: unknown,
      nowMs?: number,
    ) => {
      unlocked: boolean;
      needsRefresh: boolean;
      reason: string;
      message: string;
      effectiveUsedToday: number;
      remainingToday: number | null;
      msUntilRefresh: number;
    };
    applyServerVerifyResult: (
      prev: unknown,
      serverData: Record<string, unknown>,
      ctx?: Record<string, unknown>,
    ) => Record<string, unknown>;
    incrementPendingUsage: (prev: unknown, amount?: number, nowMs?: number) => Record<string, unknown>;
  };
}

const VALID_URL = 'https://script.google.com/macros/s/AKfycbxTestId123/exec';

test('unactivated state is strictly locked until verified by server', () => {
  const lic = loadLicenseModule();
  const empty = lic.createEmptyLicenseState(VALID_URL);
  const res = lic.evaluateLocalLicense(empty, 1_000_000);
  assert.equal(res.unlocked, false);
  assert.equal(res.reason, 'UNACTIVATED');
  assert.equal(lic.normalizeLicenseKey(' tc-minh 8821! '), 'TC-MINH8821');
  assert.equal(lic.isValidAppsScriptUrl(VALID_URL), true);
  assert.equal(lic.isValidAppsScriptUrl('https://evil.example.com/exec'), false);
});

test('15-minute cache prevents unnecessary Google Sheets calls and triggers refresh after 15 mins or 10 solves', () => {
  const lic = loadLicenseModule();
  const t0 = Date.UTC(2026, 10, 14, 2, 0, 0); // 09:00 VN
  const today = lic.getTodayDateKey(t0);

  let state = lic.createEmptyLicenseState(VALID_URL);
  state = lic.applyServerVerifyResult(
    state,
    {
      ok: true,
      userName: 'Công ty Minh Anh',
      status: 'ACTIVE',
      expiresAt: '2026-12-31',
      maxDevices: 2,
      deviceCount: 1,
      dailyLimit: 50,
      usedToday: 5,
      usedDate: today,
      totalSolved: 100,
    },
    { licenseKey: 'TC-MINH-1111', licenseApiUrl: VALID_URL, nowMs: t0, sentDelta: 0 },
  );

  // Within 15 minutes -> unlocked, NO refresh needed
  const at5Min = lic.evaluateLocalLicense(state, t0 + 5 * 60 * 1000);
  assert.equal(at5Min.unlocked, true);
  assert.equal(at5Min.needsRefresh, false);
  assert.equal(at5Min.effectiveUsedToday, 5);
  assert.equal(at5Min.remainingToday, 45);

  // After 15 minutes -> still unlocked locally, needsRefresh = true
  const at15Min = lic.evaluateLocalLicense(state, t0 + lic.LICENSE_CACHE_TTL_MS + 100);
  assert.equal(at15Min.unlocked, true);
  assert.equal(at15Min.needsRefresh, true);

  // Increment 10 pending solves within 15 minutes -> triggers batch sync
  for (let i = 0; i < lic.USAGE_SYNC_BATCH_SIZE; i++) {
    state = lic.incrementPendingUsage(state, 1, t0 + 60_000);
  }
  const afterBatch = lic.evaluateLocalLicense(state, t0 + 60_000);
  assert.equal(afterBatch.unlocked, true);
  assert.equal(afterBatch.needsRefresh, true);
  assert.equal(afterBatch.effectiveUsedToday, 15);
  assert.equal(afterBatch.remainingToday, 35);

  // Sync succeeds -> clears sentDelta
  state = lic.applyServerVerifyResult(
    state,
    {
      ok: true,
      userName: 'Công ty Minh Anh',
      status: 'ACTIVE',
      expiresAt: '2026-12-31',
      maxDevices: 2,
      deviceCount: 1,
      dailyLimit: 50,
      usedToday: 15,
      usedDate: today,
      totalSolved: 110,
    },
    { licenseKey: 'TC-MINH-1111', licenseApiUrl: VALID_URL, nowMs: t0 + 65_000, sentDelta: 10 },
  );
  assert.equal(state.pendingUsageDelta, 0);
  assert.equal(lic.evaluateLocalLicense(state, t0 + 66_000).needsRefresh, false);
});

test('server rejection (LOCKED / EXPIRED / DEVICE_LIMIT) immediately locks extension, while transient network blip uses short grace', () => {
  const lic = loadLicenseModule();
  const t0 = Date.UTC(2026, 10, 14, 2, 0, 0);
  const today = lic.getTodayDateKey(t0);

  let state = lic.applyServerVerifyResult(
    lic.createEmptyLicenseState(VALID_URL),
    {
      ok: true,
      userName: 'User A',
      status: 'ACTIVE',
      expiresAt: '2026-12-31',
      maxDevices: 2,
      deviceCount: 1,
      dailyLimit: 0,
      usedToday: 0,
      usedDate: today,
      totalSolved: 0,
    },
    { licenseKey: 'TC-AAA-1111', licenseApiUrl: VALID_URL, nowMs: t0 },
  );

  // Transient network outage after 16m keeps unlocked during grace window
  state = lic.applyServerVerifyResult(
    state,
    { ok: false, networkError: true, message: 'Timeout' },
    { licenseKey: 'TC-AAA-1111', licenseApiUrl: VALID_URL, nowMs: t0 + 16 * 60 * 1000 },
  );
  assert.equal(lic.evaluateLocalLicense(state, t0 + 17 * 60 * 1000).unlocked, true);

  // Explicit LOCKED response immediately locks extension
  state = lic.applyServerVerifyResult(
    state,
    { ok: false, reason: 'LOCKED', message: 'Tài khoản đã bị Admin khóa.' },
    { licenseKey: 'TC-AAA-1111', licenseApiUrl: VALID_URL, nowMs: t0 + 20 * 60 * 1000 },
  );
  const lockedEval = lic.evaluateLocalLicense(state, t0 + 20 * 60 * 1000);
  assert.equal(lockedEval.unlocked, false);
  assert.equal(lockedEval.reason, 'LOCKED');
});

test('dailyLimit blocks solving once reached locally and resets on next VN calendar day', () => {
  const lic = loadLicenseModule();
  const day1 = Date.UTC(2026, 10, 14, 15, 0, 0); // 22:00 VN on 2026-11-14
  const day1Key = lic.getTodayDateKey(day1);

  let state = lic.applyServerVerifyResult(
    lic.createEmptyLicenseState(VALID_URL),
    {
      ok: true,
      userName: 'Limited User',
      status: 'ACTIVE',
      expiresAt: 'FOREVER',
      maxDevices: 1,
      deviceCount: 1,
      dailyLimit: 3,
      usedToday: 2,
      usedDate: day1Key,
      totalSolved: 2,
    },
    { licenseKey: 'TC-LIM-9999', licenseApiUrl: VALID_URL, nowMs: day1 },
  );

  state = lic.incrementPendingUsage(state, 1, day1 + 1000);
  const capped = lic.evaluateLocalLicense(state, day1 + 2000);
  assert.equal(capped.unlocked, false);
  assert.equal(capped.reason, 'DAILY_LIMIT');
  assert.equal(capped.remainingToday, 0);

  // Next VN calendar day resets local counter and triggers refresh
  const day2 = day1 + 3 * 60 * 60 * 1000; // 01:00 VN on 2026-11-15
  const nextDayEval = lic.evaluateLocalLicense(state, day2);
  assert.equal(nextDayEval.unlocked, true);
  assert.equal(nextDayEval.needsRefresh, true);
});
