import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { buildLogExportPayload } = await import('../dist-electron/log-export.js');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.version, '0.1.1-demo.11');

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
  version: '0.1.1-demo.11',
  exportedAt: '2026-08-25T00:00:00.000Z',
  entries,
  diagnostic: {
    schemaVersion: 2,
    sessionId: 'session-one',
    format: 'jsonl',
    activeFile: '/profile/logs/haptic-relay.jsonl',
    maxFileBytes: 16 * 1024 * 1024,
    maxFiles: 16,
    token: 'must-not-export'
  },
  password: 'must-not-export',
  environment: { SECRET: 'must-not-export' }
});

assert.deepEqual(payload, {
  schemaVersion: 1,
  sessionId: 'session-one',
  app: 'Haptic Relay',
  version: '0.1.1-demo.11',
  exportedAt: '2026-08-25T00:00:00.000Z',
  entries,
  diagnosticLog: {
    schemaVersion: 2,
    sessionId: 'session-one',
    format: 'jsonl',
    maxFileBytes: 16 * 1024 * 1024,
    maxFiles: 16
  }
});

const serialized = JSON.stringify(payload);
assert.doesNotMatch(serialized, /must-not-export|password|environment|token|profile|activeFile/);

console.log('log export payload tests passed');
