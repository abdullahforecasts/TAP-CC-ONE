/**
 * Connects one workspace folder to a Recorder: VS Code events in, log bytes out (design §11).
 * Everything here is thin glue; the behaviour lives in recorder/ and storage/.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { type KeyPair, toHex, toLogPath } from '@tap/core';
import * as vscode from 'vscode';
import type { AnchorService, AnchorSink } from '../anchoring/anchorService.js';
import type { EditReason } from '../recorder/classify.js';
import { detectAiExtensions, LIVE_SHARE_ID, normaliseAppName } from '../recorder/environment.js';
import {
  type CheckpointInfo,
  type DiskRead,
  Recorder,
  type RecorderHost,
  type RecorderOptions,
  type RecorderState,
} from '../recorder/recorder.js';
import { maskCommand, programName } from '../recorder/terminal.js';
import { readTrackedFile } from '../storage/diskReader.js';
import { createMatcher, type LoadedConfig, loadConfig, TAP_DIR } from '../storage/folderConfig.js';
import { FolderLock, LOCK_HEARTBEAT_MS } from '../storage/lock.js';
import { type OpenedLog, openLog } from '../storage/logStore.js';
import { walkFiles } from '../storage/walk.js';

export type SessionStatus = RecorderState | 'read-only' | 'error';

export interface SessionContext {
  extensionVersion: string;
  key: KeyPair;
  mirrorDir: string;
  sessionId: string;
  log: vscode.LogOutputChannel;
  onStatusChange: () => void;
  /** Shared timestamp queue (absent in some tests). */
  anchors?: AnchorService;
}

const TICK_MS = 15_000;
const VCS_WINDOW_MS = 5_000;

/** Diagnostics on the console when TAP_DEBUG is set (the integration tests set it). */
function debug(...args: unknown[]): void {
  if (process.env.TAP_DEBUG) console.log('[tap]', ...args);
}

