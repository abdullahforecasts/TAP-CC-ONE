/**
 * The recorder: turns editor events into log records (design §6, §11).
 *
 * This module has no dependency on the VS Code API. Everything it needs from the outside world
 * comes through `RecorderHost` and `LogSink`, so it can be tested with plain unit tests and a
 * simulated editor. `vscode/folderSession.ts` adapts real VS Code events onto it.
 *
 * Ordering model
 * --------------
 * Event handlers run synchronously. Text changes are buffered (cheap: one object per change).
 * Every other event first *seals* the buffer up to that point and then enqueues an async job.
 * Jobs run one at a time, in order: a job appends the sealed edits, then its own record(s),
 * then writes the new bytes to disk. Anything captured from the editor (document text at save
 * time, timestamps) is captured synchronously in the handler, so the log order always matches
 * the order things happened in the editor, no matter how long a job waits for the clipboard or
 * the disk.
 */
import {
  type BodyByKind,
  bytesEqual,
  type ChangeTuple,
  contentHash,
  detectEol,
  Flag,
  isTapError,
  type KeyPair,
  type KindName,
  LARGE_INSERT_THRESHOLD,
  type LogWriter,
  normalizeText,
  type RecoveryBody,
  type SnapshotOrigin,
  toWellFormed,
} from '@tap/core';
import {
  type ClassifySettings,
  classifyEvent,
  type EditorChange,
  type EditReason,
  isPasteOf,
  resolvePaste,
} from './classify.js';

export type DiskRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'skip'; reason: 'binary' | 'large' };

export interface RecorderHost {
  /** Wall clock, unix ms. */
  wallNow(): number;
  /** Monotonic clock, ms (performance.now). */
  monoNow(): number;
  readClipboard(): Promise<string>;
  /** Current text of the document if it is open in the editor. */
  openText(rel: string): string | undefined;
  /** All tracked documents currently open in the editor. */
  openDocuments(): Array<{ rel: string; text: string }>;
  /** Reads a file from disk (applies size and binary limits). */
  readDisk(rel: string): Promise<DiskRead>;
  /** Size and modification time of a file on disk, or undefined if it does not exist. */
  statFile(rel: string): Promise<{ size: number; mtimeMs: number } | undefined>;
  /** All tracked files currently on disk (workspace-relative, '/' separators). */
  listFiles(): Promise<string[]>;
  /** Whether a path matches the folder's include/exclude rules. */
  isTracked(rel: string): boolean;
  /** Whether a version-control operation (checkout, pull, stash...) happened in the last seconds. */
  vcsRecentlyActive(): Promise<boolean>;
  randomBytes(n: number): Uint8Array;
  /** Called for unexpected errors; the recorder keeps going. */
  onError(error: unknown, context: string): void;
}

export interface LogSink {
  append(bytes: Uint8Array): Promise<void>;
  appendSync(bytes: Uint8Array): void;
}

export interface SessionEnvironment {
  vsc: string;
  app: string;
  os: string;
  ext: string;
  aiExt: string[];
  liveShare: boolean;
  cfgHash: Uint8Array;
  settings: Record<string, boolean | number | string>;
}

export interface RecorderSettings extends ClassifySettings {
  recordFocus: boolean;
  checkpointIntervalMs: number;
  /** Flush buffered edits this long after the first one (design: 2 s). */
  flushDelayMs: number;
  /** Flush when this many bytes of inserted text are buffered (design: 64 KB). */
  maxBufferedBytes: number;
  /** How long a flush waits for pending clipboard comparisons (design: 250 ms). */
  clipboardWaitMs: number;
  /** Debounce for file-system watcher events. */
  diskDebounceMs: number;
  /**
   * How long to wait for the editor's dirty flag when a change arrives on a clean document and
   * the result does not match the file on disk (see `checkReload`).
   */
  reloadWaitMs: number;
  /**
   * How often closed files are compared with the disk (size and modification time), in case the
   * file-system watcher missed an event. Also done before every verification.
   */
  diskSweepIntervalMs: number;
}

export const DEFAULT_SETTINGS: RecorderSettings = {
  clipboardCheckMinChars: 2,
  bulkMinChars: 40,
  recordFocus: true,
  checkpointIntervalMs: 300_000,
  flushDelayMs: 2_000,
  maxBufferedBytes: 64 * 1024,
  clipboardWaitMs: 250,
  diskDebounceMs: 300,
  reloadWaitMs: 150,
  diskSweepIntervalMs: 60_000,
};

export interface RecorderOptions {
  writer: LogWriter;
  sink: LogSink;
  host: RecorderHost;
  key: KeyPair;
  env: SessionEnvironment;
  settings?: Partial<RecorderSettings>;
  /** From resumeInfo(): last on-disk content hash per file. */
  diskHashes?: Map<number, Uint8Array>;
  /** Public key that signed the previous session (to emit KEY_ROTATION when it changed). */
  lastPub?: Uint8Array;
  /** RECOVERY body to append first, when the log tail was repaired on open. */
  recovery?: RecoveryBody;
  /** Start in the paused state (the user paused before the window was reloaded). */
  startPaused?: boolean;
}

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

interface Time {
  t: number;
  m: number;
}

