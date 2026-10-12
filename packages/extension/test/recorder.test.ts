import { Flag, Kind, LogWriter, readLog, scanForRecovery, toWellFormed, verifyLog } from '@tap/core';
import { describe, expect, it } from 'vitest';
import { classifyEvent, isPasteOf, resolvePaste } from '../src/recorder/classify.js';
import { detectAiExtensions, normaliseAppName } from '../src/recorder/environment.js';
import { diffRegion } from '../src/recorder/recorder.js';
import { issues, loggedText, Sim, SimHost, testKey } from './support/sim.js';

function records(bytes: Uint8Array) {
  return readLog(bytes).records.map((r) => r.record);
}

function flagsOf(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const rec of records(bytes))
    if (rec.k === Kind.EDIT_BATCH) for (const c of rec.b.c) out.push(c[4] ?? 0);
  return out;
}

function kinds(bytes: Uint8Array): string[] {
  const names = Object.fromEntries(Object.entries(Kind).map(([k, v]) => [v, k]));
  return records(bytes).map((r) => names[r.k]!);
}

async function newSim(files: Record<string, string> = {}): Promise<Sim> {
  const host = new SimHost();
  for (const [p, t] of Object.entries(files)) host.disk.set(p, t);
  return new Sim(host).start();
}

/** Every scenario must end with a log that verifies and matches the files. */
async function finish(sim: Sim, extraAllowed: string[] = []): Promise<ReturnType<Sim['verify']>> {
  await sim.settle();
  await sim.recorder.stop();
  const report = sim.verify();
  const unexpected = issues(report).filter(
    (i) => !['warn:NO_ANCHORS', 'info:SUBMISSION_FILE_MISSING', ...extraAllowed].includes(i),
  );
  expect(
    unexpected,
    JSON.stringify(
      report.findings.filter((f) => f.severity !== 'pass'),
      null,
      2,
    ),
  ).toEqual([]);
  expect(sim.host.errors).toEqual([]);
  // The log reproduces exactly what the editor shows.
  for (const [rel, doc] of sim.host.docs) {
    // Lone surrogates are stored as U+FFFD (same length), so compare in that form.
    if (sim.host.tracked(rel))
      expect(toWellFormed(loggedText(sim.bytes, rel) ?? ''), rel).toBe(toWellFormed(doc.text));
  }
  return report;
}

