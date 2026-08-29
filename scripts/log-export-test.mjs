import assert from 'node:assert/strict';

const { buildLogExportPayload } = await import('../dist-electron/log-export.js');

const entries = [{
  id: 1,
  timestamp: 1_777_244_400_000,
  level: 'info',
  source: 'hardware',
  message: 'hardware-connected',
  details: 'COM3'
}];

const payload = buildLogExportPayload({
  appName: 'Haptic Relay',
  version: '0.1.1-demo.10',
  exportedAt: '2026-08-25T00:00:00.000Z',
  entries,
  diagnostic: {
    schemaVersion: 1,
    sessionId: 'session-one',
    format: 'jsonl',
    activeFile: '/profile/logs/haptic-relay.jsonl',
    maxFileBytes: 2_097_152,
    maxFiles: 5,
    token: 'must-not-export'
  },
  password: 'must-not-export',
  environment: { SECRET: 'must-not-export' }
});

assert.deepEqual(payload, {
  schemaVersion: 1,
  sessionId: 'session-one',
  app: 'Haptic Relay',
  version: '0.1.1-demo.10',
  exportedAt: '2026-08-25T00:00:00.000Z',
  entries,
  diagnosticLog: {
    schemaVersion: 1,
    sessionId: 'session-one',
    format: 'jsonl',
    maxFileBytes: 2_097_152,
    maxFiles: 5
  }
});

const serialized = JSON.stringify(payload);
assert.doesNotMatch(serialized, /must-not-export|password|environment|token|profile|activeFile/);

console.log('log export payload tests passed');
