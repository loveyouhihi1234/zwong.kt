import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Upload, CheckCircle2, AlertTriangle, ShieldCheck, ArrowRight } from 'lucide-react';
import {
  MAX_AUTO_RETRIES,
  PORTAL_LIST,
  PORTALS,
  buildSampleCaptchaSvg,
  canAutoSolve,
  createInitialRetryState,
  nextRetryState,
  randomCaptchaCode,
  type PortalId,
  type RetryState,
  type SolveSpeedMode,
} from '../utils/captchaLogic';
import { rasterizeImageElement } from '../utils/imagePreprocess';

interface SandboxPanelProps {
  geminiConfigured: boolean;
  geminiKeyFormatValid?: boolean;
  onSolved?: () => void;
}

export const SandboxPanel: React.FC<SandboxPanelProps> = ({
  geminiConfigured,
  geminiKeyFormatValid = true,
  onSolved,
}) => {
  const [portal, setPortal] = useState<PortalId>('hddt');
  const [expectedCode, setExpectedCode] = useState<string>(() => randomCaptchaCode(6));
  const [customImageSrc, setCustomImageSrc] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState<string>('');
  const [retryState, setRetryState] = useState<RetryState>(() => createInitialRetryState(MAX_AUTO_RETRIES));
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [lastSourceTag, setLastSourceTag] = useState<string>('');
  const [submitFeedback, setSubmitFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [autoSolveOnChange, setAutoSolveOnChange] = useState<boolean>(false);
  const [localUxDemo, setLocalUxDemo] = useState<boolean>(false);
  const [speedMode, setSpeedMode] = useState<SolveSpeedMode>('fast');
  const [enhanceImage, setEnhanceImage] = useState<boolean>(true);
  const [enhancedPreviewSrc, setEnhancedPreviewSrc] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastSampleRef = useRef<{ sampleId: string; predicted: string } | null>(null);
  const retryStateRef = useRef<RetryState>(retryState);
  retryStateRef.current = retryState;

  const activeMeta = PORTALS[portal];
  const svgMarkup = buildSampleCaptchaSvg(expectedCode, portal);
  const generatedSrc = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgMarkup)))}`;
  const activeImageSrc = customImageSrc || generatedSrc;
  const imageKey = customImageSrc ? `custom:${customImageSrc.slice(0, 64)}:${customImageSrc.length}` : `${portal}:${expectedCode}`;

  const runSolve = useCallback(
    async (mode: 'auto' | 'manual') => {
      const img = imgRef.current;
      if (!img) return;

      const current = retryStateRef.current;
      if (mode === 'auto' && !canAutoSolve(current, imageKey)) {
        if (current.autoAttempts >= current.maxRetries && current.lastImageKey !== imageKey) {
          setRetryState(nextRetryState(current, { type: 'IMAGE_DETECTED', imageKey }));
        }
        return;
      }

      const nextReading = nextRetryState(
        current,
        mode === 'manual'
          ? { type: 'MANUAL_RETRY', imageKey }
          : { type: 'IMAGE_DETECTED', imageKey },
      );
      setRetryState(nextReading);
      setSubmitFeedback(null);

      if (localUxDemo && !customImageSrc) {
        await new Promise((r) => setTimeout(r, 320));
        setInputValue(expectedCode);
        setLastLatencyMs(320);
        setRetryState((prev) => nextRetryState(prev, { type: 'SOLVE_SUCCESS', code: expectedCode }));
        return;
      }

      try {
        const compactImage = await rasterizeImageElement(img, enhanceImage);
        if (!compactImage) {
          setRetryState((prev) => nextRetryState(prev, { type: 'SOLVE_FAILED' }));
          return;
        }
        if (enhanceImage) {
          setEnhancedPreviewSrc(compactImage);
        } else {
          setEnhancedPreviewSrc(null);
        }

        const svgDataUrl =
          portal === 'hddt' &&
          mode !== 'manual' &&
          activeImageSrc.startsWith('data:image/svg+xml;base64,')
            ? activeImageSrc
            : undefined;

        const res = await fetch('/api/captcha/solve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TaxCap-Sandbox': '1',
          },
          body: JSON.stringify({
            portal,
            image: compactImage,
            svgDataUrl,
            speedMode,
            enhanced: enhanceImage,
            bypassCache: mode === 'manual',
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.ok && data.captcha) {
          lastSampleRef.current = data.sampleId
            ? { sampleId: String(data.sampleId), predicted: String(data.captcha) }
            : null;
          setInputValue(data.captcha);
          setLastLatencyMs(typeof data.latencyMs === 'number' ? data.latencyMs : null);
          const tag =
            data.source === 'svg-local'
              ? 'SVG nội bộ'
              : data.source === 'memory'
                ? 'Trí nhớ AI'
                : data.source === 'onnx'
                  ? 'Model ONNX'
                  : data.fewShotCount > 0
                    ? `Kèm ${data.fewShotCount} ảnh mẫu`
                    : '';
          setLastSourceTag(tag);
          setRetryState((prev) => nextRetryState(prev, { type: 'SOLVE_SUCCESS', code: data.captcha }));
          onSolved?.();
        } else {
          setLastLatencyMs(null);
          setLastSourceTag('');
          setRetryState((prev) =>
            nextRetryState(prev, {
              type: 'SOLVE_FAILED',
              message: data.message || undefined,
            }),
          );
          onSolved?.();
        }
      } catch {
        setRetryState((prev) => nextRetryState(prev, { type: 'SOLVE_FAILED' }));
      }
    },
    [activeImageSrc, customImageSrc, enhanceImage, expectedCode, imageKey, localUxDemo, onSolved, portal, speedMode],
  );

  useEffect(() => {
    if (autoSolveOnChange) {
      const timer = setTimeout(() => {
        runSolve('auto');
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [autoSolveOnChange, imageKey, runSolve]);

  const handlePortalSelect = (nextPortal: PortalId) => {
    setPortal(nextPortal);
    setCustomImageSrc(null);
    setEnhancedPreviewSrc(null);
    setExpectedCode(randomCaptchaCode(6));
    setInputValue('');
    setLastLatencyMs(null);
    setLastSourceTag('');
    setSubmitFeedback(null);
    setRetryState(createInitialRetryState(MAX_AUTO_RETRIES));
  };

  const handleSimulatePortalRefresh = () => {
    setCustomImageSrc(null);
    setEnhancedPreviewSrc(null);
    setExpectedCode(randomCaptchaCode(6));
    setInputValue('');
    setLastSourceTag('');
    setSubmitFeedback({
      kind: 'err',
      text: 'Cổng giả lập báo sai mã và vừa đổi ảnh captcha mới.',
    });
    if (!autoSolveOnChange) {
      setAutoSolveOnChange(true);
    }
  };

  const handleNewSample = () => {
    setCustomImageSrc(null);
    setEnhancedPreviewSrc(null);
    setExpectedCode(randomCaptchaCode(6));
    setInputValue('');
    setLastLatencyMs(null);
    setLastSourceTag('');
    setSubmitFeedback(null);
    setRetryState(createInitialRetryState(MAX_AUTO_RETRIES));
  };

  const handleUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCustomImageSrc(reader.result);
        setInputValue('');
        setSubmitFeedback(null);
        setRetryState(createInitialRetryState(MAX_AUTO_RETRIES));
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const sendSandboxFeedback = (finalCode: string) => {
    const sample = lastSampleRef.current;
    if (!sample) return;
    lastSampleRef.current = null;
    const outcome = finalCode === sample.predicted ? 'verified' : 'corrected';
    fetch('/api/dataset/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TaxCap-Sandbox': '1',
      },
      body: JSON.stringify({
        sampleId: sample.sampleId,
        outcome,
        finalLabel: finalCode,
      }),
    })
      .then(() => onSolved?.())
      .catch(() => {});
  };

  const handleVerifyForm = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = inputValue.trim();
    if (!cleaned) {
      setSubmitFeedback({ kind: 'err', text: 'Ô captcha đang trống.' });
      return;
    }
    if (customImageSrc) {
      sendSandboxFeedback(cleaned);
      setSubmitFeedback({
        kind: 'ok',
        text: `Đã xác nhận & lưu mẫu "${cleaned}" vào Kho Dữ liệu.`,
      });
      return;
    }
    const matched = cleaned.toUpperCase() === expectedCode.toUpperCase();
    if (matched) {
      sendSandboxFeedback(cleaned);
      setSubmitFeedback({
        kind: 'ok',
        text: `Khớp chính xác mã "${expectedCode}" — đã lưu vào Kho Dữ liệu.`,
      });
      setRetryState((prev) => nextRetryState(prev, { type: 'RESET' }));
    } else {
      setSubmitFeedback({
        kind: 'err',
        text: `Mã "${cleaned}" chưa khớp "${expectedCode}". Bạn có thể sửa tay hoặc bấm Giải lại.`,
      });
    }
  };

  const statusTone =
    retryState.status === 'reading'
      ? 'text-sky-700'
      : retryState.status === 'filled'
        ? 'text-emerald-700 font-medium'
        : retryState.status === 'failed'
          ? 'text-amber-700 font-medium'
          : retryState.status === 'locked'
            ? 'text-red-700 font-medium'
            : 'text-slate-500';

  return (
    <div className="space-y-6">
      {/* Portal Switcher Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div
          role="tablist"
          aria-label="Chọn cổng mô phỏng"
          className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1"
        >
          {PORTAL_LIST.map((item) => {
            const active = item.id === portal;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handlePortalSelect(item.id)}
                className={`whitespace-nowrap shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {item.shortName}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="speed-mode-select" className="text-xs font-medium text-slate-600 whitespace-nowrap">
              Chế độ:
            </label>
            <select
              id="speed-mode-select"
              data-testid="speed-mode-select"
              value={speedMode}
              onChange={(e) => setSpeedMode(e.target.value === 'accurate' ? 'accurate' : 'fast')}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 focus:border-sky-600 focus:outline-none"
            >
              <option value="fast">Nhanh (Flash Lite)</option>
              <option value="accurate">Chuẩn (Flash 4)</option>
            </select>
          </div>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="enhance-image-toggle"
              checked={enhanceImage}
              onChange={(e) => {
                setEnhanceImage(e.target.checked);
                if (!e.target.checked) setEnhancedPreviewSrc(null);
              }}
              className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
            />
            <span>Làm nét ảnh (Bước 2)</span>
          </label>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="local-ux-demo-toggle"
              checked={localUxDemo}
              onChange={(e) => setLocalUxDemo(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
            />
            <span>Thử UX nội bộ (không gọi API)</span>
          </label>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="auto-solve-toggle"
              checked={autoSolveOnChange}
              onChange={(e) => setAutoSolveOnChange(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
            />
            <span>Tự động đọc khi ảnh đổi (giới hạn 3/3)</span>
          </label>
        </div>
      </div>

      {(!geminiConfigured || !geminiKeyFormatValid) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 space-y-1">
          <div className="font-semibold">
            {!geminiConfigured
              ? 'Máy chủ chưa có GEMINI_API_KEY.'
              : 'GEMINI_API_KEY hiện không đúng định dạng key Google AI Studio (AIza...).'}
          </div>
          <div>
            Vào mục <span className="font-semibold">Settings &gt; Secrets</span> của AI Studio, kiểm tra hoặc dán lại API key lấy từ{' '}
            <code className="font-mono">aistudio.google.com</code> (không để khoảng trắng/dấu ngoặc kép, không giới hạn HTTP Referrer). Trong lúc chờ gắn key, bạn có thể bật <span className="font-semibold">Thử UX nội bộ (không gọi API)</span> ở góc trên bên phải.
          </div>
        </div>
      )}

      {/* Main 2-column Interactive Sandbox */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Simulated Portal Form */}
        <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{activeMeta.name}</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {activeMeta.host} · {activeMeta.pathHint}
              </p>
            </div>
            <button
              type="button"
              onClick={handleNewSample}
              className="whitespace-nowrap shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Tạo ảnh mẫu khác
            </button>
          </div>

          <form onSubmit={handleVerifyForm} className="mt-5 space-y-4">
            <div>
              <label htmlFor="demo-mst" className="block text-xs font-medium text-slate-700">
                Mã số thuế (mô phỏng)
              </label>
              <input
                id="demo-mst"
                type="text"
                defaultValue="0101234567"
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 focus:border-sky-600 focus:bg-white focus:outline-none"
              />
            </div>

            {/* Captcha Image + Input Row */}
            <div>
              <label htmlFor="captcha-sandbox-input" className="block text-xs font-medium text-slate-700">
                Mã xác nhận (Captcha)
              </label>

              <div className="mt-1.5 flex flex-wrap items-start gap-3">
                <div className="flex flex-col items-center gap-0.5">
                  <div className="flex h-12 w-40 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-1">
                    <img
                      ref={imgRef}
                      src={activeImageSrc}
                      alt="Ảnh captcha mô phỏng"
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                  {enhancedPreviewSrc && (
                    <span className="text-[10px] text-slate-400">Ảnh gốc</span>
                  )}
                </div>
                {enhancedPreviewSrc && (
                  <div className="flex flex-col items-center gap-0.5">
                    <div className="flex h-12 w-36 items-center justify-center overflow-hidden rounded-lg border border-sky-200 bg-white p-1">
                      <img
                        src={enhancedPreviewSrc}
                        alt="Ảnh sau làm nét"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="text-[10px] text-sky-700 font-medium">Đã làm nét</span>
                  </div>
                )}

                {/* Input with embedded mini retry button at right corner */}
                <div className="relative flex-1 min-w-[200px]">
                  <input
                    id="captcha-sandbox-input"
                    data-testid="captcha-sandbox-input"
                    type="text"
                    value={inputValue}
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      setSubmitFeedback(null);
                      setRetryState((prev) => nextRetryState(prev, { type: 'MANUAL_INPUT' }));
                    }}
                    placeholder="Nhập hoặc để tự điền..."
                    className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-3 pr-10 font-mono text-sm tracking-wider text-slate-900 placeholder:font-sans placeholder:tracking-normal placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/15"
                  />
                  <button
                    type="button"
                    data-testid="mini-retry-btn"
                    onClick={() => runSolve('manual')}
                    disabled={retryState.status === 'reading'}
                    title="Giải lại ảnh captcha này"
                    aria-label="Giải lại mã captcha"
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${retryState.status === 'reading' ? 'animate-spin text-sky-600' : ''}`}
                    />
                  </button>
                </div>
              </div>

              {/* Inline Status Line right below captcha input */}
              <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                <span data-testid="captcha-status" className={statusTone}>
                  {retryState.message || 'Sẵn sàng — bấm "Đọc Captcha bằng Gemini" hoặc nút xoay tròn'}
                </span>
                <span className="font-mono tabular-nums text-slate-500 whitespace-nowrap shrink-0">
                  Lần thử: {retryState.autoAttempts}/{retryState.maxRetries}
                  {lastLatencyMs !== null ? ` · ${lastLatencyMs} ms` : ''}
                  {lastSourceTag ? ` · ${lastSourceTag}` : ''}
                </span>
              </div>
            </div>

            {/* Action Buttons: Explicit "Fill-Only, Manual Submit" separation */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                data-testid="solve-now-btn"
                onClick={() => runSolve('auto')}
                disabled={retryState.status === 'reading' || retryState.status === 'locked'}
                className="whitespace-nowrap shrink-0 rounded-lg bg-sky-700 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Đọc Captcha bằng Gemini
              </button>

              <button
                type="button"
                data-testid="simulate-wrong-btn"
                onClick={handleSimulatePortalRefresh}
                className="whitespace-nowrap shrink-0 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Giả lập sai mã (đổi ảnh)
              </button>

              <button
                type="submit"
                data-testid="verify-submit-btn"
                className="whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 ml-auto"
              >
                <span>Xác nhận (Enter)</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {submitFeedback && (
              <div
                data-testid="submit-feedback"
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  submitFeedback.kind === 'ok'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-amber-200 bg-amber-50 text-amber-900'
                }`}
              >
                {submitFeedback.kind === 'ok' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
                )}
                <span>{submitFeedback.text}</span>
              </div>
            )}
          </form>
        </div>

        {/* Right: Real Image Upload & Safety Spec */}
        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-slate-900">Thử với ảnh Captcha thật</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Tải lên ảnh chụp captcha PNG, JPG hoặc SVG từ trang Thuế để kiểm tra trực tiếp khả năng đọc của Gemini Flash.
            </p>
            <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-700 hover:border-sky-600 hover:bg-sky-50/40">
              <Upload className="h-4 w-4 text-slate-500" />
              <span>Chọn tệp ảnh (.png, .jpg, .svg)</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={handleUploadFile}
                className="sr-only"
              />
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldCheck className="h-4 w-4 text-sky-700" />
              <span>3 Cơ chế bảo vệ được tích hợp</span>
            </div>
            <ul className="space-y-2 text-xs leading-relaxed text-slate-600">
              <li>
                <span className="font-semibold text-slate-800">1. Dòng trạng thái trực tiếp:</span> Báo rõ{' '}
                <span className="font-mono text-slate-800">"Đang đọc..."</span>,{' '}
                <span className="font-mono text-slate-800">"Đã điền (kiểm tra lại)"</span> hoặc{' '}
                <span className="font-mono text-slate-800">"Không đọc được, bấm thử lại"</span> ngay dưới ô nhập.
              </li>
              <li>
                <span className="font-semibold text-slate-800">2. Giới hạn tự thử lại 3/3:</span> Chặn vòng lặp vô hạn khi cổng thuế đổi ảnh liên tục, tránh khóa tài khoản. Bấm nút xoay tròn góc ô nhập để ép đọc lại bất kỳ lúc nào.
              </li>
              <li>
                <span className="font-semibold text-slate-800">3. Chỉ điền, không tự gửi:</span> Kích hoạt đúng sự kiện React/jQuery để web nhận giá trị, giữ quyền bấm Enter thuộc về người dùng.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
