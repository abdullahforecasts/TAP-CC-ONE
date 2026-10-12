import { randomBytes } from '@noble/hashes/utils.js';
import { bytesEqual, concatBytes } from './bytes.js';
import { type CborValue, encodeCanonical } from './cbor.js';
import {
  DEFAULT_TARGET_BLOCK_RAW,
  FORMAT_VERSION,
  HASH_ALG,
  Kind,
  type KindName,
  MAGIC,
  MAX_BLOCK_RAW,
  SIG_ALG,
} from './constants.js';
import { checkpointMessage, publicKeyOf, signMessage } from './crypto.js';
import { TapError } from './errors.js';
import { encodeFrame } from './framing.js';
import { genesisHash, recordHash, sha256 } from './hash.js';
import { readLog } from './reader.js';
import {
  type AnyRecord,
  type BodyByKind,
  type LogHeader,
  type RecoveryBody,
  validateBody,
} from './records.js';
import { Replayer } from './replay.js';

export interface RecordTime {
  /** Wall-clock time, unix ms UTC. */
  t: number;
  /** Monotonic ms since the current SESSION_START. */
  m: number;
}

export interface AppendResult {
  s: number;
  hash: Uint8Array;
}

export interface WriterOptions {
  /** Pack records into blocks of about this many uncompressed bytes. */
  targetBlockSize?: number;
  /** Compress blocks with deflate-raw (default true). */
  compress?: boolean;
}

export interface CreateOptions extends WriterOptions {
  created: number;
  tool: string;
  label?: string;
  /** 16 bytes; random when omitted. */
  logId?: Uint8Array;
}

/**
 * Append-only log writer (design §7, §11). It does no I/O: callers append records, then call
 * `drain()` and write the returned bytes to disk (sync or async, as they prefer).
 *
 * The writer replays everything it appends, so `writer.state` is always the exact state a verifier
 * will reconstruct. The recorder uses it as its shadow copy, and checkpoints are computed from it.
 * Appending a record that would not replay cleanly throws, and nothing is written.
 */
export class LogWriter {
  readonly header: LogHeader;
  readonly state: Replayer;
  private head: Uint8Array;
  private nextSeq: number;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private headerPending: Uint8Array | null;
  private activeKey: Uint8Array | null = null;
  private readonly targetBlockSize: number;
  private readonly compress: boolean;

  private constructor(
    header: LogHeader,
    headerBytes: Uint8Array,
    options: WriterOptions,
    resumed?: { head: Uint8Array; nextSeq: number; state: Replayer; activeKey: Uint8Array | null },
  ) {
    this.header = header;
    this.targetBlockSize = Math.min(options.targetBlockSize ?? DEFAULT_TARGET_BLOCK_RAW, MAX_BLOCK_RAW);
    this.compress = options.compress ?? true;
    if (resumed) {
      this.head = resumed.head;
      this.nextSeq = resumed.nextSeq;
      this.state = resumed.state;
      this.activeKey = resumed.activeKey;
      this.headerPending = null;
    } else {
      this.head = genesisHash(headerBytes);
      this.nextSeq = 0;
      this.state = new Replayer();
      this.headerPending = concatBytes(MAGIC, encodeFrame(headerBytes, false));
    }
  }

  /** Starts a new log. The first `drain()` returns the magic bytes and header block. */
  static create(options: CreateOptions): LogWriter {
    const header: LogHeader = {
      fmt: FORMAT_VERSION,
      logId: options.logId ?? randomBytes(16),
      created: options.created,
      tool: options.tool,
      hash: HASH_ALG,
      sig: SIG_ALG,
    };
    if (options.label !== undefined) header.label = options.label;
    const headerBytes = encodeCanonical(header as unknown as CborValue);
    return new LogWriter(header, headerBytes, options);
  }

  /**
   * Continues an existing, fully valid log (after recovery if needed). Every record is replayed
   * and the chain is checked; a log that does not verify structurally is refused.
   */
  static resume(existing: Uint8Array, options: WriterOptions = {}): LogWriter {
    const parsed = readLog(existing);
    let head = genesisHash(parsed.headerBytes);
    const state = new Replayer();
    let activeKey: Uint8Array | null = null;
    parsed.records.forEach((entry, i) => {
      const rec = entry.record;
      if (rec.s !== i || !bytesEqual(rec.p, head)) {
        throw new TapError('WRITER_STATE', 'existing log has a broken chain; refusing to append', {
          seq: rec.s,
        });
      }
      const failure = state.apply(rec).find((x) => x.severity === 'fail');
      if (failure) throw new TapError('REPLAY_FAILED', failure.message, { seq: rec.s });
      if (rec.k === Kind.SESSION_START) activeKey = rec.b.pub;
      head = recordHash(entry.bytes);
    });
    return new LogWriter(parsed.header, parsed.headerBytes, options, {
      head,
      nextSeq: parsed.records.length,
      state,
      activeKey,
    });
  }

