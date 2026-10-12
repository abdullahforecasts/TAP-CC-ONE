import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '@tap/core';
import picomatch from 'picomatch';

export interface FolderConfig {
  version: 1;
  label: string;
  include: string[];
  exclude: string[];
  maxFileSizeKB: number;
}

export const TAP_DIR = '.tap';
export const CONFIG_FILE = 'config.json';

/** Always excluded, whatever the configuration says. */
const ALWAYS_EXCLUDED = ['.tap/**', '**/.git/**'];

export function configPathOf(folder: string): string {
  return path.join(folder, TAP_DIR, CONFIG_FILE);
}

export function hasConfig(folder: string): boolean {
  return fs.existsSync(configPathOf(folder));
}

export interface LoadedConfig {
  config: FolderConfig;
  /** SHA-256 of the config file bytes (recorded as cfgHash). */
  hash: Uint8Array;
}

/** Creates .tap/ with config.json and .gitignore (design §11.2). */
export function createConfig(folder: string, defaults: Omit<FolderConfig, 'version'>): LoadedConfig {
  const tapDir = path.join(folder, TAP_DIR);
  fs.mkdirSync(tapDir, { recursive: true });
  const config: FolderConfig = { version: 1, ...defaults };
  fs.writeFileSync(configPathOf(folder), `${JSON.stringify(config, null, 2)}\n`);
  const gitignore = path.join(tapDir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, 'lock\nquarantine/\n');
  return loadConfig(folder);
}

export function loadConfig(folder: string): LoadedConfig {
  const bytes = fs.readFileSync(configPathOf(folder));
  const raw = JSON.parse(bytes.toString('utf8')) as Partial<FolderConfig>;
  const strings = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback;
  const config: FolderConfig = {
    version: 1,
    label:
      typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.slice(0, 200) : path.basename(folder),
    include: strings(raw.include, ['**/*']),
    exclude: strings(raw.exclude, []),
    maxFileSizeKB:
      typeof raw.maxFileSizeKB === 'number' && raw.maxFileSizeKB > 0
        ? Math.min(raw.maxFileSizeKB, 4096)
        : 1024,
  };
  return { config, hash: sha256(new Uint8Array(bytes)) };
}

/** Builds the include/exclude matcher for workspace-relative '/' paths. */
export function createMatcher(config: FolderConfig): (rel: string) => boolean {
  const options = { dot: true, nocase: process.platform === 'win32' || process.platform === 'darwin' };
  const include = picomatch(config.include, options);
  const exclude = picomatch([...ALWAYS_EXCLUDED, ...config.exclude], options);
  return (rel: string) => rel.length > 0 && include(rel) && !exclude(rel);
}