describe('classification', () => {
  const settings = { clipboardCheckMinChars: 2, bulkMinChars: 40 };

  it('orders simultaneous changes and flags them', () => {
    const out = classifyEvent(
      [
        { rangeOffset: 0, rangeLength: 0, text: '// ' },
        { rangeOffset: 10, rangeLength: 0, text: '// ' },
      ],
      undefined,
      false,
      settings,
    );
    expect(out.map((c) => c.off)).toEqual([10, 0]);
    expect(out.every((c) => c.flags & Flag.MULTI_CURSOR)).toBe(true);
    expect(out.every((c) => c.needsClipboard)).toBe(true);
  });

  it('marks undo, redo and format-on-save, and skips clipboard checks for them', () => {
    const undo = classifyEvent(
      [{ rangeOffset: 0, rangeLength: 0, text: 'abc' }],
      'undo',
      false,
      settings,
    )[0]!;
    expect(undo.flags).toBe(Flag.UNDO);
    expect(undo.needsClipboard).toBe(false);
    expect(
      classifyEvent([{ rangeOffset: 0, rangeLength: 1, text: '' }], 'redo', false, settings)[0]!.flags,
    ).toBe(Flag.REDO);
    expect(
      classifyEvent([{ rangeOffset: 0, rangeLength: 0, text: '  ' }], undefined, true, settings)[0]!.flags,
    ).toBe(Flag.FORMAT_ON_SAVE);
  });

  it('provisionally marks bulk insertions and large ones', () => {
    const bulk = classifyEvent(
      [{ rangeOffset: 0, rangeLength: 0, text: 'x'.repeat(45) }],
      undefined,
      false,
      settings,
    )[0]!;
    expect(bulk.flags).toBe(Flag.BULK);
    const block = classifyEvent(
      [{ rangeOffset: 0, rangeLength: 0, text: 'line one\nline two\n12' }],
      undefined,
      false,
      settings,
    )[0]!;
    expect(block.flags).toBe(Flag.BULK);
    const short = classifyEvent(
      [{ rangeOffset: 0, rangeLength: 0, text: 'ab' }],
      undefined,
      false,
      settings,
    )[0]!;
    expect(short.flags).toBe(0);
    const single = classifyEvent(
      [{ rangeOffset: 0, rangeLength: 0, text: 'a' }],
      undefined,
      false,
      settings,
    )[0]!;
    expect(single.needsClipboard).toBe(false);
    const large = classifyEvent(
      [{ rangeOffset: 0, rangeLength: 0, text: 'y'.repeat(300_000) }],
      undefined,
      false,
      settings,
    )[0]!;
    expect(large.flags & Flag.LARGE).toBe(Flag.LARGE);
  });

  it('recognises pastes, including multi-cursor and line-ending variants', () => {
    expect(isPasteOf('abc', 'abc', false)).toBe(true);
    expect(isPasteOf('a\r\nb', 'a\nb', false)).toBe(true);
    expect(isPasteOf('line\n', 'line', false)).toBe(true);
    expect(isPasteOf('two', 'one\ntwo\nthree', true)).toBe(true);
    expect(isPasteOf('two', 'one\ntwo\nthree', false)).toBe(false);
    expect(isPasteOf('', 'x', false)).toBe(false);
    expect(isPasteOf('x', '', false)).toBe(false);
    expect(resolvePaste(Flag.BULK, 'paste')).toBe(Flag.PASTE);
    expect(resolvePaste(Flag.BULK, 'no-paste')).toBe(Flag.BULK);
    expect(resolvePaste(0, 'timeout')).toBe(Flag.CLASSIFY_TIMEOUT);
  });

  it('diffRegion finds the changed middle without splitting surrogate pairs', () => {
    expect(diffRegion('abcdef', 'abXYef')).toEqual([2, 2, 'XY']);
    expect(diffRegion('same', 'same')).toEqual([4, 0, '']);
    expect(diffRegion('a😀b', 'a😃b')).toEqual([1, 2, '😃']);
  });

  it('detects AI extensions and normalises app names', () => {
    expect(detectAiExtensions(['GitHub.copilot', 'ms-python.python', 'continue.continue'])).toEqual([
      'continue.continue',
      'github.copilot',
    ]);
    expect(normaliseAppName('Visual Studio Code')).toBe('vscode');
    expect(normaliseAppName('Visual Studio Code - Insiders')).toBe('vscode-insiders');
    expect(normaliseAppName('Cursor')).toBe('cursor');
    expect(normaliseAppName('VSCodium')).toBe('vscodium');
    expect(normaliseAppName('Windsurf')).toBe('windsurf');
    expect(normaliseAppName('Some Editor!')).toBe('some-editor-');
    expect(normaliseAppName('')).toBe('unknown');
  });
});

describe('Recorder: a fresh log', () => {
  it('snapshots existing files, records typing and saves, and verifies', async () => {
    const sim = await newSim({ 'main.cpp': '', 'notes.md': '# notes\n', 'img.png': 'x' });
    sim.open('main.cpp');
    sim.typeAtEnd('main.cpp', 'int main() {\n  return 0;\n}\n');
    sim.save('main.cpp');
    const report = await finish(sim);
    expect(report.verdict).toBe('INTACT_WITH_WARNINGS');
    expect(kinds(sim.bytes)).toEqual(
      expect.arrayContaining([
        'SESSION_START',
        'FILE_SNAPSHOT',
        'EDIT_BATCH',
        'SAVE',
        'CHECKPOINT',
        'SESSION_END',
      ]),
    );
    expect(report.finalFiles.map((f) => f.path)).toEqual(['main.cpp', 'notes.md']);
    expect(report.composition?.byOrigin.typed?.chars).toBe('int main() {\n  return 0;\n}\n'.length);
    expect(report.composition?.byOrigin.preexisting?.chars).toBe('# notes\n'.length);
    expect(sim.recorder.trackedPaths()).toEqual(['main.cpp', 'notes.md']);
  });

  it('groups keystrokes into batches with timing', async () => {
    const sim = await newSim({ 'a.py': '' });
    sim.open('a.py');
    sim.typeAtEnd('a.py', 'print(1)\n');
    await finish(sim);
    const batches = records(sim.bytes).filter((r) => r.k === Kind.EDIT_BATCH);
    const tuples = batches.flatMap((b) => (b.k === Kind.EDIT_BATCH ? b.b.c : []));
    expect(tuples).toHaveLength(9);
    expect(tuples.slice(1).every((t) => t[0] === 120)).toBe(true);
  });
});

