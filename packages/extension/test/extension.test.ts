/**
 * The whole extension (activation, commands, status bar, FolderSession wiring) running against
 * the in-memory VS Code stand-in.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { type HttpClient, parseTimeStampReq, verifyTimestampToken } from '@tap/anchor';
import { TEST_CALENDAR, testPendingOts, testTsa } from '@tap/anchor/testing';
import { Kind, readLog, verifyLog } from '@tap/core';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension.js';
import type { Controller } from '../src/vscode/controller.js';
import { readSubmissionZip } from '../src/vscode/exportZip.js';
import { driver, type FakeContext, ui } from './support/fakeVscode.js';

const fake = vscode as unknown as typeof import('./support/fakeVscode.js');

let ws: string;
let storage: string;
const controllers: Controller[] = [];

beforeEach(() => {
  driver.reset();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ws-'));
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-store-'));
  fs.writeFileSync(path.join(ws, 'main.c'), 'int main(void) {\n}\n');
  fs.writeFileSync(path.join(ws, 'README.png'), 'not code');
  driver.configuration.set('tap.include', ['**/*.{c,h,py,txt}']);
  driver.configuration.set('tap.exclude', ['build/**']);
  // No real network in unit tests; the anchoring tests below turn it on with a fake TSA.
  driver.configuration.set('tap.anchoring.enabled', false);
});

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  deactivate();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(storage, { recursive: true, force: true });
});

async function start(
  context = driver.context(storage),
): Promise<{ controller: Controller; context: FakeContext }> {
  const controller = await activate(context as unknown as vscode.ExtensionContext);
  controllers.push(controller);
  return { controller, context };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

function logBytes(): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(ws, '.tap', 'log.codelog')));
}

function kinds(bytes: Uint8Array): string[] {
  const names = Object.fromEntries(Object.entries(Kind).map(([k, v]) => [v, k]));
  return readLog(bytes).records.map((r) => names[r.record.k]!);
}

function status() {
  return ui.statusItems.find((i) => i.name === 'TAP-CC-ONE')!;
}

describe('extension activation', () => {
  it('asks before recording a folder with code, and starts on "Start"', async () => {
    driver.addFolder(ws);
    ui.answers.push('Start');
    await start();
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    expect(ui.messages[0]!.text).toMatch(/Record authorship history/);
    expect(ui.messages[0]!.items).toEqual(['Start', 'Not now', 'Never for this folder']);
    await until(() => status().visible);
    expect(status().text).toBe('$(record) TAP · Practice');
    expect(fs.readFileSync(path.join(ws, '.tap', '.gitignore'), 'utf8')).toContain('lock');
    expect(JSON.parse(fs.readFileSync(path.join(ws, '.tap', 'config.json'), 'utf8')).include).toEqual([
      '**/*.{c,h,py,txt}',
    ]);
  });

  it('does not ask again after "Never for this folder", or when disabled by settings', async () => {
    driver.addFolder(ws);
    ui.answers.push('Never for this folder');
    const { context, controller } = await start();
    await until(() => ui.messages.length === 1);
    await wait(20);
    controller.dispose();
    deactivate();
    ui.messages.length = 0;
    driver.reset();
    driver.addFolder(ws);
    await start(context);
    expect(ui.messages).toEqual([]);
    driver.reset();
    driver.addFolder(ws);
    driver.configuration.set('tap.promptOnOpen', false);
    await start();
    expect(ui.messages).toEqual([]);
  });

  it('does not ask for folders without code or non-file folders', async () => {
    fs.rmSync(path.join(ws, 'main.c'));
    driver.addFolder(ws);
    driver.configuration.set('tap.include', ['**/*.c']);
    await start();
    expect(ui.messages).toEqual([]);
    expect(status().visible).toBe(false);
  });

  it('resumes recording automatically where .tap/ exists', async () => {
    driver.addFolder(ws);
    const first = await start();
    await vscode.commands.executeCommand('tap.start');
    first.controller.deactivate();
    driver.reset();
    driver.addFolder(ws);
    await start(first.context);
    expect(ui.messages.filter((m) => /Record authorship/.test(m.text))).toEqual([]);
    expect(kinds(logBytes()).filter((k) => k === 'SESSION_START')).toHaveLength(2);
  });
});

