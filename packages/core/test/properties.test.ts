import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type ChangeTuple,
  concatBytes,
  contentHash,
  decodeCanonical,
  encodeCanonical,
  encodeFrame,
  Flag,
  LogWriter,
  MAGIC,
  Replayer,
  readLog,
  toHex,
  toSequentialChanges,
  verifyLog,
} from '../src/index.js';
import { sessionStart, testKey } from './support/raw.js';

const key = testKey();
const RUNS = Number(process.env.TAP_PROPERTY_RUNS ?? 150);

// Pieces that stress the format: CRLF, astral characters, combining marks, tabs, CJK.
const piece = fc.constantFrom('a', 'b', 'Z', ' ', '\t', '\n', '\r\n', 'é', 'é', '中', '😀', '𝄞', '{', '}');
const text = fc.array(piece, { maxLength: 40 }).map((p) => p.join(''));

/** Offsets that fall on code-point boundaries (an editor never splits a surrogate pair). */
function boundaries(s: string): number[] {
  const out = [0];
  let pos = 0;
  for (const ch of s) {
    pos += ch.length;
    out.push(pos);
  }
  return out;
}

interface EditSpec {
  start: number;
  span: number;
  ins: string;
  flags: number;
}

const flagChoice = fc.constantFrom(
  0,
  0,
  0,
  Flag.PASTE,
  Flag.BULK,
  Flag.UNDO,
  Flag.REDO,
  Flag.FORMAT_ON_SAVE,
  Flag.MULTI_CURSOR,
);
const editSpec = fc.record({ start: fc.nat(), span: fc.nat({ max: 6 }), ins: text, flags: flagChoice });

/** Reference model: an array of code points, independent of the string-slicing replay. */
function applyReference(cps: string[], startCp: number, delCp: number, ins: string): string[] {
  const copy = [...cps];
  copy.splice(startCp, delCp, ...Array.from(ins));
  return copy;
}

function buildLog(initial: string, edits: EditSpec[], blockSize: number, compress: boolean) {
  const w = LogWriter.create({
    created: 1,
    tool: 'prop',
    logId: new Uint8Array(16),
    targetBlockSize: blockSize,
    compress,
  });
  const T = { t: 10, m: 0 };
  w.append('SESSION_START', sessionStart(key.publicKey), T);
  w.append(
    'FILE_SNAPSHOT',
    {
      f: 0,
      path: 'p.txt',
      origin: 'preexisting',
      text: initial,
      h: contentHash(initial),
      eol: initial.includes('\r\n') ? 'crlf' : 'lf',
      enc: 'utf8',
    },
    T,
  );
  let cps = Array.from(initial);
  let current = initial;
  let batch: ChangeTuple[] = [];
  edits.forEach((e, i) => {
    const b = boundaries(current);
    const startCp = e.start % b.length;
    const delCp = Math.min(e.span, b.length - 1 - startCp);
    const off = b[startCp]!;
    const del = b[startCp + delCp]! - off;
    if (del === 0 && e.ins.length === 0) return;
    batch.push(e.flags ? [i, off, del, e.ins, e.flags] : [i, off, del, e.ins]);
    cps = applyReference(cps, startCp, delCp, e.ins);
    current = cps.join('');
    if (batch.length >= 3) {
      w.append('EDIT_BATCH', { f: 0, c: batch }, T);
      batch = [];
    }
  });
  if (batch.length > 0) w.append('EDIT_BATCH', { f: 0, c: batch }, T);
  w.append('SAVE', { f: 0, h: contentHash(current), n: current.length }, T);
  w.appendCheckpoint(key.secretKey, T);
  return { bytes: w.drain(), expected: current, writer: w };
}

