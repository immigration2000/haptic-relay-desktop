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
    { schemaVersion: 1, timestamp: 1000, sessionId: 'session-one', level: 'info', source: 'app', event: 'first', data: { order: 1 } },
    { schemaVersion: 1, timestamp: 1001, sessionId: 'session-one', level: 'info', source: 'app', event: 'second', data: { order: 2 } }
  ]);
  assert.equal(fake.directories.has(diagnosticsDirectory), true, 'directory is created lazily');
  assert.deepEqual(fake.appendOrder.map(line => JSON.parse(line).event), ['first', 'second']);
  assert.deepEqual(errors, []);
  assert.deepEqual(store.metadata(), {
    schemaVersion: 1,
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

  store.recordMotion({ timestamp: 2100, outcome: 'completed', command: 'L05000100', position: 0.5, intensity: 0.1 });
  store.recordMotion({ timestamp: 2200, outcome: 'completed', command: 'L06000100', position: 0.6, intensity: 0.1 });
  store.recordMotion({ timestamp: 2300, outcome: 'dropped', reason: 'protection-paused' });
  store.recordMotion({ timestamp: 3100, outcome: 'failed', reason: 'hardware-write-timeout' });
  await store.flushMotion();
  await store.flush();

  const summaries = allRecords(fake).filter(record => record.event === 'hardware-motion-summary');
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[0].data, {
    attempted: 3,
    completed: 2,
    dropped: 1,
    failed: 0,
    firstTimestamp: 2100,
    lastTimestamp: 2300,
    lastCommand: 'L06000100',
    lastPosition: 0.6,
    lastIntensity: 0.1,
    lastFailureReason: 'protection-paused'
  });
  assert.deepEqual(summaries[1].data, {
    attempted: 1,
    completed: 0,
    dropped: 0,
    failed: 1,
    firstTimestamp: 3100,
    lastTimestamp: 3100,
    lastFailureReason: 'hardware-write-timeout'
  });
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

console.log('diagnostic log store tests passed');
