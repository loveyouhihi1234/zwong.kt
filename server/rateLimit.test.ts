import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimit';

test('createRateLimiter enforces maxRequests within window and resets after expiry', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });

  const r1 = limiter.check('1.2.3.4', 100);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);

  const r2 = limiter.check('1.2.3.4', 200);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);

  const r3 = limiter.check('1.2.3.4', 300);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);
  assert.equal(r3.resetInMs, 800);

  // Different IP is unaffected
  const other = limiter.check('5.6.7.8', 300);
  assert.equal(other.allowed, true);

  // Window expires
  const afterReset = limiter.check('1.2.3.4', 1100);
  assert.equal(afterReset.allowed, true);
  assert.equal(afterReset.remaining, 1);

  assert.equal(limiter.prune(2200), 2);
});
