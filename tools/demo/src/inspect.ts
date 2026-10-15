/**
 * Runs the real verifier and the viewer's model over a project's log and writes readable
 * outputs: the verification report, a record-by-record dump, the first bytes in hex, stats.
 *
 *   tsx --conditions=source tools/demo/src/inspect.ts <project folder> <output folder>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KIND_NAMES, Kind, readLog, type SubmittedFile, toHex, verifyLog } from '@tap/core';
import { LogLoader } from '../../../packages/ui/src/model/load.js';

const project = path.resolve(process.argv[2] ?? 'project');
const out = path.resolve(process.argv[3] ?? 'log');
fs.mkdirSync(out, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(path.join(project, '.tap', 'log.codelog')));

function walk(dir: string, prefix = ''): SubmittedFile[] {
  const files: SubmittedFile[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === '.tap') continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) files.push(...walk(path.join(dir, e.name), `${rel}/`));
    else files.push({ path: rel, content: new Uint8Array(fs.readFileSync(path.join(dir, e.name))) });
  }
  return files;
}

const submission = walk(project);
const report = verifyLog(bytes, { submission });
const lines: string[] = [];
lines.push(`$ tap-verify project/.tap/log.codelog --submission project/`);
lines.push('');
lines.push(`Verdict: ${report.verdict}`);
for (const f of report.findings) {
  lines.push(`  [${f.severity}] ${f.code}${f.seq !== undefined ? ` @${f.seq}` : ''}: ${f.message}`);
}
const c = report.composition!;
lines.push('');
lines.push(`Final code: ${c.nonWs} non-whitespace characters in ${report.finalFiles.length} files`);
for (const [origin, v] of Object.entries(c.byOrigin).sort((a, b) => b[1]!.nonWs - a[1]!.nonWs)) {
  lines.push(
    `  ${origin.padEnd(14)} ${((100 * v!.nonWs) / c.nonWs).toFixed(1).padStart(5)}%  (${v!.nonWs} chars)`,
  );
}
const s = report.stats;
lines.push('');
lines.push(
  `Stats: ${s.sessions} sessions, ${s.changes} changes, ${s.pastes} pastes, ${s.bulkInserts} tool/AI inserts, ${s.saves} saves, ${s.runs} runs, ${s.checkpoints} signed checkpoints, ${s.pauses} pause(s), ${s.recoveries} crash recovery`,
);
lines.push(
  `Log: ${bytes.length} bytes, ${report.recordCount} records in ${report.blockCount} blocks, key ${report.keys.join(', ')}`,
);
fs.writeFileSync(path.join(out, 'verify-report.txt'), `${lines.join('\n')}\n`);

// Per-file composition from the viewer's model.
const loader = new LogLoader();
loader.reset(bytes);
const model = loader.model();
const table: string[] = [
  'file                     chars  typed  own-copy  outside-paste  tool/AI  outside-editor  starter',
];
for (const f of model.files.filter((x) => !x.deleted)) {
  const comp = f.composition!;
  const pct = (o: string) => {
    const v = comp.byOrigin[o as keyof typeof comp.byOrigin]?.nonWs ?? 0;
    return v ? `${Math.round((100 * v) / comp.nonWs)}%` : '-';
  };
  table.push(
    `${f.path.padEnd(24)} ${String(comp.nonWs).padStart(5)}  ${pct('typed').padStart(5)}  ${pct('internal-copy').padStart(8)}  ${pct('paste').padStart(13)}  ${pct('bulk').padStart(7)}  ${pct('external').padStart(14)}  ${pct('preexisting').padStart(7)}`,
  );
}
fs.writeFileSync(path.join(out, 'composition-per-file.txt'), `${table.join('\n')}\n`);

// Record-by-record dump.
const parsed = readLog(bytes);
const paths = new Map<number, string>();
const dump: string[] = [
  `# ${parsed.records.length} records, ${parsed.blockCount} blocks, ${bytes.length} bytes`,
  `# header: logId ${toHex(parsed.header.logId)}, tool ${parsed.header.tool}`,
  '# seq  local time (UTC+5)    kind            file / details',
];
for (const { record: r } of parsed.records) {
  const b = r.b as Record<string, unknown>;
  if (typeof b.f === 'number' && typeof b.path === 'string') paths.set(b.f, b.path);
  const file = typeof b.f === 'number' ? (paths.get(b.f) ?? `f${b.f}`) : '';
  let detail = '';
  switch (r.k) {
    case Kind.EDIT_BATCH: {
      const ins = r.b.c.reduce((n, ch) => n + ch[3].length, 0);
      const flags = new Set(
        r.b.c.flatMap((ch) => {
          const fl = ch[4] ?? 0;
          return [
            fl & 1 && 'undo',
            fl & 2 && 'redo',
            fl & 4 && 'PASTE',
            fl & 8 && 'BULK',
            fl & 16 && 'multi-cursor',
            fl & 32 && 'format',
          ].filter(Boolean) as string[];
        }),
      );
      detail = `${r.b.c.length} change(s), +${ins} chars${flags.size ? ` [${[...flags].join(', ')}]` : ''}`;
      break;
    }
    case Kind.FILE_SNAPSHOT:
      detail = `origin=${r.b.origin}, ${r.b.text.length} chars`;
      break;
    case Kind.SAVE:
      detail = `${r.b.n} chars, sha256 ${toHex(r.b.h).slice(0, 16)}…`;
      break;
    case Kind.FILE_OP:
      detail = `${r.b.op}${r.b.newPath ? ` → ${r.b.newPath}` : ''} (${r.b.origin})`;
      break;
    case Kind.RUN_START:
      detail = `${r.b.kind} "${r.b.name ?? ''}"`;
      break;
    case Kind.RUN_END:
      detail = `exit ${r.b.exit ?? '?'}`;
      break;
    case Kind.CHECKPOINT:
      detail = `signed, ${r.b.files} files, state ${toHex(r.b.state).slice(0, 16)}…`;
      break;
    case Kind.SESSION_START:
      detail = `${r.b.app} ${r.b.vsc}, recorder ${r.b.ext}, AI extensions: ${r.b.aiExt.join(', ') || 'none'}`;
      break;
    case Kind.SESSION_END:
      detail = r.b.reason;
      break;
    case Kind.NOTE:
      detail = `"${r.b.text}"`;
      break;
    case Kind.PAUSE:
      detail = r.b.why ?? '';
      break;
    case Kind.FOCUS:
      detail = r.b.on ? 'VS Code focused' : 'VS Code lost focus';
      break;
    case Kind.RECOVERY:
      detail = `${r.b.lostBytes} damaged bytes set aside`;
      break;
    default:
      break;
  }
  const t = new Date(r.t + 5 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  dump.push(
    `${String(r.s).padStart(5)}  ${t}  ${KIND_NAMES[r.k]!.padEnd(15)} ${file}${file && detail ? '  ' : ''}${detail}`,
  );
}
fs.writeFileSync(path.join(out, 'log-records.txt'), `${dump.join('\n')}\n`);

// The first bytes, to show the file is binary.
const head: string[] = [];
for (let i = 0; i < 256; i += 16) {
  const row = bytes.subarray(i, i + 16);
  const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
  head.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`);
}
fs.writeFileSync(path.join(out, 'log-first-256-bytes.hex.txt'), `${head.join('\n')}\n`);

const kinds: Record<string, number> = {};
for (const { record } of parsed.records)
  kinds[KIND_NAMES[record.k]!] = (kinds[KIND_NAMES[record.k]!] ?? 0) + 1;
fs.writeFileSync(
  path.join(out, 'stats.json'),
  `${JSON.stringify(
    {
      verdict: report.verdict,
      bytes: bytes.length,
      records: parsed.records.length,
      blocks: parsed.blockCount,
      recordKinds: kinds,
      stats: report.stats,
      composition: report.composition,
      historyEntries: model.history.length,
      events: model.events.length,
    },
    null,
    2,
  )}\n`,
);
console.log(lines.join('\n'));
console.log(`\n${table.join('\n')}`);
