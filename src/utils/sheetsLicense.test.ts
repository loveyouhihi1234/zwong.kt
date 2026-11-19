import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysToVnDateKey,
  buildGoogleAppsScriptCode,
  formatBilingualSheetHeader,
  generateLicenseKey,
  isExpiredLicenseDate,
  SHEET_HEADER_COLUMNS,
  summarizeSheetUsers,
  validateAppsScriptWebAppUrl,
  type SheetUserRecord,
} from './sheetsLicense.ts';

test('generateLicenseKey produces clean unambiguous TC-XXXX-YYYY codes', () => {
  const k1 = generateLicenseKey();
  const k2 = generateLicenseKey('vip');
  assert.match(k1, /^TC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(k2, /^VIP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('addDaysToVnDateKey and isExpiredLicenseDate handle forever and bounded dates accurately', () => {
  assert.equal(addDaysToVnDateKey(30, '2026-11-01'), '2026-12-01');
  assert.equal(isExpiredLicenseDate('FOREVER', '2026-11-14'), false);
  assert.equal(isExpiredLicenseDate('2026-11-14', '2026-11-14'), false);
  assert.equal(isExpiredLicenseDate('2026-11-13', '2026-11-14'), true);
});

test('validateAppsScriptWebAppUrl allows Google Apps Script exec URLs only', () => {
  assert.equal(validateAppsScriptWebAppUrl('https://script.google.com/macros/s/AKfycb123/exec'), true);
  assert.equal(validateAppsScriptWebAppUrl('http://localhost:3000'), false);
});

test('summarizeSheetUsers computes active, locked, expired, and total solves', () => {
  const users: SheetUserRecord[] = [
    {
      licenseKey: 'TC-1111-2222',
      userName: 'A',
      status: 'ACTIVE',
      expiresAt: '2026-12-31',
      maxDevices: 2,
      deviceIds: ['d1'],
      deviceCount: 1,
      dailyLimit: 0,
      usedToday: 4,
      usedDate: '2026-11-14',
      totalSolved: 50,
      lastUsedAt: '',
      note: '',
    },
    {
      licenseKey: 'TC-3333-4444',
      userName: 'B',
      status: 'LOCKED',
      expiresAt: 'FOREVER',
      maxDevices: 1,
      deviceIds: [],
      deviceCount: 0,
      dailyLimit: 0,
      usedToday: 0,
      usedDate: '',
      totalSolved: 10,
      lastUsedAt: '',
      note: '',
    },
    {
      licenseKey: 'TC-5555-6666',
      userName: 'C',
      status: 'ACTIVE',
      expiresAt: '2026-11-01',
      maxDevices: 1,
      deviceIds: [],
      deviceCount: 0,
      dailyLimit: 0,
      usedToday: 0,
      usedDate: '',
      totalSolved: 5,
      lastUsedAt: '',
      note: '',
    },
  ];
  const summary = summarizeSheetUsers(users, '2026-11-14');
  assert.equal(summary.totalUsers, 3);
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.lockedCount, 1);
  assert.equal(summary.expiredCount, 1);
  assert.equal(summary.totalSolvedAll, 65);
});

test('buildGoogleAppsScriptCode embeds admin secret, bilingual headers, and CacheService + LockService protections', () => {
  const gs = buildGoogleAppsScriptCode('my-secret-999');
  assert.equal(gs.includes("const DEFAULT_ADMIN_SECRET = 'my-secret-999';"), true);
  assert.equal(gs.includes('CacheService.getScriptCache()'), true);
  assert.equal(gs.includes('LockService.getScriptLock()'), true);
  assert.equal(gs.includes("'licenseKey\\n(Mã kích hoạt)'"), true);
  assert.equal(gs.includes("'userName\\n(Tên người dùng)'"), true);
  assert.equal(gs.includes("'note\\n(Ghi chú)'"), true);
  assert.equal(gs.includes('setWrap(true)'), true);
  assert.equal(gs.includes('menuUpdateBilingualHeaders'), true);
});

test('SHEET_HEADER_COLUMNS defines all 12 bilingual English-Vietnamese columns', () => {
  assert.equal(SHEET_HEADER_COLUMNS.length, 12);
  assert.equal(formatBilingualSheetHeader(SHEET_HEADER_COLUMNS[0]), 'licenseKey\n(Mã kích hoạt)');
  assert.equal(formatBilingualSheetHeader(SHEET_HEADER_COLUMNS[11]), 'note\n(Ghi chú)');
  for (const col of SHEET_HEADER_COLUMNS) {
    assert.ok(col.key.length > 0);
    assert.ok(col.viLabel.length > 0);
    assert.ok(col.description.length > 0);
  }
});
