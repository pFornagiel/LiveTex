import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TexProgram, directEngine, latexmkArgs } from './projectOptions';

const execFileP = promisify(execFile);

export type EngineKind = 'tectonic' | 'latexmk';
export interface Engine { kind: EngineKind; command: string; source: string; binDir?: string }

export const TECTONIC_VERSION = '0.17.0';
// Official release assets (github.com/tectonic-typesetting/tectonic, tag tectonic@0.17.0) with their sha256.
const ASSETS: Record<string, { file: string; sha256: string }> = {
  'linux-x64': { file: 'x86_64-unknown-linux-musl.tar.gz', sha256: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7' },
  'linux-arm64': { file: 'aarch64-unknown-linux-musl.tar.gz', sha256: 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8' },
  'linux-arm': { file: 'arm-unknown-linux-musleabihf.tar.gz', sha256: '882f5213599931992dfb9f7e1157d3015fd9abd505c68c693b3d6dc20967f7eb' },
  'darwin-x64': { file: 'x86_64-apple-darwin.tar.gz', sha256: '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80' },
  'darwin-arm64': { file: 'aarch64-apple-darwin.tar.gz', sha256: 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667' },
  'win32-x64': { file: 'x86_64-pc-windows-msvc.zip', sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f' },
};

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export function managedTectonicPath(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'tectonic', TECTONIC_VERSION, exe('tectonic'));
}

export function tectonicCacheDir(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'TectonicProject', 'Tectonic');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'Tectonic');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'tectonic');
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

export function which(name: string, dirs = (process.env.PATH ?? '').split(path.delimiter)): string | undefined {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

function subdirs(dir: string): string[] {
  try { return fs.readdirSync(dir).map(d => path.join(dir, d)).filter(d => fs.statSync(d).isDirectory()); } catch { return []; }
}

/**
 * TeX distribution bin directories that are often missing from the editor's PATH (GUI-launched editors don't
 * read shell profiles): the user's setting, TinyTeX, TeX Live, MacTeX, MiKTeX.
 */
export function texBinDirs(): string[] {
  const home = os.homedir();
  const configured = vscode.workspace.getConfiguration('livetex').get<string>('texBinPath', '').trim();
  const dirs = configured ? [configured.replace(/^~(?=$|[\\/])/, home)] : [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    dirs.push(path.join(appData, 'TinyTeX', 'bin', 'windows'), path.join(appData, 'TinyTeX', 'bin', 'win32'),
      path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
    for (const y of subdirs('C:\\texlive').sort().reverse()) dirs.push(path.join(y, 'bin', 'windows'), path.join(y, 'bin', 'win64'));
  } else {
    dirs.push(...subdirs(path.join(home, process.platform === 'darwin' ? 'Library/TinyTeX/bin' : '.TinyTeX/bin')));
    dirs.push('/Library/TeX/texbin');
    for (const y of subdirs('/usr/local/texlive').sort().reverse()) dirs.push(...subdirs(path.join(y, 'bin')));
    dirs.push(path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin');
  }
  return dirs;
}

/** Find an engine without installing anything. */
export function resolveEngine(ctx: vscode.ExtensionContext): Engine | undefined {
  const cfg = vscode.workspace.getConfiguration('livetex');
  const pref = cfg.get<string>('engine', 'auto');
  const findTectonic = (): Engine | undefined => {
    const custom = cfg.get<string>('tectonicPath', '').trim();
    if (custom && isExecutable(custom)) return { kind: 'tectonic', command: custom, source: 'livetex.tectonicPath' };
    const managed = managedTectonicPath(ctx);
    if (isExecutable(managed)) return { kind: 'tectonic', command: managed, source: `bundled download (${TECTONIC_VERSION})` };
    const onPath = which('tectonic');
    if (onPath) return { kind: 'tectonic', command: onPath, source: 'PATH' };
    return undefined;
  };
  const findLatexmk = (): Engine | undefined => {
    // Prefer an explicitly configured/known distribution, then PATH.
    const known = which('latexmk', texBinDirs());
    const p = known ?? which('latexmk');
    if (!p) return undefined;
    // latexmk runs pdflatex/biber/bibtex itself, so they must come from the same distribution: put its real bin dir first.
    // (latexmk itself is often a symlink to a Perl script elsewhere, so check where the engines actually are.)
    let binDir = path.dirname(p);
    if (!which('pdflatex', [binDir]) && !which('xelatex', [binDir])) {
      try { binDir = path.dirname(fs.realpathSync(p)); } catch { /* keep symlink dir */ }
    }
    return { kind: 'latexmk', command: p, source: known ? `TeX distribution (${binDir})` : 'PATH', binDir };
  };
  if (pref === 'tectonic') return findTectonic();
  if (pref === 'latexmk') return findLatexmk();
  // An installed TeX distribution behaves like Overleaf (pdfLaTeX, biber, current packages); Tectonic is the zero-install fallback.
  return findLatexmk() ?? findTectonic();
}

/** Downloads the official static Tectonic binary into the extension's private storage. Nothing system-wide is touched. */
export async function installTectonic(ctx: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<string | undefined> {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    vscode.window.showErrorMessage(`No prebuilt Tectonic for ${key}. Install it yourself (https://tectonic-typesetting.github.io) and set livetex.tectonicPath.`);
    return undefined;
  }
  const name = `tectonic-${TECTONIC_VERSION}-${asset.file}`;
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${name}`;
  const target = managedTectonicPath(ctx);
  const dir = path.dirname(target);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading Tectonic ${TECTONIC_VERSION}`, cancellable: false },
    async progress => {
      try {
        log.appendLine(`[install] GET ${url}`);
        progress.report({ message: 'fetching release…' });
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length') ?? 0);
        const chunks: Uint8Array[] = [];
        let got = 0, lastPct = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct > lastPct) { progress.report({ increment: pct - lastPct, message: `${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` }); lastPct = pct; }
          }
        }
        const buf = Buffer.concat(chunks);
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        if (digest !== asset.sha256) throw new Error(`checksum mismatch (got ${digest})`);
        fs.mkdirSync(dir, { recursive: true });
        const archive = path.join(dir, name);
        fs.writeFileSync(archive, buf);
        progress.report({ message: 'extracting…' });
        // bsdtar (macOS, Windows 10+) and GNU tar (Linux) both handle these archives.
        await execFileP('tar', ['-xf', archive, '-C', dir]);
        fs.rmSync(archive, { force: true });
        if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
        if (!isExecutable(target)) throw new Error('binary missing after extraction');
        log.appendLine(`[install] Tectonic installed at ${target}`);
        return target;
      } catch (e) {
        log.appendLine(`[install] failed: ${e}`);
        vscode.window.showErrorMessage(`Downloading Tectonic failed: ${e instanceof Error ? e.message : e}`);
        return undefined;
      }
    },
  );
}

