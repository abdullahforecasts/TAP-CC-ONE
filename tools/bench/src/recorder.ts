/**
 * Recorder hot-path benchmark (design §11.9): 50,000 editor changes through the recorder's
 * synchronous change handler, with flushes and checkpoints as in real use.
 *   budget: change handler < 0.2 ms on average and < 1 ms at p99
 */
import { performance } from 'node:perf_hooks';
import { concatBytes, keyPairFromSeed, LogWriter, sha256, utf8, verifyLog } from '@tap/core';
import {
  type DiskRead,
  Recorder,
  type RecorderHost,
} from '../../../packages/extension/src/recorder/recorder.js';

const CHANGES = 50_000;
const FILES = [
  '3sum.cpp',
  'longest_substring.cpp',
  'group_anagrams.cpp',
  'top_k.cpp',
  'product.cpp',
  'vector.h',
  'main.cpp',
];

export async function benchRecorder(): Promise<{ ok: boolean; lines: Array<[string, string]> }> {
  const docs = new Map<string, string>(FILES.map((f) => [f, '']));
  let clipboard = '';
  let wall = Date.UTC(2026, 9, 13, 9);
  let mono = 0;
  const host: RecorderHost = {
    wallNow: () => wall,
    monoNow: () => mono,
    readClipboard: async () => clipboard,
    openText: (rel) => docs.get(rel),
    openDocuments: () => [...docs].map(([rel, text]) => ({ rel, text })),
    readDisk: async (rel): Promise<DiskRead> => ({ kind: 'text', text: docs.get(rel) ?? '' }),
    listFiles: async () => [...docs.keys()],
    isTracked: () => true,
    vcsRecentlyActive: async () => false,
    randomBytes: (n) => new Uint8Array(n),
    onError: (e) => {
      throw e;
    },
  };
  const chunks: Uint8Array[] = [];
  const writer = LogWriter.create({ created: wall, tool: 'bench' });
  chunks.push(writer.drain());
  const recorder = new Recorder({
    writer,
    sink: { append: async (b) => void chunks.push(b), appendSync: (b) => void chunks.push(b) },
    host,
    key: keyPairFromSeed(sha256(utf8('bench'))),
    env: {
      vsc: '1',
      app: 'vscode',
      os: 'linux',
      ext: '0',
      aiExt: [],
      liveShare: false,
      cfgHash: new Uint8Array(32),
      settings: {},
    },
    settings: { flushDelayMs: 1_000_000, clipboardWaitMs: 5 },
  });
  await recorder.start();

  const durations = new Float64Array(CHANGES);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const t0 = performance.now();
  for (let i = 0; i < CHANGES; i++) {
    const rel = FILES[Math.min(FILES.length - 1, Math.floor((i / CHANGES) * FILES.length))]!;
    const text = docs.get(rel)!;
    const at = Math.floor(rand() * (text.length + 1));
    let change: { rangeOffset: number; rangeLength: number; text: string };
    if (rand() < 0.15 && at > 0) change = { rangeOffset: at - 1, rangeLength: 1, text: '' };
    else if (rand() < 0.005) {
      clipboard = 'for (int i = 0; i < n; i++) {\n    sum += a[i];\n}\n';
      change = { rangeOffset: at, rangeLength: 0, text: clipboard };
    } else change = { rangeOffset: at, rangeLength: 0, text: 'abcdefgh;{}\n '[Math.floor(rand() * 13)]! };
    const next =
      text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
    docs.set(rel, next);
    wall += 150;
    mono += 150;
    const s = performance.now();
    recorder.onDocumentChanged(rel, [change], undefined, true, () => next);
    durations[i] = performance.now() - s;
    if (i % 13 === 12) {
      // About every 2 s of typing: flush, as the timer would.
      await recorder.flush();
      if (i % 2000 === 1999) await recorder.tick();
    }
  }
  await recorder.stop();
  const totalMs = performance.now() - t0;
  const sorted = [...durations].sort((a, b) => a - b);
  const avg = sorted.reduce((n, d) => n + d, 0) / sorted.length;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
  const max = sorted[sorted.length - 1]!;
  const bytes = concatBytes(...chunks);
  const report = verifyLog(bytes);
  const fails = report.findings.filter((f) => f.severity === 'fail');
  const ok = avg < 0.2 && p99 < 1 && fails.length === 0;
  return {
    ok,
    lines: [
      ['recorder: changes', `${CHANGES} across ${FILES.length} files`],
      [
        'change handler avg / p99 / max',
        `${(avg * 1000).toFixed(1)} µs / ${(p99 * 1000).toFixed(1)} µs / ${max.toFixed(2)} ms`,
      ],
      ['whole pipeline (incl. flushes)', `${totalMs.toFixed(0)} ms`],
      [
        'resulting log',
        `${(bytes.length / 1024).toFixed(0)} KB → ${report.verdict}${fails.length ? ` (${fails.map((f) => f.code).join(',')})` : ''}`,
      ],
    ],
  };
}
