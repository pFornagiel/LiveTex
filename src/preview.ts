import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { OverleafBadge } from './overleaf';

export type ToHost =
  | { type: 'ready' }
  | { type: 'inverse'; page: number; x: number; y: number }
  | { type: 'compile' }
  | { type: 'export' }
  | { type: 'showLog' }
  | { type: 'installEngine' }
  | { type: 'problems' }
  | { type: 'overleafSync' };

export type ToView =
  | { type: 'pdf'; data: Uint8Array; seq: number }
  | { type: 'status'; state: 'compiling' | 'ok' | 'error' | 'idle' | 'no-engine'; text: string; errors?: number; warnings?: number }
  | { type: 'highlight'; page: number; x: number; y: number; w: number; h: number; reveal: boolean }
  | { type: 'config'; invertDark: boolean }
  | { type: 'overleaf'; badge?: OverleafBadge };

export const VIEW_TYPE = 'livetex.preview';

/** A webview that renders the root document's PDF with pdf.js. */
export class PreviewPanel implements vscode.Disposable {
  private ready = false;
  private queue: ToView[] = [];
  private seq = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onMessage = new vscode.EventEmitter<ToHost>();
  private readonly _onDispose = new vscode.EventEmitter<void>();
  readonly onMessage = this._onMessage.event;
  readonly onDidDispose = this._onDispose.event;

  static create(ctx: vscode.ExtensionContext, root: vscode.Uri, column: vscode.ViewColumn): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE, title(root), { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] },
    );
    return new PreviewPanel(ctx, panel, root);
  }

  constructor(private readonly ctx: vscode.ExtensionContext, readonly panel: vscode.WebviewPanel, readonly root: vscode.Uri) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ToHost) => {
        if (m.type === 'ready') {
          this.ready = true;
          this.post({ type: 'config', invertDark: vscode.workspace.getConfiguration('livetex').get('invertPdfInDarkTheme', false) });
          for (const q of this.queue.splice(0)) void panel.webview.postMessage(q);
        }
        this._onMessage.fire(m);
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  post(msg: ToView) {
    if (!this.ready) {
      // Only the newest PDF/status matters while the view boots.
      this.queue = this.queue.filter(q => q.type !== msg.type);
      this.queue.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  showPdf(data: Uint8Array) {
    // Node Buffers are views into a shared pool; hand the webview a standalone copy so the transfer is exact.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.post({ type: 'pdf', data: copy, seq: ++this.seq });
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f)).toString();
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} data: blob:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `font-src ${w.cspSource} data: blob:`,
      `script-src 'nonce-${nonce}' ${w.cspSource}`,
      `worker-src blob:`,
      `connect-src ${w.cspSource} data: blob:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('viewer.css')}">
</head><body>
<div id="toolbar">
  <span id="status" class="st-idle" title="Compiler status — click for log"><i></i><b id="status-text">Starting…</b></span>
  <button id="problems" class="pill hidden" title="Show problems"></button>
  <span class="grow"></span>
  <span id="pageinfo">– / –</span>
  <span class="sep"></span>
  <button id="zoom-out" title="Zoom out (Ctrl -)">&#8722;</button>
  <button id="zoom-label" title="Fit width">100%</button>
  <button id="zoom-in" title="Zoom in (Ctrl +)">+</button>
  <span class="sep"></span>
  <button id="overleaf" class="hidden" title="Sync with Overleaf"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 12.5h6.9a2.9 2.9 0 0 0 .3-5.8 4.1 4.1 0 0 0-7.9 1.1 2.4 2.4 0 0 0 .7 4.7z"/></svg><span class="ol-name">Overleaf</span><span id="overleaf-text"></span></button>
  <button id="compile" title="Recompile">&#8635;</button>
  <button id="export" title="Export PDF…">PDF</button>
</div>
<div id="viewer"><div id="pages"></div>
  <div id="empty"><div class="spinner"></div><p id="empty-text">Compiling…</p><button id="install" class="hidden">Download Tectonic (≈10–25 MB)</button></div>
</div>
<script nonce="${nonce}">window.__LL = ${JSON.stringify({
      worker: media('pdf.worker.min.mjs'),
      wasm: media('wasm/'),
      fonts: media('standard_fonts/'),
      name: path.basename(this.root.fsPath),
      root: this.root.fsPath,
    })};</script>
<script nonce="${nonce}" type="module" src="${media('viewer.js')}"></script>
</body></html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._onDispose.fire();
    this._onDispose.dispose();
    this._onMessage.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}

export function title(root: vscode.Uri) { return `Preview ${path.basename(root.fsPath)}`; }
