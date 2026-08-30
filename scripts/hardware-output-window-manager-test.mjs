import assert from 'node:assert/strict';

const { HardwareOutputWindowManager } = await import('../dist-electron/services/hardware-output-window-manager.js');

const created = [];
const manager = new HardwareOutputWindowManager(() => {
  const listeners = new Map();
  const sent = [];
  const window = {
    destroyed: false,
    shown: 0,
    focused: 0,
    closeCalls: 0,
    sent,
    isDestroyed() { return this.destroyed; },
    show() { this.shown += 1; },
    focus() { this.focused += 1; },
    on(name, listener) { listeners.set(name, listener); },
    close() { this.closeCalls += 1; this.destroyed = true; },
    closeForTest() { this.destroyed = true; listeners.get('closed')?.(); },
    emitClosedForTest() { listeners.get('closed')?.(); },
    webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) }
  };
  created.push(window);
  return window;
});

const first = manager.open();
assert.equal(created.length, 1);
assert.equal(manager.open(), first);
assert.equal(first.shown, 1);
assert.equal(first.focused, 1);
assert.equal(manager.send('hardware-output-log:append', { id: 1 }), true);
assert.deepEqual(first.sent, [['hardware-output-log:append', { id: 1 }]]);
first.webContents.isDestroyed = () => true;
assert.equal(manager.send('hardware-output-log:append', { id: 2 }), false);
first.webContents.isDestroyed = () => false;
first.closeForTest();
assert.equal(manager.send('hardware-output-log:append', { id: 3 }), false);
const second = manager.open();
assert.notEqual(second, first);
assert.equal(created.length, 2);
assert.equal(manager.isCurrentWebContents(second.webContents), true);
manager.close();
assert.equal(second.closeCalls, 1);
assert.equal(manager.isCurrentWebContents(second.webContents), false);
const third = manager.open();
assert.equal(created.length, 3);
second.emitClosedForTest();
assert.equal(manager.send('hardware-output-log:append', { id: 4 }), true);
assert.deepEqual(third.sent, [['hardware-output-log:append', { id: 4 }]]);

console.log('hardware output window manager tests passed');
