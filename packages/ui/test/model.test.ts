import {
  type ChangeTuple,
  contentHash,
  Flag,
  Kind,
  keyPairFromSeed,
  LogWriter,
  readLog,
  sha256,
  toHex,
  utf8,
  verifyLog,
} from '@tap/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  diffLines,
  diffStats,
  diffTexts,
  frameAt,
  indexAfterSeq,
  intervalStats,
  KEYFRAME_EVERY,
  LogLoader,
  type LogModel,
  splitLines,
  weakenings,
} from '../src/model/index.js';
import { DEMO_START, demoLog } from './support/demoLog.js';

const RUNS = Number(process.env.TAP_PROPERTY_RUNS ?? 100);

function load(bytes: Uint8Array): LogModel {
  const loader = new LogLoader();
  loader.reset(bytes);
  return loader.model();
}

/** Length of a longest common subsequence (reference for diff minimality). */
function lcs(a: readonly string[], b: readonly string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

describe('line diff', () => {
  it('splits lines with any line ending and no phantom last line', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('is minimal and rebuilds both texts', () => {
    const line = fc.constantFrom('a', 'b', 'c', '', '  x');
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), fc.array(line, { maxLength: 30 }), (a, b) => {
        const { ops } = diffLines(a, b);
        const oldOut: string[] = [];
        const newOut: string[] = [];
        let i = 0;
        let j = 0;
        let equal = 0;
        for (const op of ops) {
          if (op === 'equal') {
            expect(a[i]).toBe(b[j]);
            oldOut.push(a[i++]!);
            newOut.push(b[j++]!);
            equal++;
          } else if (op === 'remove') oldOut.push(a[i++]!);
          else newOut.push(b[j++]!);
        }
        expect(oldOut).toEqual(a);
        expect(newOut).toEqual(b);
        expect(equal).toBe(lcs(a, b));
      }),
      { numRuns: RUNS * 3 },
    );
  });

  it('groups changes into hunks with context and line numbers', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const lines = old.split('\n');
    lines[2] = 'changed 3';
    lines.splice(15, 0, 'inserted');
    const result = diffTexts(old, lines.join('\n'));
    expect(result).toMatchObject({ added: 2, removed: 1, approximate: false });
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, oldLines: 6, newLines: 6 });
    expect(result.hunks[1]!.lines.map((l) => l.op)).toEqual([
      'equal',
      'equal',
      'equal',
      'add',
      'equal',
      'equal',
      'equal',
    ]);
    expect(result.hunks[1]).toMatchObject({ oldStart: 13, newStart: 13 });
    expect(diffStats('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
    expect(diffTexts('', 'x\ny').hunks[0]!.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });
});

