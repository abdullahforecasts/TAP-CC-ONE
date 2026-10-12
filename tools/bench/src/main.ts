/**
 * Core benchmark: simulates the 4-hour DSA assignment from design.md §2.5 (5 problems plus a
 * Vector class, ~35,000 changes, ~120 saves) and measures writer, file size, reading and full
 * verification.
 *
 *   pnpm bench            # print results
 *   pnpm bench --assert   # also fail if a budget is exceeded (used in CI)
 */
import { performance } from 'node:perf_hooks';
import {
  type ChangeTuple,
  contentHash,
  Flag,
  keyPairFromSeed,
  LogWriter,
  readLog,
  sha256,
  utf8,
  verifyLog,
} from '@tap/core';

// Budgets for the core library on a mid-range laptop; generous so CI noise does not flake.
const BUDGET = {
  appendPerChangeUs: 50, // writer append + replay, amortised per change
  verifyMs: 4000, // full verification of the whole session
  sizeKB: 600, // log size for the session (design estimate: 120–200 KB)
};

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = [
  '3sum.cpp',
  'longest_substring.cpp',
  'group_anagrams.cpp',
  'top_k.cpp',
  'product.cpp',
  'vector.h',
  'main.cpp',
];
const TOKENS = [
  'int ',
  'for (',
  'i++',
  ') {',
  '\n',
  '  ',
  'return ',
  ';',
  'vec',
  'size_',
  ' = ',
  '[i]',
  '}',
  'std::',
  'push_back',
];

function simulate() {
  const rand = rng(42);
  const key = keyPairFromSeed(sha256(utf8('bench-key')));
  const w = LogWriter.create({ created: 0, tool: 'bench', label: 'dsa-4h' });
  let t = Date.UTC(2026, 9, 12, 9);
  let m = 0;
  const time = () => ({ t, m });
  w.append(
    'SESSION_START',
    {
      sid: new Uint8Array(16),
      pub: key.publicKey,
      vsc: '1.105.0',
      app: 'vscode',
      os: 'linux',
      ext: '0.1.0',
      aiExt: [],
      liveShare: false,
      cfgHash: new Uint8Array(32),
    },
    time(),
  );
  FILES.forEach((path, f) => {
    w.append('FILE_OP', { op: 'create', f, path, origin: 'editor' }, time());
  });

  const TOTAL_CHANGES = 35_000;
  let changes = 0;
  let saves = 0;
  let records = 0;
  let appendMs = 0;
  let lastCheckpoint = t;
  const out: Uint8Array[] = [];
  while (changes < TOTAL_CHANGES) {
    const f = Math.min(FILES.length - 1, Math.floor((changes / TOTAL_CHANGES) * FILES.length));
    const text = w.state.files.get(f)!.text;
    let len = text.length;
    let cursor = Math.floor(rand() * (len + 1));
    const batch: ChangeTuple[] = [];
    let elapsed = 0;
    while (elapsed < 2000 && changes < TOTAL_CHANGES) {
      const dt = 60 + Math.floor(rand() * 250);
      elapsed += dt;
      const r = rand();
      if (r < 0.15 && cursor > 0) {
        batch.push([dt, cursor - 1, 1, '']); // backspace
        cursor--;
        len--;
      } else if (r < 0.155) {
        const ins = 'for (int i = 0; i < n; i++) {\n    sum += a[i];\n}\n';
        batch.push([dt, cursor, 0, ins, Flag.PASTE]);
        cursor += ins.length;
        len += ins.length;
      } else {
        const ins = TOKENS[Math.floor(rand() * TOKENS.length)]![0]!; // one character at a time
        batch.push([dt, cursor, 0, ins]);
        cursor++;
        len++;
      }
      changes++;
    }
    t += elapsed;
    m += elapsed;
    const t0 = performance.now();
    w.append('EDIT_BATCH', { f, c: batch }, time());
    records++;
    if (rand() < 0.05) {
      const doc = w.state.files.get(f)!.text;
      w.append('SAVE', { f, h: contentHash(doc), n: doc.length }, time());
      saves++;
      records++;
    }
    if (t - lastCheckpoint >= 300_000) {
      w.appendCheckpoint(key.secretKey, time());
      lastCheckpoint = t;
      records++;
    }
    appendMs += performance.now() - t0;
    if (w.pendingSize > 64 * 1024) out.push(w.drain());
  }
  w.appendCheckpoint(key.secretKey, time());
  const d0 = performance.now();
  out.push(w.drain());
  const drainMs = performance.now() - d0;
  const bytes = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
  let pos = 0;
  for (const b of out) {
    bytes.set(b, pos);
    pos += b.length;
  }
  return { bytes, changes, saves, records, appendMs, drainMs, hours: m / 3_600_000 };
}

function main(): void {
  const assert = process.argv.includes('--assert');
  const s = simulate();
  const r0 = performance.now();
  const parsed = readLog(s.bytes);
  const readMs = performance.now() - r0;
  const v0 = performance.now();
  const report = verifyLog(s.bytes);
  const verifyMs = performance.now() - v0;

  const perChangeUs = (s.appendMs * 1000) / s.changes;
  const sizeKB = s.bytes.length / 1024;
  const rows: Array<[string, string]> = [
    ['simulated active time', `${s.hours.toFixed(1)} h`],
    ['changes / records / saves', `${s.changes} / ${parsed.records.length} / ${s.saves}`],
    ['final code size', `${report.composition?.chars ?? 0} chars in ${report.finalFiles.length} files`],
    ['log size', `${sizeKB.toFixed(0)} KB (${parsed.blockCount} blocks)`],
    ['writer append+replay', `${perChangeUs.toFixed(2)} µs per change (${s.appendMs.toFixed(0)} ms total)`],
    ['final drain', `${s.drainMs.toFixed(1)} ms`],
    ['read whole log', `${readMs.toFixed(0)} ms`],
    ['full verification', `${verifyMs.toFixed(0)} ms → ${report.verdict}`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);

  const failures: string[] = [];
  if (report.findings.some((f) => f.severity === 'fail')) failures.push('verification reported failures');
  if (perChangeUs > BUDGET.appendPerChangeUs)
    failures.push(`append ${perChangeUs.toFixed(1)} µs > ${BUDGET.appendPerChangeUs}`);
  if (verifyMs > BUDGET.verifyMs) failures.push(`verify ${verifyMs.toFixed(0)} ms > ${BUDGET.verifyMs}`);
  if (sizeKB > BUDGET.sizeKB) failures.push(`size ${sizeKB.toFixed(0)} KB > ${BUDGET.sizeKB}`);
  if (failures.length > 0) {
    console.error(`\nBudget check: ${failures.join('; ')}`);
    if (assert) process.exit(1);
  } else {
    console.log('\nAll budgets met.');
  }
}

main();
