/**
 * Everything open in the window that is not a file of the recorded folder (F1, D5-D8): files from
 * other folders, unsaved editors, web pages (Simple Browser), notebooks, other tabs and terminals.
 * Only names are recorded (a file's base name, a tab's label), never contents or full paths.
 */
import * as path from 'node:path';
import { type OpenItem, tabTitle } from '@tap/core';
import * as vscode from 'vscode';

/** Tabs that are part of VS Code itself and say nothing about the work. */
const NOISE =
  /^(Welcome|Settings|Keyboard Shortcuts|Release Notes|Running Extensions|Extension: .*|Walkthrough.*|Log: .*)$/;

/**
 * `place` says where a URI is: 'recorded' (a file of the folder recorded as text, or TAP's own),
 * a folder-relative path (a file of the folder that is not recorded as text: an image, a PDF...),
 * or undefined (outside the folder).
 */
export function currentOpenItems(
  place: (uri: vscode.Uri) => 'recorded' | { rel: string } | undefined,
  monitored: (terminal: vscode.Terminal) => boolean | undefined,
  aiNames: readonly string[] = [],
): OpenItem[] {
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = aiNames.map(squash).filter((n) => n.length >= 4);
  const isAi = (...texts: string[]) => {
    const t = squash(texts.join(' '));
    return names.some((n) => t.includes(n));
  };
  const isRecorded = (uri: vscode.Uri) => place(uri) === 'recorded';
  const inside = (uri: vscode.Uri) => {
    const p = place(uri);
    return typeof p === 'object' ? p.rel : undefined;
  };
  const items = new Map<string, OpenItem>();
  const add = (item: OpenItem) => {
    const name = (item.k === 'other' || item.k === 'web' ? tabTitle(item.name) : item.name).slice(0, 300);
    const key = `${item.in ? 'in' : item.k}\u0000${name}`;
    const prev = items.get(key);
    const merged: OpenItem = { ...item, name };
    if (prev?.vis) merged.vis = true;
    if (prev?.ai) merged.ai = true;
    if (!merged.vis) delete merged.vis;
    items.set(key, merged);
  };
  const fromUri = (uri: vscode.Uri, label: string, vis: boolean, notebook = false) => {
    if (isRecorded(uri)) return;
    const rel = inside(uri);
    if (rel !== undefined) {
      add({ k: notebook ? 'notebook' : 'file', name: rel, vis, in: true });
      return;
    }
    if (uri.scheme === 'untitled') add({ k: 'untitled', name: label, vis });
    else if (uri.scheme === 'file')
      add({ k: notebook ? 'notebook' : 'file', name: path.basename(uri.fsPath), vis });
    else if (uri.scheme === 'vscode-notebook-cell' || notebook) add({ k: 'notebook', name: label, vis });
  };
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const vis = tab.isActive;
      const input = tab.input;
      if (input instanceof vscode.TabInputText) fromUri(input.uri, tab.label, vis);
      else if (input instanceof vscode.TabInputTextDiff) fromUri(input.modified, tab.label, vis);
      else if (input instanceof vscode.TabInputNotebook) fromUri(input.uri, tab.label, vis, true);
      else if (input instanceof vscode.TabInputNotebookDiff) fromUri(input.modified, tab.label, vis, true);
      else if (input instanceof vscode.TabInputCustom) {
        // Image previews, PDF viewers and other custom editors.
        const rel = inside(input.uri);
        if (rel !== undefined) add({ k: 'file', name: rel, vis, in: true });
        else if (!isRecorded(input.uri)) add({ k: 'other', name: tab.label, vis });
      } else if (input instanceof vscode.TabInputWebview) {
        if (input.viewType.includes('tap.viewer')) continue;
        const web = /simpleBrowser|browser|preview/i.test(input.viewType);
        const item: OpenItem = { k: web ? 'web' : 'other', name: tab.label, vis };
        // A panel of an AI extension (its chat, its agent sessions...).
        if (isAi(input.viewType, tab.label)) item.ai = true;
        add(item);
      } else if (input instanceof vscode.TabInputTerminal) {
        // terminals are listed below
      } else if (!NOISE.test(tab.label)) {
        // Chat editors, interactive windows and other tabs without a public input type.
        add({ k: 'other', name: tab.label, vis, ...(isAi(tab.label) ? { ai: true } : {}) });
      }
    }
  }
  for (const terminal of vscode.window.terminals) {
    const item: OpenItem = { k: 'terminal', name: terminal.name };
    if (vscode.window.activeTerminal === terminal) item.vis = true;
    const mon = monitored(terminal);
    if (mon !== undefined) item.mon = mon;
    add(item);
  }
  return [...items.values()].sort((a, b) => (a.k + a.name).localeCompare(b.k + b.name));
}
