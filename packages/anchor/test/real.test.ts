/**
 * Answers recorded from the real services by scripts/record-real.ts. Skipped until that script
 * has been run (it needs normal internet access).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromHex } from '@tap/core';
import { describe, expect, it } from 'vitest';
import type { RealManifest } from '../scripts/record-real.js';
import {
  checkBitcoinHeader,
  parseOts,
  summarizeOts,
  trustedIntermediates,
  trustedRoots,
  verifyTimestampToken,
} from '../src/index.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real');
const manifestPath = path.join(dir, 'manifest.json');
const manifest = fs.existsSync(manifestPath)
  ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RealManifest)
  : undefined;
const read = (file: string) => new Uint8Array(fs.readFileSync(path.join(dir, file)));

describe.skipIf(!manifest)('real timestamp services (recorded)', () => {
  const digest = fromHex(manifest?.digest ?? '00');

  for (const t of manifest?.tsas ?? []) {
    it(`${new URL(t.url).hostname} token verifies with the bundled roots`, () => {
      const check = verifyTimestampToken(read(t.file), digest, trustedRoots(), trustedIntermediates());
      expect(check.status).toBe('valid');
      expect(new Date(check.genTime!).toISOString()).toBe(t.genTime);
      expect(check.path).toEqual(t.path);
      // Any other digest is rejected.
      expect(verifyTimestampToken(read(t.file), new Uint8Array(32), trustedRoots()).status).toBe('invalid');
    });
  }

  it.skipIf(!manifest?.ots)('the OpenTimestamps calendar answer is a pending proof', () => {
    const sum = summarizeOts(parseOts(read(manifest!.ots!.pending), digest));
    expect(sum.pending.length).toBeGreaterThan(0);
  });

  it.skipIf(!manifest?.ots?.upgraded)('the upgraded proof matches its Bitcoin block', () => {
    const sum = summarizeOts(parseOts(read(manifest!.ots!.upgraded!), digest));
    const att = sum.bitcoin.find((b) => b.height === manifest!.ots!.height);
    expect(att).toBeDefined();
    const time = checkBitcoinHeader(att!.merkleRoot, fromHex(manifest!.ots!.header!));
    expect(time).toBeGreaterThan(Date.parse(manifest!.recorded));
  });
});
