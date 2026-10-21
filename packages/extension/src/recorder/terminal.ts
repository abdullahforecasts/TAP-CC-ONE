/**
 * Terminal commands (design §6.1 runs): what is stored for a command typed in VS Code's terminal.
 * The full command line is kept, with obvious secrets replaced by "***" before it is logged.
 */

const MAX_CMD = 8000;

const SECRET_WORD =
  '(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|apikey|auth(?:orization)?|access[-_]?key|private[-_]?key|client[-_]?secret|credentials?)';

const RULES: Array<[RegExp, string]> = [
  // --password=x, --token x, -p:x style options named like secrets
  [new RegExp(`(--?[\\w-]*${SECRET_WORD}[\\w-]*)(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1$2***'],
  // ENV_VAR=value assignments named like secrets (incl. PowerShell $env:X="y")
  [
    new RegExp(`((?:\\$env:)?[A-Za-z_]*${SECRET_WORD}[A-Za-z0-9_]*\\s*=\\s*)("[^"]*"|'[^']*'|\\S+)`, 'gi'),
    '$1***',
  ],
  // user:password@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1***@'],
  // Authorization headers
  [/(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // Well-known token shapes
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '***'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***'],
];

/** The command line as stored: secrets masked, at most 8000 characters. */
export function maskCommand(commandLine: string): string {
  let s = commandLine.trim();
  for (const [re, replacement] of RULES) s = s.replace(re, replacement);
  if ([...s].length > MAX_CMD) s = `${[...s].slice(0, MAX_CMD - 1).join('')}…`;
  return s;
}

/** Program name of a command line: "g++" for "g++ -Wall main.cpp", "python" for "python3 x.py". */
export function programName(commandLine: string): string | undefined {
  const m = commandLine.trim().match(/^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const first = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!first) return undefined;
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').slice(0, 500) || undefined;
}
