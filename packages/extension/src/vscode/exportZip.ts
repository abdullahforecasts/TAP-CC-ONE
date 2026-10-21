/**
 * "TAP: Export for Submission": one .zip with the log, the code it describes and a short
 * explanation for the reader (design §11.4). Also reads such a zip back for "TAP: Open Log File".
 */
import {
  isValidRelPath,
  keyFingerprint,
  readLog,
  type SubmittedFile,
  toLogPath,
  type VerifyReport,
} from '@tap/core';
import { strToU8, unzipSync, type Zippable, zipSync } from 'fflate';

export const HOW_TO = 'HOW-TO-VERIFY.txt';
/** Refuse zips that would expand to more than this (zip bombs). */
const MAX_UNZIPPED = 256 * 1024 * 1024;

export interface ExportInput {
  folderName: string;
  extensionVersion: string;
  log: Uint8Array;
  files: SubmittedFile[];
  report: VerifyReport;
  now: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "<folder>-2026-10-21-0930" (local time). */
export function exportBaseName(folderName: string, now: Date): string {
  const safe = folderName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'code';
  return `${safe}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function howToVerify(input: ExportInput, logName: string): string {
  const { report } = input;
  let key = 'unknown';
  try {
    const starts = readLog(input.log).records.filter((r) => r.record.k === 1);
    const last = starts[starts.length - 1]?.record;
    if (last && last.k === 1) key = keyFingerprint(last.b.pub);
  } catch {
    // the report below says what is wrong
  }
  const a = report.anchoring;
  const verdict = report.verdict.replace(/_/g, ' ').toLowerCase();
  const timestamps =
    a && a.anchoredCheckpoints > 0
      ? `${a.anchoredCheckpoints} of ${a.checkpoints} checkpoints were timestamped by independent services; ${Math.floor(a.coverage * 100)}% of the edits are covered.`
      : 'No independent timestamps yet (offline?): the times come from the computer clock only.';
  return [
    `TAP-CC-ONE submission: ${input.folderName}`,
    `Exported ${localStamp(input.now)} (computer time; ${input.now.toISOString().slice(0, 16).replace('T', ' ')} UTC) by TAP-CC-ONE ${input.extensionVersion}`,
    `Signing key fingerprint: ${key}`,
    '',
    'What is in this zip',
    `- ${logName}: the authorship log. It records how the code below was written: every change`,
    '  with its time, saves, runs, pastes, inserts by tools or AI, and changes made outside the editor.',
    '  It is hash-chained, signed, and timestamped by independent services.',
    `- ${input.files.length} code file(s), exactly as they were at export.`,
    '',
    'How to check it',
    '1. Install the TAP-CC-ONE extension in VS Code:',
    '   https://github.com/abdullahforecasts/TAP-CC-ONE',
    '2. In VS Code, run "TAP: Open Log File..." and choose this zip (no need to unzip it).',
    '   The viewer checks the log, compares it with the code in the zip, and shows Save History,',
    '   a replay of every file, a timeline and how the final code arrived.',
    "3. To be sure the log was made on the student's own computer, ask them to run",
    '   "TAP: Show Key Fingerprint" and compare it with the fingerprint above.',
    '',
    `Check at export: ${verdict}. ${timestamps}`,
    '',
    'The log shows how the code was written. It is evidence for a person to interpret, not a verdict.',
    '',
  ].join('\r\n');
}

/** Builds the submission zip. Paths inside are the folder-relative paths of the code. */
export function buildSubmissionZip(input: ExportInput): { zip: Uint8Array; name: string } {
  const base = exportBaseName(input.folderName, input.now);
  const logName = `${base}.codelog`;
  const entries: Zippable = {};
  const mtime = input.now;
  for (const f of input.files) {
    const content = typeof f.content === 'string' ? strToU8(f.content) : f.content;
    entries[f.path] = [content, { mtime }];
  }
  entries[logName] = [input.log, { mtime, level: 0 }];
  entries[HOW_TO] = [strToU8(howToVerify(input, logName)), { mtime }];
  return { zip: zipSync(entries, { level: 6 }), name: `${base}.zip` };
}

export interface OpenedSubmission {
  log: Uint8Array;
  logName: string;
  files: SubmittedFile[];
}

/** Reads a submission zip: the .codelog and the code next to it. */
export function readSubmissionZip(zip: Uint8Array): OpenedSubmission {
  let total = 0;
  const entries = unzipSync(zip, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error('the zip is too large to open');
      return !f.name.endsWith('/');
    },
  });
  const names = Object.keys(entries);
  const logs = names
    .filter((n) => n.toLowerCase().endsWith('.codelog'))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  if (logs.length === 0) throw new Error('the zip has no .codelog file');
  const logName = logs[0]!;
  // Code paths are relative to the folder holding the log (zips made by hand often add a folder).
  // A zipped project folder keeps its log at .tap/log.codelog; the code is next to .tap/.
  const inTap = /(^|\/)\.tap\/log\.codelog$/.test(logName);
  const logDir = logName.includes('/') ? logName.slice(0, logName.lastIndexOf('/') + 1) : '';
  const prefix = inTap ? logDir.slice(0, -'.tap/'.length) : logDir;
  const files: SubmittedFile[] = [];
  for (const name of names) {
    if (name === logName || !name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (rel === HOW_TO || rel.startsWith('.tap/') || rel.startsWith('__MACOSX/')) continue;
    const path = toLogPath(rel);
    // Skip names that are not usable relative paths (absolute, "..", ...).
    if (isValidRelPath(path)) files.push({ path, content: entries[name]! });
  }
  return { log: entries[logName]!, logName, files };
}
