import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  checkMagic,
  crc32,
  encodeFrame,
  FRAME_OVERHEAD,
  MAGIC,
  MAX_BLOCK_RAW,
  parseFrame,
  readLog,
  scanForRecovery,
  TapError,
  u32be,
  utf8,
} from '../src/index.js';
import { RawLog, sessionStart, testKey } from './support/raw.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof TapError ? e.code : `non-tap: ${(e as Error).message}`;
  }
}

/** Builds a frame with arbitrary (possibly inconsistent) header fields and a correct CRC. */
function rawFrame(payload: Uint8Array, codec: number, rawLen: number): Uint8Array {
  const f = new Uint8Array(FRAME_OVERHEAD + payload.length);
  f.set(u32be(payload.length), 0);
  f[4] = codec;
  f.set(u32be(rawLen), 5);
  f.set(payload, 9);
  f.set(u32be(crc32(f, 0, 9 + payload.length)), 9 + payload.length);
  return f;
}

describe('block framing', () => {
  it('round-trips compressed and uncompressed blocks', () => {
    const text = utf8('hello world '.repeat(200));
    const z = encodeFrame(text, true);
    expect(z[4]).toBe(1);
    expect(z.length).toBeLessThan(text.length);
    expect(parseFrame(z, 0).raw).toEqual(text);
    const plain = encodeFrame(text, false);
    expect(plain[4]).toBe(0);
    expect(parseFrame(plain, 0)).toMatchObject({ offset: 0, length: plain.length, codec: 0 });
  });

  it('stores incompressible data uncompressed', () => {
    const noise = new Uint8Array(64).map((_, i) => (i * 7919 + 13) % 251);
    expect(encodeFrame(noise, true)[4]).toBe(0);
  });

  it('refuses empty and oversized blocks when encoding', () => {
    expect(code(() => encodeFrame(new Uint8Array(0), true))).toBe('EMPTY_BLOCK');
    expect(code(() => encodeFrame(new Uint8Array(MAX_BLOCK_RAW + 1), false))).toBe('BLOCK_TOO_LARGE');
  });

  it('detects truncation, checksum errors and bad headers', () => {
    const frame = encodeFrame(utf8('abc'), false);
    expect(code(() => parseFrame(frame.subarray(0, 5), 0))).toBe('TRUNCATED');
    expect(code(() => parseFrame(frame.subarray(0, frame.length - 1), 0))).toBe('TRUNCATED');
    const flipped = frame.slice();
    flipped[10] = flipped[10]! ^ 1;
    expect(code(() => parseFrame(flipped, 0))).toBe('BAD_CRC');
    expect(code(() => parseFrame(rawFrame(utf8('abc'), 7, 3), 0))).toBe('BAD_CODEC');
    expect(code(() => parseFrame(rawFrame(utf8('abc'), 0, 4), 0))).toBe('RAW_LEN_MISMATCH');
    expect(code(() => parseFrame(rawFrame(utf8('abc'), 0, 0), 0))).toBe('EMPTY_BLOCK');
    expect(code(() => parseFrame(rawFrame(utf8('abc'), 1, MAX_BLOCK_RAW + 1), 0))).toBe('BLOCK_TOO_LARGE');
    expect(code(() => parseFrame(rawFrame(new Uint8Array(2000), 1, 10), 0))).toBe('BLOCK_TOO_LARGE');
  });

  it('bounds decompression by raw_len (decompression bomb)', () => {
    const bomb = deflateSync(new Uint8Array(1 << 20), { level: 9 });
    expect(code(() => parseFrame(rawFrame(bomb, 1, 200), 0))).toBe('RAW_LEN_MISMATCH');
    const short = deflateSync(utf8('abc'));
    expect(code(() => parseFrame(rawFrame(short, 1, 10), 0))).toBe('RAW_LEN_MISMATCH');
    expect(code(() => parseFrame(rawFrame(new Uint8Array([0xff, 0xff, 0xff]), 1, 10), 0))).toBe(
      'DECOMPRESS_FAILED',
    );
  });

  it('checks the magic bytes', () => {
    expect(code(() => checkMagic(MAGIC))).toBeUndefined();
    expect(code(() => checkMagic(MAGIC.subarray(0, 4)))).toBe('BAD_MAGIC');
    // A text-mode transfer that turns CRLF into LF breaks the magic.
    expect(code(() => checkMagic(new Uint8Array([0x89, 0x43, 0x4c, 0x47, 0x0a, 0x1a, 0x0a, 0])))).toBe(
      'BAD_MAGIC',
    );
  });
});

