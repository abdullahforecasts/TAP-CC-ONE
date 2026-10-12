/** Format version written by this implementation. */
export const FORMAT_VERSION = 1;

/** PNG-style magic: high bit, "CLG", CR LF, Ctrl-Z, LF (spec §2). */
export const MAGIC = new Uint8Array([0x89, 0x43, 0x4c, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Block frame: payload_len(4) codec(1) raw_len(4) ... crc32(4). */
export const FRAME_HEADER_SIZE = 9;
export const FRAME_TRAILER_SIZE = 4;
export const FRAME_OVERHEAD = FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE;

/** Maximum decompressed size of one block (spec §3). */
export const MAX_BLOCK_RAW = 8 * 1024 * 1024;
/** Maximum slack allowed between raw_len and payload_len for compressed blocks. */
export const MAX_PAYLOAD_SLACK = 1024;
/** Target decompressed size the writer aims for when packing records into blocks. */
export const DEFAULT_TARGET_BLOCK_RAW = 256 * 1024;

/** Verifier resource limits (spec §9). */
export const MAX_RECORDS = 10_000_000;
export const MAX_FILES = 50_000;

export const CODEC_NONE = 0;
export const CODEC_DEFLATE_RAW = 1;

export const HASH_ALG = 'sha-256';
export const SIG_ALG = 'ed25519';

/** Domain-separation labels (spec §6). */
export const DS_GENESIS = 'CLG1/genesis';
export const DS_RECORD = 'CLG1/record';
export const DS_STATE = 'CLG1/state';
export const DS_CHECKPOINT = 'CLG1/checkpoint';

export const Kind = {
  SESSION_START: 1,
  SESSION_END: 2,
  FILE_SNAPSHOT: 3,
  EDIT_BATCH: 4,
  SAVE: 5,
  FILE_OP: 6,
  EXTERNAL_CHANGE: 7,
  RUN_START: 8,
  RUN_END: 9,
  FOCUS: 10,
  PAUSE: 11,
  RESUME: 12,
  CHECKPOINT: 13,
  ANCHOR: 14,
  RECOVERY: 15,
  NOTE: 16,
  KEY_ROTATION: 17,
  CLOCK_ANOMALY: 18,
  ENV_CHANGE: 19,
} as const;

export type KindName = keyof typeof Kind;
export type KindCode = (typeof Kind)[KindName];

export const KIND_NAMES: Readonly<Record<number, KindName>> = Object.freeze(
  Object.fromEntries(Object.entries(Kind).map(([name, code]) => [code, name as KindName])),
);

/** Change flags (spec §5.4). */
export const Flag = {
  UNDO: 0x01,
  REDO: 0x02,
  PASTE: 0x04,
  BULK: 0x08,
  MULTI_CURSOR: 0x10,
  FORMAT_ON_SAVE: 0x20,
  LARGE: 0x40,
  CLASSIFY_TIMEOUT: 0x80,
} as const;

export const ALL_FLAGS = 0xff;

/** Inserted text above this many UTF-16 units must carry the LARGE flag. */
export const LARGE_INSERT_THRESHOLD = 256 * 1024;

/** Maximum NOTE length in Unicode code points. */
export const MAX_NOTE_CODE_POINTS = 2000;
