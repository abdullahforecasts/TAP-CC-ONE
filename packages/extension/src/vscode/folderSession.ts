/**
 * Connects one workspace folder to a Recorder: VS Code events in, log bytes out (design §11).
 * Everything here is thin glue; the behaviour lives in recorder/ and storage/.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type AiChoice,
  type AiState,
  type Asset,
  type KeyPair,
  type OpenItem,
  type RecordingMode,
  toHex,
  toLogPath,
} from '@tap/core';
import * as vscode from 'vscode';
import type { AnchorService, AnchorSink } from '../anchoring/anchorService.js';
import type { EditReason } from '../recorder/classify.js';
import {
  AI_OFF_SETTINGS,
  detectAiExtensions,
  LIVE_SHARE_ID,
  normaliseAppName,
  SUGGESTIONS_OFF_SETTINGS,
} from '../recorder/environment.js';
import {
  type CheckpointInfo,
  type DiskRead,
  Recorder,
  type RecorderHost,
  type RecorderOptions,
  type RecorderState,
} from '../recorder/recorder.js';
import { cleanTerminalOutput, maskCommand, programName } from '../recorder/terminal.js';
import { ASSET_SCAN_MAX, describeAsset, sameAsset, scanAssets } from '../storage/assets.js';
import { readTrackedFile } from '../storage/diskReader.js';
import {
  createMatcher,
  DEFAULT_POLICY,
  type FolderPolicy,
  type LoadedConfig,
  loadConfig,
  TAP_DIR,
} from '../storage/folderConfig.js';
import { FolderLock, LOCK_HEARTBEAT_MS } from '../storage/lock.js';
import { type OpenedLog, openLog } from '../storage/logStore.js';
import { walkFiles } from '../storage/walk.js';
import { currentAiState, editorSettings, userCustomizations } from './editorEnv.js';
import { currentOpenItems } from './openItems.js';

export type SessionStatus = RecorderState | 'read-only' | 'error';

export interface SessionContext {
  extensionVersion: string;
  key: KeyPair;
  mirrorDir: string;
  sessionId: string;
  /** The extension's global storage folder (to find the user's snippets and keybindings). */
  globalStorage?: string;
  log: vscode.LogOutputChannel;
  onStatusChange: () => void;
  /** Shared timestamp queue (absent in some tests). */
  anchors?: AnchorService;
  /** Remembers a setting TAP changed (exam mode), so practice mode can put it back. */
  rememberWrite?: (write: SettingWrite) => void;
  /** Returns and forgets the settings TAP changed. */
  takeWrites?: () => SettingWrite[];
}

const TICK_MS = 15_000;
const VCS_WINDOW_MS = 5_000;
/** Raw terminal output read per command before cleaning (the stored output is capped at 64 Ki). */
const MAX_RAW_OUTPUT = 512 * 1024;
/** How long a new terminal may take to report shell integration before it counts as unmonitored. */
const SHELL_INTEGRATION_WAIT_MS = 5_000;
/** Debounce for the list of things open outside the folder. */
const OPEN_DEBOUNCE_MS = 1_000;
/** Wait before recording a change to an image, PDF... (they are often written in several steps). */
const ASSET_DEBOUNCE_MS = 1_500;

/** The rules exam mode applies (0.3.4): the same as a strict teacher policy. */
export const EXAM_POLICY: FolderPolicy = {
  ai: 'off',
  suggestions: 'off',
  lockSettings: true,
  requireShellIntegration: true,
};

/** A setting TAP changed, with the value it replaced (undefined: it was not set there). */
export interface SettingWrite {
  section: string;
  key: string;
  target: vscode.ConfigurationTarget;
  before: unknown;
}

const TARGET_NAME: Record<number, string> = { 1: 'user level', 2: 'workspace level', 3: 'folder level' };

function inspectAt(
  info: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined,
  target: vscode.ConfigurationTarget,
): unknown {
  if (!info) return undefined;
  if (target === vscode.ConfigurationTarget.Global) return info.globalValue;
  if (target === vscode.ConfigurationTarget.Workspace) return info.workspaceValue;
  return info.workspaceFolderValue;
}

