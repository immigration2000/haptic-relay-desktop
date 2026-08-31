import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
let viewSource;

try {
  viewSource = await readFile(new URL('../src/ui/views/HardwareOutputLogView.tsx', import.meta.url), 'utf8');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    assert.fail('missing HardwareOutputLogView renderer');
  }
  throw error;
}

const stylesSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const modelSource = await readFile(new URL('../src/ui/output-log-model.mjs', import.meta.url), 'utf8');

assert.match(mainSource, /import\s+HardwareOutputLogView\s+from\s+['"]\.\/ui\/views\/HardwareOutputLogView['"]/);
assert.match(mainSource, /new URLSearchParams\(window\.location\.search\)\.get\(['"]view['"]\)/);
assert.match(mainSource, /HardwareOutputLogView\s*\/>/);
assert.match(viewSource, /const outputLog = window\.hapticOutputLog/);
assert.match(viewSource, /outputLog\.getSession\(\)/);
assert.match(viewSource, /onReset\(/);
assert.match(viewSource, /onAppend\(/);
assert.match(viewSource, /createFrameBatcher/);
assert.match(viewSource, /getVirtualWindow/);
assert.match(viewSource, /setOutputLogFollowing/);
assert.match(viewSource, /canExpandHistory/);
assert.match(viewSource, /aria-rowcount=\{visibleRows\.length \+ 1\}/);
assert.match(viewSource, /aria-rowindex=\{rowIndex\}/);
assert.match(viewSource, /error && !hasRows/);
assert.match(viewSource, /error && hasRows/);
assert.match(viewSource, /scope="col"/);
assert.match(viewSource, /hardware-output-log-caption/);
assert.match(viewSource, /출력 로그를 불러오는 중입니다/);
assert.match(viewSource, /이전 \{[^}]+\}개 생략됨/);
assert.match(viewSource, /최신 로그로 이동/);
assert.match(viewSource, /완료 시각/);
assert.match(viewSource, /명령/);
assert.match(stylesSource, /\.hardware-output-log-view\b/);
assert.match(modelSource, /payload\.sessionId/);
assert.match(modelSource, /MAX_RENDERED_ROWS = 80/);

console.log('hardware output log renderer source checks: passed');
