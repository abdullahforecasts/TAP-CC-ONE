import { decodeFirst, encode, rfc8949EncodeOptions } from 'cborg';
import { bytesEqual } from './bytes.js';
import { TapError } from './errors.js';

/**
 * The CBOR subset used by the format (spec §4):
 *   unsigned/negative integers within the JS safe range, byte strings, UTF-8 text strings,
 *   arrays, maps with text keys, and booleans.
 * Not allowed: floats, null, undefined, tags, indefinite lengths, duplicate keys, bigints.
 */
export type CborValue = number | boolean | string | Uint8Array | CborValue[] | { [key: string]: CborValue };

const DECODE_OPTIONS = {
  strict: true,
  allowIndefinite: false,
  allowUndefined: false,
  allowBigInt: false,
  allowNaN: false,
  allowInfinity: false,
  rejectDuplicateMapKeys: true,
  useMaps: false,
} as const;

const MAX_DEPTH = 32;

/** Throws CBOR_UNSUPPORTED_VALUE unless `value` is inside the allowed subset. */
export function assertCborValue(value: unknown, path = '$', depth = 0): asserts value is CborValue {
  if (depth > MAX_DEPTH)
    throw new TapError('CBOR_UNSUPPORTED_VALUE', `${path}: nesting deeper than ${MAX_DEPTH}`);
  switch (typeof value) {
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TapError(
          'CBOR_UNSUPPORTED_VALUE',
          `${path}: only safe integers are allowed (got ${value})`,
        );
      }
      return;
    case 'boolean':
    case 'string':
      return;
    case 'object': {
      if (value === null) throw new TapError('CBOR_UNSUPPORTED_VALUE', `${path}: null is not allowed`);
      if (value instanceof Uint8Array) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) assertCborValue(value[i], `${path}[${i}]`, depth + 1);
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TapError('CBOR_UNSUPPORTED_VALUE', `${path}: unsupported object type`);
      }
      for (const [k, v] of Object.entries(value)) assertCborValue(v, `${path}.${k}`, depth + 1);
      return;
    }
    default:
      throw new TapError('CBOR_UNSUPPORTED_VALUE', `${path}: unsupported type ${typeof value}`);
  }
}

/** Deterministic encoding (RFC 8949 §4.2.1): shortest forms, map keys sorted bytewise. */
export function encodeCanonical(value: CborValue): Uint8Array {
  assertCborValue(value);
  // cborg reuses an internal buffer; copy so callers own the bytes.
  return new Uint8Array(encode(value, rfc8949EncodeOptions));
}

export interface DecodedItem {
  value: CborValue;
  /** The exact canonical bytes of this item (a view into the input). */
  bytes: Uint8Array;
  /** Offset of the item within the input. */
  start: number;
}

function decodeOne(input: Uint8Array, start: number): DecodedItem {
  const view = input.subarray(start);
  let value: unknown;
  let rest: Uint8Array;
  try {
    [value, rest] = decodeFirst(view, DECODE_OPTIONS) as [unknown, Uint8Array];
  } catch (e) {
    throw new TapError('CBOR_INVALID', `at +${start}: ${(e as Error).message}`);
  }
  const consumed = view.length - rest.length;
  const bytes = view.subarray(0, consumed);
  try {
    assertCborValue(value);
  } catch (e) {
    throw new TapError('CBOR_NONCANONICAL', `at +${start}: ${(e as Error).message}`);
  }
  // Canonical check: re-encoding must reproduce the exact same bytes. This rejects non-shortest
  // integers/lengths, unsorted keys, floats that decode to integers, invalid UTF-8, etc.
  if (!bytesEqual(encodeCanonical(value), bytes)) {
    throw new TapError('CBOR_NONCANONICAL', `at +${start}: item is not in deterministic encoding`);
  }
  return { value, bytes, start };
}

/** Decodes exactly one canonical item filling the whole input. */
export function decodeCanonical(input: Uint8Array): CborValue {
  const item = decodeOne(input, 0);
  if (item.bytes.length !== input.length) {
    throw new TapError('CBOR_INVALID', `${input.length - item.bytes.length} trailing bytes after item`);
  }
  return item.value;
}

/** Decodes a CBOR sequence (RFC 8742) of canonical items. */
export function decodeCanonicalSequence(input: Uint8Array): DecodedItem[] {
  const items: DecodedItem[] = [];
  let pos = 0;
  while (pos < input.length) {
    const item = decodeOne(input, pos);
    if (item.bytes.length === 0) throw new TapError('CBOR_INVALID', `empty item at +${pos}`);
    items.push(item);
    pos += item.bytes.length;
  }
  return items;
}
