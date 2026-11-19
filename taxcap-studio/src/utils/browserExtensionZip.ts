import JSZip from 'jszip';
import manifestRaw from '../../extension/manifest.json?raw';
import directGeminiJs from '../../extension/direct-gemini.js?raw';
import licenseJs from '../../extension/license.js?raw';
import backgroundJs from '../../extension/background.js?raw';
import popupHtml from '../../extension/popup.html?raw';
import popupJs from '../../extension/popup.js?raw';
import svgTemplatesJs from '../../extension/content/captcha-svg-templates.js?raw';
import svgSolverJs from '../../extension/content/captcha-svg.js?raw';
import commonJs from '../../extension/content/common.js?raw';
import hddtJs from '../../extension/content/hddt.js?raw';
import tdtJs from '../../extension/content/tdt.js?raw';
import dvcJs from '../../extension/content/dvc.js?raw';
import tracuunntJs from '../../extension/content/tracuunnt.js?raw';
import { generatePngIconBytes } from './pngIcon';

export interface BrowserExtensionFile {
  path: string;
  content: string;
}

function normalizeOriginPattern(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

export function buildBrowserExtensionFiles(options: {
  connectionMode?: 'direct' | 'proxy';
  apiBaseUrl?: string;
  accessToken?: string;
  licenseApiUrl?: string;
}): BrowserExtensionFile[] {
  const connectionMode = options.connectionMode === 'proxy' ? 'proxy' : 'direct';
  const cleanUrl =
    connectionMode === 'proxy'
      ? (options.apiBaseUrl || '').trim().replace(/\/+$/, '') || 'http://localhost:3000'
      : '';
  const cleanToken = connectionMode === 'proxy' ? (options.accessToken || '').trim() : '';
  const cleanLicenseUrl = (options.licenseApiUrl || '').trim().replace(/\/+$/, '');

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

  return [
    { path: 'manifest.json', content: manifestContent },
    { path: 'config.js', content: configContent },
    { path: 'direct-gemini.js', content: directGeminiJs },
    { path: 'license.js', content: licenseJs },
    { path: 'background.js', content: backgroundJs },
    { path: 'popup.html', content: popupHtml },
    { path: 'popup.js', content: popupJs },
    { path: 'content/captcha-svg-templates.js', content: svgTemplatesJs },
    { path: 'content/captcha-svg.js', content: svgSolverJs },
    { path: 'content/common.js', content: commonJs },
    { path: 'content/hddt.js', content: hddtJs },
    { path: 'content/tdt.js', content: tdtJs },
    { path: 'content/dvc.js', content: dvcJs },
    { path: 'content/tracuunnt.js', content: tracuunntJs },
  ];
}

export async function buildBrowserExtensionZipBlob(options: {
  connectionMode?: 'direct' | 'proxy';
  apiBaseUrl?: string;
  accessToken?: string;
  licenseApiUrl?: string;
}): Promise<{ blob: Blob; files: BrowserExtensionFile[] }> {
  const files = buildBrowserExtensionFiles(options);
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content);
  }
  zip.file('icons/icon-48.png', generatePngIconBytes(48));
  zip.file('icons/icon-128.png', generatePngIconBytes(128));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, files };
}