type ClipState = { verdict: 'pending' | 'paste' | 'no-paste'; promise?: Promise<void> };

/**
 * A change event on a document without unsaved edits, not caused by undo/redo or a save. It is
 * either the editor reloading the file from disk, or the first edit after opening or saving
 * (VS Code reports isDirty=false for that event and sets the flag a moment later).
 */
interface ReloadCheck {
  verdict: 'pending' | 'edit' | 'reload';
  promise?: Promise<void>;
  /** Document text right after the event. */
  text: string;
  hint?: 'vcs';
  isDirtyNow: () => boolean;
}

interface PendingChange {
  id: number;
  f: number;
  dt: number;
  off: number;
  del: number;
  ins: string;
  flags: number;
  multi: boolean;
  clip?: ClipState;
  /** Shared by all changes of one event that may be a reload from disk. */
  reload?: ReloadCheck;
  time: Time;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RecorderStats {
  records: number;
  changes: number;
  resyncs: number;
  errors: number;
}

const MAX_DT = 0xffffffff;

export class Recorder {
  private readonly writer: LogWriter;
  private readonly sink: LogSink;
  private readonly host: RecorderHost;
  private key: KeyPair;
  private readonly env: SessionEnvironment;
  private readonly settings: RecorderSettings;
  private readonly options: RecorderOptions;

  private stateValue: RecorderState = 'idle';
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private sessionStartMono = 0;
  private sid: Uint8Array = new Uint8Array(16);

  /** Path → file id for live files, maintained synchronously (the writer catches up in jobs). */
  private readonly registry = new Map<string, number>();
  private nextFileId = 0;
  private readonly diskHash: Map<number, Uint8Array>;

  private readonly pending: PendingChange[] = [];
  private nextChangeId = 1;
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly lastChangeMono = new Map<number, number>();
  private readonly savingUntil = new Map<string, number>();
  private readonly diskTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last seen size:mtime of closed files, for the periodic disk sweep. */
  private readonly diskStats = new Map<string, string>();
  private lastSweepMono = 0;

  private nextRid = 1;
  private recordsSinceCheckpoint = 0;
  private lastCheckpointMono = 0;
  private lastTick: { wall: number; mono: number } | undefined;

  readonly stats: RecorderStats = { records: 0, changes: 0, resyncs: 0, errors: 0 };

  /** Called whenever the state changes (status bar). */
  onStateChange: ((state: RecorderState) => void) | undefined;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.writer = options.writer;
    this.sink = options.sink;
    this.host = options.host;
    this.key = options.key;
    this.env = options.env;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
    this.diskHash = new Map(options.diskHashes ?? []);
    for (const file of this.writer.state.files.values()) this.registry.set(file.path, file.f);
    const ids = [...this.writer.state.files.keys(), ...this.writer.state.retired];
    this.nextFileId = ids.length === 0 ? 0 : Math.max(...ids) + 1;
  }

  get state(): RecorderState {
    return this.stateValue;
  }

  get logId(): Uint8Array {
    return this.writer.header.logId;
  }

  /** Paths currently tracked (live files). */
  trackedPaths(): string[] {
    return [...this.registry.keys()].sort();
  }

  /** Resolves when every queued job has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  // -------------------------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------------------------

  /** Writes SESSION_START (plus RECOVERY / KEY_ROTATION when needed) and reconciles files. */
  start(): Promise<void> {
    if (this.stateValue !== 'idle') throw new Error(`cannot start from state ${this.stateValue}`);
    this.sessionStartMono = this.host.monoNow();
    this.lastCheckpointMono = this.sessionStartMono;
    this.lastSweepMono = this.sessionStartMono;
    this.sid = this.host.randomBytes(16);
    const time = this.now();
    const isNewLog = this.writer.seq === 0;
    const { recovery, lastPub, startPaused } = this.options;

    if (startPaused) {
      this.setState('paused');
      return this.enqueue(() => {
        this.writeSessionPrelude(time, recovery, lastPub);
        this.checkpoint(time);
        this.append('PAUSE', { why: 'paused before the window was reloaded' }, time);
      });
    }

    this.setState('recording');
    const openTexts = this.captureOpenDocuments();
    return this.enqueue(async () => {
      this.writeSessionPrelude(time, recovery, lastPub);
      await this.reconcile(isNewLog ? 'new-log' : 'resume', openTexts, time);
      this.checkpoint(this.now());
    });
  }

  private writeSessionPrelude(
    time: Time,
    recovery: RecoveryBody | undefined,
    lastPub: Uint8Array | undefined,
  ) {
    if (recovery) this.append('RECOVERY', recovery, time);
    if (lastPub && !bytesEqual(lastPub, this.key.publicKey)) {
      this.append('KEY_ROTATION', { oldPub: lastPub, newPub: this.key.publicKey, why: 'lost' }, time);
    }
    const env = this.env;
    this.append(
      'SESSION_START',
      {
        sid: this.sid,
        pub: this.key.publicKey,
        vsc: env.vsc,
        app: env.app,
        os: env.os,
        ext: env.ext,
        aiExt: env.aiExt,
        liveShare: env.liveShare,
        cfgHash: env.cfgHash,
        settings: env.settings,
      },
      time,
    );
  }

