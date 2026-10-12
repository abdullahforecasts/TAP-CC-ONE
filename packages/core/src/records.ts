import type { CborValue } from './cbor.js';
import {
  ALL_FLAGS,
  Flag,
  FORMAT_VERSION,
  HASH_ALG,
  KIND_NAMES,
  Kind,
  type KindName,
  LARGE_INSERT_THRESHOLD,
  MAX_NOTE_CODE_POINTS,
  SIG_ALG,
} from './constants.js';
import { TapError } from './errors.js';
import { relPathError } from './paths.js';
import { countCodePoints, isWellFormed } from './text.js';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface LogHeader {
  fmt: 1;
  logId: Uint8Array;
  created: number;
  tool: string;
  hash: 'sha-256';
  sig: 'ed25519';
  label?: string;
}

/** [dt, off, del, ins] or [dt, off, del, ins, flags] with flags !== 0. */
export type ChangeTuple = [number, number, number, string] | [number, number, number, string, number];

export type SnapshotOrigin = 'preexisting' | 'created' | 'external' | 'resync' | 'paused-gap' | 'periodic';

export interface SessionStartBody {
  sid: Uint8Array;
  pub: Uint8Array;
  vsc: string;
  app: string;
  os: string;
  ext: string;
  aiExt: string[];
  liveShare: boolean;
  cfgHash: Uint8Array;
  settings?: { [key: string]: CborValue };
}
export interface SessionEndBody {
  sid: Uint8Array;
  reason: 'close' | 'reload' | 'deactivate';
}
export interface FileSnapshotBody {
  f: number;
  path: string;
  origin: SnapshotOrigin;
  text: string;
  h: Uint8Array;
  eol: 'lf' | 'crlf';
  enc: string;
}
export interface EditBatchBody {
  f: number;
  c: ChangeTuple[];
}
export interface SaveBody {
  f: number;
  h: Uint8Array;
  n: number;
}
export interface FileOpBody {
  op: 'create' | 'delete' | 'rename';
  f: number;
  path: string;
  newPath?: string;
  origin: 'editor' | 'external' | 'fromUntitled';
}
export interface ExternalChangeBody {
  f: number;
  h: Uint8Array;
  hint?: 'vcs';
}
export interface RunStartBody {
  rid: number;
  kind: 'debug' | 'task' | 'terminal';
  name?: string;
  cmd?: string;
  cwd?: string;
}
export interface RunEndBody {
  rid: number;
  exit?: number;
}
export interface FocusBody {
  on: boolean;
}
export interface PauseBody {
  why?: string;
}
export type ResumeBody = Record<string, never>;
export interface CheckpointBody {
  state: Uint8Array;
  files: number;
  sig: Uint8Array;
}
export interface AnchorBody {
  ck: number;
  d: Uint8Array;
  type: 'rfc3161' | 'ots';
  src: string;
  tok: Uint8Array;
  status: 'complete' | 'pending' | 'upgraded';
}
export interface RecoveryBody {
  lostBytes: number;
  quarantineHash: Uint8Array;
  atOffset: number;
}
export interface NoteBody {
  text: string;
}
export interface KeyRotationBody {
  oldPub?: Uint8Array;
  newPub: Uint8Array;
  why: 'lost' | 'manual';
}
export interface ClockAnomalyBody {
  wallDelta: number;
  monoDelta: number;
}
export interface EnvChangeBody {
  vsc?: string;
  aiExt?: string[];
  liveShare?: boolean;
  cfgHash?: Uint8Array;
  settings?: { [key: string]: CborValue };
}

export interface BodyByKind {
  SESSION_START: SessionStartBody;
  SESSION_END: SessionEndBody;
  FILE_SNAPSHOT: FileSnapshotBody;
  EDIT_BATCH: EditBatchBody;
  SAVE: SaveBody;
  FILE_OP: FileOpBody;
  EXTERNAL_CHANGE: ExternalChangeBody;
  RUN_START: RunStartBody;
  RUN_END: RunEndBody;
  FOCUS: FocusBody;
  PAUSE: PauseBody;
  RESUME: ResumeBody;
  CHECKPOINT: CheckpointBody;
  ANCHOR: AnchorBody;
  RECOVERY: RecoveryBody;
  NOTE: NoteBody;
  KEY_ROTATION: KeyRotationBody;
  CLOCK_ANOMALY: ClockAnomalyBody;
  ENV_CHANGE: EnvChangeBody;
}

/** A record as stored (envelope + body). */
export interface LogRecord<K extends KindName = KindName> {
  s: number;
  k: (typeof Kind)[K];
  t: number;
  m: number;
  p: Uint8Array;
  b: BodyByKind[K];
}

export type AnyRecord = { [K in KindName]: LogRecord<K> }[KindName];

export function kindName(rec: { k: number }): KindName {
  return KIND_NAMES[rec.k]!;
}

export function isKind<K extends KindName>(rec: AnyRecord, kind: K): rec is Extract<AnyRecord, LogRecord<K>> {
  return rec.k === Kind[kind];
}

// ---------------------------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------------------------

