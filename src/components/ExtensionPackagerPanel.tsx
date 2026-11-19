import React, { useMemo, useState } from 'react';
import { Download, Copy, Check, FileCode2, ShieldCheck } from 'lucide-react';
import {
  buildBrowserExtensionFiles,
  buildBrowserExtensionZipBlob,
  type ExtensionFileGroup,
} from '../utils/browserExtensionZip';
import { SHEETS_URL_STORAGE_KEY } from './UsersAdminPanel';

interface ExtensionPackagerPanelProps {
  tokenRequired?: boolean;
}

type GroupFilter = 'all' | ExtensionFileGroup;

const GROUP_TABS: { id: GroupFilter; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'core', label: 'Lõi & Side Panel' },
  { id: 'hddt', label: 'Tab 1: Tải HĐĐT' },
  { id: 'hoso', label: 'Tab 2: Tải Hồ sơ' },
  { id: 'captcha', label: 'Tab 3: Captcha' },
];

export const ExtensionPackagerPanel: React.FC<ExtensionPackagerPanelProps> = ({ tokenRequired = false }) => {
  const [connectionMode, setConnectionMode] = useState<'direct' | 'proxy'>('direct');
  const [licenseApiUrl, setLicenseApiUrl] = useState<string>(
    () => localStorage.getItem(SHEETS_URL_STORAGE_KEY) || '',
  );
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => window.location.origin);
  const [accessToken, setAccessToken] = useState<string>('');
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all');
  const [selectedPath, setSelectedPath] = useState<string>('manifest.json');
  const [copied, setCopied] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloadError, setDownloadError] = useState<string>('');

  const files = useMemo(
    () =>
      buildBrowserExtensionFiles({
        connectionMode,
        apiBaseUrl,
        accessToken,
        licenseApiUrl,
      }),
    [connectionMode, apiBaseUrl, accessToken, licenseApiUrl],
  );

  const visibleFiles = useMemo(
    () => (groupFilter === 'all' ? files : files.filter((f) => f.group === groupFilter)),
    [files, groupFilter],
  );

  const activeFile =
    visibleFiles.find((f) => f.path === selectedPath) || visibleFiles[0] || files[0];

  const handleLicenseUrlChange = (val: string) => {
    setLicenseApiUrl(val);
    if (val.trim()) {
      localStorage.setItem(SHEETS_URL_STORAGE_KEY, val.trim());
    } else {
      localStorage.removeItem(SHEETS_URL_STORAGE_KEY);
    }
  };

  const handleCopy = async () => {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownloadZip = async () => {
    setDownloading(true);
    setDownloadError('');
    try {
      const { blob } = await buildBrowserExtensionZipBlob({
        connectionMode,
        apiBaseUrl,
        accessToken,
        licenseApiUrl,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'taxcap-suite-mv3.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Không đóng gói được tệp zip.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Configuration & Download Card */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        <div className="lg:col-span-7 h-full flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 space-y-4">
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Đóng gói Extension hợp nhất 3 trong 1 (Side Panel MV3)
              </h2>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                Một gói cài đặt duy nhất gồm 3 tab trên thanh Side Panel:{' '}
                <span className="font-semibold text-slate-800">1. Tải HĐĐT</span>,{' '}
                <span className="font-semibold text-slate-800">2. Tải Hồ sơ thuế</span> và{' '}
                <span className="font-semibold text-slate-800">3. Tự điền Captcha</span> — dùng chung 1 mã kích hoạt Google Sheets và 1 bộ giải SVG cho cổng Hóa đơn điện tử.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                <div className="font-semibold text-slate-900">Tab 1 · Tải HĐĐT</div>
                <p className="mt-0.5 text-[11px] text-slate-600">
                  Xuất Excel, XML, HTML, PDF có font tiếng Việt, kiểm tra rủi ro &amp; hỗ trợ file Excel &gt;40MB.
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                <div className="font-semibold text-slate-900">Tab 2 · Tải Hồ sơ</div>
                <p className="mt-0.5 text-[11px] text-slate-600">
                  Tra cứu &amp; tải hàng loạt tờ khai, thông báo trên DVC (từ 07/2025) và Thuế ĐT.
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                <div className="font-semibold text-slate-900">Tab 3 · Captcha</div>
                <p className="mt-0.5 text-[11px] text-slate-600">
                  Tự điền 4 cổng Thuế/DVC, 4 tab con (Captcha, Cấu hình, Kho dữ liệu, Nhật ký).
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="packager-license-url" className="block text-xs font-medium text-slate-700">
                URL Google Apps Script gắn sẵn (Khóa kích hoạt chung cả 3 tính năng)
              </label>
              <input
                id="packager-license-url"
                type="url"
                value={licenseApiUrl}
                onChange={(e) => handleLicenseUrlChange(e.target.value)}
                placeholder="https://script.google.com/macros/s/.../exec (tự đồng bộ từ tab Quản lý User)"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Khi điền sẵn URL này trước khi tải file <code className="font-mono">.zip</code>, người dùng cuối chỉ cần nhập <strong>Mã kích hoạt</strong> để mở khóa cả 3 tab.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setConnectionMode('direct')}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  connectionMode === 'direct'
                    ? 'border-sky-600 bg-sky-50/70'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div className="text-xs font-semibold text-slate-900">Độc lập 100% (Khuyên dùng)</div>
                <div className="mt-0.5 text-[11px] text-slate-600">
                  Dán Gemini API Key trong tab Captcha → Cấu hình. Hoạt động hoàn toàn cục bộ, không cần server.
                </div>
              </button>

              <button
                type="button"
                onClick={() => setConnectionMode('proxy')}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  connectionMode === 'proxy'
                    ? 'border-sky-600 bg-sky-50/70'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div className="text-xs font-semibold text-slate-900">Qua Backend Proxy (Tùy chọn)</div>
                <div className="mt-0.5 text-[11px] text-slate-600">
                  Dùng chung API Key, Kho dữ liệu và model ONNX qua một server riêng.
                </div>
              </button>
            </div>

            {connectionMode === 'direct' ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3.5 py-3 text-xs leading-relaxed text-emerald-950 space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-900">
                  <ShieldCheck className="h-4 w-4 text-emerald-700" />
                  <span>Khóa bản quyền chung 2 lớp · Không gián đoạn khi chuyển tab</span>
                </div>
                <ul className="list-disc pl-4 space-y-1 text-emerald-900">
                  <li>
                    <span className="font-semibold">Bảo vệ toàn bộ 3 tab:</span> Chưa kích hoạt hoặc hết hạn sẽ khóa đồng thời Side Panel, tự điền Captcha và lệnh tải tệp HĐĐT/Hồ sơ.
                  </li>
                  <li>
                    <span className="font-semibold">Dùng chung bộ giải SVG:</span> Nạp một lần duy nhất trên <code className="font-mono">hoadondientu.gdt.gov.vn</code> cho cả đăng nhập và tra hóa đơn máy tính tiền.
                  </li>
                </ul>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="proxy-url-input" className="block text-xs font-medium text-slate-700">
                      URL Backend Proxy (API Server)
                    </label>
                    <input
                      id="proxy-url-input"
                      type="url"
                      value={apiBaseUrl}
                      onChange={(e) => setApiBaseUrl(e.target.value)}
                      placeholder="https://your-proxy-url.run.app"
                      className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label htmlFor="team-token-input" className="block text-xs font-medium text-slate-700">
                      {tokenRequired ? 'Mã truy cập nhóm (Bắt buộc)' : 'Mã truy cập nhóm (Tùy chọn)'}
                    </label>
                    <input
                      id="team-token-input"
                      type="text"
                      value={accessToken}
                      onChange={(e) => setAccessToken(e.target.value)}
                      placeholder={tokenRequired ? 'Nhập đúng EXTENSION_SHARED_TOKEN' : 'Để trống nếu không đặt mật khẩu'}
                      className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}

            {downloadError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {downloadError}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
            <span className="text-xs text-slate-500 tabular-nums">
              Gói zip gồm {files.length} tệp mã nguồn + 5 tệp font PDF/UI + 2 icon PNG 48/128px.
            </span>
            <button
              type="button"
              onClick={handleDownloadZip}
              disabled={downloading}
              data-testid="download-zip-link"
              className="whitespace-nowrap shrink-0 inline-flex items-center gap-2 rounded-lg bg-sky-700 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              <span>{downloading ? 'Đang đóng gói...' : 'Tải Extension Hợp Nhất (.zip)'}</span>
            </button>
          </div>
        </div>

        {/* Setup Guide */}
        <div className="lg:col-span-5 h-full rounded-xl border border-slate-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-slate-900">5 bước cài đặt cho người dùng</h3>
          <ol className="mt-3 space-y-2.5 text-xs leading-relaxed text-slate-600">
            <li>
              <span className="font-semibold text-slate-900">Bước 1:</span> Tải{' '}
              <code className="font-mono text-slate-800">taxcap-suite-mv3.zip</code> và giải nén vào một thư mục cố định (không xóa sau khi cài).
            </li>
            <li>
              <span className="font-semibold text-slate-900">Bước 2:</span> Mở{' '}
              <code className="font-mono text-slate-800">chrome://extensions</code> (hoặc{' '}
              <code className="font-mono text-slate-800">edge://extensions</code>).
            </li>
            <li>
              <span className="font-semibold text-slate-900">Bước 3:</span> Bật{' '}
              <span className="font-semibold text-slate-800">Developer mode</span> ở góc trên bên phải.
            </li>
            <li>
              <span className="font-semibold text-slate-900">Bước 4:</span> Bấm{' '}
              <span className="font-semibold text-slate-800">Load unpacked</span> và chọn thư mục vừa giải nén.
            </li>
            <li>
              <span className="font-semibold text-slate-900">Bước 5:</span> Bấm biểu tượng{' '}
              <span className="font-semibold text-slate-800">TaxCap Suite</span> để mở thanh <span className="font-semibold text-slate-800">Side Panel</span> → nhập{' '}
              <span className="font-semibold text-slate-800">Mã kích hoạt</span> để mở khóa cả 3 tab{' '}
              <span className="font-semibold text-slate-800">Tải HĐĐT · Tải Hồ sơ · Captcha</span> (dán Gemini API Key trong tab <span className="font-semibold text-slate-800">Captcha → Cấu hình</span>).
            </li>
          </ol>
        </div>
      </div>

      {/* Live Source Code Inspector */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FileCode2 className="h-4 w-4 text-slate-500" />
              <span>Xem trước mã nguồn Extension</span>
            </div>
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="Lọc tệp theo phân hệ">
              {GROUP_TABS.map((tab) => {
                const active = groupFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setGroupFilter(tab.id)}
                    className={`whitespace-nowrap shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      active
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!activeFile}
            className="whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? 'Đã sao chép' : 'Sao chép tệp'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12">
          <div className="md:col-span-3 border-b md:border-b-0 md:border-r border-slate-200 bg-slate-50 p-2 space-y-0.5 max-h-[440px] overflow-y-auto">
            {visibleFiles.map((file) => {
              const active = file.path === activeFile?.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`w-full text-left rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors truncate ${
                    active
                      ? 'bg-white text-sky-700 font-semibold shadow-2xs border border-slate-200'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                  title={file.path}
                >
                  {file.path}
                </button>
              );
            })}
          </div>
          <div className="md:col-span-9 bg-slate-950 p-4 overflow-auto max-h-[440px]">
            <pre className="font-mono text-xs leading-relaxed text-slate-100">
              <code>{activeFile?.content || ''}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