describe('log model of a realistic session', () => {
  const demo = demoLog();
  const model = load(demo.bytes);
  const records = readLog(demo.bytes).records.map((r) => r.record);

  it('lists saves per file with diffs, runs and how the code arrived', () => {
    const summary = model.history.map((h) => ({
      kind: h.kind,
      path: h.path,
      number: h.number,
      repeats: h.repeats,
      added: h.added,
      removed: h.removed,
      runs: h.runs.map((r) => r.exit),
    }));
    expect(summary).toEqual([
      { kind: 'save', path: 'main.py', number: 1, repeats: 0, added: 6, removed: 0, runs: [1] },
      { kind: 'save', path: 'main.py', number: 2, repeats: 1, added: 6, removed: 0, runs: [0] },
      { kind: 'save', path: 'notes.txt', number: 1, repeats: 0, added: 1, removed: 0, runs: [] },
      { kind: 'save', path: 'main.py', number: 3, repeats: 0, added: 2, removed: 0, runs: [] },
    ]);
    const first = model.history[0]!.since!;
    expect(first.byOrigin).toEqual({ typed: first.insertedChars - countWs(first) });
    expect(first.edits).toBe(first.insertedChars);
    // 180 ms between keystrokes, so active time is the typing time.
    expect(first.activeMs).toBe((first.edits - 1) * 180);
    const second = model.history[1]!.since!;
    expect(second.pastes).toEqual([
      expect.objectContaining({ origin: 'internal-copy', copiedFrom: 'util.py', lines: 3 }),
      expect.objectContaining({ origin: 'paste', lines: 4 }),
    ]);
    expect(model.history[3]!.since!.byOrigin.bulk).toBeGreaterThan(0);
  });

  it('replays every save interval to exactly the saved content', () => {
    for (const entry of model.history.filter((h) => h.kind === 'save')) {
      const track = model.tracks.find((tr) => tr.f === entry.f)!;
      const save = records.find((r) => r.s === entry.seq)!;
      expect(save.k).toBe(Kind.SAVE);
      const frame = frameAt(track, entry.toIndex!);
      expect(save.k === Kind.SAVE && toHex(save.b.h)).toBe(toHex(contentHash(frame.text)));
      expect(indexAfterSeq(track, entry.seq)).toBe(entry.toIndex);
    }
  });

  it('collects events, sessions, ranges and file history', () => {
    const cats = new Set(model.events.map((e) => e.category));
    expect([...cats].sort()).toEqual(
      ['external', 'file', 'note', 'paste', 'pause', 'run', 'session', 'bulk'].sort(),
    );
    expect(model.events.find((e) => e.category === 'external')?.label).toBe(
      'util.py changed outside the editor',
    );
    expect(model.events.filter((e) => e.category === 'run').map((e) => e.detail)).toEqual([
      'exit code 1',
      'exit code 0',
    ]);
    expect(model.sessions.map((s) => s.aiExt)).toEqual([[], ['GitHub.copilot']]);
    expect(model.timeline.pauses).toHaveLength(1);
    expect(model.timeline.pauses[0]!.to - model.timeline.pauses[0]!.from).toBe(20 * 60_000);
    expect(model.timeline.unfocused).toHaveLength(1);
    expect(model.timeline.sessions).toHaveLength(2);
    expect(model.timeline.start).toBe(DEMO_START);
    expect(model.files.map((f) => [f.path, f.paths, f.deleted])).toEqual([
      ['TODO.txt', ['notes.txt', 'TODO.txt'], false],
      ['main.py', ['main.py'], false],
      ['util.py', ['util.py'], true],
    ]);
    expect(model.header).toMatchObject({ tool: 'tap-ui-test', label: 'two-sum' });
    expect(model.weakenings).toEqual([]);
  });

  it('computes the same composition as the verifier, per file and in total', () => {
    const report = verifyLog(demo.bytes);
    expect(model.composition).toEqual(report.composition);
    const live = model.files.filter((f) => !f.deleted);
    expect(live.reduce((n, f) => n + f.composition!.chars, 0)).toBe(model.composition.chars);
    const main = model.files.find((f) => f.path === 'main.py')!;
    expect(main.composition!.chars).toBe(demo.files['main.py']!.length);
  });

  it('keyframes give the same text as replaying from the start', () => {
    const big = load(demoLog(30).bytes);
    const track = big.tracks.find((t) => t.path === 'main.py')!;
    expect(track.keyframes.length).toBeGreaterThan(3);
    let text = '';
    for (let i = 0; i <= track.events.length; i++) {
      if (i % 97 === 0 || i === track.events.length || i % KEYFRAME_EVERY < 2) {
        expect(frameAt(track, i).text).toBe(text);
      }
      const e = track.events[i];
      if (e) text = text.slice(0, e.off) + e.ins + text.slice(e.off + e.del);
    }
  });
});

