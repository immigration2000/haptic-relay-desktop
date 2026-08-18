import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  send(method, params = {}) {
    this.socket.send(JSON.stringify({ id: this.nextId++, method, params }));
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const root = path.resolve(import.meta.dirname, '..');
const appExecutable = process.env.APP_EXECUTABLE?.trim()
  ? path.resolve(process.env.APP_EXECUTABLE.trim())
  : path.join(root, 'release', 'win-unpacked', 'Haptic Relay.exe');
const relayPort = await getAvailablePort();
const externalRelayUrl = process.env.RELAY_URL?.trim();
const relayUrl = externalRelayUrl || `http://127.0.0.1:${relayPort}`;
const hostDebugPort = await getAvailablePort();
const viewerDebugPort = await getAvailablePort();
const runId = Date.now().toString(36);
const roomName = `studio-${runId}`;
const roomPassword = `password-${runId}`;
const viewerName = `viewer-${runId}`;
const automaticPositionRange = { min: 0.2, max: 0.8 };
const outputDirectory = path.join(os.tmpdir(), `haptic-relay-two-client-${runId}`);
const logs = { server: '', host: '', viewer: '' };

await access(appExecutable);
await mkdir(outputDirectory, { recursive: true });

const server = externalRelayUrl ? undefined : spawn(process.execPath, ['dist-server/server/src/relay-server.js'], {
  cwd: root,
  env: {
    ...process.env,
    HAPTIC_RELAY_PORT: String(relayPort),
    HAPTIC_PUBLIC_RELAY_URL: relayUrl
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
if (server) captureOutput(server, 'server');

let host;
let viewer;
let hostCdp;
let viewerCdp;

try {
  await waitForHttp(`${relayUrl}/healthz`);
  host = launchApp('host', hostDebugPort);
  captureOutput(host, 'host');
  hostCdp = await connectRenderer(hostDebugPort);
  await hostCdp.call('Page.enable');
  await hostCdp.call('Runtime.enable');
  await loginClient(hostCdp, `host-${runId}`);
  await clickButton(hostCdp, '방 만들기');
  await waitForExpression(hostCdp, `document.querySelector('[role="dialog"]')?.textContent.includes('새 방 만들기')`);
  await setInputByLabel(hostCdp, '서버 URL', relayUrl);
  await setInputByLabel(hostCdp, '방 이름', roomName);
  await setInputByLabel(hostCdp, '비밀번호', roomPassword);
  await clickButton(hostCdp, '방 생성');
  await waitForExpression(hostCdp, `document.body.innerText.includes('HOST SESSION')`);
  const inviteCode = await hostCdp.evaluate(`document.querySelector('.invite-code code')?.textContent.trim() ?? ''`);
  assert.match(inviteCode, /^HRS1\./, 'host room exposes an invite code');

  viewer = launchApp('viewer', viewerDebugPort);
  captureOutput(viewer, 'viewer');
  viewerCdp = await connectRenderer(viewerDebugPort);
  await viewerCdp.call('Page.enable');
  await viewerCdp.call('Runtime.enable');
  await loginClient(viewerCdp, viewerName);
  await clickButton(viewerCdp, '서버 선택');
  await clickButton(viewerCdp, '사용자 서버 추가');
  await setInputByLabel(viewerCdp, '서버 이름', '테스트 릴레이');
  await setInputByLabel(viewerCdp, '서버 URL', relayUrl);
  await clickButton(viewerCdp, '서버 사용');
  await clickButton(viewerCdp, '초대 코드');
  await waitForExpression(viewerCdp, `document.querySelector('[role="dialog"]')?.textContent.includes('초대 코드로 입장')`);
  await setTextareaByLabel(viewerCdp, '초대 코드', inviteCode);
  await clickButton(viewerCdp, '초대 코드 적용');
  await setInputByLabel(viewerCdp, '표시 이름', viewerName);
  await waitForExpression(viewerCdp, `(() => {
    const labels = [...document.querySelectorAll('label')];
    const value = text => labels.find(label => label.textContent.includes(text))?.querySelector('input')?.value;
    return value('방 이름') === ${JSON.stringify(roomName)}
      && value('서버 URL') === ${JSON.stringify(relayUrl)}
      && value('비밀번호') === ${JSON.stringify(roomPassword)};
  })()`);
  await clickButton(viewerCdp, '입장 요청');

  await waitForExpression(viewerCdp, `document.body.innerText.includes('PARTICIPANT SESSION')`);
  await waitForExpression(hostCdp, `document.body.innerText.includes(${JSON.stringify(viewerName)}) && document.body.innerText.includes('1명 접속')`);
  await captureScreenshot(hostCdp, path.join(outputDirectory, '01-host-viewer-connected.png'));

  await clickButton(hostCdp, '실시간 시연');
  await waitForExpression(hostCdp, `Boolean(document.querySelector('.motion-demo-controls'))`);
  await clickButton(hostCdp, '시연 시작');
  await waitForExpression(hostCdp, `document.querySelector('.stream-state')?.textContent.includes('30Hz 전송 중')`);
  await setDemoControls(hostCdp, 0.82, 0.31);

  await waitForExpression(viewerCdp, `(() => {
    const gauges = document.querySelectorAll('.motion-gauge');
    return document.querySelector('.monitor-state')?.textContent.includes('수신 중')
      && gauges[0]?.textContent.includes('0.82')
      && gauges[1]?.textContent.includes('0.31');
  })()`);
  const receivedFrames = await viewerCdp.evaluate(`Number(document.querySelectorAll('.monitor-metrics dd')[2]?.textContent ?? 0)`);
  assert.ok(receivedFrames >= 2, `viewer must receive repeated motion frames, got ${receivedFrames}`);
  await captureScreenshot(hostCdp, path.join(outputDirectory, '02-host-live-demo.png'));
  await captureScreenshot(viewerCdp, path.join(outputDirectory, '03-viewer-receiving.png'));

  await clickButton(hostCdp, '시연 중지');
  await waitForExpression(hostCdp, `document.querySelector('.stream-state')?.textContent.includes('전송 대기')`);

  await clickButton(hostCdp, '자동 패턴');
  await waitForExpression(hostCdp, `Boolean(document.querySelector('.pattern-demo-content'))`);
  await selectOptionByLabel(hostCdp, '패턴', 'triangle');
  await clickButton(hostCdp, '시연 시작');
  await waitForExpression(hostCdp, `document.querySelector('.stream-state')?.textContent.includes('30Hz 전송 중')`);
  await waitForExpression(viewerCdp, `(() => {
    const text = document.querySelector('.motion-gauge strong')?.textContent.trim() ?? '';
    const position = Number(text);
    return document.querySelector('.monitor-state')?.textContent.includes('수신 중')
      && /^[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/.test(text)
      && Number.isFinite(position)
      && position >= ${automaticPositionRange.min}
      && position <= ${automaticPositionRange.max};
  })()`);

  const automaticSamples = await sampleViewerPositions(viewerCdp, 1_400);
  const automaticPositions = automaticSamples.map(sample => {
    assert.match(sample.positionText, /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/, 'viewer position display must be numeric');
    const position = Number(sample.positionText);
    assert.ok(Number.isFinite(position), `viewer position must be finite, got ${sample.positionText}`);
    return position;
  });
  const distinctAutomaticPositions = [...new Set(automaticPositions)];
  assert.ok(
    distinctAutomaticPositions.length >= 3,
    `viewer must receive at least 3 distinct automatic positions, got ${distinctAutomaticPositions.join(', ')}`
  );
  assert.ok(
    automaticPositions.every(position => position >= automaticPositionRange.min && position <= automaticPositionRange.max),
    `automatic positions must remain between ${automaticPositionRange.min} and ${automaticPositionRange.max}`
  );
  assert.ok(
    automaticSamples.every(sample => sample.receiving),
    'viewer must remain in the receiving state during automatic delivery'
  );
  const firstAutomaticFrame = automaticSamples[0].receivedFrames;
  const automaticReceivedFrames = automaticSamples.at(-1).receivedFrames;
  assert.ok(
    automaticReceivedFrames >= firstAutomaticFrame + 2,
    `viewer must continue receiving repeated automatic frames, got ${firstAutomaticFrame} to ${automaticReceivedFrames}`
  );
  await captureScreenshot(hostCdp, path.join(outputDirectory, '04-host-automatic-pattern.png'));
  await captureScreenshot(viewerCdp, path.join(outputDirectory, '05-viewer-automatic-receiving.png'));

  await clickButton(hostCdp, '시연 중지');
  await waitForExpression(hostCdp, `document.querySelector('.stream-state')?.textContent.includes('전송 대기')`);

  viewerCdp.send('Browser.close');
  await waitForExit(viewer, 5_000);
  await waitForExpression(hostCdp, `document.querySelector('.viewer-chip')?.textContent.includes('0명 접속')`);
  hostCdp.send('Browser.close');
  await waitForExit(host, 5_000);

  assertCleanExitLog('host', logs.host);
  assertCleanExitLog('viewer', logs.viewer);

  console.log(JSON.stringify({
    ok: true,
    roomName,
    viewerName,
    receivedFrames,
    automaticReceivedFrames,
    distinctAutomaticPositions,
    screenshots: [
      path.join(outputDirectory, '01-host-viewer-connected.png'),
      path.join(outputDirectory, '02-host-live-demo.png'),
      path.join(outputDirectory, '03-viewer-receiving.png'),
      path.join(outputDirectory, '04-host-automatic-pattern.png'),
      path.join(outputDirectory, '05-viewer-automatic-receiving.png')
    ]
  }, null, 2));
} finally {
  hostCdp?.close();
  viewerCdp?.close();
  await terminateChild(host);
  await terminateChild(viewer);
  if (server) await terminateChild(server);
}

function launchApp(role, debugPort) {
  return spawn(appExecutable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(outputDirectory, `${role}-profile`)}`
  ], {
    cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function connectRenderer(debugPort) {
  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find(target => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, `renderer target is available on ${debugPort}`);
  return CdpClient.connect(page.webSocketDebuggerUrl);
}

async function setInputByLabel(client, labelText, value) {
  const changed = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const input = label?.querySelector('input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `input is available: ${labelText}`);
  await delay(80);
}

async function setTextareaByLabel(client, labelText, value) {
  const changed = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const textarea = label?.querySelector('textarea');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `textarea is available: ${labelText}`);
  await delay(80);
}

async function selectOptionByLabel(client, labelText, value) {
  const changed = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const select = label?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(value)};
  })()`);
  assert.equal(changed, true, `${labelText} select accepts ${value}`);
}

async function loginClient(client, username) {
  await waitForExpression(client, `document.body.innerText.includes('로그인')`);
  await setInputByLabel(client, '아이디', username);
  await setInputByLabel(client, '비밀번호', 'demo-password');
  await clickButton(client, '로그인');
  await waitForExpression(client, `document.body.innerText.includes('방 찾기')`);
}

async function clickButton(client, text) {
  const clicked = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)});
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(clicked, true, `button is available: ${text}`);
  await delay(80);
}