export class FolderSession implements vscode.Disposable {
  readonly folder: vscode.WorkspaceFolder;
  readonly root: string;
  private readonly ctx: SessionContext;
  private recorder: Recorder | undefined;
  private opened: OpenedLog | undefined;
  private lock: FolderLock | undefined;
  private config: LoadedConfig | undefined;
  private matcher: (rel: string) => boolean = () => false;
  private disposables: vscode.Disposable[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private statusValue: SessionStatus = 'idle';
  private problem: string | undefined;
  private readonly runs = new Map<unknown, number>();
  private lastEnv = '';
  private focused: boolean;
  private anchorSink: AnchorSink | undefined;
  /** Newest checkpoint already sent for timestamping. */
  private lastAnchoredCk = -1;

  constructor(folder: vscode.WorkspaceFolder, ctx: SessionContext) {
    this.folder = folder;
    this.root = folder.uri.fsPath;
    this.ctx = ctx;
    this.focused = vscode.window.state.focused;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  /** Human-readable reason for 'error' / 'read-only'. */
  get detail(): string | undefined {
    return this.problem;
  }

  get name(): string {
    return this.folder.name;
  }

  get tapDir(): string {
    return path.join(this.root, TAP_DIR);
  }

  get logPath(): string {
    return path.join(this.tapDir, 'log.codelog');
  }

  get recorderStats() {
    return this.recorder?.stats;
  }

  get logIdHex(): string | undefined {
    return this.opened ? toHex(this.opened.writer.header.logId) : undefined;
  }

  /** Opens (or creates) the log and starts recording. */
  async start(options: { paused: boolean }): Promise<void> {
    if (this.recorder) return;
    try {
      this.config = loadConfig(this.root);
      this.matcher = createMatcher(this.config.config);

      this.lock = new FolderLock(path.join(this.tapDir, 'lock'), this.ctx.sessionId);
      const lockResult = this.lock.acquire();
      if (!lockResult.acquired) {
        this.problem = 'Recording is active in another VS Code window for this folder.';
        this.setStatus('read-only');
        this.lock = undefined;
        return;
      }

      this.opened = openLog({
        tapDir: this.tapDir,
        mirrorDir: this.ctx.mirrorDir,
        label: this.config.config.label,
        tool: `tap-cc-one/${this.ctx.extensionVersion}`,
        now: Date.now(),
      });
      if (this.opened.quarantinedTo) {
        this.ctx.log.warn(
          `${this.name}: repaired a damaged log tail; the damaged bytes were saved to ${this.opened.quarantinedTo}`,
        );
      }

      const settings = vscode.workspace.getConfiguration('tap', this.folder.uri);
      const recorderSettings = {
        recordFocus: settings.get<boolean>('record.focus', true),
        clipboardCheckMinChars: settings.get<number>('classify.clipboardCheckMinChars', 2),
        bulkMinChars: settings.get<number>('classify.bulkMinChars', 40),
        checkpointIntervalMs: Math.max(60, settings.get<number>('checkpoint.intervalSec', 300)) * 1000,
      };
      const anchoring = settings.get<boolean>('anchoring.enabled', true);
      const terminal = settings.get<boolean>('record.terminalCommands', true);
      const env = this.environment();
      this.lastEnv = JSON.stringify([env.aiExt, env.liveShare]);
      const options2: RecorderOptions = {
        writer: this.opened.writer,
        sink: this.opened.store,
        host: this.createHost(),
        key: this.ctx.key,
        env: {
          ...env,
          cfgHash: this.config.hash,
          settings: {
            'tap.record.focus': recorderSettings.recordFocus,
            'tap.classify.clipboardCheckMinChars': recorderSettings.clipboardCheckMinChars,
            'tap.classify.bulkMinChars': recorderSettings.bulkMinChars,
            'tap.checkpoint.intervalSec': recorderSettings.checkpointIntervalMs / 1000,
            'tap.anchoring.enabled': anchoring,
            'tap.record.terminalCommands': terminal,
          },
        },
        settings: recorderSettings,
        diskHashes: this.opened.info.diskHashes,
      };
      if (this.opened.info.lastPub) options2.lastPub = this.opened.info.lastPub;
      if (this.opened.recovery) options2.recovery = this.opened.recovery;
      if (options.paused) options2.startPaused = true;

      this.recorder = new Recorder(options2);
      this.recorder.onStateChange = (state) => this.setStatus(state);
      this.subscribe();
      await this.recorder.start();
      this.timers.push(setInterval(() => void this.recorder?.tick(), TICK_MS));
      this.timers.push(setInterval(() => this.heartbeat(), LOCK_HEARTBEAT_MS));
      this.startAnchoring(settings);
      this.ctx.log.info(`${this.name}: recording to ${this.logPath}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async pause(): Promise<void> {
    await this.recorder?.pause();
    await this.anchorLatest();
  }

  async resume(): Promise<void> {
    await this.recorder?.resume();
  }

  async addNote(text: string): Promise<void> {
    await this.recorder?.addNote(text);
  }

  /** Writes everything buffered to disk (and, unless `sweep` is false, checks closed files). */
  async flush(options: { sweep?: boolean } = {}): Promise<void> {
    await this.recorder?.flush(options);
  }

  /** Stops recording cleanly (SESSION_END), releasing the lock. */
  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (recorder) {
      // Timestamp the final state first, so the log ends with independently dated work.
      const ck = await this.anchorLatest();
      if (ck) await this.ctx.anchors?.waitFor(this.logIdHex!, ck.s, 8000);
      await recorder.stop('close');
    }
    this.teardown();
    if (this.statusValue !== 'error' && this.statusValue !== 'read-only') this.setStatus('stopped');
  }

  /** Synchronous stop for deactivate(). */
  stopSync(): void {
    this.recorder?.stopSync('deactivate');
    this.teardown();
  }

  dispose(): void {
    this.stopSync();
  }

  private teardown(): void {
    if (this.anchorSink && this.logIdHex) this.ctx.anchors?.unregister(this.logIdHex, this.anchorSink);
    this.anchorSink = undefined;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.opened?.store.close();
    this.lock?.release();
    this.recorder = undefined;
    this.opened = undefined;
    this.lock = undefined;
  }

  private fail(e: unknown): void {
    this.problem = e instanceof Error ? e.message : String(e);
    this.ctx.log.error(`${this.name}: ${this.problem}`);
    this.teardown();
    this.setStatus('error');
  }

  private setStatus(status: SessionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.ctx.onStatusChange();
  }

  private heartbeat(): void {
    if (!this.lock) return;
    try {
      if (!this.lock.heartbeat()) {
        this.ctx.log.warn(`${this.name}: another window took over recording; this window stops recording`);
        this.recorder?.stopSync('close');
        this.teardown();
        this.problem = 'Recording moved to another VS Code window.';
        this.setStatus('read-only');
      }
    } catch (e) {
      this.ctx.log.warn(`${this.name}: lock heartbeat failed: ${String(e)}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Timestamp anchoring (design §9.4)
  // ------------------------------------------------------------------------------------------

  private startAnchoring(settings: vscode.WorkspaceConfiguration): void {
    const anchors = this.ctx.anchors;
    const logId = this.logIdHex;
    if (!anchors || !logId || !this.recorder) return;
    const recorder = this.recorder;
    this.anchorSink = { appendAnchor: (body) => recorder.appendAnchor(body) };
    anchors.register(logId, this.anchorSink);
    anchors.upgradeNow(logId);
    this.lastAnchoredCk = this.opened?.info.lastAnchoredCk ?? -1;
    if (!settings.get<boolean>('anchoring.enabled', true)) return;
    const every = Math.max(120, settings.get<number>('anchoring.intervalSec', 600)) * 1000;
    this.timers.push(setInterval(() => void this.anchorLatest(), every));
  }

  /**
   * Sends the newest checkpoint for timestamping, writing a new checkpoint first when anything
   * was recorded since the last one. Nothing is sent when nothing changed (design §9.4).
   */
  async anchorLatest(options: { force?: boolean } = {}): Promise<CheckpointInfo | undefined> {
    const recorder = this.recorder;
    const anchors = this.ctx.anchors;
    const logId = this.logIdHex;
    if (!recorder || !anchors || !logId) return undefined;
    const settings = vscode.workspace.getConfiguration('tap', this.folder.uri);
    if (!settings.get<boolean>('anchoring.enabled', true)) return undefined;
    const ck = await recorder.checkpointNow(options.force === true);
    if (!ck) return undefined;
    if (ck.s > this.lastAnchoredCk || options.force) {
      this.lastAnchoredCk = Math.max(this.lastAnchoredCk, ck.s);
      anchors.anchor(logId, ck.s, ck.hash);
    }
    return ck;
  }

  /** "TAP: Timestamp Now": checkpoint, timestamp, and wait up to `ms` for the TSAs. */
  async timestampNow(ms: number): Promise<{ ck?: CheckpointInfo; written: number }> {
    await this.flush();
    const ck = await this.anchorLatest({ force: true });
    if (!ck || !this.ctx.anchors || !this.logIdHex) return { written: 0 };
    const written = await this.ctx.anchors.waitFor(this.logIdHex, ck.s, ms);
    await this.flush({ sweep: false });
    return { ck, written };
  }

  /** Editor and environment details disclosed in SESSION_START (design §6.1). */
  environment() {
    const ids = vscode.extensions.all.map((e) => e.id);
    return {
      vsc: vscode.version,
      app: normaliseAppName(vscode.env.appName),
      os: process.platform,
      ext: this.ctx.extensionVersion,
      aiExt: detectAiExtensions(ids),
      liveShare: vscode.extensions.getExtension(LIVE_SHARE_ID) !== undefined,
    };
  }

  /** Workspace-relative log path of a URI in this folder, or undefined. */
  relOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const rel = path.relative(this.root, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return toLogPath(rel);
  }

  private absOf(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  private findDocument(rel: string): vscode.TextDocument | undefined {
    const abs = path.normalize(this.absOf(rel));
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && !d.isClosed && path.normalize(d.uri.fsPath) === abs,
    );
  }

  private createHost(): RecorderHost {
    const maxBytes = (this.config?.config.maxFileSizeKB ?? 1024) * 1024;
    return {
      wallNow: () => Date.now(),
      monoNow: () => performance.now(),
      readClipboard: async () => vscode.env.clipboard.readText(),
      openText: (rel) => this.findDocument(rel)?.getText(),
      openDocuments: () =>
        vscode.workspace.textDocuments
          .filter((d) => !d.isClosed)
          .map((d) => ({ rel: this.relOf(d.uri), text: d }))
          .filter((x): x is { rel: string; text: vscode.TextDocument } => x.rel !== undefined)
          .map((x) => ({ rel: x.rel, text: x.text.getText() })),
      readDisk: (rel): Promise<DiskRead> => readTrackedFile(this.absOf(rel), maxBytes),
      statFile: (rel) =>
        fs.promises.stat(this.absOf(rel)).then(
          (s) => (s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined),
          () => undefined,
        ),
      listFiles: () => walkFiles(this.root, this.matcher),
      isTracked: (rel) => this.matcher(rel),
      vcsRecentlyActive: async () => this.vcsRecentlyActive(),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      onError: (error, context) => {
        debug(`${this.name}: ${context}:`, error);
        this.ctx.log.warn(
          `${this.name}: ${context}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    };
  }

  /** Commands run in VS Code's terminal (needs shell integration; design §6.1). */
  private terminalSubscriptions(): vscode.Disposable[] {
    const w = vscode.window as Partial<typeof vscode.window>;
    if (!w.onDidStartTerminalShellExecution || !w.onDidEndTerminalShellExecution) return [];
    const settings = () => vscode.workspace.getConfiguration('tap', this.folder.uri);
    return [
      w.onDidStartTerminalShellExecution((e) => {
        if (!settings().get<boolean>('record.terminalCommands', true)) return;
        const cwdUri = e.execution.cwd;
        let cwd: string | undefined;
        if (cwdUri) {
          if (cwdUri.scheme !== 'file') return;
          const rel = path.relative(this.root, cwdUri.fsPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) return; // another folder's terminal
          cwd = rel === '' ? undefined : toLogPath(rel);
        } else if ((vscode.workspace.workspaceFolders ?? []).length > 1) {
          return; // cannot tell which folder the command belongs to
        }
        const line = e.execution.commandLine.value;
        if (!line.trim()) return;
        const details: { cmd: string; cwd?: string } = { cmd: maskCommand(line) };
        if (cwd !== undefined) details.cwd = cwd;
        const rid = this.recorder?.runStarted('terminal', programName(line), details);
        if (rid !== undefined) this.runs.set(e.execution, rid);
      }),
      w.onDidEndTerminalShellExecution((e) => {
        const rid = this.runs.get(e.execution);
        if (rid === undefined) return;
        this.runs.delete(e.execution);
        this.recorder?.runEnded(rid, e.exitCode);
      }),
    ];
  }

  private vcsRecentlyActive(): boolean {
    const now = Date.now();
    for (const name of ['HEAD', 'index', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD']) {
      try {
        if (now - fs.statSync(path.join(this.root, '.git', name)).mtimeMs < VCS_WINDOW_MS) return true;
      } catch {
        // not present
      }
    }
    return false;
  }

  private subscribe(): void {
    const r = () => this.recorder;
    const d = this.disposables;
    d.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const rel = this.relOf(e.document.uri);
        if (!rel || e.contentChanges.length === 0) return;
        const reason: EditReason =
          e.reason === vscode.TextDocumentChangeReason.Undo
            ? 'undo'
            : e.reason === vscode.TextDocumentChangeReason.Redo
              ? 'redo'
              : undefined;
        const doc = e.document;
        r()?.onDocumentChanged(
          rel,
          e.contentChanges,
          reason,
          doc.isDirty,
          () => doc.getText(),
          () => doc.isDirty,
        );
      }),
      vscode.workspace.onWillSaveTextDocument((e) => {
        const rel = this.relOf(e.document.uri);
        if (rel) r()?.onWillSave(rel);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const rel = this.relOf(doc.uri);
        if (rel) r()?.onDidSave(rel, doc.getText());
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        const rel = this.relOf(doc.uri);
        if (rel) r()?.onDocumentOpened(rel, doc.getText());
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        const rels = e.files.map((u) => this.relOf(u)).filter((x): x is string => x !== undefined);
        if (rels.length > 0) r()?.onFilesCreated(rels);
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        const rels = e.files.map((u) => this.relOf(u)).filter((x): x is string => x !== undefined);
        if (rels.length > 0) r()?.onFilesDeleted(rels);
      }),
      vscode.workspace.onWillRenameFiles((e) => {
        const pairs: Array<{ from: string; to: string }> = [];
        for (const f of e.files) {
          const from = this.relOf(f.oldUri);
          const to = this.relOf(f.newUri);
          if (from && to) pairs.push({ from, to });
        }
        if (pairs.length > 0) r()?.onFilesWillRename(pairs);
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        const pairs: Array<{ from: string; to: string }> = [];
        for (const f of e.files) {
          const from = this.relOf(f.oldUri);
          const to = this.relOf(f.newUri);
          if (from && to) pairs.push({ from, to });
          else if (from) r()?.onFilesDeleted([from]);
          else if (to) r()?.onFilesCreated([to]);
        }
        if (pairs.length > 0) r()?.onFilesRenamed(pairs);
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused === this.focused) return;
        this.focused = s.focused;
        r()?.onFocusChanged(s.focused);
      }),
      vscode.debug.onDidStartDebugSession((s) => {
        if (s.workspaceFolder && s.workspaceFolder.uri.toString() !== this.folder.uri.toString()) return;
        const rid = r()?.runStarted('debug', s.name);
        if (rid !== undefined) this.runs.set(s.id, rid);
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        const rid = this.runs.get(s.id);
        if (rid === undefined) return;
        this.runs.delete(s.id);
        r()?.runEnded(rid);
      }),
      vscode.tasks.onDidStartTaskProcess((e) => {
        const scope = e.execution.task.scope;
        if (typeof scope === 'object' && scope.uri.toString() !== this.folder.uri.toString()) return;
        const rid = r()?.runStarted('task', e.execution.task.name);
        if (rid !== undefined) this.runs.set(e.execution, rid);
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        const rid = this.runs.get(e.execution);
        if (rid === undefined) return;
        this.runs.delete(e.execution);
        r()?.runEnded(rid, e.exitCode);
      }),
      ...this.terminalSubscriptions(),
      vscode.extensions.onDidChange(() => {
        const env = this.environment();
        const key = JSON.stringify([env.aiExt, env.liveShare]);
        if (key === this.lastEnv) return;
        this.lastEnv = key;
        r()?.environmentChanged({ aiExt: env.aiExt, liveShare: env.liveShare });
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    const onDisk = (uri: vscode.Uri) => {
      const rel = this.relOf(uri);
      debug('disk event', uri.fsPath, rel);
      if (rel && !rel.startsWith(`${TAP_DIR}/`)) r()?.onDiskEvent(rel);
    };
    d.push(watcher, watcher.onDidCreate(onDisk), watcher.onDidChange(onDisk), watcher.onDidDelete(onDisk));
  }
}
