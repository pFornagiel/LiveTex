import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { Engine, EngineKind, buildCommand } from './engines';
import { parseTectonic, parseTexLog, tectonicCompatIssues, Problem } from './logParser';
import { SyncTex } from './synctex';
import { PreviewImageCache } from './imageCache';
import { findLatexmkrc, texProgram } from './projectOptions';

export type BuildReason = 'open' | 'change' | 'save' | 'manual' | 'external';

export interface BuildResult {
  ok: boolean;               // a fresh PDF was produced
  pdf?: Uint8Array;
  pdfPath?: string;
  problems: Problem[];
  errors: number;
  warnings: number;
  durationMs: number;
  clean: boolean;            // compiled exactly what is on disk (no unsaved buffers)
  reason: BuildReason;
  preview: boolean;          // built with preview-only shortcuts (flattened images): not for writing to disk
  engine?: EngineKind;
  fatal?: string;            // engine could not run at all
}

// Auxiliary files carried over from the previous build so a single TeX pass still resolves references.
const SEED_EXT = /\.(aux|bbl|toc|lof|lot|out|nav|snm|vrb|ind|gls|glo|acr|brf|thm|loa|lol)$/i;

// Files whose unsaved contents are worth mirroring into the shadow dir.
const MIRROR_EXT = /\.(tex|ltx|latex|sty|cls|bib|bst|bbx|cbx|def|cfg|clo|dtx|tikz|pgf|txt|csv|dat)$/i;

/** Compiles one root document; keeps at most one build running plus one queued. */
export class RootBuilder implements vscode.Disposable {
  readonly projectDir: string;
  readonly rootName: string;
  readonly srcDir: string;
  readonly outDir: string;
  synctex?: SyncTex;
  lastPdf?: Uint8Array;
  lastResult?: BuildResult;

  private timer?: NodeJS.Timeout;
  private timerReason?: BuildReason;
  private proc?: ChildProcess;
  private running = false;
  private pending?: BuildReason;
  private disposed = false;

  private readonly _onStart = new vscode.EventEmitter<BuildReason>();
  private readonly _onDone = new vscode.EventEmitter<BuildResult>();
  readonly onStart = this._onStart.event;
  readonly onDone = this._onDone.event;

  constructor(
    readonly root: vscode.Uri,
    storageDir: string,
    private readonly getEngine: () => Promise<Engine | undefined>,
    private readonly log: vscode.OutputChannel,
    private readonly images?: PreviewImageCache,
  ) {
    this.projectDir = path.dirname(root.fsPath);
    this.rootName = path.basename(root.fsPath);
    const id = crypto.createHash('sha1').update(root.fsPath).digest('hex').slice(0, 12);
    const work = path.join(storageDir, 'builds', id);
    this.srcDir = path.join(work, 'src');
    this.outDir = path.join(work, 'out');
    this.prepareImages();
  }

  /** Convert transparent PNGs in the background; rebuild the preview once faster copies are available. */
  prepareImages() {
    if (!this.images || !vscode.workspace.getConfiguration('livetex').get('previewImageOptimization', true)) return;
    const t0 = Date.now();
    void this.images.prepare(this.projectDir).then(n => {
      if (!n || this.disposed) return;
      this.log.appendLine(`[images] flattened ${n} transparent PNG(s) for faster previews in ${Date.now() - t0} ms`);
      this.request('external', 0);
    });
  }

  get stem() { return this.rootName.replace(/\.[^.]+$/, ''); }
  get busy() { return this.running || !!this.timer; }

  /** Ask for a build after `delayMs` (debounced; bursts of requests collapse into one build). */
  request(reason: BuildReason, delayMs = 0) {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerReason = stronger(this.timerReason, reason);
    this.timer = setTimeout(() => {
      const r = this.timerReason!;
      this.timer = undefined;
      this.timerReason = undefined;
      this.kick(r);
    }, delayMs);
  }

  private kick(reason: BuildReason) {
    if (this.running) { this.pending = stronger(this.pending, reason); return; }
    void this.run(reason);
  }

  /** Map a path the engine saw (possibly inside the shadow dir) back to the user's file. */
  toRealPath = (p: string): string => {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.srcDir, p);
    const rel = path.relative(this.srcDir, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(this.projectDir, rel);
    return path.normalize(abs);
  };

