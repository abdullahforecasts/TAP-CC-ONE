import { TapError } from './errors.js';

/** A change expressed relative to the document *before* an editor event (VS Code's contentChanges). */
export interface SimultaneousChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/**
 * Converts the changes of one editor event into sequential-application order (design §6.4):
 * descending offset, so applying them one after another gives the same result as applying them
 * simultaneously. For equal offsets the longer range goes first, so a pure insertion at X lands
 * before the replacement text that also starts at X. Overlapping ranges are rejected.
 */
export function toSequentialChanges<T extends SimultaneousChange>(changes: readonly T[]): T[] {
  const ascending = [...changes].sort(
    (a, b) => a.rangeOffset - b.rangeOffset || a.rangeLength - b.rangeLength,
  );
  for (let i = 1; i < ascending.length; i++) {
    const prev = ascending[i - 1]!;
    const cur = ascending[i]!;
    if (prev.rangeOffset + prev.rangeLength > cur.rangeOffset) {
      throw new TapError(
        'OVERLAPPING_CHANGES',
        `changes at ${prev.rangeOffset}+${prev.rangeLength} and ${cur.rangeOffset}+${cur.rangeLength} overlap`,
      );
    }
  }
  return ascending.reverse();
}

/** Applies one change to a string; throws RangeError when out of bounds. */
export function applyChange(text: string, off: number, del: number, ins: string): string {
  if (off < 0 || del < 0 || off + del > text.length) {
    throw new RangeError(`change ${off}+${del} outside 0..${text.length}`);
  }
  return text.slice(0, off) + ins + text.slice(off + del);
}
