/**
 * Minimal DER (ASN.1 Distinguished Encoding Rules) reader and writer: just enough for RFC 3161
 * timestamp requests and responses, CMS SignedData and X.509 certificates. Definite lengths only;
 * anything else is rejected with an AnchorError.
 */

export class AnchorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AnchorError';
  }
}

export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** One decoded element. `bytes` is the whole element (header + content). */
export interface Der {
  tag: number;
  /** Tag class: 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  /** Tag number within its class (low-tag-number form only). */
  num: number;
  bytes: Uint8Array;
  content: Uint8Array;
}

const MAX_DEPTH = 64;

/** Decodes the element at `offset`; returns it and the offset just after it. */
export function readDer(buf: Uint8Array, offset = 0): { el: Der; next: number } {
  if (offset + 2 > buf.length) throw new AnchorError('DER', 'truncated DER element');
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new AnchorError('DER', 'high tag numbers are not supported');
  let pos = offset + 1;
  const first = buf[pos++]!;
  let len: number;
  if (first < 0x80) len = first;
  else if (first === 0x80) throw new AnchorError('DER', 'indefinite length is not DER');
  else {
    const n = first & 0x7f;
    if (n > 4 || pos + n > buf.length) throw new AnchorError('DER', 'bad DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]!;
    if (len < 0x80 || (n > 1 && buf[pos - n] === 0)) throw new AnchorError('DER', 'non-minimal DER length');
  }
  const end = pos + len;
  if (end > buf.length) throw new AnchorError('DER', 'DER element runs past the end');
  return {
    el: {
      tag,
      cls: tag >> 6,
      constructed: (tag & 0x20) !== 0,
      num: tag & 0x1f,
      bytes: buf.subarray(offset, end),
      content: buf.subarray(pos, end),
    },
    next: end,
  };
}

/** Decodes a buffer that must hold exactly one element. */
export function parseDer(buf: Uint8Array): Der {
  const { el, next } = readDer(buf, 0);
  if (next !== buf.length) throw new AnchorError('DER', 'trailing bytes after DER element');
  return el;
}

/** Children of a constructed element. */
export function children(el: Der, depth = 0): Der[] {
  if (!el.constructed) throw new AnchorError('DER', 'expected a constructed element');
  if (depth > MAX_DEPTH) throw new AnchorError('DER', 'DER nesting too deep');
  const out: Der[] = [];
  let pos = 0;
  while (pos < el.content.length) {
    const { el: child, next } = readDer(el.content, pos);
    out.push(child);
    pos = next;
  }
  return out;
}

export function expect(el: Der | undefined, tag: number, what: string): Der {
  if (!el || el.tag !== tag) {
    throw new AnchorError('DER', `expected ${what}`);
  }
  return el;
}

/** Context-specific tag byte: [n], constructed or primitive. */
export function ctx(n: number, constructed: boolean): number {
  return 0x80 | (constructed ? 0x20 : 0) | n;
}

export function decodeOid(el: Der): string {
  expect(el, Tag.OID, 'OBJECT IDENTIFIER');
  const c = el.content;
  if (c.length === 0) throw new AnchorError('DER', 'empty OID');
  const parts: number[] = [];
  let value = 0;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!;
    if (value === 0 && b === 0x80) throw new AnchorError('DER', 'non-minimal OID');
    value = value * 128 + (b & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new AnchorError('DER', 'OID arc too large');
    if ((b & 0x80) === 0) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        parts.push(first, value - first * 40);
      } else parts.push(value);
      value = 0;
    } else if (i === c.length - 1) throw new AnchorError('DER', 'truncated OID');
  }
  return parts.join('.');
}

/** INTEGER as a non-negative bigint (negative values are rejected). */
export function decodeUint(el: Der): bigint {
  expect(el, Tag.INTEGER, 'INTEGER');
  const c = el.content;
  if (c.length === 0) throw new AnchorError('DER', 'empty INTEGER');
  if (c[0]! & 0x80) throw new AnchorError('DER', 'negative INTEGER');
  let v = 0n;
  for (const b of c) v = (v << 8n) | BigInt(b);
  return v;
}

