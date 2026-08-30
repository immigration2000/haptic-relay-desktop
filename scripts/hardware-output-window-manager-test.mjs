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
    sent,
    isDestroyed() { return this.destroyed; },
    show() { this.shown += 1; },
    focus() { this.focused += 1; },
    on(name, listener) { listeners.set(name, listener); },
    closeForTest() { this.destroyed = true; listeners.get('closed')?.(); },
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
assert.notEqual(manager.open(), first);
assert.equal(created.length, 2);

console.log('hardware output window manager tests passed');
