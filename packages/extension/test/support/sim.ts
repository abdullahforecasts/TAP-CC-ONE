/**
 * A simulated editor + disk for testing the recorder without VS Code. It mimics the parts of
 * VS Code behaviour the recorder depends on: change events relative to the pre-change text,
 * isDirty after the change, reloads from disk for clean documents, willSave/didSave, and the
 * file-system watcher.
 */
import {
  concatBytes,
  type KeyPair,
  keyPairFromSeed,
  LogWriter,
  Replayer,
  readLog,
  sha256,
  utf8,
  type VerifyReport,
  verifyLog,
} from '@tap/core';
import type { EditorChange, EditReason } from '../../src/recorder/classify.js';
import {
  type DiskRead,
  type LogSink,
  Recorder,
  type RecorderHost,
  type RecorderOptions,
  type RecorderSettings,
} from '../../src/recorder/recorder.js';
import { resumeInfo } from '../../src/recorder/resumeInfo.js';

export function testKey(label = 'student'): KeyPair {
  return keyPairFromSeed(sha256(utf8(`ext-test/${label}`)));
}

export class MemorySink implements LogSink {
  chunks: Uint8Array[] = [];
  syncWrites = 0;
  failNext = false;

  async append(bytes: Uint8Array): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk full');
    }
    this.chunks.push(bytes.slice());
  }

  appendSync(bytes: Uint8Array): void {
    this.syncWrites++;
    this.chunks.push(bytes.slice());
  }

  get bytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

interface Doc {
  text: string;
  dirty: boolean;
}

export class SimHost implements RecorderHost {
  disk = new Map<string, string>();
  binary = new Set<string>();
  docs = new Map<string, Doc>();
  clipboard = '';
  clipboardDelayMs = 0;
  /**
   * Mimic VS Code reporting isDirty=false with the first edit after opening or saving (the
   * dirty flag is updated just after the change event).
   */
  staleDirtyFlag = false;
  wall = Date.UTC(2026, 9, 13, 9);
  mono = 1000;
  vcs = false;
  errors: Array<{ error: unknown; context: string }> = [];
  private counter = 0;
  tracked: (rel: string) => boolean = (rel) => !rel.startsWith('.tap/') && !rel.endsWith('.png');

  wallNow(): number {
    return this.wall;
  }
  monoNow(): number {
    return this.mono;
  }
  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
  async readClipboard(): Promise<string> {
    const value = this.clipboard;
    if (this.clipboardDelayMs > 0) await new Promise((r) => setTimeout(r, this.clipboardDelayMs));
    return value;
  }
  openText(rel: string): string | undefined {
    return this.docs.get(rel)?.text;
  }
  openDocuments(): Array<{ rel: string; text: string }> {
    return [...this.docs.entries()].map(([rel, d]) => ({ rel, text: d.text }));
  }
  async readDisk(rel: string): Promise<DiskRead> {
    await Promise.resolve();
    if (this.binary.has(rel)) return { kind: 'skip', reason: 'binary' };
    const text = this.disk.get(rel);
    return text === undefined ? { kind: 'missing' } : { kind: 'text', text };
  }
  async statFile(rel: string): Promise<{ size: number; mtimeMs: number } | undefined> {
    const text = this.disk.get(rel) ?? (this.binary.has(rel) ? '' : undefined);
    if (text === undefined) return undefined;
    // A content fingerprint stands in for the modification time.
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return { size: text.length, mtimeMs: h };
  }
  async listFiles(): Promise<string[]> {
    return [...this.disk.keys(), ...this.binary].filter((p) => this.tracked(p)).sort();
  }
  isTracked(rel: string): boolean {
    return this.tracked(rel);
  }
  async vcsRecentlyActive(): Promise<boolean> {
    return this.vcs;
  }
  randomBytes(n: number): Uint8Array {
    return sha256(utf8(`random-${this.counter++}`)).slice(0, n);
  }
  onError(error: unknown, context: string): void {
    this.errors.push({ error, context });
  }
}

export const FAST: Partial<RecorderSettings> = {
  flushDelayMs: 5,
  clipboardWaitMs: 30,
  diskDebounceMs: 5,
  reloadWaitMs: 20,
};

