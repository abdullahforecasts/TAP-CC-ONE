/**
 * Integration tests in a real VS Code window: real typing (the `type` command), clipboard
 * paste, undo, multi-cursor, save participants, reloads from disk and workspace file edits.
 * These check the assumptions the recorder makes about VS Code's events.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type AnyRecord, Flag, Kind, readLog, type VerifyReport } from '@tap/core';
import * as vscode from 'vscode';
import type { Controller } from '../../src/vscode/controller.js';

const EXTENSION_ID = 'abdullahforecasts.tap-cc-one';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let controller: Controller;
let folder: vscode.WorkspaceFolder;

function root(): string {
  return folder.uri.fsPath;
}

function logRecords(): AnyRecord[] {
  const bytes = new Uint8Array(fs.readFileSync(path.join(root(), '.tap', 'log.codelog')));
  return readLog(bytes).records.map((r) => r.record);
}

function changeFlags(records: AnyRecord[]): number[] {
  const out: number[] = [];
  for (const r of records) if (r.k === Kind.EDIT_BATCH) for (const c of r.b.c) out.push(c[4] ?? 0);
  return out;
}

async function verify(): Promise<VerifyReport> {
  const report = await controller.verifyFolder(folder);
  assert.ok(report, 'log exists');
  const failures = report.findings.filter((f) => f.severity === 'fail');
  assert.deepEqual(failures, [], JSON.stringify(report.findings, null, 2));
  return report;
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(100);
  }
}

async function openEditor(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(path.join(root(), rel));
  return vscode.window.showTextDocument(doc);
}

async function typeText(editor: vscode.TextEditor, text: string): Promise<void> {
  for (const ch of text) await vscode.commands.executeCommand('type', { text: ch });
  void editor;
}

function moveToEnd(editor: vscode.TextEditor): void {
  const end = editor.document.positionAt(editor.document.getText().length);
  editor.selection = new vscode.Selection(end, end);
}

suite('TAP-CC-ONE in VS Code', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<Controller>(EXTENSION_ID);
    assert.ok(ext, 'extension is installed');
    controller = await ext.activate();
    folder = vscode.workspace.workspaceFolders![0]!;
    await vscode.commands.executeCommand('tap.start');
    await until(() => fs.existsSync(path.join(root(), '.tap', 'log.codelog')));
  });

  test('records typed code and saves', async () => {
    const editor = await openEditor('main.c');
    editor.selection = new vscode.Selection(3, 0, 3, 0);
    await typeText(editor, '  printf("hi");\n');
    await editor.document.save();
    const report = await verify();
    assert.ok((report.composition?.byOrigin.typed?.chars ?? 0) >= '  printf("hi");\n'.length - 2);
    assert.ok(logRecords().some((r) => r.k === Kind.SAVE));
    assert.ok(report.findings.some((f) => f.code === 'SUBMISSION_MATCH'));
  });

  test('marks a clipboard paste', async () => {
    const editor = await openEditor('main.c');
    moveToEnd(editor);
    const snippet = '// pasted from somewhere else\n';
    await vscode.env.clipboard.writeText(snippet);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await editor.document.save();
    const report = await verify();
    assert.equal(report.composition?.byOrigin.paste?.chars, snippet.length);
  });

  test('marks undo and redo', async () => {
    const editor = await openEditor('main.c');
    moveToEnd(editor);
    await typeText(editor, 'zz');
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('redo');
    await vscode.commands.executeCommand('undo');
    await editor.document.save();
    await verify();
    const flags = changeFlags(logRecords());
    assert.ok(
      flags.some((f) => f & Flag.UNDO),
      'undo flagged',
    );
    assert.ok(
      flags.some((f) => f & Flag.REDO),
      'redo flagged',
    );
  });

  test('marks multi-cursor edits', async () => {
    const editor = await openEditor('other.c');
    editor.selections = [new vscode.Selection(0, 0, 0, 0), new vscode.Selection(0, 4, 0, 4)];
    await vscode.commands.executeCommand('type', { text: 'X' });
    await editor.document.save();
    await verify();
    assert.ok(
      changeFlags(logRecords()).some((f) => f & Flag.MULTI_CURSOR),
      'multi-cursor flagged',
    );
  });

  test('marks edits made by save participants (trim trailing whitespace)', async () => {
    const editor = await openEditor('other.c');
    moveToEnd(editor);
    await typeText(editor, 'int y = 2;   ');
    await editor.document.save();
    await verify();
    assert.ok(
      changeFlags(logRecords()).some((f) => f & Flag.FORMAT_ON_SAVE),
      'save edits flagged',
    );
  });

  test('records a change made by another program to a closed file', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(path.join(root(), 'notes.txt'), 'written by another program\n');
    await until(() => logRecords().some((r) => r.k === Kind.FILE_SNAPSHOT && r.b.path === 'notes.txt'));
    fs.writeFileSync(path.join(root(), 'notes.txt'), 'changed again\n');
    await until(() => logRecords().some((r) => r.k === Kind.EXTERNAL_CHANGE));
    await verify();
  });

  test('records a reload of a clean open document as an external change', async () => {
    await openEditor('other.c');
    const before = logRecords().filter((r) => r.k === Kind.EXTERNAL_CHANGE).length;
    fs.writeFileSync(path.join(root(), 'other.c'), 'int other = 42;\n');
    await until(() => logRecords().filter((r) => r.k === Kind.EXTERNAL_CHANGE).length > before);
    const report = await verify();
    assert.equal(report.findings.filter((f) => f.code === 'RESYNC').length, 0);
  });

  test('records files renamed through a workspace edit', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(
      vscode.Uri.file(path.join(root(), 'notes.txt')),
      vscode.Uri.file(path.join(root(), 'todo.txt')),
    );
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(() => logRecords().some((r) => r.k === Kind.FILE_OP && r.b.op === 'rename'));
    const report = await verify();
    assert.ok(report.finalFiles.some((f) => f.path === 'todo.txt'));
  });

  test('pauses, records the gap and resumes', async () => {
    await vscode.commands.executeCommand('tap.pause');
    const editor = await openEditor('main.c');
    moveToEnd(editor);
    await typeText(editor, '/* while paused */\n');
    await editor.document.save();
    await vscode.commands.executeCommand('tap.resume');
    await typeText(editor, '// after\n');
    await editor.document.save();
    const report = await verify();
    assert.ok((report.composition?.byOrigin['paused-gap']?.chars ?? 0) > 0, 'gap recorded');
  });

  test('stops with a log that verifies against the files on disk', async () => {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    const report = await verify();
    assert.ok(report.findings.some((f) => f.code === 'SUBMISSION_MATCH'));
    const records = logRecords();
    assert.equal(records[0]?.k, Kind.SESSION_START);
    assert.ok(records.some((r) => r.k === Kind.CHECKPOINT));
  });
});
