import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import JSZip from 'jszip';
import { buildExtensionArtifacts, generatePngIcon } from './extensionBundle';

test('generatePngIcon returns valid PNG header', () => {
  const buf = generatePngIcon(48);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('buildExtensionArtifacts defaults to 100% standalone Direct Gemini mode without proxy dependency', async () => {
  const { zipBuffer, files } = await buildExtensionArtifacts({});

  const zip = await JSZip.loadAsync(zipBuffer);
  assert.ok(zip.file('manifest.json'));
  assert.ok(zip.file('config.js'));
  assert.ok(zip.file('direct-gemini.js'));
  assert.ok(zip.file('license.js'));
  assert.ok(zip.file('background.js'));
  assert.ok(zip.file('content/captcha-svg-templates.js'));
  assert.ok(zip.file('content/captcha-svg.js'));
  assert.ok(zip.file('content/common.js'));
  assert.ok(zip.file('content/hddt.js'));
  assert.ok(zip.file('content/tdt.js'));
  assert.ok(zip.file('content/dvc.js'));
  assert.ok(zip.file('content/tracuunnt.js'));
  assert.ok(zip.file('icons/icon-48.png'));
  assert.ok(zip.file('icons/icon-128.png'));

  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions.includes('storage'), true);
  assert.equal(manifest.permissions.includes('alarms'), true);
  assert.equal(manifest.host_permissions.includes('https://generativelanguage.googleapis.com/*'), true);
  assert.equal(manifest.host_permissions.includes('https://script.google.com/*'), true);
  assert.equal(manifest.content_scripts.every((s: { run_at: string }) => s.run_at === 'document_end'), true);

  const configJs = await zip.file('config.js')!.async('string');
  assert.equal(configJs.includes('"connectionMode": "direct"'), true);
  assert.equal(configJs.includes('"speedMode": "fast"'), true);
  assert.equal(configJs.includes('"licenseApiUrl":'), true);
  assert.equal(files.length >= 13, true);

  for (const file of files) {
    if (file.path.endsWith('.js')) {
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
