import process from 'node:process';
import { io } from 'socket.io-client';
import { decodeMotionPacket, encodeMotionPacket } from '../dist-server/src/shared/motion-packet.js';

const port = Number(process.env.HAPTIC_SMOKE_TEST_PORT ?? 4210);
const baseUrl = `http://127.0.0.1:${port}`;
const sockets = [];
const results = [];

process.env.HAPTIC_RELAY_PORT = String(port);
process.env.HAPTIC_RELAY_HOST = '127.0.0.1';
process.env.HAPTIC_PUBLIC_RELAY_URL = baseUrl;
process.env.HAPTIC_CONTROL_TOKEN_SECRET = 'smoke-test-secret-that-is-longer-than-32-characters';
process.env.HAPTIC_HOST_RECONNECT_GRACE_MS = '250';
process.env.HAPTIC_RELAY_BURST_FRAMES = '4';

const { closeRelayServer, relayServerReady } = await import('../dist-server/server/src/relay-server.js');
await relayServerReady;

try {
  await runSmokeTest();
} catch (error) {
  record('smoke test completed', false, formatError(error));
} finally {
  for (const socket of sockets) socket.disconnect();
  await closeRelayServer();
}

const passed = results.filter(result => result.pass).length;
console.log(JSON.stringify({
  summary: {
    passed,
    total: results.length,
    failed: results.length - passed
  },
  results
}, null, 2));

if (passed !== results.length) process.exitCode = 1;

