/**
 * What the editor could insert besides the student's typing (F2, G1): suggestion settings, user
 * snippets and keybindings that type text, and the AI state. Only counts and settings are
 * recorded, never the snippets themselves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AiState } from '@tap/core';
import * as vscode from 'vscode';
import { aiStateOf, type ExtensionFacts, toolKind } from '../recorder/environment.js';

type Flat = Record<string, boolean | number | string>;

/** Suggestion and terminal settings that change what can be inserted or monitored. */
export function editorSettings(folder: vscode.Uri): Flat {
  const ed = vscode.workspace.getConfiguration('editor', folder);
  const term = vscode.workspace.getConfiguration('terminal.integrated', folder);
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).slice(0, 200);
  return {
    'editor.inlineSuggest.enabled': ed.get<boolean>('inlineSuggest.enabled', true),
    'editor.wordBasedSuggestions': str(ed.get('wordBasedSuggestions', 'matchingDocuments')),
    'editor.snippetSuggestions': str(ed.get('snippetSuggestions', 'inline')),
    'editor.tabCompletion': str(ed.get('tabCompletion', 'off')),
    'editor.quickSuggestions': str(ed.get('quickSuggestions')),
    'terminal.integrated.shellIntegration.enabled': term.get<boolean>('shellIntegration.enabled', true),
  };
}

/** Strips // and /* *\/ comments and trailing commas (enough for VS Code's JSONC files). */
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const listDir = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Counts user snippets and keybindings that type text, from VS Code's User folder (all profiles)
 * and the folder's own .vscode/*.code-snippets. `globalStorage` is the extension's global
 * storage folder (<User>/globalStorage/<extension id>).
 */
export function userCustomizations(globalStorage: string, folder: string): Flat {
  const user = path.dirname(path.dirname(globalStorage));
  const roots = [user, ...listDir(path.join(user, 'profiles')).map((p) => path.join(user, 'profiles', p))];
  let snippetFiles = 0;
  let snippets = 0;
  let snippetChars = 0;
  let typeKeybindings = 0;
  const countSnippets = (file: string) => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      snippetFiles++;
      snippetChars += text.length;
      const parsed = parseJsonc(text);
      if (parsed && typeof parsed === 'object') snippets += Object.keys(parsed).length;
    } catch {
      // unreadable or not JSON: still counted by size above when read
    }
  };
  for (const root of roots) {
    const dir = path.join(root, 'snippets');
    for (const name of listDir(dir)) {
      if (/\.(json|code-snippets)$/i.test(name)) countSnippets(path.join(dir, name));
    }
    try {
      const kb = fs.readFileSync(path.join(root, 'keybindings.json'), 'utf8');
      typeKeybindings += (kb.match(/"command"\s*:\s*"type"/g) ?? []).length;
    } catch {
      // no keybindings file
    }
  }
  const wsDir = path.join(folder, '.vscode');
  for (const name of listDir(wsDir)) {
    if (/\.code-snippets$/i.test(name)) countSnippets(path.join(wsDir, name));
  }
  return { snippetFiles, snippets, snippetChars, typeKeybindings };
}

/** What an installed, enabled extension says about itself. */
export function extensionFacts(e: vscode.Extension<unknown>): ExtensionFacts {
  const pkg = (e.packageJSON ?? {}) as {
    isBuiltin?: boolean;
    displayName?: string;
    description?: string;
    categories?: unknown;
    keywords?: unknown;
    contributes?: Record<string, unknown>;
  };
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const contributes = pkg.contributes ?? {};
  const facts: ExtensionFacts = {
    id: e.id.toLowerCase(),
    builtin: pkg.isBuiltin === true || e.id.toLowerCase().startsWith('vscode.'),
    categories: strings(pkg.categories),
    keywords: strings(pkg.keywords),
    contributesAi: [
      'chatParticipants',
      'languageModelTools',
      'languageModels',
      'languageModelChatProviders',
    ].some((k) => contributes[k] !== undefined),
    contributesTerminal: contributes.terminal !== undefined,
  };
  if (typeof pkg.displayName === 'string') facts.displayName = pkg.displayName;
  if (typeof pkg.description === 'string') facts.description = pkg.description;
  return facts;
}

/** Installed, enabled extensions that are not part of VS Code, with what they are (0.3.5). */
export function installedExtensions(): Array<{
  id: string;
  kind: 'ai' | 'terminal' | undefined;
  active: boolean;
  names: string[];
}> {
  const out = [];
  for (const e of vscode.extensions.all) {
    const facts = extensionFacts(e);
    if (facts.builtin) continue;
    const short = facts.id.split('.')[1] ?? facts.id;
    out.push({
      id: facts.id,
      kind: toolKind(facts),
      active: e.isActive,
      names: [short, facts.displayName ?? ''].filter((n) => n.length > 0),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The AI state right now (G1, G3; third-party assistants count since 0.3.5). */
export function currentAiState(folder: vscode.Uri): AiState {
  const ed = vscode.workspace.getConfiguration('editor', folder);
  const chat = vscode.workspace.getConfiguration('chat', folder);
  const copilot = vscode.workspace
    .getConfiguration('github.copilot', folder)
    .get<Record<string, boolean>>('enable');
  const ai = installedExtensions().filter((e) => e.kind === 'ai');
  return aiStateOf({
    inlineSuggest: ed.get<boolean>('inlineSuggest.enabled', true),
    disableAiFeatures: chat.get<boolean>('disableAIFeatures', false),
    copilotEnabled: copilot?.['*'] !== false,
    installed: ai.map((e) => e.id),
    active: ai.filter((e) => e.active).map((e) => e.id),
  });
}
