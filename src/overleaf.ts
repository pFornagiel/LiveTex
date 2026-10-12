// VS Code side of Overleaf sync: commands, status bar, token storage. The git work is in overleafGit.ts.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  Git, GitError, RepoStatus, Remote, SyncOutcome, findRemote, hostOf, parseProjectInput, planLink, prepareLink,
  projectPageUrl, ensureExcludes, status, sync, topLevel, writeAskpass,
} from './overleafGit';

const AUTO_PULL_INTERVAL_MS = 2 * 60_000;   // Overleaf rate-limits clients that poll; pull at most this often
const PUSH_ON_SAVE_DELAY_MS = 15_000;
const SYNC_MESSAGE = 'Update from LiveTex';
const TOKEN_HELP = 'https://www.overleaf.com/user/settings';

interface Repo {
  root: string;
  remote: Remote;
  status?: RepoStatus;
  busy?: Promise<unknown>;
  error?: string;
  lastPull: number;
  pushTimer?: NodeJS.Timeout;
  fsTimer?: NodeJS.Timeout;
}

type Mode = 'manual' | 'autoPull' | 'pushOnSave';

export interface OverleafBadge {
  state: 'synced' | 'pending' | 'busy' | 'conflict' | 'error';
  icon: string;       // codicon for the status bar
  label: string;      // short text: "↓2 ↑", "1 conflict", "Syncing…"
  tooltip: string;
}

