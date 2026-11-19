import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';

const EXTENSION_DIR = path.resolve(process.cwd(), 'extension');

// Pure Node CRC32 for generating valid PNG icons without native canvas dependencies
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Generates a crisp square TaxCap PNG icon (deep blue badge with clean white geometric glyph).
 */
export function generatePngIcon(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cornerR = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // PNG filter type 0
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      // Rounded rectangle mask
      const dx = Math.max(0, cornerR - Math.min(x, size - 1 - x));
      const dy = Math.max(0, cornerR - Math.min(y, size - 1 - y));
      const inRoundedRect = dx * dx + dy * dy <= cornerR * cornerR;

      if (!inRoundedRect) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Draw a crisp white "T" + shield checkmark motif in the center
      const nx = x / size;
      const ny = y / size;
      const isTopBar = ny >= 0.24 && ny <= 0.36 && nx >= 0.24 && nx <= 0.76;
      const isStem = nx >= 0.44 && nx <= 0.56 && ny >= 0.24 && ny <= 0.76;
      const isWhite = isTopBar || isStem;

      if (isWhite) {
        raw[px] = 255;
        raw[px + 1] = 255;
        raw[px + 2] = 255;
        raw[px + 3] = 255;
      } else {
        // #0B6BCB with subtle vertical depth
        const t = y / size;
        raw[px] = Math.round(11 + t * 4);
        raw[px + 1] = Math.round(107 - t * 14);
        raw[px + 2] = Math.round(203 - t * 20);
        raw[px + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface ExtensionFilePreview {
  path: string;
  content: string;
}

function normalizeOriginPattern(apiBaseUrl: string): string | null {
  try {
    const u = new URL(apiBaseUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

export async function buildExtensionArtifacts(options: {
  connectionMode?: 'direct' | 'proxy';
  apiBaseUrl?: string;
  accessToken?: string;
  licenseApiUrl?: string;
}): Promise<{ zipBuffer: Buffer; files: ExtensionFilePreview[] }> {
  const connectionMode = options.connectionMode === 'proxy' ? 'proxy' : 'direct';
  const cleanUrl =
    connectionMode === 'proxy'
      ? (options.apiBaseUrl || '').trim().replace(/\/+$/, '') || 'http://localhost:3000'
      : '';
  const cleanToken = connectionMode === 'proxy' ? (options.accessToken || '').trim() : '';
  const cleanLicenseUrl = (options.licenseApiUrl || '').trim().replace(/\/+$/, '');

  const manifestRaw = await fs.readFile(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8');
  const manifestObj = JSON.parse(manifestRaw);
  if (connectionMode === 'proxy') {
    const proxyPattern = normalizeOriginPattern(cleanUrl);
    if (proxyPattern && Array.isArray(manifestObj.host_permissions)) {
      if (!manifestObj.host_permissions.includes(proxyPattern)) {
        manifestObj.host_permissions.push(proxyPattern);
      }
    }
  }
  const manifestContent = JSON.stringify(manifestObj, null, 2);

  const configContent = `// Cấu hình tạo tự động từ TaxCap Studio
self.TAXCAP_DEFAULTS = ${JSON.stringify(
    {
      connectionMode,
      geminiApiKey: '',
      licenseApiUrl: cleanLicenseUrl,
      apiBaseUrl: cleanUrl,
      accessToken: cleanToken,
      speedMode: 'fast',
      enhanceImage: true,
      enabled: true,
      pausedUntil: 0,
      portals: {
        hddt: true,
        tdt: true,
        dvc: true,
        tracuunnt: true,
      },
    },
    null,
    2,
  )};
`;

  const relativeTextFiles = [
    'direct-gemini.js',
    'license.js',
    'background.js',
    'popup.html',
    'popup.js',
    'content/captcha-svg-templates.js',
    'content/captcha-svg.js',
    'content/common.js',
    'content/hddt.js',
    'content/tdt.js',
    'content/dvc.js',
    'content/tracuunnt.js',
  ];

  const zip = new JSZip();
  const previews: ExtensionFilePreview[] = [
    { path: 'manifest.json', content: manifestContent },
    { path: 'config.js', content: configContent },
  ];

  zip.file('manifest.json', manifestContent);
  zip.file('config.js', configContent);

  for (const rel of relativeTextFiles) {
    const content = await fs.readFile(path.join(EXTENSION_DIR, rel), 'utf8');
    zip.file(rel, content);
    previews.push({ path: rel, content });
  }

  zip.file('icons/icon-48.png', generatePngIcon(48));
  zip.file('icons/icon-128.png', generatePngIcon(128));

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { zipBuffer, files: previews };
}