  get seq(): number {
    return this.nextSeq;
  }

  get headHash(): Uint8Array {
    return this.head;
  }

  get hasPending(): boolean {
    return this.pending.length > 0 || this.headerPending !== null;
  }

  append<K extends KindName>(kind: K, body: BodyByKind[K], time: RecordTime): AppendResult {
    if (kind === 'CHECKPOINT') {
      throw new TapError('WRITER_STATE', 'use appendCheckpoint() to write checkpoints');
    }
    return this.appendRecord(kind, body, time);
  }

  /**
   * Appends a signed CHECKPOINT over the current state. The key must belong to the active
   * session (the `pub` of the most recent SESSION_START).
   */
  appendCheckpoint(secretKey: Uint8Array, time: RecordTime): AppendResult {
    if (!this.activeKey) throw new TapError('WRITER_STATE', 'checkpoint before any SESSION_START');
    if (!bytesEqual(publicKeyOf(secretKey), this.activeKey)) {
      throw new TapError('KEY_MISMATCH', 'signing key does not match the session public key');
    }
    const state = this.state.stateDigest();
    const sig = signMessage(
      checkpointMessage({ logId: this.header.logId, s: this.nextSeq, p: this.head, state, t: time.t }),
      secretKey,
    );
    return this.appendRecord('CHECKPOINT', { state, files: this.state.files.size, sig }, time);
  }

  /** Body for the RECOVERY record written after truncating a damaged tail (spec §8). */
  static recoveryBody(scan: { validLength: number; lost: Uint8Array }): RecoveryBody {
    return { lostBytes: scan.lost.length, quarantineHash: sha256(scan.lost), atOffset: scan.validLength };
  }

  private appendRecord<K extends KindName>(kind: K, body: BodyByKind[K], time: RecordTime): AppendResult {
    validateBody(kind, body);
    if (!Number.isSafeInteger(time.t) || time.t < 0 || !Number.isSafeInteger(time.m) || time.m < 0) {
      throw new TapError('RECORD_INVALID', 't and m must be non-negative integers');
    }
    const record = { s: this.nextSeq, k: Kind[kind], t: time.t, m: time.m, p: this.head, b: body };
    const bytes = encodeCanonical(record as unknown as CborValue);
    if (bytes.length > MAX_BLOCK_RAW) {
      throw new TapError('RECORD_TOO_LARGE', `record of ${bytes.length} bytes exceeds the block limit`);
    }
    // Replay before committing. Replayer.apply leaves the state unchanged when it reports a
    // failure, so a record that would not replay is rejected and nothing is written.
    const previousSeq = this.state.lastSeq;
    const issues = this.state.apply(record as AnyRecord);
    const failure = issues.find((x) => x.severity === 'fail');
    if (failure) {
      this.state.lastSeq = previousSeq;
      throw new TapError('REPLAY_FAILED', `${failure.code}: ${failure.message}`, { seq: record.s });
    }
    if (kind === 'SESSION_START') this.activeKey = (body as BodyByKind['SESSION_START']).pub;
    const hash = recordHash(bytes);
    this.head = hash;
    this.nextSeq++;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    return { s: record.s, hash };
  }

  /** Encodes all pending records into framed blocks and returns the bytes to append to the file. */
  drain(): Uint8Array {
    const out: Uint8Array[] = [];
    if (this.headerPending) {
      out.push(this.headerPending);
      this.headerPending = null;
    }
    let block: Uint8Array[] = [];
    let blockSize = 0;
    const flushBlock = () => {
      if (block.length === 0) return;
      out.push(encodeFrame(concatBytes(...block), this.compress));
      block = [];
      blockSize = 0;
    };
    for (const rec of this.pending) {
      if (
        blockSize > 0 &&
        (blockSize + rec.length > this.targetBlockSize || blockSize + rec.length > MAX_BLOCK_RAW)
      ) {
        flushBlock();
      }
      block.push(rec);
      blockSize += rec.length;
    }
    flushBlock();
    this.pending = [];
    this.pendingBytes = 0;
    return concatBytes(...out);
  }

  get pendingSize(): number {
    return this.pendingBytes;
  }
}
