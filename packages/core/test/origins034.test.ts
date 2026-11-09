import { describe, expect, it } from 'vitest';
import {
  contentHash,
  Flag,
  insertOrigin,
  REMOVED_HISTORY_CHARS,
  RemovedHistory,
  Replayer,
} from '../src/index.js';

function snap(f: number, path: string, text: string, origin = 'preexisting') {
  return { f, path, origin, text, h: contentHash(text), eol: 'lf', enc: 'utf8' };
}

let seq = 0;
const rec = (k: number, b: unknown) => ({ s: seq++, k, t: seq, m: seq, p: new Uint8Array(32), b }) as never;

function originsByLine(r: Replayer, f = 0): string[] {
  const file = r.files.get(f)!;
  const spans = file.spans!.toArray();
  const at = (p: number) => {
    let a = 0;
    for (const s of spans) {
      if (p < a + s.len) return s.origin;
      a += s.len;
    }
    return '?';
  };
  let pos = 0;
  return file.text.split('\n').map((line) => {
    const set = new Set<string>();
    for (let i = 0; i < line.length; i++) if (line[i] !== ' ') set.add(at(pos + i));
    pos += line.length + 1;
    return [...set].join(',');
  });
}

describe('which inserts the editor made (0.3.4)', () => {
  it('a suggestion replacing the typed word is a completion; a rewrite of a region is judged by what changed', () => {
    expect(insertOrigin('namespace', 'name')).toBe('completion');
    expect(insertOrigin('next')).toBe('completion'); // member suggestion after "->"
    expect(insertOrigin('()')).toBe('typed');
    expect(insertOrigin('\n    }')).toBe('typed');
    expect(insertOrigin('x'.repeat(40))).toBe('bulk');
    expect(insertOrigin('abc', 'two words')).toBe('typed');
  });

  it('an editor that replaces the whole file for every few characters typed shows typing (RM.md case)', () => {
    seq = 0;
    const r = new Replayer({ provenance: true });
    let text = 'notes\n\n';
    r.apply(rec(3, snap(0, 'RM.md', text, 'created')));
    for (const burst of ['n', 'igga', ' new', ' s', 'cnz', 'zz', ' bu', 'aha', 'hah']) {
      const next = `${text}${burst}`;
      // The recorder flagged each whole-file replacement BULK (it is 40+ characters long).
      r.apply(rec(4, { f: 0, c: [[300, 0, text.length, next, Flag.BULK]] }));
      text = next;
    }
    expect(originsByLine(r)).toEqual(['created', '', 'typed']);
  });

  it('a tool rewriting a region with 40+ new characters is still bulk', () => {
    seq = 0;
    const r = new Replayer({ provenance: true });
    const before = 'int main() {\n    return 0;\n}\n';
    const after = 'int main() {\n    for (int i = 0; i < 10; i++) printf("%d", i);\n    return 0;\n}\n';
    r.apply(rec(3, snap(0, 'a.c', before)));
    r.apply(rec(4, { f: 0, c: [[0, 0, before.length, after]] }));
    expect(originsByLine(r)).toEqual(['preexisting', 'bulk', 'preexisting', 'preexisting', '']);
  });
});

describe('removed-text history for undo (0.3.4)', () => {
  it('keeps pieces by size, not by count, so many small edits do not push out the one undone', () => {
    const h = new RemovedHistory();
    h.add({
      text: 'vector<int> result;\nNode* temp = head;\n',
      spans: [{ len: 39, origin: 'external', seq: 5 }],
    });
    for (let i = 0; i < 1000; i++)
      h.add({ text: ` ${i}`, spans: [{ len: ` ${i}`.length, origin: 'typed', seq: 6 }] });
    expect(h.restore('vector<int> result;\nNode* temp = head;\n', 'undo-redo', 9)).toEqual([
      { text: 'vector<int> result;\nNode* temp = head;\n', origin: 'external', seq: 5 },
    ]);
    // Bounded: very old text is eventually forgotten.
    h.add({
      text: 'y'.repeat(REMOVED_HISTORY_CHARS),
      spans: [{ len: REMOVED_HISTORY_CHARS, origin: 'typed', seq: 7 }],
    });
    expect(h.restore('vector<int> result;\nNode* temp = head;\n', 'undo-redo', 9)).toBeUndefined();
  });

  it('restores line by line when the undo brings back text split differently', () => {
    const h = new RemovedHistory();
    h.add({ text: '    while (temp != nullptr) {\n', spans: [{ len: 30, origin: 'external', seq: 3 }] });
    h.add({ text: '        temp = temp->next;\n', spans: [{ len: 27, origin: 'external', seq: 3 }] });
    const pieces = h.restore(
      '    while (temp != nullptr) {\n        temp = temp->next;\n    }\n',
      'undo-redo',
      9,
    )!;
    const by = pieces.map((p) => [p.origin, p.text.trim()]).filter(([, t]) => t !== '');
    expect(by).toEqual([
      ['external', 'while (temp != nullptr) {'],
      ['external', 'temp = temp->next;'],
      ['undo-redo', '}'],
    ]);
  });
});
