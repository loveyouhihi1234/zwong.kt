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
