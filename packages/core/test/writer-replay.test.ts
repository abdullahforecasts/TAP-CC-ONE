import { describe, expect, it } from 'vitest';
import {
  type AnyRecord,
  addToComposition,
  applyChange,
  bytesEqual,
  concatBytes,
  contentHash,
  emptyComposition,
  Flag,
  Kind,
  LogWriter,
  originFromFlags,
  Replayer,
  ReplayIndex,
  readLog,
  SpanList,
  scanForRecovery,
  stateDigest,
  TapError,
  toSequentialChanges,
  verifyLog,
} from '../src/index.js';
import { sessionStart, testKey, ZERO32 } from './support/raw.js';

const key = testKey();
const T = { t: 1_000, m: 0 };

function newWriter(options: { targetBlockSize?: number; compress?: boolean } = {}): LogWriter {
  const w = LogWriter.create({ created: 1, tool: 'test', label: 'w', logId: new Uint8Array(16), ...options });
  w.append('SESSION_START', sessionStart(key.publicKey), T);
  return w;
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof TapError ? e.code : `non-tap: ${(e as Error).message}`;
  }
}

function snap(f: number, path: string, text: string, origin = 'preexisting' as const) {
  return { f, path, origin, text, h: contentHash(text), eol: 'lf' as const, enc: 'utf8' };
}

