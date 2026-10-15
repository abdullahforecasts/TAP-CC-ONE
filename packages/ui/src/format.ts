import type { Origin } from '@tap/core';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date and time, e.g. "2026-10-27 12:58:30". */
export function fmtDateTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A time range; the dates are included when it does not start and end on the same day. */
export function fmtSpan(from: number, to: number): string {
  const a = fmtDateTime(from);
  const b = fmtDateTime(to);
  return a.slice(0, 10) === b.slice(0, 10)
    ? `${a.slice(11)} → ${b.slice(11)}`
    : `${a.slice(5, 16)} → ${b.slice(5, 16)}`;
}

export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "52 min", "1 h 05 min", "40 s". */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${pad(m % 60)} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Percentage with no decimals, but never rounds a non-zero share down to "0%". */
export function fmtPct(part: number, total: number): string {
  if (total <= 0) return '0%';
  const p = (100 * part) / total;
  if (p > 0 && p < 1) return '<1%';
  if (p < 100 && p > 99) return '>99%';
  return `${Math.round(p)}%`;
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  typed: 'typed',
  paste: 'pasted from outside',
  'internal-copy': 'copied from own files',
  bulk: 'tool / AI insert',
  format: 'format on save',
  external: 'changed outside the editor',
  preexisting: 'already there',
  created: 'created with file',
  'undo-redo': 'undo/redo',
  'paused-gap': 'while paused',
  resync: 're-synchronised',
};

export const ORIGIN_HELP: Record<Origin, string> = {
  typed: 'Typed in the editor, one change at a time.',
  paste: 'Pasted from the clipboard; the text did not exist elsewhere in the workspace.',
  'internal-copy': 'Pasted text that already existed in another file of the workspace.',
  bulk: 'Inserted in one go without the clipboard: AI completions (Copilot…), agents working inside the editor (Kilo Code, Cline…), snippets or refactorings. Which tool did it is not known; the AI extensions that were enabled are listed under "About this log".',
  format: 'Changed by a formatter or save action when the file was saved.',
  external:
    'Changed by another program while the file was not being edited in VS Code: git, another editor, or an AI agent writing files directly (Claude Code in a terminal…).',
  preexisting: 'In the file when recording started (starter code, earlier work).',
  created: 'In the file when it was created (copied or generated file).',
  'undo-redo': 'Brought back by undo or redo.',
  'paused-gap': 'Changed while recording was paused.',
  resync: 'Re-synchronised by the recorder after an event it could not capture.',
};

/** Display order for composition bars. */
export const ORIGIN_ORDER: Origin[] = [
  'typed',
  'undo-redo',
  'format',
  'internal-copy',
  'paste',
  'bulk',
  'preexisting',
  'created',
  'external',
  'paused-gap',
  'resync',
];
