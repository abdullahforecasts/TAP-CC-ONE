/**
 * The folder's tracked files as they are now — the editor's text for open documents, the disk
 * otherwise — for comparing with the log (TAP: Verify Log Integrity and the viewer).
 */
import * as path from 'node:path';
import type { SubmittedFile } from '@tap/core';
import * as vscode from 'vscode';
import { readTrackedFile } from '../storage/diskReader.js';
import { createMatcher, loadConfig } from '../storage/folderConfig.js';
import { walkFiles } from '../storage/walk.js';

export const COMPARED_WITH = 'the files in this folder';

export async function workspaceFiles(root: string): Promise<SubmittedFile[]> {
  const { config } = loadConfig(root);
  const matcher = createMatcher(config);
  const open = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && !doc.isClosed) open.set(path.normalize(doc.uri.fsPath), doc.getText());
  }
  const files: SubmittedFile[] = [];
  for (const rel of await walkFiles(root, matcher)) {
    const abs = path.normalize(path.join(root, ...rel.split('/')));
    const text = open.get(abs);
    if (text !== undefined) {
      files.push({ path: rel, content: text });
      continue;
    }
    const read = await readTrackedFile(abs, config.maxFileSizeKB * 1024);
    if (read.kind === 'text') files.push({ path: rel, content: read.text });
  }
  return files;
}