describe('LogWriter', () => {
  it('writes a log that reads back with an intact chain', () => {
    const w = newWriter();
    w.append('FILE_SNAPSHOT', snap(0, 'a.txt', 'hello'), T);
    w.append('EDIT_BATCH', { f: 0, c: [[5, 5, 0, '!']] }, T);
    w.append('SAVE', { f: 0, h: contentHash('hello!'), n: 6 }, T);
    w.appendCheckpoint(key.secretKey, T);
    expect(w.seq).toBe(5);
    expect(w.hasPending).toBe(true);
    expect(w.pendingSize).toBeGreaterThan(0);
    const bytes = w.drain();
    expect(w.hasPending).toBe(false);
    expect(w.drain()).toEqual(new Uint8Array(0));
    expect(readLog(bytes).records).toHaveLength(5);
    expect(w.state.files.get(0)!.text).toBe('hello!');
    const report = verifyLog(bytes);
    expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
  });

  it('concatenated drains form one valid file, split into blocks by size', () => {
    const w = newWriter({ targetBlockSize: 64 });
    const first = w.drain();
    w.append('FILE_SNAPSHOT', snap(0, 'a.txt', ''), T);
    for (let i = 0; i < 20; i++) w.append('EDIT_BATCH', { f: 0, c: [[1, i, 0, 'x']] }, T);
    const second = w.drain();
    const parsed = readLog(concatBytes(first, second));
    expect(parsed.records).toHaveLength(22);
    expect(parsed.blockCount).toBeGreaterThan(5);
  });

  it('can write uncompressed blocks', () => {
    const w = newWriter({ compress: false });
    w.append('NOTE', { text: 'n'.repeat(500) }, T);
    const bytes = w.drain();
    expect(readLog(bytes).records).toHaveLength(2);
  });

  it('rejects invalid bodies, bad times and direct CHECKPOINT appends', () => {
    const w = newWriter();
    expect(code(() => w.append('FOCUS', { on: 'yes' } as never, T))).toBe('RECORD_INVALID');
    expect(code(() => w.append('FOCUS', { on: true }, { t: -1, m: 0 }))).toBe('RECORD_INVALID');
    expect(code(() => w.append('FOCUS', { on: true }, { t: 1, m: 0.5 }))).toBe('RECORD_INVALID');
    expect(code(() => w.append('CHECKPOINT', { state: ZERO32, files: 0, sig: new Uint8Array(64) }, T))).toBe(
      'WRITER_STATE',
    );
    expect(code(() => w.append('FILE_OP', { op: 'rename', f: 0, path: 'a', origin: 'editor' }, T))).toBe(
      'RECORD_INVALID',
    );
    expect(w.seq).toBe(1);
  });

  it('refuses records that would not replay, leaving state and chain unchanged', () => {
    const w = newWriter();
    w.append('FILE_SNAPSHOT', snap(0, 'a.txt', 'abc'), T);
    const head = w.headHash;
    // Second change is out of bounds: the whole batch must be refused atomically.
    expect(
      code(() =>
        w.append(
          'EDIT_BATCH',
          {
            f: 0,
            c: [
              [1, 3, 0, 'd'],
              [1, 10, 1, ''],
            ],
          },
          T,
        ),
      ),
    ).toBe('REPLAY_FAILED');
    expect(w.state.files.get(0)!.text).toBe('abc');
    expect(w.headHash).toEqual(head);
    expect(w.seq).toBe(2);
    expect(code(() => w.append('SAVE', { f: 0, h: ZERO32, n: 3 }, T))).toBe('REPLAY_FAILED');
    expect(code(() => w.append('EDIT_BATCH', { f: 9, c: [[1, 0, 0, 'x']] }, T))).toBe('REPLAY_FAILED');
  });

  it('checkpoints need an active session and its key', () => {
    const w = LogWriter.create({ created: 1, tool: 'test' });
    expect(code(() => w.appendCheckpoint(key.secretKey, T))).toBe('WRITER_STATE');
    w.append('SESSION_START', sessionStart(key.publicKey), T);
    expect(code(() => w.appendCheckpoint(testKey('other').secretKey, T))).toBe('KEY_MISMATCH');
    expect(w.appendCheckpoint(key.secretKey, T).s).toBe(1);
    expect(w.header.logId).toHaveLength(16);
  });

  it('refuses records larger than a block', () => {
    const w = newWriter();
    const big = 'x'.repeat(9 * 1024 * 1024);
    expect(code(() => w.append('FILE_SNAPSHOT', snap(0, 'big.txt', big), T))).toBe('RECORD_TOO_LARGE');
  });

  it('resumes an existing log and continues the chain', () => {
    const w = newWriter();
    w.append('FILE_SNAPSHOT', snap(0, 'a.txt', 'x'), T);
    const part1 = w.drain();
    const resumed = LogWriter.resume(part1);
    expect(resumed.seq).toBe(2);
    expect(resumed.state.files.get(0)!.text).toBe('x');
    resumed.append('EDIT_BATCH', { f: 0, c: [[1, 1, 0, 'y']] }, T);
    resumed.appendCheckpoint(key.secretKey, T);
    const full = concatBytes(part1, resumed.drain());
    expect(verifyLog(full).findings.filter((f) => f.severity === 'fail')).toEqual([]);
  });

  it('refuses to resume a log with a broken chain or bad replay', () => {
    const w = newWriter();
    w.append('NOTE', { text: 'a' }, T);
    const bytes = w.drain();
    const parsed = readLog(bytes);
    // Swap the two records' block contents by rebuilding a log where record 1 has a wrong p.
    const good = LogWriter.create({ created: 1, tool: 'test', logId: new Uint8Array(16), label: 'w' });
    good.append('SESSION_START', sessionStart(key.publicKey), T);
    const otherHeader = good.drain();
    // Same header, but records from a different writer (different p for record 1) → broken chain.
    const w2 = LogWriter.create({ created: 2, tool: 'test', logId: new Uint8Array(16), label: 'w' });
    w2.append('SESSION_START', sessionStart(key.publicKey), T);
    w2.append('NOTE', { text: 'a' }, T);
    const foreign = w2.drain();
    const foreignBlocks = foreign.subarray(readLog(foreign).records[0]!.blockOffset);
    const headerPart = otherHeader.subarray(0, readLog(otherHeader).records[0]!.blockOffset);
    expect(code(() => LogWriter.resume(concatBytes(headerPart, foreignBlocks)))).toBe('WRITER_STATE');
    expect(parsed.records).toHaveLength(2);
  });

  it('builds RECOVERY bodies from a scan', () => {
    const w = newWriter();
    const bytes = w.drain();
    const damaged = concatBytes(bytes, new Uint8Array([0, 0, 0, 9, 1]));
    const scan = scanForRecovery(damaged);
    const body = LogWriter.recoveryBody(scan);
    expect(body).toMatchObject({ lostBytes: 5, atOffset: bytes.length });
    const resumed = LogWriter.resume(damaged.subarray(0, scan.validLength));
    resumed.append('RECOVERY', body, T);
    expect(readLog(concatBytes(bytes, resumed.drain())).records).toHaveLength(2);
  });
});

