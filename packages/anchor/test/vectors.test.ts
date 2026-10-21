/**
 * Conformance for the anchored vectors (spec/vectors 013 onwards): verify their timestamp tokens
 * with the trust anchors named in expected.json, read from the files as another implementation would.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromHex, verifyLog } from '@tap/core';
import { describe, expect, it } from 'vitest';
import { createAnchorVerifier, rootsFromPem } from '../src/index.js';

const VECTORS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../spec/vectors');

interface Expected {
  verdict: string;
  findings: Array<{ code: string; severity: string; seq?: number }>;
  trust?: { tsaRoots: string[]; bitcoinHeaders: Record<string, string> };
  anchoring?: unknown;
}

const anchored = readdirSync(VECTORS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({
    dir: d.name,
    expected: JSON.parse(readFileSync(join(VECTORS, d.name, 'expected.json'), 'utf8')) as Expected,
  }))
  .filter((v) => v.expected.trust);

describe('anchored conformance vectors', () => {
  it('has the anchored vectors', () => {
    expect(anchored.map((v) => v.dir.slice(0, 3))).toEqual(['013', '014', '015']);
  });

  for (const { dir, expected } of anchored) {
    it(dir, () => {
      const trust = expected.trust!;
      const roots = trust.tsaRoots.flatMap((p) => rootsFromPem(readFileSync(join(VECTORS, p), 'utf8')));
      const bitcoinHeaders = new Map(
        Object.entries(trust.bitcoinHeaders).map(([h, hex]) => [Number(h), fromHex(hex)] as const),
      );
      const log = new Uint8Array(readFileSync(join(VECTORS, dir, 'log.codelog')));
      const report = verifyLog(log, { anchorVerifier: createAnchorVerifier({ roots, bitcoinHeaders }) });
      expect(report.verdict).toBe(expected.verdict);
      const actual = report.findings
        .filter((f) => f.severity !== 'pass')
        .map((f) => `${f.severity}:${f.code}`)
        .sort();
      expect(actual).toEqual(expected.findings.map((f) => `${f.severity}:${f.code}`).sort());
      for (const f of expected.findings.filter((x) => x.seq !== undefined)) {
        expect(report.findings.some((r) => r.code === f.code && r.seq === f.seq)).toBe(true);
      }
      expect(report.anchoring).toEqual(expected.anchoring);
    });
  }

  it('the same tokens are untrusted without the test root', () => {
    const log = new Uint8Array(readFileSync(join(VECTORS, '013-anchored-rfc3161', 'log.codelog')));
    const report = verifyLog(log, { anchorVerifier: createAnchorVerifier() });
    expect(report.findings.filter((f) => f.code === 'ANCHOR_TSA_UNTRUSTED')).toHaveLength(2);
    expect(report.findings.map((f) => f.code)).toContain('NO_VALID_ANCHORS');
  });
});
