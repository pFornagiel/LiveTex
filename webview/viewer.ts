// PDF viewer that runs inside the webview. Bundled by esbuild into media/viewer.js.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

declare const acquireVsCodeApi: () => { postMessage(m: unknown): void; setState(s: unknown): void; getState(): any };
declare global { interface Window { __LL: { worker: string; wasm: string; fonts: string; name: string; root: string } } }

const vscode = acquireVsCodeApi();
const cfg = window.__LL;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = $('viewer'), pagesEl = $('pages'), empty = $('empty'), emptyText = $('empty-text');
const statusEl = $('status'), statusText = $('status-text'), problemsBtn = $('problems'), pageInfo = $('pageinfo');
const zoomLabel = $('zoom-label'), installBtn = $('install'), overleafBtn = $('overleaf'), overleafText = $('overleaf-text');

const GAP = 12;          // px between pages (must match CSS)
const MIN_ZOOM = 0.25, MAX_ZOOM = 5;

interface PageSlot { el: HTMLDivElement; canvas?: HTMLCanvasElement; w: number; h: number; renderedKey?: string; task?: RenderTask }

let doc: PDFDocumentProxy | undefined;
let docTask: PDFDocumentLoadingTask | undefined;
let sizes: { w: number; h: number }[] = [];   // pt at scale 1
const slots: PageSlot[] = [];
let fit = true;                                 // fit-to-width mode
let zoom = 1;
let docSeq = 0;
// Timestamps for perf checks from devtools/CDP: when a PDF arrived and when its first pages were on screen.
const stats = { received: [] as number[], shown: [] as number[], stage: 'init' };
(window as any).__llStats = stats;
(window as any).__llDebug = { pdfjs, get doc() { return doc; }, get data() { return latestData; }, worker: () => workerReady };
const saved = vscode.getState() ?? {};
if (typeof saved.zoom === 'number') { zoom = saved.zoom; fit = !!saved.fit; }

// ----- pdf.js worker (webviews can't load a cross-origin worker URL directly, so go through a blob) -----
// One explicit PDFWorker owned by us: documents passed `worker:` never tear it down when they are destroyed.
// (With GlobalWorkerOptions.workerPort every loading task shares *and owns* a cached worker, so destroying
// the previous document killed the worker under the next one and the preview froze.)
const workerReady = (async () => {
  const src = await (await fetch(cfg.worker)).text();
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return pdfjs.PDFWorker.create({ port: new Worker(url, { type: 'module' }) });
})();

// ----- layout -----
function scale(): number {
  if (!fit || !sizes.length) return zoom;
  const maxW = Math.max(...sizes.map(s => s.w));
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (viewer.clientWidth - 2 * GAP) / maxW));
}

/** Where the reader is looking: page index + fraction into it. Survives re-layout. */
function anchor(): { page: number; frac: number } {
  const top = viewer.scrollTop + 1;
  for (let i = 0; i < slots.length; i++) {
    const el = slots[i].el;
    if (el.offsetTop + el.offsetHeight + GAP > top) return { page: i, frac: Math.max(0, (top - el.offsetTop) / el.offsetHeight) };
  }
  return { page: 0, frac: 0 };
}

function layout(keep = anchor()) {
  const s = scale();
  while (slots.length > sizes.length) slots.pop()!.el.remove();
  while (slots.length < sizes.length) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = String(slots.length + 1);
    pagesEl.appendChild(el);
    slots.push({ el, w: 0, h: 0 });
  }
  sizes.forEach((sz, i) => {
    const slot = slots[i];
    slot.w = Math.floor(sz.w * s); slot.h = Math.floor(sz.h * s);
    slot.el.style.width = slot.w + 'px';
    slot.el.style.height = slot.h + 'px';
  });
  if (slots[keep.page]) viewer.scrollTop = slots[keep.page].el.offsetTop + keep.frac * slots[keep.page].el.offsetHeight - 1;
  zoomLabel.textContent = fit ? 'Fit' : Math.round(s * 100) + '%';
  vscode.setState({ zoom, fit, root: cfg.root });
  scheduleRender();
}

function visiblePages(margin = 1): number[] {
  const top = viewer.scrollTop, bottom = top + viewer.clientHeight;
  const res: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const el = slots[i].el;
    if (el.offsetTop + el.offsetHeight >= top && el.offsetTop <= bottom) res.push(i);
  }
  if (!res.length) return res;
  for (let m = 1; m <= margin; m++) {
    if (res[0] - m >= 0) res.unshift(res[0] - m);
    if (res[res.length - 1] + 1 < slots.length) res.push(res[res.length - 1] + 1);
  }
  return res;
}

