import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const MAGIC = /^\s*%\s*!\s*T[eE]X\s+root\s*=\s*(.+?)\s*$/m;
const DOCCLASS = /^[^%\n]*\\documentclass/m;

function textOf(uri: vscode.Uri): string | undefined {
  const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch { return undefined; }
}

/** Figure out which document should be compiled when `doc` is being edited. */
export async function findRoot(doc: vscode.Uri): Promise<vscode.Uri> {
  const text = textOf(doc) ?? '';
  const head = text.split('\n').slice(0, 30).join('\n');
  const magic = MAGIC.exec(head);
  if (magic) {
    const p = path.resolve(path.dirname(doc.fsPath), magic[1]);
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  const configured = vscode.workspace.getConfiguration('livetex').get<string>('rootFile', '').trim();
  if (configured) {
    const ws = vscode.workspace.getWorkspaceFolder(doc) ?? vscode.workspace.workspaceFolders?.[0];
    const p = path.isAbsolute(configured) ? configured : ws ? path.join(ws.uri.fsPath, configured) : configured;
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  if (DOCCLASS.test(text)) return doc;

  // Look for a document that \input/\include/\subfile's this one.
  const candidates = await vscode.workspace.findFiles('**/*.tex', '**/{node_modules,.git}/**', 300);
  for (const c of candidates) {
    if (c.fsPath === doc.fsPath) continue;
    const t = textOf(c);
    if (!t || !DOCCLASS.test(t)) continue;
    const rel = path.relative(path.dirname(c.fsPath), doc.fsPath).replace(/\\/g, '/');
    const stem = rel.replace(/\.tex$/, '');
    const re = new RegExp(String.raw`\\(?:input|include|subfile|import\*?\{[^}]*\})\s*\{\s*(?:\./)?${escape(stem)}(?:\.tex)?\s*\}`);
    if (re.test(t)) return c;
  }
  return doc;
}

function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function isTexDoc(d: vscode.TextDocument): boolean {
  return d.languageId === 'latex' || d.languageId === 'tex' || /\.(tex|ltx|latex)$/i.test(d.fileName);
}
