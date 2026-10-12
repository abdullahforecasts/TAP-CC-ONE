import { deflateSync, inflateSync } from 'fflate';
import { bytesEqual, readU32be, u32be } from './bytes.js';
import {
  CODEC_DEFLATE_RAW,
  CODEC_NONE,
  FRAME_HEADER_SIZE,
  FRAME_OVERHEAD,
  MAGIC,
  MAX_BLOCK_RAW,
  MAX_PAYLOAD_SLACK,
} from './constants.js';
import { crc32 } from './crc32.js';
import { TapError } from './errors.js';

/**
 * Frames one block (spec §3):
 *   payload_len u32be | codec u8 | raw_len u32be | payload | crc32 u32be over all preceding bytes
 * With `compress`, deflate-raw is used only when it actually makes the payload smaller.
 */
export function encodeFrame(raw: Uint8Array, compress: boolean): Uint8Array {
  if (raw.length === 0) throw new TapError('EMPTY_BLOCK', 'block payload must not be empty');
  if (raw.length > MAX_BLOCK_RAW) {
    throw new TapError('BLOCK_TOO_LARGE', `block of ${raw.length} bytes exceeds ${MAX_BLOCK_RAW}`);
  }
  let codec = CODEC_NONE;
  let payload = raw;
  if (compress) {
    // Fixed level and memory settings keep the output byte-identical across runs and platforms.
    const deflated = deflateSync(raw, { level: 6, mem: 8 });
    if (deflated.length < raw.length) {
      codec = CODEC_DEFLATE_RAW;
      payload = deflated;
    }
  }
  const frame = new Uint8Array(FRAME_OVERHEAD + payload.length);
  frame.set(u32be(payload.length), 0);
  frame[4] = codec;
  frame.set(u32be(raw.length), 5);
  frame.set(payload, FRAME_HEADER_SIZE);
  frame.set(u32be(crc32(frame, 0, FRAME_HEADER_SIZE + payload.length)), FRAME_HEADER_SIZE + payload.length);
  return frame;
}

export interface ParsedFrame {
  /** Offset of the frame within the file. */
  offset: number;
  /** Total bytes the frame occupies. */
  length: number;
  codec: number;
  /** Decompressed payload. */
  raw: Uint8Array;
}

/**
 * Parses and checks the frame starting at `offset`. All limits are checked before any allocation,
 * and decompression is bounded by the declared raw_len (decompression-bomb guard).
 */
export function parseFrame(bytes: Uint8Array, offset: number): ParsedFrame {
  const where = { offset };
  if (bytes.length - offset < FRAME_OVERHEAD) {
    throw new TapError('TRUNCATED', `incomplete block frame (${bytes.length - offset} bytes left)`, where);
  }
  const payloadLen = readU32be(bytes, offset);
  const codec = bytes[offset + 4]!;
  const rawLen = readU32be(bytes, offset + 5);
  if (rawLen === 0) throw new TapError('EMPTY_BLOCK', 'block declares an empty payload', where);
  if (rawLen > MAX_BLOCK_RAW) throw new TapError('BLOCK_TOO_LARGE', `raw_len ${rawLen} exceeds limit`, where);
  if (codec !== CODEC_NONE && codec !== CODEC_DEFLATE_RAW) {
    throw new TapError('BAD_CODEC', `unknown codec ${codec}`, where);
  }
  if (codec === CODEC_NONE && payloadLen !== rawLen) {
    throw new TapError('RAW_LEN_MISMATCH', 'uncompressed block with payload_len != raw_len', where);
  }
  if (payloadLen > rawLen + MAX_PAYLOAD_SLACK) {
    throw new TapError('BLOCK_TOO_LARGE', `payload_len ${payloadLen} too large for raw_len ${rawLen}`, where);
  }
  const end = offset + FRAME_OVERHEAD + payloadLen;
  if (end > bytes.length) {
    throw new TapError(
      'TRUNCATED',
      `block needs ${end - offset} bytes, ${bytes.length - offset} available`,
      where,
    );
  }
  const crcPos = offset + FRAME_HEADER_SIZE + payloadLen;
  if (crc32(bytes, offset, crcPos) !== readU32be(bytes, crcPos)) {
    throw new TapError('BAD_CRC', 'block checksum does not match', where);
  }
  const payload = bytes.subarray(offset + FRAME_HEADER_SIZE, crcPos);
  let raw: Uint8Array;
  if (codec === CODEC_NONE) {
    raw = payload;
  } else {
    // One extra byte detects output that would exceed raw_len (fflate truncates silently).
    const out = new Uint8Array(rawLen + 1);
    try {
      raw = inflateSync(payload, { out });
    } catch (e) {
      throw new TapError('DECOMPRESS_FAILED', (e as Error).message, where);
    }
    if (raw.length !== rawLen) {
      throw new TapError(
        'RAW_LEN_MISMATCH',
        raw.length > rawLen
          ? 'decompressed data exceeds raw_len'
          : `decompressed ${raw.length} bytes, expected ${rawLen}`,
        where,
      );
    }
  }
  return { offset, length: end - offset, codec, raw };
}

export function checkMagic(bytes: Uint8Array): void {
  if (bytes.length < MAGIC.length || !bytesEqual(bytes.subarray(0, MAGIC.length), MAGIC)) {
    throw new TapError('BAD_MAGIC', 'not a .codelog file (or it was corrupted by a text-mode transfer)', {
      offset: 0,
    });
  }
}
