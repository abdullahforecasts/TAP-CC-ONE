import { describe, expect, it } from 'vitest';
import {
  type BodyByKind,
  Flag,
  Kind,
  type KindName,
  kindName,
  LARGE_INSERT_THRESHOLD,
  TapError,
  validateBody,
  validateHeader,
  validateRecord,
} from '../src/index.js';
import { sessionStart, testKey, ZERO32 } from './support/raw.js';

const SIG = new Uint8Array(64);
const SID = new Uint8Array(16);

/** One valid body per kind. */
export const VALID_BODIES: { [K in KindName]: BodyByKind[K] } = {
  SESSION_START: { ...sessionStart(testKey().publicKey), settings: { 'tap.record.focus': true } },
  SESSION_END: { sid: SID, reason: 'close' },
  FILE_SNAPSHOT: { f: 0, path: 'a.c', origin: 'preexisting', text: 'x', h: ZERO32, eol: 'lf', enc: 'utf8' },
  EDIT_BATCH: {
    f: 0,
    c: [
      [10, 0, 0, 'a'],
      [5, 1, 0, 'b', Flag.PASTE],
    ],
  },
  SAVE: { f: 0, h: ZERO32, n: 2 },
  FILE_OP: { op: 'rename', f: 0, path: 'a.c', newPath: 'b.c', origin: 'editor' },
  EXTERNAL_CHANGE: { f: 0, h: ZERO32, hint: 'vcs' },
  RUN_START: { rid: 1, kind: 'terminal', cmd: 'g++ a.cpp', cwd: 'src' },
  RUN_END: { rid: 1, exit: -1 },
  FOCUS: { on: false },
  PAUSE: { why: 'lunch' },
  RESUME: {},
  CHECKPOINT: { state: ZERO32, files: 1, sig: SIG },
  ANCHOR: {
    ck: 3,
    d: ZERO32,
    type: 'ots',
    src: 'https://a.pool.opentimestamps.org',
    tok: new Uint8Array([1]),
    status: 'pending',
  },
  RECOVERY: { lostBytes: 10, quarantineHash: ZERO32, atOffset: 100 },
  NOTE: { text: 'Starter code from the course page.' },
  KEY_ROTATION: { oldPub: ZERO32, newPub: ZERO32, why: 'manual' },
  CLOCK_ANOMALY: { wallDelta: -5000, monoDelta: 10 },
  ENV_CHANGE: { aiExt: ['github.copilot'], liveShare: true },
};

function envelope(kind: KindName, body: unknown, extra: Record<string, unknown> = {}) {
  return { s: 0, k: Kind[kind], t: 1, m: 0, p: ZERO32, b: body, ...extra };
}

function err(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof TapError ? `${e.code}: ${e.message}` : String(e);
  }
}

