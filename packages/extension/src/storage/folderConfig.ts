import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '@tap/core';
import picomatch from 'picomatch';

/**
 * A teacher's rules for a recorded folder (exam mode, 0.3.3), set in .tap/config.json:
 *   "policy": { "ai": "off", "suggestions": "off", "lockSettings": true, "requireShellIntegration": true }
 * The config file's hash is in every SESSION_START, so a student who edits it is visible.
 */
export interface FolderPolicy {
  /** off: AI features are turned off without asking; ask (default): the student chooses; on: no question. */
  ai: 'off' | 'ask' | 'on';
  /** off: word-based, snippet and tab-completion suggestions are turned off for the folder. */
  suggestions: 'off' | 'on';
  /** The recorder ignores the student's TAP settings and uses the defaults. */
  lockSettings: boolean;
  /** Terminal shell integration is turned on so commands and output can be recorded. */
  requireShellIntegration: boolean;
  /**
   * With AI off (0.3.5): "block-ai" (default) turns off AI and terminal extensions; "allowlist"
   * turns off every extension except TAP-CC-ONE and `allowExtensions`.
   */
  extensions?: 'block-ai' | 'allowlist';
  /** Extension ids never turned off (e.g. "ms-vscode.cpptools"). */
  allowExtensions?: string[];
}

export const DEFAULT_POLICY: FolderPolicy = {
  ai: 'ask',
  suggestions: 'on',
  lockSettings: false,
  requireShellIntegration: false,
};

export interface FolderConfig {
  version: 1;
  label: string;
  include: string[];
  exclude: string[];
  maxFileSizeKB: number;
  policy?: FolderPolicy;
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
  const policy = parsePolicy((raw as { policy?: unknown }).policy);
  if (policy) config.policy = policy;
  return { config, hash: sha256(new Uint8Array(bytes)) };
}

/** The policy object of a config file, or undefined when there is none. */
export function parsePolicy(v: unknown): FolderPolicy | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const p = v as Record<string, unknown>;
  return {
    ai: p.ai === 'off' || p.ai === 'on' ? p.ai : 'ask',
    suggestions: p.suggestions === 'off' ? 'off' : 'on',
    lockSettings: p.lockSettings === true,
    requireShellIntegration: p.requireShellIntegration === true,
    ...(p.extensions === 'allowlist' ? { extensions: 'allowlist' as const } : {}),
    ...(Array.isArray(p.allowExtensions)
      ? {
          allowExtensions: p.allowExtensions
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.toLowerCase())
            .slice(0, 200),
        }
      : {}),
  };
}

/** Builds the include/exclude matcher for workspace-relative '/' paths. */
export function createMatcher(config: FolderConfig): (rel: string) => boolean {
  const options = { dot: true, nocase: process.platform === 'win32' || process.platform === 'darwin' };
  const include = picomatch(config.include, options);
  const exclude = picomatch([...ALWAYS_EXCLUDED, ...config.exclude], options);
  return (rel: string) => rel.length > 0 && include(rel) && !exclude(rel);
}
