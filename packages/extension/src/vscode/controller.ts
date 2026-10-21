/**
 * Extension-level wiring: one FolderSession per recorded workspace folder, commands, status bar
 * and prompts (design §11.4, §11.8).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createAnchorVerifier,
  type HttpClient,
  trustedIntermediates,
  trustedRoots,
  verifyTimestampToken,
} from '@tap/anchor';
import { nodeHttpClient } from '@tap/anchor/node';
import {
  type AnchorVerifier,
  type KeyPair,
  keyFingerprint,
  Replayer,
  readLog,
  type SubmittedFile,
  type VerifyReport,
  verifyLog,
} from '@tap/core';
import * as vscode from 'vscode';
import {
  type AnchorConfig,
  AnchorService,
  DEFAULT_CALENDARS,
  DEFAULT_TSAS,
} from '../anchoring/anchorService.js';
import { createConfig, createMatcher, hasConfig } from '../storage/folderConfig.js';
import { loadOrCreateKey } from '../storage/keystore.js';
import { walkFiles } from '../storage/walk.js';
import { buildSubmissionZip, readSubmissionZip } from './exportZip.js';
import { FolderSession, type SessionStatus } from './folderSession.js';
import { ViewerPanel } from './viewerPanel.js';
import { workspaceFiles } from './workspaceFiles.js';

const NEVER_KEY = 'tap.neverAsk';
const DISABLED_KEY = 'tap.disabled';
const PAUSED_KEY = 'tap.paused';
const KEY_NOTICE_KEY = 'tap.keyFileNoticeShown';
/** Longest a timestamp request may take, and the largest answer accepted. */
const HTTP_TIMEOUT_MS = 20_000;
const HTTP_MAX_BYTES = 1024 * 1024;
/** How long export waits for timestamps of its final checkpoint (design §9.4). */
const EXPORT_WAIT_MS = 30_000;

