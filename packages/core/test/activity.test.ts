import { describe, expect, it } from 'vitest';
import {
  codeLinesOf,
  compareVersions,
  contentHash,
  Flag,
  originFromFlags,
  Replayer,
  stateDigest,
  summarizeActivity,
  verifyLog,
  weakenedSetting,
} from '../src/index.js';
import { RawLog, SID, sessionStart, testKey } from './support/raw.js';

const key = testKey();

function snap(f: number, path: string, text: string, origin = 'preexisting') {
  return { f, path, origin, text, h: contentHash(text), eol: 'lf', enc: 'utf8' };
}

const codes = (r: ReturnType<typeof verifyLog>, stage = 'activity') =>
  r.findings.filter((f) => f.stage === stage && f.severity !== 'pass').map((f) => `${f.severity}:${f.code}`);

const ai = (on: boolean) => ({ on, inline: on, chat: on, active: on ? ['github.copilot'] : [] });

describe('origins decided from the inserted text (0.3.3)', () => {
  it('typing is one character per change; several characters at once are a completion or bulk', () => {
    expect(originFromFlags(0, false, 'a')).toBe('typed');
    expect(originFromFlags(0, false, '()')).toBe('typed'); // auto-closed pair
    expect(originFromFlags(0, false, '\n    ')).toBe('typed'); // indentation
    expect(originFromFlags(0, false, 'result')).toBe('completion');
    expect(originFromFlags(0, false, 'x'.repeat(40))).toBe('bulk');
    expect(originFromFlags(0, false, 'int a;\nint b;\nint c;')).toBe('bulk'); // multi-line, 20+
    // A recorder told to flag bulk only above 100000 characters cannot hide it any more.
    expect(originFromFlags(0, false, 'for (int i = 0; i < n; i++) { sum += a[i]; }')).toBe('bulk');
    expect(originFromFlags(Flag.PASTE, false, 'result')).toBe('paste');
    expect(originFromFlags(Flag.UNDO, false, 'result')).toBe('undo-redo');
  });
});

describe('undo after an outside change keeps the outside origin (E)', () => {
  it('text replaced by an external snapshot and brought back by undo is still "external"', () => {
    const r = new Replayer({ provenance: true });
    const mine = 'int f() { return 0; }\n';
    const theirs = 'int f() {\n    return compute(42) + helper(7);\n}\n';
    r.apply({ s: 0, k: 3, t: 0, m: 0, p: new Uint8Array(32), b: snap(0, 'a.c', mine) } as never);
    // Another program writes the file, then the student undoes in the editor and redoes.
    r.apply({ s: 1, k: 7, t: 1, m: 1, p: new Uint8Array(32), b: { f: 0, h: contentHash(theirs) } } as never);
    r.apply({
      s: 2,
      k: 3,
      t: 2,
      m: 2,
      p: new Uint8Array(32),
      b: snap(0, 'a.c', theirs, 'external'),
    } as never);
    r.apply({
      s: 3,
      k: 4,
      t: 3,
      m: 3,
      p: new Uint8Array(32),
      b: { f: 0, c: [[0, 0, theirs.length, mine, Flag.UNDO]] },
    } as never);
    r.apply({
      s: 4,
      k: 4,
      t: 4,
      m: 4,
      p: new Uint8Array(32),
      b: { f: 0, c: [[0, 0, mine.length, theirs, Flag.REDO]] },
    } as never);
    const comp = r.composition();
    expect(comp.byOrigin.external?.nonWs).toBeGreaterThan(20);
    expect(comp.byOrigin['undo-redo']).toBeUndefined();
  });
});

