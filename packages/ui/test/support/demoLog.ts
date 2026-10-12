/**
 * A realistic two-session log for tests and for the end-to-end test page: typing with timing,
 * pastes (from outside and from another file), saves, runs, an external change, a pause, a
 * note, focus changes, a rename and a deletion.
 */
import {
  type ChangeTuple,
  contentHash,
  Flag,
  type KeyPair,
  keyPairFromSeed,
  LogWriter,
  sha256,
  utf8,
} from '@tap/core';

export const DEMO_START = Date.UTC(2026, 9, 27, 9, 0, 0);

export interface DemoLog {
  bytes: Uint8Array;
  /** Final text of every live file. */
  files: Record<string, string>;
  key: KeyPair;
}

/** Builds the demo log. `scale` repeats the typing work (for size/speed tests). */
export function demoLog(scale = 1): DemoLog {
  const key = keyPairFromSeed(sha256(utf8('ui-demo')));
  const w = LogWriter.create({
    created: DEMO_START,
    tool: 'tap-ui-test',
    label: 'two-sum',
    logId: sha256(utf8('demo')).slice(0, 16),
  });
  let t = DEMO_START;
  let m = 0;
  const at = (ms = 0) => {
    t += ms;
    m += ms;
    return { t, m };
  };
  const texts = new Map<number, string>();
  const paths = new Map<number, string>();

  const session = (index: number) =>
    w.append(
      'SESSION_START',
      {
        sid: sha256(utf8(`sid-${index}`)).slice(0, 16),
        pub: key.publicKey,
        vsc: '1.105.0',
        app: 'vscode',
        os: 'linux',
        ext: '0.2.0',
        aiExt: index === 2 ? ['GitHub.copilot'] : [],
        liveShare: false,
        cfgHash: new Uint8Array(32),
        settings: { 'tap.record.focus': true, 'tap.classify.bulkMinChars': 40 },
      },
      at(),
    );
  const snapshot = (
    f: number,
    path: string,
    text: string,
    origin: 'preexisting' | 'external' | 'created',
  ) => {
    w.append(
      'FILE_SNAPSHOT',
      { f, path, origin, text, h: contentHash(text), eol: 'lf', enc: 'utf8' },
      at(origin === 'preexisting' ? 0 : 500),
    );
    texts.set(f, text);
    paths.set(f, path);
  };
  /** Types `text` at `off` one character at a time, `ms` apart, in batches of up to 40. */
  const type = (f: number, off: number, text: string, ms = 180) => {
    let batch: ChangeTuple[] = [];
    let pos = off;
    for (const ch of text) {
      batch.push([ms, pos, 0, ch]);
      pos += ch.length;
      if (batch.length === 40) {
        flush(f, batch, ms);
        batch = [];
      }
    }
    if (batch.length) flush(f, batch, ms);
  };
  const flush = (f: number, batch: ChangeTuple[], ms: number) => {
    let text = texts.get(f)!;
    for (const [, off, del, ins] of batch) text = text.slice(0, off) + ins + text.slice(off + del);
    texts.set(f, text);
    w.append('EDIT_BATCH', { f, c: batch }, at(ms * batch.length));
  };
  const change = (f: number, off: number, del: number, ins: string, flags = 0, ms = 400) => {
    flush(f, [flags ? [ms, off, del, ins, flags] : [ms, off, del, ins]], ms);
  };
  const save = (f: number) => {
    const text = texts.get(f)!;
    w.append('SAVE', { f, h: contentHash(text), n: text.length }, at(300));
  };
  const run = (rid: number, name: string, exit: number) => {
    w.append('RUN_START', { rid, kind: 'task', name }, at(500));
    w.append('RUN_END', { rid, exit }, at(2000));
  };

  // ---- Session 1 ------------------------------------------------------------------------------
  session(1);
  snapshot(0, 'util.py', 'def read_ints():\n    return list(map(int, input().split()))\n', 'preexisting');
  snapshot(1, 'main.py', '', 'preexisting');
  w.appendCheckpoint(key.secretKey, at(10));

  for (let i = 0; i < scale; i++) {
    const body =
      i === 0
        ? 'def two_sum(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n        if target - x in seen:\n            return [seen[target - x], i]\n        seen[x] = i\n'
        : `\n# pass ${i}\ndef helper_${i}(values):\n    total = 0\n    for v in values:\n        total += v\n    return total\n`;
    type(1, texts.get(1)!.length, body);
  }
  save(1);
  run(1, 'run main.py', 1);
  // A typo fixed after the failed run.
  const text1 = texts.get(1)!;
  const fixAt = text1.indexOf('return [seen');
  change(1, fixAt, 0, '# found\n            ', 0, 2000);
  // Paste from another file in the workspace, then from outside.
  change(1, 0, 0, 'def read_ints():\n    return list(map(int, input().split()))\n', Flag.PASTE, 3000);
  change(
    1,
    texts.get(1)!.length,
    0,
    '\nif __name__ == "__main__":\n    print(two_sum(read_ints(), 9))\n',
    Flag.PASTE,
    4000,
  );
  save(1);
  run(2, 'run main.py', 0);
  save(1); // saved again without changes: folded into the previous entry
  w.append('FOCUS', { on: false }, at(60_000));
  w.append('FOCUS', { on: true }, at(30_000));
  w.append('NOTE', { text: 'read_ints copied from my own util.py' }, at(1000));
  w.append('PAUSE', { why: 'lunch' }, at(1000));
  w.append('RESUME', {}, at(20 * 60_000));
  // Another program rewrites util.py while the editor has it closed.
  const util2 = 'def read_ints():\n    return [int(x) for x in input().split()]\n';
  w.append('EXTERNAL_CHANGE', { f: 0, h: contentHash(util2) }, at(2000));
  w.append(
    'FILE_SNAPSHOT',
    { f: 0, path: 'util.py', origin: 'external', text: util2, h: contentHash(util2), eol: 'lf', enc: 'utf8' },
    at(),
  );
  texts.set(0, util2);
  w.appendCheckpoint(key.secretKey, at(10));
  w.append('SESSION_END', { sid: sha256(utf8('sid-1')).slice(0, 16), reason: 'close' }, at(1000));

  // ---- Session 2 (next day) -------------------------------------------------------------------
  at(24 * 3600_000);
  session(2);
  w.appendCheckpoint(key.secretKey, at(10));
  w.append('FILE_OP', { op: 'create', f: 2, path: 'notes.txt', origin: 'editor' }, at(1000));
  texts.set(2, '');
  paths.set(2, 'notes.txt');
  type(2, 0, 'todo: tests\n');
  save(2);
  change(
    1,
    texts.get(1)!.length,
    0,
    '    # a completion inserted by a tool\n    return None\n',
    Flag.BULK,
    1500,
  );
  save(1);
  w.append(
    'FILE_OP',
    { op: 'rename', f: 2, path: 'notes.txt', newPath: 'TODO.txt', origin: 'editor' },
    at(1000),
  );
  paths.set(2, 'TODO.txt');
  w.append('FILE_OP', { op: 'delete', f: 0, path: 'util.py', origin: 'editor' }, at(1000));
  texts.delete(0);
  w.appendCheckpoint(key.secretKey, at(10));
  w.append('SESSION_END', { sid: sha256(utf8('sid-2')).slice(0, 16), reason: 'close' }, at(1000));

  const files: Record<string, string> = {};
  for (const [f, text] of texts) files[paths.get(f)!] = text;
  return { bytes: w.drain(), files, key };
}
