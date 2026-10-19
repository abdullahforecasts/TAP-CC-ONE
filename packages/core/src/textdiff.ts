/**
 * Minimal edits between two texts, for provenance (spec §7.1): when a change or snapshot replaces
 * text, only what really differs gets the new origin, so code that an editor, tool or AI rewrote
 * unchanged keeps the origin it had.
 *
 * Algorithm (normative, so every verifier attributes characters the same way):
 * 1. Strip the longest common prefix and suffix (UTF-16 units).
 * 2. Split what remains of both texts into lines, each keeping its trailing "\n".
 * 3. Diff the lines with Myers' algorithm; if the edit distance would exceed MAX_LINE_EDITS,
 *    or either side has more than MAX_LINES lines, the remainder is one edit.
 * 4. Each run of differing lines becomes one edit, with its own common prefix and suffix stripped.
 * Ties in Myers' algorithm prefer deletions first (the classic forward greedy order).
 */

/** One edit in sequential order: offsets refer to the text after all earlier edits. */
export interface TextEdit {
  off: number;
  del: number;
  ins: string;
}

/** Above this many changed lines the remainder is treated as one edit. */
export const MAX_LINE_EDITS = 1000;
/** Above this many lines on either side the remainder is treated as one edit. */
export const MAX_LINES = 20000;

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffix(a: string, b: string, max: number): number {
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

function splitLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Myers diff over string arrays: returns matched index pairs, or undefined past the limit. */
function matchLines(a: string[], b: string[], limit: number): Array<[number, number]> | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset);
    }
  }
  return undefined;
}

function backtrack(
  trace: Int32Array[],
  depth: number,
  n: number,
  m: number,
  offset: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = depth; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  return pairs.reverse();
}

/**
 * Sequential edits that turn `a` into `b`, touching as little as possible. Applying them in
 * order to `a` gives `b` exactly. Returns [] when the texts are equal.
 */
export function minimalEdits(a: string, b: string): TextEdit[] {
  if (a === b) return [];
  const pre = commonPrefix(a, b);
  const suf = commonSuffix(a, b, Math.min(a.length, b.length) - pre);
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (midA === '' || midB === '') return [{ off: pre, del: midA.length, ins: midB }];
  const la = splitLines(midA);
  const lb = splitLines(midB);
  const pairs =
    la.length + lb.length > 2 && la.length <= MAX_LINES && lb.length <= MAX_LINES
      ? matchLines(la, lb, MAX_LINE_EDITS)
      : undefined;
  if (!pairs || pairs.length === 0) return [{ off: pre, del: midA.length, ins: midB }];

  const edits: TextEdit[] = [];
  // Offsets into the evolving text: `pos` walks `b`'s layout, since earlier edits are applied.
  let pos = pre;
  let ia = 0;
  let ib = 0;
  const flush = (toA: number, toB: number) => {
    const oldPart = la.slice(ia, toA).join('');
    const newPart = lb.slice(ib, toB).join('');
    if (oldPart !== '' || newPart !== '') {
      const p = commonPrefix(oldPart, newPart);
      const s = commonSuffix(oldPart, newPart, Math.min(oldPart.length, newPart.length) - p);
      const del = oldPart.length - p - s;
      const ins = newPart.slice(p, newPart.length - s);
      if (del > 0 || ins !== '') edits.push({ off: pos + p, del, ins });
      pos += newPart.length;
    }
    ia = toA;
    ib = toB;
  };
  for (const [x, y] of pairs) {
    flush(x, y);
    pos += lb[y]!.length;
    ia = x + 1;
    ib = y + 1;
  }
  flush(la.length, lb.length);
  return edits;
}