describe('log model of random logs', () => {
  const key = keyPairFromSeed(sha256(utf8('ui-random')));

  function randomLog(ops: Array<{ kind: number; pos: number; text: string }>) {
    const w = LogWriter.create({ created: 1, tool: 't', logId: new Uint8Array(16), targetBlockSize: 200 });
    let t = 1_000;
    const T = () => {
      t += 700;
      return { t, m: t };
    };
    w.append(
      'SESSION_START',
      {
        sid: new Uint8Array(16),
        pub: key.publicKey,
        vsc: '1',
        app: 'vscode',
        os: 'linux',
        ext: '0',
        aiExt: [],
        liveShare: false,
        cfgHash: new Uint8Array(32),
      },
      T(),
    );
    const text = ['a\nb\n', ''];
    w.append(
      'FILE_SNAPSHOT',
      {
        f: 0,
        path: 'a.c',
        origin: 'preexisting',
        text: text[0]!,
        h: contentHash(text[0]!),
        eol: 'lf',
        enc: 'utf8',
      },
      T(),
    );
    w.append('FILE_OP', { op: 'create', f: 1, path: 'b.c', origin: 'editor' }, T());
    for (const op of ops) {
      const f = op.pos % 2;
      const cur = text[f]!;
      // Positions on code-point boundaries: an editor never splits a surrogate pair.
      const bounds = [0];
      for (const ch of cur) bounds.push(bounds.at(-1)! + ch.length);
      const bi = op.pos % bounds.length;
      const at = bounds[bi]!;
      if (op.kind < 6) {
        const del = op.kind === 5 ? bounds[Math.min(bi + 2, bounds.length - 1)]! - at : 0;
        const c: ChangeTuple = op.kind === 4 ? [100, at, del, op.text, Flag.PASTE] : [100, at, del, op.text];
        text[f] = cur.slice(0, at) + op.text + cur.slice(at + del);
        if (del > 0 || op.text) w.append('EDIT_BATCH', { f, c: [c] }, T());
      } else if (op.kind < 8) {
        w.append('SAVE', { f, h: contentHash(cur), n: cur.length }, T());
      } else if (op.kind === 8) {
        const next = `${op.text}\n${cur}`;
        w.append('EXTERNAL_CHANGE', { f, h: contentHash(next) }, T());
        w.append(
          'FILE_SNAPSHOT',
          {
            f,
            path: f ? 'b.c' : 'a.c',
            origin: 'external',
            text: next,
            h: contentHash(next),
            eol: 'lf',
            enc: 'utf8',
          },
          T(),
        );
        text[f] = next;
      } else {
        w.appendCheckpoint(key.secretKey, T());
      }
    }
    return { bytes: w.drain(), text };
  }

  const op = fc.record({
    kind: fc.nat({ max: 9 }),
    pos: fc.nat(),
    text: fc.constantFrom('x', 'yz', '\n', 'foo()\n', '😀', ''),
  });

  it('replays every save to its content, and incremental loading equals loading at once', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), fc.array(fc.nat(), { maxLength: 4 }), (ops, cuts) => {
        const { bytes, text } = randomLog(ops);
        const model = load(bytes);
        const records = readLog(bytes).records.map((r) => r.record);
        for (const entry of model.history) {
          const save = records.find((r) => r.s === entry.seq)!;
          if (save.k !== Kind.SAVE) continue;
          const track = model.tracks.find((tr) => tr.f === save.b.f)!;
          expect(toHex(contentHash(frameAt(track, entry.toIndex!).text))).toBe(toHex(save.b.h));
        }
        for (const track of model.tracks) {
          expect(frameAt(track, track.events.length).text).toBe(text[track.f]);
        }
        // Feed the same bytes in arbitrary chunks, as live refresh does.
        const loader = new LogLoader();
        const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
        let prev = 0;
        loader.reset(new Uint8Array(0));
        for (const p of [...points, bytes.length]) {
          loader.append(bytes.slice(prev, p));
          prev = p;
        }
        expect(JSON.stringify(loader.model())).toBe(JSON.stringify(model));
      }),
      { numRuns: RUNS },
    );
  });

  it('reports a damaged log and keeps what it could read', () => {
    const { bytes } = randomLog([
      { kind: 0, pos: 0, text: 'x' },
      { kind: 6, pos: 0, text: '' },
    ]);
    const damaged = bytes.slice();
    damaged[damaged.length - 6]! ^= 0xff;
    const model = load(damaged);
    expect(model.problem).toMatch(/checksum/);
    expect(load(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])).problem).toMatch(/not a .codelog/);
  });
});

