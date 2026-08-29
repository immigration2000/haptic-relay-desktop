import process from 'node:process';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { io } from 'socket.io-client';
import { decodeMotionPacket, encodeMotionPacket } from '../dist-server/src/shared/motion-packet.js';

const port = Number(process.env.HAPTIC_SMOKE_TEST_PORT ?? 4210);
const baseUrl = `http://127.0.0.1:${port}`;
const sockets = [];
const cleanup = [];
const results = [];

process.env.HAPTIC_RELAY_PORT = String(port);
process.env.HAPTIC_RELAY_HOST = '127.0.0.1';
process.env.HAPTIC_PUBLIC_RELAY_URL = baseUrl;
process.env.HAPTIC_CONTROL_TOKEN_SECRET = 'smoke-test-secret-that-is-longer-than-32-characters';
process.env.HAPTIC_HOST_RECONNECT_GRACE_MS = '250';
process.env.HAPTIC_RELAY_BURST_FRAMES = '4';
process.env.HAPTIC_METRICS_TOKEN = 'smoke-metrics-token-that-is-longer-than-32-characters';
process.env.HAPTIC_ROOM_CREATE_RATE_LIMIT = '4';
process.env.HAPTIC_ROOM_JOIN_RATE_LIMIT = '8';
process.env.HAPTIC_CONTROL_RATE_WINDOW_MS = '60000';

const { closeRelayServer, relayServerReady } = await import('../dist-server/server/src/relay-server.js');
await relayServerReady;
const { RelayClient } = await import('../dist-electron/services/relay-client.js');