describe('Recorder: classification in context', () => {
  it('flags pastes from outside, internal copies, bulk completions and short completions', async () => {
    const helper = 'int add(int a, int b) { return a + b; }\n';
    const sim = await newSim({ 'utils.c': helper, 'main.c': '' });
    sim.open('main.c');
    sim.typeAtEnd('main.c', '// main\n');
    sim.paste('main.c', sim.text('main.c').length, 'int solve(int n) { return n * 2; }\n');
    sim.paste('main.c', sim.text('main.c').length, helper);
    sim.host.clipboard = 'something else';
    sim.insert('main.c', sim.text('main.c').length, 'printf("%d\\n", solve(add(1, 2)));  // completion\n');
    sim.insert('main.c', 0, 'stdio');
    sim.save('main.c');
    const report = await finish(sim);
    const o = report.composition!.byOrigin;
    expect(o.paste?.chars).toBe('int solve(int n) { return n * 2; }\n'.length);
    expect(o['internal-copy']?.chars).toBe(helper.length);
    expect(o.bulk?.chars).toBe('printf("%d\\n", solve(add(1, 2)));  // completion\n'.length);
    expect(o.typed?.chars).toBe('// main\n'.length + 'stdio'.length);
  });

  it('marks clipboard checks that take too long', async () => {
    const sim = await newSim({ 'a.js': '' });
    sim.open('a.js');
    sim.host.clipboardDelayMs = 200;
    sim.paste('a.js', 0, 'const x = 1;');
    await finish(sim);
    expect(flagsOf(sim.bytes)).toEqual([Flag.CLASSIFY_TIMEOUT]);
  });

  it('records multi-cursor edits, undo, redo and format-on-save', async () => {
    const sim = await newSim({ 'a.js': 'a();\nb();\nc();\n' });
    sim.open('a.js');
    sim.change('a.js', [
      { rangeOffset: 0, rangeLength: 0, text: '// ' },
      { rangeOffset: 5, rangeLength: 0, text: '// ' },
      { rangeOffset: 10, rangeLength: 0, text: '// ' },
    ]);
    sim.insert('a.js', 0, 'x');
    sim.change('a.js', [{ rangeOffset: 0, rangeLength: 1, text: '' }], 'undo');
    sim.change('a.js', [{ rangeOffset: 0, rangeLength: 0, text: 'x' }], 'redo');
    sim.save('a.js', [{ rangeOffset: sim.text('a.js').length, rangeLength: 0, text: '\n' }]);
    await finish(sim);
    const flags = flagsOf(sim.bytes);
    expect(flags.slice(0, 3)).toEqual([Flag.MULTI_CURSOR, Flag.MULTI_CURSOR, Flag.MULTI_CURSOR]);
    expect(flags).toContain(Flag.UNDO);
    expect(flags).toContain(Flag.REDO);
    expect(flags[flags.length - 1]).toBe(Flag.FORMAT_ON_SAVE);
  });

  it('records very large insertions with the LARGE flag', async () => {
    const sim = await newSim({ 'big.txt': '' });
    sim.open('big.txt');
    sim.host.clipboard = 'nope';
    sim.insert('big.txt', 0, 'z'.repeat(270_000));
    await finish(sim);
    expect(flagsOf(sim.bytes)[0]! & Flag.LARGE).toBe(Flag.LARGE);
  });
});