/** INTEGER as a small number. */
export function decodeSmallInt(el: Der): number {
  const v = decodeUint(el);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new AnchorError('DER', 'INTEGER too large');
  return Number(v);
}

/** Bytes of a BIT STRING with no unused bits. */
export function decodeBitString(el: Der): Uint8Array {
  expect(el, Tag.BIT_STRING, 'BIT STRING');
  if (el.content.length === 0 || el.content[0] !== 0) {
    throw new AnchorError('DER', 'BIT STRING with unused bits');
  }
  return el.content.subarray(1);
}

/** GeneralizedTime or UTCTime → unix ms. Fractional seconds are kept (ms precision). */
export function decodeTime(el: Der): number {
  const s = new TextDecoder().decode(el.content);
  let m: RegExpMatchArray | null;
  if (el.tag === Tag.UTC_TIME) {
    m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new AnchorError('DER', `bad UTCTime ${s}`);
    const yy = Number(m[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (el.tag === Tag.GENERALIZED_TIME) {
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/);
    if (!m) throw new AnchorError('DER', `bad GeneralizedTime ${s}`);
    const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
      ms,
    );
  }
  throw new AnchorError('DER', 'expected a time');
}

// ---- writer --------------------------------------------------------------------------------

function lengthBytes(len: number): number[] {
  if (len < 0x80) return [len];
  const out: number[] = [];
  let v = len;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | out.length, ...out];
}

export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const total = content.reduce((n, c) => n + c.length, 0);
  const head = [tag, ...lengthBytes(total)];
  const out = new Uint8Array(head.length + total);
  out.set(head, 0);
  let pos = head.length;
  for (const c of content) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export const seq = (...items: Uint8Array[]) => tlv(Tag.SEQUENCE, ...items);
export const set = (...items: Uint8Array[]) => tlv(Tag.SET, ...items);
export const octets = (b: Uint8Array) => tlv(Tag.OCTET_STRING, b);
export const nullDer = () => tlv(Tag.NULL);
export const bool = (v: boolean) => tlv(Tag.BOOLEAN, new Uint8Array([v ? 0xff : 0]));
export const bitString = (b: Uint8Array) => tlv(Tag.BIT_STRING, new Uint8Array([0]), b);
export const utf8 = (s: string) => tlv(Tag.UTF8_STRING, new TextEncoder().encode(s));

/** INTEGER from a non-negative bigint or number. */
export function uint(v: bigint | number): Uint8Array {
  let n = BigInt(v);
  if (n < 0n) throw new RangeError('negative');
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(Tag.INTEGER, new Uint8Array(bytes));
}

/** INTEGER from big-endian magnitude bytes (adds a leading zero when needed). */
export function uintBytes(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const mag = b.subarray(i);
  return mag[0]! & 0x80 ? tlv(Tag.INTEGER, new Uint8Array([0]), mag) : tlv(Tag.INTEGER, mag);
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  const arcs = [parts[0]! * 40 + parts[1]!, ...parts.slice(2)];
  const out: number[] = [];
  for (const arc of arcs) {
    const chunk: number[] = [arc & 0x7f];
    let v = Math.floor(arc / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  }
  return tlv(Tag.OID, new Uint8Array(out));
}

/** GeneralizedTime with millisecond precision when the time has milliseconds. */
export function generalizedTime(ms: number): Uint8Array {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  let s = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(
    d.getUTCMinutes(),
  )}${p(d.getUTCSeconds())}`;
  const frac = d.getUTCMilliseconds();
  if (frac) s += `.${p(frac, 3).replace(/0+$/, '')}`;
  return tlv(Tag.GENERALIZED_TIME, new TextEncoder().encode(`${s}Z`));
}

export function utcTime(ms: number): Uint8Array {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(
    d.getUTCMinutes(),
  )}${p(d.getUTCSeconds())}Z`;
  return tlv(Tag.UTC_TIME, new TextEncoder().encode(s));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new AnchorError('HEX', 'bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
