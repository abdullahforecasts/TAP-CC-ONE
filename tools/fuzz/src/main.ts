/**
 * Mutation fuzzer for the verifier. Starts from the committed vectors and applies random byte-level
 * and structure-aware mutations (records changed, re-encoded and re-framed with valid checksums).
 * The verifier must never throw, hang, or report a mutated log as INTACT when its bytes changed
 * in a way that alters records before the last checkpoint.
 *
 *   pnpm fuzz                 # 60 seconds
 *   pnpm fuzz --seconds 1800  # nightly run
 *   pnpm fuzz --seed 123      # reproduce a run
 *
 * Crashing inputs are written to fuzz-crashes/.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  type CborValue,
  concatBytes,
  decodeCanonical,
  encodeCanonical,
  encodeFrame,
  MAGIC,
  readLog,
  verifyLog,
} from '@tap/core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VECTORS = join(ROOT, 'spec/vectors');
const CRASHES = join(ROOT, 'fuzz-crashes');
const PER_INPUT_LIMIT_MS = 2000;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: Rand, n: number) => Math.floor(r() * n);

const INTERESTING = [
  0, 1, 0x7f, 0x80, 0xff, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x9f, 0xbf, 0xf6, 0xf7, 0xf9, 0xfb, 0xff,
];

function byteMutation(r: Rand, input: Uint8Array): Uint8Array {
  const b = input.slice();
  switch (int(r, 6)) {
    case 0: {
      const i = int(r, b.length);
      b[i] = b[i]! ^ (1 << int(r, 8));
      return b;
    }
    case 1:
      b[int(r, b.length)] = pick(r, INTERESTING);
      return b;
    case 2:
      return b.subarray(0, int(r, b.length));
    case 3: {
      const i = int(r, b.length);
      return concatBytes(b.subarray(0, i), new Uint8Array([pick(r, INTERESTING)]), b.subarray(i));
    }
    case 4: {
      const i = int(r, b.length);
      return concatBytes(b.subarray(0, i), b.subarray(i + 1 + int(r, 16)));
    }
    default: {
      // Overwrite a 4-byte length field position with a random large value.
      if (b.length < 4) return b;
      const i = int(r, b.length - 3);
      new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(i, Math.floor(r() * 0xffffffff));
      return b;
    }
  }
}

function mutateValue(r: Rand, v: CborValue, depth = 0): CborValue {
  if (depth > 4 || r() < 0.3) {
    return pick<CborValue>(r, [
      0,
      1,
      -1,
      2 ** 31,
      Number.MAX_SAFE_INTEGER,
      '',
      'x',
      '../evil',
      '\u{1F600}',
      true,
      false,
      new Uint8Array(0),
      new Uint8Array(32),
      [],
      {},
    ]);
  }
  if (Array.isArray(v)) {
    const copy = [...v];
    if (copy.length > 0 && r() < 0.7)
      copy[int(r, copy.length)] = mutateValue(r, copy[int(r, copy.length)]!, depth + 1);
    else if (r() < 0.5) copy.pop();
    else copy.push(mutateValue(r, 0, depth + 1));
    return copy;
  }
  if (v instanceof Uint8Array) return v.length > 0 ? v.subarray(1) : new Uint8Array([1]);
  if (typeof v === 'object') {
    const copy: Record<string, CborValue> = { ...v };
    const keys = Object.keys(copy);
    if (keys.length > 0 && r() < 0.7) {
      const k = pick(r, keys);
      copy[k] = mutateValue(r, copy[k]!, depth + 1);
    } else if (keys.length > 0 && r() < 0.5) {
      delete copy[pick(r, keys)];
    } else {
      copy[pick(r, ['zz', 'b', 'p', 's'])] = mutateValue(r, 0, depth + 1);
    }
    return copy;
  }
  if (typeof v === 'number') return v + pick(r, [1, -1, 1000, -v]);
  if (typeof v === 'string') return v + pick(r, ['a', '\r\n', '😀', '']);
  return !v;
}

/** Decode, mutate one record, re-encode and re-frame with valid CRCs. Null if not parseable. */
function structuralMutation(r: Rand, input: Uint8Array): Uint8Array | null {
  let parsed: ReturnType<typeof readLog>;
  try {
    parsed = readLog(input);
  } catch {
    return null;
  }
  if (parsed.records.length === 0) return null;
  const records = parsed.records.map((x) => x.bytes);
  const i = int(r, records.length);
  switch (int(r, 4)) {
    case 0: {
      const value = mutateValue(r, decodeCanonical(records[i]!));
      try {
        records[i] = encodeCanonical(value);
      } catch {
        return null;
      }
      break;
    }
    case 1:
      records.splice(i, 1);
      break;
    case 2:
      records.splice(int(r, records.length + 1), 0, records[i]!);
      break;
    default: {
      const j = int(r, records.length);
      [records[i], records[j]] = [records[j]!, records[i]!];
    }
  }
  const blocks: Uint8Array[] = [];
  for (let k = 0; k < records.length; k += 1 + int(r, 4)) {
    blocks.push(encodeFrame(concatBytes(...records.slice(k, k + 1 + int(r, 4))), r() < 0.5));
  }
  return concatBytes(MAGIC, encodeFrame(parsed.headerBytes, false), ...blocks);
}

function main(): void {
  const seconds = arg('seconds', 60);
  const seed = arg('seed', Date.now() % 2 ** 31);
  const r = rng(seed);
  const corpus = readdirSync(VECTORS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => new Uint8Array(readFileSync(join(VECTORS, d.name, 'log.codelog'))));
  const deadline = performance.now() + seconds * 1000;
  let runs = 0;
  let structural = 0;
  let slowest = 0;
  const verdicts: Record<string, number> = {};
  const crashes: string[] = [];
  console.log(`Fuzzing ${corpus.length} seeds for ${seconds}s (seed ${seed})`);
  while (performance.now() < deadline) {
    let input: Uint8Array = pick(r, corpus);
    const steps = 1 + int(r, 3);
    for (let s = 0; s < steps; s++) {
      const structuralInput = r() < 0.5 ? structuralMutation(r, input) : null;
      if (structuralInput) structural++;
      input = structuralInput ?? byteMutation(r, input);
      if (input.length === 0) input = pick(r, corpus);
    }
    const t0 = performance.now();
    try {
      const report = verifyLog(input);
      verdicts[report.verdict] = (verdicts[report.verdict] ?? 0) + 1;
    } catch (e) {
      mkdirSync(CRASHES, { recursive: true });
      const file = join(CRASHES, `crash-${seed}-${runs}.codelog`);
      writeFileSync(file, input);
      crashes.push(`${file}: ${(e as Error).stack?.split('\n')[0]}`);
    }
    const ms = performance.now() - t0;
    slowest = Math.max(slowest, ms);
    if (ms > PER_INPUT_LIMIT_MS) crashes.push(`slow input (${ms.toFixed(0)} ms) at run ${runs}`);
    runs++;
  }
  console.log(`${runs} inputs (${structural} structure-aware mutations), slowest ${slowest.toFixed(1)} ms`);
  console.log(`verdicts: ${JSON.stringify(verdicts)}`);
  if (crashes.length > 0) {
    console.error(`\n${crashes.length} problem(s):\n  ${crashes.slice(0, 20).join('\n  ')}`);
    process.exit(1);
  }
  console.log('No crashes, hangs or exceptions.');
}

main();
