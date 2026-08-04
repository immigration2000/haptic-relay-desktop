import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [mainSource, preloadSource] = await Promise.all([
  readFile(new URL('../dist-electron/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-electron/preload.cjs', import.meta.url), 'utf8')
]);

assert.match(mainSource, /preload:\s*path\.join\(__dirname, ['"]preload\.cjs['"]\)/);
assert.match(preloadSource, /require\(['"]electron['"]\)/);
assert.doesNotMatch(preloadSource, /^\s*import\s/m);

console.log('sandbox preload format: commonjs');