describe('Replayer', () => {
  function rec(s: number, kind: keyof typeof Kind, b: unknown): AnyRecord {
    return { s, k: Kind[kind], t: 0, m: 0, p: ZERO32, b } as AnyRecord;
  }
  function codes(r: Replayer, record: AnyRecord): string[] {
    return r.apply(record).map((i) => `${i.severity}:${i.code}`);
  }

  it('applies snapshots, edits, saves and file operations', () => {
    const r = new Replayer({ provenance: true });
    expect(codes(r, rec(0, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'abc')))).toEqual([]);
    expect(codes(r, rec(1, 'EDIT_BATCH', { f: 0, c: [[1, 1, 1, 'XY']] }))).toEqual([]);
    expect(r.files.get(0)!.text).toBe('aXYc');
    expect(codes(r, rec(2, 'SAVE', { f: 0, h: contentHash('aXYc'), n: 4 }))).toEqual([]);
    expect(codes(r, rec(3, 'FILE_OP', { op: 'create', f: 1, path: 'b.txt', origin: 'external' }))).toEqual([
      'info:EXTERNAL_FILE_CREATED',
    ]);
    expect(
      codes(r, rec(4, 'FILE_OP', { op: 'rename', f: 1, path: 'b.txt', newPath: 'c.txt', origin: 'editor' })),
    ).toEqual([]);
    expect(r.fileByPath('c.txt')?.f).toBe(1);
    expect(codes(r, rec(5, 'FILE_OP', { op: 'delete', f: 1, path: 'c.txt', origin: 'editor' }))).toEqual([]);
    expect(r.liveFiles().map((f) => f.path)).toEqual(['a.txt']);
    expect(r.composition().chars).toBe(4);
    expect(r.composition(['nope']).chars).toBe(0);
    expect(r.lastSeq).toBe(5);
    expect(codes(r, rec(6, 'FOCUS', { on: true }))).toEqual([]);
  });

  it('reports every replay failure with a stable code', () => {
    const r = new Replayer();
    r.apply(rec(0, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'abc')));
    r.apply(rec(1, 'FILE_OP', { op: 'create', f: 5, path: 'gone.txt', origin: 'editor' }));
    r.apply(rec(2, 'FILE_OP', { op: 'delete', f: 5, path: 'gone.txt', origin: 'editor' }));
    const cases: Array<[AnyRecord, string]> = [
      [rec(9, 'EDIT_BATCH', { f: 1, c: [[1, 0, 0, 'x']] }), 'fail:UNKNOWN_FILE'],
      [rec(9, 'EDIT_BATCH', { f: 5, c: [[1, 0, 0, 'x']] }), 'fail:FILE_DELETED'],
      [rec(9, 'EDIT_BATCH', { f: 0, c: [[1, 2, 5, '']] }), 'fail:EDIT_OUT_OF_BOUNDS'],
      [rec(9, 'SAVE', { f: 0, h: ZERO32, n: 3 }), 'fail:SAVE_HASH_MISMATCH'],
      [rec(9, 'SAVE', { f: 0, h: contentHash('abc'), n: 4 }), 'fail:SAVE_LENGTH_MISMATCH'],
      [rec(9, 'FILE_OP', { op: 'create', f: 0, path: 'z', origin: 'editor' }), 'fail:FILE_ID_REUSED'],
      [rec(9, 'FILE_OP', { op: 'create', f: 5, path: 'z', origin: 'editor' }), 'fail:FILE_ID_REUSED'],
      [rec(9, 'FILE_OP', { op: 'create', f: 7, path: 'a.txt', origin: 'editor' }), 'fail:DUPLICATE_PATH'],
      [rec(9, 'FILE_OP', { op: 'delete', f: 0, path: 'wrong', origin: 'editor' }), 'fail:OP_PATH_MISMATCH'],
      [rec(9, 'FILE_OP', { op: 'delete', f: 3, path: 'x', origin: 'editor' }), 'fail:UNKNOWN_FILE'],
      [rec(9, 'FILE_SNAPSHOT', { ...snap(0, 'a.txt', 'abc'), h: ZERO32 }), 'fail:SNAPSHOT_HASH_MISMATCH'],
      [
        rec(9, 'FILE_SNAPSHOT', snap(0, 'other.txt', 'abc', 'resync' as never)),
        'fail:SNAPSHOT_PATH_MISMATCH',
      ],
      [rec(9, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'abc')), 'fail:SNAPSHOT_ORIGIN_INVALID'],
      [rec(9, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'zz', 'created' as never)), 'fail:SNAPSHOT_ORIGIN_INVALID'],
      [rec(9, 'FILE_SNAPSHOT', snap(8, 'n.txt', 'x', 'resync' as never)), 'fail:SNAPSHOT_ORIGIN_INVALID'],
      [rec(9, 'FILE_SNAPSHOT', snap(5, 'n.txt', 'x')), 'fail:FILE_ID_REUSED'],
      [rec(9, 'FILE_SNAPSHOT', snap(8, 'a.txt', 'x')), 'fail:DUPLICATE_PATH'],
      [rec(9, 'EXTERNAL_CHANGE', { f: 3, h: ZERO32 }), 'fail:UNKNOWN_FILE'],
    ];
    for (const [record, expected] of cases) {
      const before = r.snapshot();
      expect(codes(r, record), expected).toEqual([expected]);
      // Failures never change state.
      expect(r.snapshot().files).toEqual(before.files);
    }
  });

  it('handles snapshots of known files by origin, keeping provenance of unchanged regions', () => {
    const r = new Replayer({ provenance: true });
    r.apply(rec(0, 'FILE_OP', { op: 'create', f: 0, path: 'a.txt', origin: 'editor' }));
    r.apply(rec(1, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'start\n', 'created' as never)));
    r.apply(rec(2, 'EDIT_BATCH', { f: 0, c: [[1, 6, 0, 'typed line\n']] }));
    expect(
      codes(r, rec(3, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'start\ntyped line\n', 'periodic' as never))),
    ).toEqual([]);
    expect(
      codes(r, rec(4, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'start\ntyped LINE\n', 'periodic' as never))),
    ).toEqual(['warn:PERIODIC_SNAPSHOT_DIVERGED']);
    expect(
      codes(r, rec(5, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'start\ntyped LINE!\n', 'resync' as never))),
    ).toEqual(['warn:RESYNC']);
    expect(codes(r, rec(6, 'EXTERNAL_CHANGE', { f: 0, h: contentHash('x'), hint: 'vcs' }))).toEqual([
      'info:VCS_OPERATION',
    ]);
    expect(codes(r, rec(7, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'y', 'external' as never)))).toEqual([
      'fail:EXTERNAL_HASH_MISMATCH',
    ]);
    expect(codes(r, rec(8, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'x', 'external' as never)))).toEqual([
      'info:EXTERNAL_CHANGE',
    ]);
    expect(codes(r, rec(9, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'x\n', 'paused-gap' as never)))).toEqual([
      'warn:PAUSED_GAP_CHANGES',
    ]);
    expect(codes(r, rec(10, 'FILE_SNAPSHOT', snap(1, 'b.txt', 'b', 'external' as never)))).toEqual([
      'info:EXTERNAL_FILE',
    ]);
    expect(codes(r, rec(11, 'FILE_SNAPSHOT', snap(2, 'c.txt', 'c', 'paused-gap' as never)))).toEqual([
      'warn:PAUSED_GAP_CHANGES',
    ]);
    expect(codes(r, rec(12, 'FILE_SNAPSHOT', { ...snap(3, 'd.txt', 'a\r\nb'), eol: 'lf' }))).toEqual([
      'warn:SNAPSHOT_EOL_MISMATCH',
    ]);
    const spans = r.files.get(0)!.spans!.toArray();
    expect(spans.map((s) => s.origin)).toEqual(['external', 'paused-gap']);
  });

  it('keeps typed provenance outside a resynced region', () => {
    const r = new Replayer({ provenance: true });
    r.apply(rec(0, 'FILE_SNAPSHOT', snap(0, 'a.txt', '')));
    r.apply(rec(1, 'EDIT_BATCH', { f: 0, c: [[1, 0, 0, 'hello world']] }));
    r.apply(rec(2, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'hello WORLD', 'resync' as never)));
    const comp = r.composition();
    expect(comp.byOrigin.typed?.chars).toBe(6);
    expect(comp.byOrigin.resync?.chars).toBe(5);
  });

  it('warns about external changes never followed by a snapshot', () => {
    const r = new Replayer();
    r.apply(rec(0, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'a')));
    r.apply(rec(1, 'EXTERNAL_CHANGE', { f: 0, h: ZERO32 }));
    expect(r.finish().map((i) => i.code)).toEqual(['EXTERNAL_WITHOUT_SNAPSHOT']);
    r.apply(rec(2, 'FILE_OP', { op: 'delete', f: 0, path: 'a.txt', origin: 'editor' }));
    expect(r.finish()).toEqual([]);
  });

  it('round-trips snapshots and requires provenance for composition', () => {
    const r = new Replayer({ provenance: true });
    r.apply(rec(0, 'FILE_SNAPSHOT', snap(0, 'a.txt', 'abc')));
    r.apply(rec(1, 'FILE_OP', { op: 'create', f: 1, path: 'b', origin: 'editor' }));
    r.apply(rec(2, 'FILE_OP', { op: 'delete', f: 1, path: 'b', origin: 'editor' }));
    const copy = Replayer.fromSnapshot(r.snapshot(), { provenance: true });
    expect(copy.stateDigest()).toEqual(r.stateDigest());
    expect(copy.retired.has(1)).toBe(true);
    expect(copy.composition()).toEqual(r.composition());
    const plain = Replayer.fromSnapshot(new Replayer().snapshot(), { provenance: true });
    expect(plain.files.size).toBe(0);
    const noSpans = Replayer.fromSnapshot(
      { seq: 0, files: [{ f: 0, path: 'x', text: 'ab' }], retired: [] },
      {
        provenance: true,
      },
    );
    expect(noSpans.composition().byOrigin.resync?.chars).toBe(2);
    expect(() => new Replayer().composition()).toThrow(/provenance/);
  });

  it('refuses too many files', () => {
    const r = new Replayer();
    for (let i = 0; i < 50_000; i++) r.files.set(i, { f: i, path: `f${i}`, text: '' });
    expect(codes(r, rec(0, 'FILE_SNAPSHOT', snap(60_000, 'new.txt', '')))).toEqual(['fail:TOO_MANY_FILES']);
  });
});