describe('Recorder: files changing outside the editor', () => {
  it('records external edits to closed files and VCS hints', async () => {
    const sim = await newSim({ 'a.c': 'int x = 1;\n' });
    sim.externalWrite('a.c', 'int x = 2;\n');
    await sim.settle();
    sim.host.vcs = true;
    sim.externalWrite('a.c', 'int x = 3;\n');
    const report = await finish(sim, ['info:EXTERNAL_CHANGE', 'info:VCS_OPERATION']);
    const ext = records(sim.bytes).filter((r) => r.k === Kind.EXTERNAL_CHANGE);
    expect(ext).toHaveLength(2);
    expect(ext[1]!.k === Kind.EXTERNAL_CHANGE && ext[1]!.b.hint).toBe('vcs');
    expect(report.composition!.byOrigin.external?.chars).toBe(1);
  });

  it('ignores watcher events that match the recorded content (own saves)', async () => {
    const sim = await newSim({ 'a.c': 'x' });
    sim.open('a.c');
    sim.typeAtEnd('a.c', 'y');
    sim.save('a.c');
    sim.close('a.c');
    sim.recorder.onDiskEvent('a.c');
    await finish(sim);
    expect(records(sim.bytes).some((r) => r.k === Kind.EXTERNAL_CHANGE)).toBe(false);
  });

  it('treats a reload of a clean open document as an external change', async () => {
    const sim = await newSim({ 'a.c': 'one\n' });
    sim.open('a.c');
    sim.externalWrite('a.c', 'two\n');
    await finish(sim, ['info:EXTERNAL_CHANGE']);
    expect(records(sim.bytes).filter((r) => r.k === Kind.EXTERNAL_CHANGE)).toHaveLength(1);
  });

  it('records "Revert File" as an undo of unsaved edits', async () => {
    const sim = await newSim({ 'a.c': 'saved\n' });
    sim.open('a.c');
    sim.typeAtEnd('a.c', 'unsaved');
    sim.revert('a.c');
    const report = await finish(sim);
    expect(flagsOf(sim.bytes).at(-1)).toBe(Flag.UNDO);
    expect(report.composition!.byOrigin.typed).toBeUndefined();
  });

  it('adds files that appear on disk and removes deleted ones', async () => {
    const sim = await newSim({ 'a.c': 'a' });
    sim.externalWrite('new.c', 'int y;\n');
    await sim.settle();
    sim.externalDelete('a.c');
    sim.host.binary.add('blob.bin');
    sim.recorder.onDiskEvent('blob.bin');
    sim.recorder.onDiskEvent('.tap/log.codelog');
    sim.recorder.onDiskEvent('missing.c');
    const report = await finish(sim, ['info:EXTERNAL_FILE']);
    expect(report.finalFiles.map((f) => f.path)).toEqual(['new.c']);
  });

  it('ignores watcher events for open documents', async () => {
    const sim = await newSim({ 'a.c': 'a' });
    sim.open('a.c');
    sim.typeAtEnd('a.c', 'b');
    sim.host.disk.set('a.c', 'different');
    sim.recorder.onDiskEvent('a.c');
    await sim.settle();
    sim.host.disk.set('a.c', sim.text('a.c'));
    await finish(sim);
    expect(records(sim.bytes).some((r) => r.k === Kind.EXTERNAL_CHANGE)).toBe(false);
  });
});

