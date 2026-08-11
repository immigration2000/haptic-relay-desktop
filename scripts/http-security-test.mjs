import assert from 'node:assert/strict';

import {
  FixedWindowRateLimiter,
  getClientAddress,
  getMetricsAccess
} from '../dist-server/server/src/http-security.js';

let now = 1_000;
const limiter = new FixedWindowRateLimiter({
  maxRequests: 2,
  windowMs: 1_000,
  now: () => now
});

assert.deepEqual(limiter.consume('viewer-a'), {
  allowed: true,
  remaining: 1,
  retryAfterSeconds: 1
});
assert.deepEqual(limiter.consume('viewer-a'), {
  allowed: true,
  remaining: 0,
  retryAfterSeconds: 1
});
assert.deepEqual(limiter.consume('viewer-a'), {
  allowed: false,
  remaining: 0,
  retryAfterSeconds: 1
});
assert.equal(limiter.consume('viewer-b').allowed, true, 'rate limits must be isolated by client');

now = 2_001;
assert.equal(limiter.consume('viewer-a').allowed, true, 'rate limit window must reset');

const request = {
  headers: { 'cf-connecting-ip': '203.0.113.7' },
  socket: { remoteAddress: '127.0.0.1' }
};
assert.equal(getClientAddress(request, false), '127.0.0.1');
assert.equal(getClientAddress(request, true), '203.0.113.7');
assert.equal(getClientAddress({
  headers: { 'cf-connecting-ip': 'not-an-ip' },
  socket: { remoteAddress: '127.0.0.1' }
}, true), '127.0.0.1', 'invalid proxy addresses must be ignored');

const metricsToken = 'metrics-secret-that-is-at-least-32-characters';
assert.equal(getMetricsAccess(undefined, undefined), 'disabled');
assert.equal(getMetricsAccess(metricsToken, undefined), 'unauthorized');
assert.equal(getMetricsAccess(metricsToken, 'Bearer wrong-token'), 'unauthorized');
assert.equal(getMetricsAccess(metricsToken, `Bearer ${metricsToken}`), 'authorized');

console.log('http security test passed');
