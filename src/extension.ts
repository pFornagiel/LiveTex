import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RootBuilder, BuildResult } from './builder';
import { PreviewPanel, ToHost, VIEW_TYPE, title } from './preview';
import { Engine, installTectonic, resolveEngine, tectonicCacheDir, TECTONIC_VERSION } from './engines';
import { findRoot, isTexDoc } from './root';
import { PreviewImageCache } from './imageCache';
import { OverleafSync } from './overleaf';

const RELEVANT_FILE = /(\.(tex|ltx|latex|sty|cls|bib|bst|bbx|cbx|def|cfg|clo|tikz|pgf|png|jpe?g|pdf|eps|svg|csv|dat|txt)|(^|[\\/])\.?latexmkrc)$/i;

export function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('LiveTex');
  const diagnostics = vscode.languages.createDiagnosticCollection('livetex');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const builders = new Map<string, RootBuilder>();
  const previews = new Map<string, PreviewPanel>();
  const rootCache = new Map<string, string>();          // edited file -> root file
  const diagFiles = new Map<string, Set<string>>();     // root -> files that currently carry our diagnostics
  const exportedPdfs = new Set<string>();               // our own writes; ignored by the file watcher
  const storageDir = (ctx.storageUri ?? ctx.globalStorageUri).fsPath;
  let lastTexColumn: vscode.ViewColumn | undefined;
  let installOffer: Thenable<unknown> | undefined;
  const cfg = () => vscode.workspace.getConfiguration('livetex');
  const images = new PreviewImageCache(path.join(ctx.globalStorageUri.fsPath, 'preview-images'), ctx.asAbsolutePath('dist/flattenWorker.js'), s => log.appendLine(s));
  ctx.subscriptions.push(log, diagnostics, status, { dispose: () => images.dispose() });
  const overleaf = new OverleafSync(ctx, log);
  ctx.subscriptions.push(overleaf, overleaf.onDidChange(() => { for (const p of previews.values()) postOverleaf(p); }));
  const postOverleaf = (p: PreviewPanel) => p.post({ type: 'overleaf', badge: overleaf.badgeFor(p.root.fsPath) });

  // ---------- engine ----------
  let engineNoticeShown = false;
  const getEngine = async (): Promise<Engine | undefined> => {
    const e = resolveEngine(ctx);
    if (e && !engineNoticeShown) { engineNoticeShown = true; log.appendLine(`[engine] ${e.kind} from ${e.source}: ${e.command}`); }
    return e;
  };

  async function offerInstall(force = false) {
    if (installOffer && !force) return;
    const download = `Download Tectonic ${TECTONIC_VERSION}`;
    const msg =
      'LiveTex needs a TeX engine and none was found. Tectonic is a self-contained LaTeX engine (single ≈25 MB binary, ' +
      'stored in VS Code\'s extension storage, nothing installed system-wide). LaTeX packages are fetched on demand and cached in ' +
      `${tectonicCacheDir()}.`;
    installOffer = vscode.window.showWarningMessage(msg, download, 'Use my own TeX…').then(async pick => {
      if (pick === download) {
        const p = await installTectonic(ctx, log);
        if (p) { vscode.window.showInformationMessage('Tectonic is ready. The first compile downloads common LaTeX packages and can take a minute.'); rebuildAll('open'); }
      } else if (pick) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'livetex.engine');
      }
      installOffer = undefined;
    });
  }

  // ---------- builders ----------
  function builderFor(root: vscode.Uri): RootBuilder {
    let b = builders.get(root.fsPath);
    if (b) return b;
    b = new RootBuilder(root, storageDir, getEngine, log, images);
    builders.set(root.fsPath, b);
    const builder = b;
    b.onStart(() => {
      previews.get(root.fsPath)?.post({ type: 'status', state: 'compiling', text: 'Compiling…' });
      updateStatus();
    });
    b.onDone(r => onBuildDone(builder, r));
    return b;
  }

  function onBuildDone(b: RootBuilder, r: BuildResult) {
    const preview = previews.get(b.root.fsPath);
    if (r.fatal === 'no-engine') {
      preview?.post({ type: 'status', state: 'no-engine', text: 'No TeX engine' });
      void offerInstall();
      updateStatus();
      return;
    }
    // diagnostics
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const p of r.problems) {
      const file = p.file ?? b.root.fsPath;
      const line = Math.max(0, (p.line ?? 1) - 1);
      const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), p.message,
        p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'LaTeX';
      (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(d);
    }
    for (const f of diagFiles.get(b.root.fsPath) ?? []) if (!byFile.has(f)) diagnostics.delete(vscode.Uri.file(f));
    for (const [f, ds] of byFile) diagnostics.set(vscode.Uri.file(f), ds);
    diagFiles.set(b.root.fsPath, new Set(byFile.keys()));

    if (r.pdf) preview?.showPdf(r.pdf);
    const secs = (r.durationMs / 1000).toFixed(r.durationMs < 10000 ? 1 : 0);
    const text = r.fatal ? `Engine failed: ${r.fatal}`
      : r.ok ? `Compiled in ${secs}s`
      : r.errors ? 'Failed — showing last good PDF' : 'No PDF produced';
    preview?.post({ type: 'status', state: r.fatal || !r.ok || r.errors ? 'error' : 'ok', text, errors: r.errors, warnings: r.warnings });

    if (r.ok && r.clean && r.pdfPath && (r.reason === 'save' || r.reason === 'manual') && cfg().get('pdfOnSave', true)) {
      const dest = path.join(b.projectDir, b.stem + '.pdf');
      try {
        exportedPdfs.add(dest);
        fs.copyFileSync(r.pdfPath, dest);
        setTimeout(() => exportedPdfs.delete(dest), 3000);
      } catch (e) { log.appendLine(`[pdf] could not write ${dest}: ${e}`); }
    }
    updateStatus();
  }

  function rebuildAll(reason: 'open' | 'change') {
    for (const root of previews.keys()) builderFor(vscode.Uri.file(root)).request(reason);
  }

  async function rootFor(uri: vscode.Uri): Promise<vscode.Uri> {
    const cached = rootCache.get(uri.fsPath);
    if (cached && fs.existsSync(cached)) return vscode.Uri.file(cached);
    const root = await findRoot(uri);
    rootCache.set(uri.fsPath, root.fsPath);
    return root;
  }

  /** Roots with an open preview whose project folder contains `file`. */
  function previewedRootsContaining(file: string): RootBuilder[] {
    const res: RootBuilder[] = [];
    for (const root of previews.keys()) {
      const b = builderFor(vscode.Uri.file(root));
      const rel = path.relative(b.projectDir, file);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) res.push(b);
    }
    return res;
  }

  // ---------- preview ----------
  function attachPreview(p: PreviewPanel) {
    const root = p.root;
    previews.set(root.fsPath, p);
    const b = builderFor(root);
    p.onMessage(m => onViewMessage(b, m));
    p.onDidDispose(() => { previews.delete(root.fsPath); updateStatus(); });
    p.panel.onDidChangeViewState(() => updateStatus());
    if (b.lastPdf) p.showPdf(b.lastPdf);
    b.request('open');
    postOverleaf(p);
    void overleaf.trackFile(root.fsPath).then(() => postOverleaf(p));
  }

  async function openPreview(target?: vscode.Uri) {
    const uri = target ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) { vscode.window.showInformationMessage('Open a .tex file first.'); return; }
    const root = await rootFor(uri);
    const existing = previews.get(root.fsPath);
    if (existing) { existing.panel.reveal(undefined, true); return; }
    attachPreview(PreviewPanel.create(ctx, root, vscode.ViewColumn.Beside));
  }

  function onViewMessage(b: RootBuilder, m: ToHost) {
    switch (m.type) {
      case 'inverse': {
        const loc = b.synctex?.inverse(m.page, m.x, m.y);
        if (loc) void revealSource(loc.file, loc.line);
        else log.appendLine(`[synctex] nothing at page ${m.page} (${m.x.toFixed(1)}, ${m.y.toFixed(1)})`);
        break;
      }
      case 'compile': b.request('manual'); break;
      case 'export': void exportPdf(b); break;
      case 'showLog': log.show(true); break;
      case 'installEngine': void offerInstall(true); break;
      case 'problems': void vscode.commands.executeCommand('workbench.actions.view.problems'); break;
      case 'overleafSync': void overleaf.syncFile(b.root.fsPath); break;
    }
  }

  const flash = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });
  ctx.subscriptions.push(flash);

  async function revealSource(file: string, line: number) {
    const uri = vscode.Uri.file(file);
    const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === uri.fsPath);
    const column = visible?.viewColumn ?? lastTexColumn ?? vscode.ViewColumn.One;
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: column, preserveFocus: false });
    const ln = Math.min(Math.max(0, line - 1), editor.document.lineCount - 1);
    const range = editor.document.lineAt(ln).range;
    suppressForwardUntil = Date.now() + 400;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(flash, [range]);
    setTimeout(() => editor.setDecorations(flash, []), 900);
  }

  async function forwardSync(editor: vscode.TextEditor, reveal: boolean) {
    const root = await rootFor(editor.document.uri);
    const p = previews.get(root.fsPath);
    const st = builders.get(root.fsPath)?.synctex;
    if (!p || !st) return;
    const rect = st.forward(editor.document.uri.fsPath, editor.selection.active.line + 1);
    if (rect) p.post({ type: 'highlight', ...rect, reveal });
  }

  async function exportPdf(b?: RootBuilder) {
    if (!b) {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const root = uri ? await rootFor(uri) : [...previews.keys()].map(r => vscode.Uri.file(r))[0];
      if (!root) { vscode.window.showInformationMessage('Open a .tex file first.'); return; }
      b = builderFor(root);
    }
    const src = path.join(b.outDir, b.stem + '.pdf');
    const last = b.lastResult;
    if (!fs.existsSync(src) || !last?.ok || last.preview || b.busy) {
      // The preview PDF may use preview-only shortcuts (flattened images): export a full build instead.
      const builder = b;
      const full = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Building the full-quality PDF…' },
        () => new Promise<BuildResult>(resolve => {
          const sub = builder.onDone(r => { if (r.reason === 'manual' || r.reason === 'save') { sub.dispose(); resolve(r); } });
          builder.request('manual');
        }),
      );
      if (!full.ok) { vscode.window.showErrorMessage('The PDF could not be built; see the Problems panel.'); return; }
    }
    const dest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(b.projectDir, b.stem + '.pdf')),
      filters: { PDF: ['pdf'] },
      saveLabel: 'Export PDF',
    });
    if (!dest) return;
    exportedPdfs.add(dest.fsPath);
    fs.copyFileSync(src, dest.fsPath);
    setTimeout(() => exportedPdfs.delete(dest.fsPath), 3000);
    const open = await vscode.window.showInformationMessage(`Exported ${path.basename(dest.fsPath)}`, 'Reveal in File Explorer');
    if (open) void vscode.commands.executeCommand('revealFileInOS', dest);
  }

  // ---------- status bar ----------
  function updateStatus() {
    const ed = vscode.window.activeTextEditor;
    const activePreview = [...previews.values()].find(p => p.panel.active);
    let root: string | undefined = activePreview?.root.fsPath;
    if (!root && ed && isTexDoc(ed.document)) root = rootCache.get(ed.document.uri.fsPath) ?? ed.document.uri.fsPath;
    if (!root) { status.hide(); return; }
    const b = builders.get(root);
    if (b?.lastResult?.fatal === 'no-engine') {
      status.text = '$(warning) LaTeX: no engine';
      status.tooltip = 'No TeX engine found — click to download Tectonic';
      status.command = 'livetex.installTectonic';
    } else if (!previews.has(root) || !b) {
      status.text = '$(open-preview) LaTeX Preview';
      status.tooltip = 'Open the live PDF preview';
      status.command = 'livetex.openPreview';
    } else if (b.busy) {
      status.text = '$(sync~spin) LaTeX';
      status.tooltip = 'Compiling…';
      status.command = 'livetex.showLog';
    } else {
      const r = b.lastResult;
      status.text = !r ? '$(file-pdf) LaTeX' : r.errors ? `$(error) LaTeX ${r.errors}` : `$(check) LaTeX ${(r.durationMs / 1000).toFixed(1)}s`;
      status.tooltip = r?.fatal ? `Engine failed: ${r.fatal}` : 'Click to show compiler output';
      status.command = 'livetex.showLog';
    }
    status.show();
  }

  // ---------- events ----------
  let suppressForwardUntil = 0;
  let selTimer: NodeJS.Timeout | undefined;

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!e.contentChanges.length || e.document.uri.scheme !== 'file') return;
      if (cfg().get<string>('compileOn', 'change') !== 'change') return;
      if (!RELEVANT_FILE.test(e.document.fileName)) return;
      const delay = cfg().get<number>('debounceMs', 250);
      for (const b of previewedRootsContaining(e.document.uri.fsPath)) b.request('change', delay);
      updateStatus();
    }),
    vscode.workspace.onDidSaveTextDocument(d => {
      if (cfg().get<string>('compileOn', 'change') === 'manual' || d.uri.scheme !== 'file') return;
      if (isTexDoc(d)) { rootCache.delete(d.uri.fsPath); void rootFor(d.uri).then(updateStatus); } // magic comments may have changed
      for (const b of previewedRootsContaining(d.uri.fsPath)) b.request('save', 30);
    }),
    vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && isTexDoc(ed.document)) {
        lastTexColumn = ed.viewColumn;
        void rootFor(ed.document.uri).then(updateStatus);
      }
      updateStatus();
    }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!cfg().get('syncOnCursorMove', true) || !isTexDoc(e.textEditor.document)) return;
      if (e.kind === vscode.TextEditorSelectionChangeKind.Command || Date.now() < suppressForwardUntil) return;
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => void forwardSync(e.textEditor, false), 150);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('livetex')) return;
      for (const p of previews.values()) p.post({ type: 'config', invertDark: cfg().get('invertPdfInDarkTheme', false) });
      if (e.affectsConfiguration('livetex.rootFile')) rootCache.clear();
      if (['engine', 'tectonicPath', 'continueOnErrors', 'shellEscape', 'latexmkArgs'].some(k => e.affectsConfiguration(`livetex.${k}`))) {
        engineNoticeShown = false;
        rebuildAll('open');
      }
    }),
  );

  // Files changed outside the editor (git checkout, an agent writing files, regenerated figures…).
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFsEvent = (uri: vscode.Uri) => {
    if (cfg().get<string>('compileOn', 'change') === 'manual' || !RELEVANT_FILE.test(uri.fsPath) || exportedPdfs.has(uri.fsPath)) return;
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    if (open?.isDirty) return; // the editor buffer is the source of truth
    for (const b of previewedRootsContaining(uri.fsPath)) {
      if (uri.fsPath === path.join(b.projectDir, b.stem + '.pdf')) continue;
      if (/\.png$/i.test(uri.fsPath)) b.prepareImages();
      b.request('external', 150);
    }
  };
  ctx.subscriptions.push(watcher, watcher.onDidChange(onFsEvent), watcher.onDidCreate(onFsEvent), watcher.onDidDelete(onFsEvent));

  // ---------- commands ----------
  ctx.subscriptions.push(
    vscode.commands.registerCommand('livetex.openPreview', (uri?: vscode.Uri) => openPreview(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('livetex.compile', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const root = uri ? await rootFor(uri) : [...previews.keys()].map(r => vscode.Uri.file(r))[0];
      if (!root) return;
      if (!resolveEngine(ctx)) { void offerInstall(true); return; }
      builderFor(root).request('manual');
    }),
    vscode.commands.registerCommand('livetex.exportPdf', () => exportPdf()),
    vscode.commands.registerCommand('livetex.syncToPdf', () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) void forwardSync(ed, true);
    }),
    vscode.commands.registerCommand('livetex.installTectonic', async () => {
      const p = await installTectonic(ctx, log);
      if (p) { vscode.window.showInformationMessage(`Tectonic installed: ${p}`); rebuildAll('open'); }
    }),
    vscode.commands.registerCommand('livetex.showLog', () => log.show(true)),
    vscode.commands.registerCommand('livetex.setRoot', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
      const rel = ws ? path.relative(ws.uri.fsPath, ed.document.uri.fsPath) : ed.document.uri.fsPath;
      await cfg().update('rootFile', rel, vscode.ConfigurationTarget.Workspace);
      rootCache.clear();
      vscode.window.showInformationMessage(`LiveTex root document: ${rel}`);
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: { root?: string } | undefined) {
        if (!state?.root || !fs.existsSync(state.root)) { panel.dispose(); return; }
        const root = vscode.Uri.file(state.root);
        panel.title = title(root);
        attachPreview(new PreviewPanel(ctx, panel, root));
      },
    }),
    { dispose: () => { for (const b of builders.values()) b.dispose(); for (const p of previews.values()) p.dispose(); } },
  );

  if (vscode.window.activeTextEditor && isTexDoc(vscode.window.activeTextEditor.document)) {
    lastTexColumn = vscode.window.activeTextEditor.viewColumn;
    void rootFor(vscode.window.activeTextEditor.document.uri).then(updateStatus);
  }
  updateStatus();
}

export function deactivate() {}
