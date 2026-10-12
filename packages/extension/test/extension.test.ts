/**
 * The whole extension (activation, commands, status bar, FolderSession wiring) running against
 * the in-memory VS Code stand-in.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { Kind, readLog, verifyLog } from '@tap/core';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension.js';
import type { Controller } from '../src/vscode/controller.js';
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
  return ui.statusItems[ui.statusItems.length - 1]!;
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
    expect(status().text).toBe('$(record) TAP');
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
    expect(status().text).toBe('$(debug-pause) TAP');
    driver.edit(doc, [{ rangeOffset: 0, rangeLength: 0, text: '/* paused */\n' }]);
    driver.save(doc);
    await vscode.commands.executeCommand('tap.resume');
    expect(status().text).toBe('$(record) TAP');
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
        (f.severity === 'warn' && f.code !== 'NO_ANCHORS' && f.code !== 'PAUSED_GAP_CHANGES'),
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
    expect(status().text).toBe('$(debug-pause) TAP');
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
    expect(status().text).toBe('$(debug-pause) TAP');
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