  /** Ends the session cleanly: flush, checkpoint, SESSION_END. */
  stop(reason: 'close' | 'reload' | 'deactivate' = 'close'): Promise<void> {
    if (this.stateValue === 'stopped' || this.stateValue === 'idle') return this.queue;
    const upTo = this.seal();
    const time = this.now();
    this.setState('stopped');
    this.clearTimers();
    return this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.checkpoint(time);
      this.append('SESSION_END', { sid: this.sid, reason }, time);
    }).then(() => {
      this.closed = true;
    });
  }

  /**
   * Synchronous last-resort stop for extension deactivation: appends everything buffered,
   * a checkpoint and SESSION_END, and writes them synchronously. Jobs still in flight are
   * abandoned (they check `closed`).
   */
  stopSync(reason: 'close' | 'reload' | 'deactivate' = 'deactivate'): void {
    if (this.closed || this.stateValue === 'idle') return;
    this.setState('stopped');
    this.clearTimers();
    try {
      this.appendEditsNow(Number.MAX_SAFE_INTEGER);
      const time = this.now();
      this.checkpoint(time);
      this.append('SESSION_END', { sid: this.sid, reason }, time);
      const bytes = this.writer.drain();
      if (bytes.length > 0) this.sink.appendSync(bytes);
    } catch (e) {
      this.reportError(e, 'stopSync');
    } finally {
      // Jobs still in flight see `closed` and drop their work instead of appending after SESSION_END.
      this.closed = true;
    }
  }

  pause(why?: string): Promise<void> {
    if (this.stateValue !== 'recording') return this.queue;
    const upTo = this.seal();
    const time = this.now();
    this.setState('paused');
    return this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.checkpoint(time);
      this.append('PAUSE', why ? { why } : {}, time);
    });
  }

  resume(): Promise<void> {
    if (this.stateValue !== 'paused') return this.queue;
    const time = this.now();
    this.setState('recording');
    const openTexts = this.captureOpenDocuments();
    return this.enqueue(async () => {
      this.append('RESUME', {}, time);
      await this.reconcile('paused-gap', openTexts, time);
    });
  }

  /** Periodic housekeeping: flush checkpoint when due, detect clock jumps. Call every ~15 s. */
  tick(): Promise<void> {
    const wall = this.host.wallNow();
    const mono = this.host.monoNow();
    const prev = this.lastTick;
    this.lastTick = { wall, mono };
    if (this.stateValue !== 'recording') return this.queue;
    if (prev) {
      const wallDelta = wall - prev.wall;
      const monoDelta = Math.max(0, Math.round(mono - prev.mono));
      // Sleep makes wall time run ahead of monotonic time; only a wall clock that falls behind
      // monotonic time is an anomaly (clock set back).
      if (wallDelta < monoDelta - 2000) {
        const time = this.now();
        const upTo = this.seal();
        this.enqueue(async () => {
          await this.appendEdits(upTo);
          this.append('CLOCK_ANOMALY', { wallDelta: Math.round(wallDelta), monoDelta }, time);
        });
      }
    }
    if (mono - this.lastSweepMono >= this.settings.diskSweepIntervalMs) {
      this.lastSweepMono = mono;
      const time = this.now();
      this.enqueue(() => this.sweepDisk(time));
    }
    const due = mono - this.lastCheckpointMono >= this.settings.checkpointIntervalMs;
    if (due && (this.recordsSinceCheckpoint > 0 || this.pending.length > 0)) {
      const upTo = this.seal();
      const time = this.now();
      return this.enqueue(async () => {
        await this.appendEdits(upTo);
        this.checkpoint(time);
      });
    }
    return this.queue;
  }

  /** Replaces the signing key (e.g. after the user resets it). Takes effect at the next session. */
  setKey(key: KeyPair): void {
    this.key = key;
  }

  // -------------------------------------------------------------------------------------------
  // Editor events (synchronous handlers)
  // -------------------------------------------------------------------------------------------

  /**
   * A tracked document changed.
   * @param isDirtyAfter document.isDirty as reported with the change (false for reloads from
   *   disk, but also for the first edit after opening or saving: see `ReloadCheck`).
   * @param textAfter returns the document text after the change (only called when needed).
   * @param isDirtyNow returns document.isDirty when called (defaults to `isDirtyAfter`).
   */
  onDocumentChanged(
    rel: string,
    changes: readonly EditorChange[],
    reason: EditReason,
    isDirtyAfter: boolean,
    textAfter: () => string,
    isDirtyNow: () => boolean = () => isDirtyAfter,
  ): void {
    if (this.stateValue !== 'recording' || changes.length === 0) return;
    const f = this.registry.get(rel);
    if (f === undefined) {
      if (!this.host.isTracked(rel)) return;
      this.introduce(rel, textAfter(), 'editor');
      return;
    }
    const mono = this.host.monoNow();
    const saving = (this.savingUntil.get(rel) ?? 0) > mono;
    // Possibly the editor replacing the buffer with the file on disk ("Revert File", or a file
    // without unsaved edits changed on disk). Buffered like an edit; decided before it is written.
    const reload =
      reason === undefined && !isDirtyAfter && !saving
        ? this.checkReload(rel, textAfter(), isDirtyNow)
        : undefined;

    let classified: ReturnType<typeof classifyEvent>;
    try {
      classified = classifyEvent(changes, reason, saving, this.settings);
    } catch (e) {
      // Overlapping ranges should never happen; resynchronise rather than record nonsense.
      this.reportError(e, 'classify');
      this.requestResync(f, rel);
      return;
    }
    const time = this.now();
    const last = this.lastChangeMono.get(f);
    const dt = last === undefined ? 0 : Math.min(MAX_DT, Math.max(0, Math.round(mono - last)));
    this.lastChangeMono.set(f, mono);
    const multi = ((classified[0]?.flags ?? 0) & Flag.MULTI_CURSOR) !== 0;

    classified.forEach((c, i) => {
      const change: PendingChange = {
        id: this.nextChangeId++,
        f,
        dt: i === 0 ? dt : 0,
        off: c.off,
        del: c.del,
        ins: c.ins,
        flags: c.flags,
        multi,
        time,
      };
      if (c.needsClipboard) change.clip = this.checkClipboard(c.ins, multi);
      if (reload) change.reload = reload;
      this.pending.push(change);
      this.pendingBytes += c.ins.length + 16;
    });
    this.stats.changes += classified.length;

    if (this.pendingBytes >= this.settings.maxBufferedBytes) {
      const upTo = this.seal();
      this.enqueue(() => this.appendEdits(upTo));
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const upTo = this.seal();
        this.enqueue(() => this.appendEdits(upTo));
      }, this.settings.flushDelayMs);
    }
  }

  onWillSave(rel: string): void {
    if (this.stateValue !== 'recording') return;
    this.savingUntil.set(rel, this.host.monoNow() + 3000);
    // The document is being saved, so it had unsaved edits: changes still awaiting a reload
    // check were edits.
    const f = this.registry.get(rel);
    for (const c of this.pending) if (c.f === f && c.reload?.verdict === 'pending') c.reload.verdict = 'edit';
  }

  /** A tracked document was saved; `text` is its content at save time. */
  onDidSave(rel: string, text: string): void {
    this.savingUntil.delete(rel);
    if (this.stateValue !== 'recording') return;
    let f = this.registry.get(rel);
    if (f === undefined) {
      if (!this.host.isTracked(rel)) return;
      f = this.introduce(rel, text, 'editor');
    }
    const id = f;
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      if (this.closed) return;
      const current = this.writer.state.files.get(id);
      if (!current) return;
      if (!sameText(current.text, text)) this.snapshot(id, current.path, text, 'resync', time);
      const h = contentHash(text);
      this.append('SAVE', { f: id, h, n: text.length }, time);
      this.diskHash.set(id, h);
    });
  }

  /** A tracked document was opened in the editor. */
  onDocumentOpened(rel: string, text: string): void {
    if (this.stateValue !== 'recording') return;
    const f = this.registry.get(rel);
    if (f === undefined) {
      if (this.host.isTracked(rel)) this.introduce(rel, text, 'external');
      return;
    }
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.applyDiskVersion(f, rel, text, time, { fromOpen: true });
    });
  }

  /** Files created through the editor (Explorer, workspace edits). */
  onFilesCreated(rels: readonly string[]): void {
    if (this.stateValue !== 'recording') return;
    for (const rel of rels) {
      if (this.registry.has(rel) || !this.host.isTracked(rel)) continue;
      const f = this.allocate(rel);
      const time = this.now();
      this.enqueue(async () => {
        this.append('FILE_OP', { op: 'create', f, path: rel, origin: 'editor' }, time);
        const read = await this.host.readDisk(rel);
        // A file created with content (copy, "save as", template). Skip if the user already
        // started typing in it: those edits are buffered and will produce the text themselves.
        if (read.kind === 'text' && !this.lastChangeMono.has(f)) {
          if (read.text !== '' && this.writer.state.files.get(f)?.text === '') {
            this.snapshot(f, rel, read.text, 'created', time);
          }
          this.diskHash.set(f, contentHash(read.text));
        }
      });
    }
  }

  /** Files or folders deleted through the editor. */
  onFilesDeleted(rels: readonly string[]): void {
    if (this.stateValue !== 'recording') return;
    for (const rel of this.expandFolders(rels)) this.deleteFile(rel, 'editor');
  }

  /** Files or folders renamed/moved through the editor. */
  onFilesRenamed(pairs: ReadonlyArray<{ from: string; to: string }>): void {
    if (this.stateValue !== 'recording') return;
    for (const { from, to } of pairs) {
      const moves: Array<[string, string]> = this.registry.has(from)
        ? [[from, to]]
        : [...this.registry.keys()]
            .filter((p) => p.startsWith(`${from}/`))
            .map((p) => [p, to + p.slice(from.length)]);
      if (moves.length === 0 && this.host.isTracked(to)) this.onFilesCreated([to]);
      for (const [oldPath, newPath] of moves) {
        const f = this.registry.get(oldPath)!;
        if (!this.host.isTracked(newPath)) {
          this.deleteFile(oldPath, 'editor');
          continue;
        }
        if (this.registry.has(newPath)) this.deleteFile(newPath, 'editor');
        this.registry.delete(oldPath);
        this.registry.set(newPath, f);
        const upTo = this.seal();
        const time = this.now();
        this.enqueue(async () => {
          await this.appendEdits(upTo);
          this.append('FILE_OP', { op: 'rename', f, path: oldPath, newPath, origin: 'editor' }, time);
        });
      }
    }
  }

  /** File-system watcher: something changed on disk (debounced per path). */
  onDiskEvent(rel: string): void {
    if (this.stateValue !== 'recording' || rel.startsWith('.tap/') || rel === '.tap') return;
    const existing = this.diskTimers.get(rel);
    if (existing) clearTimeout(existing);
    this.diskTimers.set(
      rel,
      setTimeout(() => {
        this.diskTimers.delete(rel);
        if (this.stateValue !== 'recording') return;
        const time = this.now();
        this.enqueue(() => this.checkDisk(rel, time));
      }, this.settings.diskDebounceMs),
    );
  }

  runStarted(kind: 'debug' | 'task' | 'terminal', name?: string): number {
    const rid = this.nextRid++;
    if (this.stateValue !== 'recording') return rid;
    const upTo = this.seal();
    const time = this.now();
    const body: BodyByKind['RUN_START'] = { rid, kind };
    if (name) body.name = name.slice(0, 500);
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.append('RUN_START', body, time);
    });
    return rid;
  }

  runEnded(rid: number, exit?: number): void {
    if (this.stateValue !== 'recording') return;
    const upTo = this.seal();
    const time = this.now();
    const body: BodyByKind['RUN_END'] = { rid };
    if (exit !== undefined && Number.isSafeInteger(exit)) body.exit = exit;
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.append('RUN_END', body, time);
    });
  }

  onFocusChanged(focused: boolean): void {
    if (this.stateValue !== 'recording') return;
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      if (this.settings.recordFocus) this.append('FOCUS', { on: focused }, time);
    });
  }

  addNote(text: string): Promise<void> {
    if (this.stateValue !== 'recording' && this.stateValue !== 'paused') return this.queue;
    const upTo = this.seal();
    const time = this.now();
    return this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.append('NOTE', { text }, time);
    });
  }

  environmentChanged(change: BodyByKind['ENV_CHANGE']): void {
    if (this.stateValue !== 'recording' && this.stateValue !== 'paused') return;
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.append('ENV_CHANGE', change, time);
    });
  }

  /**
   * Writes everything buffered to disk now and brings closed files up to date (used before
   * verifying or exporting): debounced watcher events are handled immediately and the disk is
   * swept for changes the watcher missed.
   */
  flush(): Promise<void> {
    if (this.stateValue === 'idle' || this.closed) return this.queue;
    const upTo = this.seal();
    const time = this.now();
    const recording = this.stateValue === 'recording';
    const due = [...this.diskTimers.keys()];
    for (const timer of this.diskTimers.values()) clearTimeout(timer);
    this.diskTimers.clear();
    if (recording) this.lastSweepMono = this.host.monoNow();
    return this.enqueue(async () => {
      await this.appendEdits(upTo);
      if (!recording) return;
      for (const rel of due) await this.checkDisk(rel, time);
      await this.sweepDisk(time);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private now(): Time {
    return {
      t: Math.round(this.host.wallNow()),
      m: Math.max(0, Math.round(this.host.monoNow() - this.sessionStartMono)),
    };
  }

  private setState(state: RecorderState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.onStateChange?.(state);
  }

  private clearTimers(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const timer of this.diskTimers.values()) clearTimeout(timer);
    this.diskTimers.clear();
  }

  /** Marks everything buffered so far as belonging before the next job. Returns the cut-off id. */
  private seal(): number {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pendingBytes = 0;
    return this.nextChangeId - 1;
  }

  private enqueue(job: () => Promise<void> | void): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      try {
        await job();
        await this.persist();
      } catch (e) {
        if (!(e instanceof RecorderClosed)) this.reportError(e, 'job');
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private async persist(): Promise<void> {
    if (this.closed) return;
    const bytes = this.writer.drain();
    if (bytes.length > 0) await this.sink.append(bytes);
  }

  private reportError(e: unknown, context: string): void {
    this.stats.errors++;
    this.host.onError(e, context);
  }

  private append<K extends KindName>(kind: K, body: BodyByKind[K], time: Time): void {
    if (this.closed) throw new RecorderClosed();
    this.writer.append(kind, body, time);
    this.stats.records++;
    this.recordsSinceCheckpoint++;
  }

  private checkpoint(time: Time): void {
    if (this.closed) throw new RecorderClosed();
    this.writer.appendCheckpoint(this.key.secretKey, time);
    this.stats.records++;
    this.recordsSinceCheckpoint = 0;
    this.lastCheckpointMono = this.host.monoNow();
  }

  private snapshot(f: number, path: string, raw: string, origin: SnapshotOrigin, time: Time): void {
    // Lone surrogates (never produced by typing, but possible through programmatic edits) are
    // stored as U+FFFD. The length is unchanged, so later offsets stay valid.
    const text = toWellFormed(raw);
    this.append(
      'FILE_SNAPSHOT',
      { f, path, origin, text, h: contentHash(text), eol: detectEol(text), enc: 'utf8' },
      time,
    );
    if (origin === 'resync') this.stats.resyncs++;
  }

  private allocate(rel: string): number {
    const f = this.nextFileId++;
    this.registry.set(rel, f);
    return f;
  }

  private checkClipboard(ins: string, multi: boolean): ClipState {
    const state: ClipState = { verdict: 'pending' };
    state.promise = this.host.readClipboard().then(
      (clipboard) => {
        state.verdict = isPasteOf(ins, clipboard, multi) ? 'paste' : 'no-paste';
      },
      () => {
        state.verdict = 'no-paste';
      },
    );
    return state;
  }

  /**
   * Decides whether a change on a clean document was a reload from disk. A document that stays
   * clean was reloaded. One that becomes dirty was edited, unless its text right after the event
   * equals the file on disk (a reload immediately followed by typing). A save of the document
   * while the check runs settles it as an edit (`onWillSave`): clean documents are not saved.
   */
  private checkReload(rel: string, text: string, isDirtyNow: () => boolean): ReloadCheck {
    const check: ReloadCheck = { verdict: 'pending', text, isDirtyNow };
    check.promise = (async () => {
      let dirty = isDirtyNow();
      for (let waited = 0; !dirty && waited < this.settings.reloadWaitMs; waited += 10) {
        await delay(10);
        dirty = isDirtyNow();
      }
      let onDisk = false;
      if (dirty && check.verdict === 'pending') {
        try {
          const read = await this.host.readDisk(rel);
          onDisk = read.kind === 'text' && normalizeText(read.text) === normalizeText(text);
        } catch {
          // unreadable: decided by the dirty flag
        }
      }
      const reloaded = !dirty || onDisk;
      if (check.verdict !== 'pending') return;
      if (reloaded && (await this.host.vcsRecentlyActive().catch(() => false))) check.hint = 'vcs';
      if (check.verdict === 'pending') check.verdict = reloaded ? 'reload' : 'edit';
    })();
    return check;
  }

  /** Final verdict of a reload check; one still running is decided by the dirty flag now. */
  private isReload(c: PendingChange): boolean {
    const r = c.reload;
    if (!r) return false;
    if (r.verdict === 'pending') r.verdict = r.isDirtyNow() ? 'edit' : 'reload';
    return r.verdict === 'reload';
  }

  /** Waits for `promises`, at most `ms`. */
  private async waitFor(promises: Array<Promise<void>>, ms: number): Promise<void> {
    if (promises.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(promises),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Appends buffered changes with id <= upTo, waiting briefly for clipboard and reload checks. */
  private async appendEdits(upTo: number): Promise<void> {
    const sealed = this.pending.filter((c) => c.id <= upTo);
    await this.waitFor(
      sealed.filter((c) => c.clip?.verdict === 'pending').map((c) => c.clip!.promise!),
      this.settings.clipboardWaitMs,
    );
    await this.waitFor(
      [...new Set(sealed.filter((c) => c.reload?.verdict === 'pending').map((c) => c.reload!.promise!))],
      this.settings.reloadWaitMs + 1000,
    );
    if (this.closed) return;
    this.appendEditsNow(upTo);
  }

  /** Synchronously appends buffered changes up to `upTo` as EDIT_BATCH records. */
  private appendEditsNow(upTo: number): void {
    let count = 0;
    while (count < this.pending.length && this.pending[count]!.id <= upTo) count++;
    if (count === 0) return;
    const taken = this.pending.splice(0, count);
    const resynced = new Set<number>();
    let i = 0;
    while (i < taken.length) {
      const first = taken[i]!;
      const f = first.f;
      if (this.isReload(first)) {
        // The editor reloaded the file from disk: record the new version, not typing.
        const reload = first.reload!;
        while (i < taken.length && taken[i]!.reload === reload) i++;
        if (resynced.has(f)) continue;
        const path = this.writer.state.files.get(f)?.path;
        if (path !== undefined) {
          this.applyDiskVersion(f, path, reload.text, first.time, reload.hint ? { hint: reload.hint } : {});
        }
        continue;
      }
      const group: PendingChange[] = [];
      while (i < taken.length && taken[i]!.f === f && !this.isReload(taken[i]!)) group.push(taken[i++]!);
      if (resynced.has(f)) continue; // already contained in the resync snapshot
      const tuples = group.map((c): ChangeTuple => {
        let flags = c.flags;
        if (c.clip) flags = resolvePaste(flags, c.clip.verdict === 'pending' ? 'timeout' : c.clip.verdict);
        const ins = toWellFormed(c.ins);
        return flags ? [c.dt, c.off, c.del, ins, flags] : [c.dt, c.off, c.del, ins];
      });
      try {
        this.append('EDIT_BATCH', { f, c: tuples }, group[group.length - 1]!.time);
      } catch (e) {
        if (!isTapError(e) || e.code !== 'REPLAY_FAILED') throw e;
        // Our copy of the document diverged from the editor (missed or reordered event).
        // Record the editor's current text instead and drop buffered edits it already contains.
        this.reportError(e, 'edit-batch');
        const path = this.writer.state.files.get(f)?.path;
        if (path !== undefined) this.resyncFromEditor(f, path, group[group.length - 1]!.time);
        resynced.add(f);
      }
    }
  }

  private requestResync(f: number, rel: string): void {
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      this.resyncFromEditor(f, rel, time);
    });
  }

  private resyncFromEditor(f: number, rel: string, time: Time): void {
    const text = this.host.openText(rel);
    if (text === undefined) return;
    // Buffered changes for this file are already reflected in the editor text.
    for (let k = this.pending.length - 1; k >= 0; k--)
      if (this.pending[k]!.f === f) this.pending.splice(k, 1);
    const current = this.writer.state.files.get(f);
    if (current && !sameText(current.text, text)) this.snapshot(f, rel, text, 'resync', time);
  }

  /** Introduces a file the recorder has not seen yet. Returns its id. */
  private introduce(rel: string, text: string, origin: 'editor' | 'external'): number {
    const f = this.allocate(rel);
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      if (origin === 'external') {
        this.snapshot(f, rel, text, 'external', time);
      } else {
        this.append('FILE_OP', { op: 'create', f, path: rel, origin: 'editor' }, time);
        if (text !== '') this.snapshot(f, rel, text, 'created', time);
      }
    });
    return f;
  }

  private deleteFile(rel: string, origin: 'editor' | 'external'): void {
    const f = this.registry.get(rel);
    if (f === undefined) return;
    this.registry.delete(rel);
    const upTo = this.seal();
    const time = this.now();
    this.enqueue(async () => {
      await this.appendEdits(upTo);
      const current = this.writer.state.files.get(f);
      if (!current) return;
      this.append('FILE_OP', { op: 'delete', f, path: current.path, origin }, time);
      this.diskHash.delete(f);
      this.lastChangeMono.delete(f);
    });
  }

  private expandFolders(rels: readonly string[]): string[] {
    const out = new Set<string>();
    for (const rel of rels) {
      if (this.registry.has(rel)) out.add(rel);
      for (const p of this.registry.keys()) if (p.startsWith(`${rel}/`)) out.add(p);
    }
    return [...out];
  }

  /**
   * The editor now shows `text`, which came from disk. If it equals the last saved content, the
   * user discarded unsaved edits (Revert File / reopened without saving): record that as an undo.
   * Otherwise the file changed on disk: EXTERNAL_CHANGE plus an external snapshot.
   */
  private applyDiskVersion(
    f: number,
    rel: string,
    text: string,
    time: Time,
    opts: { fromOpen?: boolean; hint?: 'vcs' } = {},
  ): void {
    const current = this.writer.state.files.get(f);
    if (!current || sameText(current.text, text)) return;
    const h = contentHash(text);
    const known = this.diskHash.get(f);
    if (known && bytesEqual(known, h)) {
      this.append('EDIT_BATCH', { f, c: [undoTuple(current.text, text)] }, time);
      return;
    }
    if (opts.fromOpen) {
      // Opened with content that is neither our state nor the last saved version.
      this.snapshot(f, rel, text, 'resync', time);
      return;
    }
    const body: BodyByKind['EXTERNAL_CHANGE'] = { f, h };
    if (opts.hint) body.hint = opts.hint;
    this.append('EXTERNAL_CHANGE', body, time);
    this.snapshot(f, rel, text, 'external', time);
    this.diskHash.set(f, h);
  }

  /** Watcher job: compare a closed file on disk with the recorded state. */
  private async checkDisk(rel: string, time: Time): Promise<void> {
    if (this.host.openText(rel) !== undefined) return; // open documents report through the editor
    const read = await this.host.readDisk(rel);
    const f = this.registry.get(rel);
    if (read.kind === 'missing') {
      if (f !== undefined) this.deleteFileNow(rel, f, time);
      return;
    }
    if (read.kind === 'skip') return;
    if (f === undefined) {
      if (!this.host.isTracked(rel)) return;
      const id = this.allocate(rel);
      this.snapshot(id, rel, read.text, 'external', time);
      this.diskHash.set(id, contentHash(read.text));
      return;
    }
    const current = this.writer.state.files.get(f);
    if (!current) return;
    if (sameText(current.text, read.text)) {
      this.diskHash.set(f, contentHash(read.text));
      return;
    }
    // Either another program changed it, or the editor closed it with unsaved edits discarded.
    const hint = (await this.host.vcsRecentlyActive()) ? 'vcs' : undefined;
    this.applyDiskVersion(f, rel, read.text, time, hint ? { hint } : {});
  }

  /**
   * Compares closed tracked files with the disk by size and modification time and checks the
   * ones that changed, so a change the file-system watcher missed is still recorded.
   */
  private async sweepDisk(time: Time): Promise<void> {
    const paths = new Set<string>(this.registry.keys());
    for (const p of await this.host.listFiles()) if (this.host.isTracked(p)) paths.add(p);
    for (const rel of [...paths].sort()) {
      if (this.closed || this.stateValue !== 'recording') return;
      if (this.host.openText(rel) !== undefined) continue;
      const stat = await this.host.statFile(rel);
      const key = stat ? `${stat.size}:${stat.mtimeMs}` : '-';
      if (this.diskStats.get(rel) === key) continue;
      this.diskStats.set(rel, key);
      await this.checkDisk(rel, time);
    }
    for (const rel of [...this.diskStats.keys()]) if (!paths.has(rel)) this.diskStats.delete(rel);
  }

  private deleteFileNow(rel: string, f: number, time: Time): void {
    this.registry.delete(rel);
    const current = this.writer.state.files.get(f);
    if (!current) return;
    this.append('FILE_OP', { op: 'delete', f, path: current.path, origin: 'external' }, time);
    this.diskHash.delete(f);
  }

  private captureOpenDocuments(): Map<string, string> {
    const texts = new Map<string, string>();
    for (const { rel, text } of this.host.openDocuments()) if (this.host.isTracked(rel)) texts.set(rel, text);
    return texts;
  }

  /**
   * Brings the log in line with the files as they are now (session start, or resume after a
   * pause). Open documents use the editor text captured synchronously by the caller.
   */
  private async reconcile(
    mode: 'new-log' | 'resume' | 'paused-gap',
    openTexts: Map<string, string>,
    time: Time,
  ): Promise<void> {
    const onDisk = await this.host.listFiles();
    const candidates = new Set<string>([
      ...onDisk.filter((p) => this.host.isTracked(p)),
      ...openTexts.keys(),
    ]);
    for (const p of this.registry.keys()) candidates.add(p);
    for (const rel of [...candidates].sort()) {
      if (this.closed) return;
      const open = openTexts.get(rel);
      let text: string;
      let disk: string | undefined;
      if (open !== undefined) {
        text = open;
        const read = await this.host.readDisk(rel);
        if (read.kind === 'text') disk = read.text;
      } else {
        const read = await this.host.readDisk(rel);
        if (read.kind === 'missing') {
          const f = this.registry.get(rel);
          if (f !== undefined && this.writer.state.files.has(f)) this.deleteFileNow(rel, f, time);
          continue;
        }
        if (read.kind === 'skip') continue;
        text = read.text;
        disk = read.text;
      }

      const known = this.registry.get(rel);
      const current = known === undefined ? undefined : this.writer.state.files.get(known);
      if (known === undefined || !current) {
        // Not in the log yet (the registry may already hold an id allocated by an event handler
        // that has not run its job; in that case the job will introduce the file).
        if (known !== undefined) continue;
        const f = this.allocate(rel);
        const origin: SnapshotOrigin =
          mode === 'new-log' ? 'preexisting' : mode === 'resume' ? 'external' : 'paused-gap';
        this.snapshot(f, rel, text, origin, time);
        if (disk !== undefined) this.diskHash.set(f, contentHash(disk));
        continue;
      }
      if (sameText(current.text, text)) {
        if (disk !== undefined && disk === text) this.diskHash.set(known, contentHash(disk));
        continue;
      }
      if (mode === 'paused-gap') {
        this.snapshot(known, rel, text, 'paused-gap', time);
        if (disk !== undefined) this.diskHash.set(known, contentHash(disk));
        continue;
      }
      // Session start of an existing log.
      const last = this.diskHash.get(known);
      if (open === undefined && last && bytesEqual(last, contentHash(text))) {
        // Disk still holds the last saved version; the log's newer text was unsaved editor
        // content (it comes back when the editor restores the document).
        continue;
      }
      if (
        open !== undefined &&
        disk !== undefined &&
        last &&
        bytesEqual(last, contentHash(disk)) &&
        open === disk
      ) {
        // Unsaved edits were discarded while the editor was closed.
        this.append('EDIT_BATCH', { f: known, c: [undoTuple(current.text, text)] }, time);
        continue;
      }
      const h = contentHash(text);
      this.append('EXTERNAL_CHANGE', { f: known, h }, time);
      this.snapshot(known, rel, text, 'external', time);
      if (disk !== undefined) this.diskHash.set(known, contentHash(disk));
    }
  }
}

/** The single region where `a` and `b` differ: [offset, deleted length, inserted text]. */
export function diffRegion(a: string, b: string): [number, number, string] {
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  // Do not split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(a.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  const maxSuffix = max - prefix;
  while (suffix < maxSuffix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix))
    suffix++;
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--;
  return [prefix, a.length - prefix - suffix, b.slice(prefix, b.length - suffix)];
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Thrown by append() after the recorder was closed; jobs in flight stop quietly. */
class RecorderClosed extends Error {
  constructor() {
    super('recorder closed');
  }
}

/** One change that turns `from` into `to`, flagged as an undo (reverted or discarded edits). */
function undoTuple(from: string, to: string): ChangeTuple {
  const [off, del, raw] = diffRegion(from, to);
  const ins = toWellFormed(raw);
  const flags = Flag.UNDO | (ins.length > LARGE_INSERT_THRESHOLD ? Flag.LARGE : 0);
  return [0, off, del, ins, flags];
}

/** Equal once lone surrogates are normalised to U+FFFD (as stored in the log). */
function sameText(a: string, b: string): boolean {
  return a === b || toWellFormed(a) === toWellFormed(b);
}
