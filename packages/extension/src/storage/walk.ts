import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toLogPath } from '@tap/core';

export const MAX_SCAN_FILES = 50_000;

/**
 * Lists files under `root` (workspace-relative '/' paths) that `isTracked` accepts. Directories
 * that the exclude rules cover entirely are not entered, so node_modules and friends cost
 * nothing. Symbolic links are not followed.
 */
export async function walkFiles(
  root: string,
  isTracked: (rel: string) => boolean,
  options: { limit?: number; firstOnly?: boolean } = {},
): Promise<string[]> {
  const limit = options.limit ?? MAX_SCAN_FILES;
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = toLogPath(relDir ? `${relDir}/${entry.name}` : entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.tap') continue;
        // Skip well-known heavy folders (node_modules, build...) unless the rules would record
        // files inside them. Files are still filtered one by one, so this is only a shortcut.
        if (isHeavyDir(rel) && !isTracked(`${rel}/probe.c`) && !isTracked(`${rel}/probe.py`)) continue;
        stack.push(rel);
      } else if (entry.isFile() && isTracked(rel)) {
        out.push(rel);
        if (options.firstOnly || out.length >= limit) return out.sort();
      }
    }
  }
  return out.sort();
}

const HEAVY_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'build',
  'dist',
  'out',
  'target',
  'bin',
  'obj',
  '.idea',
  '.vscode-test',
  '.pnpm-store',
]);

function isHeavyDir(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  return HEAVY_DIRS.has(name);
}