export class Controller implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly sessions = new Map<string, FolderSession>();
  private readonly status: vscode.StatusBarItem;
  readonly log: vscode.LogOutputChannel;
  private key: KeyPair | undefined;
  private readonly version: string;
  private readonly disposables: vscode.Disposable[] = [];
  readonly anchors: AnchorService;
  private verifier: AnchorVerifier | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
    this.log = vscode.window.createOutputChannel('TAP-CC-ONE', { log: true });
    this.status = vscode.window.createStatusBarItem('tap.status', vscode.StatusBarAlignment.Left, 100);
    this.status.name = 'TAP-CC-ONE';
    this.status.command = 'tap.showMenu';
    this.disposables.push(this.log, this.status);
    const queueFile = path.join(context.globalStorageUri.fsPath, 'anchor-queue.json');
    this.anchors = new AnchorService({
      http: httpClient,
      now: () => Date.now(),
      random: (n) => new Uint8Array(randomBytes(n)),
      load: () => (fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8') : undefined),
      save: (json) => {
        fs.mkdirSync(path.dirname(queueFile), { recursive: true });
        fs.writeFileSync(`${queueFile}.tmp`, json);
        fs.renameSync(`${queueFile}.tmp`, queueFile);
      },
      log: (m) => this.log.info(m),
      config: () => anchorConfig(),
      checkToken: (token, digest) =>
        verifyTimestampToken(token, digest, trustedRoots(), trustedIntermediates()),
    });
    this.anchors.onChange = () => this.updateStatus();
  }

  /** Token verification for reports (the bundled TSA roots; cached across calls). */
  anchorVerifier(): AnchorVerifier {
    this.verifier ??= createAnchorVerifier();
    return this.verifier;
  }

  async activate(): Promise<void> {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg('tap.start', () => this.cmdStart());
    reg('tap.stop', () => this.cmdStop());
    reg('tap.pause', () => this.cmdPause());
    reg('tap.resume', () => this.cmdResume());
    reg('tap.addNote', () => this.cmdAddNote());
    reg('tap.showFingerprint', () => this.cmdFingerprint());
    reg('tap.verifyCurrent', () => this.cmdVerify());
    reg('tap.showMenu', () => this.cmdMenu());
    reg('tap.viewLog', () => this.cmdView());
    reg('tap.timestampNow', () => this.cmdTimestampNow());
    reg('tap.export', () => this.cmdExport());
    reg('tap.openLogFile', (uri) => this.cmdOpenLogFile(uri instanceof vscode.Uri ? uri : undefined));
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const f of e.removed) {
          this.sessions.get(f.uri.toString())?.stopSync();
          this.sessions.delete(f.uri.toString());
        }
        for (const f of e.added) void this.openFolder(f);
        this.updateStatus();
      }),
    );
    for (const folder of vscode.workspace.workspaceFolders ?? []) await this.openFolder(folder);
    this.anchors.start();
    this.updateStatus();
  }

  /** Synchronous shutdown (VS Code is closing or reloading the window). */
  deactivate(): void {
    this.anchors.stop();
    for (const s of this.sessions.values()) s.stopSync();
    this.sessions.clear();
  }

  dispose(): void {
    ViewerPanel.disposeAll();
    this.deactivate();
    for (const d of this.disposables) d.dispose();
  }

  /** For tests and the menu. */
  session(folder: vscode.WorkspaceFolder): FolderSession | undefined {
    return this.sessions.get(folder.uri.toString());
  }

  /** The open viewer of a folder (tests). */
  viewer(folder: vscode.WorkspaceFolder): ViewerPanel | undefined {
    return ViewerPanel.of(folder);
  }

  /** Opens the viewer of a recorded folder. */
  showViewer(folder: vscode.WorkspaceFolder): ViewerPanel {
    return ViewerPanel.show(folder, {
      extensionUri: this.context.extensionUri,
      log: this.log,
      flush: async (f) => {
        await this.session(f)?.flush({ sweep: false });
      },
    });
  }

  private async getKey(): Promise<KeyPair> {
    if (this.key) return this.key;
    const loaded = await loadOrCreateKey(this.context.secrets, this.context.globalStorageUri.fsPath);
    this.key = loaded.key;
    if (loaded.source === 'file' && !this.context.globalState.get<boolean>(KEY_NOTICE_KEY)) {
      void this.context.globalState.update(KEY_NOTICE_KEY, true);
      void vscode.window.showInformationMessage(
        "TAP-CC-ONE: the system keychain is not available, so your signing key is stored in a private file in VS Code's extension storage.",
      );
    }
    this.log.info(`signing key ${keyFingerprint(loaded.key.publicKey)} (${loaded.source})`);
    return loaded.key;
  }

  private folderList(key: string): string[] {
    return this.context.workspaceState.get<string[]>(key) ?? [];
  }

  private async setFolderFlag(key: string, folder: vscode.WorkspaceFolder, on: boolean): Promise<void> {
    const id = folder.uri.toString();
    const list = new Set(
      key === NEVER_KEY ? (this.context.globalState.get<string[]>(key) ?? []) : this.folderList(key),
    );
    if (on) list.add(id);
    else list.delete(id);
    if (key === NEVER_KEY) await this.context.globalState.update(key, [...list]);
    else await this.context.workspaceState.update(key, [...list]);
  }

  private hasFolderFlag(key: string, folder: vscode.WorkspaceFolder): boolean {
    const list =
      key === NEVER_KEY ? (this.context.globalState.get<string[]>(key) ?? []) : this.folderList(key);
    return list.includes(folder.uri.toString());
  }

  /** On activation: resume recording where .tap/ exists, otherwise maybe ask. */
  private async openFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.scheme !== 'file') return;
    const root = folder.uri.fsPath;
    if (hasConfig(root)) {
      if (this.hasFolderFlag(DISABLED_KEY, folder)) return;
      await this.startSession(folder);
      return;
    }
    const settings = vscode.workspace.getConfiguration('tap', folder.uri);
    if (!settings.get<boolean>('promptOnOpen', true) || this.hasFolderFlag(NEVER_KEY, folder)) return;
    const defaults = this.defaultConfig(folder);
    const matcher = createMatcher({ version: 1, ...defaults });
    const hasCode = (await walkFiles(root, matcher, { firstOnly: true })).length > 0;
    if (!hasCode) return;
    void vscode.window
      .showInformationMessage(
        `Record authorship history for "${folder.name}"? TAP-CC-ONE keeps a tamper-evident log of how your code is written, so you can show your work is your own.`,
        'Start',
        'Not now',
        'Never for this folder',
      )
      .then(async (choice) => {
        if (choice === 'Start') await this.startFolder(folder);
        else if (choice === 'Never for this folder') await this.setFolderFlag(NEVER_KEY, folder, true);
      });
  }

  private defaultConfig(folder: vscode.WorkspaceFolder) {
    const settings = vscode.workspace.getConfiguration('tap', folder.uri);
    return {
      label: folder.name,
      include: settings.get<string[]>('include', ['**/*']),
      exclude: settings.get<string[]>('exclude', []),
      maxFileSizeKB: settings.get<number>('maxFileSizeKB', 1024),
    };
  }

  /** Creates .tap/ if needed and starts recording a folder. */
  async startFolder(folder: vscode.WorkspaceFolder): Promise<FolderSession | undefined> {
    const root = folder.uri.fsPath;
    if (!hasConfig(root)) createConfig(root, this.defaultConfig(folder));
    await this.setFolderFlag(DISABLED_KEY, folder, false);
    await this.setFolderFlag(NEVER_KEY, folder, false);
    return this.startSession(folder);
  }

  private async startSession(folder: vscode.WorkspaceFolder): Promise<FolderSession | undefined> {
    const id = folder.uri.toString();
    const existing = this.sessions.get(id);
    if (existing && (existing.status === 'recording' || existing.status === 'paused')) return existing;
    this.restoreFromMirrorIfMissing(folder);
    const session = new FolderSession(folder, {
      extensionVersion: this.version,
      key: await this.getKey(),
      mirrorDir: path.join(this.context.globalStorageUri.fsPath, 'logs'),
      sessionId: vscode.env.sessionId,
      log: this.log,
      anchors: this.anchors,
      onStatusChange: () => {
        this.updateStatus();
        // Remember pause across window reloads; stopping (including on reload) does not clear it.
        if (session.status === 'paused' || session.status === 'recording') {
          void this.rememberPaused(folder, session.status === 'paused');
        }
      },
    });
    this.sessions.set(id, session);
    await session.start({ paused: this.hasFolderFlag(PAUSED_KEY, folder) });
    if (session.logIdHex) {
      const map = this.context.globalState.get<Record<string, string>>('tap.logIds') ?? {};
      if (map[id] !== session.logIdHex)
        await this.context.globalState.update('tap.logIds', { ...map, [id]: session.logIdHex });
    }
    if (session.status === 'error') {
      void vscode.window.showErrorMessage(`TAP-CC-ONE could not record "${folder.name}": ${session.detail}`);
    } else if (session.status === 'read-only') {
      void vscode.window.showWarningMessage(
        `TAP-CC-ONE: ${session.detail} This window will not record "${folder.name}".`,
      );
    }
    this.updateStatus();
    return session;
  }

  private async rememberPaused(folder: vscode.WorkspaceFolder, paused: boolean): Promise<void> {
    if (this.hasFolderFlag(PAUSED_KEY, folder) !== paused)
      await this.setFolderFlag(PAUSED_KEY, folder, paused);
  }

  /** If .tap/log.codelog was deleted (git clean...), offer the shadow copy (design §11.2). */
  private restoreFromMirrorIfMissing(folder: vscode.WorkspaceFolder): void {
    const map = this.context.globalState.get<Record<string, string>>('tap.logIds') ?? {};
    const logId = map[folder.uri.toString()];
    if (!logId) return;
    const logPath = path.join(folder.uri.fsPath, '.tap', 'log.codelog');
    const mirror = path.join(this.context.globalStorageUri.fsPath, 'logs', `${logId}.codelog`);
    try {
      const logSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      if (fs.existsSync(mirror) && fs.statSync(mirror).size > logSize) {
        const log = logSize > 0 ? fs.readFileSync(logPath) : Buffer.alloc(0);
        const backup = fs.readFileSync(mirror);
        if (backup.subarray(0, log.length).equals(log)) {
          fs.copyFileSync(mirror, logPath);
          this.log.warn(
            `${folder.name}: the log was missing or shorter than its backup; restored it from the backup copy`,
          );
          void vscode.window.showWarningMessage(
            `TAP-CC-ONE restored the authorship log of "${folder.name}" from its backup copy.`,
          );
        }
      }
    } catch (e) {
      this.log.warn(`${folder.name}: could not check the backup copy: ${String(e)}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Status bar
  // ------------------------------------------------------------------------------------------

  updateStatus(): void {
    const sessions = [...this.sessions.values()];
    const states = sessions.map((s) => s.status);
    if (sessions.length === 0 || states.every((s) => s === 'stopped' || s === 'idle')) {
      this.status.hide();
      return;
    }
    const lines = sessions.map(
      (s) =>
        `${s.name}: ${describe(s.status)}${s.detail && (s.status === 'error' || s.status === 'read-only') ? ` (${s.detail})` : ''}`,
    );
    let text: string;
    let background: vscode.ThemeColor | undefined;
    if (states.includes('error')) {
      text = '$(warning) TAP';
      background = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (states.includes('recording')) {
      text = '$(record) TAP';
    } else if (states.includes('paused')) {
      text = '$(debug-pause) TAP';
    } else {
      text = '$(circle-slash) TAP';
    }
    const waiting = sessions.reduce((n, s) => n + (s.logIdHex ? this.anchors.outstanding(s.logIdHex) : 0), 0);
    if (waiting > 0) {
      text += ` ⧗${waiting}`;
      lines.push(`${waiting} timestamp(s) waiting to be sent or written (offline?)`);
    }
    this.status.text = text;
    this.status.backgroundColor = background;
    this.status.tooltip = `TAP-CC-ONE authorship recording\n${lines.join('\n')}\n\nClick for options.`;
    this.status.show();
  }

  // ------------------------------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------------------------------

  private async pickFolder(
    filter: (s: FolderSession | undefined, f: vscode.WorkspaceFolder) => boolean,
    placeHolder: string,
  ) {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => filter(this.session(f), f));
    if (folders.length === 0) return undefined;
    if (folders.length === 1) return folders[0];
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder },
    );
    return pick?.folder;
  }

  private async cmdStart(): Promise<void> {
    const folder = await this.pickFolder(
      (s, f) => f.uri.scheme === 'file' && (!s || !['recording', 'paused'].includes(s.status)),
      'Record which folder?',
    );
    if (!folder) {
      void vscode.window.showInformationMessage('TAP-CC-ONE: every open folder is already being recorded.');
      return;
    }
    const session = await this.startFolder(folder);
    if (session?.status === 'recording') {
      void vscode.window.showInformationMessage(`TAP-CC-ONE is recording "${folder.name}".`);
    }
  }

  private async cmdStop(): Promise<void> {
    const folder = await this.pickFolder(
      (s) => s?.status === 'recording' || s?.status === 'paused',
      'Stop recording which folder?',
    );
    if (!folder) return;
    await this.session(folder)?.stop();
    await this.setFolderFlag(DISABLED_KEY, folder, true);
    await this.setFolderFlag(PAUSED_KEY, folder, false);
    this.updateStatus();
    void vscode.window.showInformationMessage(
      `TAP-CC-ONE stopped recording "${folder.name}". The log is kept in .tap/; run "TAP: Start Recording This Folder" to continue it.`,
    );
  }

  private async cmdPause(): Promise<void> {
    const folder = await this.pickFolder((s) => s?.status === 'recording', 'Pause recording which folder?');
    if (folder) await this.session(folder)?.pause();
  }

  private async cmdResume(): Promise<void> {
    const folder = await this.pickFolder((s) => s?.status === 'paused', 'Resume recording which folder?');
    if (folder) await this.session(folder)?.resume();
  }

  private async cmdAddNote(): Promise<void> {
    const folder = await this.pickFolder(
      (s) => s?.status === 'recording' || s?.status === 'paused',
      'Add a note to which log?',
    );
    if (!folder) return;
    const text = await vscode.window.showInputBox({
      title: 'TAP-CC-ONE: add a note to the log',
      prompt:
        'Explain anything a reader of your log should know, e.g. "Starter code copied from the course page".',
      validateInput: (v) =>
        v.trim().length === 0
          ? 'Write a note first'
          : [...v].length > 2000
            ? 'At most 2000 characters'
            : undefined,
    });
    if (text?.trim()) await this.session(folder)?.addNote(text.trim());
  }

  private async cmdFingerprint(): Promise<void> {
    const key = await this.getKey();
    const fp = keyFingerprint(key.publicKey);
    const choice = await vscode.window.showInformationMessage(
      `Your TAP-CC-ONE key fingerprint: ${fp}`,
      'Copy',
    );
    if (choice === 'Copy') await vscode.env.clipboard.writeText(fp);
  }

  /**
   * Verifies a folder's log against its tracked files as they are now (the editor's text for
   * open documents, the disk otherwise).
   */
  async verifyFolder(folder: vscode.WorkspaceFolder): Promise<VerifyReport | undefined> {
    const session = this.session(folder);
    await session?.flush();
    const logPath = path.join(folder.uri.fsPath, '.tap', 'log.codelog');
    if (!fs.existsSync(logPath)) return undefined;
    const bytes = new Uint8Array(fs.readFileSync(logPath));
    if (hasConfig(folder.uri.fsPath)) {
      try {
        return verifyLog(bytes, {
          submission: await workspaceFiles(folder.uri.fsPath),
          anchorVerifier: this.anchorVerifier(),
        });
      } catch (e) {
        this.log.warn(`${folder.name}: could not list the folder's files: ${String(e)}`);
      }
    }
    let paths: string[] = [];
    try {
      const r = new Replayer();
      for (const e of readLog(bytes).records) r.apply(e.record);
      paths = r.liveFiles().map((f) => f.path);
    } catch {
      // verifyLog reports structural problems itself
    }
    const submission = paths
      .map((p) => ({ path: p, abs: path.join(folder.uri.fsPath, ...p.split('/')) }))
      .filter((p) => fs.existsSync(p.abs))
      .map((p) => ({ path: p.path, content: new Uint8Array(fs.readFileSync(p.abs)) }));
    return verifyLog(bytes, { submission, anchorVerifier: this.anchorVerifier() });
  }

  private async cmdVerify(): Promise<void> {
    const folder = await this.pickFolder((_, f) => hasConfig(f.uri.fsPath), "Verify which folder's log?");
    if (!folder) {
      void vscode.window.showInformationMessage('TAP-CC-ONE: no recorded folder is open.');
      return;
    }
    const report = await this.verifyFolder(folder);
    if (!report) {
      void vscode.window.showWarningMessage(`TAP-CC-ONE: "${folder.name}" has no log yet.`);
      return;
    }
    this.log.info(`Verification of ${folder.name}: ${report.verdict}`);
    for (const f of report.findings) {
      this.log.info(`  [${f.severity}] ${f.code}${f.seq !== undefined ? ` @${f.seq}` : ''}: ${f.message}`);
    }
    const composition = report.composition;
    if (composition && composition.nonWs > 0) {
      const parts = Object.entries(composition.byOrigin)
        .map(([origin, c]) => `${origin} ${((100 * (c?.nonWs ?? 0)) / composition.nonWs).toFixed(1)}%`)
        .join(', ');
      this.log.info(`  composition (non-whitespace): ${parts}`);
    }
    const summary = `${report.verdict.replace(/_/g, ' ')} — ${report.recordCount} records, ${report.stats.sessions} session(s)`;
    const show =
      report.verdict === 'NOT_INTACT' ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
    const choice = await show(
      `TAP-CC-ONE: "${folder.name}" log is ${summary}.`,
      'Open Viewer',
      'Show details',
    );
    if (choice === 'Show details') this.log.show(true);
    if (choice === 'Open Viewer') this.showViewer(folder);
  }

  private async cmdView(): Promise<void> {
    const folder = await this.pickFolder((_, f) => hasConfig(f.uri.fsPath), "View which folder's log?");
    if (!folder) {
      void vscode.window.showInformationMessage('TAP-CC-ONE: no recorded folder is open.');
      return;
    }
    this.showViewer(folder);
  }

  private async cmdTimestampNow(): Promise<void> {
    const folder = await this.pickFolder(
      (s) => s?.status === 'recording' || s?.status === 'paused',
      'Timestamp which folder?',
    );
    if (!folder) {
      void vscode.window.showInformationMessage('TAP-CC-ONE: no folder is being recorded.');
      return;
    }
    if (
      !anchorConfig().enabled ||
      !vscode.workspace.getConfiguration('tap', folder.uri).get('anchoring.enabled', true)
    ) {
      void vscode.window.showWarningMessage(
        'TAP-CC-ONE: timestamping is turned off (setting "tap.anchoring.enabled").',
      );
      return;
    }
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'TAP-CC-ONE: getting independent timestamps…',
      },
      () => this.session(folder)!.timestampNow(EXPORT_WAIT_MS),
    );
    if (result.written > 0) {
      void vscode.window.showInformationMessage(
        `TAP-CC-ONE: your work so far is timestamped by ${result.written} independent service(s).`,
      );
    } else {
      void vscode.window.showWarningMessage(
        'TAP-CC-ONE: no timestamp service answered (offline?). The request is queued and will be sent when you are back online.',
      );
    }
  }

  /** Builds the submission zip of a recorded folder (also used by tests). */
  async exportFolder(
    folder: vscode.WorkspaceFolder,
  ): Promise<{ zip: Uint8Array; name: string; report: VerifyReport }> {
    const session = this.session(folder);
    const active = session?.status === 'recording' || session?.status === 'paused';
    if (active) {
      await session.flush();
      const ck = await session.anchorLatest({ force: true });
      if (ck && session.logIdHex) {
        this.anchors.upgradeNow(session.logIdHex);
        await this.anchors.waitFor(session.logIdHex, ck.s, EXPORT_WAIT_MS);
      }
      await session.flush({ sweep: false });
    }
    const logPath = path.join(folder.uri.fsPath, '.tap', 'log.codelog');
    const log = new Uint8Array(fs.readFileSync(logPath));
    const files = await workspaceFiles(folder.uri.fsPath);
    const report = verifyLog(log, { submission: files, anchorVerifier: this.anchorVerifier() });
    const { zip, name } = buildSubmissionZip({
      folderName: folder.name,
      extensionVersion: this.version,
      log,
      files,
      report,
      now: new Date(),
    });
    return { zip, name, report };
  }

  private async cmdExport(): Promise<void> {
    const folder = await this.pickFolder((_, f) => hasConfig(f.uri.fsPath), 'Export which folder?');
    if (!folder) {
      void vscode.window.showInformationMessage('TAP-CC-ONE: no recorded folder is open.');
      return;
    }
    await vscode.workspace.saveAll(false);
    let result: Awaited<ReturnType<Controller['exportFolder']>>;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `TAP-CC-ONE: exporting "${folder.name}" (timestamping, up to 30 seconds)…`,
        },
        () => this.exportFolder(folder),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`TAP-CC-ONE could not export "${folder.name}": ${String(e)}`);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: 'Save the submission',
      defaultUri: vscode.Uri.file(path.join(path.dirname(folder.uri.fsPath), result.name)),
      filters: { 'Zip archive': ['zip'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, result.zip);
    const a = result.report.anchoring;
    const stamped =
      a && a.anchoredCheckpoints > 0
        ? `independently timestamped (${Math.floor(a.coverage * 100)}% of edits)`
        : 'not independently timestamped yet (offline?)';
    const verdict = result.report.verdict.replace(/_/g, ' ').toLowerCase();
    const show =
      result.report.verdict === 'NOT_INTACT'
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
    const choice = await show(
      `TAP-CC-ONE: saved ${path.basename(target.fsPath)}. Log ${verdict}, ${stamped}. Submit this zip.`,
      'Show in Folder',
    );
    if (choice === 'Show in Folder') await vscode.commands.executeCommand('revealFileInOS', target);
  }

  private async cmdOpenLogFile(uri?: vscode.Uri): Promise<void> {
    let file = uri;
    if (!file) {
      const picked = await vscode.window.showOpenDialog({
        title: 'Open a TAP-CC-ONE log or submission',
        canSelectMany: false,
        filters: { 'TAP-CC-ONE submission or log': ['zip', 'codelog'] },
      });
      file = picked?.[0];
    }
    if (!file) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const name = path.basename(file.fsPath);
      let log: Uint8Array;
      let submission: SubmittedFile[];
      let comparedWith: string;
      if (name.toLowerCase().endsWith('.zip')) {
        const opened = readSubmissionZip(bytes);
        log = opened.log;
        submission = opened.files;
        comparedWith = 'the code in the zip';
      } else {
        log = bytes;
        const dir = path.dirname(file.fsPath);
        submission = filesNextTo(log, path.basename(dir) === '.tap' ? path.dirname(dir) : dir);
        comparedWith = 'the files next to the log';
      }
      ViewerPanel.showFixed(
        {
          key: file.toString(),
          title: name.replace(/\.(zip|codelog)$/i, ''),
          bytes: log,
          submission,
          comparedWith,
        },
        { extensionUri: this.context.extensionUri, log: this.log, flush: async () => {} },
      );
    } catch (e) {
      void vscode.window.showErrorMessage(
        `TAP-CC-ONE could not open ${path.basename(file.fsPath)}: ${String(e)}`,
      );
    }
  }

  private async cmdMenu(): Promise<void> {
    type Item = vscode.QuickPickItem & { command: string };
    const items: Item[] = [];
    const sessions = [...this.sessions.values()];
    const any = (st: SessionStatus) => sessions.some((s) => s.status === st);
    if (any('recording')) items.push({ label: '$(debug-pause) Pause recording', command: 'tap.pause' });
    if (any('paused')) items.push({ label: '$(debug-continue) Resume recording', command: 'tap.resume' });
    if (any('recording') || any('paused')) {
      items.push({ label: '$(note) Add a note to the log', command: 'tap.addNote' });
      items.push({ label: '$(debug-stop) Stop recording', command: 'tap.stop' });
    }
    if (any('recording') || any('paused')) {
      items.push({ label: '$(package) Export for submission (zip)', command: 'tap.export' });
      items.push({ label: '$(watch) Timestamp now', command: 'tap.timestampNow' });
    }
    items.push({ label: '$(history) View log (save history, replay)', command: 'tap.viewLog' });
    items.push({ label: '$(file-zip) Open a log file or submission…', command: 'tap.openLogFile' });
    items.push({ label: '$(verified) Verify log integrity', command: 'tap.verifyCurrent' });
    items.push({ label: '$(key) Show key fingerprint', command: 'tap.showFingerprint' });
    if (
      (vscode.workspace.workspaceFolders ?? []).some(
        (f) => !this.session(f) || this.session(f)?.status === 'stopped',
      )
    ) {
      items.push({ label: '$(record) Start recording a folder', command: 'tap.start' });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'TAP-CC-ONE' });
    if (pick) await vscode.commands.executeCommand(pick.command);
  }
}

