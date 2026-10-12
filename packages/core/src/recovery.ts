import { MAGIC } from './constants.js';
import { TapError } from './errors.js';
import { checkMagic, parseFrame } from './framing.js';

export interface RecoveryScan {
  /** Bytes from the start of the file that form complete, valid blocks. */
  validLength: number;
  /** Damaged tail (to be quarantined); empty when the file is intact. */
  lost: Uint8Array;
  /** What was wrong with the first bad block, if any. */
  reason?: string;
}

/**
 * Finds the longest prefix made of complete, checksum-valid blocks (design §7.12). Used when
 * opening a log for append after a crash: the caller truncates the file to `validLength`,
 * quarantines `lost`, resumes the writer and appends a RECOVERY record.
 *
 * Only framing damage (truncation, CRC, decompression) is treated as recoverable. A damaged
 * header cannot be recovered and throws.
 */
export function scanForRecovery(bytes: Uint8Array): RecoveryScan {
  checkMagic(bytes);
  let pos = MAGIC.length;
  try {
    pos += parseFrame(bytes, pos).length;
  } catch (e) {
    throw new TapError('HEADER_INVALID', `header block is damaged: ${(e as Error).message}`, { offset: pos });
  }
  while (pos < bytes.length) {
    try {
      pos += parseFrame(bytes, pos).length;
    } catch (e) {
      return { validLength: pos, lost: bytes.slice(pos), reason: (e as Error).message };
    }
  }
  return { validLength: pos, lost: new Uint8Array(0) };
}
