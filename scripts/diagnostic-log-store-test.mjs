import assert from 'node:assert/strict';
import path from 'node:path';

const { DiagnosticLogStore } = await import('../dist-electron/diagnostic-log-store.js');

function createFakeOperations() {
  const files = new Map();
  const directories = new Set();
  const appendOrder = [];
  let failAppend = false;

  return {
    files,
    directories,
    appendOrder,
    failNextAppend() {
      failAppend = true;
    },
    operations: {
      async mkdir(directory) {
        directories.add(directory);
      },
      async stat(filePath) {
        if (!files.has(filePath)) throw missingFileError(filePath);
        return { size: Buffer.byteLength(files.get(filePath), 'utf8') };
      },
      async appendFile(filePath, content) {
        if (failAppend) {
          failAppend = false;
          throw new Error('diagnostic-append-failed');
        }
        appendOrder.push(content);
        files.set(filePath, `${files.get(filePath) ?? ''}${content}`);
      },
      async rename(sourcePath, targetPath) {
        if (!files.has(sourcePath)) throw missingFileError(sourcePath);
        files.set(targetPath, files.get(sourcePath));
        files.delete(sourcePath);
      },
      async unlink(filePath) {
        if (!files.has(filePath)) throw missingFileError(filePath);
        files.delete(filePath);
      }
    }
  };
}

function missingFileError(filePath) {
  const error = new Error(`ENOENT: ${filePath}`);
  error.code = 'ENOENT';
  return error;
}

function parseJsonLines(content = '') {
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function allRecords(fake) {
  return [...fake.files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, content]) => parseJsonLines(content));
}

const diagnosticsDirectory = path.join(path.parse(process.cwd()).root, 'diagnostics');
const activePath = path.join(diagnosticsDirectory, 'haptic-relay.jsonl');

{
  const fake = createFakeOperations();
  const store = new DiagnosticLogStore({ directory: diagnosticsDirectory, sessionId: 'defaults', operations: fake.operations });
  assert.equal(store.metadata().schemaVersion, 2);
  assert.equal(store.metadata().maxFileBytes, 16 * 1024 * 1024);
  assert.equal(store.metadata().maxFiles, 16);
}

{
  const fake = createFakeOperations();
  const errors = [];
  const store = new DiagnosticLogStore({
    directory: diagnosticsDirectory,
    sessionId: 'session-one',
    maxFileBytes: 512,
    maxFiles: 5,
    operations: fake.operations,
    onError: error => errors.push(error.message)
  });

  await Promise.all([
    store.record({ timestamp: 1000, level: 'info', source: 'app', event: 'first', data: { order: 1 } }),
    store.record({ timestamp: 1001, level: 'info', source: 'app', event: 'second', data: { order: 2 } })
  ]);
  await store.flush();

  assert.deepEqual(parseJsonLines(fake.files.get(activePath)), [
    { schemaVersion: 2, timestamp: 1000, sessionId: 'session-one', level: 'info', source: 'app', event: 'first', data: { order: 1 } },
    { schemaVersion: 2, timestamp: 1001, sessionId: 'session-one', level: 'info', source: 'app', event: 'second', data: { order: 2 } }
  ]);
  assert.equal(fake.directories.has(diagnosticsDirectory), true, 'directory is created lazily');
  assert.deepEqual(fake.appendOrder.map(line => JSON.parse(line).event), ['first', 'second']);
  assert.deepEqual(errors, []);
  assert.deepEqual(store.metadata(), {
    schemaVersion: 2,
    sessionId: 'session-one',
    format: 'jsonl',
    activeFile: activePath,
    maxFileBytes: 512,
    maxFiles: 5
  });
}

{
  const fake = createFakeOperations();
  const store = new DiagnosticLogStore({
    directory: diagnosticsDirectory,
    sessionId: 'rotation-session',
    maxFileBytes: 512,
    maxFiles: 5,
    operations: fake.operations
  });

  for (let index = 0; index < 20; index += 1) {
    await store.record({
      timestamp: 2000 + index,
      level: 'info',
      source: 'hardware',
      event: `rotation-${index}`,
      data: { index, payload: 'x'.repeat(60) }
    });
  }
  await store.flush();

  assert.equal(fake.files.size, 5, 'rotation retains the active file and four generations');
  for (const [filePath, content] of fake.files) {
    assert.equal(Buffer.byteLength(content, 'utf8') <= 512, true, `${filePath} stays within the configured bound`);
    assert.doesNotThrow(() => parseJsonLines(content), `${filePath} contains complete JSON lines`);
  }
  assert.equal(allRecords(fake).at(-1).event, 'rotation-19');
}

{
  const fake = createFakeOperations();
  const store = new DiagnosticLogStore({
    directory: diagnosticsDirectory,
    sessionId: 'motion-session',
    operations: fake.operations
  });

  await store.recordMotion({ timestamp: 2100, outcome: 'completed', command: 'L05000100', position: 0.5, intensity: 0.1 });
  await store.recordMotion({ timestamp: 2200, outcome: 'completed', command: 'L06000100', position: 0.6, intensity: 0.1 });
  await store.recordMotion({ timestamp: 2300, outcome: 'dropped', position: 0.6, intensity: 0.1, reason: 'protection-paused' });
  await store.recordMotion({ timestamp: 3100, outcome: 'failed', command: 'L07000100', position: 0.7, intensity: 0.1, reason: 'hardware-write-timeout', durationMs: 500, timeout: true });
  await store.flush();

  const samples = allRecords(fake);
  assert.deepEqual(samples.map(record => record.event), [
    'hardware-motion-sample',
    'hardware-motion-sample',
    'hardware-motion-sample',
    'hardware-motion-sample'
  ]);
  assert.deepEqual(samples.map(record => record.data.outcome), ['completed', 'completed', 'dropped', 'failed']);
  assert.equal(samples[1].data.command, 'L06000100');
  assert.equal(samples[2].data.reason, 'protection-paused');
  assert.equal(samples[3].data.durationMs, 500);
  assert.equal(samples[3].data.timeout, true);
}

{
  const fake = createFakeOperations();
  const errors = [];
  const store = new DiagnosticLogStore({
    directory: diagnosticsDirectory,
    sessionId: 'failure-session',
    operations: fake.operations,
    onError: error => errors.push(error.message)
  });

  fake.failNextAppend();
  await store.record({ timestamp: 4000, level: 'error', source: 'hardware', event: 'failed', data: {} });
  await store.record({ timestamp: 4001, level: 'info', source: 'app', event: 'ignored', data: {} });
  await store.flush();

  assert.deepEqual(errors, ['diagnostic-append-failed']);
  assert.equal(fake.files.has(activePath), false, 'persistence disables after the first filesystem failure');
}

{
  const fake = createFakeOperations();
  const store = new DiagnosticLogStore({
    directory: diagnosticsDirectory,
    sessionId: 'boundary-session',
    operations: fake.operations
  });

  store.recordMotion({ timestamp: 5_100, outcome: 'completed', command: 'L05000I33' });
  await store.recordBoundary({
    timestamp: 5_200,
    level: 'info',
    source: 'app',
    event: 'session-ended',
    data: {}
  });
  await store.flush();

  assert.deepEqual(
    parseJsonLines(fake.files.get(activePath)).map(record => record.event),
    ['hardware-motion-sample', 'session-ended'],
    'lifecycle boundaries persist the final raw motion sample first'
  );
}

console.log('diagnostic log store tests passed');