async function setDemoControls(client, position, intensity) {
  const values = await client.evaluate(`(() => {
    const inputs = document.querySelectorAll('.motion-demo-controls input');
    if (inputs.length !== 2) return [];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], ${JSON.stringify(String(position))});
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], ${JSON.stringify(String(intensity))});
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    return [inputs[0].value, inputs[1].value];
  })()`);
  assert.deepEqual(values, [String(position), String(intensity)]);
}

async function sampleViewerPositions(client, durationMs) {
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt <= durationMs) {
    const sample = await client.evaluate(`(() => ({
      positionText: document.querySelector('.motion-gauge strong')?.textContent.trim() ?? '',
      receivedFrames: Number(document.querySelectorAll('.monitor-metrics dd')[2]?.textContent ?? Number.NaN),
      receiving: document.querySelector('.monitor-state')?.textContent.includes('수신 중') ?? false
    }))()`);
    assert.ok(Number.isInteger(sample.receivedFrames), `viewer frame count must be numeric, got ${sample.receivedFrames}`);
    samples.push(sample);
    await delay(100);
  }
  return samples;
}

function assertCleanExitLog(label, log) {
  assert.doesNotMatch(log, /Object has been destroyed|JavaScript error occurred/i, `${label} closes without destroyed-object errors`);
}

function captureOutput(child, key) {
  child.stdout?.on('data', chunk => { logs[key] += chunk.toString(); });
  child.stderr?.on('data', chunk => { logs[key] += chunk.toString(); });
}

async function captureScreenshot(client, filePath) {
  const result = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(filePath, Buffer.from(result.data, 'base64'));
}

async function waitForExpression(client, expression, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await client.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

async function waitForHttp(url, timeoutMs = 8_000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => undefined);
    return response?.ok;
  }, timeoutMs, `HTTP endpoint ${url}`);
}

async function waitForJson(url, timeoutMs = 8_000) {
  let value;
  await waitFor(async () => {
    const response = await fetch(url).catch(() => undefined);
    if (!response?.ok) return false;
    value = await response.json();
    return true;
  }, timeoutMs, `JSON endpoint ${url}`);
  return value;
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(timeoutMs).then(() => { throw new Error('Packaged app did not exit after Browser.close'); })
  ]);
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(error => {
        if (error) reject(error);
        else if (port === undefined) reject(new Error('Unable to allocate a test port'));
        else resolve(port);
      });
    });
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  try {
    await waitForExit(child, 2_000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
