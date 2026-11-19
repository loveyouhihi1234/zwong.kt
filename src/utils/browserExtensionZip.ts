import JSZip from 'jszip';

// Lõi & Side Panel hợp nhất
import manifestRaw from '../../extension/manifest.json?raw';
import directGeminiJs from '../../extension/direct-gemini.js?raw';
import licenseJs from '../../extension/license.js?raw';
import backgroundJs from '../../extension/background.js?raw';
import sidepanelHtml from '../../extension/sidepanel.html?raw';
import sidepanelJs from '../../extension/sidepanel.js?raw';
import hddtLogoSvg from '../../extension/icons/hddt-logo.svg?raw';
import hosoLogoSvg from '../../extension/icons/hoso-logo.svg?raw';

// Tab 1: Tải Hóa đơn điện tử (HĐĐT)
import hddtPanelHtml from '../../extension/panels/hddt/index.html?raw';
import hddtPanelCss from '../../extension/panels/hddt/panel-hddt.css?raw';
import hddtPanelJs from '../../extension/panels/hddt/panel-hddt.js?raw';
import hddtDatepickerJs from '../../extension/panels/hddt/datepicker-hddt.js?raw';
import hddtZipJs from '../../extension/content/hddt/zip.js?raw';
import hddtXlsxJs from '../../extension/content/hddt/xlsx.js?raw';
import hddtApiJs from '../../extension/content/hddt/hddt-api.js?raw';
import hddtReportJs from '../../extension/content/hddt/report.js?raw';
import hddtPdfJs from '../../extension/content/hddt/pdf.js?raw';
import hddtContentJs from '../../extension/content/hddt/hddt-content.js?raw';

// Tab 2: Tải Hồ sơ thuế (DVC & Thuế ĐT)
import hosoPanelHtml from '../../extension/panels/hoso/index.html?raw';
import hosoPanelCss from '../../extension/panels/hoso/panel-hoso.css?raw';
import hosoPanelJs from '../../extension/panels/hoso/panel-hoso.js?raw';
import hosoDatepickerJs from '../../extension/panels/hoso/datepicker-hoso.js?raw';
import hosoComboboxJs from '../../extension/panels/hoso/combobox-hoso.js?raw';
import hosoGdtApiJs from '../../extension/content/hoso/gdt-api.js?raw';
import hosoContentJs from '../../extension/content/hoso/hoso-content.js?raw';

// Tab 3: Giải Captcha (4 cổng + SVG dùng chung)
import captchaPanelHtml from '../../extension/panels/captcha/index.html?raw';
import captchaPanelJs from '../../extension/panels/captcha/panel-captcha.js?raw';
import svgTemplatesJs from '../../extension/content/captcha-svg-templates.js?raw';
import svgSolverJs from '../../extension/content/captcha-svg.js?raw';
import commonJs from '../../extension/content/common.js?raw';
import hddtCaptchaJs from '../../extension/content/hddt.js?raw';
import tdtCaptchaJs from '../../extension/content/tdt.js?raw';
import dvcCaptchaJs from '../../extension/content/dvc.js?raw';
import tracuunntCaptchaJs from '../../extension/content/tracuunnt.js?raw';

// Font license text & binary asset URLs
import pdfFontLicense from '../../extension/content/fonts/LICENSE?raw';
import uiFontLicense from '../../extension/panels/shared/fonts/LICENSE?raw';
import pdfRegularUrl from '../../extension/content/fonts/pdf-regular.ttf?url';
import pdfBoldUrl from '../../extension/content/fonts/pdf-bold.ttf?url';
import pdfItalicUrl from '../../extension/content/fonts/pdf-italic.ttf?url';
import robotoLatinUrl from '../../extension/panels/shared/fonts/roboto-latin-wght-normal.woff2?url';
import robotoViUrl from '../../extension/panels/shared/fonts/roboto-vietnamese-wght-normal.woff2?url';

import { generatePngIconBytes } from './pngIcon';

export type ExtensionFileGroup = 'core' | 'hddt' | 'hoso' | 'captcha';

export interface BrowserExtensionFile {
  path: string;
  content: string;
  group: ExtensionFileGroup;
}

