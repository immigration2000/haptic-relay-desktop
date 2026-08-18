import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
const relayPort = await getAvailablePort();
const debugPort = await getAvailablePort();
const directoryRoomName = `directory-${Date.now().toString(36)}`;
const outputDirectory = path.join(os.tmpdir(), 'haptic-relay-ui-smoke');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const logs = { server: '', electron: '' };

await mkdir(outputDirectory, { recursive: true });

const server = spawn(process.execPath, ['dist-server/server/src/relay-server.js'], {
  cwd: root,
  env: {
    ...process.env,
    HAPTIC_RELAY_PORT: String(relayPort),
    HAPTIC_PUBLIC_RELAY_URL: `http://127.0.0.1:${relayPort}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
captureOutput(server, 'server');

let electron;
let cdp;
try {
  await waitForHttp(`http://127.0.0.1:${relayPort}/healthz`);
  const seededRoom = await fetch(`http://127.0.0.1:${relayPort}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: directoryRoomName, password: 'directory-secret', entryMode: 'request' })
  });
  assert.equal(seededRoom.status, 201, 'directory test room is created');
  electron = spawn(electronExecutable, ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(outputDirectory, `profile-${Date.now()}`)}`], {
    cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  captureOutput(electron, 'electron');

  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find(target => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Electron renderer target is available');
  cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  await waitForExpression(cdp, `document.body.innerText.includes('로그인')`);
  await captureScreenshot(cdp, path.join(outputDirectory, '00-login.png'));
  await setInputByLabel(cdp, '아이디', 'user01');
  await setInputByLabel(cdp, '비밀번호', 'demo-password');
  await clickButton(cdp, '로그인');
  await waitForExpression(cdp, `document.body.innerText.includes('방 찾기')`);
  await waitForExpression(cdp, `document.body.innerText.includes('공식 릴레이')`);
  await clickButton(cdp, '방 만들기');
  await waitForExpression(cdp, `document.querySelector('[role="dialog"]')?.textContent.includes('새 방 만들기')`);
  await waitForExpression(cdp, `(() => {
    const labels = [...document.querySelectorAll('label')];
    return labels.find(label => label.textContent.includes('서버 URL'))?.querySelector('input')?.value === 'https://relay.syncra.uk';
  })()`);
  await clickButton(cdp, '취소');
  const savedSession = await cdp.evaluate(`JSON.parse(localStorage.getItem('haptic-relay.demo-session.v1'))`);
  assert.deepEqual(savedSession, { username: 'user01', remembered: true }, 'demo login persists username only');
  await clickButton(cdp, '서버 선택');
  await clickButton(cdp, '사용자 서버 추가');
  await setInputByLabel(cdp, '서버 이름', 'QA Relay');
  await setInputByLabel(cdp, '서버 URL', `http://127.0.0.1:${relayPort}`);
  await clickButton(cdp, '서버 사용');
  await waitForExpression(cdp, `document.querySelector('[data-server-health="online"]')?.getAttribute('aria-label') === '서버 연결됨'`);
  await waitForExpression(cdp, `document.querySelectorAll('[data-room-card]').length === 1 && document.body.innerText.includes(${JSON.stringify(directoryRoomName)})`);
  await waitForExpression(cdp, `!document.body.innerText.includes('심야 드라이브')`);
  await captureScreenshot(cdp, path.join(outputDirectory, '01-room-browser.png'));
  await cdp.evaluate(`document.querySelector('.room-card-open')?.click()`);
  await waitForExpression(cdp, `document.querySelector('[role="dialog"]')?.textContent.includes('초대 코드로 입장')`);
  await waitForExpression(cdp, `(() => {
    const labels = [...document.querySelectorAll('label')];
    return labels.find(label => label.textContent.includes('방 이름'))?.querySelector('input')?.value === ${JSON.stringify(directoryRoomName)};
  })()`);
  await clickButton(cdp, '취소');
  await setInputByPlaceholder(cdp, '방 이름, 소개, 태그 검색', directoryRoomName);
  await waitForExpression(cdp, `document.querySelectorAll('[data-room-card]').length === 1`);
  await setInputByPlaceholder(cdp, '방 이름, 소개, 태그 검색', '');
  await clickButton(cdp, '방 만들기');
  await waitForExpression(cdp, `document.querySelector('[role="dialog"]')?.textContent.includes('새 방 만들기')`);
  await selectOptionByLabel(cdp, '입장 방식', 'open');
  assert.deepEqual(await getInputStateByLabel(cdp, '비밀번호'), { value: '', focused: false, disabled: true }, '자유 입장 방은 비밀번호를 입력할 수 없다');
  await selectOptionByLabel(cdp, '입장 방식', 'request');
  await typeInputByLabel(cdp, '비밀번호', 'focus-secret');
  const passwordInputState = await getInputStateByLabel(cdp, '비밀번호');
  assert.deepEqual(passwordInputState, { value: 'focus-secret', focused: true, disabled: false }, '모달이 다시 렌더링되어도 비밀번호 입력 포커스가 유지된다');
  await selectOptionByLabel(cdp, '입장 방식', 'open');
  assert.deepEqual(await getInputStateByLabel(cdp, '비밀번호'), { value: '', focused: false, disabled: true }, '자유 입장으로 변경하면 입력한 비밀번호가 지워진다');
  await captureScreenshot(cdp, path.join(outputDirectory, '02-create-room-modal.png'));
  await setInputByLabel(cdp, '서버 URL', `http://127.0.0.1:${relayPort}`);
  await setInputByLabel(cdp, '방 이름', 'studio-main');
  await clickButton(cdp, '방 생성');
  await waitForExpression(cdp, `document.body.innerText.includes('HOST SESSION') && document.body.innerText.includes('방 관리')`);
  await assertNoDocumentOverflow(cdp, '1180x780 host room');
  await captureScreenshot(cdp, path.join(outputDirectory, '03-room-management.png'));
  await clickButton(cdp, '방 찾기');
  await waitForExpression(cdp, `document.body.innerText.includes('studio-main')`);
  await clickRoomCard(cdp, 'studio-main');
  await waitForExpression(cdp, `document.querySelector('[role="dialog"]')?.textContent.includes('초대 코드로 입장')`);
  assert.deepEqual(await getInputStateByLabel(cdp, '비밀번호'), { value: '', focused: false, disabled: true }, '자유 입장 방에 들어갈 때는 비밀번호 입력을 사용할 수 없다');
  await clickButton(cdp, '취소');
  await clickButton(cdp, '현재 세션');
  await waitForExpression(cdp, `document.body.innerText.includes('HOST SESSION') && document.body.innerText.includes('방 관리')`);

  await clickButton(cdp, '실시간 시연');
  await waitForExpression(cdp, `Boolean(document.querySelector('.motion-demo-controls'))`);
  await clickButton(cdp, '시연 시작');
  await waitForExpression(cdp, `document.querySelector('.stream-state')?.textContent.includes('30Hz 전송 중')`);
  await cdp.evaluate(`(() => {
    const inputs = document.querySelectorAll('.motion-demo-controls input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], '0.82');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], '0.31');
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    return [inputs[0].value, inputs[1].value];
  })()`);
  await waitForExpression(cdp, `document.body.innerText.includes('0.82') && document.body.innerText.includes('0.31')`);
  await captureScreenshot(cdp, path.join(outputDirectory, '04-live-demo.png'));
  await clickButton(cdp, '시연 중지');
  await waitForExpression(cdp, `document.querySelector('.stream-state')?.textContent.includes('전송 대기')`);
  await clickButton(cdp, '자동 패턴');
  await waitForExpression(cdp, `(() => {
    const controls = ['period', 'position-min', 'position-max', 'pattern-intensity'];
    return controls.every(control => document.querySelector('[data-control="' + control + '"]'))
      && Boolean(document.querySelector('.pattern-preview output'));
  })()`);
  await selectOptionByLabel(cdp, '패턴', 'triangle');
  await clickButton(cdp, '시연 시작');
  await waitForExpression(cdp, `document.querySelector('.stream-state')?.textContent.includes('30Hz 전송 중')`);
  const firstAutomaticPosition = await cdp.evaluate(`Number(document.querySelector('.pattern-preview output')?.textContent)`);
  assert.ok(Number.isFinite(firstAutomaticPosition), 'automatic preview reports a numeric position');
  await delay(500);
  const secondAutomaticPosition = await cdp.evaluate(`Number(document.querySelector('.pattern-preview output')?.textContent)`);
  assert.ok(Number.isFinite(secondAutomaticPosition), 'automatic preview continues reporting a numeric position');
  assert.notEqual(firstAutomaticPosition, secondAutomaticPosition, 'automatic preview position changes over 500ms');
  await captureScreenshot(cdp, path.join(outputDirectory, '05-automatic-pattern.png'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await assertNoDocumentOverflow(cdp, '960x640 automatic pattern');
  await captureScreenshot(cdp, path.join(outputDirectory, '06-automatic-pattern-960x640.png'));
  await clickButton(cdp, '시연 중지');
  await waitForExpression(cdp, `document.querySelector('.stream-state')?.textContent.includes('전송 대기')`);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
  await clickButton(cdp, '하드웨어');
  await waitForExpression(cdp, `document.body.innerText.includes('DEVICE CONFIGURATION')`);
  await waitForExpression(cdp, `document.querySelector('[data-hardware-output]')?.textContent.includes('T-Code 출력이 완료되면 표시됩니다.')`);
  await assertNoDocumentOverflow(cdp, '1180x780 hardware output monitor');
  await captureScreenshot(cdp, path.join(outputDirectory, '07-hardware.png'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await assertNoDocumentOverflow(cdp, '960x640 hardware output monitor');
  await captureScreenshot(cdp, path.join(outputDirectory, '08-hardware-output-960x640.png'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
  await clickButton(cdp, '보호 설정');
  await waitForExpression(cdp, `document.body.innerText.includes('MOTION PROTECTION')`);
  await captureScreenshot(cdp, path.join(outputDirectory, '09-safety.png'));
  await clickButton(cdp, '로그');
  await waitForExpression(cdp, `document.body.innerText.includes('EVENT INSPECTOR')`);
  await captureScreenshot(cdp, path.join(outputDirectory, '10-logs.png'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await assertNoDocumentOverflow(cdp, '960x640 logs');
  await captureScreenshot(cdp, path.join(outputDirectory, '11-logs-960x640.png'));

  cdp.send('Browser.close');
  await waitForExit(electron, 5_000);
  assert.doesNotMatch(logs.electron, /Object has been destroyed|JavaScript error occurred/i, 'Electron closes without destroyed-object errors');

  console.log(JSON.stringify({
    ok: true,
    screenshots: [
      path.join(outputDirectory, '00-login.png'),
      path.join(outputDirectory, '01-room-browser.png'),
      path.join(outputDirectory, '02-create-room-modal.png'),
      path.join(outputDirectory, '03-room-management.png'),
      path.join(outputDirectory, '04-live-demo.png'),
      path.join(outputDirectory, '05-automatic-pattern.png'),
      path.join(outputDirectory, '06-automatic-pattern-960x640.png'),
      path.join(outputDirectory, '07-hardware.png'),
      path.join(outputDirectory, '08-hardware-output-960x640.png'),
      path.join(outputDirectory, '09-safety.png'),
      path.join(outputDirectory, '10-logs.png'),
      path.join(outputDirectory, '11-logs-960x640.png')
    ]
  }, null, 2));
} finally {
  cdp?.close();
  await terminateChild(electron);
  await terminateChild(server);
}

function captureOutput(child, key) {
  child.stdout?.on('data', chunk => { logs[key] += chunk.toString(); });
  child.stderr?.on('data', chunk => { logs[key] += chunk.toString(); });
}

async function captureScreenshot(client, filePath) {
  const result = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(filePath, Buffer.from(result.data, 'base64'));
}

async function setInputByLabel(client, labelText, value) {
  const changed = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const input = label?.querySelector('input, textarea');
    if (!input) return false;
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `${labelText} input is available`);
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

async function typeInputByLabel(client, labelText, value) {
  const focused = await client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const input = label?.querySelector('input');
    input?.focus();
    return input instanceof HTMLInputElement;
  })()`);
  assert.equal(focused, true, `${labelText} input can receive focus`);
  for (const character of value) {
    await client.call('Input.insertText', { text: character });
    await delay(20);
  }
}

async function getInputStateByLabel(client, labelText) {
  return client.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes(${JSON.stringify(labelText)}));
    const input = label?.querySelector('input');
    if (!(input instanceof HTMLInputElement)) return null;
    return { value: input.value, focused: document.activeElement === input, disabled: input.disabled };
  })()`);
}

async function clickButton(client, label) {
  const clicked = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(clicked, true, `${label} button is available`);
}

async function clickRoomCard(client, roomName) {
  const clicked = await client.evaluate(`(() => {
    const card = [...document.querySelectorAll('[data-room-card]')].find(item => item.textContent.includes(${JSON.stringify(roomName)}));
    const button = card?.querySelector('.room-card-open');
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(clicked, true, `${roomName} room card is available`);
}

async function setInputByPlaceholder(client, placeholder, value) {
  const changed = await client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(`[placeholder="${placeholder}"]`)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `${placeholder} input is available`);
  await delay(80);
}

async function assertNoDocumentOverflow(client, label) {
  const overflow = await client.evaluate(`({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight
  })`);
  assert.equal(overflow.horizontal, false, `${label} has no horizontal document overflow`);
  assert.equal(overflow.vertical, false, `${label} has no vertical document overflow`);
}

async function waitForExpression(client, expression, timeoutMs = 8_000) {
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
    delay(timeoutMs).then(() => { throw new Error('Electron did not exit after Browser.close'); })
  ]);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        else if (port === undefined) reject(new Error('Unable to allocate a QA port'));
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
