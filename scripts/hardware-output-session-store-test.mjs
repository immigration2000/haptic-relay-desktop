import assert from 'node:assert/strict';

const { HardwareOutputSessionStore } = await import('../dist-electron/services/hardware-output-session-store.js');

const store = new HardwareOutputSessionStore(3, () => 1_000);
assert.deepEqual(store.snapshot(), { sessionId: 0, rows: [], omittedRows: 0 });

assert.deepEqual(store.reset('COM3'), {
  sessionId: 1,
  startedAt: 1_000,
  portPath: 'COM3',
  rows: [],
  omittedRows: 0
});

const generatedIdStore = new HardwareOutputSessionStore(3, () => 1_000);
generatedIdStore.reset('COM3');
const appendedWithCallerId = generatedIdStore.append({
  id: 999,
  kind: 'motion',
  command: 'L00',
  completedAt: 1_001,
  portPath: 'COM3',
  baudRate: 115200
});
assert.equal(appendedWithCallerId.row.id, 1, 'returned row uses the generated ID');
assert.equal(generatedIdStore.snapshot().rows[0].id, 1, 'stored row uses the generated ID');
assert.equal(appendedWithCallerId.sessionId, 1, 'append payload identifies its current session');

for (let index = 0; index < 5; index += 1) {
  store.append({
    kind: 'motion',
    command: `L0${index}`,
    completedAt: 1_001 + index,
    portPath: 'COM3',
    baudRate: 115200
  });
}

const retained = store.snapshot();
assert.equal(retained.sessionId, 1);
assert.equal(retained.omittedRows, 2);
assert.deepEqual(retained.rows.map(row => row.id), [3, 4, 5]);
assert.deepEqual(retained.rows.map(row => row.command), ['L02', 'L03', 'L04']);

const snapshotCopy = store.snapshot();
snapshotCopy.rows[0].command = 'mutated';
snapshotCopy.rows.length = 0;
assert.equal(store.snapshot().rows.length, 3, 'callers cannot mutate store rows');
assert.equal(store.snapshot().rows[0].command, 'L02', 'callers cannot mutate stored row objects');

store.reset('COM4');
assert.deepEqual(store.snapshot(), {
  sessionId: 2,
  startedAt: 1_000,
  portPath: 'COM4',
  rows: [],
  omittedRows: 0
});

console.log('hardware output session store tests passed');
