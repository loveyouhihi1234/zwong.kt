import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginSandboxRequest, normalizeExtensionToken } from './auth';

test('normalizeExtensionToken strips accidental quotes and placeholders', () => {
  assert.equal(normalizeExtensionToken(undefined), '');
  assert.equal(normalizeExtensionToken(''), '');
  assert.equal(normalizeExtensionToken('""'), '');
  assert.equal(normalizeExtensionToken("  'MY_EXTENSION_SHARED_TOKEN'  "), '');
  assert.equal(normalizeExtensionToken(' "team-123" '), 'team-123');
});

test('isSameOriginSandboxRequest accepts same-origin behind Cloud Run proxy and rejects chrome-extension origins', () => {
  const cloudRunReq = {
    headers: {
      'x-taxcap-sandbox': '1',
      origin: 'https://ais-dev-example.asia-southeast1.run.app',
      'x-forwarded-host': 'ais-dev-example.asia-southeast1.run.app',
    },
    get: (name: string) => (name.toLowerCase() === 'host' ? '127.0.0.1:3000' : undefined),
  };
  assert.equal(
    isSameOriginSandboxRequest(cloudRunReq, 'https://ais-dev-example.asia-southeast1.run.app'),
    true,
  );

  const extReq = {
    headers: {
      'x-taxcap-sandbox': '1',
      origin: 'chrome-extension://abcdefghijklmnop',
      'x-forwarded-host': 'ais-dev-example.asia-southeast1.run.app',
    },
    get: (name: string) => (name.toLowerCase() === 'host' ? 'localhost:3000' : undefined),
  };
  assert.equal(
    isSameOriginSandboxRequest(extReq, 'https://ais-dev-example.asia-southeast1.run.app'),
    false,
  );
});