describe('Recorder: file operations through the editor', () => {
  it('creates, renames (files and folders) and deletes', async () => {
    const sim = await newSim({ 'src/x.py': 'x = 1\n', 'src/y.py': 'y = 2\n' });
    sim.createViaEditor('a.py');
    sim.open('a.py');
    sim.typeAtEnd('a.py', 'print(1)\n');
    sim.save('a.py');
    sim.renameViaEditor('a.py', 'b.py');
    sim.renameViaEditor('src', 'lib');
    sim.createViaEditor('tmp.py', 'from template\n');
    await sim.settle();
    sim.deleteViaEditor('tmp.py');
    sim.renameViaEditor('lib/y.py', 'lib/y.png'); // renamed to an untracked type: no longer recorded
    const report = await finish(sim);
    expect(report.finalFiles.map((f) => f.path)).toEqual(['b.py', 'lib/x.py']);
  });

  it('deletes all recorded files in a deleted folder', async () => {
    const sim = await newSim({ 'd/a.c': 'a', 'd/e/b.c': 'b', 'c.c': 'c' });
    sim.deleteViaEditor('d');
    const report = await finish(sim);
    expect(report.finalFiles.map((f) => f.path)).toEqual(['c.c']);
  });

  it('introduces a file first seen through an edit or a save', async () => {
    const sim = await newSim({});
    sim.host.disk.set('late.c', 'abc');
    sim.change('late.c', [{ rangeOffset: 3, rangeLength: 0, text: 'd' }]);
    sim.typeAtEnd('late.c', 'e');
    sim.save('late.c');
    sim.host.docs.set('fresh.c', { text: 'new file', dirty: true });
    sim.save('fresh.c');
    sim.change('ignored.png', [{ rangeOffset: 0, rangeLength: 0, text: 'x' }]);
    sim.recorder.onDidSave('ignored.png', 'x');
    const report = await finish(sim);
    expect(report.finalFiles.map((f) => f.path)).toEqual(['fresh.c', 'late.c']);
  });

  it('opening a document that differs from the log resynchronises it', async () => {
    const sim = await newSim({ 'a.c': 'disk' });
    sim.host.docs.set('a.c', { text: 'restored buffer', dirty: true });
    sim.recorder.onDocumentOpened('a.c', 'restored buffer');
    sim.host.docs.set('b.c', { text: 'b', dirty: false });
    sim.recorder.onDocumentOpened('b.c', 'b');
    sim.host.disk.set('a.c', 'restored buffer');
    sim.host.disk.set('b.c', 'b');
    const report = await finish(sim, ['warn:RESYNC', 'info:EXTERNAL_FILE']);
    expect(report.stats.resyncs).toBe(1);
  });
});

describe('Recorder: pause and resume', () => {
  it('ignores edits while paused and records the gap on resume', async () => {
    const sim = await newSim({ 'a.c': 'start\n' });
    sim.open('a.c');
    sim.typeAtEnd('a.c', 'typed\n');
    await sim.recorder.pause('break');
    expect(sim.recorder.state).toBe('paused');
    sim.typeAtEnd('a.c', 'while paused\n');
    sim.host.disk.set('new.c', 'made while paused');
    sim.host.disk.set('gone.c', '');
    await sim.recorder.resume();
    sim.typeAtEnd('a.c', 'after\n');
    sim.save('a.c');
    const report = await finish(sim, ['info:PAUSED', 'warn:PAUSED_GAP_CHANGES']);
    const o = report.composition!.byOrigin;
    expect(o['paused-gap']?.chars).toBe('while paused\n'.length + 'made while paused'.length);
    expect(kinds(sim.bytes)).toEqual(expect.arrayContaining(['PAUSE', 'RESUME']));
  });

  it('can start paused (paused before a reload)', async () => {
    const host = new SimHost();
    host.disk.set('a.c', 'x');
    const sim = await new Sim(host).start({ startPaused: true });
    expect(sim.recorder.state).toBe('paused');
    sim.typeAtEnd('a.c', 'ignored');
    await sim.recorder.resume();
    await finish(sim, ['info:PAUSED', 'warn:PAUSED_GAP_CHANGES']);
  });

  it('pause and resume are no-ops in the wrong state', async () => {
    const sim = await newSim({});
    await sim.recorder.resume();
    await sim.recorder.pause();
    await sim.recorder.pause();
    await sim.recorder.resume();
    await finish(sim, ['info:PAUSED']);
  });
});