describe('recording through VS Code events', () => {
  it('records a realistic session end to end and verifies', async () => {
    const folder = driver.addFolder(ws);
    const { controller } = await start();
    await vscode.commands.executeCommand('tap.start');
    expect(ui.messages.at(-1)!.text).toMatch(/is recording/);

    const doc = driver.open(path.join(ws, 'main.c'));
    driver.type(doc, '  return 0;\n', 'int main(void) {\n'.length);
    await driver.paste(doc, '// helper copied from the lecture slides\n', 0);
    driver.edit(doc, [{ rangeOffset: 0, rangeLength: 0, text: 'x' }]);
    driver.edit(doc, [{ rangeOffset: 0, rangeLength: 1, text: '' }], fake.TextDocumentChangeReason.Undo);
    driver.save(doc);

    // A new file through the editor, then renamed.
    fs.writeFileSync(path.join(ws, 'util.h'), '');
    driver.emitters.create.fire({ files: [fake.Uri.file(path.join(ws, 'util.h'))] });
    const util = driver.open(path.join(ws, 'util.h'));
    driver.type(util, '#pragma once\n');
    driver.save(util);
    fs.renameSync(path.join(ws, 'util.h'), path.join(ws, 'helpers.h'));
    driver.close(util);
    driver.emitters.rename.fire({
      files: [
        { oldUri: fake.Uri.file(path.join(ws, 'util.h')), newUri: fake.Uri.file(path.join(ws, 'helpers.h')) },
      ],
    });

    // Another program changes a closed file.
    driver.externalWrite(path.join(ws, 'notes.txt'), 'todo\n');
    await wait(400);

    // Runs, focus, notes.
    driver.emitters.taskStart.fire({ execution: { task: { name: 'build', scope: folder } } });
    const exec = { task: { name: 'run', scope: 1 } };
    driver.emitters.taskStart.fire({ execution: exec });
    driver.emitters.taskEnd.fire({ execution: exec, exitCode: 1 });
    driver.emitters.debugStart.fire({ id: 'd1', name: 'Launch', workspaceFolder: folder });
    driver.emitters.debugEnd.fire({ id: 'd1', name: 'Launch' });
    driver.emitters.debugEnd.fire({ id: 'unknown', name: 'x' });
    driver.emitters.debugStart.fire({
      id: 'other',
      name: 'Other',
      workspaceFolder: { uri: fake.Uri.file('/elsewhere'), name: 'x', index: 9 },
    });
    driver.emitters.windowState.fire({ focused: false });
    driver.emitters.windowState.fire({ focused: false });
    driver.emitters.windowState.fire({ focused: true });
    ui.answers.push('Starter code from the course page.');
    await vscode.commands.executeCommand('tap.addNote');
    fake.extensions.all.push({ id: 'GitHub.copilot' });
    driver.emitters.extensions.fire();
    driver.emitters.extensions.fire();

    // Pause, change while paused, resume.
    await vscode.commands.executeCommand('tap.pause');
    expect(status().text).toBe('$(debug-pause) TAP · Practice');
    driver.edit(doc, [{ rangeOffset: 0, rangeLength: 0, text: '/* paused */\n' }]);
    driver.save(doc);
    await vscode.commands.executeCommand('tap.resume');
    expect(status().text).toBe('$(record) TAP · Practice');
    driver.type(doc, '// done\n');
    driver.save(doc);

    // Delete a file through the editor; edits to files outside the folder are ignored.
    fs.rmSync(path.join(ws, 'notes.txt'));
    driver.emitters.delete.fire({ files: [fake.Uri.file(path.join(ws, 'notes.txt'))] });
    const outside = new fake.TextDocument(fake.Uri.file('/tmp/outside.c'), '');
    driver.edit(outside, [{ rangeOffset: 0, rangeLength: 0, text: 'x' }]);
    driver.emitters.change.fire({ document: doc, contentChanges: [], reason: undefined });

    ui.answers.push('Show details');
    await vscode.commands.executeCommand('tap.verifyCurrent');
    expect(ui.messages.at(-1)!.text).toMatch(/INTACT WITH WARNINGS/);

    await vscode.commands.executeCommand('tap.stop');
    expect(status().visible).toBe(false);
    expect(ui.messages.at(-1)!.text).toMatch(/stopped recording/);

    const bytes = logBytes();
    const report = verifyLog(bytes, {
      submission: ['main.c', 'helpers.h'].map((p) => ({
        path: p,
        content: new Uint8Array(fs.readFileSync(path.join(ws, p))),
      })),
    });
    const problems = report.findings.filter(
      (f) =>
        f.severity === 'fail' ||
        (f.severity === 'warn' &&
          f.code !== 'NO_ANCHORS' &&
          f.code !== 'PAUSED_GAP_CHANGES' &&
          // this test installs Copilot during the session, which is reported (0.3.5)
          f.code !== 'AI_EXTENSION_ADDED' &&
          // these tests turn timestamping off, which the log discloses
          !(f.code === 'SETTINGS_WEAKENED' && f.message.includes('anchoring'))),
    );
    expect(problems).toEqual([]);
    expect(report.finalFiles.map((f) => f.path)).toEqual(['helpers.h', 'main.c']);
    const o = report.composition!.byOrigin;
    expect(o.paste?.chars).toBe('// helper copied from the lecture slides\n'.length);
    expect(o['paused-gap']?.chars).toBe('/* paused */\n'.length);
    const k = kinds(bytes);
    for (const kind of [
      'RUN_START',
      'RUN_END',
      'FOCUS',
      'NOTE',
      'ENV_CHANGE',
      'PAUSE',
      'RESUME',
      'FILE_OP',
      'SESSION_END',
    ]) {
      expect(k, kind).toContain(kind);
    }
    expect(k.filter((x) => x === 'RUN_START')).toHaveLength(3);
    expect(k.filter((x) => x === 'FOCUS')).toHaveLength(2);
    expect(controller.session(folder as unknown as vscode.WorkspaceFolder)?.status).toBe('stopped');
  });

  it('stops synchronously on deactivate and remembers a pause across reloads', async () => {
    driver.addFolder(ws);
    const { controller, context } = await start();
    await vscode.commands.executeCommand('tap.start');
    const doc = driver.open(path.join(ws, 'main.c'));
    driver.type(doc, 'x');
    await vscode.commands.executeCommand('tap.pause');
    controller.deactivate();
    expect(kinds(logBytes()).at(-1)).toBe('SESSION_END');

    driver.reset();
    driver.addFolder(ws);
    const again = await start(context);
    expect(status().text).toBe('$(debug-pause) TAP · Practice');
    const k = kinds(logBytes());
    expect(k.slice(-3)).toEqual(['SESSION_START', 'CHECKPOINT', 'PAUSE']);
    await vscode.commands.executeCommand('tap.resume');
    again.controller.deactivate();
    const report = verifyLog(logBytes());
    expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
  });

  it('a second window on the same folder does not record', async () => {
    driver.addFolder(ws);
    await start();
    await vscode.commands.executeCommand('tap.start');
    // Simulate another window: different session id, same folder, separate commands registry.
    const other = await import('../src/vscode/controller.js');
    driver.reset();
    driver.addFolder(ws);
    fake.env.sessionId = 'session-2';
    const second = new other.Controller(driver.context(storage) as unknown as vscode.ExtensionContext);
    controllers.push(second);
    await second.activate();
    expect(ui.messages.some((m) => /another VS Code window/.test(m.text))).toBe(true);
    expect(status().text).toBe('$(circle-slash) TAP');
    expect(status().tooltip).toMatch(/another window/);
  });

  it('restores a deleted log from its backup copy', async () => {
    driver.addFolder(ws);
    const { controller, context } = await start();
    await vscode.commands.executeCommand('tap.start');
    controller.deactivate();
    const before = logBytes();
    fs.rmSync(path.join(ws, '.tap', 'log.codelog'));
    driver.reset();
    driver.addFolder(ws);
    const again = await start(context);
    expect(ui.messages.some((m) => /restored the authorship log/.test(m.text))).toBe(true);
    again.controller.deactivate();
    const after = logBytes();
    expect(Buffer.from(after.subarray(0, before.length)).equals(Buffer.from(before))).toBe(true);
    expect(verifyLog(after).stats.sessions).toBe(2);
  });

  it('reports a log it cannot continue', async () => {
    driver.addFolder(ws);
    const { controller } = await start();
    await vscode.commands.executeCommand('tap.start');
    controller.deactivate();
    const bytes = logBytes();
    bytes[12] = bytes[12]! ^ 0xff;
    fs.writeFileSync(path.join(ws, '.tap', 'log.codelog'), bytes);
    driver.reset();
    driver.addFolder(ws);
    await start(driver.context(fs.mkdtempSync(path.join(os.tmpdir(), 'tap-store2-'))));
    expect(ui.messages.some((m) => m.kind === 'error' && /could not record/.test(m.text))).toBe(true);
    expect(status().text).toBe('$(warning) TAP');
  });
});

