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
  electron = spawn(electronExecutable, ['.', `--remote-debugging-port=${debugPort}`], {
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
  await waitForExpression(cdp, `document.body.innerText.includes('방 만들기')`);

  await captureScreenshot(cdp, path.join(outputDirectory, '01-host-setup.png'));
  await cdp.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes('서버 URL'));
    const input = label?.querySelector('input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'http://127.0.0.1:${relayPort}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await delay(100);
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '방 생성');
    button?.click();
    return Boolean(button);
  })()`);
  await waitForExpression(cdp, `document.body.innerText.includes('스트리머 방 관리')`);
  const managementLayout = await cdp.evaluate(`(() => {
    const workspace = document.querySelector('.workspace');
    return {
      windowScrollX: window.scrollX,
      workspaceScrollLeft: workspace.scrollLeft,
      workspaceClientWidth: workspace.clientWidth,
      workspaceScrollWidth: workspace.scrollWidth,
      workspaceClientHeight: workspace.clientHeight,
      workspaceScrollHeight: workspace.scrollHeight
    };
  })()`);
  assert.equal(managementLayout.windowScrollX, 0, 'window must not scroll horizontally');
  assert.equal(managementLayout.workspaceScrollLeft, 0, 'workspace must not shift horizontally');
  assert.ok(
    managementLayout.workspaceScrollWidth <= managementLayout.workspaceClientWidth,
    `workspace overflows horizontally: ${JSON.stringify(managementLayout)}`
  );
  assert.ok(
    managementLayout.workspaceScrollHeight <= managementLayout.workspaceClientHeight,
    `room header and tabs must remain fixed while tab content scrolls: ${JSON.stringify(managementLayout)}`
  );
  await captureScreenshot(cdp, path.join(outputDirectory, '02-room-management.png'));

  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '실시간 시연');
    button?.click();
    return Boolean(button);
  })()`);
  await waitForExpression(cdp, `Boolean(document.querySelector('.motion-demo-controls'))`);
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '시연 시작');
    button?.click();
    return Boolean(button);
  })()`);
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
  await captureScreenshot(cdp, path.join(outputDirectory, '03-live-demo.png'));

  cdp.send('Browser.close');
  await waitForExit(electron, 5_000);
  assert.doesNotMatch(logs.electron, /Object has been destroyed|JavaScript error occurred/i, 'Electron closes without destroyed-object errors');

  console.log(JSON.stringify({
    ok: true,
    screenshots: [
      path.join(outputDirectory, '01-host-setup.png'),
      path.join(outputDirectory, '02-room-management.png'),
      path.join(outputDirectory, '03-live-demo.png')
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
