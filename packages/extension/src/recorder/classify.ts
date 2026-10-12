import { Flag, LARGE_INSERT_THRESHOLD, normalizeText, toSequentialChanges } from '@tap/core';

/** One content change as VS Code reports it (relative to the document before the event). */
export interface EditorChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export type EditReason = 'undo' | 'redo' | undefined;

export interface ClassifySettings {
  /** Insertions at least this long are compared with the clipboard. */
  clipboardCheckMinChars: number;
  /** Non-paste insertions at least this long are BULK. */
  bulkMinChars: number;
}

/** A change converted to sequential order, with provisional flags. */
export interface ClassifiedChange {
  off: number;
  del: number;
  ins: string;
  flags: number;
  /** True when the clipboard must be compared before the flags are final. */
  needsClipboard: boolean;
}

/** Multi-line insertions this long count as bulk even below bulkMinChars (e.g. a pasted-in block). */
const BULK_MULTILINE_MIN = 20;

/**
 * Converts one editor event into sequential changes with flags (design §6.3, §6.4).
 * Clipboard comparison happens later and asynchronously; see `resolvePaste`.
 */
export function classifyEvent(
  changes: readonly EditorChange[],
  reason: EditReason,
  formatOnSave: boolean,
  settings: ClassifySettings,
): ClassifiedChange[] {
  const ordered = toSequentialChanges(changes);
  let base = 0;
  if (reason === 'undo') base |= Flag.UNDO;
  if (reason === 'redo') base |= Flag.REDO;
  if (formatOnSave) base |= Flag.FORMAT_ON_SAVE;
  if (ordered.length > 1 && ordered.every((c) => c.text === ordered[0]!.text)) base |= Flag.MULTI_CURSOR;
  const exempt = (base & (Flag.UNDO | Flag.REDO | Flag.FORMAT_ON_SAVE)) !== 0;

  return ordered.map((c) => {
    let flags = base;
    const ins = c.text;
    if (ins.length > LARGE_INSERT_THRESHOLD) flags |= Flag.LARGE;
    const needsClipboard = !exempt && ins.length >= settings.clipboardCheckMinChars;
    if (needsClipboard && isBulk(ins, settings)) flags |= Flag.BULK;
    return { off: c.rangeOffset, del: c.rangeLength, ins, flags, needsClipboard };
  });
}

export function isBulk(ins: string, settings: ClassifySettings): boolean {
  return ins.length >= settings.bulkMinChars || (ins.includes('\n') && ins.length >= BULK_MULTILINE_MIN);
}

/**
 * Whether an insertion came from the clipboard. A single-cursor paste inserts exactly the
 * clipboard; a multi-cursor paste may split the clipboard across cursors, so each part must
 * occur in it. Line endings are normalised because editors convert them on paste.
 */
export function isPasteOf(inserted: string, clipboard: string, multiCursor: boolean): boolean {
  if (inserted.length === 0 || clipboard.length === 0) return false;
  const ins = normalizeText(inserted);
  const clip = normalizeText(clipboard);
  if (ins === clip) return true;
  // Editors may add or drop one trailing newline when pasting whole lines.
  if (ins.replace(/\n$/, '') === clip.replace(/\n$/, '')) return true;
  return multiCursor && clip.includes(ins);
}

/** Applies the clipboard verdict to provisional flags. */
export function resolvePaste(flags: number, verdict: 'paste' | 'no-paste' | 'timeout'): number {
  if (verdict === 'paste') return (flags & ~Flag.BULK) | Flag.PASTE;
  if (verdict === 'timeout') return flags | Flag.CLASSIFY_TIMEOUT;
  return flags;
}