export interface RunSpec { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; logFile?: string }

export function buildCommand(engine: Engine, o: {
  rootName: string; srcDir: string; outDir: string; projectDir: string; fast?: boolean;
  /** From `% !TEX program` in the root document. */
  program?: TexProgram;
  /** The project's latexmkrc, passed to latexmk explicitly (it runs in the shadow dir, where it would not look). */
  latexmkrc?: string;
}): RunSpec {
  const cfg = vscode.workspace.getConfiguration('livetex');
  const shell = cfg.get<boolean>('shellEscape', false);
  if (engine.kind === 'tectonic') {
    const args = ['--synctex', '--keep-logs', '--keep-intermediates', '--color', 'never', '--outdir', o.outDir, '-Z', `search-path=${o.projectDir}`];
    if (o.fast) args.push('--reruns', '0');
    if (cfg.get<boolean>('continueOnErrors', true)) args.push('-Z', 'continue-on-errors');
    if (shell) args.push('-Z', `shell-escape-cwd=${o.projectDir}`);
    args.push(o.rootName);
    return { command: engine.command, args, env: process.env, cwd: o.srcDir };
  }
  const sep = path.delimiter;
  // Shadow dir first (unsaved buffers), then the real project tree, then the TeX defaults (trailing separator).
  const inputs = `${o.srcDir}${sep}${o.projectDir}//${sep}`;
  const userArgs = cfg.get<string[]>('latexmkArgs', []);
  const env: NodeJS.ProcessEnv = { ...process.env, TEXINPUTS: inputs, BIBINPUTS: inputs, BSTINPUTS: inputs };
  if (engine.binDir) env.PATH = `${engine.binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const logFile = path.join(o.outDir, o.rootName.replace(/\.[^.]+$/, '') + '.log');
  if (o.fast) {
    // While typing: one direct engine pass that reuses the .aux/.bbl latexmk left in the output directory.
    // latexmk's dependency analysis alone costs about a second and it often adds passes; saves still use latexmk.
    const tex = directEngine(userArgs, o.program);
    const bin = which(tex, engine.binDir ? [engine.binDir] : undefined) ?? which(tex) ?? tex;
    const args = ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-recorder', `-output-directory=${o.outDir}`];
    if (shell) args.push('-shell-escape');
    args.push(o.rootName);
    return { command: bin, args, cwd: o.srcDir, env, logFile };
  }
  const args = latexmkArgs(userArgs, { program: o.program, latexmkrc: o.latexmkrc, outDir: o.outDir });
  if (shell) args.push('-shell-escape');
  if (cfg.get<boolean>('continueOnErrors', true)) args.push('-f');
  args.push(o.rootName);
  return { command: engine.command, args, cwd: o.srcDir, env, logFile };
}
