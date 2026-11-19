import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Unlock,
  CalendarPlus,
  BookOpen,
} from 'lucide-react';
import {
  addDaysToVnDateKey,
  buildGoogleAppsScriptCode,
  callSheetsApi,
  generateLicenseKey,
  getVnTodayDateKey,
  isExpiredLicenseDate,
  SHEET_HEADER_COLUMNS,
  summarizeSheetUsers,
  validateAppsScriptWebAppUrl,
  type SheetUserRecord,
} from '../utils/sheetsLicense';

export const SHEETS_URL_STORAGE_KEY = 'taxcap_sheets_url_v2';
const LEGACY_SHEETS_URL_STORAGE_KEY = 'taxcap_sheets_url';
const ADMIN_SECRET_STORAGE_KEY = 'taxcap_sheets_admin_secret_v2';
const LEGACY_ADMIN_SECRET_STORAGE_KEY = 'taxcap_sheets_admin_secret';

function purgeLegacySheetsStorageOnce() {
  try {
    if (localStorage.getItem(LEGACY_SHEETS_URL_STORAGE_KEY) !== null) {
      localStorage.removeItem(LEGACY_SHEETS_URL_STORAGE_KEY);
    }
    if (sessionStorage.getItem(LEGACY_ADMIN_SECRET_STORAGE_KEY) !== null) {
      sessionStorage.removeItem(LEGACY_ADMIN_SECRET_STORAGE_KEY);
    }
  } catch {
    // ignore storage access issues
  }
}

type StatusFilter = 'all' | 'active' | 'locked' | 'expired';