describe('Recorder: continuing an existing log', () => {
  async function firstSession(files: Record<string, string>, act: (sim: Sim) => void, keepOpen = false) {
    const sim = await newSim(files);
    act(sim);
    await sim.settle();
    if (!keepOpen) await sim.recorder.stop();
    return sim;
  }

  it('records files changed while the editor was closed, and new ones', async () => {
    const one = await firstSession({ 'a.c': 'v1\n', 'b.c': 'b\n' }, (s) => {
      s.open('a.c');
      s.typeAtEnd('a.c', 'more\n');
      s.save('a.c');
    });
    const host = new SimHost();
    host.disk = new Map(one.host.disk);
    host.disk.set('b.c', 'b changed elsewhere\n');
    host.disk.set('c.c', 'new\n');
    host.disk.delete('a.c');
    const two = await new Sim(host).start({ existing: one.bytes });
    const report = await finish(two, ['info:EXTERNAL_CHANGE', 'info:EXTERNAL_FILE']);
    expect(report.stats.sessions).toBe(2);
    expect(report.finalFiles.map((f) => f.path)).toEqual(['b.c', 'c.c']);
  });

  it('does not treat restored unsaved edits as external changes', async () => {
    const one = await firstSession({ 'a.c': 'saved\n' }, (s) => {
      s.open('a.c');
      s.typeAtEnd('a.c', 'unsaved');
    });
    // Hot exit: disk still has the saved version, the editor restores the buffer later.
    const host = new SimHost();
    host.disk = new Map(one.host.disk);
    const two = await new Sim(host).start({ existing: one.bytes });
    two.host.docs.set('a.c', { text: 'saved\nunsaved', dirty: true });
    two.recorder.onDocumentOpened('a.c', 'saved\nunsaved');
    two.typeAtEnd('a.c', '!');
    two.save('a.c');
    await finish(two);
  });

  it('records discarded unsaved edits as an undo', async () => {
    const one = await firstSession({ 'a.c': 'saved\n' }, (s) => {
      s.open('a.c');
      s.typeAtEnd('a.c', 'unsaved');
    });
    const host = new SimHost();
    host.disk = new Map(one.host.disk);
    host.docs.set('a.c', { text: 'saved\n', dirty: false });
    const two = await new Sim(host).start({ existing: one.bytes });
    await finish(two);
    expect(flagsOf(two.bytes).at(-1)).toBe(Flag.UNDO);
  });

  it('writes KEY_ROTATION when the signing key changed', async () => {
    const one = await firstSession({ 'a.c': 'x' }, () => {});
    const host = new SimHost();
    host.disk = new Map(one.host.disk);
    const two = await new Sim(host).start({ existing: one.bytes, key: testKey('new-laptop') });
    const report = await finish(two, ['warn:KEY_ROTATED']);
    expect(report.keys).toHaveLength(2);
  });

  it('recovers a crashed session with a damaged tail', async () => {
    const one = await firstSession(
      { 'a.c': 'x' },
      (s) => {
        s.open('a.c');
        s.typeAtEnd('a.c', 'yz');
      },
      true,
    );
    // Crash: no SESSION_END, last block half written.
    const full = one.bytes;
    const damaged = full.slice(0, full.length - 5);
    const scan = scanForRecovery(damaged);
    const valid = damaged.subarray(0, scan.validLength);
    const host = new SimHost();
    host.disk = new Map(one.host.disk);
    const two = await new Sim(host).start({ existing: valid, recovery: LogWriter.recoveryBody(scan) });
    const report = await finish(two, ['warn:RECOVERED', 'info:SESSION_NOT_CLOSED']);
    expect(kinds(two.bytes)).toContain('RECOVERY');
    expect(report.stats.recoveries).toBe(1);
  });
});

