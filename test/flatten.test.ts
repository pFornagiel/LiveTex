import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { flatten } from '../src/flattenWorker';
import { hasAlpha } from '../src/imageCache';

// Fixture: 64x48 RGBA written by PIL (adaptive PNG row filters), pixel (x,y) = (4x, 5y, 100, 2(x+y)) mod 256.
const fixture = path.join(__dirname, '../../test/fixtures/alpha.png');

test('flatten: alpha PNG composited onto white, exact per pixel', () => {
  assert.equal(hasAlpha(fixture), true);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'll-')), 'flat.png');
  assert.equal(flatten(fixture, out), true);
  assert.equal(hasAlpha(out), false);
  const png = fs.readFileSync(out);
  assert.equal(png[25], 2); // RGB
  const idat = png.subarray(8 + 25 + 8, png.length - 12 - 4);
  const raw = zlib.inflateSync(idat);
  const w = 64, h = 48;
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (1 + 3 * w)], 0);
    for (let x = 0; x < w; x++) {
      const a = (2 * (x + y)) % 256, src = [(4 * x) % 256, (5 * y) % 256, 100];
      for (let c = 0; c < 3; c++) {
        const want = Math.floor((src[c] * a + 255 * (255 - a) + 127) / 255);
        assert.equal(raw[y * (1 + 3 * w) + 1 + 3 * x + c], want, `pixel ${x},${y} channel ${c}`);
      }
    }
  }
});
