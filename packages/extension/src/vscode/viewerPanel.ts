/**
 * "TAP: View Log": a read-only webview over a folder's log (design §12). The page is the bundled
 * @tap/ui viewer; this side sends it the log bytes, then only the bytes appended since (the log
 * is append-only), plus the folder's current files to compare with.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMPARED_WITH, workspaceFiles } from './workspaceFiles.js';

/** How often an open viewer checks the log for new records. */
const REFRESH_MS = 2000;

/** What the viewer page last reported (used by tests and for the output channel). */
export interface ViewerStatus {
  state: 'loading' | 'ready' | 'error';
  verdict?: string;
  entries?: number;
  message?: string;
}

export interface ViewerHost {
  extensionUri: vscode.Uri;
  log: vscode.LogOutputChannel;
  /** Writes buffered edits of a recording folder to the log (no-op otherwise). */
  flush(folder: vscode.WorkspaceFolder): Promise<void>;
}

/** The content security policy of the viewer page. */
export function viewerCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspSource}`,
    // CodeMirror inserts its base styles in a <style> element, allowed by nonce.
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    // The log is parsed in a worker created from a blob: URL (the only kind webviews allow).
    'worker-src blob:',
  ].join('; ');
}

export class ViewerPanel implements vscode.Disposable {
  private static readonly open = new Map<string, ViewerPanel>();

  readonly panel: vscode.WebviewPanel;
  private readonly folder: vscode.WorkspaceFolder;
  private readonly host: ViewerHost;
  private readonly logPath: string;
  private sent = 0;
  private sentIdentity = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  status: ViewerStatus = { state: 'loading' };

  /** Opens (or reveals) the viewer of a folder. */
  static show(folder: vscode.WorkspaceFolder, host: ViewerHost): ViewerPanel {
    const key = folder.uri.toString();
    const existing = ViewerPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const viewer = new ViewerPanel(folder, host);
    ViewerPanel.open.set(key, viewer);
    return viewer;
  }

  static of(folder: vscode.WorkspaceFolder): ViewerPanel | undefined {
    return ViewerPanel.open.get(folder.uri.toString());
  }

  static disposeAll(): void {
    for (const v of [...ViewerPanel.open.values()]) v.dispose();
  }

  private constructor(folder: vscode.WorkspaceFolder, host: ViewerHost) {
    this.folder = folder;
    this.host = host;
    this.logPath = path.join(folder.uri.fsPath, '.tap', 'log.codelog');
    const webviewDir = vscode.Uri.joinPath(host.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel(
      'tap.viewer',
      `Log: ${folder.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewDir],
      },
    );
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg)),
      this.panel.onDidChangeViewState(() => this.schedule()),
    );
    this.panel.webview.html = this.html(webviewDir);
  }

  private html(webviewDir: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'viewer.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'viewer.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${viewerCsp(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="tap-style-nonce" content="${nonce}">
<link rel="stylesheet" href="${style}">
<title>Log: ${escapeHtml(this.folder.name)}</title>
</head>
<body>
<div id="app"></div>
<script src="${script}"></script>
</body>
</html>`;
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string } & Record<string, unknown>;
    if (m.type === 'ready') {
      void this.sendAll();
    } else if (m.type === 'status') {
      const next: ViewerStatus = {
        state: m.state === 'error' ? 'error' : m.state === 'ready' ? 'ready' : 'loading',
      };
      if (typeof m.verdict === 'string') next.verdict = m.verdict;
      if (typeof m.entries === 'number') next.entries = m.entries;
      if (typeof m.message === 'string') next.message = m.message;
      this.status = next;
      if (next.state === 'error')
        this.host.log.warn(`${this.folder.name}: viewer: ${next.message ?? 'error'}`);
    } else if (m.type === 'openFile' && typeof m.path === 'string') {
      const rel = m.path;
      const abs = path.join(this.folder.uri.fsPath, ...rel.split('/'));
      if (!path.relative(this.folder.uri.fsPath, abs).startsWith('..') && fs.existsSync(abs)) {
        void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
      }
    }
  }

  /** Sends the whole log (first load, or after the file was replaced). */
  private async sendAll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.host.flush(this.folder);
      if (!fs.existsSync(this.logPath)) {
        void this.panel.webview.postMessage({
          type: 'error',
          message: `"${this.folder.name}" has no log yet.`,
        });
        return;
      }
      const bytes = new Uint8Array(fs.readFileSync(this.logPath));
      this.sent = bytes.length;
      this.sentIdentity = identity(this.logPath);
      const submission = await workspaceFiles(this.folder.uri.fsPath);
      await this.panel.webview.postMessage({
        type: 'log',
        bytes,
        title: this.folder.name,
        submission,
        comparedWith: COMPARED_WITH,
      });
    } catch (e) {
      this.host.log.warn(`${this.folder.name}: viewer: ${String(e)}`);
      void this.panel.webview.postMessage({ type: 'error', message: `Could not read the log: ${String(e)}` });
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  /** Live refresh: while the viewer is visible, send what was appended to the log. */
  private schedule(): void {
    const wasRunning = this.timer !== undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.panel.visible) return;
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    // Shown again after being hidden: catch up now rather than at the next tick.
    if (!wasRunning) void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.busy || !this.panel.visible) return;
    this.busy = true;
    try {
      await this.host.flush(this.folder);
      if (!fs.existsSync(this.logPath)) return;
      const size = fs.statSync(this.logPath).size;
      if (size === this.sent && identity(this.logPath) === this.sentIdentity) return;
      if (size < this.sent || identity(this.logPath) !== this.sentIdentity) {
        // Replaced or repaired (crash recovery truncates): start over.
        this.busy = false;
        await this.sendAll();
        return;
      }
      const fd = fs.openSync(this.logPath, 'r');
      const chunk = new Uint8Array(size - this.sent);
      try {
        fs.readSync(fd, chunk, 0, chunk.length, this.sent);
      } finally {
        fs.closeSync(fd);
      }
      this.sent = size;
      const submission = await workspaceFiles(this.folder.uri.fsPath);
      await this.panel.webview.postMessage({
        type: 'append',
        bytes: chunk,
        submission,
        comparedWith: COMPARED_WITH,
      });
    } catch (e) {
      this.host.log.warn(`${this.folder.name}: viewer refresh: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    ViewerPanel.open.delete(this.folder.uri.toString());
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}

/** Changes when the file is replaced by another one (restored from backup, recreated). */
function identity(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.ino}:${s.birthtimeMs}`;
  } catch {
    return '';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