type Check = (v: unknown, path: string) => string | undefined;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

const uint: Check = (v) =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? undefined : 'expected unsigned integer';
const int: Check = (v) => (Number.isSafeInteger(v) ? undefined : 'expected integer');
const bool: Check = (v) => (typeof v === 'boolean' ? undefined : 'expected boolean');
const tstr =
  (opts: { min?: number; max?: number } = {}): Check =>
  (v) => {
    if (typeof v !== 'string') return 'expected text string';
    if (!isWellFormed(v)) return 'text contains lone surrogates';
    if (opts.min !== undefined && v.length < opts.min) return `text shorter than ${opts.min}`;
    if (opts.max !== undefined && v.length > opts.max) return `text longer than ${opts.max}`;
    return undefined;
  };
const bstr =
  (size?: number): Check =>
  (v) => {
    if (!(v instanceof Uint8Array)) return 'expected byte string';
    if (size !== undefined && v.length !== size) return `expected ${size} bytes, got ${v.length}`;
    return undefined;
  };
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v) ? undefined : `expected one of ${values.join('|')}`;
const relPath: Check = (v) => {
  if (typeof v !== 'string') return 'expected path string';
  if (!isWellFormed(v)) return 'path contains lone surrogates';
  return relPathError(v);
};
const arrayOf =
  (item: Check, opts: { min?: number } = {}): Check =>
  (v, path) => {
    if (!Array.isArray(v)) return 'expected array';
    if (opts.min !== undefined && v.length < opts.min) return `expected at least ${opts.min} items`;
    for (let i = 0; i < v.length; i++) {
      const err = item(v[i], `${path}[${i}]`);
      if (err) return `[${i}]: ${err}`;
    }
    return undefined;
  };
const map: Check = (v) => (isObj(v) ? undefined : 'expected map');

const changeTuple: Check = (v) => {
  if (!Array.isArray(v) || (v.length !== 4 && v.length !== 5))
    return 'change must be [dt, off, del, ins, flags?]';
  const [dt, off, del, ins, flags] = v as unknown[];
  if (uint(dt, '')) return 'dt must be unsigned integer';
  if (uint(off, '')) return 'off must be unsigned integer';
  if (uint(del, '')) return 'del must be unsigned integer';
  const insErr = tstr()(ins, '');
  if (insErr) return `ins: ${insErr}`;
  const insLen = (ins as string).length;
  if (insLen === 0 && del === 0) return 'empty change (nothing deleted or inserted)';
  let f = 0;
  if (v.length === 5) {
    if (uint(flags, '') || (flags as number) === 0)
      return 'flags must be a non-zero unsigned integer (omit when 0)';
    if ((flags as number) & ~ALL_FLAGS) return 'unknown flag bits';
    f = flags as number;
  }
  if (f & Flag.UNDO && f & Flag.REDO) return 'UNDO and REDO are mutually exclusive';
  if (f & Flag.PASTE && f & Flag.BULK) return 'PASTE and BULK are mutually exclusive';
  const large = insLen > LARGE_INSERT_THRESHOLD;
  if (large !== Boolean(f & Flag.LARGE)) return 'LARGE flag must be set exactly when ins exceeds 256 KiB';
  return undefined;
};

type Spec = Record<string, { check: Check; optional?: true }>;

const req = (check: Check) => ({ check });
const opt = (check: Check) => ({ check, optional: true as const });

const HEADER_SPEC: Spec = {
  fmt: req((v) => (v === FORMAT_VERSION ? undefined : `unsupported format version ${String(v)}`)),
  logId: req(bstr(16)),
  created: req(uint),
  tool: req(tstr({ min: 1, max: 200 })),
  hash: req(oneOf(HASH_ALG)),
  sig: req(oneOf(SIG_ALG)),
  label: opt(tstr({ max: 200 })),
};

