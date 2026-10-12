import {
  type BodyByKind,
  type ChangeTuple,
  contentHash,
  detectEol,
  type KeyPair,
  type KindName,
  keyPairFromSeed,
  LogWriter,
  type SnapshotOrigin,
  sha256,
  utf8,
} from '@tap/core';

/** Deterministic bytes derived from a label (vectors must be byte-identical on every run). */
export function seeded(label: string, length = 32): Uint8Array {
  return sha256(utf8(`tap-cc-one/vectors/${label}`)).slice(0, length);
}

export const BASE_TIME = Date.UTC(2026, 9, 12, 9, 0, 0); // 2026-10-12T09:00:00Z

export interface ScriptOptions {
  id: string;
  label?: string;
  keyLabel?: string;
  targetBlockSize?: number;
}

/**
 * A scripted recording session. Mirrors what the Part 2 recorder will emit, with a fake clock so
 * output is deterministic.
 */
export class Script {
  readonly writer: LogWriter;
  key: KeyPair;
  private t = BASE_TIME;
  private sessionStartT = 0;
  private sessionIndex = 0;
  private sid: Uint8Array | null = null;
  private readonly id: string;

  constructor(options: ScriptOptions, resumeFrom?: { bytes: Uint8Array; at: number }) {
    this.id = options.id;
    this.key = keyPairFromSeed(seeded(`key/${options.keyLabel ?? 'student-1'}`));
    if (resumeFrom) {
      // Continue an existing log (e.g. after crash recovery). Session numbering restarts at 100
      // so session ids never collide with the original run.
      this.t = resumeFrom.at;
      this.sessionStartT = resumeFrom.at;
      this.sessionIndex = 100;
      this.writer = LogWriter.resume(resumeFrom.bytes, { targetBlockSize: options.targetBlockSize ?? 4096 });
      return;
    }
    this.t = BASE_TIME;
    this.writer = LogWriter.create({
      created: BASE_TIME,
      tool: 'tap-cc-one/0.1.0 (vector generator)',
      label: options.label ?? options.id,
      logId: seeded(`log/${options.id}`, 16),
      targetBlockSize: options.targetBlockSize ?? 4096,
    });
  }

  get now(): { t: number; m: number } {
    return { t: this.t, m: this.t - this.sessionStartT };
  }

  tick(ms: number): this {
    this.t += ms;
    return this;
  }

  rec<K extends KindName>(kind: K, body: BodyByKind[K]): number {
    return this.writer.append(kind, body, this.now).s;
  }

  startSession(extra: Partial<BodyByKind['SESSION_START']> = {}): this {
    this.sessionIndex++;
    this.sessionStartT = this.t;
    this.sid = seeded(`sid/${this.id}/${this.sessionIndex}`, 16);
    this.rec('SESSION_START', {
      sid: this.sid,
      pub: this.key.publicKey,
      vsc: '1.105.0',
      app: 'vscode',
      os: 'linux',
      ext: '0.1.0',
      aiExt: [],
      liveShare: false,
      cfgHash: seeded('cfg/default'),
      ...extra,
    });
    return this;
  }

  endSession(reason: 'close' | 'reload' | 'deactivate' = 'close'): this {
    this.tick(500);
    this.rec('SESSION_END', { sid: this.sid!, reason });
    this.sid = null;
    return this;
  }

  snapshot(f: number, path: string, text: string, origin: SnapshotOrigin): this {
    this.tick(50);
    this.rec('FILE_SNAPSHOT', {
      f,
      path,
      origin,
      text,
      h: contentHash(text),
      eol: detectEol(text),
      enc: 'utf8',
    });
    return this;
  }

  create(f: number, path: string, origin: 'editor' | 'external' | 'fromUntitled' = 'editor'): this {
    this.tick(200);
    this.rec('FILE_OP', { op: 'create', f, path, origin });
    return this;
  }

  /** Types `text` one character (code point) at a time starting at `off`, `dt` ms apart. */
  type(f: number, off: number, text: string, dt = 120): this {
    const changes: ChangeTuple[] = [];
    let pos = off;
    for (const ch of text) {
      changes.push([dt, pos, 0, ch]);
      pos += ch.length;
    }
    return this.edit(f, changes);
  }

  /** Records raw change tuples (already in sequential order) as one or more 2-second batches. */
  edit(f: number, changes: ChangeTuple[]): this {
    let batch: ChangeTuple[] = [];
    let elapsed = 0;
    for (const c of changes) {
      batch.push(c);
      elapsed += c[0];
      this.t += c[0];
      if (elapsed >= 2000) {
        this.rec('EDIT_BATCH', { f, c: batch });
        batch = [];
        elapsed = 0;
      }
    }
    if (batch.length > 0) this.rec('EDIT_BATCH', { f, c: batch });
    return this;
  }

  save(f: number): this {
    this.tick(300);
    const file = this.writer.state.files.get(f)!;
    this.rec('SAVE', { f, h: contentHash(file.text), n: file.text.length });
    return this;
  }

  checkpoint(): number {
    this.tick(100);
    return this.writer.appendCheckpoint(this.key.secretKey, this.now).s;
  }

  bytes(): Uint8Array {
    return this.writer.drain();
  }
}
