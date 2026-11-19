export type LicenseStatus = 'ACTIVE' | 'LOCKED';

export interface SheetUserRecord {
  licenseKey: string;
  userName: string;
  status: LicenseStatus;
  expiresAt: string; // YYYY-MM-DD | FOREVER
  maxDevices: number;
  deviceIds: string[];
  deviceCount: number;
  dailyLimit: number;
  usedToday: number;
  usedDate: string;
  totalSolved: number;
  lastUsedAt: string;
  note: string;
}

export interface SheetUsersSummary {
  totalUsers: number;
  activeCount: number;
  lockedCount: number;
  expiredCount: number;
  totalSolvedAll: number;
}

export function getVnTodayDateKey(nowMs = Date.now()): string {
  const vnMs = nowMs + 7 * 60 * 60 * 1000;
  return new Date(vnMs).toISOString().slice(0, 10);
}

export function addDaysToVnDateKey(days: number, baseDateKey?: string): string {
  const startKey = baseDateKey && /^\d{4}-\d{2}-\d{2}$/.test(baseDateKey)
    ? baseDateKey
    : getVnTodayDateKey();
  const baseMs = Date.parse(`${startKey}T00:00:00.000Z`);
  const nextMs = baseMs + Math.round(days) * 24 * 60 * 60 * 1000;
  return new Date(nextMs).toISOString().slice(0, 10);
}

export function isExpiredLicenseDate(expiresAt: string, todayKey = getVnTodayDateKey()): boolean {
  const clean = String(expiresAt || '').trim().toUpperCase();
  if (!clean || clean === 'FOREVER' || clean === 'VĨNH VIỄN') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return false;
  return todayKey > clean;
}

export function generateLicenseKey(prefix = 'TC'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (len: number) => {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  };
  const cleanPrefix = prefix
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4) || 'TC';
  return `${cleanPrefix}-${pick(4)}-${pick(4)}`;
}

export function validateAppsScriptWebAppUrl(raw: string): boolean {
  const clean = String(raw || '').trim();
  return /^https:\/\/script\.(google|googleusercontent)\.com\/.+/i.test(clean);
}

export function summarizeSheetUsers(
  users: SheetUserRecord[],
  todayKey = getVnTodayDateKey(),
): SheetUsersSummary {
  let activeCount = 0;
  let lockedCount = 0;
  let expiredCount = 0;
  let totalSolvedAll = 0;

  for (const u of users) {
    totalSolvedAll += Number(u.totalSolved) || 0;
    if (u.status === 'LOCKED') {
      lockedCount += 1;
    } else if (isExpiredLicenseDate(u.expiresAt, todayKey)) {
      expiredCount += 1;
    } else {
      activeCount += 1;
    }
  }

  return {
    totalUsers: users.length,
    activeCount,
    lockedCount,
    expiredCount,
    totalSolvedAll,
  };
}

export async function callSheetsApi<T = Record<string, unknown>>(
  scriptUrl: string,
  payload: Record<string, unknown>,
): Promise<T & { ok?: boolean; message?: string }> {
  const cleanUrl = String(scriptUrl || '').trim().replace(/\/+$/, '');
  if (!validateAppsScriptWebAppUrl(cleanUrl)) {
    throw new Error('URL Google Apps Script phải bắt đầu bằng https://script.google.com/...');
  }
  const res = await fetch(cleanUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Google Apps Script không trả về JSON hợp lệ (kiểm tra quyền Deploy: Anyone).');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Phản hồi Google Apps Script không hợp lệ.');
  }
  return data as T & { ok?: boolean; message?: string };
}

