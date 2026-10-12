/**
 * Line diff for Save History (design §12.1): Myers' O(ND) algorithm on lines, after trimming the
 * common prefix and suffix. Line endings are normalised first, so CRLF files diff like LF files.
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text (equal/remove). */
  oldNo?: number;
  /** 1-based line number in the new text (equal/add). */
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffResult {
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** True when the texts were too different for a minimal diff (whole regions replaced). */
  approximate: boolean;
}

/** Above this many differences the diff falls back to replacing the changed middle wholesale. */
const MAX_EDIT_DISTANCE = 4000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Edit script between two line arrays: a sequence of ops covering both. */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
): { ops: DiffOp[]; approximate: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push('equal');
  ops.push(...middle.ops);
  for (let i = endA; i < a.length; i++) ops.push('equal');
  return { ops, approximate: middle.approximate };
}

function myers(a: readonly string[], b: readonly string[]): { ops: DiffOp[]; approximate: boolean } {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return { ops: [...Array<DiffOp>(n).fill('remove'), ...Array<DiffOp>(m).fill('add')], approximate: false };
  }
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    // Too many differences: report the whole middle as replaced.
    return { ops: [...Array<DiffOp>(n).fill('remove'), ...Array<DiffOp>(m).fill('add')], approximate: true };
  }

  // Walk the trace backwards. trace[d] holds V before step d, for k in [-d-1, d+1].
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const at = (k: number) => prev[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('equal');
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push('add');
      y--;
    } else {
      ops.push('remove');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('equal');
    x--;
    y--;
  }
  ops.reverse();
  return { ops, approximate: false };
}

/** Counts of added and removed lines between two texts. */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  const { ops } = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === 'add') added++;
    else if (op === 'remove') removed++;
  }
  return { added, removed };
}

/** Full diff with hunks of changed lines and `context` unchanged lines around them. */
export function diffTexts(oldText: string, newText: string, context = 3): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const { ops, approximate } = diffLines(a, b);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === 'equal') lines.push({ op, text: b[j]!, oldNo: ++i, newNo: ++j });
    else if (op === 'remove') {
      lines.push({ op, text: a[i]!, oldNo: ++i });
      removed++;
    } else {
      lines.push({ op, text: b[j]!, newNo: ++j });
      added++;
    }
  }

  const hunks: DiffHunk[] = [];
  let groupStart = -1;
  let groupEnd = -1;
  const flush = () => {
    if (groupStart < 0) return;
    const from = Math.max(0, groupStart - context);
    const to = Math.min(lines.length - 1, groupEnd + context);
    const slice = lines.slice(from, to + 1);
    let oldStart = 0;
    let newStart = 0;
    // Line numbers where the hunk starts (for an empty side: the line it would follow).
    for (let c = from; c >= 0 && (oldStart === 0 || newStart === 0); c--) {
      const l = lines[c]!;
      if (oldStart === 0 && l.oldNo !== undefined) oldStart = c === from ? l.oldNo : l.oldNo + 1;
      if (newStart === 0 && l.newNo !== undefined) newStart = c === from ? l.newNo : l.newNo + 1;
    }
    hunks.push({
      oldStart: Math.max(1, oldStart),
      oldLines: slice.filter((l) => l.op !== 'add').length,
      newStart: Math.max(1, newStart),
      newLines: slice.filter((l) => l.op !== 'remove').length,
      lines: slice,
    });
  };
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx]!.op === 'equal') continue;
    if (groupStart >= 0 && idx - groupEnd > 2 * context + 1) {
      flush();
      groupStart = -1;
    }
    if (groupStart < 0) groupStart = idx;
    groupEnd = idx;
  }
  flush();
  return { added, removed, hunks, approximate };
}