  /** Like toRealPath, but also resolves TeX-style names without extension (`chapters/intro` -> `chapters/intro.tex`). */
  resolveSource(p: string): string {
    const real = this.toRealPath(p);
    if (fs.existsSync(real) || path.extname(real)) return real;
    return fs.existsSync(real + '.tex') ? real + '.tex' : real;
  }

  /** Write the root + every unsaved buffer under the project dir into a fresh shadow tree. */
  private prepareShadow(seed: boolean, flattenImages: boolean): boolean {
    fs.rmSync(this.srcDir, { recursive: true, force: true });
    fs.mkdirSync(this.srcDir, { recursive: true });
    fs.mkdirSync(this.outDir, { recursive: true });
    if (seed) copyMatching(this.outDir, this.srcDir, SEED_EXT);
    let clean = true;
    const docs = new Map(vscode.workspace.textDocuments.map(d => [d.uri.fsPath, d] as const));
    const rootDoc = docs.get(this.root.fsPath);
    const rootText = rootDoc ? rootDoc.getText() : fs.readFileSync(this.root.fsPath, 'utf8');
    if (rootDoc?.isDirty) clean = false;
    fs.writeFileSync(path.join(this.srcDir, this.rootName), rootText);
    for (const d of docs.values()) {
      if (!d.isDirty || d.uri.scheme !== 'file' || d.uri.fsPath === this.root.fsPath) continue;
      const rel = path.relative(this.projectDir, d.uri.fsPath);
      if (rel.startsWith('..') || path.isAbsolute(rel) || !MIRROR_EXT.test(rel)) continue;
      const dest = path.join(this.srcDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, d.getText());
      clean = false;
    }
    if (flattenImages) this.images?.linkInto(this.projectDir, this.srcDir);
    return clean;
  }

  private async run(reason: BuildReason): Promise<void> {
    this.running = true;
    this._onStart.fire(reason);
    const t0 = Date.now();
    let result: BuildResult;
    try {
      result = await this.compile(reason, t0);
    } catch (e) {
      result = { ok: false, problems: [], errors: 1, warnings: 0, durationMs: Date.now() - t0, clean: false, reason, preview: false, fatal: String(e) };
    }
    this.running = false;
    if (this.disposed) return;
    this.lastResult = result;
    this._onDone.fire(result);
    if (this.pending) {
      const next = this.pending;
      this.pending = undefined;
      void this.run(next);
    }
  }