const BINARY_ASSETS: ReadonlyArray<{ path: string; url: string }> = [
  { path: 'content/fonts/pdf-regular.ttf', url: pdfRegularUrl },
  { path: 'content/fonts/pdf-bold.ttf', url: pdfBoldUrl },
  { path: 'content/fonts/pdf-italic.ttf', url: pdfItalicUrl },
  { path: 'panels/shared/fonts/roboto-latin-wght-normal.woff2', url: robotoLatinUrl },
  { path: 'panels/shared/fonts/roboto-vietnamese-wght-normal.woff2', url: robotoViUrl },
];

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
    // Lõi & Side Panel
    { path: 'manifest.json', content: manifestContent, group: 'core' },
    { path: 'config.js', content: configContent, group: 'core' },
    { path: 'sidepanel.html', content: sidepanelHtml, group: 'core' },
    { path: 'sidepanel.js', content: sidepanelJs, group: 'core' },
    { path: 'background.js', content: backgroundJs, group: 'core' },
    { path: 'license.js', content: licenseJs, group: 'core' },
    { path: 'direct-gemini.js', content: directGeminiJs, group: 'core' },
    { path: 'icons/hddt-logo.svg', content: hddtLogoSvg, group: 'core' },
    { path: 'icons/hoso-logo.svg', content: hosoLogoSvg, group: 'core' },
    { path: 'content/fonts/LICENSE', content: pdfFontLicense, group: 'core' },
    { path: 'panels/shared/fonts/LICENSE', content: uiFontLicense, group: 'core' },

    // Tab 1: Tải HĐĐT
    { path: 'panels/hddt/index.html', content: hddtPanelHtml, group: 'hddt' },
    { path: 'panels/hddt/panel-hddt.css', content: hddtPanelCss, group: 'hddt' },
    { path: 'panels/hddt/panel-hddt.js', content: hddtPanelJs, group: 'hddt' },
    { path: 'panels/hddt/datepicker-hddt.js', content: hddtDatepickerJs, group: 'hddt' },
    { path: 'content/hddt/hddt-content.js', content: hddtContentJs, group: 'hddt' },
    { path: 'content/hddt/hddt-api.js', content: hddtApiJs, group: 'hddt' },
    { path: 'content/hddt/report.js', content: hddtReportJs, group: 'hddt' },
    { path: 'content/hddt/pdf.js', content: hddtPdfJs, group: 'hddt' },
    { path: 'content/hddt/xlsx.js', content: hddtXlsxJs, group: 'hddt' },
    { path: 'content/hddt/zip.js', content: hddtZipJs, group: 'hddt' },

    // Tab 2: Tải Hồ sơ thuế
    { path: 'panels/hoso/index.html', content: hosoPanelHtml, group: 'hoso' },
    { path: 'panels/hoso/panel-hoso.css', content: hosoPanelCss, group: 'hoso' },
    { path: 'panels/hoso/panel-hoso.js', content: hosoPanelJs, group: 'hoso' },
    { path: 'panels/hoso/datepicker-hoso.js', content: hosoDatepickerJs, group: 'hoso' },
    { path: 'panels/hoso/combobox-hoso.js', content: hosoComboboxJs, group: 'hoso' },
    { path: 'content/hoso/hoso-content.js', content: hosoContentJs, group: 'hoso' },
    { path: 'content/hoso/gdt-api.js', content: hosoGdtApiJs, group: 'hoso' },

    // Tab 3: Giải Captcha
    { path: 'panels/captcha/index.html', content: captchaPanelHtml, group: 'captcha' },
    { path: 'panels/captcha/panel-captcha.js', content: captchaPanelJs, group: 'captcha' },
    { path: 'content/captcha-svg-templates.js', content: svgTemplatesJs, group: 'captcha' },
    { path: 'content/captcha-svg.js', content: svgSolverJs, group: 'captcha' },
    { path: 'content/common.js', content: commonJs, group: 'captcha' },
    { path: 'content/hddt.js', content: hddtCaptchaJs, group: 'captcha' },
    { path: 'content/tdt.js', content: tdtCaptchaJs, group: 'captcha' },
    { path: 'content/dvc.js', content: dvcCaptchaJs, group: 'captcha' },
    { path: 'content/tracuunnt.js', content: tracuunntCaptchaJs, group: 'captcha' },
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

  const binaryBuffers = await Promise.all(
    BINARY_ASSETS.map(async (asset) => {
      const res = await fetch(asset.url);
      if (!res.ok) throw new Error(`Không tải được tệp tài nguyên ${asset.path}`);
      return { path: asset.path, data: await res.arrayBuffer() };
    }),
  );
  for (const item of binaryBuffers) {
    zip.file(item.path, item.data);
  }

  zip.file('icons/icon-48.png', generatePngIconBytes(48));
  zip.file('icons/icon-128.png', generatePngIconBytes(128));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, files };
}
