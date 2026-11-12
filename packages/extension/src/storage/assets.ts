/**
 * Files in the recorded folder that are not recorded as text (0.3.4): images, PDFs, documents,
 * archives, media, and small text files outside the include patterns. A screenshot of code or a
 * PDF of a solution can be read and retyped; the log records that such a file was there (name,
 * size, SHA-256), and the export ships it with the code so a reader can look at it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Asset, AssetKind } from '@tap/core';

/** Folders never scanned (dependencies, build output, version control, TAP itself). */
const SKIP_DIRS = new Set([
  '.git',
  '.tap',
  '.hg',
  '.svn',
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
  '.gradle',
  '.next',
  '.cache',
]);

const KINDS: Record<string, AssetKind> = {};
for (const ext of [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'svg',
  'tif',
  'tiff',
  'heic',
  'heif',
  'ico',
  'avif',
])
  KINDS[ext] = 'image';
KINDS.pdf = 'pdf';
for (const ext of [
  'doc',
  'docx',
  'odt',
  'rtf',
  'ppt',
  'pptx',
  'odp',
  'xls',
  'xlsx',
  'ods',
  'epub',
  'pages',
  'key',
])
  KINDS[ext] = 'document';
for (const ext of ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']) KINDS[ext] = 'archive';
for (const ext of ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'ogg']) KINDS[ext] = 'media';

/** Files TAP itself keeps in .tap/; anything else there is a stray file (0.3.5). */
export function isTapOwnFile(rel: string): boolean {
  return (
    /^\.tap\/(log\.codelog|config\.json|lock|\.gitignore)$/.test(rel) || rel.startsWith('.tap/quarantine/')
  );
}

/**
 * Folders TAP does not record that a student can still write code in: TAP's own folder and build
 * output. Dependency and tool folders (node_modules, .git, .venv...) are not looked into.
 */
const WRITABLE_SKIPPED = new Set(['.tap', 'build', 'dist', 'out', 'target', 'bin', 'obj']);

/** Source-code extensions: such a file in a folder TAP skips is listed whatever its size. */
const CODE_EXT =
  /\.(c|h|cpp|cc|cxx|hpp|hh|hxx|py|pyw|ipynb|java|kt|kts|js|jsx|mjs|cjs|ts|tsx|cs|go|rs|rb|php|swift|m|mm|sql|html|htm|css|scss|sh|bash|ps1|r|jl|hs|ml|scala|lua|dart|asm|s|txt|md)$/i;

/** Files larger than this are listed without a hash and not copied into the export. */
export const ASSET_HASH_MAX = 25 * 1024 * 1024;
/** Text files outside the include patterns are listed up to this size. */
const OTHER_TEXT_MAX = 1024 * 1024;
/** At most this many files are listed per scan. */
export const ASSET_SCAN_MAX = 500;
/** At most this many directory entries are visited per scan (a whole home folder stays cheap). */
const SCAN_VISIT_MAX = 20_000;

/** The kind of a file that is not recorded as text, or undefined when it is not listed. */
export function assetKind(file: string, size: number, head?: () => Uint8Array): AssetKind | undefined {
  const ext = path.extname(file).slice(1).toLowerCase();
  const kind = KINDS[ext];
  if (kind) return kind;
  // Small text files (notes.csv, code.dat, a file without extension) can hold code too;
  // binaries such as compiled programs (a.out, .o, .exe) are not listed.
  if (size === 0 || size > OTHER_TEXT_MAX) return undefined;
  const bytes = head?.();
  if (!bytes || bytes.includes(0)) return undefined;
  return 'other';
}

function readHead(abs: string): Uint8Array {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = new Uint8Array(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(abs: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(fs.readFileSync(abs)).digest());
}

/** Describes one file, or undefined when it is not listed (code, binary, gone...). */
export function describeAsset(
  root: string,
  rel: string,
  isTracked: (rel: string) => boolean,
): Asset | undefined {
  if (isTracked(rel)) return undefined;
  const dirs = rel.split('/').slice(0, -1);
  // In a folder TAP skips, only stray files in .tap/ and code in build output are listed.
  const skippedDirs = dirs.filter((d) => SKIP_DIRS.has(d));
  let skipped = false;
  if (skippedDirs.length > 0) {
    if (skippedDirs.some((d) => !WRITABLE_SKIPPED.has(d))) return undefined;
    if (dirs[0] === '.tap' ? isTapOwnFile(rel) : !CODE_EXT.test(rel)) return undefined;
    skipped = true;
  }
  const abs = path.join(root, ...rel.split('/'));
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  let kind: AssetKind | undefined;
  try {
    kind = assetKind(rel, st.size, () => readHead(abs));
  } catch {
    return undefined;
  }
  if (!kind && skipped) kind = 'other';
  if (!kind) return undefined;
  const asset: Asset = { p: rel, n: st.size, k: kind };
  if (skipped) asset.skipped = true;
  if (st.size <= ASSET_HASH_MAX) {
    try {
      asset.h = sha256File(abs);
    } catch {
      // unreadable: listed without a hash
    }
  }
  return asset;
}

/** Lists the folder's files that are not recorded as text (sorted, at most ASSET_SCAN_MAX). */
export function scanAssets(root: string, isTracked: (rel: string) => boolean): Asset[] {
  const out: Asset[] = [];
  let visited = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 8 || out.length >= ASSET_SCAN_MAX || visited >= SCAN_VISIT_MAX) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= ASSET_SCAN_MAX || ++visited >= SCAN_VISIT_MAX) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) || WRITABLE_SKIPPED.has(e.name))
          walk(path.join(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        const a = describeAsset(root, rel, isTracked);
        if (a) out.push(a);
      }
    }
  };
  walk(root, '', 0);
  return out;
}

export function sameAsset(a: Asset, b: Asset): boolean {
  if (a.n !== b.n || a.k !== b.k) return false;
  if (!a.h || !b.h) return true;
  return a.h.length === b.h.length && a.h.every((x, i) => x === b.h![i]);
}
