import {
  type ChangeTuple,
  concatBytes,
  contentHash,
  crc32,
  decodeCanonical,
  encodeCanonical,
  encodeFrame,
  Flag,
  LogWriter,
  MAGIC,
  readLog,
  type SubmittedFile,
  scanForRecovery,
  toSequentialChanges,
  utf8,
  type VerifyReport,
} from '@tap/core';
import { encode } from 'cborg';
import { deflateSync } from 'fflate';
import { BASE_TIME, Script } from './builder.js';

export interface ExpectedFinding {
  code: string;
  severity: 'fail' | 'warn' | 'info';
  seq?: number;
  offset?: number;
}

export interface VectorOutput {
  log: Uint8Array;
  submission?: SubmittedFile[];
  /** Facts the generator learned while building (e.g. sequence numbers to expect). */
  facts?: Record<string, number>;
}

export interface VectorDef {
  id: string;
  slug: string;
  title: string;
  description: string;
  build(): VectorOutput;
  verdict: VerifyReport['verdict'];
  /** The complete list of non-pass findings the verifier must produce. */
  findings(facts: Record<string, number>): ExpectedFinding[];
  /** Extra intent checks on the report (composition etc.). Throw on mismatch. */
  check?(report: VerifyReport, facts: Record<string, number>): void;
}

const NO_ANCHORS: ExpectedFinding = { code: 'NO_ANCHORS', severity: 'warn' };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`vector intent violated: ${message}`);
}

const MAIN_CPP = '#include <iostream>\n\nint main() {\n  std::cout << "hi";\n  return 0;\n}\n';

/** 002 is reused by several tamper vectors. */
function buildTypedSingleFile(): { log: Uint8Array; facts: Record<string, number> } {
  const s = new Script({ id: '002-single-file-typed', label: 'assignment-1' });
  s.startSession();
  s.create(0, 'main.cpp');
  s.type(0, 0, MAIN_CPP, 150);
  s.save(0);
  const ck = s.checkpoint();
  s.endSession();
  return { log: s.bytes(), facts: { checkpoint: ck } };
}

/** Rebuilds a file from header bytes and per-block record byte arrays (used to forge tampered logs). */
function frameLog(headerBytes: Uint8Array, blocks: Uint8Array[][]): Uint8Array {
  return concatBytes(
    MAGIC,
    encodeFrame(headerBytes, false),
    ...blocks.map((recs) => encodeFrame(concatBytes(...recs), true)),
  );
}

function blocksOf(parsed: ReturnType<typeof readLog>): { headerBytes: Uint8Array; blocks: Uint8Array[][] } {
  const blocks: Uint8Array[][] = [];
  for (const r of parsed.records) {
    blocks[r.block] ??= [];
    blocks[r.block]!.push(r.bytes);
  }
  return { headerBytes: parsed.headerBytes, blocks };
}