describe('Recorder: timing, runs and housekeeping', () => {
  it('writes periodic checkpoints and detects a wall clock set back', async () => {
    const sim = await newSim({ 'a.c': '' });
    sim.open('a.c');
    sim.typeAtEnd('a.c', 'x');
    await sim.recorder.tick();
    sim.host.advance(301_000);
    await sim.settle();
    await sim.recorder.tick();
    const checkpoints = records(sim.bytes).filter((r) => r.k === Kind.CHECKPOINT).length;
    expect(checkpoints).toBeGreaterThanOrEqual(2);
    sim.host.mono += 10_000;
    sim.host.wall -= 60_000;
    await sim.recorder.tick();
    await finish(sim, ['warn:CLOCK_ANOMALY', 'warn:CLOCK_BACKWARDS']);
  });

  it('records runs, focus, notes and environment changes', async () => {
    const sim = await newSim({ 'a.c': '' });
    const rid = sim.recorder.runStarted('task', 'build');
    sim.recorder.runEnded(rid, 1);
    const dbg = sim.recorder.runStarted('debug', 'Launch');
    sim.recorder.runEnded(dbg);
    sim.recorder.onFocusChanged(false);
    sim.recorder.onFocusChanged(true);
    await sim.recorder.addNote('Starter code from the course page.');
    sim.recorder.environmentChanged({ aiExt: ['github.copilot'] });
    const report = await finish(sim);
    expect(report.stats.runs).toBe(2);
    expect(report.notes.map((n) => n.text)).toEqual(['Starter code from the course page.']);
    expect(kinds(sim.bytes).filter((k) => k === 'FOCUS')).toHaveLength(2);
    expect(kinds(sim.bytes)).toContain('ENV_CHANGE');
  });

  it('does not record focus when disabled', async () => {
    const host = new SimHost();
    const sim = await new Sim(host).start({ settings: { recordFocus: false } });
    sim.recorder.onFocusChanged(false);
    await finish(sim);
    expect(kinds(sim.bytes)).not.toContain('FOCUS');
  });

  it('flushes early when the buffer is large', async () => {
    const host = new SimHost();
    host.disk.set('a.txt', '');
    const sim = await new Sim(host).start({ settings: { maxBufferedBytes: 100, flushDelayMs: 60_000 } });
    sim.open('a.txt');
    for (let i = 0; i < 10; i++) sim.insert('a.txt', 0, 'x');
    await sim.recorder.idle();
    expect(
      records(sim.sink.bytes.length ? sim.bytes : sim.bytes).filter((r) => r.k === Kind.EDIT_BATCH).length,
    ).toBeGreaterThan(0);
    await finish(sim);
  });

  it('ignores events before start and after stop', async () => {
    const host = new SimHost();
    const sim = new Sim(host);
    await sim.start();
    await sim.recorder.stop();
    expect(sim.recorder.state).toBe('stopped');
    sim.recorder.onDocumentChanged(
      'a.c',
      [{ rangeOffset: 0, rangeLength: 0, text: 'x' }],
      undefined,
      true,
      () => 'x',
    );
    sim.recorder.onWillSave('a.c');
    sim.recorder.onDidSave('a.c', 'x');
    sim.recorder.onDocumentOpened('a.c', 'x');
    sim.recorder.onFilesCreated(['a.c']);
    sim.recorder.onFilesDeleted(['a.c']);
    sim.recorder.onFilesRenamed([{ from: 'a.c', to: 'b.c' }]);
    sim.recorder.onDiskEvent('a.c');
    sim.recorder.onFocusChanged(true);
    sim.recorder.runEnded(sim.recorder.runStarted('task'));
    await sim.recorder.addNote('x');
    sim.recorder.environmentChanged({ liveShare: true });
    await sim.recorder.tick();
    await sim.recorder.flush();
    await sim.recorder.stop();
    sim.recorder.stopSync();
    expect(kinds(sim.bytes).at(-1)).toBe('SESSION_END');
    expect(() => sim.recorder.start()).toThrow(/cannot start/);
  });
});

