import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const checks = [];

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function listFiles(relativePath, predicate) {
  const base = path.join(root, relativePath);
  if (!fs.existsSync(base)) {
    return [];
  }

  const found = [];
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (!predicate || predicate(fullPath)) {
        found.push(path.relative(root, fullPath));
      }
    }
  }
  return found;
}

function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

let packageJson;
try {
  packageJson = readJson('package.json');
  check('package.json parses', true);
} catch (error) {
  check('package.json parses', false, error.message);
}

if (packageJson) {
  check('electron:pack script exists', packageJson.scripts?.['electron:pack'] === 'npm run build && electron-builder --dir');
  check('electron:build script targets NSIS', packageJson.scripts?.['electron:build'] === 'npm run build && electron-builder --win nsis');
  check('ASAR enabled', packageJson.build?.asar === true);
  check('SerialPort bindings unpacked from ASAR', Array.isArray(packageJson.build?.asarUnpack)
    && packageJson.build.asarUnpack.includes('node_modules/@serialport/bindings-cpp/**/*.node')
    && packageJson.build.asarUnpack.includes('node_modules/@serialport/bindings-cpp/prebuilds/**/*'));
  check('Windows target is NSIS', Array.isArray(packageJson.build?.win?.target)
    && packageJson.build.win.target.includes('nsis'));
}

check('Electron package installed', exists('node_modules/electron/package.json'));
check('Electron runtime binary installed', exists('node_modules/electron/dist/electron.exe')
  || exists('node_modules/electron/electron.exe'), 'Run npm install without --ignore-scripts on the release machine.');

const serialportNativeFiles = listFiles('node_modules/@serialport/bindings-cpp', (filePath) => filePath.endsWith('.node'));
check('SerialPort native binding present', serialportNativeFiles.length > 0,
  serialportNativeFiles.length > 0 ? serialportNativeFiles.slice(0, 3).join(', ') : 'Run npm install on the release machine.');

check('renderer build output exists', exists('dist/index.html'), 'Run npm.cmd run build before packaging.');
check('Electron main build output exists', exists('dist-electron/main.js'), 'Run npm.cmd run build:electron.');

const appExe = exists('release/win-unpacked/Haptic Relay.exe');
const appAsar = exists('release/win-unpacked/resources/app.asar');
const unpackedDir = exists('release/win-unpacked/resources/app.asar.unpacked');
const unpackedSerialportFiles = listFiles('release/win-unpacked/resources/app.asar.unpacked', (filePath) => filePath.endsWith('.node'));
const expectedInstallerName = packageJson
  ? `${packageJson.build?.productName ?? packageJson.name}-${packageJson.version}-win-${process.arch}.exe`
  : undefined;
const expectedInstallerPath = expectedInstallerName ? path.join('release', expectedInstallerName) : undefined;

check('unpacked app executable exists', appExe, 'Run npm.cmd run electron:pack.');
check('app.asar exists', appAsar, 'Run npm.cmd run electron:pack.');
check('app.asar.unpacked exists', unpackedDir, 'SerialPort native files must stay outside app.asar.');
check('unpacked SerialPort native binding exists', unpackedSerialportFiles.length > 0,
  unpackedSerialportFiles.length > 0 ? unpackedSerialportFiles.slice(0, 3).join(', ') : 'Check asarUnpack after packaging.');
check('current-version Windows installer exists', Boolean(expectedInstallerPath && exists(expectedInstallerPath)),
  expectedInstallerPath ?? 'package metadata unavailable');

const failed = checks.filter((item) => !item.passed);

console.log(`Release check for ${packageJson?.build?.productName ?? packageJson?.name ?? 'app'}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log('');

for (const item of checks) {
  const prefix = item.passed ? '[OK]  ' : '[FAIL]';
  const suffix = item.detail ? ` - ${item.detail}` : '';
  console.log(`${prefix} ${item.name}${suffix}`);
}

console.log('');
if (failed.length > 0) {
  console.error(`${failed.length} release check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('All release checks passed.');
}
