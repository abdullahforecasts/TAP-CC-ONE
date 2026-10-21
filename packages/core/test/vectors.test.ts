/**
 * Conformance: every committed test vector must produce exactly the expected verification result.
 * Future implementations (JetBrains, Visual Studio) run the same vectors.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type SubmittedFile, verifyLog } from '../src/index.js';

const VECTORS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../spec/vectors');

interface Expected {
  id: string;
  verdict: string;
  findings: Array<{ code: string; severity: string; seq?: number; offset?: number }>;
  recordCount: number;
  finalFiles: unknown[];
  composition: unknown;
  submittedPaths: string[];
  /** Vectors with timestamp tokens: checked with a token verifier in packages/anchor. */
  trust?: unknown;
}

const dirs = readdirSync(VECTORS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function load(dir: string) {
  const base = join(VECTORS, dir);
  const expected = JSON.parse(readFileSync(join(base, 'expected.json'), 'utf8')) as Expected;
  const log = new Uint8Array(readFileSync(join(base, 'log.codelog')));
  const submission: SubmittedFile[] = expected.submittedPaths.map((p) => ({
    path: p,
    content: new Uint8Array(readFileSync(join(base, 'submission', p.replace(/\\/g, '/')))),
  }));
  return { expected, log, submission };
}

describe('conformance vectors', () => {
  it('has the full vector set', () => {
    expect(dirs.map((d) => d.slice(0, 3))).toEqual([
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
      '011',
      '012',
      '013',
      '014',
      '015',
      '100',
      '101',
      '102',
      '103',
      '104',
      '105',
    ]);
  });

  for (const dir of dirs) {
    it(dir, () => {
      const { expected, log, submission } = load(dir);
      if (expected.trust) {
        // Without a token verifier the anchors are only checked against their checkpoints.
        const report = verifyLog(log);
        expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
        expect(report.findings.map((f) => f.code)).toContain('ANCHOR_TOKENS_NOT_VERIFIED');
        return;
      }
      const report = verifyLog(log, submission.length > 0 ? { submission } : {});
      expect(report.verdict).toBe(expected.verdict);
      const actual = report.findings
        .filter((f) => f.severity !== 'pass')
        .map((f) => `${f.severity}:${f.code}`)
        .sort();
      expect(actual).toEqual(expected.findings.map((f) => `${f.severity}:${f.code}`).sort());
      for (const exp of expected.findings.filter((f) => f.seq !== undefined || f.offset !== undefined)) {
        expect(
          report.findings.some(
            (f) =>
              f.code === exp.code &&
              (exp.seq === undefined || f.seq === exp.seq) &&
              (exp.offset === undefined || f.offset === exp.offset),
          ),
          JSON.stringify(exp),
        ).toBe(true);
      }
      expect(report.recordCount).toBe(expected.recordCount);
      expect(report.finalFiles).toEqual(expected.finalFiles);
      expect(report.composition ?? null).toEqual(expected.composition);
    });
  }
});

describe('single-byte corruption is always detected', () => {
  for (const name of ['001-minimal', '002-single-file-typed', '011-recovery']) {
    it(`every byte of ${name}`, () => {
      const path = join(VECTORS, name, 'log.codelog');
      expect(existsSync(path)).toBe(true);
      const original = new Uint8Array(readFileSync(path));
      const masks = name === '001-minimal' ? [1, 2, 4, 8, 16, 32, 64, 128] : [0xff, 0x01];
      let checked = 0;
      for (let i = 0; i < original.length; i++) {
        for (const mask of masks) {
          const bytes = original.slice();
          bytes[i] = bytes[i]! ^ mask;
          const report = verifyLog(bytes);
          if (report.verdict !== 'NOT_INTACT') throw new Error(`byte ${i} ^ ${mask} was not detected`);
          checked++;
        }
      }
      expect(checked).toBe(original.length * masks.length);
    });
  }
});