describe('record validation', () => {
  for (const kind of Object.keys(VALID_BODIES) as KindName[]) {
    it(`accepts a valid ${kind}`, () => {
      const rec = validateRecord(envelope(kind, VALID_BODIES[kind]));
      expect(kindName(rec)).toBe(kind);
      expect(() => validateBody(kind, VALID_BODIES[kind])).not.toThrow();
    });
  }

  it('tolerates unknown body keys but not unknown envelope keys or kinds', () => {
    expect(err(() => validateRecord(envelope('FOCUS', { on: true, future: 1 })))).toBeUndefined();
    expect(err(() => validateRecord(envelope('FOCUS', { on: true }, { x: 1 })))).toMatch(/unknown key "x"/);
    expect(err(() => validateRecord({ ...envelope('FOCUS', { on: true }), k: 99 }))).toMatch(
      /unknown record kind/,
    );
    expect(err(() => validateRecord('nope'))).toMatch(/RECORD_INVALID/);
    expect(err(() => validateRecord({ ...envelope('FOCUS', { on: true }), p: new Uint8Array(3) }))).toMatch(
      /32 bytes/,
    );
  });

  const bad: Array<[string, KindName, Record<string, unknown>, RegExp]> = [
    ['missing field', 'FOCUS', {}, /on: missing/],
    ['wrong type', 'FOCUS', { on: 1 }, /expected boolean/],
    ['bad enum', 'SESSION_END', { sid: SID, reason: 'boom' }, /expected one of/],
    ['bad path', 'FILE_OP', { op: 'create', f: 0, path: '../x', origin: 'editor' }, /segment/],
    ['rename without newPath', 'FILE_OP', { op: 'rename', f: 0, path: 'a', origin: 'editor' }, /newPath/],
    [
      'newPath on delete',
      'FILE_OP',
      { op: 'delete', f: 0, path: 'a', newPath: 'b', origin: 'editor' },
      /newPath/,
    ],
    ['negative uint', 'SAVE', { f: -1, h: ZERO32, n: 0 }, /unsigned/],
    ['empty batch', 'EDIT_BATCH', { f: 0, c: [] }, /at least 1/],
    ['short tuple', 'EDIT_BATCH', { f: 0, c: [[1, 2, 3]] }, /change must be/],
    ['explicit zero flags', 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, 'a', 0]] }, /non-zero/],
    ['unknown flag bit', 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, 'a', 0x100]] }, /unknown flag/],
    [
      'undo and redo',
      'EDIT_BATCH',
      { f: 0, c: [[1, 0, 0, 'a', Flag.UNDO | Flag.REDO]] },
      /mutually exclusive/,
    ],
    [
      'paste and bulk',
      'EDIT_BATCH',
      { f: 0, c: [[1, 0, 0, 'a', Flag.PASTE | Flag.BULK]] },
      /mutually exclusive/,
    ],
    ['no-op change', 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, '']] }, /empty change/],
    ['LARGE without large text', 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, 'a', Flag.LARGE]] }, /LARGE/],
    [
      'large text without LARGE',
      'EDIT_BATCH',
      { f: 0, c: [[1, 0, 0, 'x'.repeat(LARGE_INSERT_THRESHOLD + 1)]] },
      /LARGE/,
    ],
    ['bad dt', 'EDIT_BATCH', { f: 0, c: [[-1, 0, 0, 'a']] }, /dt/],
    ['bad off', 'EDIT_BATCH', { f: 0, c: [[1, 1.5, 0, 'a']] }, /off/],
    ['bad del', 'EDIT_BATCH', { f: 0, c: [[1, 0, 'x', 'a']] }, /del/],
    ['bad ins', 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, 5]] }, /ins/],
    ['lone surrogate', 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, '\ud800']] }, /surrogate/],
    ['empty note', 'NOTE', { text: '' }, /shorter/],
    ['long note', 'NOTE', { text: '😀'.repeat(2001) }, /longer than 2000/],
    ['bad aiExt', 'SESSION_START', { ...VALID_BODIES.SESSION_START, aiExt: [1] }, /\[0\]/],
    ['aiExt not array', 'SESSION_START', { ...VALID_BODIES.SESSION_START, aiExt: 'x' }, /expected array/],
    ['settings not map', 'SESSION_START', { ...VALID_BODIES.SESSION_START, settings: [1] }, /expected map/],
    ['long tool name', 'RUN_START', { rid: 1, kind: 'task', name: 'x'.repeat(501) }, /longer/],
    ['bad cwd', 'RUN_START', { rid: 1, kind: 'task', cwd: '/abs' }, /absolute/],
    ['path not string', 'FILE_SNAPSHOT', { ...VALID_BODIES.FILE_SNAPSHOT, path: 5 }, /path string/],
    [
      'path lone surrogate',
      'FILE_SNAPSHOT',
      { ...VALID_BODIES.FILE_SNAPSHOT, path: 'a\ud800' },
      /surrogates/,
    ],
    ['body not a map', 'FOCUS', [] as never, /expected map/],
  ];
  for (const [name, kind, body, re] of bad) {
    it(`rejects ${name}`, () => {
      expect(err(() => validateRecord(envelope(kind, body)))).toMatch(re);
      expect(err(() => validateBody(kind, body))).toMatch(re);
    });
  }

  it('validates headers strictly', () => {
    const header = { fmt: 1, logId: SID, created: 1, tool: 't', hash: 'sha-256', sig: 'ed25519' };
    expect(validateHeader(header)).toBe(header);
    expect(err(() => validateHeader({ ...header, label: 'x'.repeat(201) }))).toMatch(/HEADER_INVALID/);
    expect(err(() => validateHeader({ ...header, hash: 'md5' }))).toMatch(/HEADER_INVALID/);
    expect(err(() => validateHeader({ ...header, tool: '' }))).toMatch(/HEADER_INVALID/);
    expect(err(() => validateHeader(null))).toMatch(/HEADER_INVALID/);
  });
});
