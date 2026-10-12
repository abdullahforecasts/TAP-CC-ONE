/**
 * Error codes raised by @tap/core. Codes are stable identifiers: tests, the verifier report and
 * future ports (Kotlin, C#) rely on them, so they are never renamed once released.
 */
export type TapErrorCode =
  // File structure
  | 'BAD_MAGIC'
  | 'TRUNCATED'
  | 'BLOCK_TOO_LARGE'
  | 'BAD_CRC'
  | 'BAD_CODEC'
  | 'DECOMPRESS_FAILED'
  | 'RAW_LEN_MISMATCH'
  | 'EMPTY_BLOCK'
  | 'HEADER_INVALID'
  // CBOR
  | 'CBOR_INVALID'
  | 'CBOR_NONCANONICAL'
  | 'CBOR_UNSUPPORTED_VALUE'
  // Records
  | 'RECORD_INVALID'
  | 'RECORD_TOO_LARGE'
  | 'ILL_FORMED_TEXT'
  | 'PATH_INVALID'
  // Writer / replay / crypto
  | 'WRITER_STATE'
  | 'REPLAY_FAILED'
  | 'KEY_MISMATCH'
  | 'OVERLAPPING_CHANGES';

export class TapError extends Error {
  readonly code: TapErrorCode;
  /** Byte offset in the log file, when known. */
  readonly offset: number | undefined;
  /** Record sequence number, when known. */
  readonly seq: number | undefined;

  constructor(code: TapErrorCode, message: string, where: { offset?: number; seq?: number } = {}) {
    super(`${code}: ${message}`);
    this.name = 'TapError';
    this.code = code;
    this.offset = where.offset;
    this.seq = where.seq;
  }
}

export function isTapError(e: unknown): e is TapError {
  return e instanceof TapError;
}
