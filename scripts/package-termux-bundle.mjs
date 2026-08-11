import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDirectory, '..');

export async function packageTermuxBundle({
  projectRoot = defaultProjectRoot,
  bundleDirectory = path.join(projectRoot, 'release', 'termux-server'),
  outputDirectory = path.join(projectRoot, 'release')
} = {}) {
  const rootPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const archiveName = `haptic-relay-termux-server-${rootPackage.version}.tar.gz`;
  const archivePath = path.join(outputDirectory, archiveName);
  const checksumPath = `${archivePath}.sha256`;

  const bundle = await stat(bundleDirectory);
  if (!bundle.isDirectory()) throw new Error('termux bundle directory is required');
  await assertSafeBundleContents(bundleDirectory);

  await mkdir(outputDirectory, { recursive: true });
  await rm(archivePath, { force: true });
  await rm(checksumPath, { force: true });
  await execFileAsync('tar', [
    '-czf',
    archivePath,
    '-C',
    path.dirname(bundleDirectory),
    path.basename(bundleDirectory)
  ], { windowsHide: true });

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  const digest = hash.digest('hex');
  await writeFile(checksumPath, `${digest}  ${archiveName}\n`, 'utf8');

  return { archivePath, checksumPath, sha256: digest };
}

async function assertSafeBundleContents(bundleDirectory, currentDirectory = bundleDirectory) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = path.relative(bundleDirectory, absolutePath).replace(/\\/g, '/');
    const forbiddenName = entry.name === '.env'
      || (entry.name.startsWith('.env.') && entry.name !== '.env.phone.example')
      || entry.name === 'node_modules'
      || entry.name === 'logs'
      || entry.name === 'relay.pid'
      || entry.name === '.git';

    if (forbiddenName || entry.isSymbolicLink()) {
      throw new Error(`forbidden termux bundle entry: ${relativePath}`);
    }
    if (entry.isDirectory()) await assertSafeBundleContents(bundleDirectory, absolutePath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifact = await packageTermuxBundle();
  console.log(`Termux archive created at ${artifact.archivePath}`);
  console.log(`SHA-256: ${artifact.sha256}`);
}
