import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDirectory, '..');

export async function buildTermuxBundle({
  projectRoot = defaultProjectRoot,
  outputDirectory = path.join(projectRoot, 'release', 'termux-server')
} = {}) {
  const serverBuild = path.join(projectRoot, 'dist-server');
  const templates = path.join(projectRoot, 'deploy', 'termux');
  const rootPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const socketIoVersion = rootPackage.dependencies?.['socket.io'];

  if (!socketIoVersion) throw new Error('socket.io dependency is required');

  const runtimePackage = {
    name: 'haptic-relay-termux-server',
    version: rootPackage.version,
    private: true,
    type: 'module',
    scripts: {
      start: 'node --env-file=.env dist-server/server/src/relay-server.js'
    },
    dependencies: {
      'socket.io': socketIoVersion
    }
  };

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await cp(serverBuild, path.join(outputDirectory, 'dist-server'), { recursive: true });
  await cp(templates, outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, 'package.json'),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
    'utf8'
  );

  return outputDirectory;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDirectory = await buildTermuxBundle();
  console.log(`Termux relay bundle created at ${outputDirectory}`);
}
