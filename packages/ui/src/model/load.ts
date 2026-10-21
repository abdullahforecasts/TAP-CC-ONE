/**
 * Reads log bytes into the viewer model, block by block, so a growing log (live refresh while
 * recording) only costs the new blocks. Also runs the verifier over the whole log.
 */
import {
  type AnchorVerifier,
  CODEC_NONE,
  checkMagic,
  concatBytes,
  decodeCanonical,
  decodeCanonicalSequence,
  isTapError,
  MAGIC,
  parseFrame,
  type SubmittedFile,
  type VerifyReport,
  validateHeader,
  validateRecord,
  verifyLog,
} from '@tap/core';
import { LogModelBuilder } from './builder.js';
import type { LogModel } from './types.js';

export class LogLoader {
  private bytes: Uint8Array = new Uint8Array(0);
  private next = 0;
  private builder = new LogModelBuilder();
  private failed = false;

  /** Bytes read so far. */
  get size(): number {
    return this.bytes.length;
  }

  /** Replaces everything with a new log (or the same log read again from the start). */
  reset(bytes: Uint8Array): void {
    this.bytes = bytes;
    this.next = 0;
    this.builder = new LogModelBuilder();
    this.failed = false;
    this.parse();
  }

  /** Adds bytes appended to the log since the last call. */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.bytes = concatBytes(this.bytes, chunk);
    this.parse();
  }

  private parse(): void {
    if (this.failed) return;
    try {
      if (this.next === 0) {
        if (this.bytes.length < MAGIC.length) return;
        checkMagic(this.bytes);
        const frame = this.frameAt(MAGIC.length);
        if (!frame) return;
        if (frame.codec !== CODEC_NONE) throw new Error('the header block must be uncompressed');
        this.builder.setHeader(validateHeader(decodeCanonical(frame.raw)));
        this.next = MAGIC.length + frame.length;
      }
      while (this.next < this.bytes.length) {
        const frame = this.frameAt(this.next);
        if (!frame) return; // the rest of the block has not been written yet
        const records = decodeCanonicalSequence(frame.raw).map((item) =>
          validateRecord(item.value, { offset: this.next }),
        );
        this.builder.append(records);
        this.next += frame.length;
      }
    } catch (e) {
      this.failed = true;
      const where = isTapError(e) && e.offset !== undefined ? ` (at byte ${e.offset})` : '';
      this.builder.setProblem(`${(e as Error).message}${where}`);
    }
  }

  /** The frame at `offset`, or undefined if it is not complete yet. */
  private frameAt(offset: number): ReturnType<typeof parseFrame> | undefined {
    try {
      return parseFrame(this.bytes, offset);
    } catch (e) {
      if (isTapError(e) && e.code === 'TRUNCATED') return undefined;
      throw e;
    }
  }

  model(): LogModel {
    return this.builder.result();
  }

  verify(submission?: readonly SubmittedFile[], anchorVerifier?: AnchorVerifier): VerifyReport {
    return verifyLog(this.bytes, {
      ...(submission ? { submission } : {}),
      ...(anchorVerifier ? { anchorVerifier } : {}),
    });
  }
}