describe('Recorder: robustness', () => {
  it('stopSync writes buffered edits synchronously and abandons jobs in flight', async () => {
    const sim = await newSim({ 'a.c': '' });
    sim.open('a.c');
    sim.host.clipboardDelayMs = 500;
    sim.paste('a.c', 0, 'pasted text');
    sim.host.clipboardDelayMs = 0;
    sim.typeAtEnd('a.c', 'abc');
    sim.save('a.c'); // queued job will wait for the clipboard
    sim.recorder.stopSync('deactivate');
    expect(sim.sink.syncWrites).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    const report = sim.verify();
    expect(issues(report).filter((i) => i.startsWith('fail'))).toEqual([]);
    expect(kinds(sim.bytes).at(-1)).toBe('SESSION_END');
    expect(loggedText(sim.bytes, 'a.c')).toBe('pasted textabc');
    expect(flagsOf(sim.bytes)[0]).toBe(Flag.CLASSIFY_TIMEOUT);
  });

  it('resynchronises when its copy of a document diverges from the editor', async () => {
    const sim = await newSim({ 'a.c': 'abc' });
    sim.open('a.c');
    // A change the recorder never heard about.
    sim.host.docs.get('a.c')!.text = 'abcXYZ';
    sim.typeAtEnd('a.c', '!');
    sim.save('a.c');
    await sim.settle();
    expect(sim.host.errors.map((e) => e.context)).toEqual(['edit-batch']);
    sim.host.errors.length = 0;
    const report = await finish(sim, ['warn:RESYNC']);
    expect(report.stats.resyncs).toBe(1);
  });

  it('resynchronises when an edit falls outside its copy of the document', async () => {
    const sim = await newSim({ 'a.c': 'abc' });
    sim.open('a.c');
    sim.host.docs.get('a.c')!.text = 'abc and much more text';
    sim.change('a.c', [{ rangeOffset: 20, rangeLength: 0, text: '!' }]);
    sim.typeAtEnd('a.c', '?');
    await sim.settle();
    expect(sim.host.errors.map((e) => e.context)).toContain('edit-batch');
    sim.host.errors.length = 0;
    await finish(sim, ['warn:RESYNC']);
  });

  it('resynchronises on overlapping change ranges', async () => {
    const sim = await newSim({ 'a.c': 'abcdef' });
    sim.open('a.c');
    sim.host.docs.get('a.c')!.text = 'ab';
    sim.recorder.onDocumentChanged(
      'a.c',
      [
        { rangeOffset: 0, rangeLength: 3, text: '' },
        { rangeOffset: 2, rangeLength: 2, text: '' },
      ],
      undefined,
      true,
      () => 'ab',
    );
    await sim.settle();
    expect(sim.host.errors.map((e) => e.context)).toContain('classify');
    sim.host.errors.length = 0;
    sim.host.disk.set('a.c', 'ab');
    await finish(sim, ['warn:RESYNC']);
  });

  it('reports sink failures and keeps going', async () => {
    const sim = await newSim({ 'a.c': '' });
    sim.open('a.c');
    sim.sink.failNext = true;
    sim.typeAtEnd('a.c', 'x');
    await sim.settle();
    expect(sim.host.errors.map((e) => e.context)).toEqual(['job']);
  });

  it('a random editing session always produces a log that verifies and matches', async () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const sim = await newSim({ 'a.c': 'int main() {}\n', 'b.c': '' });
    sim.open('a.c');
    sim.open('b.c');
    const pieces = ['x', 'for (', ';\n', '😀', 'é', '\r\n', '  ', 'return 0;'];
    for (let step = 0; step < 400; step++) {
      const rel = rand() < 0.6 ? 'a.c' : 'b.c';
      const text = sim.text(rel);
      const r = rand();
      if (r < 0.55) {
        sim.insert(rel, Math.floor(rand() * (text.length + 1)), pieces[Math.floor(rand() * pieces.length)]!);
      } else if (r < 0.7 && text.length > 0) {
        const at = Math.floor(rand() * text.length);
        sim.change(rel, [{ rangeOffset: at, rangeLength: Math.min(3, text.length - at), text: '' }]);
      } else if (r < 0.78) {
        sim.paste(rel, Math.floor(rand() * (text.length + 1)), 'pasted();\n');
      } else if (r < 0.85) {
        sim.save(rel);
      } else if (r < 0.88) {
        sim.close(rel);
        sim.externalWrite(rel, `${sim.host.disk.get(rel) ?? ''}// external\n`);
        await sim.settle();
        sim.open(rel);
      } else if (r < 0.9) {
        sim.revert(rel);
      } else if (r < 0.92) {
        await sim.recorder.tick();
      } else if (r < 0.95) {
        await sim.settle();
      }
    }
    sim.save('a.c');
    sim.save('b.c');
    const report = await finish(sim, ['info:EXTERNAL_CHANGE']);
    expect(report.findings.find((f) => f.code === 'SUBMISSION_MATCH')).toBeDefined();
    expect(verifyLog(sim.bytes).verdict).toBe('INTACT_WITH_WARNINGS');
  });
});
