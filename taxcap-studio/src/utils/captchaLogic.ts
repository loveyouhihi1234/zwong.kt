export type PortalId = 'hddt' | 'tdt' | 'dvc' | 'tracuunnt';

export interface PortalMeta {
  id: PortalId;
  name: string;
  shortName: string;
  host: string;
  pathHint: string;
  imageMode: 'svg-raster' | 'canvas-png';
  imgSelector: string;
  inputSelector: string;
  notes: string;
}

export const PORTALS: Record<PortalId, PortalMeta> = {
  hddt: {
    id: 'hddt',
    name: 'Hóa đơn điện tử (Tổng cục Thuế)',
    shortName: 'HĐĐT',
    host: 'hoadondientu.gdt.gov.vn',
    pathHint: 'Đăng nhập & Tra cứu hóa đơn (Next.js + Ant Design)',
    imageMode: 'svg-raster',
    imgSelector: 'img[alt="captcha"]',
    inputSelector: 'input[id="cvalue"], input[id$="_cvalue"]',
    notes: 'Tầng 0: so khớp mẫu SVG trong trình duyệt (<5ms, không cần API); nếu độ tin cậy <80% hoặc đổi sang ảnh PNG sẽ tự fallback sang Trí nhớ / ONNX / Gemini.',
  },
  tdt: {
    id: 'tdt',
    name: 'Thuế điện tử (eTax NNT)',
    shortName: 'Thuế ĐT',
    host: 'thuedientu.gdt.gov.vn',
    pathHint: '/etaxnnt — Form đăng nhập #loginForm',
    imageMode: 'canvas-png',
    imgSelector: 'img#safecode',
    inputSelector: 'input#vcode[name="_verifyCode"]',
    notes: 'Đọc pixel trực tiếp từ DOM qua canvas.drawImage ngay từ document_end để không gọi lại servlet làm đổi mã phiên.',
  },
  dvc: {
    id: 'dvc',
    name: 'Dịch vụ công Thuế (TTHC)',
    shortName: 'DVC Thuế',
    host: 'dichvucong.gdt.gov.vn',
    pathHint: '/tthc & /tthc/tchs — Đăng nhập NNT/CBT & Tra cứu hồ sơ',
    imageMode: 'canvas-png',
    imgSelector: 'img[id^="image-capt"]',
    inputSelector: 'input[name="captcha"], input[name="captchaCbt"]',
    notes: 'Chỉ giải cặp img + input đang hiển thị (checkVisibility) trong cùng form hoặc modal đang mở.',
  },
  tracuunnt: {
    id: 'tracuunnt',
    name: 'Tra cứu Người nộp thuế',
    shortName: 'Tra cứu NNT',
    host: 'tracuunnt.gdt.gov.vn',
    pathHint: '/tcnnt/mstdn.jsp & /tcnnt/mstcn.jsp',
    imageMode: 'canvas-png',
    imgSelector: 'img[src^="/tcnnt/captcha.png"]',
    inputSelector: 'input[name="captcha"]',
    notes: 'Ghép cặp theo từng form tra cứu doanh nghiệp hoặc cá nhân đang hiển thị.',
  },
};

export const PORTAL_LIST: PortalMeta[] = Object.values(PORTALS);

export type SolveSpeedMode = 'fast' | 'accurate';

export const SOLVE_MODELS: Record<SolveSpeedMode, string> = {
  fast: 'gemini-3.1-flash-lite',
  accurate: 'gemini-4-hydrogen',
};

export function resolveSolveMode(value: unknown): SolveSpeedMode {
  return value === 'accurate' ? 'accurate' : 'fast';
}

export function getModelForSpeedMode(mode: SolveSpeedMode): string {
  return SOLVE_MODELS[mode];
}

export function isValidPortal(value: string): value is PortalId {
  return value === 'hddt' || value === 'tdt' || value === 'dvc' || value === 'tracuunnt';
}

