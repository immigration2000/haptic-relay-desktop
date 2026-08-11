import assert from 'node:assert/strict';

const { sendToRenderer } = await import('../dist-electron/window-messenger.js');

const sent = [];
const activeWindow = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (...args) => sent.push(args)
  }
};

assert.equal(sendToRenderer(undefined, 'room:viewers', []), false);
assert.equal(sendToRenderer({ ...activeWindow, isDestroyed: () => true }, 'room:viewers', []), false);
assert.equal(sendToRenderer({
  ...activeWindow,
  webContents: { ...activeWindow.webContents, isDestroyed: () => true }
}, 'room:viewers', []), false);
assert.deepEqual(sent, [], 'destroyed renderer targets must not receive messages');

assert.equal(sendToRenderer(activeWindow, 'room:viewers', [{ socketId: 'viewer-1' }]), true);
assert.deepEqual(sent, [['room:viewers', [{ socketId: 'viewer-1' }]]]);

console.log('window messenger tests passed');