export interface SimOptions {
  key?: KeyPair;
  settings?: Partial<RecorderSettings>;
  existing?: Uint8Array;
  startPaused?: boolean;
  recovery?: RecorderOptions['recovery'];
}

/** A recorder wired to a simulated editor, with helpers that behave like VS Code. */
export class Sim {
  readonly host: SimHost;
  readonly sink = new MemorySink();
  recorder!: Recorder;
  writer!: LogWriter;
  private prefix: Uint8Array = new Uint8Array(0);

  constructor(host = new SimHost()) {
    this.host = host;
  }

  async start(options: SimOptions = {}): Promise<this> {
    let info: ReturnType<typeof resumeInfo> = { diskHashes: new Map(), sessionOpen: false };
    if (options.existing) {
      this.prefix = options.existing;
      this.writer = LogWriter.resume(options.existing);
      info = resumeInfo(readLog(options.existing).records.map((r) => r.record));
    } else {
      this.writer = LogWriter.create({
        created: this.host.wall,
        tool: 'ext-test',
        label: 'sim',
        logId: sha256(utf8('sim')).slice(0, 16),
      });
    }
    const opts: RecorderOptions = {
      writer: this.writer,
      sink: this.sink,
      host: this.host,
      key: options.key ?? testKey(),
      env: {
        vsc: '1.105.0',
        app: 'vscode',
        os: 'linux',
        ext: '0.1.0',
        aiExt: [],
        liveShare: false,
        cfgHash: new Uint8Array(32),
        settings: { 'tap.record.focus': true },
      },
      settings: { ...FAST, ...options.settings },
      diskHashes: info.diskHashes,
    };
    if (info.lastPub) opts.lastPub = info.lastPub;
    if (options.recovery) opts.recovery = options.recovery;
    if (options.startPaused) opts.startPaused = true;
    this.recorder = new Recorder(opts);
    await this.recorder.start();
    return this;
  }

  /** Full log bytes (previous sessions + this one). */
  get bytes(): Uint8Array {
    return concatBytes(this.prefix, this.sink.bytes);
  }

  async settle(): Promise<void> {
    // Let debounce/flush timers fire, then wait for all jobs.
    await new Promise((r) => setTimeout(r, 40));
    await this.recorder.flush();
    await this.recorder.idle();
  }

  verify(withDiskSubmission = true): VerifyReport {
    // What the student would hand in: saved files, or the editor's text for open documents.
    const files = new Map(this.host.disk);
    for (const [rel, doc] of this.host.docs) files.set(rel, doc.text);
    const submission = withDiskSubmission
      ? [...files.entries()]
          .filter(([p]) => this.host.tracked(p) && !this.host.binary.has(p))
          .map(([path, content]) => ({ path, content }))
      : undefined;
    return verifyLog(this.bytes, submission ? { submission } : {});
  }

  // ---- editor actions -------------------------------------------------------------------------

  open(rel: string): void {
    const text = this.host.disk.get(rel) ?? '';
    this.host.docs.set(rel, { text, dirty: false });
    this.recorder.onDocumentOpened(rel, text);
  }

  close(rel: string): void {
    this.host.docs.delete(rel);
  }

  private doc(rel: string): Doc {
    let d = this.host.docs.get(rel);
    if (!d) {
      d = { text: this.host.disk.get(rel) ?? '', dirty: false };
      this.host.docs.set(rel, d);
    }
    return d;
  }

  /** Applies simultaneous changes (relative to the current text) like one VS Code event. */
  change(rel: string, changes: EditorChange[], reason?: EditReason, opts: { dirty?: boolean } = {}): void {
    const d = this.doc(rel);
    const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
    let out = '';
    let pos = 0;
    for (const c of sorted) {
      out += d.text.slice(pos, c.rangeOffset) + c.text;
      pos = c.rangeOffset + c.rangeLength;
    }
    out += d.text.slice(pos);
    d.text = out;
    const wasDirty = d.dirty;
    d.dirty = opts.dirty ?? true;
    const reported = this.host.staleDirtyFlag && d.dirty && !wasDirty ? false : d.dirty;
    this.recorder.onDocumentChanged(
      rel,
      changes,
      reason,
      reported,
      () => d.text,
      () => d.dirty,
    );
  }

