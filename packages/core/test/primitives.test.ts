import { describe, expect, it } from 'vitest';
import {
  base32,
  bytesEqual,
  compareBytes,
  comparePaths,
  concatBytes,
  contentHash,
  countCodePoints,
  countNonWhitespace,
  crc32,
  detectEol,
  ds,
  fromHex,
  isTapError,
  isValidRelPath,
  isWellFormed,
  keyFingerprint,
  normalizeText,
  readU32be,
  relPathError,
  TapError,
  toHex,
  toLogPath,
  toWellFormed,
  u32be,
  u64be,
  utf8,
} from '../src/index.js';

describe('bytes', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(utf8('xx123456789yy'), 2, 11)).toBe(0xcbf43926);
  });

  it('hex round-trips and rejects bad input', () => {
    const b = new Uint8Array([0, 1, 0xab, 0xff]);
    expect(toHex(b)).toBe('0001abff');
    expect(fromHex('0001ABff')).toEqual(b);
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });

  it('encodes big-endian integers and rejects out-of-range values', () => {
    expect(u32be(0x01020304)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(readU32be(new Uint8Array([9, 1, 2, 3, 4]).subarray(1), 0)).toBe(0x01020304);
    expect(u64be(2 ** 40 + 5)).toEqual(new Uint8Array([0, 0, 1, 0, 0, 0, 0, 5]));
    expect(() => u32be(-1)).toThrow(RangeError);
    expect(() => u32be(2 ** 32)).toThrow(RangeError);
    expect(() => u64be(-1)).toThrow(RangeError);
    expect(() => u64be(2 ** 53)).toThrow(RangeError);
  });

  it('base32 follows RFC 4648 (no padding)', () => {
    expect(base32(utf8(''))).toBe('');
    expect(base32(utf8('f'))).toBe('MY');
    expect(base32(utf8('fo'))).toBe('MZXQ');
    expect(base32(utf8('foobar'))).toBe('MZXW6YTBOI');
  });

  it('compares and concatenates bytes', () => {
    expect(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBeLessThan(0);
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBeLessThan(0);
    expect(compareBytes(new Uint8Array([2]), new Uint8Array([1, 9]))).toBeGreaterThan(0);
    expect(
      bytesEqual(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3])), new Uint8Array([1, 2, 3])),
    ).toBe(true);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
  });

  it('domain separators end with a zero byte', () => {
    expect(ds('ab')).toEqual(new Uint8Array([0x61, 0x62, 0]));
  });

  it('key fingerprints are 20 base32 chars in groups of four', () => {
    expect(keyFingerprint(new Uint8Array(32))).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/);
  });

  it('TapError carries code and position', () => {
    const e = new TapError('BAD_CRC', 'x', { offset: 5, seq: 2 });
    expect(isTapError(e)).toBe(true);
    expect(isTapError(new Error('x'))).toBe(false);
    expect(e.code).toBe('BAD_CRC');
    expect(e.offset).toBe(5);
    expect(e.seq).toBe(2);
    expect(e.message).toBe('BAD_CRC: x');
  });
});

describe('text', () => {
  it('normalises BOM and line endings only', () => {
    expect(normalizeText('\ufeffa\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(normalizeText('  x  \t')).toBe('  x  \t');
    expect(normalizeText('\ufeff\ufeffx')).toBe('\ufeffx');
    expect(normalizeText('a\r\r\nb\r\rc')).toBe('a\nb\n\nc');
  });

  it('is stable under CRLF <-> LF conversion (as done by Git)', () => {
    const samples = ['a\r\r\n\nb', '\r\n\r\r\n', 'x\ry\r\n', '\n\r', '\r'];
    for (const s of samples) {
      expect(normalizeText(s.replace(/\r\n/g, '\n'))).toBe(normalizeText(s));
      expect(normalizeText(s.replace(/\n/g, '\r\n'))).toBe(normalizeText(s));
    }
  });

  it('content hash is equal for CRLF, LF and BOM variants', () => {
    expect(contentHash('a\r\nb')).toEqual(contentHash('a\nb'));
    expect(contentHash('\ufeffa\nb')).toEqual(contentHash('a\nb'));
    expect(contentHash('a\nb')).not.toEqual(contentHash('a\nb\n'));
  });

  it('detects line endings', () => {
    expect(detectEol('a\nb')).toBe('lf');
    expect(detectEol('a\r\nb\n')).toBe('crlf');
    expect(detectEol('')).toBe('lf');
  });

  it('checks and repairs lone surrogates', () => {
    expect(isWellFormed('ok 😀')).toBe(true);
    expect(isWellFormed('\ud83d')).toBe(false);
    expect(isWellFormed('\ude00x')).toBe(false);
    expect(isWellFormed('\ud83dx')).toBe(false);
    expect(toWellFormed('a\ud83db')).toBe('a\ufffdb');
    expect(toWellFormed('\ude00')).toBe('\ufffd');
    expect(toWellFormed('😀')).toBe('😀');
    expect(toWellFormed('x😀\ud800')).toBe('x😀\ufffd');
  });

  it('counts code points and non-whitespace', () => {
    expect(countCodePoints('a😀b')).toBe(3);
    expect(countNonWhitespace(' a\tb\n c ')).toBe(3);
  });
});

describe('paths', () => {
  it('accepts workspace-relative paths', () => {
    for (const p of ['main.cpp', 'src/a/b.py', '.tap/config.json', 'dir with space/ü.txt']) {
      expect(relPathError(p)).toBeUndefined();
      expect(isValidRelPath(p)).toBe(true);
    }
  });

  it('rejects unsafe or ambiguous paths', () => {
    for (const p of [
      '',
      '/abs',
      'a\\b',
      'C:/x',
      'a//b',
      'a/./b',
      '../x',
      'a/..',
      'x\0y',
      'a/',
      'x'.repeat(5000),
    ]) {
      expect(relPathError(p), p).toBeDefined();
    }
  });

  it('orders paths by UTF-8 bytes, not UTF-16 units', () => {
    // U+FF61 sorts after U+1F600 in UTF-16 (0xFF61 > 0xD83D) but before it in UTF-8.
    expect(comparePaths('\uff61', '😀')).toBeLessThan(0);
    expect('\uff61' < '😀').toBe(false);
  });

  it('converts OS paths', () => {
    expect(toLogPath('src\\a.py')).toBe('src/a.py');
    expect(toLogPath('./a.py')).toBe('a.py');
  });
});

describe('crypto', () => {
  it('generates, signs and verifies', async () => {
    const { generateKeyPair, keyPairFromSeed, publicKeyOf, signMessage, verifySignature } = await import(
      '../src/index.js'
    );
    const kp = generateKeyPair();
    expect(kp.publicKey).toEqual(publicKeyOf(kp.secretKey));
    const msg = utf8('m');
    const sig = signMessage(msg, kp.secretKey);
    expect(verifySignature(sig, msg, kp.publicKey)).toBe(true);
    expect(verifySignature(sig, utf8('n'), kp.publicKey)).toBe(false);
    expect(verifySignature(sig, msg, new Uint8Array(5))).toBe(false);
    expect(() => keyPairFromSeed(new Uint8Array(3))).toThrow(RangeError);
    // Deterministic from seed.
    expect(keyPairFromSeed(new Uint8Array(32)).publicKey).toEqual(
      keyPairFromSeed(new Uint8Array(32)).publicKey,
    );
  });
});