export class OverleafSync implements vscode.Disposable, vscode.FileDecorationProvider {
  private readonly repos = new Map<string, Repo>();
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Any repository's sync state changed. */
  readonly onDidChange = this._onDidChange.event;
  private readonly decorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorations.event;
  private readonly tokens = new Map<string, string>();   // in-memory copy of SecretStorage for the git askpass
  private readonly subs: vscode.Disposable[] = [];
  private readonly askpass: string;
  private readonly scratch: string;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.askpass = writeAskpass(path.join(ctx.globalStorageUri.fsPath, 'bin'));
    this.scratch = path.join(ctx.globalStorageUri.fsPath, 'tmp');
    this.item.command = 'livetex.overleaf.sync';
    const cmd = vscode.commands.registerCommand;
    this.subs.push(
      this.item, this._onDidChange, this.decorations,
      vscode.window.registerFileDecorationProvider(this),
      cmd('livetex.overleaf.sync', () => this.syncActive()),
      cmd('livetex.overleaf.link', (uri?: vscode.Uri) => this.link(uri instanceof vscode.Uri ? uri : undefined)),
      cmd('livetex.overleaf.clone', () => this.clone()),
      cmd('livetex.overleaf.abortMerge', () => this.abortMerge()),
      cmd('livetex.overleaf.openProject', () => this.openProject()),
      cmd('livetex.overleaf.setToken', () => this.setToken()),
      cmd('livetex.overleaf.forgetToken', () => this.forgetToken()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      // Re-detect on focus too, so a remote added from a terminal shows up without a reload.
      vscode.window.onDidChangeWindowState(s => { if (s.focused) void this.discover().then(() => this.autoPullAll()); }),
      vscode.workspace.onDidSaveTextDocument(d => this.onSave(d)),
    );
    // Files changed by other tools (agents, scripts, a terminal git) update the indicators too.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFs = (uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || /[\\/]\.git([\\/]|$)/.test(uri.fsPath)) return; // git's own writes would loop
      const r = this.repoOf(uri.fsPath);
      if (!r) return;
      if (r.fsTimer) clearTimeout(r.fsTimer);
      r.fsTimer = setTimeout(() => { r.fsTimer = undefined; if (!r.busy) void this.refresh(r); }, 1000);
    };
    this.subs.push(watcher, watcher.onDidChange(onFs), watcher.onDidCreate(onFs), watcher.onDidDelete(onFs));
    void this.discover().then(() => this.autoPullAll());
  }

  dispose() {
    for (const r of this.repos.values()) { clearTimeout(r.pushTimer); clearTimeout(r.fsTimer); }
    for (const s of this.subs) s.dispose();
  }

  private cfg() { return vscode.workspace.getConfiguration('livetex.overleaf'); }

  /** `url`: the remote whose host's token network commands send. */
  private git(cwd: string, url?: string): Git {
    const gp = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
    return new Git(cwd, {
      gitPath: typeof gp === 'string' && gp ? gp : Array.isArray(gp) ? gp[0] : undefined,
      askpass: this.askpass,
      token: async () => url ? this.tokens.get(hostOf(url)) : undefined,
      log: s => this.log.appendLine(s),
    });
  }

  // ---------- tokens ----------
  private key(host: string) { return `livetex.overleafToken:${host}`; }

  private async token(url: string, prompt: boolean, reason?: string): Promise<string | undefined> {
    const host = hostOf(url);
    let t = this.tokens.get(host) ?? await this.ctx.secrets.get(this.key(host));
    if (!t && prompt) t = await this.askToken(host, reason);
    if (t) this.tokens.set(host, t);
    return t;
  }

  private async askToken(host: string, reason?: string): Promise<string | undefined> {
    const box = vscode.window.createInputBox();
    box.title = `Overleaf Git token for ${host}`;
    box.prompt = (reason ? reason + ' ' : '') +
      'Create one in Overleaf → Account Settings → Git Integration. It is kept in VS Code\'s secret storage and only passed to git.';
    box.placeholder = 'olp_…';
    box.password = true;
    box.ignoreFocusOut = true;
    box.buttons = [{ iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open Overleaf account settings' }];
    const value = await new Promise<string | undefined>(resolve => {
      box.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(TOKEN_HELP)));
      box.onDidAccept(() => { resolve(box.value.trim() || undefined); box.hide(); });
      box.onDidHide(() => resolve(undefined));
      box.show();
    });
    box.dispose();
    if (value) await this.ctx.secrets.store(this.key(host), value);
    return value;
  }

  private async setToken() {
    const host = this.activeRepo() ? hostOf(this.activeRepo()!.remote.url) : 'git.overleaf.com';
    const t = await this.askToken(host);
    if (t) { this.tokens.set(host, t); vscode.window.showInformationMessage(`Overleaf token saved for ${host}.`); }
  }

  private async forgetToken() {
    const hosts = new Set(['git.overleaf.com', ...[...this.repos.values()].map(r => hostOf(r.remote.url))]);
    for (const h of hosts) { this.tokens.delete(h); await this.ctx.secrets.delete(this.key(h)); }
    vscode.window.showInformationMessage('Overleaf tokens removed from this editor.');
  }

  /** Run a network operation; if Overleaf rejects the token, ask for a new one and retry once. */
  private async withAuth<T>(url: string, interactive: boolean, op: () => Promise<T>): Promise<T | undefined> {
    if (!await this.token(url, interactive)) return undefined;
    try {
      return await op();
    } catch (e) {
      if (!(e instanceof GitError && e.authFailed) || !interactive) throw e;
      const host = hostOf(url);
      this.tokens.delete(host);
      await this.ctx.secrets.delete(this.key(host));
      if (!await this.token(url, true, 'Overleaf rejected the saved token (expired or revoked?).')) return undefined;
      return op();
    }
  }

  // ---------- repositories ----------
  private async discover() {
    const roots = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      const git = this.git(f.uri.fsPath);
      try {
        const top = await topLevel(git);
        if (top) roots.add(top);
      } catch (e) { this.log.appendLine(`[overleaf] git not usable: ${e}`); return; }
    }
    // Known repositories are re-checked too (they may come from a previewed file outside the workspace folders);
    // track() drops any that lost their Overleaf remote or no longer exist.
    for (const root of new Set([...roots, ...this.repos.keys()])) await this.track(root);
    this.render();
  }

  private async track(root: string): Promise<Repo | undefined> {
    const remote = fs.existsSync(root) ? await findRemote(this.git(root)) : undefined;
    if (!remote) { this.repos.delete(root); return undefined; }
    let r = this.repos.get(root);
    if (!r) { r = { root, remote, lastPull: 0 }; this.repos.set(root, r); this.log.appendLine(`[overleaf] ${root} ↔ ${remote.url}`); }
    r.remote = remote;
    await this.refresh(r);
    return r;
  }

  private async refresh(r: Repo) {
    try { r.status = await status(this.git(r.root), r.remote.name); } catch (e) { r.error = String(e); }
    this.render();
  }

  private repoOf(file: string): Repo | undefined {
    let best: Repo | undefined;
    for (const r of this.repos.values()) {
      const rel = path.relative(r.root, file);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && (!best || r.root.length > best.root.length)) best = r;
    }
    return best;
  }

  private activeRepo(): Repo | undefined {
    const ed = vscode.window.activeTextEditor;
    if (ed?.document.uri.scheme === 'file') { const r = this.repoOf(ed.document.uri.fsPath); if (r) return r; }
    return this.repos.size === 1 ? [...this.repos.values()][0] : undefined;
  }

  private dirtyDocs(r: Repo) {
    return vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' && this.repoOf(d.uri.fsPath) === r);
  }

  // ---------- indicators: status bar, preview button, Explorer badge ----------
  /** How a repository's sync state is shown everywhere. */
  private describe(r: Repo): OverleafBadge {
    const s = r.status;
    const name = path.basename(r.root);
    const where = `${name} ↔ ${r.remote.url}`;
    if (r.busy) return { state: 'busy', icon: 'sync~spin', label: 'Syncing…', tooltip: `Syncing ${name} with Overleaf…` };
    if (s?.merging) {
      const n = s.conflicts.length;
      return {
        state: 'conflict', icon: 'warning', label: n ? `${n} conflict${n > 1 ? 's' : ''}` : 'Finish merge',
        tooltip: n
          ? `${where}\nResolve the conflicts in ${s.conflicts.join(', ')}, save, then click to finish syncing.\n(“LiveTex: Abort Overleaf Merge” returns to your local version.)`
          : `${where}\nConflicts resolved — click to finish syncing.`,
      };
    }
    if (r.error) return { state: 'error', icon: 'error', label: 'Sync failed', tooltip: `${where}\nLast sync failed: ${r.error}\nClick to retry.` };
    const arrows = [s?.behind ? `↓${s.behind}` : '', s?.ahead || s?.changed ? '↑' : ''].filter(Boolean).join(' ');
    return {
      state: arrows ? 'pending' : 'synced', icon: 'cloud', label: arrows,
      tooltip: [
        where,
        s?.changed ? `${s.changed} changed file${s.changed > 1 ? 's' : ''} not uploaded yet` : '',
        s?.ahead ? 'Local commits not uploaded yet' : '',
        s?.behind ? `${s.behind} Overleaf change${s.behind > 1 ? 's' : ''} to download` : '',
        arrows ? '' : 'Up to date (as of the last check)',
        'Click to sync now.',
      ].filter(Boolean).join('\n'),
    };
  }

  /** Sync indicator for the Overleaf project containing `file`, if any (used by the preview toolbar). */
  badgeFor(file: string): OverleafBadge | undefined {
    const r = this.repoOf(file);
    return r && this.describe(r);
  }

  /** Detect the Overleaf project of a file outside the workspace folders (e.g. a previewed document). */
  async trackFile(file: string): Promise<void> {
    if (this.repoOf(file)) return;
    try {
      const top = await topLevel(this.git(path.dirname(file)));
      if (top) await this.track(top);
    } catch { /* git missing: no Overleaf features */ }
  }

  /** Sync the project containing `file` (preview button). */
  async syncFile(file: string): Promise<void> {
    const r = this.repoOf(file);
    if (r) await this.run(r, 'manual');
    else void this.syncActive();
  }

  private render() {
    const r = this.activeRepo();
    if (r) {
      const b = this.describe(r);
      this.item.text = `$(${b.icon}) Overleaf${b.state === 'synced' ? '' : ': ' + b.label}`.replace(/: (↓|↑)/, ' $1');
      this.item.tooltip = b.tooltip;
      this.item.show();
    } else {
      this.item.hide();
    }
    void vscode.commands.executeCommand('setContext', 'livetex.overleafLinked', this.repos.size > 0);
    this._onDidChange.fire();
    this.decorations.fire(undefined);
  }

  /** "☁" badge on the linked project folder in the Explorer. */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const r = uri.scheme === 'file' ? this.repos.get(uri.fsPath) : undefined;
    if (!r) return undefined;
    const b = this.describe(r);
    return {
      badge: b.state === 'conflict' ? '!' : '☁',
      tooltip: `Overleaf project — ${b.state === 'synced' ? 'up to date' : b.label}`,
      color: b.state === 'conflict' ? new vscode.ThemeColor('list.warningForeground') : undefined,
    };
  }

  // ---------- sync ----------
  private async syncActive() {
    const r = this.activeRepo() ?? await this.pickRepo();
    if (!r) {
      const pick = await vscode.window.showInformationMessage('This folder is not linked to an Overleaf project.', 'Link to Overleaf…', 'Clone Overleaf Project…');
      if (pick === 'Link to Overleaf…') void this.link();
      else if (pick) void this.clone();
      return;
    }
    await this.run(r, 'manual');
  }

  private async pickRepo(): Promise<Repo | undefined> {
    if (this.repos.size < 2) return undefined;
    const pick = await vscode.window.showQuickPick([...this.repos.values()].map(r => ({ label: path.basename(r.root), description: r.root, r })), { placeHolder: 'Which project?' });
    return pick?.r;
  }

  /** Serialized per repository; an automatic run is skipped while another is in progress. */
  private async run(r: Repo, mode: Mode): Promise<void> {
    if (r.busy) {
      if (mode !== 'manual') return;
      await r.busy.catch(() => undefined);
    }
    const p = this.doRun(r, mode);
    r.busy = p;
    this.render();
    try { await p; } finally { r.busy = undefined; await this.refresh(r); }
  }

  private async doRun(r: Repo, mode: Mode): Promise<void> {
    const git = this.git(r.root, r.remote.url);
    const interactive = mode === 'manual';
    if (interactive) {
      // Save first, so the editor and the disk agree before git merges into the files.
      for (const d of this.dirtyDocs(r)) if (!await d.save()) { vscode.window.showWarningMessage(`Sync cancelled: ${path.basename(d.fileName)} could not be saved.`); return; }
    } else if (this.dirtyDocs(r).length) {
      return; // never change files on disk underneath unsaved edits
    }
    const push = mode !== 'autoPull';
    try {
      const out = await this.withAuth(r.remote.url, interactive, () =>
        sync(git, r.root, r.remote.name, { push, commit: push, message: SYNC_MESSAGE }));
      if (!out) return; // no token (prompt cancelled, or automatic run without one)
      r.error = undefined;
      if (mode === 'autoPull') r.lastPull = Date.now();
      this.report(r, out, mode);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      this.log.appendLine(`[overleaf] ${r.error}`);
      if (interactive || mode === 'pushOnSave') {
        const pick = await vscode.window.showErrorMessage(`Overleaf sync failed: ${r.error}`, 'Show Log');
        if (pick) this.log.show(true);
      }
    }
  }

  private report(r: Repo, out: SyncOutcome, mode: Mode) {
    const name = path.basename(r.root);
    switch (out.kind) {
      case 'ok': {
        const what = [out.pulled ? `downloaded ${out.pulled} change${out.pulled > 1 ? 's' : ''}` : '', out.pushed ? 'uploaded your changes' : ''].filter(Boolean).join(', ');
        vscode.window.setStatusBarMessage(`$(check) Overleaf: ${what || 'up to date'}`, 4000);
        this.log.appendLine(`[overleaf] ${name}: ${what || 'up to date'}`);
        break;
      }
      case 'nothing':
        if (mode === 'manual') vscode.window.setStatusBarMessage('$(check) Overleaf: up to date', 3000);
        break;
      case 'behind':
        this.log.appendLine(`[overleaf] ${name}: ${out.behind} Overleaf change(s) not pulled automatically (local edits in the way); sync to merge`);
        break;
      case 'conflict': void this.showConflicts(r, out.files); break;
    }
  }

  private async showConflicts(r: Repo, files: string[]) {
    const pick = await vscode.window.showWarningMessage(
      `Overleaf and your local copy both changed ${files.join(', ')}. Nothing was uploaded. Resolve the conflict markers ` +
      '(or use the merge editor), save, then sync again.', 'Open Conflicts', 'Abort Merge…');
    if (pick === 'Open Conflicts') {
      for (const f of files.slice(0, 5)) await vscode.window.showTextDocument(vscode.Uri.file(path.join(r.root, f)), { preview: false });
    } else if (pick) {
      await this.abortMerge(r);
    }
  }

  private async abortMerge(r = this.activeRepo()) {
    if (!r) return;
    if (!r.status?.merging) await this.refresh(r);
    if (!r.status?.merging) { vscode.window.showInformationMessage('No Overleaf merge in progress.'); return; }
    const ok = await vscode.window.showWarningMessage(
      'Abort the merge? Your files return to your last local version; Overleaf\'s changes stay on Overleaf (the next sync merges them again). ' +
      'Edits made while resolving conflicts are discarded.', { modal: true }, 'Abort Merge');
    if (!ok) return;
    for (const d of this.dirtyDocs(r)) await d.save();
    try { await this.git(r.root).run(['merge', '--abort']); } catch (e) { vscode.window.showErrorMessage(String(e)); }
    await this.refresh(r);
  }

  private async autoPullAll() {
    if (!this.cfg().get('autoPull', true)) return;
    for (const r of this.repos.values()) {
      if (Date.now() - r.lastPull < AUTO_PULL_INTERVAL_MS || r.status?.merging) continue;
      r.lastPull = Date.now();
      void this.run(r, 'autoPull');
    }
  }

  private onSave(d: vscode.TextDocument) {
    if (d.uri.scheme !== 'file') return;
    const r = this.repoOf(d.uri.fsPath);
    if (!r) return;
    setTimeout(() => { if (!r.busy) void this.refresh(r); }, 500);
    if (!this.cfg().get('pushOnSave', false) || r.status?.merging) return;
    if (r.pushTimer) clearTimeout(r.pushTimer);
    r.pushTimer = setTimeout(() => { r.pushTimer = undefined; void this.run(r, 'pushOnSave'); }, PUSH_ON_SAVE_DELAY_MS);
  }

  // ---------- link / clone ----------
  private async askProject(): Promise<{ url: string; id?: string } | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'Overleaf project',
      prompt: 'Project URL from the browser, the Git URL from Overleaf\'s Menu → Git, or the project ID. Git access needs an Overleaf plan that includes Git integration.',
      placeHolder: 'https://www.overleaf.com/project/…',
      ignoreFocusOut: true,
      validateInput: v => !v.trim() || parseProjectInput(v) ? undefined : 'Not an Overleaf project URL or ID',
    });
    return input ? parseProjectInput(input) : undefined;
  }

  /** Validate URL + token with a read-only request before touching any folder. */
  private async probe(url: string): Promise<boolean> {
    try {
      const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Connecting to Overleaf…' },
        () => this.withAuth(url, true, () => this.git(this.scratchDir(), url).run(['ls-remote', '--heads', url], true)));
      return ok !== undefined;
    } catch (e) {
      const msg = e instanceof GitError && /not found|404|does not appear to be a git repository/i.test(e.result.stderr)
        ? 'Overleaf has no project at that address, or your account cannot access it.'
        : e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Could not reach the Overleaf project: ${msg}`);
      return false;
    }
  }

  private scratchDir() { fs.mkdirSync(this.scratch, { recursive: true }); return this.scratch; }

  private async link(target?: vscode.Uri) {
    let dir = target?.fsPath;
    if (!dir) {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
      if (folders.length === 1) dir = folders[0].uri.fsPath;
      else if (folders.length > 1) dir = (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to link with Overleaf' }))?.uri.fsPath;
      else dir = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Link Folder' }))?.[0]?.fsPath;
    }
    if (!dir) return;
    const project = await this.askProject();
    if (!project || !await this.probe(project.url)) return;

    const git = this.git(dir, project.url);
    let plan;
    try { plan = await planLink(git, dir, project.url, this.scratchDir()); } catch (e) {
      vscode.window.showErrorMessage(`Cannot link ${path.basename(dir)}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const shown = plan.files.slice(0, 12).join(', ') + (plan.files.length > 12 ? `, … (${plan.files.length - 12} more)` : '');
    const ok = await vscode.window.showWarningMessage(
      `Link “${path.basename(dir)}” to the Overleaf project?`,
      {
        modal: true,
        detail:
          (plan.files.length ? `These ${plan.files.length} local files will be merged with the Overleaf project and uploaded:\n${shown}\n\n` : 'The folder has no files to upload; the Overleaf project will be downloaded into it.\n\n') +
          'Overleaf\'s files are downloaded next to them. Nothing is deleted on either side. If a file exists in both with different ' +
          'content, you get a merge conflict to resolve; nothing is uploaded until you do.\n\n' +
          'Build output (.aux, .log, the compiled root PDF, .vscode/) stays local.' +
          (plan.initialize ? ' A git repository (.git) is created in the folder to track the sync.' : ''),
      },
      'Link and Sync');
    if (ok !== 'Link and Sync') return;

    try {
      await prepareLink(git, dir, project.url);
    } catch (e) { vscode.window.showErrorMessage(`Cannot link: ${e instanceof Error ? e.message : e}`); return; }
    const root = (await topLevel(git)) ?? dir;
    const r = await this.track(root);
    if (!r) return;
    for (const d of this.dirtyDocs(r)) await d.save();
    const p = (async () => {
      try {
        const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Linking with Overleaf…' }, () =>
          this.withAuth(r.remote.url, true, () => sync(git, root, r.remote.name, { push: true, commit: true, message: 'Local files linked by LiveTex', allowUnrelated: true })));
        if (!out) return;
        r.error = undefined;
        if (out.kind === 'conflict') void this.showConflicts(r, out.files);
        else vscode.window.showInformationMessage(`“${path.basename(root)}” is linked to Overleaf. Use the Overleaf item in the status bar to sync.`);
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Linking failed: ${r.error}. Your local files were not changed; see the LiveTex log.`);
      }
    })();
    r.busy = p;
    this.render();
    try { await p; } finally { r.busy = undefined; await this.refresh(r); }
  }

  private async clone() {
    const project = await this.askProject();
    if (!project || !await this.probe(project.url)) return;
    const parent = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Clone Here', title: 'Folder to put the project in' }))?.[0]?.fsPath;
    if (!parent) return;
    const name = await vscode.window.showInputBox({
      title: 'Name of the new project folder',
      value: project.id ? `overleaf-${project.id.slice(0, 8)}` : 'overleaf-project',
      validateInput: v => {
        if (!v.trim() || /[\\/]/.test(v)) return 'Enter a folder name';
        const p = path.join(parent, v.trim());
        return fs.existsSync(p) && fs.readdirSync(p).length ? 'A non-empty folder with this name already exists' : undefined;
      },
    });
    if (!name) return;
    const dest = path.join(parent, name.trim());
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Cloning from Overleaf…' }, () =>
        this.withAuth(project.url, true, () => this.git(parent, project.url).run(['clone', '-q', '--origin', 'overleaf', project.url, dest], true)));
      await ensureExcludes(this.git(dest), dest);
    } catch (e) {
      vscode.window.showErrorMessage(`Clone failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const pick = await vscode.window.showInformationMessage(`Cloned into ${dest}.`, 'Open Folder', 'Add to Workspace');
    if (pick === 'Open Folder') void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: false });
    else if (pick) vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(dest) });
  }

  private openProject() {
    const r = this.activeRepo();
    const page = r && projectPageUrl(r.remote.url);
    if (page) void vscode.env.openExternal(vscode.Uri.parse(page));
    else vscode.window.showInformationMessage(r ? `Remote: ${r.remote.url}` : 'This folder is not linked to an Overleaf project.');
  }
}