describe('properties', () => {
  it('random edits on Unicode/CRLF text replay identically after encode → decode', () => {
    fc.assert(
      fc.property(
        text,
        fc.array(editSpec, { maxLength: 25 }),
        fc.constantFrom(64, 512, 65536),
        fc.boolean(),
        (initial, edits, blockSize, compress) => {
          const { bytes, expected, writer } = buildLog(initial, edits, blockSize, compress);
          // The writer's own replay agrees with the reference model.
          expect(writer.state.files.get(0)!.text).toBe(expected);
          // A fresh reader + replayer agrees too.
          const r = new Replayer({ provenance: true });
          for (const entry of readLog(bytes).records) {
            expect(r.apply(entry.record).filter((x) => x.severity === 'fail')).toEqual([]);
          }
          expect(r.files.get(0)!.text).toBe(expected);
          // Provenance stays aligned with the text.
          expect(r.composition().chars).toBe(expected.length);
          // And the full verifier finds no failures, with the right final hash.
          const report = verifyLog(bytes, {
            submission: [{ path: 'p.txt', content: expected.replace(/\r\n/g, '\n') }],
          });
          expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
          expect(report.finalFiles[0]!.sha256).toBe(toHex(contentHash(expected)));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('simultaneous multi-cursor changes equal their sequential conversion', () => {
    const scenario = fc
      .tuple(
        fc.string({ maxLength: 60 }),
        fc.array(fc.tuple(fc.nat(), fc.nat({ max: 5 }), fc.string({ maxLength: 4 })), { maxLength: 8 }),
      )
      .map(([doc, raw]) => {
        // Turn random picks into sorted, non-overlapping ranges over `doc`.
        const picks = raw
          .map(([o, l, t]) => ({ rangeOffset: o % (doc.length + 1), rangeLength: l, text: t }))
          .sort((a, b) => a.rangeOffset - b.rangeOffset);
        const changes: { rangeOffset: number; rangeLength: number; text: string }[] = [];
        let minStart = 0;
        for (const p of picks) {
          const start = Math.max(p.rangeOffset, minStart);
          if (start > doc.length) break;
          const len = Math.min(p.rangeLength, doc.length - start);
          // Only one change may start at a given offset unless the earlier one is an insertion.
          const prev = changes[changes.length - 1];
          if (prev && prev.rangeOffset === start && (prev.rangeLength > 0 || len === 0)) continue;
          changes.push({ rangeOffset: start, rangeLength: len, text: p.text });
          minStart = start + len;
        }
        return { doc, changes };
      });
    fc.assert(
      fc.property(scenario, ({ doc, changes }) => {
        // Reference: walk the original document once, emitting replacements in order.
        let simultaneous = '';
        let pos = 0;
        for (const c of changes) {
          simultaneous += doc.slice(pos, c.rangeOffset) + c.text;
          pos = c.rangeOffset + c.rangeLength;
        }
        simultaneous += doc.slice(pos);
        let sequential = doc;
        for (const c of toSequentialChanges(changes)) {
          sequential =
            sequential.slice(0, c.rangeOffset) + c.text + sequential.slice(c.rangeOffset + c.rangeLength);
        }
        expect(sequential).toBe(simultaneous);
      }),
      { numRuns: RUNS * 3 },
    );
  });

  it('modifying any record before the last checkpoint breaks the chain at the next record', () => {
    fc.assert(
      fc.property(
        text,
        fc.array(editSpec, { minLength: 3, maxLength: 12 }),
        fc.nat(),
        fc.nat(),
        (initial, edits, pick, delta) => {
          const { bytes } = buildLog(initial, edits, 256, true);
          const parsed = readLog(bytes);
          const lastCheckpoint = parsed.records.length - 1;
          const i = pick % lastCheckpoint;
          const value = decodeCanonical(parsed.records[i]!.bytes) as { t: number };
          value.t = value.t + 1 + (delta % 1000);
          const forged = parsed.records.map((r, j) => (j === i ? encodeCanonical(value as never) : r.bytes));
          const rebuilt = concatBytes(
            MAGIC,
            encodeFrame(parsed.headerBytes, false),
            encodeFrame(concatBytes(...forged), true),
          );
          const report = verifyLog(rebuilt);
          expect(report.verdict).toBe('NOT_INTACT');
          expect(report.findings.find((f) => f.severity === 'fail')).toMatchObject({
            code: 'CHAIN_BROKEN',
            seq: i + 1,
          });
        },
      ),
      { numRuns: RUNS },
    );
  });
});