  type(rel: string, offset: number, text: string, msPerChar = 120): void {
    let pos = offset;
    for (const ch of text) {
      this.host.advance(msPerChar);
      this.change(rel, [{ rangeOffset: pos, rangeLength: 0, text: ch }]);
      pos += ch.length;
    }
  }

  typeAtEnd(rel: string, text: string): void {
    this.type(rel, this.doc(rel).text.length, text);
  }

  backspace(rel: string, offset: number, count = 1): void {
    this.host.advance(100);
    this.change(rel, [{ rangeOffset: offset - count, rangeLength: count, text: '' }]);
  }

  paste(rel: string, offset: number, text: string): void {
    this.host.clipboard = text;
    this.host.advance(400);
    this.change(rel, [{ rangeOffset: offset, rangeLength: 0, text }]);
  }

  insert(rel: string, offset: number, text: string, reason?: EditReason): void {
    this.host.advance(300);
    this.change(rel, [{ rangeOffset: offset, rangeLength: 0, text }], reason);
  }

  text(rel: string): string {
    return this.host.docs.get(rel)?.text ?? this.host.disk.get(rel) ?? '';
  }

  save(rel: string, formatEdits: EditorChange[] = []): void {
    this.recorder.onWillSave(rel);
    if (formatEdits.length > 0) this.change(rel, formatEdits);
    const d = this.doc(rel);
    this.host.disk.set(rel, d.text);
    d.dirty = false;
    this.host.advance(50);
    this.recorder.onDidSave(rel, d.text);
  }

  /** Another program writes the file. Clean open documents reload like VS Code does. */
  externalWrite(rel: string, text: string): void {
    this.host.disk.set(rel, text);
    const d = this.host.docs.get(rel);
    if (d && !d.dirty) {
      const old = d.text;
      this.change(rel, [{ rangeOffset: 0, rangeLength: old.length, text }], undefined, { dirty: false });
    }
    this.recorder.onDiskEvent(rel);
  }

  externalDelete(rel: string): void {
    this.host.disk.delete(rel);
    this.recorder.onDiskEvent(rel);
  }

  /** "Revert File": the buffer is replaced by the disk content and becomes clean. */
  revert(rel: string): void {
    const d = this.doc(rel);
    const disk = this.host.disk.get(rel) ?? '';
    this.change(rel, [{ rangeOffset: 0, rangeLength: d.text.length, text: disk }], undefined, {
      dirty: false,
    });
  }

  createViaEditor(rel: string, content = ''): void {
    this.host.disk.set(rel, content);
    this.recorder.onFilesCreated([rel]);
    this.recorder.onDiskEvent(rel);
  }

  deleteViaEditor(rel: string): void {
    for (const p of [...this.host.disk.keys()])
      if (p === rel || p.startsWith(`${rel}/`)) this.host.disk.delete(p);
    this.host.docs.delete(rel);
    this.recorder.onFilesDeleted([rel]);
    this.recorder.onDiskEvent(rel);
  }

  renameViaEditor(from: string, to: string): void {
    for (const p of [...this.host.disk.keys()]) {
      if (p === from || p.startsWith(`${from}/`)) {
        const target = to + p.slice(from.length);
        this.host.disk.set(target, this.host.disk.get(p)!);
        this.host.disk.delete(p);
        const d = this.host.docs.get(p);
        if (d) {
          this.host.docs.delete(p);
          this.host.docs.set(target, d);
        }
      }
    }
    this.recorder.onFilesRenamed([{ from, to }]);
    this.recorder.onDiskEvent(from);
    this.recorder.onDiskEvent(to);
  }
}

/** Codes of non-pass findings. */
export function issues(report: VerifyReport): string[] {
  return report.findings.filter((f) => f.severity !== 'pass').map((f) => `${f.severity}:${f.code}`);
}

/** Final text of a file in the log. */
export function loggedText(bytes: Uint8Array, path: string): string | undefined {
  const r = new Replayer();
  for (const entry of readLog(bytes).records) r.apply(entry.record);
  return r.fileByPath(path)?.text;
}
