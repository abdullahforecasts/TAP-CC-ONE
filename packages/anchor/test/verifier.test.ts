import { contentHash, keyPairFromSeed, LogWriter, sha256, utf8, verifyLog } from '@tap/core';
import { describe, expect, it } from 'vitest';
import { createAnchorVerifier } from '../src/index.js';
import { findNode, mergeOts, parseOts, serializeOts } from '../src/ots.js';
import { testBitcoinUpgrade, testPendingOts, testTsa } from '../src/testing.js';

const key = keyPairFromSeed(sha256(utf8('anchor-tests')));
const tsa = testTsa();
const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);

interface Built {
  bytes: Uint8Array;
}

/**
 * Two checkpoints, each anchored by `anchor(ckSeq, ckHash, ckTime)` → [type, token][]; an edit
 * after the last checkpoint is optional.
 */
function build(
  anchor: (
    ck: { s: number; hash: Uint8Array; t: number },
    i: number,
  ) => Array<['rfc3161' | 'ots', Uint8Array]>,
  options: { tailEdit?: boolean; clockAhead?: number } = {},
): Built {
  const w = LogWriter.create({ created: T0, tool: 'test', logId: new Uint8Array(16) });
  let t = T0;
  const T = () => {
    t += 60_000;
    return { t, m: t - T0 };
  };
  w.append(
    'SESSION_START',
    {
      sid: new Uint8Array(16),
      pub: key.publicKey,
      vsc: '1',
      app: 'vscode',
      os: 'linux',
      ext: '0.3.0',
      aiExt: [],
      liveShare: false,
      cfgHash: new Uint8Array(32),
    },
    T(),
  );
  w.append(
    'FILE_SNAPSHOT',
    { f: 0, path: 'a.c', origin: 'created', text: '', h: contentHash(''), eol: 'lf', enc: 'utf8' },
    T(),
  );
  for (let i = 0; i < 2; i++) {
    w.append('EDIT_BATCH', { f: 0, c: [[10, 0, 0, `x${i}`]] }, T());
    const time = T();
    const ckTime = { ...time, t: time.t + (options.clockAhead ?? 0) };
    const ck = w.appendCheckpoint(key.secretKey, ckTime);
    for (const [type, tok] of anchor({ s: ck.s, hash: ck.hash, t: time.t }, i)) {
      w.append(
        'ANCHOR',
        {
          ck: ck.s,
          d: ck.hash,
          type,
          src: type === 'ots' ? 'https://calendar.test' : 'http://tsa.test',
          tok,
          status: 'complete',
        },
        T(),
      );
    }
  }
  if (options.tailEdit) w.append('EDIT_BATCH', { f: 0, c: [[10, 0, 0, 'z']] }, T());
  return { bytes: w.drain() };
}

const verifier = () => createAnchorVerifier({ roots: tsa.roots });
const codes = (r: ReturnType<typeof verifyLog>) =>
  r.findings.filter((f) => f.stage === 'anchors').map((f) => `${f.severity}:${f.code}`);