/** The TAP settings a session records, as the user set them. */
const TAP_SETTING_KEYS: ReadonlyArray<[key: string, fallback: boolean | number]> = [
  ['record.focus', true],
  ['classify.clipboardCheckMinChars', 2],
  ['classify.bulkMinChars', 40],
  ['checkpoint.intervalSec', 300],
  ['anchoring.enabled', true],
  ['record.terminalCommands', true],
];

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
  private policy: FolderPolicy = DEFAULT_POLICY;
  /** Exam or practice (0.3.4); the teacher's policy, when there is one, decides instead. */
  private modeValue: RecordingMode = 'exam';
  /** Files that are not recorded as text, as last recorded (0.3.4). */
  private readonly assets = new Map<string, Asset>();
  private readonly assetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastAi = '';
  private lastOpen = '[]';
  private lastEditor = '';
  private lastSettings = '';
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  /** Shell integration per terminal: true once reported, false after the wait without it. */
  private readonly shellIntegration = new Map<vscode.Terminal, boolean>();
  private readonly outputs = new Map<unknown, { chunks: string[]; size: number; done: Promise<void> }>();

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
  async start(options: { paused: boolean; aiChoice?: AiChoice; mode?: RecordingMode }): Promise<void> {
    if (this.recorder) return;
    try {
      this.config = loadConfig(this.root);
      this.matcher = createMatcher(this.config.config);
      if (options.mode) this.modeValue = options.mode;
      this.policy = this.effectivePolicy();
      await this.applyPolicy();

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

      const tap = this.tapSettings();
      const recorderSettings = {
        recordFocus: tap['tap.record.focus'] !== false,
        clipboardCheckMinChars: Number(tap['tap.classify.clipboardCheckMinChars']),
        bulkMinChars: Number(tap['tap.classify.bulkMinChars']),
        checkpointIntervalMs: Number(tap['tap.checkpoint.intervalSec']) * 1000,
      };
      const env = this.environment();
      this.lastEnv = JSON.stringify([env.aiExt, env.liveShare]);
      const ai = currentAiState(this.folder.uri);
      this.lastAi = JSON.stringify(ai);
      const editor = this.editorEnvironment();
      this.lastEditor = JSON.stringify(editor);
      this.lastSettings = JSON.stringify(tap);
      const policy = this.config.config.policy;
      this.assets.clear();
      let assets: Asset[] = [];
      try {
        assets = scanAssets(this.root, (rel) => this.matcher(rel));
      } catch (e) {
        this.ctx.log.warn(`${this.name}: could not list the folder's other files: ${String(e)}`);
      }
      for (const a of assets) this.assets.set(a.p, a);
      const options2: RecorderOptions = {
        writer: this.opened.writer,
        sink: this.opened.store,
        host: this.createHost(),
        key: this.ctx.key,
        env: {
          ...env,
          cfgHash: this.config.hash,
          settings: tap,
          ai,
          editor,
          ...(options.aiChoice ? { aiChoice: options.aiChoice } : {}),
          mode: this.mode,
          ...(assets.length > 0 ? { assets } : {}),
          ...(policy
            ? {
                policy: {
                  ai: policy.ai,
                  suggestions: policy.suggestions,
                  lockSettings: policy.lockSettings,
                  requireShellIntegration: policy.requireShellIntegration,
                },
              }
            : {}),
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
      this.timers.push(
        setInterval(() => {
          this.checkAi();
          void this.recorder?.tick();
        }, TICK_MS),
      );
      this.timers.push(setInterval(() => this.heartbeat(), LOCK_HEARTBEAT_MS));
      for (const t of vscode.window.terminals) this.watchShellIntegration(t);
      this.scheduleOpenItems(0);
      this.startAnchoring();
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
    await this.restoreUserSettings();
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
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = undefined;
    for (const t of this.assetTimers.values()) clearTimeout(t);
    this.assetTimers.clear();
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

  private startAnchoring(): void {
    const anchors = this.ctx.anchors;
    const logId = this.logIdHex;
    if (!anchors || !logId || !this.recorder) return;
    const recorder = this.recorder;
    this.anchorSink = { appendAnchor: (body) => recorder.appendAnchor(body) };
    anchors.register(logId, this.anchorSink);
    anchors.upgradeNow(logId);
    this.lastAnchoredCk = this.opened?.info.lastAnchoredCk ?? -1;
    const settings = vscode.workspace.getConfiguration('tap', this.folder.uri);
    const every = Math.min(900, Math.max(120, settings.get<number>('anchoring.intervalSec', 600))) * 1000;
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
    if (this.tapSettings()['tap.anchoring.enabled'] === false) return undefined;
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

  // ------------------------------------------------------------------------------------------
  // Settings, policy, AI state and what is open outside the folder (0.3.3)
  // ------------------------------------------------------------------------------------------

  /**
   * The TAP settings in effect: the user's values, or the defaults when the teacher's policy locks
   * them. Values the recorder ignores (H2) are listed under "tap.ignored".
   */
  tapSettings(): Record<string, boolean | number | string> {
    const c = vscode.workspace.getConfiguration('tap', this.folder.uri);
    const out: Record<string, boolean | number | string> = {};
    const ignored: string[] = [];
    for (const [key, fallback] of TAP_SETTING_KEYS) {
      const raw = c.get<boolean | number>(key, fallback);
      let value = this.policy.lockSettings ? fallback : raw;
      if (key === 'classify.clipboardCheckMinChars') value = Math.min(2, Math.max(1, Number(value) || 2));
      if (key === 'classify.bulkMinChars') value = Math.min(40, Math.max(2, Number(value) || 40));
      if (key === 'checkpoint.intervalSec') value = Math.min(600, Math.max(60, Number(value) || 300));
      if (value !== raw) ignored.push(`${key}=${String(raw)}`);
      out[`tap.${key}`] = value;
    }
    if (ignored.length > 0) out['tap.ignored'] = ignored.join(', ').slice(0, 500);
    return out;
  }

  private editorEnvironment(): Record<string, boolean | number | string> {
    const env: Record<string, boolean | number | string> = { ...editorSettings(this.folder.uri) };
    if (this.ctx.globalStorage) Object.assign(env, userCustomizations(this.ctx.globalStorage, this.root));
    return env;
  }

  /**
   * The rules in effect: the teacher's policy from .tap/config.json when there is one, otherwise
   * the recording mode (0.3.4). Exam mode turns AI features and code suggestions off, locks the
   * TAP settings and turns terminal shell integration on; practice mode changes nothing.
   */
  private effectivePolicy(): FolderPolicy {
    const teacher = this.config?.config.policy;
    if (teacher) return teacher;
    return this.modeValue === 'exam' ? EXAM_POLICY : DEFAULT_POLICY;
  }

  /** The recording mode in effect ('exam' when the teacher's policy turns AI off). */
  get mode(): RecordingMode {
    const teacher = this.config?.config.policy;
    if (teacher) return teacher.ai === 'off' ? 'exam' : 'practice';
    return this.modeValue;
  }

  /** Whether the teacher's policy decides the mode (the student cannot switch). */
  get modeLocked(): boolean {
    return this.config?.config.policy !== undefined;
  }

  /** Applies the rules in effect to the folder's settings before recording starts (F3, G2, H5). */
  private async applyPolicy(): Promise<void> {
    const changes: Array<[string, string, unknown]> = [];
    if (this.policy.ai === 'off') changes.push(...AI_OFF_SETTINGS);
    if (this.policy.suggestions === 'off') changes.push(...SUGGESTIONS_OFF_SETTINGS);
    if (this.policy.requireShellIntegration) {
      changes.push(['terminal.integrated', 'shellIntegration.enabled', true]);
    }
    await this.writeFolderSettings(changes);
  }

  /**
   * Writes settings for this folder: in its .vscode/settings.json when the setting allows it,
   * else in the workspace, else (AI settings only, which some editors allow only there) in the
   * user settings. Each value replaced is remembered so practice mode can put it back.
   */
  async writeFolderSettings(changes: ReadonlyArray<readonly [string, string, unknown]>): Promise<void> {
    const targets = [
      vscode.ConfigurationTarget.WorkspaceFolder,
      vscode.ConfigurationTarget.Workspace,
      vscode.ConfigurationTarget.Global,
    ];
    for (const [section, key, value] of changes) {
      const c = vscode.workspace.getConfiguration(section, this.folder.uri);
      if (JSON.stringify(c.get(key)) === JSON.stringify(value)) continue;
      const aiSetting = AI_OFF_SETTINGS.some(([s2, k2]) => s2 === section && k2 === key);
      let done = false;
      for (const target of targets) {
        if (target === vscode.ConfigurationTarget.Global && !aiSetting) break;
        const before = inspectAt(c.inspect(key), target);
        try {
          await c.update(key, value, target);
        } catch (e) {
          this.ctx.log.info(
            `${this.name}: ${section}.${key} cannot be set at ${TARGET_NAME[target]}: ${String(e)}`,
          );
          continue;
        }
        this.ctx.rememberWrite?.({ section, key, target, before });
        done = true;
        // A value written there may still be overridden by a narrower one: check what is in effect.
        if (
          JSON.stringify(vscode.workspace.getConfiguration(section, this.folder.uri).get(key)) ===
          JSON.stringify(value)
        )
          break;
      }
      if (!done) this.ctx.log.warn(`${this.name}: could not set ${section}.${key}`);
    }
  }

  /** Puts back the settings exam mode changed (switching to practice mode). */
  private async restoreSettings(): Promise<void> {
    const writes = this.ctx.takeWrites?.() ?? [];
    for (const w of writes.reverse()) {
      try {
        await vscode.workspace.getConfiguration(w.section, this.folder.uri).update(w.key, w.before, w.target);
      } catch (e) {
        this.ctx.log.warn(`${this.name}: could not restore ${w.section}.${w.key}: ${String(e)}`);
      }
    }
  }

  /**
   * Puts back AI settings exam mode had to change in the user settings (they apply to every
   * folder), when recording stops. Folder settings stay: they are re-applied on the next start.
   */
  private async restoreUserSettings(): Promise<void> {
    const writes = this.ctx.takeWrites?.() ?? [];
    for (const w of writes.reverse()) {
      if (w.target !== vscode.ConfigurationTarget.Global) {
        this.ctx.rememberWrite?.(w);
        continue;
      }
      try {
        await vscode.workspace.getConfiguration(w.section, this.folder.uri).update(w.key, w.before, w.target);
      } catch (e) {
        this.ctx.log.warn(`${this.name}: could not restore ${w.section}.${w.key}: ${String(e)}`);
      }
    }
  }

  /** Turns AI features off for this folder (the student's choice or the policy). */
  async turnAiOff(): Promise<void> {
    await this.writeFolderSettings(AI_OFF_SETTINGS);
    this.checkAi();
  }

  /** Whether AI features are still available right now (after exam mode tried to turn them off). */
  aiStillOn(): boolean {
    return currentAiState(this.folder.uri).on;
  }

  /**
   * Switches between exam and practice mode during a session (0.3.4). The switch is recorded;
   * the teacher's policy, when there is one, cannot be switched.
   */
  async setMode(mode: RecordingMode): Promise<boolean> {
    if (this.modeLocked || mode === this.modeValue) return false;
    this.modeValue = mode;
    this.policy = this.effectivePolicy();
    if (mode === 'exam') await this.applyPolicy();
    else await this.restoreSettings();
    this.recorder?.environmentChanged({ mode, aiChoice: mode === 'exam' ? 'off' : 'on' });
    this.checkAi();
    const tap = this.tapSettings();
    const key = JSON.stringify(tap);
    if (key !== this.lastSettings) {
      this.lastSettings = key;
      this.recorder?.environmentChanged({ settings: tap });
    }
    return true;
  }

  /** Records a change to a file that is not recorded as text (0.3.4), after a short wait. */
  private scheduleAsset(rel: string): void {
    if (!this.recorder) return;
    const old = this.assetTimers.get(rel);
    if (old) clearTimeout(old);
    this.assetTimers.set(
      rel,
      setTimeout(() => {
        this.assetTimers.delete(rel);
        if (!this.recorder) return;
        let now: Asset | undefined;
        try {
          now = describeAsset(this.root, rel, (r) => this.matcher(r));
        } catch {
          now = undefined;
        }
        const known = this.assets.get(rel);
        if (!now && known) {
          this.assets.delete(rel);
          this.recorder.environmentChanged({ assets: [{ p: rel, n: known.n, k: known.k, op: 'delete' }] });
        } else if (now && (!known || !sameAsset(now, known))) {
          if (!known && this.assets.size >= ASSET_SCAN_MAX) return;
          this.assets.set(rel, now);
          this.recorder.environmentChanged({ assets: [{ ...now, op: known ? 'change' : 'add' }] });
        }
      }, ASSET_DEBOUNCE_MS),
    );
  }

  /** Files that are not recorded as text, present now (for the export). */
  currentAssets(): Asset[] {
    return [...this.assets.values()];
  }

  /** Records the student's answer to "turn off AI features while recording?" (G4). */
  recordAiChoice(choice: AiChoice): void {
    this.recorder?.environmentChanged({ aiChoice: choice });
  }

  /** Records the AI state when it differs from the last one recorded (G1, G3). */
  checkAi(): void {
    if (!this.recorder) return;
    const ai: AiState = currentAiState(this.folder.uri);
    const key = JSON.stringify(ai);
    if (key === this.lastAi) return;
    this.lastAi = key;
    this.recorder.environmentChanged({ ai });
  }

  /** Records TAP and editor setting changes (H1, F2). */
  private onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    const r = this.recorder;
    if (!r) return;
    const uri = this.folder.uri;
    if (e.affectsConfiguration('tap', uri)) {
      const tap = this.tapSettings();
      const key = JSON.stringify(tap);
      if (key !== this.lastSettings) {
        this.lastSettings = key;
        r.environmentChanged({ settings: tap });
      }
    }
    if (
      ['editor', 'terminal.integrated', 'chat', 'github.copilot'].some((section) =>
        e.affectsConfiguration(section, uri),
      )
    ) {
      const editor = this.editorEnvironment();
      const key = JSON.stringify(editor);
      if (key !== this.lastEditor) {
        this.lastEditor = key;
        r.environmentChanged({ editor });
      }
      this.checkAi();
    }
  }

  /** A terminal counts as unmonitored when it has no shell integration after a few seconds (D6). */
  private watchShellIntegration(terminal: vscode.Terminal): void {
    if (this.shellIntegration.has(terminal)) return;
    const t = terminal as vscode.Terminal & { shellIntegration?: unknown };
    if (t.shellIntegration) {
      this.shellIntegration.set(terminal, true);
      return;
    }
    setTimeout(() => {
      if (!this.recorder || this.shellIntegration.get(terminal) === true) return;
      if (vscode.window.terminals.includes(terminal)) {
        this.shellIntegration.set(terminal, Boolean(t.shellIntegration));
        this.scheduleOpenItems();
      }
    }, SHELL_INTEGRATION_WAIT_MS);
  }

  /** Records the list of things open outside the folder when it changes (F1, D5-D8). */
  private scheduleOpenItems(delay = OPEN_DEBOUNCE_MS): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      this.openTimer = undefined;
      if (!this.recorder) return;
      let items: OpenItem[];
      try {
        items = currentOpenItems(
          (uri) => {
            const rel = this.relOf(uri);
            if (rel === undefined) return this.isTapFile(uri) ? 'recorded' : undefined;
            if (rel.startsWith(`${TAP_DIR}/`) || this.matcher(rel)) return 'recorded';
            return { rel };
          },
          (terminal) => this.shellIntegration.get(terminal),
        );
      } catch (e) {
        this.ctx.log.warn(`${this.name}: could not list open tabs: ${String(e)}`);
        return;
      }
      const key = JSON.stringify(items);
      if (key === this.lastOpen) return;
      this.lastOpen = key;
      this.recorder.environmentChanged({ open: items });
    }, delay);
  }

  /** Files inside this folder that are not tracked (.tap/, excluded files) are not "outside". */
  private isTapFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') return false;
    const rel = path.relative(this.root, uri.fsPath);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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

  /**
   * Commands run in VS Code's terminal and their output (needs shell integration; design §6.1).
   * Commands outside the folder are recorded too, marked "outside" (D3, D4); another workspace
   * folder's own commands are left to that folder's log.
   */
  private terminalSubscriptions(): vscode.Disposable[] {
    const w = vscode.window as Partial<typeof vscode.window>;
    const subs: vscode.Disposable[] = [];
    if (w.onDidOpenTerminal) {
      subs.push(
        w.onDidOpenTerminal((t) => {
          this.watchShellIntegration(t);
          this.scheduleOpenItems();
        }),
      );
    }
    if (w.onDidCloseTerminal) subs.push(w.onDidCloseTerminal(() => this.scheduleOpenItems()));
    if (w.onDidChangeActiveTerminal) subs.push(w.onDidChangeActiveTerminal(() => this.scheduleOpenItems()));
    if (w.onDidChangeTerminalShellIntegration) {
      subs.push(
        w.onDidChangeTerminalShellIntegration((e) => {
          if (this.shellIntegration.get(e.terminal) !== true) {
            this.shellIntegration.set(e.terminal, true);
            this.scheduleOpenItems();
          }
        }),
      );
    }
    if (!w.onDidStartTerminalShellExecution || !w.onDidEndTerminalShellExecution) return subs;
    subs.push(
      w.onDidStartTerminalShellExecution((e) => {
        if (this.tapSettings()['tap.record.terminalCommands'] === false) return;
        if (this.shellIntegration.get(e.terminal) !== true) {
          this.shellIntegration.set(e.terminal, true);
          this.scheduleOpenItems();
        }
        const cwdUri = e.execution.cwd;
        let cwd: string | undefined;
        let outside = false;
        if (cwdUri && cwdUri.scheme === 'file') {
          const rel = path.relative(this.root, cwdUri.fsPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            const other = vscode.workspace.getWorkspaceFolder(cwdUri);
            if (other && other.uri.toString() !== this.folder.uri.toString()) return; // that folder's log
            outside = true;
          } else if (rel !== '') {
            cwd = toLogPath(rel);
          }
        } else if (cwdUri || (vscode.workspace.workspaceFolders ?? []).length > 1) {
          outside = true; // remote or unknown working folder
        }
        const line = e.execution.commandLine.value;
        if (!line.trim()) return;
        const details: { cmd: string; cwd?: string; outside?: boolean } = { cmd: maskCommand(line) };
        if (cwd !== undefined) details.cwd = cwd;
        if (outside) details.outside = true;
        const rid = this.recorder?.runStarted('terminal', programName(line), details);
        if (rid === undefined) return;
        this.runs.set(e.execution, rid);
        // Output is read from the start of the command (D1); cleaned and capped when it ends.
        const capture = { chunks: [] as string[], size: 0, done: Promise.resolve() };
        capture.done = (async () => {
          try {
            for await (const data of e.execution.read()) {
              if (capture.size < MAX_RAW_OUTPUT) {
                capture.chunks.push(data);
                capture.size += data.length;
              }
            }
          } catch (err) {
            debug('terminal output', err);
          }
        })();
        this.outputs.set(e.execution, capture);
      }),
      w.onDidEndTerminalShellExecution((e) => {
        const rid = this.runs.get(e.execution);
        if (rid === undefined) return;
        this.runs.delete(e.execution);
        const capture = this.outputs.get(e.execution);
        this.outputs.delete(e.execution);
        const finish = () => {
          const output = capture ? cleanTerminalOutput(capture.chunks.join('')) : undefined;
          this.recorder?.runEnded(rid, e.exitCode, output);
        };
        if (!capture) {
          finish();
          return;
        }
        // The output stream ends just after the command; wait briefly for its last chunk.
        void Promise.race([capture.done, new Promise((r) => setTimeout(r, 500))]).then(finish);
      }),
    );
    return subs;
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
        this.checkAi();
        const env = this.environment();
        const key = JSON.stringify([env.aiExt, env.liveShare]);
        if (key === this.lastEnv) return;
        this.lastEnv = key;
        r()?.environmentChanged({ aiExt: env.aiExt, liveShare: env.liveShare });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigurationChanged(e)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleOpenItems()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleOpenItems()),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    const onDisk = (uri: vscode.Uri) => {
      const rel = this.relOf(uri);
      debug('disk event', uri.fsPath, rel);
      if (rel && !rel.startsWith(`${TAP_DIR}/`)) {
        r()?.onDiskEvent(rel);
        this.scheduleAsset(rel);
      }
    };
    d.push(watcher, watcher.onDidCreate(onDisk), watcher.onDidChange(onDisk), watcher.onDidDelete(onDisk));
  }
}
