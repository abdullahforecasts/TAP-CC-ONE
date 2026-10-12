import { compareBytes, utf8 } from './bytes.js';

/**
 * Workspace-relative paths (spec §5.5): '/'-separated, non-empty segments, no '.' or '..'
 * segments, no leading '/', no backslashes, no NUL, no Windows drive prefix.
 * Returns an error description, or undefined when the path is valid.
 */
export function relPathError(path: string): string | undefined {
  if (path.length === 0) return 'empty path';
  if (path.length > 4096) return 'path longer than 4096 characters';
  if (path.includes('\\')) return 'backslash in path (use "/")';
  if (path.includes('\0')) return 'NUL character in path';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(path)) return 'drive-letter path';
  for (const seg of path.split('/')) {
    if (seg === '') return 'empty path segment';
    if (seg === '.' || seg === '..') return `"${seg}" segment`;
  }
  return undefined;
}

export function isValidRelPath(path: string): boolean {
  return relPathError(path) === undefined;
}

/** Path ordering used by the state digest: bytewise on UTF-8 (spec §6.3). */
export function comparePaths(a: string, b: string): number {
  return compareBytes(utf8(a), utf8(b));
}

/** Converts an OS path relative to the workspace into the log's path form. */
export function toLogPath(osRelativePath: string): string {
  return osRelativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