export const VECTORS: VectorDef[] = [
  {
    id: '001',
    slug: 'minimal',
    title: 'Minimal log',
    description: 'Header, SESSION_START and SESSION_END only. No checkpoints and no anchors.',
    build() {
      const s = new Script({ id: '001-minimal' });
      s.startSession().endSession();
      return { log: s.bytes() };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [{ code: 'NO_CHECKPOINTS', severity: 'warn' }, NO_ANCHORS],
    check(r) {
      assert(r.recordCount === 2, 'two records');
      assert(r.finalFiles.length === 0, 'no files');
    },
  },
  {
    id: '002',
    slug: 'single-file-typed',
    title: 'One file typed, saved and checkpointed',
    description:
      'A new main.cpp is created and typed character by character, saved, and covered by a signed checkpoint. The submission matches.',
    build() {
      const { log, facts } = buildTypedSingleFile();
      return { log, facts, submission: [{ path: 'main.cpp', content: utf8(MAIN_CPP) }] };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      const c = r.composition!;
      assert(c.chars === MAIN_CPP.length, 'composition covers the whole file');
      assert(c.byOrigin.typed?.chars === MAIN_CPP.length, '100% typed');
      assert(
        r.findings.some((f) => f.code === 'SUBMISSION_MATCH'),
        'submission matches',
      );
    },
  },
  {
    id: '003',
    slug: 'crlf',
    title: 'CRLF file edited across line endings',
    description:
      'A preexisting Windows (CRLF) file is edited, including a deletion that spans a CRLF. Offsets count \\r\\n as two units. The LF submission still matches because comparison normalises line endings.',
    build() {
      const s = new Script({ id: '003-crlf' });
      s.startSession();
      const start = 'line one\r\nline two\r\nline three\r\n';
      s.snapshot(0, 'notes.txt', start, 'preexisting');
      // Insert a new line after "line one\r\n" (offset 10).
      s.type(0, 10, 'inserted\r\n');
      // Delete "two\r\nline " (spans the CRLF): text is now "line one\r\ninserted\r\nline two\r\n..."
      const at = 'line one\r\ninserted\r\nline '.length;
      s.edit(0, [[400, at, 'two\r\nline '.length, '']]);
      s.save(0);
      s.checkpoint();
      s.endSession();
      const finalText = 'line one\ninserted\nline three\n';
      return { log: s.bytes(), submission: [{ path: 'notes.txt', content: utf8(finalText) }] };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      assert(
        r.findings.some((f) => f.code === 'SUBMISSION_MATCH'),
        'CRLF log matches LF submission',
      );
      assert(
        r.finalFiles[0]!.length === 'line one\r\ninserted\r\nline three\r\n'.length,
        'native length kept',
      );
    },
  },
  {
    id: '004',
    slug: 'surrogate-pairs',
    title: 'Emoji and astral characters',
    description:
      'Characters outside the Basic Multilingual Plane occupy two UTF-16 code units. They are inserted, deleted (del = 2) and replaced.',
    build() {
      const s = new Script({ id: '004-surrogate-pairs' });
      s.startSession();
      s.create(0, 'unicode.py');
      s.type(0, 0, 'print("😀")\n');
      // Delete the emoji (offset 7, two code units) and insert a musical symbol instead.
      s.edit(0, [
        [300, 7, 2, ''],
        [200, 7, 0, '𝄞'],
      ]);
      s.type(0, 'print("𝄞")\n'.length, '# ünïcödé ✓\n');
      s.save(0);
      s.checkpoint();
      s.endSession();
      return {
        log: s.bytes(),
        submission: [{ path: 'unicode.py', content: utf8('print("𝄞")\n# ünïcödé ✓\n') }],
      };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      assert(
        r.findings.some((f) => f.code === 'SUBMISSION_MATCH'),
        'astral text matches',
      );
    },
  },
  {
    id: '005',
    slug: 'multi-cursor',
    title: 'Multi-cursor edit in sequential order',
    description:
      'Three cursors insert "// " at the start of three lines in one editor event. The changes are stored in descending-offset order with the MULTI_CURSOR flag, so applying them one by one reproduces the editor result.',
    build() {
      const s = new Script({ id: '005-multi-cursor' });
      s.startSession();
      s.snapshot(0, 'a.js', 'a();\nb();\nc();\n', 'preexisting');
      const seq = toSequentialChanges([
        { rangeOffset: 0, rangeLength: 0, text: '// ' },
        { rangeOffset: 5, rangeLength: 0, text: '// ' },
        { rangeOffset: 10, rangeLength: 0, text: '// ' },
      ]);
      s.edit(
        0,
        seq.map(
          (c, i): ChangeTuple => [i === 0 ? 800 : 0, c.rangeOffset, c.rangeLength, c.text, Flag.MULTI_CURSOR],
        ),
      );
      s.save(0);
      s.checkpoint();
      s.endSession();
      return { log: s.bytes(), submission: [{ path: 'a.js', content: utf8('// a();\n// b();\n// c();\n') }] };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      assert(
        r.findings.some((f) => f.code === 'SUBMISSION_MATCH'),
        'multi-cursor result matches',
      );
      assert(r.composition!.byOrigin.typed?.chars === 9, 'three "// " insertions count as typed');
    },
  },
  {
    id: '006',
    slug: 'classification-flags',
    title: 'Typed, pasted, bulk, format-on-save and undo',
    description:
      'One file receives typed text, a paste from outside the workspace, a bulk insertion (completion), formatter edits during save, and an undo. Final-code composition attributes each region to its origin.',
    build() {
      const s = new Script({ id: '006-classification-flags' });
      s.startSession();
      s.create(0, 'solve.py');
      s.type(0, 0, 'def solve(n):\n');
      const pasted = '    return sum(range(n))\n';
      s.edit(0, [[1500, 'def solve(n):\n'.length, 0, pasted, Flag.PASTE]]);
      const afterPaste = 'def solve(n):\n'.length + pasted.length;
      const bulk = 'print(solve(10))\n';
      s.edit(0, [[900, afterPaste, 0, bulk, Flag.BULK]]);
      // Typo then undo: type "x", undo it.
      const end = afterPaste + bulk.length;
      s.edit(0, [
        [300, end, 0, 'x'],
        [700, end, 1, '', Flag.UNDO],
      ]);
      // Formatter adds a blank line before print() during save.
      s.edit(0, [[50, afterPaste, 0, '\n', Flag.FORMAT_ON_SAVE]]);
      s.save(0);
      s.checkpoint();
      s.endSession();
      return { log: s.bytes() };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      const o = r.composition!.byOrigin;
      assert(o.typed?.chars === 'def solve(n):\n'.length, 'typed region');
      assert(o.paste?.chars === '    return sum(range(n))\n'.length, 'external paste region');
      assert(o.bulk?.chars === 'print(solve(10))\n'.length, 'bulk region');
      assert(o.format?.chars === 1, 'format-on-save newline');
      assert(o['undo-redo'] === undefined, 'undo removed text, nothing remains attributed to it');
    },
  },
  {
    id: '007',
    slug: 'internal-copy',
    title: 'Paste of code that already exists in the workspace',
    description:
      'A helper function from utils.cpp is copied into main.cpp. Because the pasted text already exists in the workspace, it is attributed to internal-copy rather than paste.',
    build() {
      const s = new Script({ id: '007-internal-copy' });
      s.startSession();
      const helper = 'int add(int a, int b) {\n  return a + b;\n}\n';
      s.snapshot(0, 'utils.cpp', helper, 'preexisting');
      s.create(1, 'main.cpp');
      s.type(1, 0, '// main\n');
      s.edit(1, [[1200, '// main\n'.length, 0, helper, Flag.PASTE]]);
      s.save(1);
      s.checkpoint();
      s.endSession();
      return { log: s.bytes() };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      const o = r.composition!.byOrigin;
      assert(
        o['internal-copy']?.chars === 'int add(int a, int b) {\n  return a + b;\n}\n'.length,
        'internal copy',
      );
      assert(o.paste === undefined, 'no external paste');
    },
  },
  {
    id: '008',
    slug: 'external-change',
    title: 'File changed outside the editor',
    description:
      'After typing, one line of the file is changed on disk by another program. EXTERNAL_CHANGE is followed by an external snapshot; only the changed region is attributed to external.',
    build() {
      const s = new Script({ id: '008-external-change' });
      s.startSession();
      s.create(0, 'app.c');
      const typed = 'int x = 1;\nint y = 2;\n';
      s.type(0, 0, typed);
      s.save(0);
      const changed = 'int x = 1;\nint y = 42;\n';
      s.tick(5000);
      s.rec('EXTERNAL_CHANGE', { f: 0, h: contentHash(changed) });
      s.snapshot(0, 'app.c', changed, 'external');
      s.checkpoint();
      s.endSession();
      return { log: s.bytes(), submission: [{ path: 'app.c', content: utf8(changed) }] };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS, { code: 'EXTERNAL_CHANGE', severity: 'info' }],
    check(r) {
      const o = r.composition!.byOrigin;
      // "2;\n" -> "42;\n": the shared suffix keeps its origin, only the inserted "4" is external.
      assert(o.external?.chars === 1, 'only the inserted "4" is external');
      assert(o.typed?.chars === 'int x = 1;\nint y = 2;\n'.length, 'everything else stays typed');
    },
  },
  {
    id: '009',
    slug: 'pause-gap',
    title: 'Pause, edit while paused, resume',
    description:
      'Recording is paused, the file changes while paused, and on resume a paused-gap snapshot records the difference. The verifier flags the gap.',
    build() {
      const s = new Script({ id: '009-pause-gap' });
      s.startSession();
      s.create(0, 'main.py');
      s.type(0, 0, 'x = 1\n');
      s.save(0);
      s.checkpoint();
      s.tick(1000);
      s.rec('PAUSE', { why: 'personal break' });
      s.tick(600_000);
      s.rec('RESUME', {});
      s.snapshot(0, 'main.py', 'x = 1\ny = 2\n', 'paused-gap');
      s.save(0);
      s.checkpoint();
      s.endSession();
      return { log: s.bytes() };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [
      NO_ANCHORS,
      { code: 'PAUSED', severity: 'info' },
      { code: 'PAUSED_GAP_CHANGES', severity: 'warn' },
    ],
    check(r) {
      assert(r.composition!.byOrigin['paused-gap']?.chars === 'y = 2\n'.length, 'gap region attributed');
    },
  },
  {
    id: '010',
    slug: 'file-operations',
    title: 'Create, rename and delete files',
    description:
      'a.py is created and typed, then renamed to b.py; c.py is created and deleted. Only b.py remains, and file ids are never reused.',
    build() {
      const s = new Script({ id: '010-file-operations' });
      s.startSession();
      s.create(0, 'a.py');
      s.type(0, 0, 'print(1)\n');
      s.save(0);
      s.tick(1000);
      s.rec('FILE_OP', { op: 'rename', f: 0, path: 'a.py', newPath: 'src/b.py', origin: 'editor' });
      s.create(1, 'c.py');
      s.type(1, 0, 'tmp\n');
      s.tick(1000);
      s.rec('FILE_OP', { op: 'delete', f: 1, path: 'c.py', origin: 'editor' });
      s.checkpoint();
      s.endSession();
      return { log: s.bytes(), submission: [{ path: 'src\\b.py', content: utf8('print(1)\n') }] };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS],
    check(r) {
      assert(r.finalFiles.length === 1 && r.finalFiles[0]!.path === 'src/b.py', 'only src/b.py remains');
      assert(
        r.findings.some((f) => f.code === 'SUBMISSION_MATCH'),
        'Windows-style submitted path matches',
      );
    },
  },
  {
    id: '011',
    slug: 'recovery',
    title: 'Crash, truncated tail, recovery',
    description:
      'The last block was only partly written when the editor crashed. On reopening, the damaged tail is quarantined, the file truncated, and a RECOVERY record appended before the next session.',
    build() {
      const s = new Script({ id: '011-recovery' });
      s.startSession();
      s.create(0, 'main.c');
      s.type(0, 0, 'int main(void) {\n');
      s.save(0);
      s.checkpoint();
      const intact = s.bytes();
      // Unsaved typing in a block whose write was cut short by the crash.
      s.type(0, 'int main(void) {\n'.length, '  return 0;\n}\n');
      const lastBlock = s.bytes();
      const crashed = concatBytes(intact, lastBlock.subarray(0, Math.floor(lastBlock.length / 2)));

      const scan = scanForRecovery(crashed);
      const resumed = new Script(
        { id: '011-recovery' },
        {
          bytes: crashed.subarray(0, scan.validLength),
          at: BASE_TIME + 3_600_000,
        },
      );
      resumed.rec('RECOVERY', LogWriter.recoveryBody(scan));
      resumed.startSession();
      resumed.type(0, 'int main(void) {\n'.length, '  return 0;\n}\n');
      resumed.save(0);
      resumed.checkpoint();
      resumed.endSession();
      return {
        log: concatBytes(crashed.subarray(0, scan.validLength), resumed.bytes()),
        submission: [{ path: 'main.c', content: utf8('int main(void) {\n  return 0;\n}\n') }],
      };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [
      NO_ANCHORS,
      { code: 'RECOVERED', severity: 'warn' },
      { code: 'SESSION_NOT_CLOSED', severity: 'info' },
    ],
  },
  {
    id: '012',
    slug: 'key-rotation',
    title: 'Signing key replaced between sessions',
    description:
      'The first session signs with key A. The key is lost (e.g. OS reinstall), so KEY_ROTATION announces key B, and the next session signs with key B.',
    build() {
      const s = new Script({ id: '012-key-rotation', keyLabel: 'student-1' });
      s.startSession();
      s.create(0, 'hw.py');
      s.type(0, 0, 'a = 1\n');
      s.save(0);
      s.checkpoint();
      s.endSession();
      const newKey = new Script({ id: 'unused', keyLabel: 'student-1-new' }).key;
      s.tick(86_400_000);
      s.rec('KEY_ROTATION', { newPub: newKey.publicKey, why: 'lost' });
      s.key = newKey;
      s.startSession();
      s.type(0, 'a = 1\n'.length, 'b = 2\n');
      s.save(0);
      s.checkpoint();
      s.endSession();
      return { log: s.bytes() };
    },
    verdict: 'INTACT_WITH_WARNINGS',
    findings: () => [NO_ANCHORS, { code: 'KEY_ROTATED', severity: 'warn' }],
    check(r) {
      assert(r.keys.length === 2, 'two keys reported');
    },
  },

  // ------------------------------------------------------------------------------------------
  // Tampered and malformed logs
  // ------------------------------------------------------------------------------------------
  {
    id: '100',
    slug: 'byte-flipped',
    title: 'One byte flipped inside a block',
    description:
      'A single byte in the middle of the first record block of vector 002 is changed. The block checksum fails.',
    build() {
      const { log } = buildTypedSingleFile();
      const parsed = readLog(log);
      const blockOffset = parsed.records[0]!.blockOffset;
      const out = log.slice();
      out[blockOffset + 40] = out[blockOffset + 40]! ^ 0x20;
      return { log: out, facts: { blockOffset } };
    },
    verdict: 'NOT_INTACT',
    findings: (f) => [{ code: 'BAD_CRC', severity: 'fail', offset: f.blockOffset! }],
  },
  {
    id: '101',
    slug: 'record-modified',
    title: 'Record edited and checksum recomputed',
    description:
      'An attacker changes typed text inside an EDIT_BATCH ("hi" becomes "HI") and recomputes the block CRC. The hash chain breaks at the next record.',
    build() {
      const { log } = buildTypedSingleFile();
      const parsed = readLog(log);
      const { headerBytes, blocks } = blocksOf(parsed);
      // Find the first record whose text contains the "h" of "hi".
      const target = parsed.records.findIndex(
        (r) => r.record.k === 4 && JSON.stringify(r.record.b).includes('"h"'),
      );
      const entry = parsed.records[target]!;
      const value = decodeCanonical(entry.bytes) as { b: { c: ChangeTuple[] } };
      for (const c of value.b.c) if (c[3] === 'h') c[3] = 'H';
      const forged = encodeCanonical(value as never);
      const block = blocks[entry.block]!;
      block[block.indexOf(entry.bytes)] = forged;
      return { log: frameLog(headerBytes, blocks), facts: { brokenAt: target + 1 } };
    },
    verdict: 'NOT_INTACT',
    findings: (f) => [{ code: 'CHAIN_BROKEN', severity: 'fail', seq: f.brokenAt! }],
  },
  {
    id: '102',
    slug: 'chain-rebuilt',
    title: 'Record removed and whole chain rebuilt and re-signed',
    description:
      'The student removes a NOTE, renumbers, rebuilds the hash chain and re-signs every checkpoint with their own key. The anchor records still carry the digests that were timestamped before the edit, so they no longer match. (Timestamp tokens here are placeholders; real token verification arrives with anchoring.)',
    build() {
      const run = (withNote: boolean, anchors: Uint8Array[] | null) => {
        const s = new Script({ id: '102-chain-rebuilt' });
        s.startSession();
        s.create(0, 'q1.py');
        s.type(0, 0, 'ans = 42\n');
        if (withNote) s.rec('NOTE', { text: 'Copied the answer from a website.' });
        s.save(0);
        const ck1 = s.checkpoint();
        const digests: Uint8Array[] = [s.writer.headHash];
        s.tick(5000);
        s.rec('ANCHOR', anchorBody(ck1, anchors ? anchors[0]! : digests[0]!));
        s.type(0, 'ans = 42\n'.length, 'print(ans)\n');
        s.save(0);
        const ck2 = s.checkpoint();
        digests.push(s.writer.headHash);
        s.tick(5000);
        s.rec('ANCHOR', anchorBody(ck2, anchors ? anchors[1]! : digests[1]!));
        s.endSession();
        return { log: s.bytes(), digests };
      };
      const original = run(true, null);
      // The forger rebuilds without the note but can only reuse the original anchored digests.
      const forged = run(false, original.digests);
      return { log: forged.log, facts: { firstAnchor: 0 } };
    },
    verdict: 'NOT_INTACT',
    findings: () => [
      { code: 'ANCHOR_DIGEST_MISMATCH', severity: 'fail' },
      { code: 'ANCHOR_DIGEST_MISMATCH', severity: 'fail' },
    ],
  },
  {
    id: '103',
    slug: 'non-canonical-cbor',
    title: 'Record with unsorted map keys',
    description:
      'The SESSION_END record of vector 001 is re-encoded with its map keys in reverse order. The content is the same, but the encoding is not deterministic, so the parser rejects it.',
    build() {
      const s = new Script({ id: '001-minimal' });
      s.startSession().endSession();
      const { headerBytes, blocks } = blocksOf(readLog(s.bytes()));
      const block = blocks[0]!;
      const last = block[block.length - 1]!;
      const value = decodeCanonical(last);
      // biome-ignore lint/suspicious/noExplicitAny: cborg token entries
      const reverse = (a: any, b: any) => (a[0].value < b[0].value ? 1 : -1);
      block[block.length - 1] = new Uint8Array(encode(value, { mapSorter: reverse }));
      return { log: frameLog(headerBytes, blocks) };
    },
    verdict: 'NOT_INTACT',
    findings: () => [{ code: 'CBOR_NONCANONICAL', severity: 'fail' }],
  },
  {
    id: '104',
    slug: 'decompression-bomb',
    title: 'Block whose raw_len lies (decompression bomb)',
    description:
      'A block declares raw_len = 200 but its deflate payload expands to 1 MiB. The parser stops at raw_len + 1 bytes and rejects the block without allocating more.',
    build() {
      const s = new Script({ id: '001-minimal' });
      s.startSession().endSession();
      const log = s.bytes();
      const firstBlock = readLog(log).records[0]!.blockOffset;
      const payload = deflateSync(new Uint8Array(1024 * 1024), { level: 9 });
      const rawLen = 200;
      const frame = new Uint8Array(13 + payload.length);
      const dv = new DataView(frame.buffer);
      dv.setUint32(0, payload.length);
      frame[4] = 1;
      dv.setUint32(5, rawLen);
      frame.set(payload, 9);
      dv.setUint32(9 + payload.length, crc32(frame.subarray(0, 9 + payload.length)));
      return { log: concatBytes(log.subarray(0, firstBlock), frame), facts: { blockOffset: firstBlock } };
    },
    verdict: 'NOT_INTACT',
    findings: (f) => [{ code: 'RAW_LEN_MISMATCH', severity: 'fail', offset: f.blockOffset! }],
  },
  {
    id: '105',
    slug: 'submission-mismatch',
    title: 'Submitted code differs by one character',
    description: 'The log of vector 002 is intact, but the submitted main.cpp returns 1 instead of 0.',
    build() {
      const { log } = buildTypedSingleFile();
      return {
        log,
        submission: [{ path: 'main.cpp', content: utf8(MAIN_CPP.replace('return 0', 'return 1')) }],
      };
    },
    verdict: 'NOT_INTACT',
    findings: () => [NO_ANCHORS, { code: 'SUBMISSION_MISMATCH', severity: 'fail' }],
  },
];

function anchorBody(ck: number, d: Uint8Array) {
  return {
    ck,
    d,
    type: 'rfc3161' as const,
    src: 'test://placeholder-tsa',
    tok: utf8('PLACEHOLDER-TOKEN-NOT-A-REAL-RFC3161-RESPONSE'),
    status: 'complete' as const,
  };
}
