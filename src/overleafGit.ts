// Overleaf sync over Git (Overleaf's git bridge: https://git.overleaf.com/<project id>). No vscode imports, so it is
// testable with plain node. Safety rules: never force-push, never reset/clean/checkout over the working tree, and
// commit every local change before merging, so a merge can always be undone with `git merge --abort`.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_GIT_HOST = 'https://git.overleaf.com';

/** Turn whatever the user pasted (editor URL, git URL, `git clone …` line, bare id) into a clone URL. */
export function parseProjectInput(input: string, gitHost = DEFAULT_GIT_HOST): { url: string; id?: string } | undefined {
  const s = input.trim().replace(/^git\s+clone\s+/, '').trim();
  if (!s) return undefined;
  const editor = /^https?:\/\/(?:www\.)?overleaf\.com\/(?:project|read)\/([0-9a-f]{24})\b/i.exec(s);
  if (editor) return { url: `${gitHost}/${editor[1]}`, id: editor[1] };
  if (/^[0-9a-f]{24}$/i.test(s) || /^\d{5,}$/.test(s)) return { url: `${gitHost}/${s}`, id: s };
  if (/^https?:\/\/\S+$/i.test(s)) {
    const url = s.replace(/\/+$/, '').replace(/^(https?:\/\/)[^@/]+@/i, '$1'); // credentials never go into the remote URL
    return { url, id: /\/([0-9a-f]{24}|\d{5,})(?:\.git)?$/i.exec(url)?.[1] };
  }
  return undefined;
}

/** Project page on overleaf.com for a git.overleaf.com remote. */
export function projectPageUrl(remoteUrl: string): string | undefined {
  const m = /^https?:\/\/git\.overleaf\.com\/([0-9a-f]{24}|\d{5,})/i.exec(remoteUrl);
  return m ? `https://www.overleaf.com/project/${m[1]}` : undefined;
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * GIT_ASKPASS helper. Git calls it with the prompt as $1; the token travels in this process's environment only, so it
 * never appears in argv, in .git/config or in a credential store.
 */
export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' "\${LIVETEX_GIT_USER:-git}" ;;
  *) printf '%s\\n' "$LIVETEX_GIT_TOKEN" ;;
esac
`;

export function writeAskpass(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'overleaf-askpass.sh');
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== ASKPASS_SCRIPT) fs.writeFileSync(p, ASKPASS_SCRIPT, { mode: 0o700 });
  fs.chmodSync(p, 0o700);
  return p;
}

export interface RunResult { code: number; stdout: string; stderr: string }

export class GitError extends Error {
  constructor(readonly args: string[], readonly result: RunResult) {
    super(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  }
  get authFailed(): boolean {
    return /Authentication failed|could not read (Username|Password)|terminal prompts disabled|\b40[13]\b|invalid credentials/i.test(this.result.stderr);
  }
}

export interface GitOptions {
  gitPath?: string;
  askpass?: string;
  token?: () => Promise<string | undefined>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export class Git {
  constructor(readonly cwd: string, private readonly opts: GitOptions = {}) {}

  with(cwd: string): Git { return new Git(cwd, this.opts); }

  /** Run git; `network` commands get the askpass helper and the token. Never throws for a non-zero exit. */
  async exec(args: string[], network = false): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...this.opts.env,
      GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GCM_INTERACTIVE: 'never',
    };
    // Credential helpers are disabled so the token is neither stored nor replaced by a stale saved password.
    const pre = ['-c', 'credential.helper=', '-c', 'core.quotePath=false'];
    if (network && this.opts.askpass) {
      env.GIT_ASKPASS = this.opts.askpass;
      env.SSH_ASKPASS = this.opts.askpass;
      env.LIVETEX_GIT_TOKEN = (await this.opts.token?.()) ?? '';
    }
    this.opts.log?.(`[overleaf] git ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const p = spawn(this.opts.gitPath || 'git', [...pre, ...args], { cwd: this.cwd, env, windowsHide: true });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => stdout += d);
      p.stderr.on('data', d => stderr += d);
      p.on('error', reject);
      p.on('close', code => {
        if (code && stderr.trim()) this.opts.log?.(stderr.trim().replace(/^/gm, '  '));
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  async run(args: string[], network = false): Promise<string> {
    const r = await this.exec(args, network);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout;
  }

  async ok(args: string[]): Promise<boolean> { return (await this.exec(args)).code === 0; }
}

export interface Remote { name: string; url: string }

/** The repository's Overleaf remote: one named `overleaf`, else any remote pointing at an Overleaf host. */
export async function findRemote(git: Git): Promise<Remote | undefined> {
  const r = await git.exec(['remote', '-v']);
  if (r.code !== 0) return undefined;
  const remotes = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) remotes.set(m[1], m[2]);
  }
  if (remotes.has('overleaf')) return { name: 'overleaf', url: remotes.get('overleaf')! };
  for (const [name, url] of remotes) if (/overleaf/i.test(hostOf(url))) return { name, url };
  return undefined;
}