export const UsersAdminPanel: React.FC = () => {
  const [scriptUrl, setScriptUrl] = useState<string>(() => {
    purgeLegacySheetsStorageOnce();
    return localStorage.getItem(SHEETS_URL_STORAGE_KEY) || '';
  });
  const [adminSecret, setAdminSecret] = useState<string>(() => {
    purgeLegacySheetsStorageOnce();
    return sessionStorage.getItem(ADMIN_SECRET_STORAGE_KEY) || '';
  });
  const [showSecret, setShowSecret] = useState<boolean>(false);

  const [users, setUsers] = useState<SheetUserRecord[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [actionBusyKey, setActionBusyKey] = useState<string>('');
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string>('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState<boolean>(() => !localStorage.getItem(SHEETS_URL_STORAGE_KEY));

  // Generator state for Code.gs setup helper
  const [setupSecretDraft, setSetupSecretDraft] = useState<string>('taxcap-admin-2026');
  const [copiedScript, setCopiedScript] = useState<boolean>(false);
  const [copiedUserKey, setCopiedUserKey] = useState<string>('');

  // Create new license form
  const [newKey, setNewKey] = useState<string>(() => generateLicenseKey());
  const [newName, setNewName] = useState<string>('');
  const [newDuration, setNewDuration] = useState<'7' | '30' | '90' | '365' | 'FOREVER' | 'CUSTOM'>('30');
  const [newCustomDate, setNewCustomDate] = useState<string>(() => addDaysToVnDateKey(30));
  const [newMaxDevices, setNewMaxDevices] = useState<number>(2);
  const [newDailyLimit, setNewDailyLimit] = useState<number>(0);
  const [newNote, setNewNote] = useState<string>('');
  const [creating, setCreating] = useState<boolean>(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const todayKey = getVnTodayDateKey();

  const handleScriptUrlChange = (val: string) => {
    setScriptUrl(val);
    if (val.trim()) {
      localStorage.setItem(SHEETS_URL_STORAGE_KEY, val.trim());
    } else {
      localStorage.removeItem(SHEETS_URL_STORAGE_KEY);
    }
  };

  const handleSecretChange = (val: string) => {
    setAdminSecret(val);
    if (val) {
      sessionStorage.setItem(ADMIN_SECRET_STORAGE_KEY, val);
    } else {
      sessionStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
    }
  };

  const handleResetSheetConnection = () => {
    setScriptUrl('');
    setAdminSecret('');
    setUsers([]);
    setConnected(false);
    setShowSetupGuide(true);
    localStorage.removeItem(SHEETS_URL_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SHEETS_URL_STORAGE_KEY);
    sessionStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
    sessionStorage.removeItem(LEGACY_ADMIN_SECRET_STORAGE_KEY);
    setFeedback({
      type: 'ok',
      text: 'Đã xóa liên kết Google Sheet cũ. Hãy làm theo 4 bước bên dưới để tạo Sheet mới và dán URL Apps Script mới.',
    });
  };

  const fetchUsers = useCallback(
    async (explicitUrl?: string, explicitSecret?: string) => {
      const url = (explicitUrl ?? scriptUrl).trim();
      const secret = (explicitSecret ?? adminSecret).trim();
      if (!url || !secret) {
        setFeedback({ type: 'err', text: 'Hãy nhập đủ URL Google Apps Script và Mật khẩu Admin.' });
        return;
      }
      if (!validateAppsScriptWebAppUrl(url)) {
        setFeedback({
          type: 'err',
          text: 'URL phải có dạng https://script.google.com/macros/s/.../exec',
        });
        return;
      }

      setLoading(true);
      setFeedback(null);
      try {
        const res = await callSheetsApi<{ users?: SheetUserRecord[] }>(url, {
          action: 'admin_list',
          adminSecret: secret,
        });
        if (!res.ok) {
          setConnected(false);
          setFeedback({ type: 'err', text: res.message || 'Không xác thực được quyền Admin.' });
          return;
        }
        setUsers(Array.isArray(res.users) ? res.users : []);
        setConnected(true);
        localStorage.setItem(SHEETS_URL_STORAGE_KEY, url);
        setShowSetupGuide(false);
      } catch (err) {
        setConnected(false);
        setFeedback({
          type: 'err',
          text: err instanceof Error ? err.message : 'Lỗi kết nối Google Apps Script.',
        });
      } finally {
        setLoading(false);
      }
    },
    [scriptUrl, adminSecret],
  );

  useEffect(() => {
    if (scriptUrl.trim() && adminSecret.trim()) {
      fetchUsers(scriptUrl, adminSecret);
    }
    // Only auto-connect once on initial mount if credentials are already in session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = useMemo(() => summarizeSheetUsers(users, todayKey), [users, todayKey]);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      const expired = isExpiredLicenseDate(u.expiresAt, todayKey);
      if (statusFilter === 'active' && (u.status !== 'ACTIVE' || expired)) return false;
      if (statusFilter === 'locked' && u.status !== 'LOCKED') return false;
      if (statusFilter === 'expired' && !expired) return false;
      if (!q) return true;
      return (
        u.licenseKey.toLowerCase().includes(q) ||
        u.userName.toLowerCase().includes(q) ||
        u.note.toLowerCase().includes(q)
      );
    });
  }, [users, searchQuery, statusFilter, todayKey]);

  const handleCopyCodeGs = async () => {
    const gs = buildGoogleAppsScriptCode(setupSecretDraft || 'taxcap-admin-2026');
    await navigator.clipboard.writeText(gs).catch(() => {});
    setCopiedScript(true);
    if (!adminSecret) {
      handleSecretChange(setupSecretDraft || 'taxcap-admin-2026');
    }
    setTimeout(() => setCopiedScript(false), 1800);
  };

  const handleCopyLicenseKey = async (key: string) => {
    await navigator.clipboard.writeText(key).catch(() => {});
    setCopiedUserKey(key);
    setTimeout(() => setCopiedUserKey(''), 1500);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connected) {
      setFeedback({ type: 'err', text: 'Hãy kết nối Google Sheets trước khi tạo mã.' });
      return;
    }
    const cleanKey = newKey.trim().toUpperCase();
    if (!cleanKey) {
      setFeedback({ type: 'err', text: 'Mã kích hoạt không được để trống.' });
      return;
    }
    const expiresAt =
      newDuration === 'FOREVER'
        ? 'FOREVER'
        : newDuration === 'CUSTOM'
          ? newCustomDate
          : addDaysToVnDateKey(Number(newDuration), todayKey);

    setCreating(true);
    setFeedback(null);
    try {
      const res = await callSheetsApi<{ user?: SheetUserRecord }>(scriptUrl, {
        action: 'admin_create',
        adminSecret,
        licenseKey: cleanKey,
        userName: newName.trim() || 'Khách hàng mới',
        status: 'ACTIVE',
        expiresAt,
        maxDevices: newMaxDevices,
        dailyLimit: newDailyLimit,
        note: newNote.trim(),
      });
      if (!res.ok) {
        setFeedback({ type: 'err', text: res.message || 'Không tạo được mã kích hoạt.' });
        return;
      }
      await navigator.clipboard.writeText(cleanKey).catch(() => {});
      setFeedback({ type: 'ok', text: `Đã tạo & sao chép mã ${cleanKey} (Hạn: ${expiresAt === 'FOREVER' ? 'Vĩnh viễn' : expiresAt}).` });
      setNewKey(generateLicenseKey());
      setNewName('');
      setNewNote('');
      await fetchUsers();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Lỗi tạo mã.' });
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateUser = async (
    user: SheetUserRecord,
    patch: { status?: 'ACTIVE' | 'LOCKED'; expiresAt?: string; resetDevices?: boolean },
    successLabel: string,
  ) => {
    setActionBusyKey(user.licenseKey);
    setFeedback(null);
    try {
      const res = await callSheetsApi(scriptUrl, {
        action: 'admin_update',
        adminSecret,
        licenseKey: user.licenseKey,
        ...patch,
      });
      if (!res.ok) {
        setFeedback({ type: 'err', text: res.message || 'Không cập nhật được.' });
        return;
      }
      setFeedback({ type: 'ok', text: `${user.licenseKey}: ${successLabel}` });
      await fetchUsers();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Lỗi cập nhật.' });
    } finally {
      setActionBusyKey('');
    }
  };

  const handleDeleteUser = async (licenseKey: string) => {
    setActionBusyKey(licenseKey);
    setConfirmDeleteKey('');
    setFeedback(null);
    try {
      const res = await callSheetsApi(scriptUrl, {
        action: 'admin_delete',
        adminSecret,
        licenseKey,
      });
      if (!res.ok) {
        setFeedback({ type: 'err', text: res.message || 'Không xóa được tài khoản.' });
        return;
      }
      setFeedback({ type: 'ok', text: `Đã xóa mã ${licenseKey}.` });
      await fetchUsers();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Lỗi xóa tài khoản.' });
    } finally {
      setActionBusyKey('');
    }
  };

  return (
    <div className="space-y-6">
      {/* Connection Header Card */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-emerald-700 shrink-0" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Quản lý Người dùng qua Google Sheets
              </h2>
              <p className="text-xs text-slate-600">
                Extension đồng bộ mỗi <span className="font-semibold">15 phút</span> hoặc gom lô <span className="font-semibold">10 lượt</span> + <code className="font-mono">CacheService</code> phía Google Apps Script để tránh vượt hạn mức.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(scriptUrl.trim() || connected) && (
              <button
                type="button"
                onClick={handleResetSheetConnection}
                className="whitespace-nowrap inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Xóa link cũ / Đổi Sheet mới</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSetupGuide((v) => !v)}
              className="whitespace-nowrap inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span>{showSetupGuide ? 'Ẩn hướng dẫn cài đặt' : 'Hướng dẫn cài từ đầu (Code · Sheet · GitHub Pages)'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-12 items-end">
          <div className="md:col-span-6">
            <label htmlFor="sheets-url-input" className="block text-xs font-medium text-slate-700">
              URL Google Apps Script Web App
            </label>
            <input
              id="sheets-url-input"
              type="url"
              value={scriptUrl}
              onChange={(e) => handleScriptUrlChange(e.target.value)}
              placeholder="https://script.google.com/macros/s/.../exec"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
            />
          </div>

          <div className="md:col-span-4">
            <label htmlFor="sheets-secret-input" className="block text-xs font-medium text-slate-700">
              Mật khẩu Admin (ADMIN_SECRET)
            </label>
            <div className="relative mt-1">
              <input
                id="sheets-secret-input"
                type={showSecret ? 'text' : 'password'}
                value={adminSecret}
                onChange={(e) => handleSecretChange(e.target.value)}
                placeholder="Nhập mật khẩu trong Code.gs..."
                className="w-full rounded-lg border border-slate-300 pl-3 pr-9 py-2 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
              />
              <button
                type="button"
                aria-label={showSecret ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
              >
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <button
              type="button"
              onClick={() => fetchUsers()}
              disabled={loading}
              className="w-full whitespace-nowrap inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{connected ? 'Tải lại' : 'Kết nối'}</span>
            </button>
          </div>
        </div>

        {feedback && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs font-medium ${
              feedback.type === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-rose-200 bg-rose-50 text-rose-900'
            }`}
          >
            {feedback.text}
          </div>
        )}

        {/* Setup Guide Drawer */}
        {showSetupGuide && (
          <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-sky-950">
                  Hướng dẫn cài đặt trọn gói từ đầu (Cài Code · Google Sheet mới · GitHub Pages · Extension)
                </div>
                <p className="mt-0.5 text-[11px] text-sky-900/80">
                  Đặt mật khẩu Admin trước, sau đó bấm <strong>Sao chép Code.gs</strong> (đã có sẵn 12 cột tiêu đề song ngữ Anh – Việt).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={setupSecretDraft}
                  onChange={(e) => setSetupSecretDraft(e.target.value)}
                  aria-label="Đặt mật khẩu Admin trước khi sao chép Code.gs"
                  placeholder="Đặt Mật khẩu Admin..."
                  className="rounded-md border border-sky-300 bg-white px-2.5 py-1 font-mono text-xs text-slate-900 w-44"
                />
                <button
                  type="button"
                  onClick={handleCopyCodeGs}
                  className="whitespace-nowrap inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800"
                >
                  {copiedScript ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedScript ? 'Đã chép Code.gs' : 'Sao chép Code.gs'}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-xs leading-relaxed text-slate-700">
              <div className="rounded-lg border border-sky-200 bg-white p-3.5 space-y-1.5">
                <div className="font-semibold text-slate-900">Bước 1 — Cài Code trên máy (nếu chạy nội bộ hoặc sửa code)</div>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Cài sẵn <strong>Node.js 20+</strong>, tải hoặc giải nén thư mục mã nguồn dự án về máy.</li>
                  <li>Mở Terminal tại thư mục dự án, chạy <code className="font-mono bg-slate-100 px-1 rounded">npm install</code> để cài gói phụ thuộc.</li>
                  <li>Nếu muốn chạy cả Backend Proxy: tạo file <code className="font-mono bg-slate-100 px-1 rounded">.env</code> từ <code className="font-mono bg-slate-100 px-1 rounded">.env.example</code> rồi chạy <code className="font-mono bg-slate-100 px-1 rounded">npm run dev</code> (mở <code className="font-mono">http://localhost:3000</code>).</li>
                  <li>Nếu chỉ cần trang Admin + tải Extension miễn phí, đẩy thẳng lên GitHub ở Bước 3 (không cần thuê server).</li>
                </ol>
              </div>

              <div className="rounded-lg border border-sky-200 bg-white p-3.5 space-y-1.5">
                <div className="font-semibold text-slate-900">Bước 2 — Tạo Google Sheet mới &amp; triển khai Apps Script</div>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Truy cập <code className="font-mono">sheets.new</code> để tạo 1 file Google Sheet mới (để quyền <strong>Riêng tư</strong>, không cần share).</li>
                  <li>Vào menu <strong>Tiện ích mở rộng (Extensions) → Apps Script</strong>.</li>
                  <li>Xóa hết code mặc định, dán đoạn <code className="font-mono">Code.gs</code> vừa sao chép ở nút trên và bấm <strong>Lưu (Ctrl+S)</strong>.</li>
                  <li>(Tùy chọn) Chọn hàm <code className="font-mono">menuInitSheet</code> → bấm <strong>Chạy (Run)</strong> và cấp quyền để tạo ngay sheet <strong>Users</strong> với 12 tiêu đề song ngữ Anh – Việt.</li>
                  <li>Bấm <strong>Triển khai (Deploy) → Tùy chọn triển khai mới → Ứng dụng web (Web app)</strong>:
                    <ul className="list-disc pl-4 mt-0.5 text-[11px] text-slate-600">
                      <li>Thực thi dưới tên: <strong>Tôi (Me)</strong></li>
                      <li>Ai có quyền truy cập: <strong>Bất kỳ ai (Anyone)</strong></li>
                    </ul>
                  </li>
                  <li>Chép URL <code className="font-mono">https://script.google.com/macros/s/.../exec</code> dán vào ô phía trên và bấm <strong>Kết nối</strong>.</li>
                </ol>
              </div>

              <div className="rounded-lg border border-sky-200 bg-white p-3.5 space-y-1.5">
                <div className="font-semibold text-slate-900">Bước 3 — Đưa trang quản trị lên GitHub Pages (Miễn phí)</div>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Tạo 1 repository mới trên GitHub và đẩy toàn bộ mã nguồn lên nhánh <code className="font-mono">main</code> (dự án đã có sẵn file <code className="font-mono">.github/workflows/deploy-pages.yml</code>).</li>
                  <li>Trên repo GitHub, vào <strong>Settings → Pages</strong> → mục <strong>Build and deployment / Source</strong> chọn <strong>GitHub Actions</strong>.</li>
                  <li>Vào tab <strong>Actions</strong> chờ workflow <em>Deploy TaxCap Studio to GitHub Pages</em> chạy xanh (~1 phút).</li>
                  <li>Mở link <code className="font-mono">https://&lt;tên-github&gt;.github.io/&lt;tên-repo&gt;/</code> → vào tab <strong>Quản lý User</strong> dán URL Apps Script mới + Mật khẩu Admin.</li>
                </ol>
              </div>

              <div className="rounded-lg border border-sky-200 bg-white p-3.5 space-y-1.5">
                <div className="font-semibold text-slate-900">Bước 4 — Tạo Mã kích hoạt &amp; gửi Extension 3-trong-1</div>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Ở khung <strong>Tạo mã kích hoạt mới</strong> bên dưới, nhập tên khách, thời hạn, số máy → bấm <strong>Tạo &amp; Sao chép mã</strong>.</li>
                  <li>Chuyển sang tab <strong>Tải &amp; Cài Extension</strong> (URL Sheet mới đã tự đồng bộ sẵn) → bấm <strong>Tải Extension Hợp Nhất (.zip)</strong>.</li>
                  <li>Gửi file <code className="font-mono">taxcap-suite-mv3.zip</code> + mã kích hoạt cho người dùng để giải nén và cài qua <code className="font-mono">chrome://extensions</code> → <strong>Developer mode</strong> → <strong>Load unpacked</strong>.</li>
                </ol>
              </div>
            </div>

            {/* Bilingual 12-column schema reference */}
            <div className="rounded-lg border border-sky-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 bg-slate-50 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900">
                  Cấu trúc 12 cột tiêu đề song ngữ (Anh – Việt) trong sheet Users
                </span>
                <span className="text-[11px] text-slate-500">
                  Tự động tạo khi chạy <code className="font-mono">Code.gs</code> lần đầu hoặc từ menu <strong>TaxCap Admin</strong> trong Sheet
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 sm:gap-px bg-slate-100">
                {SHEET_HEADER_COLUMNS.map((col, idx) => (
                  <div key={col.key} className="bg-white px-3 py-2 text-[11px]">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono text-[10px] text-slate-400">{String.fromCharCode(65 + idx)}</span>
                      <code className="font-mono font-semibold text-slate-900">{col.key}</code>
                      <span className="font-medium text-sky-800">({col.viLabel})</span>
                    </div>
                    <p className="mt-0.5 text-slate-500 leading-snug">{col.description}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50/80 px-3 py-2 text-[11.5px] text-emerald-900">
              <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
              <span>
                <strong>Chống chạm giới hạn Google Sheets:</strong> Extension lưu cache cục bộ <strong>15 phút</strong> và gom mỗi <strong>10 lượt giải</strong> mới đồng bộ 1 lần; phía Apps Script có thêm <code className="font-mono">CacheService</code> (60s) và <code className="font-mono">LockService</code> nên 1 người dùng chỉ tạo ~15–25 request/ngày.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Tổng mã kích hoạt</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-slate-900">{summary.totalUsers}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Đang hoạt động</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-emerald-700">{summary.activeCount}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Đã khóa / Hết hạn</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-amber-700">
            {summary.lockedCount + summary.expiredCount}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Tổng captcha đã giải</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-sky-700">{summary.totalSolvedAll}</div>
        </div>
      </div>

      {/* Create New User / License Key */}
      <form onSubmit={handleCreateUser} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-sky-700" />
            <span>Tạo mã kích hoạt mới</span>
          </h3>
          <span className="text-xs text-slate-500">Tự động sao chép mã sau khi tạo</span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-slate-700">Tên người dùng / Khách</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Ví dụ: Kế toán Minh Anh"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
            />
          </div>

          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-slate-700">Mã kích hoạt</label>
            <div className="mt-1 flex gap-1.5">
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                className="flex-1 min-w-0 rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs uppercase text-slate-900 focus:border-sky-600 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setNewKey(generateLicenseKey())}
                className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Đổi mã
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">Thời hạn</label>
            <select
              value={newDuration}
              onChange={(e) => setNewDuration(e.target.value as typeof newDuration)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
            >
              <option value="7">7 ngày</option>
              <option value="30">1 tháng (30 ngày)</option>
              <option value="90">3 tháng (90 ngày)</option>
              <option value="365">1 năm (365 ngày)</option>
              <option value="FOREVER">Vĩnh viễn</option>
              <option value="CUSTOM">Chọn ngày...</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">Số máy tối đa</label>
            <select
              value={newMaxDevices}
              onChange={(e) => setNewMaxDevices(Number(e.target.value) || 1)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
            >
              <option value={1}>1 máy</option>
              <option value={2}>2 máy</option>
              <option value={3}>3 máy</option>
              <option value={5}>5 máy</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 items-end">
          {newDuration === 'CUSTOM' && (
            <div className="sm:col-span-3">
              <label className="block text-xs font-medium text-slate-700">Ngày hết hạn</label>
              <input
                type="date"
                value={newCustomDate}
                onChange={(e) => setNewCustomDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900"
              />
            </div>
          )}

          <div className={newDuration === 'CUSTOM' ? 'sm:col-span-3' : 'sm:col-span-3'}>
            <label className="block text-xs font-medium text-slate-700">Giới hạn lượt/ngày (0 = không giới hạn)</label>
            <input
              type="number"
              min={0}
              value={newDailyLimit}
              onChange={(e) => setNewDailyLimit(Math.max(0, Number(e.target.value) || 0))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900"
            />
          </div>

          <div className={newDuration === 'CUSTOM' ? 'sm:col-span-4' : 'sm:col-span-6'}>
            <label className="block text-xs font-medium text-slate-700">Ghi chú (Zalo / SĐT / Gói)</label>
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Ví dụ: Zalo 0901xxx - Gói năm"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
            />
          </div>

          <div className={newDuration === 'CUSTOM' ? 'sm:col-span-2' : 'sm:col-span-3'}>
            <button
              type="submit"
              disabled={creating || !connected}
              className="w-full whitespace-nowrap inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-700 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{creating ? 'Đang lưu...' : 'Tạo & Sao chép mã'}</span>
            </button>
          </div>
        </div>
      </form>

      {/* Users Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm tên, mã hoặc ghi chú..."
                className="rounded-lg border border-slate-200 pl-8 pr-3 py-1.5 text-xs text-slate-900 w-56 focus:border-sky-600 focus:outline-none"
              />
            </div>
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
              {(
                [
                  { id: 'all', label: 'Tất cả' },
                  { id: 'active', label: 'Đang bật' },
                  { id: 'locked', label: 'Đã khóa' },
                  { id: 'expired', label: 'Hết hạn' },
                ] as { id: StatusFilter; label: string }[]
              ).map((pill) => (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setStatusFilter(pill.id)}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                    statusFilter === pill.id
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>
          </div>

          <span className="text-xs text-slate-500">Hiển thị {filteredUsers.length}/{users.length}</span>
        </div>

        {!connected ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Nhập URL Google Apps Script và Mật khẩu Admin ở khung trên rồi bấm <strong>Kết nối</strong> để xem và quản lý danh sách người dùng.
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Chưa có mã kích hoạt nào khớp bộ lọc.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Người dùng &amp; Mã</th>
                  <th className="px-3 py-2.5 font-semibold">Trạng thái</th>
                  <th className="px-3 py-2.5 font-semibold">Hết hạn</th>
                  <th className="px-3 py-2.5 font-semibold">Thiết bị</th>
                  <th className="px-3 py-2.5 font-semibold">Hôm nay / Tổng</th>
                  <th className="px-3 py-2.5 font-semibold">Dùng gần nhất</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Thao tác 1 chạm</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredUsers.map((u) => {
                  const expired = isExpiredLicenseDate(u.expiresAt, todayKey);
                  const busy = actionBusyKey === u.licenseKey;
                  const usedTodayClean = u.usedDate === todayKey ? u.usedToday : 0;

                  return (
                    <tr key={u.licenseKey} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{u.userName || '—'}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <code className="font-mono text-[11px] font-semibold text-sky-800 bg-sky-50 px-1.5 py-0.5 rounded border border-sky-200">
                            {u.licenseKey}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyLicenseKey(u.licenseKey)}
                            aria-label={`Sao chép mã ${u.licenseKey}`}
                            className="text-slate-400 hover:text-slate-700"
                          >
                            {copiedUserKey === u.licenseKey ? (
                              <Check className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                        {u.note && <div className="mt-0.5 text-[11px] text-slate-500">{u.note}</div>}
                      </td>

                      <td className="px-3 py-3">
                        {u.status === 'LOCKED' ? (
                          <span className="inline-flex items-center rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 border border-rose-200">
                            Đã khóa
                          </span>
                        ) : expired ? (
                          <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-200">
                            Hết hạn
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                            Đang bật
                          </span>
                        )}
                      </td>

                      <td className="px-3 py-3 font-mono tabular-nums text-slate-700">
                        {u.expiresAt === 'FOREVER' ? 'Vĩnh viễn' : u.expiresAt}
                      </td>

                      <td className="px-3 py-3 font-mono tabular-nums text-slate-700">
                        {u.deviceCount}/{u.maxDevices}
                      </td>

                      <td className="px-3 py-3 font-mono tabular-nums text-slate-700">
                        {u.dailyLimit > 0 ? `${usedTodayClean}/${u.dailyLimit}` : usedTodayClean} ·{' '}
                        <span className="font-semibold text-slate-900">{u.totalSolved}</span>
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-slate-500">
                        {u.lastUsedAt || 'Chưa dùng'}
                      </td>

                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handleUpdateUser(
                                u,
                                { status: u.status === 'LOCKED' ? 'ACTIVE' : 'LOCKED' },
                                u.status === 'LOCKED' ? 'Đã mở khóa' : 'Đã khóa tài khoản',
                              )
                            }
                            className={`whitespace-nowrap inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${
                              u.status === 'LOCKED'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                                : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                            }`}
                          >
                            {u.status === 'LOCKED' ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                            <span>{u.status === 'LOCKED' ? 'Mở khóa' : 'Khóa'}</span>
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              const base =
                                u.expiresAt !== 'FOREVER' && !expired ? u.expiresAt : todayKey;
                              const nextDate = addDaysToVnDateKey(30, base);
                              handleUpdateUser(u, { expiresAt: nextDate }, `Đã gia hạn tới ${nextDate}`);
                            }}
                            className="whitespace-nowrap inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <CalendarPlus className="h-3 w-3" />
                            <span>+30 ngày</span>
                          </button>

                          <button
                            type="button"
                            disabled={busy || u.deviceCount === 0}
                            onClick={() =>
                              handleUpdateUser(u, { resetDevices: true }, 'Đã xóa danh sách thiết bị')
                            }
                            className="whitespace-nowrap inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>Reset máy</span>
                          </button>

                          {confirmDeleteKey === u.licenseKey ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDeleteUser(u.licenseKey)}
                              className="whitespace-nowrap rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700"
                            >
                              Xác nhận xóa
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`Xóa mã ${u.licenseKey}`}
                              onClick={() => setConfirmDeleteKey(u.licenseKey)}
                              className="rounded-md border border-slate-200 bg-white p-1 text-slate-400 hover:text-rose-600 hover:border-rose-200"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
