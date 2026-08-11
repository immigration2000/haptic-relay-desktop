import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildTermuxBundle } from './build-termux-bundle.mjs';
import { packageTermuxBundle } from './package-termux-bundle.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'haptic-termux-package-'));
const releaseDirectory = path.join(temporaryRoot, 'release');
const bundleDirectory = path.join(releaseDirectory, 'termux-server');
const projectPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const expectedArchiveName = `haptic-relay-termux-server-${projectPackage.version}.tar.gz`;

try {
  await buildTermuxBundle({ projectRoot, outputDirectory: bundleDirectory });
  const artifact = await packageTermuxBundle({
    projectRoot,
    bundleDirectory,
    outputDirectory: releaseDirectory
  });

  assert.equal(path.basename(artifact.archivePath), expectedArchiveName);
  assert.equal(path.basename(artifact.checksumPath), `${expectedArchiveName}.sha256`);

  const archive = await readFile(artifact.archivePath);
  const expectedHash = createHash('sha256').update(archive).digest('hex');
  const checksum = await readFile(artifact.checksumPath, 'utf8');
  assert.equal(checksum, `${expectedHash}  ${path.basename(artifact.archivePath)}\n`);

  const { stdout } = await execFileAsync('tar', ['-tzf', artifact.archivePath], {
    windowsHide: true
  });
  const entries = stdout.split(/\r?\n/).filter(Boolean).map(entry => entry.replace(/\\/g, '/'));

  assert.ok(entries.includes('termux-server/dist-server/server/src/relay-server.js'));
  assert.ok(entries.includes('termux-server/package-lock.json'));
  assert.ok(entries.includes('termux-server/.env.phone.example'));
  assert.ok(entries.includes('termux-server/README.md'));
  assert.equal(entries.some(entry => entry.includes('/node_modules/')), false);
  assert.equal(entries.some(entry => entry.endsWith('/.env')), false);
  assert.equal(entries.some(entry => entry.endsWith('/relay.pid')), false);
  assert.equal(entries.some(entry => entry.includes('/logs/')), false);

  await writeFile(path.join(bundleDirectory, '.env'), 'SECRET=must-not-ship\n', 'utf8');
  await assert.rejects(
    packageTermuxBundle({ projectRoot, bundleDirectory, outputDirectory: releaseDirectory }),
    /forbidden termux bundle entry: \.env/
  );

  console.log('termux package test passed');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
