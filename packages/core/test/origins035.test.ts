import { describe, expect, it } from 'vitest';
import { contentHash, type EditEvent, Flag, Replayer } from '../src/index.js';

function snap(f: number, path: string, text: string, origin = 'preexisting') {
  return { f, path, origin, text, h: contentHash(text), eol: 'lf', enc: 'utf8' };
}

let seq = 0;
const rec = (k: number, b: unknown) => ({ s: seq++, k, t: seq, m: seq, p: new Uint8Array(32), b }) as never;
const spans = (r: Replayer, f: number) =>
  r.files
    .get(f)!
    .spans!.toArray()
    .map((s) => [s.origin, s.len]);

describe('pasting back text that was just cut keeps its origins (0.3.5)', () => {
  const typed = 'int main() {\n    return 0;\n}\n';
  const outside = '// from the web: fast io\n';

  function setup(events?: EditEvent[]) {
    seq = 0;
    const r = new Replayer({ provenance: true, ...(events ? { onEdit: (e) => events.push(e) } : {}) });
    r.apply(rec(3, snap(0, 'a.cpp', '', 'created')));
    r.apply(rec(4, { f: 0, c: [...typed].map((ch, i) => [100, i, 0, ch]) }));
    r.apply(rec(4, { f: 0, c: [[100, typed.length, 0, outside, Flag.PASTE]] }));
    return r;
  }

  it('Ctrl+A, cut, paste back: typed stays typed and the outside paste stays red', () => {
    const events: EditEvent[] = [];
    const r = setup(events);
    const all = typed + outside;
    r.apply(rec(4, { f: 0, c: [[500, 0, all.length, '']] }));
    r.apply(rec(4, { f: 0, c: [[900, 0, 0, all, Flag.PASTE]] }));
    expect(spans(r, 0)).toEqual([
      ['typed', typed.length],
      ['paste', outside.length],
    ]);
    expect(events.filter((e) => e.moved).length).toBeGreaterThan(0);
  });

  it('moving code to another file keeps its origins; a copy that still exists is a copy', () => {
    const r = setup();
    r.apply(rec(3, snap(1, 'b.cpp', '', 'created')));
    // Copy (the text is still in a.cpp): internal copy.
    r.apply(rec(4, { f: 1, c: [[100, 0, 0, typed, Flag.PASTE]] }));
    expect(spans(r, 1)).toEqual([['internal-copy', typed.length]]);
    // Cut from a.cpp and paste into b.cpp: a move.
    r.apply(rec(4, { f: 0, c: [[100, 0, typed.length, '']] }));
    r.apply(rec(4, { f: 1, c: [[100, typed.length, 0, typed.replace('0', '1'), Flag.PASTE]] }));
    // Not the same text: a paste.
    expect(spans(r, 1).at(-1)![0]).toBe('paste');
  });

  it('code cut from one file and pasted into another keeps its origins', () => {
    const r = setup();
    r.apply(rec(3, snap(1, 'b.cpp', '', 'created')));
    r.apply(rec(4, { f: 0, c: [[100, 0, typed.length, '']] }));
    r.apply(rec(4, { f: 1, c: [[100, 0, 0, typed, Flag.PASTE]] }));
    expect(spans(r, 1)).toEqual([['typed', typed.length]]);
  });

  it('new text pasted after a deletion is still a paste', () => {
    const r = setup();
    r.apply(rec(4, { f: 0, c: [[500, 0, typed.length, '']] }));
    const other = 'int main() {\n    puts("hi");\n}\n';
    r.apply(rec(4, { f: 0, c: [[900, 0, 0, other, Flag.PASTE]] }));
    expect(spans(r, 0)[0]).toEqual(['paste', other.length + outside.length]);
  });
});
