import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import JSZip from 'jszip';
import {
  buildExtensionArtifacts,
  generatePngIcon,
  UNIFIED_EXTENSION_BINARY_FILES,
  UNIFIED_EXTENSION_TEXT_FILES,
} from './extensionBundle';

const ESM_MODULE_SCRIPTS = new Set([
  'panels/hddt/panel-hddt.js',
  'panels/hddt/datepicker-hddt.js',
  'panels/hoso/panel-hoso.js',
  'panels/hoso/datepicker-hoso.js',
  'panels/hoso/combobox-hoso.js',
]);

test('generatePngIcon returns valid PNG header', () => {
  const buf = generatePngIcon(48);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('buildExtensionArtifacts packages unified 3-tab Side Panel extension with HDDT, Hoso, Captcha, and binary fonts', async () => {
  const { zipBuffer, files } = await buildExtensionArtifacts({});

  const zip = await JSZip.loadAsync(zipBuffer);
  assert.ok(zip.file('manifest.json'));
  assert.ok(zip.file('config.js'));
  assert.ok(zip.file('icons/icon-48.png'));
  assert.ok(zip.file('icons/icon-128.png'));

  for (const rel of UNIFIED_EXTENSION_TEXT_FILES) {
    assert.ok(zip.file(rel), `Missing text file in zip: ${rel}`);
  }
  for (const rel of UNIFIED_EXTENSION_BINARY_FILES) {
    const entry = zip.file(rel);
    assert.ok(entry, `Missing binary asset in zip: ${rel}`);
    const bytes = await entry!.async('uint8array');
    assert.equal(bytes.length > 1000, true, `Binary asset looks empty: ${rel}`);
  }

  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel?.default_path, 'sidepanel.html');
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.permissions.includes('storage'), true);
  assert.equal(manifest.permissions.includes('alarms'), true);
  assert.equal(manifest.permissions.includes('sidePanel'), true);
  assert.equal(manifest.permissions.includes('downloads'), true);
  assert.equal(manifest.host_permissions.includes('https://generativelanguage.googleapis.com/*'), true);
  assert.equal(manifest.host_permissions.includes('https://script.google.com/*'), true);
  assert.equal(
    manifest.web_accessible_resources?.[0]?.resources?.includes('content/fonts/*.ttf'),
    true,
  );

  // Verify shared SVG captcha solver is injected ONCE on hoadondientu alongside HDDT downloader
  const hddtRule = manifest.content_scripts.find((s: { matches: string[] }) =>
    s.matches.includes('https://hoadondientu.gdt.gov.vn/*'),
  );
  assert.ok(hddtRule);
  assert.equal(
    hddtRule.js.filter((f: string) => f.includes('captcha-svg.js')).length,
    1,
  );
  assert.equal(hddtRule.js.includes('content/hddt/hddt-content.js'), true);
  assert.equal(hddtRule.js.includes('content/hddt.js'), true);

  // Verify Hoso downloader + DVC captcha run together on dichvucong
  const dvcRule = manifest.content_scripts.find((s: { matches: string[] }) =>
    s.matches.includes('https://dichvucong.gdt.gov.vn/*'),
  );
  assert.ok(dvcRule);
  assert.equal(dvcRule.js.includes('content/dvc.js'), true);
  assert.equal(dvcRule.js.includes('content/hoso/hoso-content.js'), true);

  // Verify exact top-level tab order in sidepanel.html: Tải HĐĐT -> Tải Hồ sơ -> Captcha
  const sidepanelHtml = await zip.file('sidepanel.html')!.async('string');
  const idxHddt = sidepanelHtml.indexOf('data-main-tab="hddt"');
  const idxHoso = sidepanelHtml.indexOf('data-main-tab="hoso"');
  const idxCaptcha = sidepanelHtml.indexOf('data-main-tab="captcha"');
  assert.equal(idxHddt > 0 && idxHoso > idxHddt && idxCaptcha > idxHoso, true);

  // Verify global license guard is wired in background.js for downloads and license checks
  const backgroundJs = await zip.file('background.js')!.async('string');
  assert.equal(backgroundJs.includes('TAXCAP_CHECK_LICENSE'), true);
  assert.equal(backgroundJs.includes('TAXCAP_DOWNLOAD_FILE'), true);
  assert.equal(backgroundJs.includes('openPanelOnActionClick: true'), true);

  const configJs = await zip.file('config.js')!.async('string');
  assert.equal(configJs.includes('"connectionMode": "direct"'), true);
  assert.equal(configJs.includes('"speedMode": "fast"'), true);
  assert.equal(configJs.includes('"licenseApiUrl":'), true);

  // Syntax-check every classic JS script bundled into the extension
  for (const file of files) {
    if (file.path.endsWith('.js') && !ESM_MODULE_SCRIPTS.has(file.path)) {
      assert.doesNotThrow(() => new vm.Script(file.content, { filename: file.path }));
    }
  }
});

