import { describe, expect, it } from 'vitest';
import {
  assertCborValue,
  decodeCanonical,
  decodeCanonicalSequence,
  encodeCanonical,
  fromHex,
  TapError,
  toHex,
} from '../src/index.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof TapError ? e.code : `non-tap: ${(e as Error).message}`;
  }
}

describe('canonical CBOR', () => {
  it('encodes deterministically with keys sorted bytewise', () => {
    expect(toHex(encodeCanonical({ b: 1, a: 2, aa: 3 }))).toBe('a3616102616201626161' + '03');
    expect(toHex(encodeCanonical({ aa: 3, b: 1, a: 2 }))).toBe(toHex(encodeCanonical({ a: 2, b: 1, aa: 3 })));
  });

  it('uses shortest integer forms', () => {
    expect(toHex(encodeCanonical(23))).toBe('17');
    expect(toHex(encodeCanonical(24))).toBe('1818');
    expect(toHex(encodeCanonical(-1))).toBe('20');
    expect(toHex(encodeCanonical(2 ** 32))).toBe('1b0000000100000000');
  });

  it('round-trips all supported value types', () => {
    const value = {
      i: 5,
      n: -7,
      big: Number.MAX_SAFE_INTEGER,
      s: 'héllo 😀',
      b: new Uint8Array([1, 2, 3]),
      t: true,
      f: false,
      arr: [1, 'x', [new Uint8Array(0)]],
      m: { z: 1, y: {} },
    };
    expect(decodeCanonical(encodeCanonical(value))).toEqual(value);
  });

  it('decodes sequences and reports item offsets', () => {
    const a = encodeCanonical({ x: 1 });
    const b = encodeCanonical([1, 2]);
    const items = decodeCanonicalSequence(new Uint8Array([...a, ...b]));
    expect(items).toHaveLength(2);
    expect(items[1]!.start).toBe(a.length);
    expect(items[1]!.value).toEqual([1, 2]);
    expect(decodeCanonicalSequence(new Uint8Array(0))).toEqual([]);
  });

  const nonCanonical: Array<[string, string]> = [
    ['unsorted keys', 'a2616201616102'],
    ['non-shortest integer', '1801'],
    ['non-shortest length', '780161'],
    ['indefinite array', '9f01ff'],
    ['half float 1.0', 'f93c00'],
    ['double float 1.5', 'fb3ff8000000000000'],
    ['null', 'f6'],
    ['undefined', 'f7'],
    ['tag', 'c001'],
    ['duplicate keys', 'a2616101616102'],
    ['invalid UTF-8', '62fffe'],
    ['unsafe integer', '1bffffffffffffffff'],
    ['integer key', 'a10102'],
    ['truncated', '82 01'.replace(' ', '')],
  ];
  for (const [name, hex] of nonCanonical) {
    it(`rejects ${name}`, () => {
      const c = code(() => decodeCanonical(fromHex(hex)));
      expect(c === 'CBOR_INVALID' || c === 'CBOR_NONCANONICAL', `${name}: ${c}`).toBe(true);
    });
  }

  it('rejects trailing bytes for single items', () => {
    expect(code(() => decodeCanonical(fromHex('0101')))).toBe('CBOR_INVALID');
  });

  it('refuses to encode values outside the subset', () => {
    const bad: unknown[] = [
      1.5,
      Number.NaN,
      2 ** 53,
      null,
      undefined,
      new Map(),
      new Date(),
      () => 1,
      10n,
      Symbol('x'),
    ];
    for (const v of bad)
      expect(
        code(() => assertCborValue(v)),
        String(v),
      ).toBe('CBOR_UNSUPPORTED_VALUE');
    expect(code(() => encodeCanonical({ a: [1, 0.5] } as never))).toBe('CBOR_UNSUPPORTED_VALUE');
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(code(() => assertCborValue(deep))).toBe('CBOR_UNSUPPORTED_VALUE');
    expect(code(() => assertCborValue(Object.create(null)))).toBeUndefined();
  });
});
