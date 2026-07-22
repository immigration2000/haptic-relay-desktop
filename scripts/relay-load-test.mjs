import { io } from 'socket.io-client';
import { performance } from 'node:perf_hooks';

const relayUrl = process.env.RELAY_URL ?? 'http://localhost:4174';
const viewerCount = Number(process.env.VIEWERS ?? 500);
const hz = Number(process.env.HZ ?? 30);
const durationMs = Number(process.env.DURATION_MS ?? 30000);
const roomName = `load-${Date.now()}`;
const intervalMs = 1000 / hz;

const viewers = [];
let received = 0;
let sent = 0;
let host;

function encodeMotion(position, intensity) {
  const packet = new Uint8Array(4);
  const view = new DataView(packet.buffer);
  view.setUint16(0, Math.round(clamp01(position) * 65535), false);
  view.setUint16(2, Math.round(clamp01(intensity) * 65535), false);
  return packet;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function connectSocket() {
  return io(relayUrl, {
    transports: ['websocket'],
    upgrade: false,
    reconnection: false,
    timeout: 10000
  });
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(eventName, payload, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

async function main() {
  host = connectSocket();
  await waitForConnect(host);

  const createResponse = await emitWithAck(host, 'room:create', {
    roomName,
    entryMode: 'open'
  });
  if (!createResponse?.ok) throw new Error(`room create failed: ${JSON.stringify(createResponse)}`);

  for (let index = 0; index < viewerCount; index += 1) {
    const viewer = connectSocket();
    viewer.on('m', () => {
      received += 1;
    });
    await waitForConnect(viewer);
    const joinResponse = await emitWithAck(viewer, 'viewer:join', {
      displayName: `viewer-${index}`,
      roomName
    });
    if (!joinResponse?.ok) throw new Error(`viewer join failed: ${index} ${JSON.stringify(joinResponse)}`);
    viewers.push(viewer);
  }

  const startedAt = performance.now();
  let nextSendAt = startedAt;

  await new Promise(resolve => {
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - startedAt >= durationMs) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (now >= nextSendAt) {
        const phase = sent / Math.max(1, hz);
        host.volatile.compress(false).emit('m', encodeMotion((Math.sin(phase) + 1) / 2, 0.7));
        sent += 1;
        nextSendAt += intervalMs;
      }
    }, 1);
  });

  const elapsedSec = (performance.now() - startedAt) / 1000;
  const expected = sent * viewerCount;
  const receiveRate = expected === 0 ? 0 : received / expected;

  console.log(JSON.stringify({
    relayUrl,
    viewers: viewerCount,
    hz,
    durationSec: Number(elapsedSec.toFixed(2)),
    sentFrames: sent,
    expectedViewerFrames: expected,
    receivedViewerFrames: received,
    receiveRate: Number(receiveRate.toFixed(4)),
    receivedPerSecond: Number((received / elapsedSec).toFixed(2))
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    host?.disconnect();
    for (const viewer of viewers) viewer.disconnect();
  });
