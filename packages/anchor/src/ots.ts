/**
 * OpenTimestamps proofs (https://opentimestamps.org): the binary timestamp serialisation used by
 * calendars and .ots files, evaluation, merging (upgrades) and attestation checks.
 *
 * A timestamp is a tree: starting from a message (our 32-byte checkpoint digest), operations
 * (append, prepend, hashes) lead to commitments, and attestations at the leaves say where a
 * commitment was recorded: "pending" at a calendar, or in the merkle root of a Bitcoin block.
 */

import { ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { AnchorError, bytesEqual, concat, fromHex, toHex } from './der.js';

const TAG_PENDING = '83dfe30d2ef90c8e';
const TAG_BITCOIN = '0588960d73d71901';

const MAX_MSG = 4096;
const MAX_DEPTH = 256;
const MAX_NODES = 10_000;
const MAX_PAYLOAD = 8192;

export type Op =
  | { kind: 'append' | 'prepend'; arg: Uint8Array }
  | { kind: 'sha1' | 'ripemd160' | 'sha256' | 'keccak256' | 'reverse' | 'hexlify' };

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: string; payload: Uint8Array };

export interface Timestamp {
  msg: Uint8Array;
  attestations: Attestation[];
  ops: Array<{ op: Op; stamp: Timestamp }>;
}

const OP_TAG: Record<Op['kind'], number> = {
  append: 0xf0,
  prepend: 0xf1,
  reverse: 0xf2,
  hexlify: 0xf3,
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
};

export function applyOp(op: Op, msg: Uint8Array): Uint8Array {
  let out: Uint8Array;
  switch (op.kind) {
    case 'append':
      out = concat(msg, op.arg);
      break;
    case 'prepend':
      out = concat(op.arg, msg);
      break;
    case 'reverse':
      out = msg.slice().reverse();
      break;
    case 'hexlify':
      out = new TextEncoder().encode(toHex(msg));
      break;
    case 'sha1':
      out = sha1(msg);
      break;
    case 'ripemd160':
      out = ripemd160(msg);
      break;
    case 'sha256':
      out = sha256(msg);
      break;
    case 'keccak256':
      out = keccak_256(msg);
      break;
  }
  if (out.length > MAX_MSG) throw new AnchorError('OTS_MALFORMED', 'message too long');
  return out;
}

// ---- reading -------------------------------------------------------------------------------

class Reader {
  pos = 0;
  nodes = 0;
  constructor(readonly buf: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new AnchorError('OTS_MALFORMED', 'truncated timestamp');
    return this.buf[this.pos++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new AnchorError('OTS_MALFORMED', 'truncated timestamp');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 49) throw new AnchorError('OTS_MALFORMED', 'varuint too large');
    }
    return value;
  }
  varbytes(max: number): Uint8Array {
    const n = this.varuint();
    if (n > max) throw new AnchorError('OTS_MALFORMED', 'field too long');
    return this.bytes(n);
  }
}

function readAttestation(r: Reader): Attestation {
  const tag = toHex(r.bytes(8));
  const payload = r.varbytes(MAX_PAYLOAD);
  const p = new Reader(payload);
  if (tag === TAG_PENDING) {
    const uri = new TextDecoder().decode(p.varbytes(1000));
    if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/.test(uri))
      throw new AnchorError('OTS_MALFORMED', 'bad calendar URI');
    return { kind: 'pending', uri };
  }
  if (tag === TAG_BITCOIN) return { kind: 'bitcoin', height: p.varuint() };
  return { kind: 'unknown', tag, payload };
}

function readOp(r: Reader, tag: number): Op {
  switch (tag) {
    case 0xf0:
      return { kind: 'append', arg: r.varbytes(MAX_MSG) };
    case 0xf1:
      return { kind: 'prepend', arg: r.varbytes(MAX_MSG) };
    case 0xf2:
      return { kind: 'reverse' };
    case 0xf3:
      return { kind: 'hexlify' };
    case 0x02:
      return { kind: 'sha1' };
    case 0x03:
      return { kind: 'ripemd160' };
    case 0x08:
      return { kind: 'sha256' };
    case 0x67:
      return { kind: 'keccak256' };
    default:
      throw new AnchorError('OTS_MALFORMED', `unknown operation 0x${tag.toString(16)}`);
  }
}

function readTimestamp(r: Reader, msg: Uint8Array, depth: number): Timestamp {
  if (depth > MAX_DEPTH || ++r.nodes > MAX_NODES)
    throw new AnchorError('OTS_MALFORMED', 'timestamp too complex');
  const ts: Timestamp = { msg, attestations: [], ops: [] };
  const handle = (tag: number) => {
    if (tag === 0x00) ts.attestations.push(readAttestation(r));
    else {
      const op = readOp(r, tag);
      ts.ops.push({ op, stamp: readTimestamp(r, applyOp(op, msg), depth + 1) });
    }
  };
  let tag = r.byte();
  while (tag === 0xff) {
    handle(r.byte());
    tag = r.byte();
  }
  handle(tag);
  return ts;
}

