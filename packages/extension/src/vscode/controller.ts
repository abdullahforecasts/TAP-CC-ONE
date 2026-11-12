/**
 * Extension-level wiring: one FolderSession per recorded workspace folder, commands, status bar
 * and prompts (design §11.4, §11.8).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
  type AiChoice,
  type AnchorVerifier,
  type Asset,
  type AttachmentRef,
  compareVersions,
  type KeyPair,
  keyFingerprint,
  type RecordingMode,
  Replayer,
  readLog,
  type SubmittedFile,
  sha256,
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
import { ASSET_HASH_MAX, scanAssets } from '../storage/assets.js';
import {
  createConfig,
  createMatcher,
  type FolderPolicy,
  hasConfig,
  loadConfig,
} from '../storage/folderConfig.js';
import { loadOrCreateKey } from '../storage/keystore.js';
import { walkFiles } from '../storage/walk.js';
import { buildSubmissionZip, readSubmissionZip } from './exportZip.js';
import { FolderSession, type SessionStatus, type SettingWrite } from './folderSession.js';
import { ViewerPanel } from './viewerPanel.js';
import { workspaceFiles } from './workspaceFiles.js';

const NEVER_KEY = 'tap.neverAsk';
const DISABLED_KEY = 'tap.disabled';
const PAUSED_KEY = 'tap.paused';
const KEY_NOTICE_KEY = 'tap.keyFileNoticeShown';
/** Folder → the student's answer to "turn off AI features while recording?" (G4). */
const AI_CHOICE_KEY = 'tap.aiChoice';
/** Recording mode chosen per folder (0.3.4). */
const MODE_KEY = 'tap.mode';
/** Settings exam mode changed per folder, with the values they replaced. */
const WRITES_KEY = 'tap.settingWrites';
/** At most this much of images, PDFs... goes into an export. */
const EXPORT_ATTACHMENTS_MAX = 50 * 1024 * 1024;
/** How long after exam mode starts to check that AI is really off. */
const AI_CHECK_DELAY_MS = 3000;
const UPDATE_CHECK_KEY = 'tap.lastUpdateCheck';
const RELEASES_API = 'https://api.github.com/repos/abdullahforecasts/TAP-CC-ONE/releases/latest';
const RELEASES_PAGE = 'https://github.com/abdullahforecasts/TAP-CC-ONE/releases/latest';
/** Folders with more tracked files than this get a "too broad?" warning (B7). */
const BROAD_FOLDER_FILES = 200;
/** Languages whose files are code (an outside file in one of these gets a warning, B1). */
const NON_CODE_LANGUAGES = new Set([
  'plaintext',
  'log',
  'markdown',
  'json',
  'jsonc',
  'ignore',
  'properties',
  'csv',
]);
/** Longest a timestamp request may take, and the largest answer accepted. */
const HTTP_TIMEOUT_MS = 20_000;
const HTTP_MAX_BYTES = 1024 * 1024;
/** How long export waits for timestamps of its final checkpoint (design §9.4). */
const EXPORT_WAIT_MS = 30_000;