describe('state digest', () => {
  it('is independent of insertion order and sensitive to content, path and id', () => {
    const a = stateDigest([
      { f: 0, path: 'b', text: 'x' },
      { f: 1, path: 'a', text: 'y' },
    ]);
    const b = stateDigest([
      { f: 1, path: 'a', text: 'y' },
      { f: 0, path: 'b', text: 'x' },
    ]);
    expect(bytesEqual(a, b)).toBe(true);
    expect(
      bytesEqual(
        a,
        stateDigest([
          { f: 0, path: 'b', text: 'x' },
          { f: 1, path: 'a', text: 'z' },
        ]),
      ),
    ).toBe(false);
    expect(
      bytesEqual(
        a,
        stateDigest([
          { f: 0, path: 'b', text: 'x' },
          { f: 2, path: 'a', text: 'y' },
        ]),
      ),
    ).toBe(false);
    expect(
      bytesEqual(
        a,
        stateDigest([
          { f: 0, path: 'c', text: 'x' },
          { f: 1, path: 'a', text: 'y' },
        ]),
      ),
    ).toBe(false);
    // CRLF vs LF does not change the digest (comparison normalisation).
    expect(
      bytesEqual(
        stateDigest([{ f: 0, path: 'a', text: 'x\r\n' }]),
        stateDigest([{ f: 0, path: 'a', text: 'x\n' }]),
      ),
    ).toBe(true);
  });
});

