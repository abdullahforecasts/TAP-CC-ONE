/**
 * A low-level log builder for tests. Unlike LogWriter it performs no validation or replay, so tests
 * can produce logs that are structurally valid but semantically wrong (bad signatures, mismatched
 * checkpoints, broken session structure...).
 */
import {
  type CborValue,
  checkpointMessage,
  concatBytes,
  encodeCanonical,
  encodeFrame,
  genesisHash,
  type KeyPair,
  Kind,
  type KindName,
  keyPairFromSeed,
  MAGIC,
  recordHash,
  sha256,
  signMessage,
  utf8,
} from '../../src/index.js';

export function testKey(label = 'k1'): KeyPair {
  return keyPairFromSeed(sha256(utf8(`test-key/${label}`)));
}

export const LOG_ID = sha256(utf8('test-log')).slice(0, 16);
export const SID = sha256(utf8('sid')).slice(0, 16);
export const ZERO32 = new Uint8Array(32);

export function sessionStart(pub: Uint8Array, sid: Uint8Array = SID) {
  return {
    sid,
    pub,
    vsc: '1.105.0',
    app: 'vscode',
    os: 'linux',
    ext: '0.1.0',
    aiExt: [] as string[],
    liveShare: false,
    cfgHash: ZERO32,
  };
}

interface PushOptions {
  /** Override the sequence number. */
  s?: number;
  /** Override the previous-hash link. */
  p?: Uint8Array;
}

export class RawLog {
  readonly headerBytes: Uint8Array;
  private head: Uint8Array;
  private nextSeq = 0;
  readonly records: Uint8Array[] = [];
  readonly hashes: Uint8Array[] = [];
  t = 1_000_000;
  m = 0;

  constructor(header: Record<string, CborValue> = {}) {
    this.headerBytes = encodeCanonical({
      fmt: 1,
      logId: LOG_ID,
      created: 1_000_000,
      tool: 'test',
      hash: 'sha-256',
      sig: 'ed25519',
      ...header,
    });
    this.head = genesisHash(this.headerBytes);
  }

  get seq(): number {
    return this.nextSeq;
  }

  get headHash(): Uint8Array {
    return this.head;
  }

  push(kind: KindName, body: Record<string, unknown>, options: PushOptions = {}): number {
    const s = options.s ?? this.nextSeq;
    const rec = { s, k: Kind[kind], t: this.t, m: this.m, p: options.p ?? this.head, b: body };
    const bytes = encodeCanonical(rec as unknown as CborValue);
    this.records.push(bytes);
    this.head = recordHash(bytes);
    this.hashes.push(this.head);
    this.nextSeq = s + 1;
    this.t += 10;
    this.m += 10;
    return s;
  }

  checkpoint(key: KeyPair, state: Uint8Array, files: number, options: { badSig?: boolean } = {}): number {
    const s = this.nextSeq;
    const sig = signMessage(
      checkpointMessage({ logId: LOG_ID, s, p: this.head, state, t: this.t }),
      key.secretKey,
    );
    if (options.badSig) sig[0] = sig[0]! ^ 1;
    return this.push('CHECKPOINT', { state, files, sig });
  }

  /** Frames all records, `perBlock` records per block. */
  bytes(perBlock = 1000): Uint8Array {
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < this.records.length; i += perBlock) {
      blocks.push(encodeFrame(concatBytes(...this.records.slice(i, i + perBlock)), true));
    }
    return concatBytes(MAGIC, encodeFrame(this.headerBytes, false), ...blocks);
  }
}