export class Controller implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly sessions = new Map<string, FolderSession>();
  private readonly status: vscode.StatusBarItem;
  /** "Not recorded" warning when the active editor is outside every recorded folder (B1). */
  private readonly outsideStatus: vscode.StatusBarItem;
  private readonly warnedOutside = new Set<string>();
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
    this.outsideStatus = vscode.window.createStatusBarItem('tap.outside', vscode.StatusBarAlignment.Left, 99);
    this.outsideStatus.name = 'TAP-CC-ONE: file not recorded';
    this.outsideStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.outsideStatus.command = 'tap.showMenu';
    this.disposables.push(this.log, this.status, this.outsideStatus);
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
    reg('tap.chooseMode', () => this.cmdChooseMode());
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
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.checkOutsideEditor()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEditOutside(e)),
    );
    for (const folder of vscode.workspace.workspaceFolders ?? []) await this.openFolder(folder);
    this.anchors.start();
    this.updateStatus();
    this.checkOutsideEditor();
    void this.checkForUpdate();
  }

  // ------------------------------------------------------------------------------------------
  // Warnings that keep recordings complete (0.3.3)
  // ------------------------------------------------------------------------------------------

  /** Warns when the active editor holds code that no recorded folder contains (B1). */
  checkOutsideEditor(): void {
    const recording = [...this.sessions.values()].filter(
      (s) => s.status === 'recording' || s.status === 'paused',
    );
    const doc = vscode.window.activeTextEditor?.document;
    const outside =
      recording.length > 0 &&
      doc !== undefined &&
      (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') &&
      !NON_CODE_LANGUAGES.has(doc.languageId) &&
      !recording.some((s) => s.relOf(doc.uri) !== undefined || isInside(s.root, doc.uri));
    if (!outside || !doc) {
      this.outsideStatus.hide();
      return;
    }
    const untitled = doc.uri.scheme === 'untitled';
    const name = untitled ? 'This unsaved editor' : `"${path.basename(doc.uri.fsPath)}"`;
    const folders = recording.map((s) => `"${s.name}"`).join(', ');
    this.outsideStatus.text = '$(warning) TAP: not recording this file';
    this.outsideStatus.tooltip = `${name} is outside the recorded folder ${folders}: what you type here is NOT recorded.`;
    this.outsideStatus.show();
  }

  /** The first edit of a code file outside every recorded folder: a dialog, once per file (0.3.5). */
  private onEditOutside(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (e.contentChanges.length === 0) return;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;
    if (NON_CODE_LANGUAGES.has(doc.languageId)) return;
    const recording = [...this.sessions.values()].filter(
      (s) => s.status === 'recording' || s.status === 'paused',
    );
    if (
      recording.length === 0 ||
      recording.some((s) => s.relOf(doc.uri) !== undefined || isInside(s.root, doc.uri))
    )
      return;
    const key = doc.uri.toString();
    if (this.warnedOutside.has(key)) return;
    this.warnedOutside.add(key);
    const untitled = doc.uri.scheme === 'untitled';
    const name = untitled ? 'This unsaved editor' : `"${path.basename(doc.uri.fsPath)}"`;
    const folders = recording.map((s) => `"${s.name}"`).join(', ');
    void vscode.window.showWarningMessage(
      untitled
        ? `TAP-CC-ONE: typing in an unsaved editor is NOT recorded. Save the file inside the recorded folder ${folders} first.`
        : `TAP-CC-ONE: ${name} is outside the recorded folder ${folders}, so what you type in it is NOT recorded. Move it into the recorded folder, or open and record the folder that contains it.`,
      { modal: true },
    );
  }

  /** Asks once a day whether a newer release exists (B2). */
  private async checkForUpdate(): Promise<void> {
    if (!vscode.workspace.getConfiguration('tap').get<boolean>('checkForUpdates', true)) return;
    const last = this.context.globalState.get<number>(UPDATE_CHECK_KEY) ?? 0;
    if (Date.now() - last < 24 * 3600_000) return;
    await this.context.globalState.update(UPDATE_CHECK_KEY, Date.now());
    try {
      const res = await httpClient(RELEASES_API, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tap-cc-one-extension' },
      });
      if (res.status !== 200) return;
      const tag = String(
        (JSON.parse(new TextDecoder().decode(res.body)) as { tag_name?: string }).tag_name ?? '',
      );
      const latest = tag.replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(latest) || compareVersions(latest, this.version) <= 0) return;
      const choice = await vscode.window.showInformationMessage(
        `TAP-CC-ONE ${latest} is available (you have ${this.version}). Teachers may need logs from the latest version.`,
        'Open release page',
      );
      if (choice) await vscode.env.openExternal(vscode.Uri.parse(RELEASES_PAGE));
    } catch (e) {
      this.log.info(`update check skipped: ${String(e)}`);
    }
  }

  /** Warns when the folder looks much broader than an assignment (B7). */
  private async warnIfBroad(folder: vscode.WorkspaceFolder): Promise<void> {
    const root = folder.uri.fsPath;
    const home = os.homedir();
    const name = path.basename(root).toLowerCase();
    const special =
      path.resolve(root) === path.resolve(home) ||
      (path.dirname(path.resolve(root)) === path.resolve(home) &&
        ['desktop', 'documents', 'downloads', 'onedrive'].includes(name));
    let count = 0;
    try {
      const config = loadConfig(root).config;
      count = (await walkFiles(root, createMatcher(config), { limit: BROAD_FOLDER_FILES + 1 })).length;
    } catch {
      return;
    }
    if (!special && count <= BROAD_FOLDER_FILES) return;
    void vscode.window.showWarningMessage(
      `TAP-CC-ONE is recording "${folder.name}"${special ? ', a whole personal folder' : ` with more than ${BROAD_FOLDER_FILES} files`}. Record only the assignment's folder: open that folder in VS Code and start recording there.`,
    );
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
    const session = await this.startSession(folder);
    void this.warnIfBroad(folder);
    return session;
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
      globalStorage: this.context.globalStorageUri.fsPath,
      log: this.log,
      anchors: this.anchors,
      rememberWrite: (w) => {
        const all = this.context.workspaceState.get<Record<string, SettingWrite[]>>(WRITES_KEY) ?? {};
        const list = all[id] ?? [];
        // Keep the value from before TAP's first change: that is what practice mode puts back.
        if (list.some((x) => x.section === w.section && x.key === w.key && x.target === w.target)) return;
        void this.context.workspaceState.update(WRITES_KEY, { ...all, [id]: [...list, w] });
      },
      onToolsAdded: (s, ids) => void this.onToolsAdded(folder, s, ids),
      onStrayFile: (s, rel) => void this.onStrayFile(folder, s, rel),
      takeWrites: () => {
        const all = this.context.workspaceState.get<Record<string, SettingWrite[]>>(WRITES_KEY) ?? {};
        const list = all[id] ?? [];
        void this.context.workspaceState.update(WRITES_KEY, { ...all, [id]: [] });
        return list;
      },
      onStatusChange: () => {
        this.updateStatus();
        // Remember pause across window reloads; stopping (including on reload) does not clear it.
        if (session.status === 'paused' || session.status === 'recording') {
          void this.rememberPaused(folder, session.status === 'paused');
        }
      },
    });
    this.sessions.set(id, session);
    let teacher: FolderPolicy | undefined;
    try {
      teacher = loadConfig(folder.uri.fsPath).config.policy;
    } catch {
      // start() reports a broken config
    }
    const mode = teacher ? (teacher.ai === 'off' ? 'exam' : 'practice') : await this.modeFor(folder);
    const aiChoice: AiChoice = teacher
      ? teacher.ai === 'off'
        ? 'enforced-off'
        : teacher.ai === 'on'
          ? 'on'
          : 'unanswered'
      : mode === 'exam'
        ? 'off'
        : 'on';
    await session.start({ paused: this.hasFolderFlag(PAUSED_KEY, folder), aiChoice, mode });
    if ((session.status === 'recording' || session.status === 'paused') && mode === 'exam') {
      // Some AI settings take a moment to apply: check that AI really is off.
      setTimeout(() => void this.warnIfAiStillOn(folder, session), AI_CHECK_DELAY_MS);
    }
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

  /**
   * The folder's recording mode: the one chosen before, else asked once (0.3.4). Exam mode is the
   * default and is used when the question is dismissed.
   */
  private async modeFor(folder: vscode.WorkspaceFolder): Promise<RecordingMode> {
    const id = folder.uri.toString();
    const modes = this.context.workspaceState.get<Record<string, RecordingMode>>(MODE_KEY) ?? {};
    if (modes[id]) return modes[id];
    // 0.3.3 asked about AI instead: keep that answer.
    const old = this.context.workspaceState.get<Record<string, string>>(AI_CHOICE_KEY)?.[id];
    const preset = vscode.workspace.getConfiguration('tap', folder.uri).get<string>('defaultMode', 'ask');
    let mode: RecordingMode;
    if (old === 'on' || old === 'off') mode = old === 'on' ? 'practice' : 'exam';
    else if (preset === 'exam' || preset === 'practice') mode = preset;
    else mode = (await this.askMode(folder.name, 'exam')) ?? 'exam';
    await this.context.workspaceState.update(MODE_KEY, { ...modes, [id]: mode });
    return mode;
  }

  private async askMode(name: string, current: RecordingMode): Promise<RecordingMode | undefined> {
    type Item = vscode.QuickPickItem & { mode: RecordingMode };
    const items: Item[] = [
      {
        mode: 'exam',
        label: `$(mortar-board) Exam mode${current === 'exam' ? ' (current)' : ''}`,
        description: 'recommended',
        detail:
          'AI features and code suggestions are turned off for this folder and the TAP settings are locked.',
      },
      {
        mode: 'practice',
        label: `$(beaker) Practice mode${current === 'practice' ? ' (current)' : ''}`,
        detail: 'AI features and suggestions stay as they are. The log records when AI was available.',
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `TAP-CC-ONE: how should "${name}" be recorded?`,
      placeHolder: 'The mode is written in the log. You can switch later from the TAP status bar menu.',
      ignoreFocusOut: true,
    });
    return pick?.mode;
  }

  /**
   * Exam mode: tells the student, in the middle of the window, when extensions it turned off are
   * still running (they stop after a window reload) or AI is still on, and how to fix it.
   */
  private async warnIfAiStillOn(folder: vscode.WorkspaceFolder, session: FolderSession): Promise<void> {
    if (session.status !== 'recording' && session.status !== 'paused') return;
    const running = session.blockedStillRunning();
    if (running.length > 0) {
      const reload = 'Reload Window';
      const answer = await vscode.window.showWarningMessage(
        `TAP-CC-ONE exam mode turned off ${running.join(', ')} for "${folder.name}". Reload the window to finish turning ${running.length === 1 ? 'it' : 'them'} off; until then the log records that AI or another terminal could be used.`,
        { modal: true },
        reload,
      );
      if (answer === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    if (!session.aiStillOn()) return;
    const open = 'Open AI settings';
    const answer = await vscode.window.showWarningMessage(
      `TAP-CC-ONE: exam mode could not turn off every AI feature for "${folder.name}". The log records that AI was available. Turn on "Disable AI Features" (chat.disableAIFeatures) and turn off any AI extension.`,
      { modal: true },
      open,
    );
    if (answer === open) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'disableAIFeatures');
    }
  }

  /** An AI or terminal extension was installed or enabled while recording (0.3.5). */
  private async onToolsAdded(
    folder: vscode.WorkspaceFolder,
    session: FolderSession,
    ids: string[],
  ): Promise<void> {
    if (session.mode !== 'exam') return;
    await session.blockExtensions();
    await vscode.window.showWarningMessage(
      `TAP-CC-ONE: ${ids.join(', ')} was installed or enabled while "${folder.name}" is recorded in exam mode. This is written in the log, and exam mode turns ${ids.length === 1 ? 'it' : 'them'} off.`,
      { modal: true },
    );
    await this.warnIfAiStillOn(folder, session);
  }

  /** A file appeared in .tap/ or in a folder TAP does not record (0.3.5). */
  private async onStrayFile(
    folder: vscode.WorkspaceFolder,
    session: FolderSession,
    rel: string,
  ): Promise<void> {
    const move = 'Move it into the folder';
    const tap = rel.startsWith('.tap/');
    const answer = await vscode.window.showWarningMessage(
      `TAP-CC-ONE: "${rel}" is in ${tap ? "TAP's own folder (.tap)" : 'a folder TAP does not record'}, so what you write in it is NOT recorded and it is not exported as code. The log notes that it is there.`,
      { modal: true },
      move,
    );
    if (answer !== move) return;
    const moved = session.moveIntoFolder(rel);
    if (!moved) return;
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folder.uri.fsPath, moved)),
      );
      await vscode.window.showTextDocument(doc);
    } catch (e) {
      this.log.warn(`could not open ${moved}: ${String(e)}`);
    }
  }

  /** Switches a recorded folder between exam and practice mode (0.3.4). */
  private async cmdChooseMode(): Promise<void> {
    const folder = await this.pickFolder(
      (s) => s?.status === 'recording' || s?.status === 'paused',
      'Change the mode of which folder?',
    );
    const session = folder ? this.session(folder) : undefined;
    if (!folder || !session) {
      void vscode.window.showInformationMessage('TAP-CC-ONE: no folder is being recorded.');
      return;
    }
    if (session.modeLocked) {
      void vscode.window.showInformationMessage(
        `TAP-CC-ONE: the mode of "${folder.name}" is set by the teacher (.tap/config.json) and cannot be changed.`,
      );
      return;
    }
    const mode = await this.askMode(folder.name, session.mode);
    if (!mode || mode === session.mode) return;
    if (mode === 'practice') {
      const ok = await vscode.window.showWarningMessage(
        `Switch "${folder.name}" to practice mode? AI features and suggestions will be allowed again. The switch is written in the log.`,
        { modal: true },
        'Switch to practice mode',
      );
      if (!ok) return;
    }
    await session.setMode(mode);
    const id = folder.uri.toString();
    const modes = this.context.workspaceState.get<Record<string, RecordingMode>>(MODE_KEY) ?? {};
    await this.context.workspaceState.update(MODE_KEY, { ...modes, [id]: mode });
    this.updateStatus();
    if (mode === 'exam') setTimeout(() => void this.warnIfAiStillOn(folder, session), 3000);
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
    const active = sessions.filter((s) => s.status === 'recording' || s.status === 'paused');
    const lines = sessions.map(
      (s) =>
        `${s.name}: ${describe(s.status)}${s.status === 'recording' || s.status === 'paused' ? `, ${s.mode} mode${s.modeLocked ? ' (set by the teacher)' : ''}` : ''}${s.detail && (s.status === 'error' || s.status === 'read-only') ? ` (${s.detail})` : ''}`,
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
    const modes = new Set(active.map((s) => s.mode));
    if (modes.size === 1) text += modes.has('exam') ? ' · Exam' : ' · Practice';
    const waiting = sessions.reduce((n, s) => n + (s.logIdHex ? this.anchors.outstanding(s.logIdHex) : 0), 0);
    if (waiting > 0) {
      text += ` ⧗${waiting}`;
      lines.push(`${waiting} timestamp(s) waiting to be sent or written (offline?)`);
    }
    this.checkOutsideEditor();
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
    const { attachments, skipped } = this.attachmentsOf(folder, session);
    const report = verifyLog(log, { submission: files, attachments, anchorVerifier: this.anchorVerifier() });
    const { zip, name } = buildSubmissionZip({
      folderName: folder.name,
      extensionVersion: this.version,
      log,
      files,
      attachments,
      skipped,
      report,
      now: new Date(),
    });
    return { zip, name, report };
  }

  /** Images, PDFs and other files that are not code, to ship with the export (0.3.4). */
  private attachmentsOf(
    folder: vscode.WorkspaceFolder,
    session: FolderSession | undefined,
  ): { attachments: SubmittedFile[]; skipped: string[] } {
    const root = folder.uri.fsPath;
    let assets: Asset[] = session?.currentAssets() ?? [];
    if (!session || (session.status !== 'recording' && session.status !== 'paused')) {
      try {
        const matcher = createMatcher(loadConfig(root).config);
        assets = scanAssets(root, (rel) => matcher(rel));
      } catch {
        assets = [];
      }
    }
    const attachments: SubmittedFile[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const a of assets) {
      if (a.n > ASSET_HASH_MAX || total + a.n > EXPORT_ATTACHMENTS_MAX) {
        skipped.push(a.p);
        continue;
      }
      try {
        const content = new Uint8Array(fs.readFileSync(path.join(root, ...a.p.split('/'))));
        attachments.push({ path: a.p, content });
        total += content.length;
      } catch {
        skipped.push(a.p);
      }
    }
    return { attachments, skipped };
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
    // B1: a log without code edits usually means the code was written outside the folder.
    const codeChars = result.report.composition?.nonWs ?? 0;
    if (result.report.stats.changes === 0 || codeChars === 0) {
      const go = await vscode.window.showWarningMessage(
        `TAP-CC-ONE: the log of "${folder.name}" has no edits to code files. Did you write your code in a file outside the recorded folder? Such work is not in the log.`,
        { modal: true },
        'Export anyway',
      );
      if (go !== 'Export anyway') return;
    }
    // B3: timestamps still queued (offline) would leave the end of the work without them.
    const logId = this.session(folder)?.logIdHex;
    while (logId && this.anchors.outstanding(logId) > 0) {
      const left = this.anchors.outstanding(logId);
      const go = await vscode.window.showWarningMessage(
        `TAP-CC-ONE: ${left} timestamp request(s) are still waiting to be sent (are you offline?). If you export now, the latest part of your work has no independent timestamp. Connect to the internet and choose "Try again".`,
        { modal: true },
        'Try again',
        'Export anyway',
      );
      if (go === 'Export anyway') break;
      if (go !== 'Try again') return;
      try {
        result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'TAP-CC-ONE: sending queued timestamps (up to 30 seconds)…',
          },
          async () => {
            await this.anchors.waitForAll(logId, EXPORT_WAIT_MS);
            return this.exportFolder(folder);
          },
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`TAP-CC-ONE could not export "${folder.name}": ${String(e)}`);
        return;
      }
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
      `TAP-CC-ONE: saved ${path.basename(target.fsPath)}. Log ${verdict}, ${stamped}. Submit this zip as it is (do not unzip or re-zip it).`,
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
      let attachments: AttachmentRef[] | undefined;
      if (name.toLowerCase().endsWith('.zip')) {
        const opened = readSubmissionZip(bytes);
        log = opened.log;
        submission = opened.files;
        comparedWith = 'the code in the zip';
        attachments = opened.attachments.map((a) => ({
          path: a.path,
          sha256: sha256(typeof a.content === 'string' ? new TextEncoder().encode(a.content) : a.content),
        }));
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
          ...(attachments ? { attachments } : {}),
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
      const current = sessions.find((s) => s.status === 'recording' || s.status === 'paused');
      items.push({
        label: `$(mortar-board) Mode: ${current?.mode === 'practice' ? 'Practice' : 'Exam'}${current?.modeLocked ? ' (set by the teacher)' : ' — change…'}`,
        command: 'tap.chooseMode',
      });
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

/** Whether a URI is a file inside `root` (tracked or not). */
function isInside(root: string, uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') return false;
  const rel = path.relative(root, uri.fsPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

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
