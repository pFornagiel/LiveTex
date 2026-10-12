import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SyncTex } from '../src/synctex';

// Fixture: examples/demo compiled by Tectonic 0.17 with --synctex. Ground truth from `pdftotext -bbox`.
const st = SyncTex.fromGzip(
  fs.readFileSync(path.join(__dirname, '../../test/fixtures/demo.synctex.gz')),
  p => p.replace(/^.*examples\/demo\//, ''),
);

const overlaps = (r: { y: number; h: number }, yMin: number, yMax: number) => r.y < yMax && r.y + r.h > yMin;

test('forward: intro paragraph line lands on the "Overleaf" text line', () => {
  const r = st.forward('chapters/intro.tex', 3)!;
  assert.equal(r.page, 1);
  assert.ok(overlaps(r, 315.4, 326.3), JSON.stringify(r));
  assert.ok(r.h < 16, 'single text line');
});

test('forward: main.tex Gaussian sentence', () => {
  const r = st.forward('main.tex', 26)!;
  assert.equal(r.page, 1);
  assert.ok(overlaps(r, 464.6, 475.5), JSON.stringify(r));
});

test('forward: second page content', () => {
  const r = st.forward('chapters/conclusion.tex', 2)!;
  assert.equal(r.page, 2);
  assert.ok(overlaps(r, 222.3, 236.6), JSON.stringify(r));
});

test('forward: unknown file gives undefined', () => {
  assert.equal(st.forward('nope.tex', 1), undefined);
});

test('inverse: clicking words maps back to their source lines', () => {
  assert.deepEqual(st.inverse(1, 90, 322), { file: 'chapters/intro.tex', line: 3 });
  assert.deepEqual(st.inverse(1, 90, 399), { file: 'chapters/intro.tex', line: 9 });
  assert.deepEqual(st.inverse(1, 110, 470), { file: 'main.tex', line: 26 });
  assert.deepEqual(st.inverse(2, 120, 230), { file: 'chapters/conclusion.tex', line: 2 });
});

test('round trip: forward(inverse(p)) stays on the same page and line band', () => {
  for (const [p, x, y] of [[1, 90, 322], [1, 110, 470], [2, 120, 230]] as const) {
    const loc = st.inverse(p, x, y)!;
    const r = st.forward(loc.file, loc.line)!;
    assert.equal(r.page, p);
    assert.ok(Math.abs(r.y + r.h / 2 - y) < 20, `${loc.file}:${loc.line} -> ${JSON.stringify(r)}`);
  }
});
