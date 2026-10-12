// Minimal SyncTeX reader: enough for forward (source -> PDF) and inverse (PDF -> source) search.
// Coordinates are converted to PDF points (bp) measured from the top-left corner of the page,
// which is what the webview works in after dividing CSS pixels by its zoom.
import * as zlib from 'zlib';

const SP_PER_BP = 65781.76;

export interface SyncRecord {
  kind: string;       // '[' vbox, '(' hbox, 'v'/'h' void boxes, 'x' 'k' 'g' '$' points
  file: number;       // Input tag
  line: number;
  page: number;
  x: number;          // bp from left
  y: number;          // bp from top (baseline)
  w: number;
  h: number;          // height above baseline
  d: number;          // depth below baseline
}

export interface PdfRect { page: number; x: number; y: number; w: number; h: number }
export interface SourceLoc { file: string; line: number }

const BOX_KINDS = new Set(['[', '(', 'v', 'h']);
const RECORD_RE = /^([[(vhxkg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

export class SyncTex {
  readonly files = new Map<number, string>();
  readonly pages = new Map<number, SyncRecord[]>();

  static fromGzip(buf: Buffer, mapPath: (p: string) => string = p => p): SyncTex {
    return SyncTex.parse(zlib.gunzipSync(buf).toString('utf8'), mapPath);
  }

  static parse(text: string, mapPath: (p: string) => string = p => p): SyncTex {
    const st = new SyncTex();
    let unit = 1, mag = 1000, xOff = 0, yOff = 0;
    let page = 0;
    let inContent = false;
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      if (!inContent) {
        if (line.startsWith('Input:')) {
          const m = /^Input:(\d+):(.*)$/.exec(line);
          if (m && m[2]) st.files.set(+m[1], mapPath(m[2]));
        } else if (line.startsWith('Unit:')) unit = +line.slice(5) || 1;
        else if (line.startsWith('Magnification:')) mag = +line.slice(14) || 1000;
        else if (line.startsWith('X Offset:')) xOff = +line.slice(9) || 0;
        else if (line.startsWith('Y Offset:')) yOff = +line.slice(9) || 0;
        else if (line.startsWith('Content:')) inContent = true;
        continue;
      }
      const c = line[0];
      if (c === '{') { page = +line.slice(1); if (!st.pages.has(page)) st.pages.set(page, []); continue; }
      if (c === '}') continue;
      if (line.startsWith('Input:')) {   // inputs may also appear inside the content section
        const m = /^Input:(\d+):(.*)$/.exec(line);
        if (m && m[2]) st.files.set(+m[1], mapPath(m[2]));
        continue;
      }
      if (line.startsWith('Postamble:')) break;
      const m = RECORD_RE.exec(line);
      if (!m || !page) continue;
      const k = (v: string | undefined) => (v === undefined ? 0 : (+v * unit * mag) / 1000 / SP_PER_BP);
      st.pages.get(page)!.push({
        kind: m[1], file: +m[2], line: +m[3], page,
        x: k(m[4]) + xOff / SP_PER_BP, y: k(m[5]) + yOff / SP_PER_BP,
        w: k(m[6]), h: k(m[7]), d: k(m[8]),
      });
    }
    return st;
  }

  private fileTags(file: string): Set<number> {
    const want = normalize(file);
    const tags = new Set<number>();
    for (const [tag, p] of this.files) if (normalize(p) === want) tags.add(tag);
    return tags;
  }

  /** Source line (1-based) -> rectangle in the PDF, or undefined if the file/line produced no output. */
  forward(file: string, line: number): PdfRect | undefined {
    const tags = this.fileTags(file);
    if (!tags.size) return undefined;
    // Collect lines that produced output, then pick the closest one at or after `line`
    // (TeX attributes paragraph content to the line where the paragraph ends), else before.
    const byLine = new Map<number, SyncRecord[]>();
    for (const recs of this.pages.values())
      for (const r of recs)
        if (tags.has(r.file) && r.kind !== '[') {
          let a = byLine.get(r.line);
          if (!a) byLine.set(r.line, (a = []));
          a.push(r);
        }
    if (!byLine.size) return undefined;
    const lines = [...byLine.keys()].sort((a, b) => a - b);
    const target = lines.find(l => l >= line) ?? lines[lines.length - 1];
    const recs = byLine.get(target)!;
    const page = Math.min(...recs.map(r => r.page));
    const onPage = recs.filter(r => r.page === page);
    // Highlight the first visual line this source line produced: the records sharing the topmost baseline.
    const top = Math.min(...onPage.map(r => r.y));
    const first = onPage.filter(r => Math.abs(r.y - top) < 1);
    // Extend over the enclosing text line (smallest hbox on that baseline) for a readable highlight.
    const all = this.pages.get(page)!;
    const textLine = all
      .filter(r => (r.kind === '(' || r.kind === 'h') && r.w > 0 && Math.abs(r.y - top) < 1 && first.some(f => f.x >= r.x - 1 && f.x <= r.x + r.w + 1))
      .sort((a, b) => a.w - b.w)[0];
    let x0 = Infinity, x1 = -Infinity, h = 8, d = 2;
    for (const r of first) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + Math.max(r.w, 0)); h = Math.max(h, r.h); d = Math.max(d, r.d); }
    if (textLine) { x0 = Math.min(x0, textLine.x); x1 = Math.max(x1, textLine.x + textLine.w); h = Math.max(h, textLine.h); d = Math.max(d, textLine.d); }
    return { page, x: x0, y: top - h, w: Math.max(x1 - x0, 4), h: h + d };
  }

  /** PDF point (bp, top-left origin) -> source location. */
  inverse(page: number, x: number, y: number): SourceLoc | undefined {
    const recs = this.pages.get(page);
    if (!recs?.length) return undefined;
    const contains = (r: SyncRecord, pad = 1) =>
      x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - r.h - pad && y <= r.y + r.d + pad;
    // Smallest horizontal box under the pointer is the text line that was clicked.
    let box: SyncRecord | undefined;
    for (const r of recs)
      if ((r.kind === '(' || r.kind === 'h') && r.w > 0 && contains(r))
        if (!box || r.w * (r.h + r.d) < box.w * (box.h + box.d)) box = r;
    // Within that line, the nearest glyph/glue/kern record carries the most precise source line.
    const pool = box
      ? recs.filter(r => !BOX_KINDS.has(r.kind) && Math.abs(r.y - box!.y) < 0.5 && r.x >= box!.x - 1 && r.x <= box!.x + box!.w + 1)
      : recs;
    let best: SyncRecord | undefined = undefined, bestD = Infinity;
    for (const r of pool) {
      const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
      const top = r.y - r.h, bot = r.y + r.d;
      const dy = y < top ? top - y : y > bot ? y - bot : 0;
      const dist = dx + dy * 3;
      if (dist < bestD) { bestD = dist; best = r; }
    }
    const hit = best ?? box;
    if (!hit) return undefined;
    const file = this.files.get(hit.file);
    return file ? { file, line: hit.line } : undefined;
  }
}

function normalize(p: string): string {
  let n = p.replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/\/+/g, '/');
  if (process.platform === 'win32' || process.platform === 'darwin') n = n.toLowerCase();
  return n;
}