describe('ReplayIndex', () => {
  it('seeks to any record with the same result as a full replay', () => {
    const w = newWriter();
    w.append('FILE_SNAPSHOT', snap(0, 'a.txt', ''), T);
    let text = '';
    for (let i = 0; i < 300; i++) {
      w.append('EDIT_BATCH', { f: 0, c: [[1, text.length, 0, String(i % 10)]] }, T);
      text += String(i % 10);
      if (i % 50 === 0) w.appendCheckpoint(key.secretKey, T);
    }
    const records = readLog(w.drain()).records.map((r) => r.record);
    const index = new ReplayIndex(records, 40);
    expect(index.cachedPoints).toBeGreaterThan(8);
    for (const seq of [0, 1, 2, 37, 41, 120, 200, records.length - 1, records.length + 5]) {
      const direct = new Replayer();
      for (const r of records.slice(0, seq + 1)) direct.apply(r);
      expect(index.stateAt(seq).stateDigest(), `seq ${seq}`).toEqual(direct.stateDigest());
    }
    expect(index.stateAt(-1).files.size).toBe(0);
  });
});

describe('provenance', () => {
  it('derives origin from flags with documented precedence', () => {
    expect(originFromFlags(0, false)).toBe('typed');
    expect(originFromFlags(Flag.MULTI_CURSOR, false)).toBe('typed');
    expect(originFromFlags(Flag.BULK, false)).toBe('bulk');
    expect(originFromFlags(Flag.PASTE, false)).toBe('paste');
    expect(originFromFlags(Flag.PASTE, true)).toBe('internal-copy');
    expect(originFromFlags(Flag.PASTE | Flag.FORMAT_ON_SAVE, false)).toBe('format');
    expect(originFromFlags(Flag.UNDO | Flag.PASTE, false)).toBe('undo-redo');
    expect(originFromFlags(Flag.REDO, false)).toBe('undo-redo');
  });

  it('SpanList inserts, removes and merges', () => {
    const s = SpanList.of(5, 'typed', 1);
    s.insert(5, 3, 'typed', 2);
    expect(s.toArray()).toEqual([{ len: 8, origin: 'typed', seq: 1 }]);
    s.insert(2, 2, 'paste', 3);
    expect(s.toArray().map((x) => [x.len, x.origin])).toEqual([
      [2, 'typed'],
      [2, 'paste'],
      [6, 'typed'],
    ]);
    s.remove(2, 2);
    expect(s.toArray()).toEqual([{ len: 8, origin: 'typed', seq: 1 }]);
    s.remove(0, 8);
    expect(s.length).toBe(0);
    s.insert(0, 0, 'bulk', 1);
    s.remove(0, 0);
    expect(s.toArray()).toEqual([]);
    expect(() => s.insert(1, 1, 'typed', 1)).toThrow(RangeError);
    expect(() => s.remove(0, 1)).toThrow(RangeError);
    expect(SpanList.of(0, 'typed', 0).length).toBe(0);
  });

  it('composition counts characters and non-whitespace per origin', () => {
    const spans = SpanList.of(4, 'typed', 0);
    spans.insert(4, 3, 'paste', 1);
    const total = emptyComposition();
    addToComposition(total, 'ab  c d', spans);
    expect(total).toEqual({
      chars: 7,
      nonWs: 4,
      byOrigin: { typed: { chars: 4, nonWs: 2 }, paste: { chars: 3, nonWs: 2 } },
    });
    expect(() => addToComposition(total, 'abc', spans)).toThrow(RangeError);
  });
});