describe('activity stage (0.3.3)', () => {
  function base(extra: Record<string, unknown> = {}): RawLog {
    const log = new RawLog({ tool: 'tap-cc-one/0.3.3' });
    log.push('SESSION_START', { ...sessionStart(key.publicKey), ext: '0.3.3', ...extra });
    return log;
  }

  it('reports the declared AI choice and AI that was on although declared off', () => {
    const log = base({ aiChoice: 'off', ai: ai(false) });
    log.t += 60_000;
    log.push('ENV_CHANGE', { ai: ai(true) });
    log.t += 5 * 60_000;
    log.push('ENV_CHANGE', { ai: ai(false) });
    log.push('SESSION_END', { sid: SID, reason: 'close' });
    const r = verifyLog(log.bytes());
    expect(codes(r)).toEqual(['info:AI_DECLARED_OFF', 'warn:AI_ON_AFTER_DECLARED_OFF']);
    expect(r.activity!.aiOn).toHaveLength(1);
    expect(r.findings.find((f) => f.code === 'AI_ON_AFTER_DECLARED_OFF')!.message).toMatch(/5 min/);
  });

  it('records a choice made after the session started, and AI kept on', () => {
    const log = base({ aiChoice: 'unanswered', ai: ai(true) });
    log.push('ENV_CHANGE', { aiChoice: 'on' });
    log.t += 3 * 60_000;
    log.push('SESSION_END', { sid: SID, reason: 'close' });
    const r = verifyLog(log.bytes());
    expect(codes(r)).toEqual(['info:AI_DECLARED_ON', 'info:AI_AVAILABLE']);
  });

  it('lists time away, things open outside the folder and unmonitored terminals', () => {
    const log = base();
    log.push('FOCUS', { on: false });
    log.t += 4 * 60_000;
    log.push('FOCUS', { on: true });
    log.push('ENV_CHANGE', {
      open: [
        { k: 'web', name: 'Simple Browser', vis: true },
        { k: 'file', name: 'old_lab6.cpp' },
        { k: 'terminal', name: 'bash', mon: false },
      ],
    });
    log.t += 2 * 60_000;
    log.push('ENV_CHANGE', { open: [{ k: 'file', name: 'old_lab6.cpp', vis: true }] });
    log.t += 60_000;
    log.push('SESSION_END', { sid: SID, reason: 'close' });
    const r = verifyLog(log.bytes());
    expect(codes(r)).toEqual([
      'info:AWAY_FROM_EDITOR',
      'warn:OPEN_OUTSIDE_FOLDER',
      'warn:OPEN_OUTSIDE_FOLDER',
      'warn:TERMINAL_NOT_MONITORED',
    ]);
    const outside = r.activity!.outside;
    expect(outside.map((o) => [o.name, Math.round(o.visibleMs / 60_000)])).toEqual([
      ['Simple Browser', 2],
      ['old_lab6.cpp', 1],
    ]);
  });

  it('flags weaker settings at session start and when they change', () => {
    const log = base({
      settings: { 'tap.record.focus': true, 'tap.classify.clipboardCheckMinChars': 2, 'tap.ignored': 'x=1' },
    });
    log.push('ENV_CHANGE', { settings: { 'tap.record.focus': false } });
    const r = verifyLog(log.bytes());
    expect(codes(r)).toEqual(['warn:SETTINGS_WEAKENED', 'warn:SETTINGS_CHANGED']);
    expect(weakenedSetting('tap.classify.clipboardCheckMinChars', 100)).toMatch(/pastes shorter/);
    expect(weakenedSetting('tap.classify.clipboardCheckMinChars', 2)).toBeUndefined();
  });

  it('flags old recorder versions only for logs written by the extension', () => {
    const log = new RawLog({ tool: 'tap-cc-one/0.2.0' });
    log.push('SESSION_START', { ...sessionStart(key.publicKey), ext: '0.2.0' });
    expect(codes(verifyLog(log.bytes()))).toEqual(['warn:RECORDER_OUTDATED']);
    const other = new RawLog({ tool: 'some-other-writer' });
    other.push('SESSION_START', { ...sessionStart(key.publicKey), ext: '0.2.0' });
    expect(codes(verifyLog(other.bytes()))).toEqual([]);
    expect(compareVersions('0.3.10', '0.3.2')).toBe(1);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
  });

  it('finds AI output printed in the terminal that later appears in the code (D2)', () => {
    const answer = [
      'Node* insert(Node* root, int key) {',
      '    if (!root) return new Node(key);',
      '    if (key < root->key)',
      '        root->left = insert(root->left, key);',
      '    else if (key > root->key)',
      '        root->right = insert(root->right, key);',
      '    return root;',
      '}',
    ].join('\n');
    const log = base();
    log.push('FILE_SNAPSHOT', snap(0, 'bst.cpp', '#include <iostream>\n'));
    log.push('RUN_START', { rid: 1, kind: 'terminal', name: 'ai', cmd: 'ai code for me insert in bst c++' });
    log.push('RUN_END', { rid: 1, exit: 0, out: `${answer}\nRun? [y/N]\n`, outLen: answer.length + 12 });
    // The student types it in (one character per change).
    let text = '#include <iostream>\n';
    const changes: Array<[number, number, number, string]> = [];
    for (const ch of `${answer}\n`) {
      changes.push([150, text.length, 0, ch]);
      text += ch;
    }
    log.t += 5 * 60_000;
    log.push('EDIT_BATCH', { f: 0, c: changes });
    log.checkpoint(key, stateDigest([{ f: 0, path: 'bst.cpp', text }]), 1);
    const r = verifyLog(log.bytes());
    expect(codes(r)).toContain('warn:TERMINAL_CODE_REUSED');
    const reuse = r.activity!.terminalReuse[0]!;
    expect(reuse.files).toEqual(['bst.cpp']);
    expect(reuse.lines).toBeGreaterThanOrEqual(5);
    expect(codeLinesOf('Run? [y/N]\nhello world').size).toBe(0);
  });

  it('flags code arriving from outside the editor while AI was available (AI agents write files)', () => {
    const log = base({ ai: ai(true), aiChoice: 'on' });
    log.push('FILE_SNAPSHOT', snap(0, 'a.c', 'x\n'));
    log.t += 60_000;
    log.push('EXTERNAL_CHANGE', { f: 0, h: contentHash('bool isBST() {}\n') });
    log.push('FILE_SNAPSHOT', snap(0, 'a.c', 'bool isBST() {}\n', 'external'));
    const r = verifyLog(log.bytes());
    expect(r.findings.find((f) => f.code === 'OUTSIDE_CHANGE_WHILE_AI')?.message).toMatch(
      /a\.c \d\d:\d\d UTC/,
    );
  });

  it('links an outside change to the terminal command just before it (D9)', () => {
    const log = base();
    log.push('FILE_SNAPSHOT', snap(0, 'a.c', 'x\n'));
    log.push('RUN_START', { rid: 1, kind: 'terminal', cmd: 'ai write a.c' });
    log.push('EXTERNAL_CHANGE', { f: 0, h: contentHash('int main() {}\n') });
    log.push('FILE_SNAPSHOT', snap(0, 'a.c', 'int main() {}\n', 'external'));
    const r = verifyLog(log.bytes());
    expect(r.findings.find((f) => f.code === 'EXTERNAL_CHANGE')!.message).toMatch(
      /after the terminal command "ai write a\.c"/,
    );
  });

  it('summarises terminal commands run outside the folder', () => {
    const log = base();
    log.push('RUN_START', { rid: 1, kind: 'terminal', cmd: 'ls', outside: true });
    log.push('RUN_END', { rid: 1, exit: 0, out: 'a\nb\n', outLen: 4 });
    const records = verifyLog(log.bytes());
    expect(codes(records)).toEqual(['info:TERMINAL_OUTSIDE_FOLDER']);
    const s = summarizeActivity([]);
    expect(s.terminalCommands).toBe(0);
  });
});

