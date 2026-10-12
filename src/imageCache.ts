import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Worker } from 'worker_threads';

const MIN_BYTES = 16 * 1024;    // tiny images compile fast enough as they are
const MAX_DEPTH = 6;
const SKIP_DIR = /^(\.|node_modules$|__pycache__$)/;

/** True for 8-bit, non-interlaced PNGs with an alpha channel: the ones TeX re-encodes on every compile. */
export function hasAlpha(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(29);
    if (fs.readSync(fd, b, 0, 29, 0) < 29 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return false;
    return (b[25] === 6 || b[25] === 4) && b[24] === 8 && b[28] === 0;
  } finally { fs.closeSync(fd); }
}

/**
 * Flattened (alpha-free) copies of a project's transparent PNGs, used only for live-preview builds.
 * Conversions run in a worker thread and are cached by path + size + mtime, so each image is converted once.
 */
export class PreviewImageCache {
  private readonly ready = new Map<string, string>();      // project file -> cached flattened file
  private readonly pending = new Map<string, Promise<void>>();
  private worker?: Worker;
  private jobs = new Map<number, (ok: boolean) => void>();
  private nextId = 0;

  constructor(private readonly cacheDir: string, private readonly workerScript: string, private readonly log: (s: string) => void) {}

  private cachePath(file: string, st: fs.Stats): string {
    const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    return path.join(this.cacheDir, `${key}.png`);
  }

  private run(src: string, dst: string): Promise<boolean> {
    if (!this.worker) {
      this.worker = new Worker(this.workerScript);
      this.worker.on('message', (m: { id: number; ok: boolean; error?: string }) => {
        if (m.error) this.log(`[images] ${m.error}`);
        this.jobs.get(m.id)?.(m.ok);
        this.jobs.delete(m.id);
      });
      this.worker.on('error', e => { this.log(`[images] worker error: ${e}`); for (const r of this.jobs.values()) r(false); this.jobs.clear(); this.worker = undefined; });
      this.worker.unref();
    }
    const id = ++this.nextId;
    return new Promise(resolve => { this.jobs.set(id, resolve); this.worker!.postMessage({ id, src, dst }); });
  }

  /** Find transparent PNGs under `dir` and convert the ones not cached yet. Resolves when all are done. */
  async prepare(dir: string): Promise<number> {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const todo: Promise<void>[] = [];
    let converted = 0;
    const walk = (d: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < MAX_DEPTH && !SKIP_DIR.test(e.name)) walk(p, depth + 1); continue; }
        if (!/\.png$/i.test(e.name)) continue;
        let st: fs.Stats;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.size < MIN_BYTES) continue;
        const dst = this.cachePath(p, st);
        if (fs.existsSync(dst)) { this.ready.set(p, dst); continue; }
        this.ready.delete(p);
        if (this.pending.has(dst)) { todo.push(this.pending.get(dst)!); continue; }
        try { if (!hasAlpha(p)) continue; } catch { continue; }
        const job = this.run(p, dst).then(ok => {
          this.pending.delete(dst);
          if (ok) { this.ready.set(p, dst); converted++; }
        });
        this.pending.set(dst, job);
        todo.push(job);
      }
    };
    walk(dir, 0);
    await Promise.all(todo);
    return converted;
  }

  /** Symlink (or copy) every ready flattened image into the shadow tree at the same relative path. */
  linkInto(projectDir: string, srcDir: string): number {
    let n = 0;
    for (const [file, cached] of this.ready) {
      const rel = path.relative(projectDir, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const dest = path.join(srcDir, rel);
      if (fs.existsSync(dest)) continue; // an unsaved/mirrored file wins
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try { fs.symlinkSync(cached, dest); } catch { fs.copyFileSync(cached, dest); }
        n++;
      } catch { /* ignore: TeX falls back to the original */ }
    }
    return n;
  }

  dispose() { void this.worker?.terminate(); }
}
