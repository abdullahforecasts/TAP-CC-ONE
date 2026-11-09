import type { Origin, Span } from './provenance.js';

/** Removed text remembered per file, at most this many characters in all (spec §7.1). */
export const REMOVED_HISTORY_CHARS = 512 * 1024;
/** ... and at most this many removed pieces. */
export const REMOVED_HISTORY = 4096;
/** Lines this long (without surrounding whitespace) are indexed for line-by-line restoring. */
export const RESTORE_LINE_MIN = 8;

export interface RemovedText {
  readonly text: string;
  readonly spans: readonly Span[];
}

export interface RestoredPiece {
  text: string;
  origin: Origin;
  seq: number;
}

/**
 * Text recently removed from one file, with the origins it had, so that an undo or redo that
 * brings it back can restore them (spec §7.1). Entries are never changed after they are added,
 * so copies of the history can share them.
 */
export class RemovedHistory {
  private entries: RemovedText[] = [];
  private chars = 0;
  /** Trimmed line → newest entry containing it and the line's offset there. */
  private readonly lines = new Map<string, { entry: RemovedText; at: number }>();

  static from(entries: readonly RemovedText[]): RemovedHistory {
    const h = new RemovedHistory();
    for (const e of entries) h.add(e);
    return h;
  }

  get size(): number {
    return this.entries.length;
  }

  list(): RemovedText[] {
    return [...this.entries];
  }

  add(entry: RemovedText): void {
    if (entry.text.length === 0) return;
    this.entries.push(entry);
    this.chars += entry.text.length;
    let at = 0;
    for (const line of entry.text.split('\n')) {
      const key = line.trim();
      if (key.length >= RESTORE_LINE_MIN && key.length <= 2000) {
        this.lines.set(key, { entry, at: at + line.indexOf(key) });
      }
      at += line.length + 1;
    }
    while (
      this.entries.length > 1 &&
      (this.chars > REMOVED_HISTORY_CHARS || this.entries.length > REMOVED_HISTORY)
    ) {
      this.evict(this.entries.shift()!);
    }
  }

  private evict(entry: RemovedText): void {
    this.chars -= entry.text.length;
    for (const line of entry.text.split('\n')) {
      const key = line.trim();
      if (this.lines.get(key)?.entry === entry) this.lines.delete(key);
    }
  }

  /**
   * The origins `text` had when it was removed: the newest removal equal to it, else the newest
   * removal containing it (8 characters or more), else line by line (lines of 8 or more
   * characters found in any removal keep their origins; the rest gets `fallback`). Undefined
   * when nothing matches.
   */
  restore(text: string, fallback: Origin, seq: number): RestoredPiece[] | undefined {
    const n = this.entries.length;
    for (let i = n - 1; i >= 0; i--) {
      if (this.entries[i]!.text === text) return piecesOf(this.entries[i]!, 0, text.length);
    }
    if (text.length >= RESTORE_LINE_MIN) {
      for (let i = n - 1; i >= 0; i--) {
        const at = this.entries[i]!.text.indexOf(text);
        if (at >= 0) return piecesOf(this.entries[i]!, at, text.length);
      }
    }
    const out: RestoredPiece[] = [];
    let found = false;
    let at = 0;
    const plain = (len: number) => {
      if (len > 0) out.push({ text: text.slice(at, at + len), origin: fallback, seq });
      at += len;
    };
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const key = line.trim();
      const hit = key.length >= RESTORE_LINE_MIN ? this.lines.get(key) : undefined;
      if (hit) {
        found = true;
        const lead = line.indexOf(key);
        plain(lead);
        out.push(...piecesOf(hit.entry, hit.at, key.length));
        at += key.length;
        plain(line.length - lead - key.length);
      } else {
        plain(line.length);
      }
      if (i < lines.length - 1) plain(1);
    });
    return found ? merge(out) : undefined;
  }
}

function piecesOf(entry: RemovedText, at: number, len: number): RestoredPiece[] {
  const out: RestoredPiece[] = [];
  let pos = 0;
  for (const span of entry.spans) {
    const from = Math.max(pos, at);
    const to = Math.min(pos + span.len, at + len);
    if (to > from) out.push({ text: entry.text.slice(from, to), origin: span.origin, seq: span.seq });
    pos += span.len;
  }
  return out;
}

function merge(pieces: RestoredPiece[]): RestoredPiece[] {
  const out: RestoredPiece[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.origin === p.origin && last.seq === p.seq) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