describe('clock set behind real time (B4)', () => {
  it('is reported when every timestamp token is much later than the record that holds it', async () => {
    // Covered with real tokens in @tap/anchor's verifier tests; here only the constant is checked.
    const { CLOCK_BEHIND_MS } = await import('../src/verify.js');
    expect(CLOCK_BEHIND_MS).toBe(600_000);
  });
});

describe('modes and files that are not code (0.3.4)', () => {
  const h = (n: number) => new Uint8Array(32).fill(n);

  it('reports the mode, a switch to practice, and images added, shown and deleted', () => {
    const log = new RawLog({ tool: 'tap-cc-one/0.3.4' });
    log.push('SESSION_START', {
      ...sessionStart(key.publicKey),
      ext: '0.3.4',
      mode: 'exam',
      assets: [{ p: 'lab.pdf', n: 2048, h: h(1), k: 'pdf' }],
    });
    log.t += 60_000;
    log.push('ENV_CHANGE', { assets: [{ p: 'shot.png', n: 300_000, h: h(2), k: 'image', op: 'add' }] });
    log.push('ENV_CHANGE', { open: [{ k: 'file', name: 'shot.png', vis: true, in: true }] });
    log.t += 3 * 60_000;
    log.push('ENV_CHANGE', { open: [] });
    log.push('ENV_CHANGE', { mode: 'practice', aiChoice: 'on' });
    log.push('ENV_CHANGE', { assets: [{ p: 'shot.png', n: 300_000, k: 'image', op: 'delete' }] });
    log.push('SESSION_END', { sid: SID, reason: 'close' });
    // Between sessions a PDF appears; the next session finds it.
    log.t += 10 * 60_000;
    log.push('SESSION_START', {
      ...sessionStart(key.publicKey),
      ext: '0.3.4',
      mode: 'practice',
      assets: [
        { p: 'lab.pdf', n: 2048, h: h(1), k: 'pdf' },
        { p: 'answer.pdf', n: 9000, h: h(3), k: 'pdf' },
      ],
    });
    const r = verifyLog(log.bytes());
    const found = r.findings.filter((f) => f.stage === 'activity').map((f) => `${f.severity}:${f.code}`);
    expect(found).toEqual(
      expect.arrayContaining([
        'info:MODE_PRACTICE',
        'warn:MODE_SWITCHED',
        'info:ASSETS_PRESENT',
        'warn:ASSET_ADDED',
        'warn:ASSET_VIEWED',
        'warn:ASSET_REMOVED',
      ]),
    );
    expect(found).not.toContain('warn:OPEN_OUTSIDE_FOLDER');
    const assets = r.activity!.assets;
    expect(assets.map((a) => [a.p, a.initial, a.addedOffline ?? false, a.deleted !== undefined])).toEqual([
      ['answer.pdf', false, true, false],
      ['lab.pdf', true, false, false],
      ['shot.png', false, false, true],
    ]);
    expect(Math.round(assets[2]!.visibleMs / 60_000)).toBe(3);
    expect(r.findings.find((f) => f.message.includes('answer.pdf'))!.message).toMatch(
      /while recording was off/,
    );
  });
});