// Yield to the event loop with a macrotask. Unlike requestAnimationFrame this keeps running when the
// window is not being painted (occluded/unfocused Electron windows stop producing frames), so a fresh
// PDF is always ready the moment the panel is looked at again.
const yieldChannel = new MessageChannel();
const yieldQueue: (() => void)[] = [];
yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
const nextTick = (fn: () => void) => { yieldQueue.push(fn); yieldChannel.port2.postMessage(0); };

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  nextTick(() => { renderQueued = false; void renderVisible(); });
}

async function renderVisible() {
  if (!doc) return;
  const d = doc, seq = docSeq, s = scale(), dpr = window.devicePixelRatio || 1;
  const pages = visiblePages();
  await Promise.all(pages.map(async i => {
    const slot = slots[i];
    const key = `${seq}@${s.toFixed(4)}@${dpr}`;
    if (slot.renderedKey === key) return;
    slot.renderedKey = key;
    slot.task?.cancel();
    let page: PDFPageProxy;
    try { page = await d.getPage(i + 1); } catch { return; }
    if (seq !== docSeq) return;
    const vp = page.getViewport({ scale: s * dpr });
    // Draw off-screen, then swap: the previous bitmap stays visible until the new one is ready (no flicker).
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const task = page.render({ canvas, viewport: vp });
    task.onContinue = (cont: () => void) => nextTick(cont);
    slot.task = task;
    try { await task.promise; } catch { if (slot.renderedKey === key) slot.renderedKey = undefined; return; }
    if (seq !== docSeq || slot.task !== task) return;
    slot.task = undefined;
    if (slot.canvas) slot.canvas.replaceWith(canvas); else slot.el.prepend(canvas);
    slot.canvas = canvas;
  }));
  updatePageInfo();
}

function updatePageInfo() {
  const a = anchor();
  pageInfo.textContent = slots.length ? `${Math.min(a.page + (a.frac > 0.6 ? 2 : 1), slots.length)} / ${slots.length}` : '– / –';
}

// ----- loading a new PDF -----
let loading: Promise<void> = Promise.resolve();
let latestData: Uint8Array | undefined;

function loadPdf(data: Uint8Array) {
  stats.received.push(Date.now());
  latestData = data;
  // Serialize loads; if several PDFs arrive while one is loading, only the newest is rendered.
  // The watchdog guarantees one stuck load can never block every later PDF.
  loading = loading.then(() => Promise.race([load(data), new Promise<void>(r => setTimeout(r, 20000))]));
}

async function load(data: Uint8Array) {
  {
    if (latestData !== data) return;
    stats.stage = 'worker';
    const worker = await workerReady;
    stats.stage = 'parse';
    let next: PDFDocumentProxy;
    const task = pdfjs.getDocument({ data: data.slice(), worker, wasmUrl: cfg.wasm, standardFontDataUrl: cfg.fonts });
    try {
      next = await task.promise;
    } catch (e) {
      setStatus('error', `Could not read PDF: ${e}`);
      return;
    }
    stats.stage = 'sizes';
    const newSizes: { w: number; h: number }[] = [];
    for (let i = 1; i <= next.numPages; i++) {
      const vp = (await next.getPage(i)).getViewport({ scale: 1 });
      newSizes.push({ w: vp.width, h: vp.height });
    }
    const keep = anchor();
    const oldTask = docTask;
    doc = next; docTask = task; docSeq++; sizes = newSizes;
    for (const s of slots) s.renderedKey = undefined;
    empty.classList.add('hidden');
    layout(keep);
    stats.stage = 'render';
    await renderVisible();
    stats.stage = 'idle';
    stats.shown.push(Date.now());
    void oldTask?.destroy();
  }
}

// ----- status -----
function setStatus(state: string, text: string, errors = 0, warnings = 0) {
  statusEl.className = 'st-' + state;
  statusText.textContent = text;
  const n = errors + warnings;
  problemsBtn.classList.toggle('hidden', n === 0);
  problemsBtn.className = n ? `pill ${errors ? 'err' : 'warn'}` : 'pill hidden';
  problemsBtn.textContent = errors ? `${errors} error${errors > 1 ? 's' : ''}${warnings ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`
    : `${warnings} warning${warnings > 1 ? 's' : ''}`;
  if (!doc) {
    empty.classList.remove('hidden');
    empty.classList.toggle('busy', state === 'compiling');
    installBtn.classList.toggle('hidden', state !== 'no-engine');
    emptyText.textContent = state === 'no-engine'
      ? 'No TeX engine found. Download Tectonic (self-contained, no system changes) or set "livetex.engine" to use an existing TeX Live.'
      : state === 'compiling' ? `Compiling ${cfg.name}… (the very first run downloads LaTeX packages and may take a minute)`
      : state === 'error' ? `${text}. Check the Problems panel.` : text;
  }
}

