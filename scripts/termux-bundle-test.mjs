import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTermuxBundle } from './build-termux-bundle.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'haptic-termux-bundle-'));
const outputDirectory = path.join(temporaryRoot, 'termux-server');

try {
  await buildTermuxBundle({ projectRoot, outputDirectory });

  const requiredFiles = [
    'dist-server/server/src/relay-server.js',
    'package.json',
    'package-lock.json',
    '.env.phone.example',
    'prepare-env.sh',
    'start.sh',
    'stop.sh',
    'restart.sh',
    'start-quick-tunnel.sh',
    'stop-quick-tunnel.sh',
    'health-check.sh',
    'README.md'
  ];

  for (const relativePath of requiredFiles) {
    const file = await stat(path.join(outputDirectory, relativePath));
    assert.equal(file.isFile(), true, `${relativePath} must be a file`);
  }

  const runtimePackage = JSON.parse(await readFile(path.join(outputDirectory, 'package.json'), 'utf8'));
  assert.deepEqual(runtimePackage.dependencies, {
    'socket.io': '^4.8.1'
  });
  assert.equal(runtimePackage.type, 'module');
  assert.equal(runtimePackage.scripts.start, 'node --env-file=.env dist-server/server/src/relay-server.js');
  assert.equal(runtimePackage.devDependencies, undefined);

  const environment = await readFile(path.join(outputDirectory, '.env.phone.example'), 'utf8');
  assert.match(environment, /^NODE_ENV=production$/m);
  assert.match(environment, /^HAPTIC_ROOM_REGISTRY_DRIVER=memory$/m);
  assert.match(environment, /^HAPTIC_MAX_VIEWERS_PER_ROOM=50$/m);
  assert.match(environment, /^HAPTIC_RELAY_MAX_HZ=30$/m);
  assert.match(environment, /^HAPTIC_RELAY_BURST_FRAMES=10$/m);

  const startScript = await readFile(path.join(outputDirectory, 'start.sh'), 'utf8');
  assert.match(startScript, /relay\.pid/);
  assert.match(startScript, /termux-wake-lock/);
  assert.match(startScript, /\^HAPTIC_PUBLIC_RELAY_URL=.*replace-with/);
  assert.match(startScript, /\^HAPTIC_CONTROL_TOKEN_SECRET=.*replace-with/);
  assert.doesNotMatch(startScript, /grep -q "replace-with" \.env/);
  assert.doesNotMatch(startScript, /pkill/);

  const stopScript = await readFile(path.join(outputDirectory, 'stop.sh'), 'utf8');
  assert.match(stopScript, /kill "\$PID"/);
  assert.doesNotMatch(stopScript, /pkill/);

  const prepareScript = await readFile(path.join(outputDirectory, 'prepare-env.sh'), 'utf8');
  assert.match(prepareScript, /randomBytes\(32\)/);
  assert.doesNotMatch(prepareScript, /console\.log/);

  const quickTunnelScript = await readFile(path.join(outputDirectory, 'start-quick-tunnel.sh'), 'utf8');
  assert.match(quickTunnelScript, /cloudflared\.pid/);
  assert.match(quickTunnelScript, /--config \/dev\/null/);
  assert.match(quickTunnelScript, /trycloudflare\\\.com/);
  assert.match(quickTunnelScript, /HAPTIC_PUBLIC_RELAY_URL/);
  assert.doesNotMatch(quickTunnelScript, /pkill/);

  for (const scriptName of [
    'prepare-env.sh',
    'start.sh',
    'stop.sh',
    'restart.sh',
    'start-quick-tunnel.sh',
    'stop-quick-tunnel.sh',
    'health-check.sh'
  ]) {
    const script = await readFile(path.join(outputDirectory, scriptName), 'utf8');
    assert.equal(script.includes('\r'), false, `${scriptName} must use LF line endings`);
  }

  console.log('termux bundle test passed');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