export async function topLevel(git: Git): Promise<string | undefined> {
  const r = await git.exec(['rev-parse', '--show-toplevel']);
  return r.code === 0 ? path.resolve(r.stdout.trim()) : undefined;
}

/** Overleaf's only branch: `main` for new projects, `master` for old clones. Needs a prior fetch. */
export async function remoteBranch(git: Git, remote: string): Promise<string | undefined> {
  for (const b of ['main', 'master']) if (await git.ok(['rev-parse', '-q', '--verify', `refs/remotes/${remote}/${b}`])) return b;
  return undefined;
}

// Build output that must not be uploaded. Written to .git/info/exclude (not .gitignore) so the Overleaf project stays
// untouched. Only affects untracked files: anything Overleaf already has stays tracked.
const EXCLUDE_BEGIN = '# >>> livetex: local build output, not synced to Overleaf';
const EXCLUDE_END = '# <<< livetex';
const EXCLUDE_PATTERNS = [
  '*.aux', '*.bbl', '*.bcf', '*.blg', '*.fdb_latexmk', '*.fls', '*.log', '*.out', '*.run.xml', '*.synctex.gz',
  '*.synctex(busy)', '*.toc', '*.lof', '*.lot', '*.xdv', '*.nav', '*.snm', '*.vrb', '*.idx', '*.ilg', '*.ind',
  '_minted*/', '.DS_Store', '.vscode/',
];

/** Root documents of the repo (files with \documentclass): their PDF is what pdfOnSave writes next to them. */
function rootPdfs(dir: string, repoRoot: string, depth = 0, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) rootPdfs(p, repoRoot, depth + 1, out);
    else if (e.isFile() && /\.tex$/i.test(e.name)) {
      try {
        const head = fs.readFileSync(p, 'utf8').slice(0, 20000);
        if (/^[^%\n]*\\documentclass/m.test(head)) out.push('/' + path.relative(repoRoot, p.replace(/\.tex$/i, '.pdf')).split(path.sep).join('/'));
      } catch { /* unreadable: skip */ }
    }
  }
  return out;
}

export function excludeBlock(repoRoot: string): string {
  return [EXCLUDE_BEGIN, ...EXCLUDE_PATTERNS, ...rootPdfs(repoRoot, repoRoot), EXCLUDE_END].join('\n');
}

/** Replace (or append) our block in .git/info/exclude, leaving the user's own lines alone. */
export async function ensureExcludes(git: Git, repoRoot: string): Promise<void> {
  const file = path.resolve(repoRoot, (await git.run(['rev-parse', '--git-path', 'info/exclude'])).trim());
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = excludeBlock(repoRoot);
  const re = /# >>> (?:livetex|latex-live): local build output[\s\S]*?# <<< (?:livetex|latex-live)\b/;
  const next = re.test(old) ? old.replace(re, block) : (old && !old.endsWith('\n') ? old + '\n' : old) + block + '\n';
  if (next !== old) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, next); }
}


const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

export interface RepoStatus {
  merging: boolean;
  conflicts: string[];
  changed: number;      // uncommitted local changes (files)
  ahead: number;        // local commits not on Overleaf (as of the last fetch)
  behind: number;       // Overleaf commits not merged locally (as of the last fetch)
  branch?: string;
}