describe('extensions, AI panels and unrecorded files (0.3.5)', () => {
  it('reports AI and terminal extensions added mid-session, AI panels, and counts third-party AI as on', () => {
    const log = new RawLog({ tool: 'tap-cc-one/0.3.5' });
    log.push('SESSION_START', {
      ...sessionStart(key.publicKey),
      ext: '0.3.5',
      mode: 'exam',
      aiChoice: 'off',
      ai: ai(false),
      exts: ['ms-vscode.cpptools'],
      termExt: [],
      assets: [{ p: '.tap/lab.cpp', n: 40, k: 'other', skipped: true }],
    });
    log.t += 2 * 60_000;
    // Recorded as "off" by 0.3.4 recorders although Kilo Code was active.
    log.push('ENV_CHANGE', {
      aiExt: ['kilocode.kilo-code'],
      exts: ['kilocode.kilo-code', 'ms-vscode.cpptools'],
    });
    log.push('ENV_CHANGE', { open: [{ k: 'other', name: '✓ Kilo Code', vis: true }] });
    log.t += 60_000;
    log.push('ENV_CHANGE', { open: [{ k: 'other', name: '◔ Kilo Code', vis: true }] });
    log.t += 60_000;
    log.push('ENV_CHANGE', {
      termExt: ['someone.portaterm'],
      exts: ['kilocode.kilo-code', 'ms-vscode.cpptools', 'someone.portaterm', 'usernamehw.errorlens'],
      blocked: ['kilocode.kilo-code', 'someone.portaterm'],
    });
    log.t += 60_000;
    log.push('SESSION_END', { sid: SID, reason: 'close' });
    const r = verifyLog(log.bytes());
    const found = r.findings.filter((f) => f.stage === 'activity').map((f) => `${f.severity}:${f.code}`);
    expect(found).toEqual(
      expect.arrayContaining([
        'warn:AI_ON_AFTER_DECLARED_OFF',
        'warn:AI_EXTENSION_ADDED',
        'warn:TERMINAL_EXTENSION_ADDED',
        'info:EXTENSION_ADDED',
        'warn:AI_PANEL_SHOWN',
        'info:EXTENSIONS_BLOCKED',
        'warn:UNRECORDED_CODE_FILE',
      ]),
    );
    expect(found).not.toContain('info:OPEN_OUTSIDE_FOLDER');
    // One panel, not one per status mark.
    expect(r.activity!.aiPanels.map((p) => p.name)).toEqual(['Kilo Code']);
    expect(r.activity!.extensionsAdded.map((e) => [e.id, e.kind])).toEqual([
      ['kilocode.kilo-code', 'ai'],
      ['someone.portaterm', 'terminal'],
      ['usernamehw.errorlens', 'other'],
    ]);
  });
});
