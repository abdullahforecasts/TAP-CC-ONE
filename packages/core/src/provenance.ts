import { Flag } from './constants.js';
import { countNonWhitespace } from './text.js';

/** Where a piece of text came from (design §10.3). */
export type Origin =
  | 'typed'
  | 'paste'
  | 'internal-copy'
  | 'bulk'
  | 'completion'
  | 'format'
  | 'external'
  | 'preexisting'
  | 'created'
  | 'undo-redo'
  | 'paused-gap'
  | 'resync';

export const ORIGINS: readonly Origin[] = [
  'typed',
  'paste',
  'internal-copy',
  'bulk',
  'completion',
  'format',
  'external',
  'preexisting',
  'created',
  'undo-redo',
  'paused-gap',
  'resync',
];

/** Inserts this long (or multi-line inserts of BULK_MULTILINE_MIN) count as bulk, whatever the recorder flagged. */
export const BULK_MIN_CHARS = 40;
export const BULK_MULTILINE_MIN = 20;
/**
 * A change inserting at least this many non-whitespace characters, at the cursor or in place of
 * one word, was inserted by the editor (autocomplete, snippet, accepted suggestion):
 * typing inserts one character per change, plus auto-closed pairs and indentation (spec §7.1).
 */
export const COMPLETION_MIN_NON_WS = 3;

/** Whether inserted text is long enough to have come from a tool rather than the keyboard. */
export function isBulkText(text: string): boolean {
  return text.length >= BULK_MIN_CHARS || (text.includes('\n') && text.length >= BULK_MULTILINE_MIN);
}

/**
 * Origin of an insert that is not an undo, redo, save-time format or paste, from the inserted
 * text and the text it replaced: bulk, completion (inserted at the cursor, or replacing one
 * word, as the suggestion widget does) or typed. The recorder's BULK flag is not used, so
 * recorder settings cannot change the result (spec §7.1).
 */
export function insertOrigin(ins: string, deleted = ''): Origin {
  if (isBulkText(ins)) return 'bulk';
  if (!/\s/.test(deleted) && countNonWhitespace(ins) >= COMPLETION_MIN_NON_WS) return 'completion';
  return 'typed';
}

/**
 * Origin of a change from its flags and text. Precedence: undo/redo > format-on-save > paste >
 * bulk > completion > typed. `internalCopy` refines a paste whose text already existed in the
 * workspace; `deleted` is the text the change replaced.
 */
export function originFromFlags(flags: number, internalCopy: boolean, ins = '', deleted = ''): Origin {
  if (flags & (Flag.UNDO | Flag.REDO)) return 'undo-redo';
  if (flags & Flag.FORMAT_ON_SAVE) return 'format';
  if (flags & Flag.PASTE) return internalCopy ? 'internal-copy' : 'paste';
  return insertOrigin(ins, deleted);
}

export interface Span {
  len: number;
  origin: Origin;
  /** Earliest record sequence number that contributed to this span. */
  seq: number;
}

/**
 * Per-file run-length list of origins, parallel to the file text (lengths in UTF-16 code units).
 * Adjacent spans with the same origin are merged, so the list stays small.
 */
export class SpanList {
  private spans: Span[] = [];
  private total = 0;

  static of(len: number, origin: Origin, seq: number): SpanList {
    const list = new SpanList();
    if (len > 0) list.insert(0, len, origin, seq);
    return list;
  }

  get length(): number {
    return this.total;
  }

  toArray(): readonly Span[] {
    return this.spans;
  }

  clone(): SpanList {
    const copy = new SpanList();
    copy.spans = this.spans.map((s) => ({ ...s }));
    copy.total = this.total;
    return copy;
  }

  /** Splits so that a span boundary exists at `off`; returns the index of the span starting there. */
  private splitAt(off: number): number {
    let pos = 0;
    for (let i = 0; i < this.spans.length; i++) {
      const span = this.spans[i]!;
      if (pos === off) return i;
      if (off < pos + span.len) {
        const left = off - pos;
        this.spans.splice(i + 1, 0, { len: span.len - left, origin: span.origin, seq: span.seq });
        span.len = left;
        return i + 1;
      }
      pos += span.len;
    }
    return this.spans.length;
  }

  private mergeAround(i: number): void {
    for (let j = Math.min(i + 1, this.spans.length - 1); j >= Math.max(i - 1, 1); j--) {
      const a = this.spans[j - 1]!;
      const b = this.spans[j]!;
      if (a.origin === b.origin) {
        a.len += b.len;
        a.seq = Math.min(a.seq, b.seq);
        this.spans.splice(j, 1);
      }
    }
  }

  insert(off: number, len: number, origin: Origin, seq: number): void {
    if (off < 0 || off > this.total) throw new RangeError(`insert offset ${off} outside 0..${this.total}`);
    if (len <= 0) return;
    const i = this.splitAt(off);
    this.spans.splice(i, 0, { len, origin, seq });
    this.total += len;
    this.mergeAround(i);
  }

  /** Copies of the spans covering [off, off + len), trimmed to that range. */
  slice(off: number, len: number): Span[] {
    const out: Span[] = [];
    let pos = 0;
    for (const span of this.spans) {
      const from = Math.max(pos, off);
      const to = Math.min(pos + span.len, off + len);
      if (to > from) out.push({ len: to - from, origin: span.origin, seq: span.seq });
      pos += span.len;
      if (pos >= off + len) break;
    }
    return out;
  }

  remove(off: number, len: number): void {
    if (len <= 0) return;
    if (off < 0 || off + len > this.total)
      throw new RangeError(`remove ${off}+${len} outside 0..${this.total}`);
    const start = this.splitAt(off);
    const end = this.splitAt(off + len);
    this.spans.splice(start, end - start);
    this.total -= len;
    this.mergeAround(Math.max(0, start - 1));
  }
}

export interface OriginCount {
  /** UTF-16 code units. */
  chars: number;
  /** Non-whitespace UTF-16 code units. */
  nonWs: number;
}

export interface Composition {
  chars: number;
  nonWs: number;
  byOrigin: Partial<Record<Origin, OriginCount>>;
}

export function emptyComposition(): Composition {
  return { chars: 0, nonWs: 0, byOrigin: {} };
}

/** Adds one file's text/spans to a composition total. */
export function addToComposition(total: Composition, text: string, spans: SpanList): void {
  if (spans.length !== text.length) {
    throw new RangeError(`span list length ${spans.length} != text length ${text.length}`);
  }
  let pos = 0;
  for (const span of spans.toArray()) {
    const slice = text.slice(pos, pos + span.len);
    const nonWs = countNonWhitespace(slice);
    let entry = total.byOrigin[span.origin];
    if (!entry) {
      entry = { chars: 0, nonWs: 0 };
      total.byOrigin[span.origin] = entry;
    }
    entry.chars += span.len;
    entry.nonWs += nonWs;
    total.chars += span.len;
    total.nonWs += nonWs;
    pos += span.len;
  }
}