const BODY_SPECS: Record<KindName, Spec> = {
  SESSION_START: {
    sid: req(bstr(16)),
    pub: req(bstr(32)),
    vsc: req(tstr({ max: 100 })),
    app: req(tstr({ max: 100 })),
    os: req(tstr({ max: 50 })),
    ext: req(tstr({ max: 100 })),
    aiExt: req(arrayOf(tstr({ max: 200 }))),
    liveShare: req(bool),
    cfgHash: req(bstr(32)),
    settings: opt(map),
  },
  SESSION_END: { sid: req(bstr(16)), reason: req(oneOf('close', 'reload', 'deactivate')) },
  FILE_SNAPSHOT: {
    f: req(uint),
    path: req(relPath),
    origin: req(oneOf('preexisting', 'created', 'external', 'resync', 'paused-gap', 'periodic')),
    text: req(tstr()),
    h: req(bstr(32)),
    eol: req(oneOf('lf', 'crlf')),
    enc: req(tstr({ min: 1, max: 50 })),
  },
  EDIT_BATCH: { f: req(uint), c: req(arrayOf(changeTuple, { min: 1 })) },
  SAVE: { f: req(uint), h: req(bstr(32)), n: req(uint) },
  FILE_OP: {
    op: req(oneOf('create', 'delete', 'rename')),
    f: req(uint),
    path: req(relPath),
    newPath: opt(relPath),
    origin: req(oneOf('editor', 'external', 'fromUntitled')),
  },
  EXTERNAL_CHANGE: { f: req(uint), h: req(bstr(32)), hint: opt(oneOf('vcs')) },
  RUN_START: {
    rid: req(uint),
    kind: req(oneOf('debug', 'task', 'terminal')),
    name: opt(tstr({ max: 500 })),
    cmd: opt(tstr({ max: 8000 })),
    cwd: opt(relPath),
  },
  RUN_END: { rid: req(uint), exit: opt(int) },
  FOCUS: { on: req(bool) },
  PAUSE: { why: opt(tstr({ max: 2000 })) },
  RESUME: {},
  CHECKPOINT: { state: req(bstr(32)), files: req(uint), sig: req(bstr(64)) },
  ANCHOR: {
    ck: req(uint),
    d: req(bstr(32)),
    type: req(oneOf('rfc3161', 'ots')),
    src: req(tstr({ min: 1, max: 500 })),
    tok: req(bstr()),
    status: req(oneOf('complete', 'pending', 'upgraded')),
  },
  RECOVERY: { lostBytes: req(uint), quarantineHash: req(bstr(32)), atOffset: req(uint) },
  NOTE: {
    text: req((v, p) => {
      const e = tstr({ min: 1 })(v, p);
      if (e) return e;
      return countCodePoints(v as string) > MAX_NOTE_CODE_POINTS
        ? `note longer than ${MAX_NOTE_CODE_POINTS} characters`
        : undefined;
    }),
  },
  KEY_ROTATION: { oldPub: opt(bstr(32)), newPub: req(bstr(32)), why: req(oneOf('lost', 'manual')) },
  CLOCK_ANOMALY: { wallDelta: req(int), monoDelta: req(uint) },
  ENV_CHANGE: {
    vsc: opt(tstr({ max: 100 })),
    aiExt: opt(arrayOf(tstr({ max: 200 }))),
    liveShare: opt(bool),
    cfgHash: opt(bstr(32)),
    settings: opt(map),
  },
};

function checkSpec(value: unknown, spec: Spec, where: string, strictKeys: boolean): string | undefined {
  if (!isObj(value)) return `${where}: expected map`;
  for (const [key, { check, optional }] of Object.entries(spec)) {
    if (!(key in value)) {
      if (optional) continue;
      return `${where}.${key}: missing`;
    }
    const err = check(value[key], `${where}.${key}`);
    if (err) return `${where}.${key}: ${err}`;
  }
  if (strictKeys) {
    for (const key of Object.keys(value)) if (!(key in spec)) return `${where}: unknown key "${key}"`;
  }
  return undefined;
}

/** Validates the header map (strict: unknown keys are rejected). */
export function validateHeader(value: unknown): LogHeader {
  const err = checkSpec(value, HEADER_SPEC, 'header', true);
  if (err) throw new TapError('HEADER_INVALID', err);
  return value as unknown as LogHeader;
}

const ENVELOPE_SPEC: Spec = {
  s: req(uint),
  k: req(uint),
  t: req(uint),
  m: req(uint),
  p: req(bstr(32)),
  b: req(map),
};

/**
 * Validates a record. The envelope is strict and unknown kinds are rejected; unknown keys inside
 * a body are tolerated so that optional body fields can be added in minor revisions (spec §10).
 */
export function validateRecord(value: unknown, where: { offset?: number } = {}): AnyRecord {
  const seq = isObj(value) && Number.isSafeInteger(value.s) ? (value.s as number) : undefined;
  const loc = seq === undefined ? where : { ...where, seq };
  let err = checkSpec(value, ENVELOPE_SPEC, 'record', true);
  if (err) throw new TapError('RECORD_INVALID', err, loc);
  const rec = value as Record<string, unknown>;
  const name = KIND_NAMES[rec.k as number];
  if (!name) throw new TapError('RECORD_INVALID', `unknown record kind ${String(rec.k)}`, loc);
  err = checkSpec(rec.b, BODY_SPECS[name], name, false);
  if (err) throw new TapError('RECORD_INVALID', err, loc);
  if (name === 'FILE_OP') {
    const b = rec.b as Record<string, unknown>;
    if ((b.op === 'rename') !== (b.newPath !== undefined)) {
      throw new TapError(
        'RECORD_INVALID',
        'FILE_OP: newPath is required for rename and only for rename',
        loc,
      );
    }
  }
  return value as AnyRecord;
}

/** Validates only a body for the given kind (used by the writer before encoding). */
export function validateBody(kind: KindName, body: unknown): void {
  const err = checkSpec(body, BODY_SPECS[kind], kind, false);
  if (err) throw new TapError('RECORD_INVALID', err);
  if (kind === 'FILE_OP') {
    const b = body as Record<string, unknown>;
    if ((b.op === 'rename') !== (b.newPath !== undefined)) {
      throw new TapError('RECORD_INVALID', 'FILE_OP: newPath is required for rename and only for rename');
    }
  }
}
