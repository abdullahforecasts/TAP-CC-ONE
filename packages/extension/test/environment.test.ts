import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiStateOf, toolKind } from '../src/recorder/environment.js';
import { describeAsset, isTapOwnFile, scanAssets } from '../src/storage/assets.js';

describe('AI and terminal extensions (0.3.5)', () => {
  it('recognises AI assistants by list, marketplace category, contributions and keywords', () => {
    expect(toolKind({ id: 'kilocode.kilo-code', builtin: false })).toBe('ai');
    expect(toolKind({ id: 'someone.new-helper', builtin: false, categories: ['AI', 'Other'] })).toBe('ai');
    expect(toolKind({ id: 'someone.helper2', builtin: false, contributesAi: true })).toBe('ai');
    expect(toolKind({ id: 'someone.helper3', builtin: false, keywords: ['llm', 'agent'] })).toBe('ai');
    expect(toolKind({ id: 'ms-python.python', builtin: false, categories: ['Programming Languages'] })).toBe(
      undefined,
    );
    expect(toolKind({ id: 'vscode.github', builtin: true, categories: ['AI'] })).toBe(undefined);
    expect(toolKind({ id: 'abdullahforecasts.tap-cc-one', builtin: false, keywords: ['ai'] })).toBe(
      undefined,
    );
  });

  it('recognises extensions with a terminal of their own, but not language support', () => {
    expect(toolKind({ id: 'someone.portaterm', builtin: false, displayName: 'Portaterm' })).toBe('terminal');
    expect(toolKind({ id: 'someone.shells', builtin: false, contributesTerminal: true })).toBe('terminal');
    expect(toolKind({ id: 'ms-vscode.powershell', builtin: false, contributesTerminal: true })).toBe(
      undefined,
    );
    expect(toolKind({ id: 'formulahendry.code-runner', builtin: false, displayName: 'Code Runner' })).toBe(
      undefined,
    );
    expect(toolKind({ id: 'usernamehw.errorlens', builtin: false, displayName: 'Error Lens' })).toBe(
      undefined,
    );
  });

  it('counts a third-party assistant as AI on even when VS Code AI features are off', () => {
    const base = { inlineSuggest: false, disableAiFeatures: true, copilotEnabled: false, active: [] };
    expect(aiStateOf({ ...base, installed: ['github.copilot-chat'] }).on).toBe(false);
    expect(aiStateOf({ ...base, installed: ['github.copilot-chat', 'kilocode.kilo-code'] }).on).toBe(true);
    expect(aiStateOf({ ...base, installed: [] }).on).toBe(false);
    expect(aiStateOf({ ...base, inlineSuggest: true, installed: ['codeium.codeium'] }).inline).toBe(true);
  });
});

describe('files TAP does not record (0.3.5)', () => {
  it('lists stray files in .tap/ and code in build output, not TAP files or dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-assets-'));
    const put = (rel: string, text = 'int main() {}\n') => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    put('.tap/log.codelog', 'x');
    put('.tap/config.json', '{}');
    put('.tap/lock', '{}');
    put('.tap/quarantine/tail-1.bin', 'x');
    put('.tap/x.cpp');
    put('build/main.cpp');
    put('build/app.o', '\u0000\u0001');
    put('node_modules/pkg/index.js');
    put('main.cpp');
    const tracked = (rel: string) => /\.cpp$/.test(rel) && !rel.includes('/');
    const found = scanAssets(root, tracked).map((a) => [a.p, a.skipped ?? false]);
    expect(found).toEqual([
      ['.tap/x.cpp', true],
      ['build/main.cpp', true],
    ]);
    expect(isTapOwnFile('.tap/log.codelog')).toBe(true);
    expect(isTapOwnFile('.tap/notes.cpp')).toBe(false);
    expect(describeAsset(root, '.tap/config.json', tracked)).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