function describe(status: SessionStatus): string {
  switch (status) {
    case 'recording':
      return 'recording';
    case 'paused':
      return 'paused';
    case 'read-only':
      return 'not recording here (another window is)';
    case 'error':
      return 'problem';
    default:
      return 'not recording';
  }
}

/** Settings that apply to the shared timestamp queue. */
function anchorConfig(): AnchorConfig {
  const c = vscode.workspace.getConfiguration('tap');
  return {
    enabled: c.get<boolean>('anchoring.enabled', true),
    tsas: c.get<string[]>('anchoring.tsa', DEFAULT_TSAS),
    calendars: c.get<string[]>('anchoring.ots', DEFAULT_CALENDARS),
  };
}

/**
 * HTTP for timestamp requests, with a timeout and a size limit. Node's http/https rather than
 * fetch(): fetch gives up on slow IPv6/IPv4 fallback (seen from Pakistan to FreeTSA), and VS Code
 * applies the user's proxy settings to these modules.
 */
const httpClient: HttpClient = nodeHttpClient({ timeoutMs: HTTP_TIMEOUT_MS, maxBytes: HTTP_MAX_BYTES });

/** For a bare .codelog: the logged files found next to it, to compare with. */
function filesNextTo(log: Uint8Array, dir: string): SubmittedFile[] {
  let paths: string[] = [];
  try {
    const r = new Replayer();
    for (const e of readLog(log).records) r.apply(e.record);
    paths = r.liveFiles().map((f) => f.path);
  } catch {
    return [];
  }
  return paths
    .map((p) => ({ path: p, abs: path.join(dir, ...p.split('/')) }))
    .filter((p) => fs.existsSync(p.abs) && fs.statSync(p.abs).isFile())
    .map((p) => ({ path: p.path, content: new Uint8Array(fs.readFileSync(p.abs)) }));
}