try {
  await runSmokeTest();
} catch (error) {
  record('smoke test completed', false, formatError(error));
} finally {
  for (const disconnect of cleanup) disconnect();
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

  const unauthorizedMetrics = await fetch(`${baseUrl}/metrics`);
  record('metrics require bearer token', unauthorizedMetrics.status === 401, `status=${unauthorizedMetrics.status}`);
  const authorizedMetrics = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: `Bearer ${process.env.HAPTIC_METRICS_TOKEN}` }
  });
  record('metrics accept configured bearer token', authorizedMetrics.status === 200, `status=${authorizedMetrics.status}`);

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

  const directoryAfterCreate = await get('/api/rooms');
  const listedRoom = directoryAfterCreate.payload.rooms?.find(room => room.roomName === roomName);
  const serializedDirectory = JSON.stringify(directoryAfterCreate.payload);
  record(
    'public room directory redacts credentials',
    directoryAfterCreate.status === 200
      && listedRoom?.entryMode === 'open'
      && listedRoom.passwordProtected === true
      && listedRoom.viewerCount === 0
      && listedRoom.maxViewers === 500
      && listedRoom.relayNodeId === 'local-1'
      && Number.isFinite(listedRoom.createdAt)
      && !serializedDirectory.includes('open-secret')
      && !serializedDirectory.includes(created.payload.hostToken)
      && !serializedDirectory.includes(host.id),
    serializedDirectory
  );

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

  const terminalStatuses = [];
  const terminalConnections = [];
  const terminalRejoinClient = new RelayClient(
    undefined,
    undefined,
    status => terminalStatuses.push(status),
    undefined,
    undefined,
    status => terminalConnections.push(status)
  );
  terminalRejoinClient.socket = { connected: true, disconnect() {} };
  terminalRejoinClient.roomName = 'ended-room';
  terminalRejoinClient.session = {
    role: 'viewer',
    roomName: 'ended-room',
    displayName: 'terminal-viewer',
    token: 'not-exposed',
    waitingForApproval: false
  };
  terminalRejoinClient.emitWithAck = async () => ({ ok: false, reason: 'room-not-found' });
  await terminalRejoinClient.rejoinSession();
  assert.equal(terminalRejoinClient.hasActiveRoom(), false, 'terminal rejoin ack clears active room state');
  assert.deepEqual(terminalStatuses, [{ roomName: 'ended-room', status: 'removed', reason: 'room-not-found' }]);
  assert.equal(terminalConnections.length, 0, 'terminal rejoin ack is not reported as a transient connection error');
  record('RelayClient clears terminal rejoin state', true);

  const transientStatuses = [];
  const transientConnections = [];
  const transientRejoinClient = new RelayClient(
    undefined,
    undefined,
    status => transientStatuses.push(status),
    undefined,
    undefined,
    status => transientConnections.push(status)
  );
  transientRejoinClient.socket = { connected: true, disconnect() {} };
  transientRejoinClient.roomName = 'transient-room';
  transientRejoinClient.session = {
    role: 'viewer',
    roomName: 'transient-room',
    displayName: 'transient-viewer',
    token: 'not-exposed',
    waitingForApproval: false
  };
  transientRejoinClient.emitWithAck = async () => { throw new Error('operation-has-timed-out'); };
  await transientRejoinClient.rejoinSession();
  assert.equal(transientRejoinClient.hasActiveRoom(), true, 'transient rejoin failure retains active room state');
  assert.deepEqual(transientStatuses, [], 'transient rejoin failure does not emit a terminal viewer status');
  assert.equal(transientConnections.at(-1)?.status, 'error');
  record('RelayClient retains transient rejoin state', true);

  const pendingJoinGate = deferred();
  const pendingJoinStarted = deferred();
  const pendingJoinClient = new RelayClient();
  await withFetchMock(async (input, init, originalFetch) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (body.displayName !== 'pending-join-viewer') return originalFetch(input, init);
    pendingJoinStarted.resolve();
    await pendingJoinGate.promise;
    return jsonResponse({ ok: true, roomName, relayUrl: baseUrl, viewerToken: joined.payload.viewerToken });
  }, async () => {
    const pendingJoin = pendingJoinClient.joinRoom(baseUrl, {
      displayName: 'pending-join-viewer',
      roomName,
      password: 'open-secret'
    });
    const pendingJoinCancelled = assert.rejects(pendingJoin, /relay-lifecycle-cancelled/);
    await pendingJoinStarted.promise;
    pendingJoinClient.disconnect();
    pendingJoinGate.resolve();
    await pendingJoinCancelled;
  });
  assert.equal(pendingJoinClient.hasActiveRoom(), false, 'disconnect prevents pending join resurrection');
  record('disconnect cancels pending RelayClient join', true);

  const pendingCreateGate = deferred();
  const pendingCreateStarted = deferred();
  const pendingCreateClient = new RelayClient();
  await withFetchMock(async (_input, _init) => {
    pendingCreateStarted.resolve();
    await pendingCreateGate.promise;
    return jsonResponse({
      ok: true,
      roomName,
      relayUrl: baseUrl,
      hostToken: created.payload.hostToken,
      entryMode: 'open'
    }, 201);
  }, async () => {
    const pendingCreate = pendingCreateClient.createRoom(baseUrl, { roomName: 'pending-create-room', entryMode: 'open' });
    const pendingCreateCancelled = assert.rejects(pendingCreate, /relay-lifecycle-cancelled/);
    await pendingCreateStarted.promise;
    pendingCreateClient.disconnect();
    pendingCreateGate.resolve();
    await pendingCreateCancelled;
  });
  assert.equal(pendingCreateClient.hasActiveRoom(), false, 'disconnect prevents pending create resurrection');
  record('disconnect cancels pending RelayClient create', true);

  const staleJoinGate = deferred();
  const staleJoinStarted = deferred();
  const competingJoinClient = new RelayClient();
  await withFetchMock(async (_input, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (body.displayName === 'stale-join-viewer') {
      staleJoinStarted.resolve();
      await staleJoinGate.promise;
      return jsonResponse({ ok: true, roomName: 'stale-room', relayUrl: baseUrl, viewerToken: joined.payload.viewerToken });
    }
    return jsonResponse({ ok: true, roomName, relayUrl: baseUrl, viewerToken: joined.payload.viewerToken });
  }, async () => {
    const staleJoin = competingJoinClient.joinRoom(baseUrl, { displayName: 'stale-join-viewer', roomName: 'stale-room' });
    const staleJoinCancelled = assert.rejects(staleJoin, /relay-lifecycle-cancelled/);
    await staleJoinStarted.promise;
    const winningJoin = competingJoinClient.joinRoom(baseUrl, { displayName: 'winning-join-viewer', roomName });
    await winningJoin;
    staleJoinGate.resolve();
    await staleJoinCancelled;
  });
  assert.equal(competingJoinClient.roomName, roomName, 'older join completion cannot overwrite the winning room');
  assert.equal(competingJoinClient.session?.displayName, 'winning-join-viewer', 'older join cannot overwrite winning session');
  competingJoinClient.disconnect();
  record('latest competing RelayClient join wins', true);

  const directoryAfterJoin = await get('/api/rooms');
  const joinedDirectoryRoom = directoryAfterJoin.payload.rooms?.find(room => room.roomName === roomName);
  record(
    'public room directory updates viewer count',
    directoryAfterJoin.status === 200 && joinedDirectoryRoom?.viewerCount === 1,
    JSON.stringify(joinedDirectoryRoom)
  );

  const mixedProtocolMotion = [];
  const mixedProtocolViewer = new RelayClient(frame => {
    mixedProtocolMotion.push(frame);
  });
  cleanup.push(() => mixedProtocolViewer.disconnect());
  await mixedProtocolViewer.joinRoom(baseUrl, {
    displayName: 'mixed-protocol-viewer',
    roomName,
    password: 'open-secret'
  });
  assert.equal(mixedProtocolViewer.hasActiveRoom(), true, 'joined RelayClient reports an active room');

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

  await waitFor(
    () => mixedProtocolMotion.find(frame => frame.sequence === 77),
    1_000,
    'mixed-protocol viewer did not receive V2 motion'
  );
  host.volatile.compress(false).emit('m', Uint8Array.from([0xa0, 0x00, 0x60, 0x00]));
  const mixedLegacyMotion = await waitFor(
    () => mixedProtocolMotion.find(frame => frame.sequence === 78),
    1_000,
    'legacy V1 motion after V2 was dropped as out-of-order'
  );
  record(
    'legacy V1 sequence continues after V2',
    mixedLegacyMotion.protocolVersion === 2 && mixedLegacyMotion.sequence === 78,
    JSON.stringify(mixedLegacyMotion)
  );

  const delayedMotion = [];
  const delayedViewer = new RelayClient(frame => {
    delayedMotion.push({ frame, receivedAtMs: performance.now() });
  });
  cleanup.push(() => delayedViewer.disconnect());
  await delayedViewer.joinRoom(baseUrl, {
    displayName: 'delayed-viewer',
    roomName,
    password: 'open-secret'
  });
  assert.equal(typeof delayedViewer.setMotionDelay, 'function', 'setMotionDelay missing');
  delayedViewer.setMotionDelay(300);
  const delayedStartMs = performance.now();
  host.volatile.compress(false).emit('m', encodeMotionPacket({
    protocolVersion: 2,
    sequence: 78,
    sourceTimeMs: Date.now(),
    timestamp: Date.now(),
    durationMs: 45,
    position: 0.35,
    intensity: 0.65
  }));
  await delay(100);
  assert.equal(delayedMotion.length, 0, 'delayed RelayClient motion arrived early');
  const delayedOutput = await waitFor(
    () => delayedMotion.find(item => item.frame.sequence === 78),
    1_000,
    'delayed RelayClient motion timeout'
  );
  assert.ok(delayedOutput.receivedAtMs - delayedStartMs >= 250, 'delayed RelayClient motion arrived too early');
  record('RelayClient delays viewer motion', true, `elapsed=${delayedOutput.receivedAtMs - delayedStartMs}`);

  host.volatile.compress(false).emit('m', encodeMotionPacket({
    protocolVersion: 2,
    sequence: 79,
    sourceTimeMs: Date.now(),
    timestamp: Date.now(),
    durationMs: 33,
    position: 0.2,
    intensity: 0.2
  }));
  await delay(120);
  host.volatile.compress(false).emit('m', encodeMotionPacket({
    protocolVersion: 2,
    sequence: 80,
    sourceTimeMs: Date.now(),
    timestamp: Date.now(),
    durationMs: 33,
    position: 0.8,
    intensity: 0.8
  }));
  const interpolatedOutput = await waitFor(
    () => delayedMotion.find(item => item.frame.sequence === 80
      && item.frame.position > 0.25
      && item.frame.position < 0.75),
    1_000,
    'delayed RelayClient did not interpolate sparse motion'
  );
  record('RelayClient interpolates delayed viewer motion', true, JSON.stringify(interpolatedOutput.frame));

  delayedViewer.setMotionDelay(500);
  host.volatile.compress(false).emit('m', encodeMotionPacket({
    protocolVersion: 2,
    sequence: 81,
    sourceTimeMs: Date.now(),
    timestamp: Date.now(),
    durationMs: 45,
    position: 0.35,
    intensity: 0.65
  }));
  const queuedDelayStats = await waitFor(
    () => {
      const stats = delayedViewer.getMotionDelayStats();
      return stats.bufferedFrames === 1 ? stats : undefined;
    },
    1_000,
    'delayed RelayClient motion was not queued'
  );
  assert.equal(queuedDelayStats.bufferedFrames, 1, 'delayed RelayClient motion was not queued');
  assert.equal(delayedViewer.setMotionDelay(500).bufferedFrames, 1, 'reapplying the delay cleared queued motion');
  assert.throws(() => delayedViewer.setMotionDelay(50), /invalid-motion-delay/, 'invalid delay must throw');
  assert.equal(delayedViewer.getMotionDelayStats().bufferedFrames, 1, 'invalid delay cleared queued motion');

  const viewers = await emitWithAck(host, 'room:viewers', {});
  record('host viewer list', viewers.ok === true && viewers.viewers?.some(item => item.displayName === 'viewer-one'), JSON.stringify(viewers));

  const stopPromise = onceEvent(viewer, 'room:stop');
  const stopResponse = await emitWithAck(host, 'room:stop', {});
  const stopSignal = await stopPromise;
  record('room emergency stop relay', stopResponse.ok === true && stopSignal.roomName === roomName, JSON.stringify(stopSignal));
  await delay(550);
  assert.equal(delayedMotion.filter(item => item.frame.sequence === 81).length, 0, 'cleared delayed RelayClient motion was delivered');
  record('RelayClient clears delayed motion on room stop', true);
  mixedProtocolViewer.disconnect();
  assert.equal(mixedProtocolViewer.hasActiveRoom(), false, 'disconnect clears active room state');

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

  host.io.engine.close();
  const reconnectedHost = await connectSocket();
  const rejoin = await emitWithAck(reconnectedHost, 'room:create', { token: created.payload.hostToken });
  record('host reconnect with existing token', rejoin.ok === true, JSON.stringify(rejoin));

  const explicitRoomName = uniqueRoomName('explicit-close');
  const explicitCreated = await post('/api/rooms', { roomName: explicitRoomName, entryMode: 'open' });
  const explicitHost = await connectSocket();
  await emitWithAck(explicitHost, 'room:create', { token: explicitCreated.payload.hostToken });
  const explicitJoin = await post(`/api/rooms/${encodeURIComponent(explicitRoomName)}/join`, {
    displayName: 'explicit-close-viewer'
  });
  const explicitViewer = await connectSocket();
  await emitWithAck(explicitViewer, 'viewer:join', {
    displayName: 'explicit-close-viewer',
    token: explicitJoin.payload.viewerToken
  });
  const explicitClosedEvent = onceEvent(explicitViewer, 'viewer:removed');
  const explicitCloseStartedAt = performance.now();
  explicitHost.disconnect();
  const explicitClosed = await explicitClosedEvent;
  const explicitCloseElapsedMs = performance.now() - explicitCloseStartedAt;
  const directoryAfterExplicitClose = await get('/api/rooms');
  const explicitRoomStillListed = directoryAfterExplicitClose.payload.rooms?.some(room => room.roomName === explicitRoomName);
  record(
    'explicit host leave removes room immediately',
    explicitClosed.reason === 'host-disconnected' && explicitCloseElapsedMs < 150 && explicitRoomStillListed === false,
    `elapsed=${explicitCloseElapsedMs} listed=${explicitRoomStillListed}`
  );

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
  expiringHost.io.engine.close();
  const hostClosed = await hostClosedEvent;
  await delay(50);
  const joinAfterClose = await post(`/api/rooms/${encodeURIComponent(expiringRoomName)}/join`, {
    displayName: 'late-viewer'
  });
  record('expired host session cleanup', hostClosed.reason === 'host-disconnected' && joinAfterClose.status === 404, `event=${JSON.stringify(hostClosed)} http=${joinAfterClose.status}`);

  const createRateLimited = await post('/api/rooms', { roomName: uniqueRoomName('rate-limited') });
  record(
    'room create rate limit',
    createRateLimited.status === 429 && Boolean(createRateLimited.retryAfter),
    `status=${createRateLimited.status} retryAfter=${createRateLimited.retryAfter}`
  );

  const joinRateLimited = await post(`/api/rooms/${encodeURIComponent(roomName)}/join`, {
    displayName: 'rate-limited-viewer',
    password: 'open-secret'
  });
  record(
    'room join rate limit',
    joinRateLimited.status === 429 && Boolean(joinRateLimited.retryAfter),
    `status=${joinRateLimited.status} retryAfter=${joinRateLimited.retryAfter}`
  );
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, payload, retryAfter: response.headers.get('retry-after') };
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, payload: await response.json() };
}

async function withFetchMock(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => mock(input, init, originalFetch);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
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

async function waitFor(find, timeoutMs, timeoutMessage) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = find();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error(timeoutMessage);
}

function almostEqual(actual, expected) {
  return Math.abs(actual - expected) < 0.000_01;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