export function sanitizeCaptchaText(raw: string): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/[`'"\s\r\n\t]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length < 2 || cleaned.length > 12) {
    return cleaned.slice(0, 12);
  }
  return cleaned;
}

const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

export function parseCaptchaImageInput(
  input: string,
): { mimeType: string; data: string } | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const dataUriMatch = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(trimmed);
  if (dataUriMatch) {
    const mime = dataUriMatch[1].toLowerCase();
    const data = dataUriMatch[2];
    if (!ALLOWED_IMAGE_MIME.has(mime) || data.length < 32) return null;
    return { mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime, data };
  }

  // Allow raw base64 PNG/JPEG payloads
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 64) {
    return { mimeType: 'image/png', data: trimmed };
  }

  return null;
}

export const MAX_AUTO_RETRIES = 3;

export type CaptchaUiStatus = 'idle' | 'reading' | 'filled' | 'failed' | 'locked';

export interface RetryState {
  status: CaptchaUiStatus;
  autoAttempts: number;
  maxRetries: number;
  lastImageKey: string | null;
  lastCode: string;
  message: string;
}

export type RetryEvent =
  | { type: 'IMAGE_DETECTED'; imageKey: string }
  | { type: 'SOLVE_SUCCESS'; code: string }
  | { type: 'SOLVE_FAILED'; message?: string }
  | { type: 'MANUAL_RETRY'; imageKey: string }
  | { type: 'MANUAL_INPUT' }
  | { type: 'RESET' };

export function createInitialRetryState(maxRetries = MAX_AUTO_RETRIES): RetryState {
  return {
    status: 'idle',
    autoAttempts: 0,
    maxRetries,
    lastImageKey: null,
    lastCode: '',
    message: '',
  };
}

export function statusMessageFor(status: CaptchaUiStatus, autoAttempts: number, maxRetries: number): string {
  switch (status) {
    case 'reading':
      return 'Đang đọc...';
    case 'filled':
      return 'Đã điền (kiểm tra lại)';
    case 'failed':
      return 'Không đọc được, bấm thử lại';
    case 'locked':
      return `Đã tự thử lại ${autoAttempts}/${maxRetries} lần — tự nhập hoặc bấm Giải lại`;
    default:
      return '';
  }
}

export function canAutoSolve(state: RetryState, imageKey: string): boolean {
  if (!imageKey) return false;
  if (state.status === 'locked') return false;
  if (state.lastImageKey === imageKey && state.status !== 'idle') return false;
  return state.autoAttempts < state.maxRetries;
}

export function nextRetryState(state: RetryState, event: RetryEvent): RetryState {
  switch (event.type) {
    case 'RESET':
      return createInitialRetryState(state.maxRetries);

    case 'MANUAL_INPUT':
      return {
        ...state,
        autoAttempts: 0,
        status: 'idle',
        message: '',
      };

    case 'IMAGE_DETECTED': {
      if (!canAutoSolve(state, event.imageKey)) {
        if (state.autoAttempts >= state.maxRetries && state.lastImageKey !== event.imageKey) {
          return {
            ...state,
            status: 'locked',
            lastImageKey: event.imageKey,
            message: statusMessageFor('locked', state.autoAttempts, state.maxRetries),
          };
        }
        return state;
      }
      const nextAttempts = state.autoAttempts + 1;
      return {
        ...state,
        status: 'reading',
        autoAttempts: nextAttempts,
        lastImageKey: event.imageKey,
        message: statusMessageFor('reading', nextAttempts, state.maxRetries),
      };
    }

    case 'MANUAL_RETRY':
      return {
        ...state,
        status: 'reading',
        autoAttempts: 1,
        lastImageKey: event.imageKey,
        message: statusMessageFor('reading', 1, state.maxRetries),
      };

    case 'SOLVE_SUCCESS':
      return {
        ...state,
        status: 'filled',
        lastCode: event.code,
        message: statusMessageFor('filled', state.autoAttempts, state.maxRetries),
      };

    case 'SOLVE_FAILED': {
      const hitLimit = state.autoAttempts >= state.maxRetries;
      const nextStatus: CaptchaUiStatus = hitLimit ? 'locked' : 'failed';
      return {
        ...state,
        status: nextStatus,
        message: event.message || statusMessageFor(nextStatus, state.autoAttempts, state.maxRetries),
      };
    }
  }
}

const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCaptchaCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  }
  return out;
}

/**
 * Generates a realistic captcha SVG mimicking Vietnamese tax/public-service portals
 * for live testing inside the Sandbox.
 */
export function buildSampleCaptchaSvg(code: string, portal: PortalId): string {
  const width = 156;
  const height = 48;
  const bg = portal === 'hddt' ? '#f8fafc' : portal === 'tdt' ? '#eef2ff' : portal === 'dvc' ? '#f1f5f9' : '#fefce8';
  const palette =
    portal === 'hddt'
      ? ['#0f172a', '#1e3a8a', '#0b6bcb', '#334155']
      : portal === 'tdt'
        ? ['#1e1b4b', '#4338ca', '#0f766e', '#1d4ed8']
        : portal === 'dvc'
          ? ['#064e3b', '#0f766e', '#1e293b', '#0369a1']
          : ['#7c2d12', '#9a3412', '#1e293b', '#b45309'];

  // Deterministic pseudo-random based on code so renders stay stable for a given code
  let seed = 0;
  for (let i = 0; i < code.length; i++) seed = (seed * 31 + code.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    const x1 = Math.round(rand() * width);
    const y1 = Math.round(rand() * height);
    const x2 = Math.round(rand() * width);
    const y2 = Math.round(rand() * height);
    const color = palette[i % palette.length];
    lines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-opacity="0.28" stroke-width="1.3"/>`,
    );
  }

  const dots: string[] = [];
  for (let i = 0; i < 18; i++) {
    const cx = Math.round(rand() * width);
    const cy = Math.round(rand() * height);
    dots.push(`<circle cx="${cx}" cy="${cy}" r="1" fill="#64748b" fill-opacity="0.35"/>`);
  }

  const chars = code.split('').map((ch, idx) => {
    const x = 16 + idx * 22 + Math.round((rand() - 0.5) * 4);
    const y = 32 + Math.round((rand() - 0.5) * 6);
    const rot = Math.round((rand() - 0.5) * 24);
    const color = palette[idx % palette.length];
    const size = 23 + Math.round(rand() * 4);
    return `<text x="${x}" y="${y}" fill="${color}" font-family="'Courier New', monospace" font-weight="700" font-size="${size}" transform="rotate(${rot} ${x} ${y})">${ch}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="${bg}"/>
    ${lines.join('')}
    ${dots.join('')}
    ${chars.join('')}
  </svg>`;
}