describe('anchor verification in verifyLog', () => {
  it('reports verified timestamps, coverage and existed-by times', () => {
    const { bytes } = build((ck) => [['rfc3161', tsa.token({ digest: ck.hash, genTime: ck.t + 1500 })]]);
    const r = verifyLog(bytes, { anchorVerifier: verifier() });
    expect(r.verdict).toBe('INTACT');
    expect(codes(r)).toEqual(['pass:ANCHORS_OK']);
    expect(r.anchoring!.anchoredCheckpoints).toBe(2);
    expect(r.anchoring!.coverage).toBe(1);
    expect(r.anchoring!.existedBy.map((e) => e.time - T0)).toEqual([4 * 60_000 + 1500, 7 * 60_000 + 1500]);
    expect(r.anchoring!.anchors[0]).toMatchObject({
      type: 'rfc3161',
      status: 'valid',
      authority: 'TAP Test TSA',
    });
    expect(r.stats.anchors).toBe(2);
  });

  it('without a verifier, tokens are reported as not verified', () => {
    const { bytes } = build((ck) => [['rfc3161', tsa.token({ digest: ck.hash, genTime: ck.t })]]);
    expect(codes(verifyLog(bytes))).toEqual(['info:ANCHOR_TOKENS_NOT_VERIFIED']);
  });

  it('a forged or broken token makes the log not intact', () => {
    const { bytes } = build((ck, i) => [
      ['rfc3161', tsa.token({ digest: ck.hash, genTime: ck.t, wrongKey: i === 1 })],
    ]);
    const r = verifyLog(bytes, { anchorVerifier: verifier() });
    expect(r.verdict).toBe('NOT_INTACT');
    expect(codes(r)).toEqual(['fail:ANCHOR_TOKEN_INVALID']);
  });

  it('a token from an unknown TSA is a warning and gives no independent time', () => {
    const { bytes } = build((ck) => [['rfc3161', tsa.token({ digest: ck.hash, genTime: ck.t })]]);
    const r = verifyLog(bytes, { anchorVerifier: createAnchorVerifier() });
    expect(codes(r)).toEqual([
      'warn:ANCHOR_TSA_UNTRUSTED',
      'warn:ANCHOR_TSA_UNTRUSTED',
      'warn:NO_VALID_ANCHORS',
    ]);
    expect(r.anchoring!.anchoredCheckpoints).toBe(0);
  });

  it('a clock set ahead of the timestamp is caught', () => {
    const { bytes } = build((ck) => [['rfc3161', tsa.token({ digest: ck.hash, genTime: ck.t })]], {
      clockAhead: 600_000,
    });
    const r = verifyLog(bytes, { anchorVerifier: verifier() });
    expect(r.verdict).toBe('NOT_INTACT');
    expect(codes(r)).toContain('fail:CLOCK_INCONSISTENT');
  });

  it('late anchors, partial coverage and pending OpenTimestamps proofs are informational', () => {
    const { bytes } = build(
      (ck, i) =>
        i === 0
          ? [['rfc3161', tsa.token({ digest: ck.hash, genTime: ck.t + 3_600_000 })]]
          : [['ots', testPendingOts(ck.hash).token]],
      { tailEdit: true },
    );
    const r = verifyLog(bytes, { anchorVerifier: verifier() });
    expect(r.verdict).toBe('INTACT');
    expect(codes(r)).toEqual([
      'info:ANCHORED_LATE',
      'info:OTS_PENDING',
      'pass:ANCHORS_OK',
      'info:ANCHOR_COVERAGE_PARTIAL',
    ]);
    expect(r.anchoring!.coverage).toBeCloseTo(1 / 3);
  });

  it('an upgraded OpenTimestamps proof is checked against a known block header', () => {
    const blockTime = T0 + 7_200_000;
    let header: Uint8Array = new Uint8Array();
    const { bytes } = build((ck) => {
      const { token, commitment } = testPendingOts(ck.hash);
      const up = testBitcoinUpgrade(commitment, 920_000, blockTime);
      header = up.header;
      const ts = parseOts(token, ck.hash);
      mergeOts(findNode(ts, commitment)!, parseOts(up.upgrade, commitment));
      return [['ots', serializeOts(ts)]];
    });
    const unchecked = verifyLog(bytes, { anchorVerifier: verifier() });
    expect(unchecked.anchoring!.anchors.map((a) => a.status)).toEqual(['confirmed', 'confirmed']);
    expect(unchecked.anchoring!.anchoredCheckpoints).toBe(0); // no time without the header
    const r = verifyLog(bytes, {
      anchorVerifier: createAnchorVerifier({
        roots: tsa.roots,
        bitcoinHeaders: new Map([[920_000, header]]),
      }),
    });
    // Both checkpoints share a header here only because the test reuses the height.
    expect(r.anchoring!.anchors[1]).toMatchObject({
      status: 'confirmed',
      time: blockTime,
      bitcoinHeight: 920_000,
    });
  });

  it('a pending proof upgraded later in the log is neither pending nor late', () => {
    const blockTime = T0 + 7_200_000;
    const headers = new Map<number, Uint8Array>();
    const { bytes } = build((ck, i) => {
      const { token, commitment } = testPendingOts(ck.hash);
      const up = testBitcoinUpgrade(commitment, 920_000 + i, blockTime);
      headers.set(920_000 + i, up.header);
      const ts = parseOts(token, ck.hash);
      mergeOts(findNode(ts, commitment)!, parseOts(up.upgrade, commitment));
      return [
        ['ots', token],
        ['ots', serializeOts(ts)],
      ];
    });
    const r = verifyLog(bytes, {
      anchorVerifier: createAnchorVerifier({ roots: tsa.roots, bitcoinHeaders: headers }),
    });
    // Two hours to a Bitcoin block is normal for OpenTimestamps, so it is not "late".
    expect(codes(r)).toEqual(['pass:ANCHORS_OK']);
    expect(r.verdict).toBe('INTACT');
  });
});