async function runSmokeTest() {
  const health = await fetch(`${baseUrl}/healthz`).then(response => response.json());
  record('health endpoint', health.ok === true && health.rooms === 0, JSON.stringify(health));

  const roomName = uniqueRoomName('open');
  const created = await post('/api/rooms', { roomName, password: 'open-secret', entryMode: 'open' });
  record('open room create', created.status === 201 && Boolean(created.payload.hostToken), `status=${created.status}`);

  const wrongPassword = await post(`/api/rooms/${encodeURIComponent(roomName)}/join`, {
    displayName: 'viewer-one',
    password: 'wrong'
  });
  record('wrong password rejected', wrongPassword.status === 403, `status=${wrongPassword.status}`);

  const host = await connectSocket();
  const hostBound = await emitWithAck(host, 'room:create', { token: created.payload.hostToken });
  record('host socket bind', hostBound.ok === true, JSON.stringify(hostBound));

  const joined = await post(`/api/rooms/${encodeURIComponent(roomName)}/join`, {
    displayName: 'viewer-one',
    password: 'open-secret'
  });
  const viewer = await connectSocket();
  const viewerBound = await emitWithAck(viewer, 'viewer:join', {
    displayName: 'viewer-one',
    token: joined.payload.viewerToken
  });
  record('viewer join', joined.status === 200 && viewerBound.ok === true, JSON.stringify(viewerBound));

  const legacyMotionPromise = onceEvent(viewer, 'm');
  host.volatile.compress(false).emit('m', Uint8Array.from([0x80, 0x00, 0x40, 0x00]));
  const legacyMotion = decodeMotionPacket(await legacyMotionPromise);
  const nextLegacyMotionPromise = onceEvent(viewer, 'm');
  host.volatile.compress(false).emit('m', Uint8Array.from([0x90, 0x00, 0x50, 0x00]));
  const nextLegacyMotion = decodeMotionPacket(await nextLegacyMotionPromise);
  record(
    'legacy V1 motion relay',
    legacyMotion.protocolVersion === 2
      && nextLegacyMotion.protocolVersion === 2
      && nextLegacyMotion.sequence === legacyMotion.sequence + 1
      && almostEqual(legacyMotion.position, 32768 / 65535)
      && almostEqual(legacyMotion.intensity, 16384 / 65535),
    JSON.stringify({ legacyMotion, nextLegacyMotion })
  );

  const sourceTimeMs = Date.now() - 120;
  const motionPromise = onceEvent(viewer, 'm');
  host.volatile.compress(false).emit('m', encodeMotionPacket({
    protocolVersion: 2,
    sequence: 77,
    sourceTimeMs,
    timestamp: sourceTimeMs,
    durationMs: 45,
    position: 0.35,
    intensity: 0.65
  }));
  const motion = decodeMotionPacket(await motionPromise);
  record(
    'V2 motion metadata relay',
    motion.protocolVersion === 2 && motion.sequence === 77 && motion.sourceTimeMs === sourceTimeMs && motion.durationMs === 45,
    JSON.stringify(motion)
  );

  const viewers = await emitWithAck(host, 'room:viewers', {});
  record('host viewer list', viewers.ok === true && viewers.viewers?.some(item => item.displayName === 'viewer-one'), JSON.stringify(viewers));

  const stopPromise = onceEvent(viewer, 'room:stop');
  const stopResponse = await emitWithAck(host, 'room:stop', {});
  const stopSignal = await stopPromise;
  record('room emergency stop relay', stopResponse.ok === true && stopSignal.roomName === roomName, JSON.stringify(stopSignal));

  const removedPromise = onceEvent(viewer, 'viewer:removed');
  const moderation = await emitWithAck(host, 'viewer:moderate', { socketId: viewer.id, action: 'kick' });
  const removed = await removedPromise;
  record('viewer kick', moderation.ok === true && removed.reason === 'kick', JSON.stringify(removed));

  const requestRoomName = uniqueRoomName('request');
  const requestCreated = await post('/api/rooms', { roomName: requestRoomName, entryMode: 'request' });
  const requestHost = await connectSocket();
  await emitWithAck(requestHost, 'room:create', { token: requestCreated.payload.hostToken });

  const approvalRequested = onceEvent(requestHost, 'viewer:approval-requested');
  const requestJoin = await post(`/api/rooms/${encodeURIComponent(requestRoomName)}/join`, {
    displayName: 'needs-approval'
  });
  const requestViewer = await connectSocket();
  const requestBound = await emitWithAck(requestViewer, 'viewer:join', {
    displayName: 'needs-approval',
    token: requestJoin.payload.viewerToken
  });
  const approval = await approvalRequested;
  record('approval request queued', requestBound.reason === 'approval-required' && approval.displayName === 'needs-approval', JSON.stringify(requestBound));

  const approvedEvent = onceEvent(requestViewer, 'viewer:approved');
  const approvalResponse = await emitWithAck(requestHost, 'viewer:approve', {
    socketId: requestViewer.id,
    approved: true
  });
  await approvedEvent;
  record('approval accepted', approvalResponse.ok === true && approvalResponse.approved === true, JSON.stringify(approvalResponse));

  host.disconnect();
  const reconnectedHost = await connectSocket();
  const rejoin = await emitWithAck(reconnectedHost, 'room:create', { token: created.payload.hostToken });
  record('host reconnect with existing token', rejoin.ok === true, JSON.stringify(rejoin));

  const expiringRoomName = uniqueRoomName('expires');
  const expiringCreated = await post('/api/rooms', { roomName: expiringRoomName, entryMode: 'open' });
  const expiringHost = await connectSocket();
  await emitWithAck(expiringHost, 'room:create', { token: expiringCreated.payload.hostToken });
  const expiringJoin = await post(`/api/rooms/${encodeURIComponent(expiringRoomName)}/join`, {
    displayName: 'cleanup-viewer'
  });
  const expiringViewer = await connectSocket();
  await emitWithAck(expiringViewer, 'viewer:join', {
    displayName: 'cleanup-viewer',
    token: expiringJoin.payload.viewerToken
  });

  const hostClosedEvent = onceEvent(expiringViewer, 'viewer:removed');
  expiringHost.disconnect();
  const hostClosed = await hostClosedEvent;
  await delay(50);
  const joinAfterClose = await post(`/api/rooms/${encodeURIComponent(expiringRoomName)}/join`, {
    displayName: 'late-viewer'
  });
  record('expired host session cleanup', hostClosed.reason === 'host-disconnected' && joinAfterClose.status === 404, `event=${JSON.stringify(hostClosed)} http=${joinAfterClose.status}`);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function connectSocket() {
  const socket = io(baseUrl, {
    transports: ['websocket'],
    upgrade: false,
    reconnection: false,
    timeout: 2_000
  });
  sockets.push(socket);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket-connect-timeout')), 2_500);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return socket;
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(2_500).emit(eventName, payload, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function onceEvent(socket, eventName, timeoutMs = 2_500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`${eventName}-timeout`));
    }, timeoutMs);
    const handler = value => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(eventName, handler);
  });
}

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

function uniqueRoomName(suffix) {
  return `smoke-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function almostEqual(actual, expected) {
  return Math.abs(actual - expected) < 0.000_01;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