describe('changes', () => {
  it('orders simultaneous changes for sequential application', () => {
    const changes = [
      { rangeOffset: 0, rangeLength: 0, text: 'A' },
      { rangeOffset: 4, rangeLength: 2, text: 'B' },
      { rangeOffset: 2, rangeLength: 0, text: 'C' },
    ];
    const seq = toSequentialChanges(changes);
    expect(seq.map((c) => c.text)).toEqual(['B', 'C', 'A']);
    let text = 'xxxxxx';
    for (const c of seq) text = applyChange(text, c.rangeOffset, c.rangeLength, c.text);
    expect(text).toBe('AxxCxxB');
  });

  it('rejects overlapping ranges and out-of-bounds application', () => {
    expect(
      code(() =>
        toSequentialChanges([
          { rangeOffset: 0, rangeLength: 3, text: '' },
          { rangeOffset: 2, rangeLength: 1, text: '' },
        ]),
      ),
    ).toBe('OVERLAPPING_CHANGES');
    expect(
      code(() =>
        toSequentialChanges([
          { rangeOffset: 1, rangeLength: 1, text: 'a' },
          { rangeOffset: 1, rangeLength: 2, text: 'b' },
        ]),
      ),
    ).toBe('OVERLAPPING_CHANGES');
    expect(() => applyChange('ab', 1, 5, '')).toThrow(RangeError);
    expect(() => applyChange('ab', -1, 0, '')).toThrow(RangeError);
  });
});

