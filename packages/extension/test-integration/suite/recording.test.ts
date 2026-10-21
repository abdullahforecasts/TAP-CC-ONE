/**
 * Integration tests in a real VS Code window: real typing (the `type` command), clipboard
 * paste, undo, multi-cursor, save participants, reloads from disk and workspace file edits.
 * These check the assumptions the recorder makes about VS Code's events.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type AnyRecord, Flag, Kind, Replayer, readLog, type VerifyReport, verifyLog } from '@tap/core';
import * as vscode from 'vscode';
import type { Controller } from '../../src/vscode/controller.js';
import { HOW_TO, readSubmissionZip } from '../../src/vscode/exportZip.js';

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

/** The log's current text of a file (undefined if not in the log). */
function loggedText(rel: string): string | undefined {
  const r = new Replayer();
  for (const e of readLog(new Uint8Array(fs.readFileSync(path.join(root(), '.tap', 'log.codelog')))).records)
    r.apply(e.record);
  return r.fileByPath(rel)?.text;
}

/** One line per record, printed when a test fails. */
function dumpLog(): string {
  const names = Object.fromEntries(Object.entries(Kind).map(([k, v]) => [v, k]));
  const paths = new Map<number, string>();
  return logRecords()
    .map((r, seq) => {
      const b = r.b as Record<string, unknown>;
      if (typeof b.f === 'number' && typeof b.path === 'string') paths.set(b.f, b.path);
      const file = typeof b.f === 'number' ? ` ${paths.get(b.f) ?? `f${b.f}`}` : '';
      let detail = '';
      if (r.k === Kind.EDIT_BATCH) detail = ` ${JSON.stringify(r.b.c)}`;
      else if (r.k === Kind.FILE_SNAPSHOT)
        detail = ` origin=${r.b.origin} ${JSON.stringify(r.b.text.slice(0, 60))}`;
      else if (r.k === Kind.FILE_OP) detail = ` ${r.b.op}${r.b.newPath ? ` -> ${r.b.newPath}` : ''}`;
      return `  #${seq} m=${r.m} ${names[r.k]}${file}${detail}`;
    })
    .join('\n');
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
  teardown(function () {
    if (this.currentTest?.state === 'failed')
      console.log(`log after "${this.currentTest.title}":\n${dumpLog()}`);
  });

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
    assert.ok(!logRecords().some((r) => r.k === Kind.EXTERNAL_CHANGE), 'typing is not an external change');
  });

  test('marks a clipboard paste', async function () {
    const editor = await openEditor('main.c');
    moveToEnd(editor);
    const before = editor.document.getText();
    const snippet = '// pasted from somewhere else\n';
    await vscode.env.clipboard.writeText(snippet);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    if (editor.document.getText() === before) {
      // The editor pasted nothing: no working clipboard here (Linux CI under a virtual display).
      console.log('  (skipped: the editor has no working clipboard in this environment)');
      this.skip();
    }
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

  test('records edits made by save participants (trim trailing whitespace)', async () => {
    const editor = await openEditor('other.c');
    moveToEnd(editor);
    await typeText(editor, 'int y = 2;   ');
    await editor.document.save();
    await verify();
    // Whatever VS Code did on save, the log must hold exactly the saved text.
    assert.equal(loggedText('other.c'), editor.document.getText());
    // Whether VS Code trims, and whether it does so before or after telling extensions that a
    // save is starting, varies (the order of save participants is not fixed; the macOS runner
    // did not trim at all), so these are reported rather than required.
    const trimmed = !editor.document.getText().endsWith(' ');
    const flagged = changeFlags(logRecords()).some((f) => f & Flag.FORMAT_ON_SAVE);
    console.log(`  (VS Code trimmed: ${trimmed}; FORMAT_ON_SAVE flag ${flagged ? 'set' : 'not set'})`);
  });

  test('records a change made by another program to a closed file', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(path.join(root(), 'notes.txt'), 'written by another program\n');
    await until(() => loggedText('notes.txt') === 'written by another program\n');
    fs.writeFileSync(path.join(root(), 'notes.txt'), 'changed again\n');
    await until(() => loggedText('notes.txt') === 'changed again\n');
    await verify();
  });

  test('records a reload of a clean open document as an external change', async () => {
    await openEditor('other.c');
    const before = logRecords().filter((r) => r.k === Kind.EXTERNAL_CHANGE).length;
    fs.writeFileSync(path.join(root(), 'other.c'), 'int other = 42;\n');
    await until(() => loggedText('other.c') === 'int other = 42;\n');
    const report = await verify();
    assert.equal(logRecords().filter((r) => r.k === Kind.EXTERNAL_CHANGE).length, before + 1);
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

  test('opens the viewer, which reads the log in the webview', async () => {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    await vscode.commands.executeCommand('tap.viewLog');
    const viewer = controller.viewer(folder);
    assert.ok(viewer, 'viewer panel opened');
    // The page loads the bundle under the webview's CSP, parses the log in a worker and reports back.
    await until(() => viewer.status.state !== 'loading', 30_000);
    assert.equal(viewer.status.state, 'ready', viewer.status.message);
    assert.ok((viewer.status.entries ?? 0) >= 3, `history entries: ${viewer.status.entries}`);
    assert.ok(viewer.status.verdict?.startsWith('INTACT'), viewer.status.verdict);
    // Live refresh picks up new records. The change is made without showing an editor: opening
    // one in the same editor group would hide the viewer, and a hidden viewer does not refresh.
    const before = viewer.status.entries ?? 0;
    assert.ok(viewer.panel.visible, 'viewer is visible');
    const doc = await vscode.workspace.openTextDocument(path.join(root(), 'main.c'));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(doc.getText().length), '// seen by the viewer\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save());
    await until(() => (viewer.status.entries ?? 0) > before, 15_000);
    // Hidden, it stops refreshing; shown again, it catches up straight away.
    const hiddenBy = await openEditor('other.c');
    assert.ok(!viewer.panel.visible, 'an editor in the same group hides the viewer');
    moveToEnd(hiddenBy);
    await typeText(hiddenBy, '// while the viewer was hidden\n');
    await hiddenBy.document.save();
    const whileHidden = viewer.status.entries ?? 0;
    viewer.panel.reveal();
    await until(() => (viewer.status.entries ?? 0) > whileHidden, 15_000);
    viewer.dispose();
  });

  test('exports a submission zip that opens and matches the code', async () => {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    const exported = await controller.exportFolder(folder);
    assert.match(exported.name, /\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
    const opened = readSubmissionZip(exported.zip);
    assert.ok(opened.logName.endsWith('.codelog'));
    assert.ok(opened.files.some((f) => f.path === 'main.c'));
    const report = verifyLog(opened.log, { submission: opened.files });
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'fail'),
      [],
      JSON.stringify(report.findings, null, 2),
    );
    assert.ok(report.findings.some((f) => f.code === 'SUBMISSION_MATCH'));
    assert.ok(!opened.files.some((f) => f.path === HOW_TO));
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