describe('reader', () => {
  function sampleLog(): RawLog {
    const key = testKey();
    const log = new RawLog({ label: 'x' });
    log.push('SESSION_START', sessionStart(key.publicKey));
    log.push('FOCUS', { on: true });
    return log;
  }

  it('reads header, blocks and records with positions', () => {
    const bytes = sampleLog().bytes(1);
    const parsed = readLog(bytes);
    expect(parsed.header.label).toBe('x');
    expect(parsed.blockCount).toBe(2);
    expect(parsed.records.map((r) => r.block)).toEqual([0, 1]);
    expect(parsed.records[1]!.blockOffset).toBeGreaterThan(parsed.records[0]!.blockOffset);
    expect(parsed.size).toBe(bytes.length);
  });

  it('rejects a compressed header, invalid header CBOR and bad header fields', () => {
    const log = sampleLog();
    const good = log.bytes();
    const headerEnd = MAGIC.length + FRAME_OVERHEAD + log.headerBytes.length;
    const zipped = new Uint8Array([
      ...MAGIC,
      ...rawFrame(deflateSync(log.headerBytes), 1, log.headerBytes.length),
    ]);
    expect(code(() => readLog(zipped))).toBe('HEADER_INVALID');
    const badCbor = new Uint8Array([...MAGIC, ...rawFrame(new Uint8Array([0x18, 0x01]), 0, 2)]);
    expect(code(() => readLog(badCbor))).toMatch(/^CBOR_/);
    expect(code(() => readLog(new RawLog({ fmt: 2 }).bytes()))).toBe('HEADER_INVALID');
    expect(code(() => readLog(new RawLog({ extra: 1 }).bytes()))).toBe('HEADER_INVALID');
    expect(code(() => readLog(good.subarray(0, headerEnd)))).toBeUndefined();
  });

  it('reports CBOR and record errors with the block offset', () => {
    const log = sampleLog();
    const header = log.bytes().subarray(0, MAGIC.length + FRAME_OVERHEAD + log.headerBytes.length);
    const badRecord = new Uint8Array([
      ...header,
      ...encodeFrame(new Uint8Array([0xa1, 0x61, 0x78, 0x01]), false),
    ]);
    try {
      readLog(badRecord);
      expect.unreachable();
    } catch (e) {
      expect((e as TapError).code).toBe('RECORD_INVALID');
      expect((e as TapError).offset).toBe(header.length);
    }
    const badCbor = new Uint8Array([...header, ...encodeFrame(new Uint8Array([0x9f, 0x01, 0xff]), false)]);
    expect(code(() => readLog(badCbor))).toBe('CBOR_INVALID');
  });
});

describe('recovery scan', () => {
  it('returns the whole file when intact', () => {
    const bytes = new RawLog().bytes();
    expect(scanForRecovery(bytes)).toEqual({ validLength: bytes.length, lost: new Uint8Array(0) });
  });

  it('finds the valid prefix of a truncated log', () => {
    const log = new RawLog();
    log.push('SESSION_START', sessionStart(testKey().publicKey));
    log.push('FOCUS', { on: true });
    const bytes = log.bytes(1);
    const cut = bytes.subarray(0, bytes.length - 3);
    const scan = scanForRecovery(cut);
    expect(scan.validLength).toBe(readLog(bytes).records[1]!.blockOffset);
    expect(scan.lost.length).toBe(cut.length - scan.validLength);
    expect(scan.reason).toMatch(/TRUNCATED/);
  });

  it('cannot recover a damaged header', () => {
    const bytes = new RawLog().bytes().slice();
    bytes[MAGIC.length + 12] = bytes[MAGIC.length + 12]! ^ 1;
    expect(code(() => scanForRecovery(bytes))).toBe('HEADER_INVALID');
    expect(code(() => scanForRecovery(new Uint8Array(3)))).toBe('BAD_MAGIC');
  });
});
