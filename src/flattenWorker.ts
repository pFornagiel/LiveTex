// Worker thread: flattens a PNG with an alpha channel onto white and writes it as plain RGB/gray.
// pdfTeX and xdvipdfmx can embed such PNGs by copying their compressed data, whereas images with alpha
// are decoded, split into colour + soft mask and re-compressed on every single compile.
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as zlib from 'zlib';

interface Job { id: number; src: string; dst: string }

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function flatten(src: string, dst: string): boolean {
  const data = fs.readFileSync(src);
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= data.length) {
    const len = data.readUInt32BE(pos);
    const t = data.toString('latin1', pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (t === 'IDAT') idat.push(body);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  const channels = type === 6 ? 4 : type === 4 ? 2 : 0;
  if (!channels || depth !== 8 || interlace !== 0) return false;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = w * bpp, outCh = channels - 1;
  const out = Buffer.alloc(h * (1 + w * outCh));
  let prev = Buffer.alloc(stride), line = Buffer.alloc(stride);
  for (let y = 0, i = 0, o = 0; y < h; y++) {
    const f = raw[i++];
    for (let x = 0; x < stride; x++) {
      const v = raw[i++];
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let p = v;
      if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[x] = p & 255;
    }
    out[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const al = line[x * bpp + outCh];
      for (let k = 0; k < outCh; k++) out[o++] = (line[x * bpp + k] * al + 255 * (255 - al) + 127) / 255 | 0;
    }
    [prev, line] = [line, prev];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = outCh === 3 ? 2 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, png);
  fs.renameSync(tmp, dst);
  return true;
}

parentPort?.on('message', (job: Job) => {
  try { parentPort!.postMessage({ id: job.id, ok: flatten(job.src, job.dst) }); }
  catch (e) { parentPort!.postMessage({ id: job.id, ok: false, error: String(e) }); }
});