export function buildGoogleAppsScriptCode(adminSecret = 'CHANGE_THIS_ADMIN_SECRET'): string {
  const safeSecret = String(adminSecret || 'CHANGE_THIS_ADMIN_SECRET').replace(/['"\\`\r\n]/g, '');
  return `/**
 * TaxCap Studio — Google Sheets License Server (Apps Script Web App)
 * Tối ưu chống vượt hạn mức Google Sheets:
 *  - CacheService 60 giây: Lượt check định kỳ 15p (delta=0) trả về ngay từ RAM, KHÔNG chạm vào Sheet.
 *  - LockService: Chống ghi đè khi nhiều người dùng đồng thời.
 *  - Single batch setValues(): Chỉ 1 lần ghi mỗi dòng khi cộng lượt hoặc đổi thiết bị.
 */
const DEFAULT_ADMIN_SECRET = '${safeSecret}';
const SHEET_NAME = 'Users';
const CACHE_KEY = 'TAXCAP_USERS_CACHE_V1';
const CACHE_TTL_SEC = 60;
const HEADERS = [
  'licenseKey',
  'userName',
  'status',
  'expiresAt',
  'maxDevices',
  'deviceIds',
  'dailyLimit',
  'usedToday',
  'usedDate',
  'totalSolved',
  'lastUsedAt',
  'note'
];

function getAdminSecret_() {
  var prop = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  return (prop && prop.trim()) ? prop.trim() : DEFAULT_ADMIN_SECRET;
}

function getVnToday_() {
  return Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
}

function getVnNowStr_() {
  return Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm:ss');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureUsersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e2e8f0');
  }
  return sheet;
}

function rowToUser_(row, rowIndex) {
  var devRaw = String(row[5] || '').trim();
  var deviceIds = devRaw ? devRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  return {
    rowIndex: rowIndex,
    licenseKey: String(row[0] || '').trim().toUpperCase(),
    userName: String(row[1] || '').trim(),
    status: String(row[2] || 'ACTIVE').trim().toUpperCase() === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
    expiresAt: row[3] instanceof Date
      ? Utilities.formatDate(row[3], 'GMT+7', 'yyyy-MM-dd')
      : (String(row[3] || 'FOREVER').trim().toUpperCase() || 'FOREVER'),
    maxDevices: Math.max(1, Number(row[4]) || 1),
    deviceIds: deviceIds,
    deviceCount: deviceIds.length,
    dailyLimit: Math.max(0, Number(row[6]) || 0),
    usedToday: Math.max(0, Number(row[7]) || 0),
    usedDate: row[8] instanceof Date
      ? Utilities.formatDate(row[8], 'GMT+7', 'yyyy-MM-dd')
      : String(row[8] || '').trim(),
    totalSolved: Math.max(0, Number(row[9]) || 0),
    lastUsedAt: row[10] instanceof Date
      ? Utilities.formatDate(row[10], 'GMT+7', 'yyyy-MM-dd HH:mm:ss')
      : String(row[10] || '').trim(),
    note: String(row[11] || '').trim()
  };
}

function userToRow_(u) {
  return [
    u.licenseKey,
    u.userName,
    u.status,
    u.expiresAt || 'FOREVER',
    Math.max(1, Number(u.maxDevices) || 1),
    (u.deviceIds || []).join(','),
    Math.max(0, Number(u.dailyLimit) || 0),
    Math.max(0, Number(u.usedToday) || 0),
    u.usedDate || '',
    Math.max(0, Number(u.totalSolved) || 0),
    u.lastUsedAt || '',
    u.note || ''
  ];
}

function loadUsersSnapshot_(bypassCache) {
  var cache = CacheService.getScriptCache();
  if (!bypassCache) {
    var cachedStr = cache.get(CACHE_KEY);
    if (cachedStr) {
      try {
        return JSON.parse(cachedStr);
      } catch (e) {}
    }
  }
  var sheet = ensureUsersSheet_();
  var lastRow = sheet.getLastRow();
  var users = [];
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim()) {
        users.push(rowToUser_(values[i], i + 2));
      }
    }
  }
  try {
    var serialized = JSON.stringify(users);
    if (serialized.length < 95000) {
      cache.put(CACHE_KEY, serialized, CACHE_TTL_SEC);
    }
  } catch (e) {}
  return users;
}

function invalidateCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY);
}

function isExpired_(expiresAt, todayKey) {
  var clean = String(expiresAt || 'FOREVER').trim().toUpperCase();
  if (!clean || clean === 'FOREVER') return false;
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(clean)) return false;
  return todayKey > clean;
}

function handleVerify_(body) {
  var licenseKey = String(body.licenseKey || '').trim().toUpperCase();
  var deviceId = String(body.deviceId || '').trim();
  var delta = Math.max(0, Math.min(500, Number(body.delta) || 0));
  var today = getVnToday_();

  if (!licenseKey || !deviceId) {
    return jsonOut_({ ok: false, reason: 'UNACTIVATED', message: 'Thiếu mã kích hoạt hoặc mã thiết bị.' });
  }

  // FAST PATH (0 lần mở/ghi Sheet!): Kiểm tra từ CacheService nếu đã gắn device & chưa cần cộng lượt
  if (delta === 0) {
    var fastUsers = loadUsersSnapshot_(false);
    var hit = null;
    for (var i = 0; i < fastUsers.length; i++) {
      if (fastUsers[i].licenseKey === licenseKey) { hit = fastUsers[i]; break; }
    }
    if (!hit) {
      return jsonOut_({ ok: false, reason: 'NOT_FOUND', message: 'Mã kích hoạt không tồn tại.' });
    }
    if (hit.status === 'LOCKED') {
      return jsonOut_({ ok: false, reason: 'LOCKED', userName: hit.userName, message: 'Tài khoản đã bị Admin tạm khóa.' });
    }
    if (isExpired_(hit.expiresAt, today)) {
      return jsonOut_({ ok: false, reason: 'EXPIRED', userName: hit.userName, expiresAt: hit.expiresAt, message: 'Mã kích hoạt đã hết hạn.' });
    }
    var knownDevice = hit.deviceIds.indexOf(deviceId) !== -1;
    var sameDay = hit.usedDate === today;
    var cachedUsedToday = sameDay ? hit.usedToday : 0;
    if (hit.dailyLimit > 0 && cachedUsedToday >= hit.dailyLimit) {
      return jsonOut_({
        ok: false,
        reason: 'DAILY_LIMIT',
        userName: hit.userName,
        expiresAt: hit.expiresAt,
        maxDevices: hit.maxDevices,
        deviceCount: hit.deviceIds.length,
        dailyLimit: hit.dailyLimit,
        usedToday: cachedUsedToday,
        usedDate: today,
        message: 'Đã hết hạn mức lượt hôm nay.'
      });
    }
    if (knownDevice && sameDay) {
      return jsonOut_({
        ok: true,
        cached: true,
        userName: hit.userName,
        status: hit.status,
        expiresAt: hit.expiresAt,
        maxDevices: hit.maxDevices,
        deviceCount: hit.deviceIds.length,
        dailyLimit: hit.dailyLimit,
        usedToday: cachedUsedToday,
        usedDate: today,
        totalSolved: hit.totalSolved
      });
    }
  }

  // WRITE PATH: Dùng LockService để chống xung đột khi nhiều người ghi cùng lúc
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var users = loadUsersSnapshot_(true);
    var target = null;
    for (var j = 0; j < users.length; j++) {
      if (users[j].licenseKey === licenseKey) { target = users[j]; break; }
    }
    if (!target) {
      return jsonOut_({ ok: false, reason: 'NOT_FOUND', message: 'Mã kích hoạt không tồn tại.' });
    }
    if (target.status === 'LOCKED') {
      return jsonOut_({ ok: false, reason: 'LOCKED', userName: target.userName, message: 'Tài khoản đã bị Admin tạm khóa.' });
    }
    if (isExpired_(target.expiresAt, today)) {
      return jsonOut_({ ok: false, reason: 'EXPIRED', userName: target.userName, expiresAt: target.expiresAt, message: 'Mã kích hoạt đã hết hạn.' });
    }

    var dirty = false;
    if (target.deviceIds.indexOf(deviceId) === -1) {
      if (target.deviceIds.length >= target.maxDevices) {
        return jsonOut_({
          ok: false,
          reason: 'DEVICE_LIMIT',
          userName: target.userName,
          maxDevices: target.maxDevices,
          deviceCount: target.deviceIds.length,
          message: 'Mã này đã đạt giới hạn ' + target.maxDevices + ' thiết bị.'
        });
      }
      target.deviceIds.push(deviceId);
      dirty = true;
    }

    if (target.usedDate !== today) {
      target.usedToday = 0;
      target.usedDate = today;
      dirty = true;
    }

    if (delta > 0) {
      target.usedToday += delta;
      target.totalSolved += delta;
      target.lastUsedAt = getVnNowStr_();
      dirty = true;
    } else if (dirty) {
      target.lastUsedAt = getVnNowStr_();
    }

    if (dirty) {
      var sheet = ensureUsersSheet_();
      sheet.getRange(target.rowIndex, 1, 1, HEADERS.length).setValues([userToRow_(target)]);
      invalidateCache_();
    }

    if (target.dailyLimit > 0 && target.usedToday > target.dailyLimit) {
      return jsonOut_({
        ok: false,
        reason: 'DAILY_LIMIT',
        userName: target.userName,
        expiresAt: target.expiresAt,
        maxDevices: target.maxDevices,
        deviceCount: target.deviceIds.length,
        dailyLimit: target.dailyLimit,
        usedToday: target.usedToday,
        usedDate: target.usedDate,
        message: 'Bạn đã dùng hết hạn mức lượt trong ngày hôm nay.'
      });
    }

    return jsonOut_({
      ok: true,
      userName: target.userName,
      status: target.status,
      expiresAt: target.expiresAt,
      maxDevices: target.maxDevices,
      deviceCount: target.deviceIds.length,
      dailyLimit: target.dailyLimit,
      usedToday: target.usedToday,
      usedDate: target.usedDate,
      totalSolved: target.totalSolved
    });
  } finally {
    lock.releaseLock();
  }
}

function handleDeactivate_(body) {
  var licenseKey = String(body.licenseKey || '').trim().toUpperCase();
  var deviceId = String(body.deviceId || '').trim();
  var delta = Math.max(0, Math.min(500, Number(body.delta) || 0));
  var today = getVnToday_();
  if (!licenseKey || !deviceId) return jsonOut_({ ok: true });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var users = loadUsersSnapshot_(true);
    var target = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].licenseKey === licenseKey) { target = users[i]; break; }
    }
    if (!target) return jsonOut_({ ok: true });

    target.deviceIds = target.deviceIds.filter(function(id) { return id !== deviceId; });
    if (delta > 0) {
      if (target.usedDate !== today) { target.usedToday = 0; target.usedDate = today; }
      target.usedToday += delta;
      target.totalSolved += delta;
      target.lastUsedAt = getVnNowStr_();
    }
    var sheet = ensureUsersSheet_();
    sheet.getRange(target.rowIndex, 1, 1, HEADERS.length).setValues([userToRow_(target)]);
    invalidateCache_();
    return jsonOut_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function isAuthorizedAdmin_(body) {
  var expected = getAdminSecret_();
  var provided = String(body.adminSecret || '').trim();
  return Boolean(expected && provided && provided === expected);
}

function handleAdminList_() {
  var users = loadUsersSnapshot_(false);
  return jsonOut_({ ok: true, users: users, today: getVnToday_() });
}

function handleAdminCreate_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = ensureUsersSheet_();
    var users = loadUsersSnapshot_(true);
    var key = String(body.licenseKey || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!key) {
      return jsonOut_({ ok: false, message: 'Mã kích hoạt không hợp lệ.' });
    }
    for (var i = 0; i < users.length; i++) {
      if (users[i].licenseKey === key) {
        return jsonOut_({ ok: false, message: 'Mã kích hoạt này đã tồn tại.' });
      }
    }
    var newUser = {
      licenseKey: key,
      userName: String(body.userName || 'Khách hàng mới').trim(),
      status: String(body.status || 'ACTIVE').toUpperCase() === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
      expiresAt: String(body.expiresAt || 'FOREVER').trim().toUpperCase() || 'FOREVER',
      maxDevices: Math.max(1, Number(body.maxDevices) || 2),
      deviceIds: [],
      dailyLimit: Math.max(0, Number(body.dailyLimit) || 0),
      usedToday: 0,
      usedDate: getVnToday_(),
      totalSolved: 0,
      lastUsedAt: '',
      note: String(body.note || '').trim()
    };
    sheet.appendRow(userToRow_(newUser));
    invalidateCache_();
    return jsonOut_({ ok: true, user: newUser });
  } finally {
    lock.releaseLock();
  }
}

function handleAdminUpdate_(body) {
  var key = String(body.licenseKey || '').trim().toUpperCase();
  if (!key) return jsonOut_({ ok: false, message: 'Thiếu mã kích hoạt.' });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var users = loadUsersSnapshot_(true);
    var target = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].licenseKey === key) { target = users[i]; break; }
    }
    if (!target) return jsonOut_({ ok: false, message: 'Không tìm thấy mã kích hoạt.' });

    if (body.status === 'ACTIVE' || body.status === 'LOCKED') target.status = body.status;
    if (typeof body.expiresAt === 'string' && body.expiresAt.trim()) target.expiresAt = body.expiresAt.trim().toUpperCase();
    if (body.maxDevices !== undefined) target.maxDevices = Math.max(1, Number(body.maxDevices) || 1);
    if (body.dailyLimit !== undefined) target.dailyLimit = Math.max(0, Number(body.dailyLimit) || 0);
    if (typeof body.userName === 'string') target.userName = body.userName.trim();
    if (typeof body.note === 'string') target.note = body.note.trim();
    if (body.resetDevices) target.deviceIds = [];

    var sheet = ensureUsersSheet_();
    sheet.getRange(target.rowIndex, 1, 1, HEADERS.length).setValues([userToRow_(target)]);
    invalidateCache_();
    return jsonOut_({ ok: true, user: target });
  } finally {
    lock.releaseLock();
  }
}

function handleAdminDelete_(body) {
  var key = String(body.licenseKey || '').trim().toUpperCase();
  if (!key) return jsonOut_({ ok: false, message: 'Thiếu mã kích hoạt.' });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var users = loadUsersSnapshot_(true);
    var target = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].licenseKey === key) { target = users[i]; break; }
    }
    if (!target) return jsonOut_({ ok: false, message: 'Không tìm thấy mã kích hoạt.' });
    var sheet = ensureUsersSheet_();
    sheet.deleteRow(target.rowIndex);
    invalidateCache_();
    return jsonOut_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return jsonOut_({ ok: true, service: 'taxcap-sheets-license', today: getVnToday_() });
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, message: 'JSON không hợp lệ.' });
  }
  var action = String(body.action || '');
  if (action === 'health') return jsonOut_({ ok: true, service: 'taxcap-sheets-license', today: getVnToday_() });
  if (action === 'verify') return handleVerify_(body);
  if (action === 'deactivate') return handleDeactivate_(body);

  if (action.indexOf('admin_') === 0) {
    if (!isAuthorizedAdmin_(body)) {
      return jsonOut_({ ok: false, unauthorized: true, message: 'Sai Mật khẩu Admin (ADMIN_SECRET).' });
    }
    if (action === 'admin_list') return handleAdminList_();
    if (action === 'admin_create') return handleAdminCreate_(body);
    if (action === 'admin_update') return handleAdminUpdate_(body);
    if (action === 'admin_delete') return handleAdminDelete_(body);
  }
  return jsonOut_({ ok: false, message: 'Hành động không hỗ trợ.' });
}

// Menu tiện ích ngay trong Google Sheets
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('TaxCap Admin')
    .addItem('1. Khởi tạo bảng Users', 'menuInitSheet')
    .addItem('2. Tạo nhanh mã 30 ngày', 'menuQuickCreate30Days')
    .addItem('3. Xóa Cache để đồng bộ ngay', 'menuClearCache')
    .addToUi();
}

function menuInitSheet() {
  ensureUsersSheet_();
  SpreadsheetApp.getUi().alert('Đã sẵn sàng bảng Users!');
}

function menuQuickCreate30Days() {
  var sheet = ensureUsersSheet_();
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var gen = function(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  };
  var code = 'TC-' + gen(4) + '-' + gen(4);
  var exp = Utilities.formatDate(new Date(Date.now() + 30 * 86400000), 'GMT+7', 'yyyy-MM-dd');
  sheet.appendRow([code, 'Khách mới', 'ACTIVE', exp, 2, '', 0, 0, getVnToday_(), 0, '', 'Tạo từ Sheet']);
  invalidateCache_();
  SpreadsheetApp.getUi().alert('Đã tạo mã mới: ' + code + ' (Hết hạn: ' + exp + ')');
}

function menuClearCache() {
  invalidateCache_();
  SpreadsheetApp.getUi().alert('Đã xóa bộ nhớ đệm CacheService!');
}
`;
}