test('buildExtensionArtifacts still supports optional proxy mode with host_permissions and accessToken', async () => {
  const { zipBuffer } = await buildExtensionArtifacts({
    connectionMode: 'proxy',
    apiBaseUrl: 'https://taxcap-proxy.example.com/',
    accessToken: 'team-secret-123',
  });

  const zip = await JSZip.loadAsync(zipBuffer);
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.host_permissions.includes('https://taxcap-proxy.example.com/*'), true);

  const configJs = await zip.file('config.js')!.async('string');
  assert.equal(configJs.includes('"connectionMode": "proxy"'), true);
  assert.equal(configJs.includes('https://taxcap-proxy.example.com'), true);
  assert.equal(configJs.includes('team-secret-123'), true);
});

test('all TAXCAP_* runtime messages sent by sidepanel, panels, and content scripts are handled by background.js', async () => {
  const { files } = await buildExtensionArtifacts({});
  const bg = files.find((f) => f.path === 'background.js')?.content || '';
  const sidepanel = files.find((f) => f.path === 'sidepanel.js')?.content || '';

  assert.equal(sidepanel.includes('TAXCAP_LICENSE_STATUS'), true);
  assert.equal(sidepanel.includes('TAXCAP_LICENSE_ACTIVATE'), true);
  assert.equal(sidepanel.includes('licRes?.license'), true);

  const sentTypes = new Set<string>();
  const typeRegex = /type\s*:\s*['"](TAXCAP_[A-Z0-9_]+)['"]/g;
  for (const file of files) {
    if (!file.path.endsWith('.js') || file.path === 'background.js') continue;
    let m: RegExpExecArray | null;
    while ((m = typeRegex.exec(file.content)) !== null) {
      sentTypes.add(m[1]);
    }
  }

  assert.ok(sentTypes.size >= 10, 'Expected at least 10 TAXCAP_* runtime message types');
  for (const msgType of sentTypes) {
    assert.equal(
      bg.includes(`"${msgType}"`) || bg.includes(`'${msgType}'`),
      true,
      `background.js is missing handler for message type: ${msgType}`,
    );
  }
});

test('v2.0.2 UI & reliability guarantees: no banners, HDDT log visible + instant abort, Hoso 4 presets, Captcha dedupe', async () => {
  const { zipBuffer, files } = await buildExtensionArtifacts({});
  const zip = await JSZip.loadAsync(zipBuffer);

  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.version, '2.0.2');

  const hddtHtml = await zip.file('panels/hddt/index.html')!.async('string');
  assert.equal(hddtHtml.includes('class="notice"'), false, 'HDDT yellow update notice must be removed');
  assert.equal(hddtHtml.includes('id="jobArea"'), true, 'HDDT Nhật ký section must exist');
  assert.equal(hddtHtml.includes('id="log"'), true, 'HDDT log list must exist');

  const hddtCss = await zip.file('panels/hddt/panel-hddt.css')!.async('string');
  assert.equal(hddtCss.includes('.job:has(#log:empty)'), false, 'HDDT Nhật ký must not hide when empty');

  const hddtApi = files.find((f) => f.path === 'content/hddt/hddt-api.js')?.content || '';
  const hddtContent = files.find((f) => f.path === 'content/hddt/hddt-content.js')?.content || '';
  const hddtPanelJs = files.find((f) => f.path === 'panels/hddt/panel-hddt.js')?.content || '';
  assert.equal(hddtApi.includes('abortActive'), true, 'HDDT API must expose abortActive()');
  assert.equal(hddtContent.includes("msg.type === 'hddt-stop'"), true, 'HDDT port must handle hddt-stop');
  assert.equal(hddtPanelJs.includes('Đang dừng…'), true, 'HDDT Stop button must show immediate Đang dừng… feedback');

  const hosoHtml = await zip.file('panels/hoso/index.html')!.async('string');
  assert.equal(hosoHtml.includes('class="privacy"'), false, 'Hoso privacy box must be removed');
  assert.equal(hosoHtml.includes('Cam kết không thu thập dữ liệu'), false);

  const hosoPanelJs = files.find((f) => f.path === 'panels/hoso/panel-hoso.js')?.content || '';
  for (const label of ["'Tháng này'", "'Tháng trước'", "'Quý trước'", "'Năm nay'"]) {
    assert.equal(hosoPanelJs.includes(label), true, `Hoso presets missing ${label}`);
  }
  assert.equal(hosoPanelJs.includes("'12 tháng qua'"), false, 'Hoso old 12 tháng qua preset must be removed');

  const commonJs = files.find((f) => f.path === 'content/common.js')?.content || '';
  assert.equal(commonJs.includes('window.__taxcapCommonLoaded'), true, 'common.js must guard against duplicate load');
  assert.equal(commonJs.includes('taxcapExtId'), true, 'common.js must tag and dedupe same-extension widgets');
});