/** Parses a serialised timestamp (as a calendar returns it) for `msg`. */
export function parseOts(bytes: Uint8Array, msg: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  const ts = readTimestamp(r, msg, 0);
  if (r.pos !== bytes.length) throw new AnchorError('OTS_MALFORMED', 'trailing bytes after timestamp');
  return ts;
}

// ---- writing -------------------------------------------------------------------------------

function varuint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

function varbytes(b: Uint8Array): Uint8Array {
  return concat(new Uint8Array(varuint(b.length)), b);
}

function attestationBytes(a: Attestation): Uint8Array {
  switch (a.kind) {
    case 'pending':
      return concat(fromHex(TAG_PENDING), varbytes(varbytes(new TextEncoder().encode(a.uri))));
    case 'bitcoin':
      return concat(fromHex(TAG_BITCOIN), varbytes(new Uint8Array(varuint(a.height))));
    case 'unknown':
      return concat(fromHex(a.tag), varbytes(a.payload));
  }
}

function opBytes(op: Op): Uint8Array {
  const tag = new Uint8Array([OP_TAG[op.kind]]);
  return op.kind === 'append' || op.kind === 'prepend' ? concat(tag, varbytes(op.arg)) : tag;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Serialises a timestamp; attestations and operations are written in a canonical order. */
export function serializeOts(ts: Timestamp): Uint8Array {
  const atts = ts.attestations.map(attestationBytes).sort(compareBytes);
  const ops = ts.ops
    .map((o) => ({ op: opBytes(o.op), stamp: serializeOts(o.stamp) }))
    .sort((a, b) => compareBytes(a.op, b.op));
  if (atts.length === 0 && ops.length === 0) throw new AnchorError('OTS_MALFORMED', 'empty timestamp');
  const parts: Uint8Array[] = [];
  const items: Uint8Array[] = [
    ...atts.map((a) => concat(new Uint8Array([0x00]), a)),
    ...ops.map((o) => concat(o.op, o.stamp)),
  ];
  items.forEach((item, i) => {
    if (i < items.length - 1) parts.push(new Uint8Array([0xff]));
    parts.push(item);
  });
  return concat(...parts);
}

// ---- evaluation ----------------------------------------------------------------------------

export interface Leaf {
  attestation: Attestation;
  /** The commitment the attestation is about. */
  msg: Uint8Array;
}

export function leaves(ts: Timestamp): Leaf[] {
  const out: Leaf[] = ts.attestations.map((attestation) => ({ attestation, msg: ts.msg }));
  for (const { stamp } of ts.ops) out.push(...leaves(stamp));
  return out;
}

function opKey(op: Op): string {
  return toHex(opBytes(op));
}

/** Merges `other` (a timestamp for the same message) into `into`. */
export function mergeOts(into: Timestamp, other: Timestamp): void {
  if (!bytesEqual(into.msg, other.msg))
    throw new AnchorError('OTS_MALFORMED', 'cannot merge different messages');
  for (const a of other.attestations) {
    const key = toHex(attestationBytes(a));
    if (!into.attestations.some((b) => toHex(attestationBytes(b)) === key)) into.attestations.push(a);
  }
  for (const { op, stamp } of other.ops) {
    const existing = into.ops.find((o) => opKey(o.op) === opKey(op));
    if (existing) mergeOts(existing.stamp, stamp);
    else into.ops.push({ op, stamp });
  }
}

/** Finds the subtree whose message is `msg` (to graft an upgrade onto). */
export function findNode(ts: Timestamp, msg: Uint8Array): Timestamp | undefined {
  if (bytesEqual(ts.msg, msg)) return ts;
  for (const { stamp } of ts.ops) {
    const found = findNode(stamp, msg);
    if (found) return found;
  }
  return undefined;
}

export interface OtsSummary {
  /** Calendars still holding the commitment for a later Bitcoin transaction. */
  pending: string[];
  /** Bitcoin block heights with the commitment as their merkle root (lowest first). */
  bitcoin: Array<{ height: number; merkleRoot: Uint8Array }>;
}

export function summarizeOts(ts: Timestamp): OtsSummary {
  const out: OtsSummary = { pending: [], bitcoin: [] };
  for (const leaf of leaves(ts)) {
    if (leaf.attestation.kind === 'pending') out.pending.push(leaf.attestation.uri);
    else if (leaf.attestation.kind === 'bitcoin') {
      if (leaf.msg.length === 32) out.bitcoin.push({ height: leaf.attestation.height, merkleRoot: leaf.msg });
    }
  }
  out.bitcoin.sort((a, b) => a.height - b.height);
  return out;
}

/**
 * Checks a Bitcoin attestation against an 80-byte block header: the commitment must equal the
 * header's merkle root (bytes 36–68, internal byte order). Returns the block time (unix ms).
 */
export function checkBitcoinHeader(merkleRoot: Uint8Array, header: Uint8Array): number | undefined {
  if (header.length !== 80) return undefined;
  if (!bytesEqual(header.subarray(36, 68), merkleRoot)) return undefined;
  const t = header[68]! | (header[69]! << 8) | (header[70]! << 16) | (header[71]! * 2 ** 24);
  return t * 1000;
}

/** Bitcoin block hash (display order hex) of an 80-byte header. */
export function blockHash(header: Uint8Array): string {
  return toHex(sha256(sha256(header)).reverse());
}
