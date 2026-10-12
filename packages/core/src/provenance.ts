import { Flag } from './constants.js';
import { countNonWhitespace } from './text.js';

/** Where a piece of text came from (design §10.3). */
export type Origin =
  | 'typed'
  | 'paste'
  | 'internal-copy'
  | 'bulk'
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
  'format',
  'external',
  'preexisting',
  'created',
  'undo-redo',
  'paused-gap',
  'resync',
];

/**
 * Origin of an inserted change from its flags. Precedence: undo/redo > format-on-save > paste >
 * bulk > typed. `internalCopy` refines a paste whose text already existed in the workspace.
 */
export function originFromFlags(flags: number, internalCopy: boolean): Origin {
  if (flags & (Flag.UNDO | Flag.REDO)) return 'undo-redo';
  if (flags & Flag.FORMAT_ON_SAVE) return 'format';
  if (flags & Flag.PASTE) return internalCopy ? 'internal-copy' : 'paste';
  if (flags & Flag.BULK) return 'bulk';
  return 'typed';
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