describe('viewer', () => {
  it('opens a webview with a strict CSP, sends the log, then only what was appended', async () => {
    const folder = driver.addFolder(ws) as unknown as vscode.WorkspaceFolder;
    const { controller } = await start();
    await vscode.commands.executeCommand('tap.start');
    const doc = driver.open(path.join(ws, 'main.c'));
    driver.type(doc, '  return 0;\n', 'int main(void) {\n'.length);
    driver.save(doc);

    ui.answers.push(undefined);
    await vscode.commands.executeCommand('tap.viewLog');
    expect(ui.panels).toHaveLength(1);
    const panel = ui.panels[0]!;
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(panel.webview.html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src https://webview.test;');
    expect(csp).toMatch(/style-src https:\/\/webview.test 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain('worker-src blob:');
    expect(csp).not.toContain('unsafe');
    // No inline script anywhere in the page.
    expect(panel.webview.html.match(/<script[^>]*>/g)).toEqual([
      expect.stringMatching(/<script src="[^"]+viewer\.js">/),
    ]);

    panel.webview.send({ type: 'ready' });
    await until(() => panel.webview.posted.length === 1);
    const first = panel.webview.posted[0] as {
      type: string;
      bytes: Uint8Array;
      submission: Array<{ path: string }>;
    };
    expect(first.type).toBe('log');
    expect(Buffer.from(first.bytes).equals(fs.readFileSync(path.join(ws, '.tap', 'log.codelog')))).toBe(true);
    expect(first.submission.map((f) => f.path)).toEqual(['main.c']);

    // Live refresh: unsaved typing is flushed to the log and only the new bytes are sent.
    driver.type(doc, '// more\n', 0);
    const viewer = controller.viewer(folder)!;
    await viewer.refresh();
    const second = panel.webview.posted[1] as {
      type: string;
      bytes: Uint8Array;
      submission: Array<{ content: string }>;
    };
    expect(second.type).toBe('append');
    const all = Buffer.concat([Buffer.from(first.bytes), Buffer.from(second.bytes)]);
    expect(all.equals(fs.readFileSync(path.join(ws, '.tap', 'log.codelog')))).toBe(true);
    expect(second.submission[0]!.content).toContain('// more'); // the editor's text, not the disk
    await viewer.refresh();
    expect(panel.webview.posted).toHaveLength(2); // nothing new

    panel.webview.send({ type: 'status', state: 'ready', verdict: 'INTACT_WITH_WARNINGS', entries: 1 });
    expect(viewer.status).toEqual({ state: 'ready', verdict: 'INTACT_WITH_WARNINGS', entries: 1 });
    panel.webview.send({ type: 'status', state: 'error', message: 'boom' });
    expect(ui.channels[0]!.lines.some((l) => l.includes('viewer: boom'))).toBe(true);
    panel.webview.send({ type: 'openFile', path: '../outside.c' });

    // A second "View Log" reveals the same panel; closing it forgets it.
    await vscode.commands.executeCommand('tap.viewLog');
    expect(ui.panels).toHaveLength(1);
    expect(panel.revealed).toBe(1);
    panel.dispose();
    expect(controller.viewer(folder)).toBeUndefined();
  });

  it('starts over when the log is replaced, and reports a missing log', async () => {
    const folder = driver.addFolder(ws) as unknown as vscode.WorkspaceFolder;
    const { controller } = await start();
    await vscode.commands.executeCommand('tap.start');
    const viewer = controller.showViewer(folder);
    const panel = ui.panels[0]!;
    panel.webview.send({ type: 'ready' });
    await until(() => panel.webview.posted.length === 1);
    await vscode.commands.executeCommand('tap.stop');
    const logPath = path.join(ws, '.tap', 'log.codelog');
    const bytes = fs.readFileSync(logPath);
    fs.rmSync(logPath);
    fs.writeFileSync(logPath, bytes.subarray(0, bytes.length - 10));
    await viewer.refresh();
    expect((panel.webview.posted.at(-1) as { type: string }).type).toBe('log');
    fs.rmSync(logPath);
    panel.webview.send({ type: 'ready' });
    await until(() => (panel.webview.posted.at(-1) as { type: string }).type === 'error');
    viewer.dispose();
  });
});

describe('commands', () => {
  it('shows the key fingerprint and copies it', async () => {
    driver.addFolder(ws);
    await start();
    ui.answers.push('Copy');
    await vscode.commands.executeCommand('tap.showFingerprint');
    expect(ui.messages.at(-1)!.text).toMatch(/[A-Z2-7]{4}(-[A-Z2-7]{4}){4}/);
    expect(fake.env.clipboard.value).toMatch(/^[A-Z2-7-]{24}$/);
  });

  it('warns once when the keychain is unavailable', async () => {
    driver.addFolder(ws);
    const context = driver.context(storage);
    context.secrets = {
      async get() {
        throw new Error('no keyring');
      },
      async store() {
        throw new Error('no keyring');
      },
    };
    await start(context);
    await vscode.commands.executeCommand('tap.showFingerprint');
    await vscode.commands.executeCommand('tap.showFingerprint');
    expect(ui.messages.filter((m) => /keychain is not available/.test(m.text))).toHaveLength(1);
  });

  it('handles commands with nothing to act on', async () => {
    fs.rmSync(path.join(ws, 'main.c'));
    driver.addFolder(ws);
    await start();
    await vscode.commands.executeCommand('tap.verifyCurrent');
    expect(ui.messages.at(-1)!.text).toMatch(/no recorded folder/);
    await vscode.commands.executeCommand('tap.stop');
    await vscode.commands.executeCommand('tap.pause');
    await vscode.commands.executeCommand('tap.resume');
    await vscode.commands.executeCommand('tap.addNote');
    await vscode.commands.executeCommand('tap.start');
    await vscode.commands.executeCommand('tap.start');
    expect(ui.messages.at(-1)!.text).toMatch(/already being recorded/);
    ui.answers.push('');
    await vscode.commands.executeCommand('tap.addNote');
    ui.answers.push('Pause recording');
    await vscode.commands.executeCommand('tap.showMenu');
    expect(status().text).toBe('$(debug-pause) TAP · Practice');
    ui.answers.push('Resume recording');
    await vscode.commands.executeCommand('tap.showMenu');
    ui.answers.push('nothing matches');
    await vscode.commands.executeCommand('tap.showMenu');
  });

  it('picks among several folders and follows folder changes', async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ws2-'));
    try {
      driver.addFolder(ws);
      const second = driver.addFolder(ws2, 'second');
      await start();
      ui.answers.push('second');
      await vscode.commands.executeCommand('tap.start');
      expect(fs.existsSync(path.join(ws2, '.tap', 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(ws, '.tap'))).toBe(false);
      fs.rmSync(path.join(ws, 'main.c'));
      const third = { uri: fake.Uri.file(ws), name: 'again', index: 2 };
      driver.emitters.folders.fire({ added: [third], removed: [second] });
      await wait(20);
      expect(kinds(new Uint8Array(fs.readFileSync(path.join(ws2, '.tap', 'log.codelog')))).at(-1)).toBe(
        'SESSION_END',
      );
      ui.answers.push(undefined);
      await vscode.commands.executeCommand('tap.verifyCurrent');
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });

  it('reports a folder whose log was removed', async () => {
    driver.addFolder(ws);
    const { controller } = await start();
    await vscode.commands.executeCommand('tap.start');
    controller.deactivate();
    fs.rmSync(path.join(ws, '.tap', 'log.codelog'));
    await vscode.commands.executeCommand('tap.verifyCurrent');
    expect(ui.messages.at(-1)!.text).toMatch(/has no log yet/);
  });
});

describe('timestamps, terminal commands, export and opening submissions', () => {
  const tsa = testTsa();
  /** A fake TSA and calendar on the "network". */
  const network: HttpClient = async (url, init) => {
    if (url.endsWith('/digest')) return { status: 200, body: testPendingOts(init.body!).token };
    if (init.method === 'GET') return { status: 404, body: new Uint8Array() };
    const req = parseTimeStampReq(init.body!);
    return {
      status: 200,
      body: tsa.response(tsa.token({ digest: req.digest, genTime: Date.now(), nonce: req.nonce! })),
    };
  };

  it('timestamps on demand, records terminal commands and exports a checkable zip', async () => {
    driver.configuration.set('tap.anchoring.enabled', true);
    driver.configuration.set('tap.anchoring.tsa', ['http://tsa-a.test', 'http://tsa-b.test']);
    driver.configuration.set('tap.anchoring.ots', [TEST_CALENDAR]);
    const folder = driver.addFolder(ws);
    const { controller } = await start();
    controller.anchors.setHttp(network);
    controller.anchors.setTokenCheck((token, digest) => verifyTimestampToken(token, digest, tsa.roots));
    await vscode.commands.executeCommand('tap.start');
    const doc = driver.open(path.join(ws, 'main.c'));
    driver.type(doc, '  return 0;\n', 'int main(void) {\n'.length);
    driver.save(doc);

    // A compile in the integrated terminal, with a secret on the command line.
    const exec = {
      commandLine: { value: 'gcc main.c -o app && MYSQL_PASSWORD=hunter2 ./app' },
      cwd: fake.Uri.file(ws),
      async *read() {
        yield '\u001b[32mok\u001b[0m\r\n';
        yield 'token sk-abcdefghijklmnopqrstuvwx\r\n';
      },
    };
    driver.emitters.terminalStart.fire({ execution: exec });
    await new Promise((r) => setTimeout(r, 10));
    driver.emitters.terminalEnd.fire({ execution: exec, exitCode: 0 });
    // A command after "cd ~" is recorded too, marked as outside the folder (0.3.3).
    const outside = { commandLine: { value: 'ls' }, cwd: fake.Uri.file('/elsewhere') };
    driver.emitters.terminalStart.fire({ execution: outside });
    driver.emitters.terminalEnd.fire({ execution: outside, exitCode: 0 });
    await new Promise((r) => setTimeout(r, 600));

    await vscode.commands.executeCommand('tap.timestampNow');
    expect(ui.messages.at(-1)!.text).toMatch(/timestamped by 2 independent service/);
    expect(status().text).toBe('$(record) TAP · Practice');

    const runs = readLog(logBytes())
      .records.map((r) => r.record)
      .filter((r) => r.k === Kind.RUN_START);
    expect(
      runs.map((r) => (r.k === Kind.RUN_START ? [r.b.kind, r.b.name, r.b.cmd, r.b.outside ?? false] : [])),
    ).toEqual([
      ['terminal', 'gcc', 'gcc main.c -o app && MYSQL_PASSWORD=*** ./app', false],
      ['terminal', 'ls', 'ls', true],
    ]);
    const ends = readLog(logBytes())
      .records.map((r) => r.record)
      .filter((r) => r.k === Kind.RUN_END);
    // Output without colour codes, secrets masked.
    expect(ends.map((r) => (r.k === Kind.RUN_END ? r.b.out : undefined))).toEqual([
      'ok\ntoken ***\n',
      undefined,
    ]);

    // Export: a zip with the log, the code and instructions; the teacher opens it read-only.
    const exported = await controller.exportFolder(folder as unknown as vscode.WorkspaceFolder);
    expect(
      exported.report.anchoring!.anchors.filter((a) => a.type === 'rfc3161').length,
    ).toBeGreaterThanOrEqual(4);
    expect(exported.report.findings.filter((f) => f.stage === 'submission').map((f) => f.code)).toEqual([
      'SUBMISSION_MATCH',
    ]);
    const target = path.join(storage, 'submission.zip');
    ui.files.push(target);
    await vscode.commands.executeCommand('tap.export');
    expect(ui.dialogs.at(-1)).toMatch(new RegExp(`${path.basename(ws)}-\\d{4}-\\d{2}-\\d{2}-\\d{4}\\.zip$`));
    expect(ui.messages.at(-1)!.text).toMatch(/saved submission\.zip/);

    ui.files.push(target);
    await vscode.commands.executeCommand('tap.openLogFile');
    const panel = ui.panels.at(-1)!;
    panel.webview.send({ type: 'ready' });
    await until(() => panel.webview.posted.length > 0);
    const msg = panel.webview.posted[0] as {
      type: string;
      comparedWith: string;
      submission: Array<{ path: string }>;
    };
    expect(msg.type).toBe('log');
    expect(msg.comparedWith).toBe('the code in the zip');
    expect(msg.submission.map((f) => f.path)).toEqual(['main.c']);
  });

  it('queues timestamps while offline and shows them in the status bar', async () => {
    driver.configuration.set('tap.anchoring.enabled', true);
    driver.addFolder(ws);
    const { controller } = await start();
    controller.anchors.setHttp(async () => {
      throw new Error('offline');
    });
    await vscode.commands.executeCommand('tap.start');
    const doc = driver.open(path.join(ws, 'main.c'));
    driver.type(doc, 'x');
    await vscode.commands.executeCommand('tap.pause');
    await until(() => /⧗3/.test(status().text));
    expect(status().tooltip).toMatch(/3 timestamp\(s\) waiting/);
  });
});

describe('the bundled extension', () => {
  it('loads from the esbuild bundle and activates', async () => {
    const outfile = path.join(storage, 'bundle', 'extension.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'extension.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      conditions: ['source'],
      external: ['vscode'],
      logLevel: 'silent',
    });
    const Module = createRequire(import.meta.url)('node:module') as {
      _load: (r: string, ...a: unknown[]) => unknown;
    };
    const original = Module._load;
    Module._load = (request: string, ...rest: unknown[]) =>
      request === 'vscode' ? fake : original(request, ...rest);
    try {
      const ext = createRequire(import.meta.url)(outfile) as {
        activate: typeof activate;
        deactivate: typeof deactivate;
      };
      driver.addFolder(ws);
      const c = await ext.activate(driver.context(storage) as unknown as vscode.ExtensionContext);
      controllers.push(c);
      await vscode.commands.executeCommand('tap.start');
      expect(fs.existsSync(path.join(ws, '.tap', 'log.codelog'))).toBe(true);
      ext.deactivate();
    } finally {
      Module._load = original;
    }
  });
});

describe('0.3.3-0.3.5: modes, extensions, policy, outside files, open tabs, attachments and export checks', () => {
  function records() {
    return readLog(logBytes()).records.map((r) => r.record);
  }

  it('asks for the mode (exam preselected), sets AI off even where only the user level allows it, and records a switch', async () => {
    fake.extensions.all = [{ id: 'GitHub.copilot', isActive: true }];
    driver.configuration.set('tap.defaultMode', 'ask');
    // Like the real editor for some AI settings: not settable per folder or workspace.
    driver.settings.readOnlySettings.add('chat.disableAIFeatures');
    driver.addFolder(ws);
    await start();
    ui.answers.push('Exam mode');
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    const first = records().find((r) => r.k === Kind.SESSION_START)!;
    if (first.k !== Kind.SESSION_START) throw new Error('no session');
    expect(first.b.mode).toBe('exam');
    expect(first.b.aiChoice).toBe('off');
    expect(first.b.ai?.on).toBe(false);
    expect(driver.configuration.get('chat.disableAIFeatures')).toBe(true);
    expect(driver.configuration.get('editor.inlineSuggest.enabled')).toBe(false);
    expect(driver.configuration.get('editor.wordBasedSuggestions')).toBe('off');
    expect(
      driver.settings.writes.find((w) => w.key === 'chat.disableAIFeatures' && w.value === true)?.target,
    ).toBe(fake.ConfigurationTarget.Global);
    expect(status().text).toBe('$(record) TAP · Exam');
    // Exam mode locks the TAP settings: a weaker value is ignored and that is recorded.
    expect(first.b.settings?.['tap.anchoring.enabled']).toBe(true);
    expect(String(first.b.settings?.['tap.ignored'])).toMatch(/anchoring\.enabled=false/);

    // Switching to practice mode puts the settings back and is written in the log.
    ui.answers.push('Practice mode', 'Switch to practice mode');
    await vscode.commands.executeCommand('tap.chooseMode');
    await until(() => records().some((r) => r.k === Kind.ENV_CHANGE && r.b.mode === 'practice'));
    expect(driver.configuration.get('chat.disableAIFeatures')).toBeUndefined();
    expect(driver.configuration.get('editor.inlineSuggest.enabled')).toBeUndefined();
    expect(status().text).toBe('$(record) TAP · Practice');
    await until(() => records().some((r) => r.k === Kind.ENV_CHANGE && r.b.ai?.on === true));
    const findings = verifyLog(logBytes()).findings.filter((f) => f.stage === 'activity');
    expect(findings.find((f) => f.code === 'MODE_SWITCHED')?.severity).toBe('warn');
    expect(findings.map((f) => f.code)).toContain('MODE_PRACTICE');
  });

  it('dismissing the mode question records in exam mode; the menu shows the mode', async () => {
    driver.configuration.set('tap.defaultMode', 'ask');
    driver.addFolder(ws);
    await start();
    ui.answers.push(undefined);
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    const first = records().find((r) => r.k === Kind.SESSION_START)!;
    expect(first.k === Kind.SESSION_START && first.b.mode).toBe('exam');
    expect(verifyLog(logBytes()).findings.map((f) => f.code)).toContain('MODE_EXAM');
  });

  it('exam mode turns off AI and terminal extensions, asks to reload, and puts them back on stop (0.3.5)', async () => {
    fake.extensions.all = [
      { id: 'KiloCode.kilo-code', isActive: true },
      { id: 'someone.portaterm', isActive: true, packageJSON: { displayName: 'Portaterm' } },
      { id: 'ms-vscode.cpptools', isActive: true, packageJSON: { categories: ['Programming Languages'] } },
    ];
    driver.configuration.set('tap.defaultMode', 'exam');
    driver.addFolder(ws);
    await start();
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    expect(driver.configuration.get('extensions.allowed')).toEqual({
      '*': true,
      'kilocode.kilo-code': false,
      'someone.portaterm': false,
    });
    const first = records().find((r) => r.k === Kind.SESSION_START)!;
    if (first.k !== Kind.SESSION_START) throw new Error('no session');
    expect(first.b.blocked).toEqual(['kilocode.kilo-code', 'someone.portaterm']);
    expect(first.b.termExt).toEqual(['someone.portaterm']);
    expect(first.b.ai?.on).toBe(true); // Kilo Code still runs until the window reloads
    expect(driver.configuration.get('files.exclude')).toEqual({ '**/.tap': true });
    // The student is told, in the middle of the window, to reload.
    await until(() => ui.messages.some((m) => m.modal && /Reload the window/.test(m.text)), 5000);
    // Stopping puts the user setting back.
    await vscode.commands.executeCommand('tap.stop');
    expect(driver.configuration.get('extensions.allowed')).toBeUndefined();
    const codes = verifyLog(logBytes()).findings.map((f) => f.code);
    expect(codes).toContain('EXTENSIONS_BLOCKED');
    expect(codes).toContain('TERMINAL_EXTENSION');
  });

  it('an AI extension installed during an exam is recorded, turned off and reported in a dialog (0.3.5)', async () => {
    driver.configuration.set('tap.defaultMode', 'exam');
    driver.addFolder(ws);
    await start();
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    fake.extensions.all = [{ id: 'saoudrizwan.claude-dev', isActive: false }];
    driver.emitters.extensions.fire();
    await until(() =>
      records().some((r) => r.k === Kind.ENV_CHANGE && r.b.blocked?.includes('saoudrizwan.claude-dev')),
    );
    expect(ui.messages.some((m) => m.modal && /installed or enabled while/.test(m.text))).toBe(true);
    const codes = verifyLog(logBytes()).findings.map((f) => `${f.severity}:${f.code}`);
    expect(codes).toContain('warn:AI_EXTENSION_ADDED');
  });

  it('a file written in .tap/ is recorded as not recorded, and the student can move it (0.3.5)', async () => {
    driver.addFolder(ws);
    await start();
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    const stray = path.join(ws, '.tap', 'lab.cpp');
    fs.writeFileSync(stray, 'int main() { return 0; }\n');
    ui.answers.push('Move it into the folder');
    for (const w of driver.watchers) w.create.fire(fake.Uri.file(stray));
    await until(() =>
      records().some(
        (r) => r.k === Kind.ENV_CHANGE && r.b.assets?.some((a) => a.p === '.tap/lab.cpp' && a.skipped),
      ),
    );
    await until(() => fs.existsSync(path.join(ws, 'lab.cpp')));
    expect(fs.existsSync(stray)).toBe(false);
    const msg = ui.messages.find((m) => /\.tap\/lab\.cpp/.test(m.text))!;
    expect(msg.modal).toBe(true);
    const finding = verifyLog(logBytes()).findings.find((f) => f.code === 'UNRECORDED_CODE_FILE')!;
    expect(finding.severity).toBe('warn');
    expect(finding.message).toMatch(/TAP's own folder/);
  });

  it('records images and PDFs in the folder, when they are shown, and ships them in the export', async () => {
    const folder = driver.addFolder(ws);
    const { controller } = await start();
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    const first = records().find((r) => r.k === Kind.SESSION_START)!;
    expect(first.k === Kind.SESSION_START && first.b.assets?.map((a) => [a.p, a.k])).toEqual([
      ['README.png', 'image'],
    ]);
    // A screenshot of code is saved into the folder and opened in VS Code.
    const shot = path.join(ws, 'shots', 'code.png');
    fs.mkdirSync(path.dirname(shot));
    fs.writeFileSync(shot, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    for (const w of driver.watchers) w.create.fire(fake.Uri.file(shot));
    await until(() =>
      records().some((r) => r.k === Kind.ENV_CHANGE && r.b.assets?.some((a) => a.p === 'shots/code.png')),
    );
    fake.window.tabGroups.all = [
      { tabs: [{ label: 'code.png', isActive: true, input: new fake.TabInputCustom(fake.Uri.file(shot)) }] },
    ];
    driver.emitters.tabs.fire();
    await until(() =>
      records().some(
        (r) => r.k === Kind.ENV_CHANGE && r.b.open?.some((o) => o.in && o.name === 'shots/code.png'),
      ),
    );
    const report = verifyLog(logBytes());
    const added = report.findings.find((f) => f.code === 'ASSET_ADDED')!;
    expect(added.severity).toBe('warn');
    expect(added.message).toMatch(/image "shots\/code\.png"/);
    expect(report.findings.map((f) => f.code)).not.toContain('OPEN_OUTSIDE_FOLDER');

    // The export ships it under attachments/, and opening the zip checks it against the log.
    const exported = await controller.exportFolder(folder as unknown as vscode.WorkspaceFolder);
    const opened = readSubmissionZip(exported.zip);
    expect(opened.attachments.map((a) => a.path).sort()).toEqual(['README.png', 'shots/code.png']);
    expect(opened.files.map((f) => f.path)).toEqual(['main.c']);
    const check = verifyLog(opened.log, { submission: opened.files, attachments: opened.attachments });
    expect(check.findings.filter((f) => f.code.startsWith('ATTACHMENT_'))).toEqual([]);
    const swapped = verifyLog(opened.log, {
      submission: opened.files,
      attachments: [{ path: 'shots/code.png', content: new Uint8Array([1, 2, 3]) }],
    });
    expect(swapped.findings.map((f) => f.code)).toContain('ATTACHMENT_MISMATCH');
    expect(swapped.findings.map((f) => f.code)).toContain('ATTACHMENT_NOT_SHIPPED');

    // Deleting it is recorded too.
    fs.rmSync(shot);
    for (const w of driver.watchers) w.delete.fire(fake.Uri.file(shot));
    await until(() =>
      records().some((r) => r.k === Kind.ENV_CHANGE && r.b.assets?.some((a) => a.op === 'delete')),
    );
    expect(verifyLog(logBytes()).findings.map((f) => f.code)).toContain('ASSET_REMOVED');
  });

  it('a course policy turns AI and suggestions off without asking', async () => {
    fs.mkdirSync(path.join(ws, '.tap'));
    fs.writeFileSync(
      path.join(ws, '.tap', 'config.json'),
      JSON.stringify({
        version: 1,
        label: 'lab',
        include: ['**/*.c'],
        exclude: [],
        maxFileSizeKB: 1024,
        policy: { ai: 'off', suggestions: 'off', lockSettings: true, requireShellIntegration: true },
      }),
    );
    driver.configuration.set('tap.record.focus', false);
    driver.addFolder(ws);
    await start();
    await until(() => fs.existsSync(path.join(ws, '.tap', 'log.codelog')));
    const first = records().find((r) => r.k === Kind.SESSION_START)!;
    if (first.k !== Kind.SESSION_START) throw new Error('no session');
    expect(first.b.aiChoice).toBe('enforced-off');
    expect(first.b.policy).toMatchObject({ ai: 'off', lockSettings: true });
    // Locked settings: the student's "record.focus = false" is ignored and the attempt recorded.
    expect(first.b.settings).toMatchObject({ 'tap.record.focus': true });
    expect(String(first.b.settings?.['tap.ignored'])).toMatch(/record\.focus=false/);
    expect(driver.configuration.get('editor.snippetSuggestions')).toBe('none');
    expect(driver.configuration.get('terminal.integrated.shellIntegration.enabled')).toBe(true);
    expect(ui.messages.some((m) => /turn off AI features/.test(m.text))).toBe(false);
  });

  it('warns when the code being edited is outside the recorded folder', async () => {
    driver.addFolder(ws);
    await start();
    ui.answers.push(undefined);
    await vscode.commands.executeCommand('tap.start');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-other-'));
    fs.writeFileSync(path.join(other, 'answer.c'), 'int x;\n');
    const doc = driver.open(path.join(other, 'answer.c'));
    fake.window.activeTextEditor = { document: doc };
    driver.emitters.activeEditor.fire(fake.window.activeTextEditor);
    const outside = ui.statusItems.find((i) => i.name === 'TAP-CC-ONE: file not recorded')!;
    expect(outside.visible).toBe(true);
    // Typing in it shows a dialog in the middle of the window, once per file (0.3.5).
    driver.type(doc, 'int y;');
    expect(ui.messages.at(-1)!.text).toMatch(/"answer\.c" is outside the recorded folder/);
    expect(ui.messages.at(-1)!.modal).toBe(true);
    const count = ui.messages.length;
    driver.type(doc, 'int z;');
    expect(ui.messages.length).toBe(count);
    fake.window.activeTextEditor = { document: driver.open(path.join(ws, 'main.c')) };
    driver.emitters.activeEditor.fire(fake.window.activeTextEditor);
    expect(outside.visible).toBe(false);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('records tabs and terminals open outside the folder, and terminals it cannot monitor', async () => {
    driver.addFolder(ws);
    await start();
    ui.answers.push(undefined);
    await vscode.commands.executeCommand('tap.start');
    fake.window.tabGroups.all = [
      {
        tabs: [
          { label: 'Simple Browser', isActive: true, input: new fake.TabInputWebview('simpleBrowser.view') },
          {
            label: 'old_lab6.cpp',
            isActive: false,
            input: new fake.TabInputText(fake.Uri.file('/x/old_lab6.cpp')),
          },
          {
            label: 'main.c',
            isActive: false,
            input: new fake.TabInputText(fake.Uri.file(path.join(ws, 'main.c'))),
          },
        ],
      },
    ];
    const terminal = { name: 'bash' };
    fake.window.terminals = [terminal];
    driver.emitters.terminalOpen.fire(terminal);
    driver.emitters.tabs.fire();
    await until(() =>
      records().some((r) => r.k === Kind.ENV_CHANGE && r.b.open?.some((o) => o.name === 'Simple Browser')),
    );
    const open = records().filter((r) => r.k === Kind.ENV_CHANGE && r.b.open)[0]!;
    expect(open.k === Kind.ENV_CHANGE && open.b.open?.map((o) => [o.k, o.name, o.vis ?? false])).toEqual([
      ['file', 'old_lab6.cpp', false],
      ['terminal', 'bash', false],
      ['web', 'Simple Browser', true],
    ]);
    // After a few seconds without shell integration the terminal counts as unmonitored.
    await until(
      () => records().some((r) => r.k === Kind.ENV_CHANGE && r.b.open?.some((o) => o.mon === false)),
      8000,
    );
    const codes = verifyLog(logBytes()).findings.map((f) => f.code);
    expect(codes).toContain('TERMINAL_NOT_MONITORED');
    expect(codes).toContain('OPEN_OUTSIDE_FOLDER');
  }, 15_000);

  it('records TAP setting changes while recording', async () => {
    driver.addFolder(ws);
    await start();
    ui.answers.push(undefined);
    await vscode.commands.executeCommand('tap.start');
    await vscode.workspace.getConfiguration('tap').update('record.terminalCommands', false);
    await until(() =>
      records().some(
        (r) => r.k === Kind.ENV_CHANGE && r.b.settings?.['tap.record.terminalCommands'] === false,
      ),
    );
    expect(verifyLog(logBytes()).findings.map((f) => f.code)).toContain('SETTINGS_CHANGED');
  });

  it('warns before exporting a log with no code edits', async () => {
    const folder = driver.addFolder(ws);
    await start();
    ui.answers.push(undefined);
    await vscode.commands.executeCommand('tap.start');
    ui.files.push(path.join(storage, 'empty.zip'));
    ui.answers.push(undefined); // dismiss the warning: nothing is saved
    await vscode.commands.executeCommand('tap.export');
    expect(ui.messages.at(-1)!.text).toMatch(/has no edits to code files/);
    expect(fs.existsSync(path.join(storage, 'empty.zip'))).toBe(false);
    void folder;
  });
});
