import assert from 'node:assert/strict';

let model;
try {
  model = await import('../src/ui/output-log-model.mjs');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
    assert.fail('missing output-log reconciliation model');
  }
  throw error;
}

const {
  MAX_RENDERED_ROWS,
  applyInitialSnapshot,
  createFrameBatcher,
  createOutputLogModel,
  expandHistory,
  getVirtualWindow,
  reduceOutputLogEvent
} = model;

function row(id, command = `L0${id}`) {
  return { id, kind: 'motion', command, completedAt: id, portPath: 'COM3', baudRate: 115200 };
}

function session(sessionId, rows = []) {
  return { sessionId, portPath: 'COM3', rows, omittedRows: 0 };
}

let state = applyInitialSnapshot(createOutputLogModel(), session(1, [row(1)]), [
  { type: 'reset', session: session(2, [row(1, 'reset')]) },
  { type: 'append', payload: { sessionId: 2, row: row(2), omittedRows: 0 } }
]);
assert.equal(state.session.sessionId, 2, 'live reset wins over a delayed initial snapshot');
assert.deepEqual(state.session.rows.map(entry => entry.id), [1, 2], 'queued live appends replay after reset');

const beforeDuplicate = state;
state = reduceOutputLogEvent(state, { type: 'append', payload: { sessionId: 2, row: row(2), omittedRows: 0 } });
assert.equal(state, beforeDuplicate, 'duplicate row IDs do not produce another state revision');
state = reduceOutputLogEvent(state, { type: 'append', payload: { sessionId: 1, row: row(99), omittedRows: 0 } });
assert.equal(state, beforeDuplicate, 'append events from older sessions are ignored');

const fixedSlice = {
  ...createOutputLogModel(),
  session: session(2, Array.from({ length: 500 }, (_, index) => row(index + 1))),
  visibleCount: 500
};
const fixedSliceBefore = fixedSlice.revision;
state = reduceOutputLogEvent(fixedSlice, { type: 'append', payload: { sessionId: 2, row: row(501), omittedRows: 0 } });
assert.equal(state.session.rows.slice(-state.visibleCount).length, 500, 'latest slice remains fixed at 500 rows');
assert.ok(state.revision > fixedSliceBefore, 'latest identity changes even when a visible slice stays the same size');
const resetRevision = state.revision;
state = reduceOutputLogEvent(state, { type: 'reset', session: session(2, Array.from({ length: 500 }, (_, index) => row(index + 1, 'same-count-reset'))) });
assert.equal(state.session.rows.length, 500, 'same-count reset replaces the selected history');
assert.ok(state.revision > resetRevision, 'same-session reset produces a new follow revision');

state = reduceOutputLogEvent(state, { type: 'append', payload: { sessionId: 3, row: row(1, 'new-session'), omittedRows: 7 } });
assert.equal(state.session.sessionId, 3, 'newer append starts the newer session');
assert.deepEqual(state.session.rows.map(entry => entry.command), ['new-session']);
assert.equal(state.session.omittedRows, 7);

const historical = {
  ...createOutputLogModel(),
  session: session(3, Array.from({ length: 1_000 }, (_, index) => row(index + 1))),
  visibleCount: 500,
  following: true
};
const expansion = expandHistory(historical, 120, 24);
assert.equal(expansion.model.visibleCount, 1_000);
assert.equal(expansion.model.following, false, 'opening history suspends follow');
assert.equal(expansion.scrollTop, 12_120, 'opening history keeps the previously visible row anchored');

const retained = reduceOutputLogEvent({
  ...createOutputLogModel(),
  session: session(4, Array.from({ length: 10_000 }, (_, index) => row(index + 1)))
}, { type: 'append', payload: { sessionId: 4, row: row(10_001), omittedRows: 1 } });
assert.equal(retained.session.rows.length, 10_000, 'model retains at most 10,000 rows');
assert.equal(retained.session.rows[0].id, 2);

const virtual = getVirtualWindow(10_000, 120_000, 480, 24);
assert.ok(virtual.end - virtual.start <= MAX_RENDERED_ROWS, 'virtual window bounds mounted data rows');
assert.equal(virtual.topSpacerPx, virtual.start * 24);
assert.equal(virtual.bottomSpacerPx, (10_000 - virtual.end) * 24);

const callbacks = [];
const cancelled = [];
let frame;
const batcher = createFrameBatcher(values => callbacks.push(values), callback => {
  frame = callback;
  return 42;
}, handle => cancelled.push(handle));
batcher.push('first');
batcher.push('second');
assert.deepEqual(callbacks, [], 'append work batches until an animation frame');
frame();
assert.deepEqual(callbacks, [['first', 'second']], 'batching preserves event order');
batcher.push('discarded');
batcher.dispose();
assert.deepEqual(cancelled, [42], 'disposing cancels a scheduled frame');
frame();
assert.deepEqual(callbacks, [['first', 'second']], 'a cancelled frame cannot process events after cleanup');

console.log('hardware output log model tests passed');