describe('Replayer edit events', () => {
  it('reports snapshots as region replacements and names the source of internal copies', () => {
    const w = newWriter();
    w.append('FILE_SNAPSHOT', snap(0, 'util.c', 'int helper(void);\n'), T);
    w.append('FILE_OP', { op: 'create', f: 1, path: 'main.c', origin: 'editor' }, T);
    w.append('EDIT_BATCH', { f: 1, c: [[0, 0, 0, 'int helper(void);\n', Flag.PASTE]] }, T);
    w.append('EDIT_BATCH', { f: 1, c: [[0, 18, 0, 'x', Flag.PASTE]] }, T);
    w.append('EXTERNAL_CHANGE', { f: 1, h: contentHash('// top\nint helper(void);\nx') }, T);
    w.append(
      'FILE_SNAPSHOT',
      { ...snap(1, 'main.c', '// top\nint helper(void);\nx'), origin: 'external' as const },
      T,
    );
    const events: Array<Record<string, unknown>> = [];
    const r = new Replayer({ onEdit: (e) => events.push({ ...e }) });
    for (const e of readLog(w.drain()).records) r.apply(e.record);
    expect(events).toEqual([
      { f: 0, seq: 1, off: 0, del: 0, ins: 'int helper(void);\n', origin: 'preexisting', flags: 0 },
      {
        f: 1,
        seq: 3,
        off: 0,
        del: 0,
        ins: 'int helper(void);\n',
        origin: 'internal-copy',
        flags: Flag.PASTE,
        copiedFrom: 'util.c',
      },
      { f: 1, seq: 4, off: 18, del: 0, ins: 'x', origin: 'paste', flags: Flag.PASTE },
      { f: 1, seq: 6, off: 0, del: 0, ins: '// top\n', origin: 'external', flags: 0 },
    ]);
  });
});

describe('provenance of replacements, undo and redo (spec §7.1)', () => {
  function spansOf(records: AnyRecord[], f = 0) {
    const r = new Replayer({ provenance: true });
    for (const rec of records) r.apply(rec);
    return r.files
      .get(f)!
      .spans!.toArray()
      .map((s) => [s.origin, s.len]);
  }
  function recordsOf(build: (w: LogWriter) => void): AnyRecord[] {
    const w = newWriter();
    build(w);
    return readLog(w.drain()).records.map((x) => x.record);
  }
  const typed = 'int main() {\n    return 0;\n}\n';

  it('a tool rewriting the whole file only re-attributes the line it added', () => {
    const withLine = 'int main() {\n    cout << 1;\n    return 0;\n}\n';
    const records = recordsOf((w) => {
      w.append('FILE_SNAPSHOT', snap(0, 'a.cpp', '', 'created' as never), T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 0, 0, typed]] }, T);
      // Copilot-style apply: the whole document replaced by the old text plus one line.
      w.append('EDIT_BATCH', { f: 0, c: [[0, 0, typed.length, withLine, Flag.BULK]] }, T);
    });
    // Only the new line (aligned after the shared indentation) is the tool's.
    expect(spansOf(records)).toEqual([
      ['typed', 17],
      ['bulk', 15],
      ['typed', withLine.length - 32],
    ]);
  });

  it('undo brings removed text back with the origin it had', () => {
    const records = recordsOf((w) => {
      w.append('FILE_SNAPSHOT', snap(0, 'a.cpp', '', 'created' as never), T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 0, 0, typed]] }, T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 13, 14, '']] }, T); // delete the return line
      w.append('EDIT_BATCH', { f: 0, c: [[0, 13, 0, '    return 0;\n', Flag.UNDO]] }, T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 0, 0, '// x\n', Flag.UNDO]] }, T); // never removed
    });
    expect(spansOf(records)).toEqual([
      ['undo-redo', 5],
      ['typed', typed.length],
    ]);
  });

  it('a replay resumed from a snapshot attributes undo the same way', () => {
    const records = recordsOf((w) => {
      w.append('FILE_SNAPSHOT', snap(0, 'a.cpp', '', 'created' as never), T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 0, 0, typed]] }, T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 13, 14, '']] }, T);
      w.append('EDIT_BATCH', { f: 0, c: [[0, 13, 0, '    return 0;\n', Flag.UNDO]] }, T);
    });
    const full = new Replayer({ provenance: true });
    const half = new Replayer({ provenance: true });
    records.forEach((r, i) => {
      full.apply(r);
      if (i < records.length - 1) half.apply(r);
    });
    const resumed = Replayer.fromSnapshot(half.snapshot(), { provenance: true });
    resumed.apply(records.at(-1)!);
    expect(resumed.files.get(0)!.spans!.toArray()).toEqual(full.files.get(0)!.spans!.toArray());
  });
});