  private async compile(reason: BuildReason, t0: number): Promise<BuildResult> {
    const engine = await this.getEngine();
    if (!engine) {
      return { ok: false, problems: [], errors: 0, warnings: 0, durationMs: 0, clean: false, reason, preview: false, fatal: 'no-engine' };
    }
    const cfg = vscode.workspace.getConfiguration('livetex');
    // A project latexmkrc is Perl that latexmk executes, so only in trusted workspaces (as latexmk itself would).
    const latexmkrc = engine.kind === 'latexmk' && vscode.workspace.isTrusted ? findLatexmkrc(this.projectDir) : undefined;
    // While typing: a single TeX pass reusing the previous build's .aux/.bbl (Tectonic: seeded into the shadow dir;
    // latexmk: the engine is run directly in the output dir). Saves, opens and manual builds do the full rerun logic.
    // A latexmkrc can change how the engine must be called, which a direct pass would ignore: always use latexmk then.
    const fast = reason === 'change' && cfg.get('fastPreview', true)
      && (engine.kind === 'tectonic' || (!latexmkrc && fs.existsSync(path.join(this.outDir, this.stem + '.aux'))));
    // Preview-only builds may use flattened images; saves and manual builds (what lands on disk) use the originals.
    const preview = reason !== 'save' && reason !== 'manual' && !!this.images && cfg.get('previewImageOptimization', true);
    const clean = this.prepareShadow(fast && engine.kind === 'tectonic', preview);
    const pdfPath = path.join(this.outDir, this.stem + '.pdf');
    const before = mtime(pdfPath);
    const rootText = fs.readFileSync(path.join(this.srcDir, this.rootName), 'utf8');
    const magic = texProgram(rootText);
    const spec = buildCommand(engine, {
      rootName: this.rootName, srcDir: this.srcDir, outDir: this.outDir, projectDir: this.projectDir, fast,
      program: magic?.program, latexmkrc,
    });
    this.log.appendLine(`\n[build ${new Date().toLocaleTimeString()}] (${reason}) ${spec.command} ${spec.args.join(' ')}`);

    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const p = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
      this.proc = p;
      let so = '', se = '';
      let downloading = false;
      p.stdout.on('data', b => { so += b; });
      p.stderr.on('data', b => {
        const s = b.toString();
        se += s;
        for (const line of s.split('\n')) {
          if (!line || /^Fontconfig/.test(line)) continue;
          this.log.appendLine(line);
          if (!downloading && /downloading/.test(line)) {
            downloading = true;
            vscode.window.setStatusBarMessage('$(cloud-download) LiveTex: fetching TeX packages (first use only)…', 8000);
          }
        }
      });
      p.on('error', err => resolve({ code: -1, stdout: so, stderr: se + `\nerror: ${err.message}` }));
      p.on('close', c => resolve({ code: c, stdout: so, stderr: se }));
    });
    this.proc = undefined;
    const texMs = Date.now() - t0;
    // The full TeX transcript is in the .log file; keep the output channel readable.
    if (stdout.trim()) this.log.appendLine(stdout.trimEnd().split('\n').slice(-15).join('\n'));

    let problems: Problem[];
    if (engine.kind === 'tectonic') {
      problems = parseTectonic(stderr);
      problems.push(...tectonicCompatIssues(rootText, stderr));
    } else {
      const logText = spec.logFile && fs.existsSync(spec.logFile) ? fs.readFileSync(spec.logFile, 'utf8') : stdout;
      problems = parseTexLog(logText);
    }
    if (magic && !magic.program) {
      problems.push({ file: this.rootName, line: magic.line, severity: 'warning',
        message: `% !TEX program = ${magic.raw} is not supported here (use pdflatex, xelatex or lualatex); compiled with the default engine.` });
    } else if (magic?.program && engine.kind === 'tectonic' && magic.program !== 'xelatex') {
      problems.push({ file: this.rootName, line: magic.line, severity: 'warning',
        message: `This document asks for ${magic.program} (% !TEX program), but Tectonic only runs XeLaTeX. Install a TeX distribution (e.g. TinyTeX) to compile it as intended.` });
    }
    problems = problems.map(p => ({ ...p, file: p.file ? this.resolveSource(p.file) : this.root.fsPath }));

    const fresh = mtime(pdfPath) > before;
    // latexmk skips work when nothing changed ("All targets are up-to-date"); the existing PDF is then current.
    const upToDate = !fresh && code === 0 && before > 0;
    let pdf: Uint8Array | undefined;
    if (fresh || (upToDate && !this.lastPdf)) {
      pdf = fs.readFileSync(pdfPath);
      this.lastPdf = pdf;
      const st = path.join(this.outDir, this.stem + '.synctex.gz');
      try { this.synctex = SyncTex.fromGzip(fs.readFileSync(st), this.toRealPath); }
      catch (e) { this.log.appendLine(`[synctex] ${e}`); }
    }
    const durationMs = Date.now() - t0;
    const errors = problems.filter(p => p.severity === 'error').length;
    const warnings = problems.length - errors;
    this.log.appendLine(`[build] exit ${code}, ${fresh ? 'PDF updated' : upToDate ? 'up to date' : 'no new PDF'}, ${errors} error(s), ${warnings} warning(s), ${durationMs} ms (engine ${texMs} ms)`);
    const ok = fresh || upToDate;
    return {
      ok, pdf, pdfPath: ok ? pdfPath : undefined, problems, errors, warnings, durationMs, clean, reason, preview, engine: engine.kind,
      fatal: code === -1 ? stderr.split('\n').filter(Boolean).pop() : undefined,
    };
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.proc?.kill();
    this._onStart.dispose();
    this._onDone.dispose();
  }
}

function copyMatching(from: string, to: string, re: RegExp) {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const src = path.join(from, e.name), dest = path.join(to, e.name);
    if (e.isDirectory()) copyMatching(src, dest, re);
    else if (re.test(e.name)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(src, dest); }
  }
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

const RANK: Record<BuildReason, number> = { change: 0, external: 1, open: 2, save: 3, manual: 4 };
function stronger(a: BuildReason | undefined, b: BuildReason): BuildReason {
  return !a || RANK[b] >= RANK[a] ? b : a;
}