describe('helpers', () => {
  it('counts active time with gaps up to five minutes', () => {
    const ev = (t: number) => ({ seq: 1, t, off: 0, del: 0, ins: 'x', origin: 'typed' as const });
    const stats = intervalStats([ev(0), ev(1000), ev(302_000), ev(303_000)], 0, 4, 400_000);
    expect(stats.activeMs).toBe(2000);
    expect(stats.durationMs).toBe(400_000);
  });

  it('lists settings that weaken the evidence', () => {
    const base = {
      index: 1,
      seq: 0,
      t: 0,
      app: 'vscode',
      vsc: '1',
      os: 'linux',
      ext: '0',
      aiExt: [],
      key: 'k',
    };
    expect(weakenings(undefined)).toEqual([]);
    const list = weakenings({
      ...base,
      liveShare: true,
      settings: {
        'tap.record.focus': false,
        'tap.classify.clipboardCheckMinChars': 50,
        'tap.classify.bulkMinChars': 400,
      },
    });
    expect(list.map((w) => w.setting)).toEqual([
      'tap.record.focus',
      'tap.classify.clipboardCheckMinChars',
      'tap.classify.bulkMinChars',
      'Live Share',
    ]);
  });
});

function countWs(stats: { insertedChars: number; byOrigin: Record<string, number | undefined> }): number {
  const nonWs = Object.values(stats.byOrigin).reduce<number>((n, v) => n + (v ?? 0), 0);
  return stats.insertedChars - nonWs;
}

describe('runs cut off by the end of a session', () => {
  it('shows a run that never reported a result as cut off, not running', () => {
    const key = keyPairFromSeed(sha256(utf8('cut-off')));
    const w = LogWriter.create({
      created: DEMO_START,
      tool: 'tap-ui-test',
      logId: sha256(utf8('cut')).slice(0, 16),
    });
    let t = DEMO_START;
    const at = (ms: number) => {
      t += ms;
      return { t, m: t - DEMO_START };
    };
    const session = (i: number) =>
      w.append(
        'SESSION_START',
        {
          sid: sha256(utf8(`s${i}`)).slice(0, 16),
          pub: key.publicKey,
          vsc: '1.105.0',
          app: 'vscode',
          os: 'linux',
          ext: '0.2.0',
          aiExt: [],
          liveShare: false,
          cfgHash: new Uint8Array(32),
          settings: {},
        },
        at(1000),
      );
    session(1);
    w.append('RUN_START', { rid: 1, kind: 'task', name: 'build' }, at(1000));
    const lastOfFirst = t;
    // The laptop dies: no RUN_END, no SESSION_END. Next day the recorder repairs the log and
    // starts a new session, which reuses run id 1.
    w.append('RECOVERY', { lostBytes: 7, quarantineHash: new Uint8Array(32), atOffset: 100 }, at(86_400_000));
    session(2);
    w.append('RUN_START', { rid: 1, kind: 'task', name: 'build' }, at(1000));
    w.append('RUN_END', { rid: 1, exit: 0 }, at(1000));
    const model = load(w.drain());
    const runs = model.history.flatMap((h) => h.runs);
    expect(runs.map((r) => [r.cutOff ?? false, r.exit])).toEqual([
      [true, undefined],
      [false, 0],
    ]);
    // The first session lasted until its last record, not until the recovery a day later.
    expect(model.sessions[0]!.lastT).toBe(lastOfFirst);
    expect(model.timeline.sessions[0]!.to).toBe(lastOfFirst);
    expect(model.sessions[1]!.lastT).toBe(t);
    expect(model.events.filter((e) => e.category === 'run').map((e) => e.detail)).toEqual([
      'no result: the session ended before it finished',
      'exit code 0',
    ]);
  });
});