export async function status(git: Git, remote: string): Promise<RepoStatus> {
  const merging = await git.ok(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  const conflicts = splitZ(await git.run(['diff', '--name-only', '--diff-filter=U', '-z']));
  const changed = splitZ(await git.run(['status', '--porcelain', '-z', '--untracked-files=all'])).filter(l => /^.. /.test(l)).length;
  const branch = await remoteBranch(git, remote);
  let ahead = 0, behind = 0;
  if (branch && await git.ok(['rev-parse', '-q', '--verify', 'HEAD'])) {
    const [a, b] = (await git.run(['rev-list', '--left-right', '--count', `HEAD...${remote}/${branch}`])).trim().split(/\s+/).map(Number);
    ahead = a; behind = b;
  }
  return { merging, conflicts, changed, ahead, behind, branch };
}

function splitZ(s: string): string[] { return s.split('\0').filter(Boolean); }

export type SyncOutcome =
  | { kind: 'ok'; pulled: number; pushed: number; committed: boolean }
  | { kind: 'conflict'; files: string[]; pulled: number }
  | { kind: 'behind'; behind: number }     // pull-only mode could not fast-forward
  | { kind: 'nothing' };

export interface SyncOptions {
  push: boolean;
  /** Commit local changes before merging (full sync). False = fetch + fast-forward only, no commits. */
  commit: boolean;
  message: string;
  allowUnrelated?: boolean;
}

/** Fallback identity when the user has none configured; Overleaf credits the token's owner anyway. */
async function identityArgs(git: Git): Promise<string[]> {
  const email = (await git.exec(['config', 'user.email'])).stdout.trim();
  const name = (await git.exec(['config', 'user.name'])).stdout.trim();
  return [...(email ? [] : ['-c', 'user.email=livetex@localhost']), ...(name ? [] : ['-c', 'user.name=LiveTex'])];
}

/** Stage files whose conflict markers the user removed by hand (instead of "Complete Merge" in the merge editor). */
async function stageResolved(git: Git, repoRoot: string): Promise<string[]> {
  const left: string[] = [];
  for (const f of splitZ(await git.run(['diff', '--name-only', '--diff-filter=U', '-z']))) {
    const abs = path.join(repoRoot, f);
    let text: string | undefined;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { /* deleted: resolved as deletion */ }
    if (text !== undefined && CONFLICT_MARKER.test(text)) left.push(f);
    else await git.run(['add', '-A', '--', f]);
  }
  return left;
}

/**
 * One sync round: commit local work, fetch, merge Overleaf's branch, push. Conflicts stop before pushing and leave
 * a normal git merge in progress (resolve, then sync again; or `git merge --abort` to return to the local commit).
 */
export async function sync(git: Git, repoRoot: string, remote: string, o: SyncOptions): Promise<SyncOutcome> {
  const id = await identityArgs(git);
  let committed = false;
  if (o.commit) {
    if (await git.ok(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      const left = await stageResolved(git, repoRoot);
      if (left.length) return { kind: 'conflict', files: left, pulled: 0 };
    }
    await ensureExcludes(git, repoRoot);
    await git.run(['add', '-A']);
    if (!await git.ok(['diff', '--cached', '--quiet'])) {
      const merging = await git.ok(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      await git.run([...id, 'commit', '-q', ...(merging ? ['--no-edit'] : ['-m', o.message])]);
      committed = true;
    } else if (await git.ok(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      await git.run([...id, 'commit', '-q', '--no-edit']); // merge resolved to the local tree: still record it
      committed = true;
    }
  } else if (await git.ok(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    return { kind: 'conflict', files: splitZ(await git.run(['diff', '--name-only', '--diff-filter=U', '-z'])), pulled: 0 };
  }

  let pulled = 0, pushed = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await git.run(['fetch', '--prune', remote], true);
    const branch = await remoteBranch(git, remote);
    if (!branch) throw new Error(`The Overleaf remote has no main/master branch (fetched from ${remote}).`);
    const hasHead = await git.ok(['rev-parse', '-q', '--verify', 'HEAD']);
    const target = `${remote}/${branch}`;
    const behind = +(await git.run(['rev-list', '--count', hasHead ? `HEAD..${target}` : target])).trim();

    if (behind > 0) {
      if (!o.commit) {
        if (hasHead && +(await git.run(['rev-list', '--count', `${target}..HEAD`])).trim() > 0) return { kind: 'behind', behind };
        // Fast-forward only. Git refuses (and changes nothing) if it would overwrite uncommitted local edits.
        const r = await git.exec(['merge', '--ff-only', '-q', target]);
        if (r.code !== 0) return { kind: 'behind', behind };
        return { kind: 'ok', pulled: behind, pushed: 0, committed: false };
      }
      const r = await git.exec([...id, 'merge', '--no-edit', '-q', ...(o.allowUnrelated ? ['--allow-unrelated-histories'] : []), target]);
      if (r.code !== 0) {
        const files = splitZ(await git.run(['diff', '--name-only', '--diff-filter=U', '-z']));
        if (files.length) return { kind: 'conflict', files, pulled: behind };
        throw new GitError(['merge'], r);
      }
      pulled += behind;
    }

    const ahead = +(await git.run(['rev-list', '--count', `${target}..HEAD`])).trim();
    if (!o.push || ahead === 0) return pulled || committed ? { kind: 'ok', pulled, pushed, committed } : { kind: 'nothing' };
    // Plain push, never forced: if someone edited on Overleaf meanwhile it is rejected and we fetch/merge again.
    const r = await git.exec(['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`], true);
    if (r.code === 0) { pushed = ahead; return { kind: 'ok', pulled, pushed, committed }; }
    if (!/\[rejected\]|non-fast-forward|fetch first/i.test(r.stdout + r.stderr)) throw new GitError(['push'], r);
  }
  throw new Error('Overleaf kept changing while syncing; try again.');
}

export interface LinkPlan { initialize: boolean; files: string[] }

/** Everything linking would check, without changing anything. Throws with a user-facing reason if it can't link. */
async function checkLinkable(git: Git, dir: string, url: string): Promise<{ initialize: boolean }> {
  const top = await topLevel(git);
  if (top && path.resolve(top) !== path.resolve(dir))
    throw new Error(`${dir} is inside the git repository ${top}. Open that folder, or link a folder that is not part of another repository.`);
  if (!top) return { initialize: true };
  if (splitZ(await git.run(['status', '--porcelain', '-z'])).length)
    throw new Error('This git repository has uncommitted changes. Commit or stash them first, then link again.');
  if (await git.ok(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) throw new Error('A git merge is in progress in this folder. Finish or abort it first.');
  const existing = await findRemote(git);
  if (existing && existing.url !== url) throw new Error(`This repository is already linked to ${existing.url} (remote "${existing.name}").`);
  return { initialize: false };
}

/**
 * Dry run of linking `dir`: the checks plus the list of files the first sync would upload. A folder that is not a
 * repository yet is listed through a throwaway git dir in `scratch`, so nothing is created inside `dir`.
 */
export async function planLink(git: Git, dir: string, url: string, scratch: string): Promise<LinkPlan> {
  const { initialize } = await checkLinkable(git, dir, url);
  fs.mkdirSync(scratch, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(scratch, 'link-'));
  try {
    const excludes = path.join(tmp, 'exclude');
    fs.writeFileSync(excludes, excludeBlock(dir) + '\n');
    let files: string[];
    if (initialize) {
      await git.with(tmp).run(['init', '-q', 'repo']);
      files = splitZ(await git.run(['--git-dir', path.join(tmp, 'repo', '.git'), '--work-tree', dir,
        'ls-files', '-z', '--others', '--exclude-standard', `--exclude-from=${excludes}`]));
    } else {
      files = splitZ(await git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', `--exclude-from=${excludes}`]));
    }
    return { initialize, files: [...new Set(files)].sort() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Make `dir` a repository with the Overleaf remote (`git init` if needed) and write excludes. No network. */
export async function prepareLink(git: Git, dir: string, url: string): Promise<void> {
  const { initialize } = await checkLinkable(git, dir, url);
  if (initialize) {
    await git.run(['init', '-q']);
    await git.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  if (!await findRemote(git)) await git.run(['remote', 'add', 'overleaf', url]);
  await ensureExcludes(git, dir);
}
