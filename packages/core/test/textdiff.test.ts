import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { minimalEdits } from '../src/textdiff.js';

const apply = (s: string, es: { off: number; del: number; ins: string }[]) =>
  es.reduce((t, e) => t.slice(0, e.off) + e.ins + t.slice(e.off + e.del), s);
describe('minimalEdits', () => {
  it('round trips', () => {
    const line = fc.constantFrom('a\n', 'b\n', 'int x;\n', '}\n', '\n', 'cout<<1;\n', 'x', 'y\n');
    fc.assert(
      fc.property(fc.array(line, { maxLength: 40 }), fc.array(line, { maxLength: 40 }), (A, B) => {
        const a = A.join('');
        const b = B.join('');
        expect(apply(a, minimalEdits(a, b))).toBe(b);
      }),
      { numRuns: 3000 },
    );
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(apply(a, minimalEdits(a, b))).toBe(b);
      }),
      { numRuns: 2000 },
    );
  });
  it('keeps unchanged lines out of the edits', () => {
    const a = 'L1\nL2\nL3\nL4\nL5\n';
    const b = 'L1\nX\nL2\nL3\nL4\nY\nL5\n';
    const edits = minimalEdits(a, b);
    expect(edits).toHaveLength(2);
    expect(edits.map((e) => e.del)).toEqual([0, 0]);
    expect(edits.map((e) => e.ins.length)).toEqual([2, 2]);
    // A whole-text replacement that only adds one line touches only that line.
    const big = 'line\n'.repeat(200);
    const withOne = `${'line\n'.repeat(100)}NEW\n${'line\n'.repeat(100)}`;
    expect(minimalEdits(big, withOne)).toEqual([{ off: 500, del: 0, ins: 'NEW\n' }]);
    // Two separate changes keep everything between them out of the edits.
    const two = `A\n${'line\n'.repeat(50)}B\n`;
    const twoNew = `A2\n${'line\n'.repeat(50)}B2\n`;
    expect(minimalEdits(two, twoNew).reduce((n, e) => n + e.del + e.ins.length, 0)).toBe(2);
  });
});