// ----- Overleaf sync button (only for documents in a linked Overleaf project) -----
function setOverleaf(b?: { state: string; label: string; tooltip: string }) {
  overleafBtn.classList.toggle('hidden', !b);
  if (!b) return;
  overleafBtn.className = 'ol-' + b.state;
  overleafText.textContent = b.state === 'synced' ? '' : b.label;
  overleafBtn.title = b.tooltip;
}

// ----- SyncTeX highlight -----
function highlight(m: { page: number; x: number; y: number; w: number; h: number; reveal: boolean }) {
  const slot = slots[m.page - 1];
  if (!slot) return;
  const s = scale(), pad = 2;
  document.querySelectorAll('.hl').forEach(e => e.remove());
  const hl = document.createElement('div');
  hl.className = 'hl';
  Object.assign(hl.style, {
    left: m.x * s - pad + 'px', top: m.y * s - pad + 'px',
    width: m.w * s + 2 * pad + 'px', height: m.h * s + 2 * pad + 'px',
  });
  slot.el.appendChild(hl);
  setTimeout(() => hl.classList.add('fade'), 1400);
  setTimeout(() => hl.remove(), 2600);
  const y = slot.el.offsetTop + m.y * s;
  const inView = y > viewer.scrollTop + 30 && y < viewer.scrollTop + viewer.clientHeight - 30;
  if (m.reveal || !inView) viewer.scrollTo({ top: y - viewer.clientHeight / 3, behavior: inView ? 'smooth' : 'auto' });
}

// ----- input -----
function setZoom(z: number, f = false) {
  const a = anchor();
  fit = f;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  layout(a);
}

$('zoom-in').onclick = () => setZoom(scale() * 1.2);
$('zoom-out').onclick = () => setZoom(scale() / 1.2);
zoomLabel.onclick = () => setZoom(scale(), true);
$('compile').onclick = () => vscode.postMessage({ type: 'compile' });
$('export').onclick = () => vscode.postMessage({ type: 'export' });
statusEl.onclick = () => vscode.postMessage({ type: 'showLog' });
problemsBtn.onclick = () => vscode.postMessage({ type: 'problems' });
overleafBtn.onclick = () => vscode.postMessage({ type: 'overleafSync' });
installBtn.onclick = () => vscode.postMessage({ type: 'installEngine' });

viewer.addEventListener('scroll', () => { scheduleRender(); updatePageInfo(); }, { passive: true });
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(scale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(scale() * 1.2); }
  else if (e.key === '-') { e.preventDefault(); setZoom(scale() / 1.2); }
  else if (e.key === '0') { e.preventDefault(); setZoom(1, true); }
});
let resizeTimer: number | undefined;
new ResizeObserver(() => {
  if (!fit) return;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => layout(), 60);
}).observe(viewer);

// Double-click (or Ctrl/Cmd+click) a spot in the PDF to jump to its source.
function inverse(e: MouseEvent) {
  const pageEl = (e.target as HTMLElement).closest('.page') as HTMLElement | null;
  if (!pageEl) return;
  const r = pageEl.getBoundingClientRect(), s = scale();
  vscode.postMessage({ type: 'inverse', page: +pageEl.dataset.page!, x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s });
}
pagesEl.addEventListener('dblclick', e => { window.getSelection()?.removeAllRanges(); inverse(e); });
pagesEl.addEventListener('click', e => { if (e.ctrlKey || e.metaKey) inverse(e); });

window.addEventListener('message', ev => {
  const m = ev.data;
  switch (m.type) {
    case 'pdf': {
      const d = m.data;
      const bytes = d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(Object.values(d ?? {}) as number[]);
      if (bytes.byteLength) loadPdf(bytes); else setStatus('error', 'Received an empty PDF');
      break;
    }
    case 'status': setStatus(m.state, m.text, m.errors, m.warnings); break;
    case 'highlight': highlight(m); break;
    case 'config': document.body.classList.toggle('invert', !!m.invertDark); break;
    case 'overleaf': setOverleaf(m.badge); break;
  }
});

vscode.setState({ zoom, fit, root: cfg.root });
vscode.postMessage({ type: 'ready' });
