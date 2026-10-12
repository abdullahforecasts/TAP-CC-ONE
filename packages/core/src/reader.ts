import { decodeCanonical, decodeCanonicalSequence } from './cbor.js';
import { CODEC_NONE, MAGIC, MAX_RECORDS } from './constants.js';
import { TapError } from './errors.js';
import { checkMagic, parseFrame } from './framing.js';
import { type AnyRecord, type LogHeader, validateHeader, validateRecord } from './records.js';

export interface RecordEntry {
  record: AnyRecord;
  /** Canonical CBOR bytes of the record (exactly as stored). */
  bytes: Uint8Array;
  /** Index of the block (0 = first block after the header). */
  block: number;
  /** File offset of the block containing the record. */
  blockOffset: number;
}

export interface ParsedLog {
  header: LogHeader;
  headerBytes: Uint8Array;
  records: RecordEntry[];
  blockCount: number;
  /** Total size of the file in bytes. */
  size: number;
}

export type LogItem =
  | { type: 'header'; header: LogHeader; headerBytes: Uint8Array; end: number }
  | { type: 'block'; index: number; offset: number; length: number; codec: number; records: RecordEntry[] };

/**
 * Streams through a log: yields the header, then each block with its decoded records.
 * Throws TapError (with offset) at the first structural problem.
 */
export function* iterateLog(bytes: Uint8Array): Generator<LogItem> {
  checkMagic(bytes);
  const headerFrame = parseFrame(bytes, MAGIC.length);
  if (headerFrame.codec !== CODEC_NONE) {
    throw new TapError('HEADER_INVALID', 'header block must be uncompressed', { offset: MAGIC.length });
  }
  let headerValue: unknown;
  try {
    headerValue = decodeCanonical(headerFrame.raw);
  } catch (e) {
    if (e instanceof TapError) throw new TapError(e.code, `header: ${e.message}`, { offset: MAGIC.length });
    throw e;
  }
  const header = validateHeader(headerValue);
  let pos = MAGIC.length + headerFrame.length;
  yield { type: 'header', header, headerBytes: headerFrame.raw, end: pos };

  let index = 0;
  let total = 0;
  while (pos < bytes.length) {
    const frame = parseFrame(bytes, pos);
    let items: ReturnType<typeof decodeCanonicalSequence>;
    try {
      items = decodeCanonicalSequence(frame.raw);
    } catch (e) {
      if (e instanceof TapError) throw new TapError(e.code, `block ${index}: ${e.message}`, { offset: pos });
      throw e;
    }
    total += items.length;
    if (total > MAX_RECORDS)
      throw new TapError('BLOCK_TOO_LARGE', `more than ${MAX_RECORDS} records`, { offset: pos });
    const records: RecordEntry[] = items.map((item) => ({
      record: validateRecord(item.value, { offset: pos }),
      bytes: item.bytes,
      block: index,
      blockOffset: pos,
    }));
    yield { type: 'block', index, offset: pos, length: frame.length, codec: frame.codec, records };
    pos += frame.length;
    index++;
  }
}

/** Reads a whole log into memory. */
export function readLog(bytes: Uint8Array): ParsedLog {
  let header: LogHeader | undefined;
  let headerBytes: Uint8Array | undefined;
  const records: RecordEntry[] = [];
  let blockCount = 0;
  for (const item of iterateLog(bytes)) {
    if (item.type === 'header') {
      header = item.header;
      headerBytes = item.headerBytes;
    } else {
      for (const r of item.records) records.push(r);
      blockCount++;
    }
  }
  return { header: header!, headerBytes: headerBytes!, records, blockCount, size: bytes.length };
}
