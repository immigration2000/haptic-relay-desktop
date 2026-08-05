import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const assetReferences = [...html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);

assert.ok(assetReferences.length > 0, 'missing built renderer asset references');
assert.ok(assetReferences.every(reference => !reference.startsWith('/')), 'root-absolute renderer asset reference');
assert.ok(assetReferences.some(reference => reference.startsWith('./assets/')), 'missing relative renderer asset reference');

console.log('renderer build asset paths: relative');
