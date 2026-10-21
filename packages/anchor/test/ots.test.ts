import { sha256 } from '@noble/hashes/sha2.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toHex } from '../src/der.js';
import {
  blockHash,
  checkBitcoinHeader,
  parseOts,
  serializeOts,
  submitOts,
  summarizeOts,
  type Timestamp,
  upgradeOts,
} from '../src/index.js';
import { applyOp, type Op } from '../src/ots.js';
import { TEST_CALENDAR, testBitcoinUpgrade, testPendingOts } from '../src/testing.js';

const RUNS = Number(process.env.TAP_PROPERTY_RUNS ?? 100);
const digest = sha256(new TextEncoder().encode('checkpoint'));

describe('OpenTimestamps proofs', () => {
  it('round-trips a pending proof and finds its calendar', () => {
    const { token, commitment } = testPendingOts(digest);
    const ts = parseOts(token, digest);
    expect(serializeOts(ts)).toEqual(token);
    expect(summarizeOts(ts)).toEqual({ pending: [TEST_CALENDAR], bitcoin: [] });
    expect(toHex(commitment)).toHaveLength(64);
  });

  it('serialisation is canonical for any tree', () => {
    const leaf = fc.oneof(
      fc.record({
        kind: fc.constant('pending' as const),
        uri: fc.constantFrom('https://a.test', 'https://b.test'),
      }),
      fc.record({ kind: fc.constant('bitcoin' as const), height: fc.nat(900_000) }),
    );
    const op = fc.oneof(
      fc.record({
        kind: fc.constantFrom('append' as const, 'prepend' as const),
        arg: fc.uint8Array({ minLength: 1, maxLength: 8 }),
      }),
      fc.record({
        kind: fc.constantFrom(
          'sha256' as const,
          'ripemd160' as const,
          'sha1' as const,
          'keccak256' as const,
          'reverse' as const,
        ),
      }),
    );
    type Node = {
      attestations: Array<{ kind: 'pending'; uri: string } | { kind: 'bitcoin'; height: number }>;
      ops: Array<{ op: Op; stamp: Node }>;
    };
    const tree = (depth: number): fc.Arbitrary<Node> =>
      fc.record({
        attestations: fc.array(leaf, { maxLength: 2 }),
        ops:
          depth === 0
            ? fc.constant([])
            : fc.array(fc.record({ op, stamp: tree(depth - 1) }), { maxLength: 2 }),
      }) as fc.Arbitrary<Node>;
    fc.assert(
      fc.property(tree(4), (t) => {
        // Build messages by applying ops; skip trees that would be empty.
        const build = (node: Node, msg: Uint8Array): Timestamp | undefined => {
          const ops = node.ops
            .map(({ op: o, stamp }) => {
              const m = applyOp(o, msg);
              const s = build(stamp, m);
              return s ? { op: o, stamp: s } : undefined;
            })
            .filter((x): x is NonNullable<typeof x> => x !== undefined);
          // Duplicate ops would merge; keep the first of each.
          const seen = new Set<string>();
          const unique = ops.filter((o) => {
            const k = JSON.stringify([o.op.kind, 'arg' in o.op ? toHex(o.op.arg) : '']);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          const atts = [...new Map(node.attestations.map((a) => [JSON.stringify(a), a])).values()];
          if (atts.length === 0 && unique.length === 0) return undefined;
          return { msg, attestations: atts, ops: unique };
        };
        const ts = build(t, digest);
        if (!ts) return;
        const bytes = serializeOts(ts);
        expect(serializeOts(parseOts(bytes, digest))).toEqual(bytes);
      }),
      { numRuns: RUNS },
    );
  });

  it('rejects malformed proofs without throwing anything but AnchorError', () => {
    const { token } = testPendingOts(digest);
    expect(() => parseOts(token.subarray(0, token.length - 3), digest)).toThrow(/truncated/);
    expect(() => parseOts(new Uint8Array([0x99]), digest)).toThrow(/unknown operation/);
    expect(() => parseOts(new Uint8Array([...token, 0]), digest)).toThrow(/trailing/);
    const deep = new Uint8Array(600).fill(0x08); // 600 nested sha256 ops
    expect(() => parseOts(deep, digest)).toThrow(/too complex|truncated/);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (junk) => {
        try {
          parseOts(junk, digest);
        } catch (e) {
          expect((e as Error).name).toBe('AnchorError');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('submits to a calendar and upgrades to a Bitcoin attestation', async () => {
    const { token, commitment } = testPendingOts(digest);
    const blockTime = Date.UTC(2026, 9, 21, 11, 0, 0);
    const { upgrade, header } = testBitcoinUpgrade(commitment, 920_001, blockTime);
    const requests: string[] = [];
    const http = async (url: string, init: { method: string; body?: Uint8Array }) => {
      requests.push(`${init.method} ${url}`);
      if (init.method === 'POST') return { status: 200, body: token };
      return url.endsWith(toHex(commitment))
        ? { status: 200, body: upgrade }
        : { status: 404, body: new Uint8Array() };
    };
    expect(await submitOts(http, `${TEST_CALENDAR}/`, digest)).toEqual(token);
    const notYet = await upgradeOts(async () => ({ status: 404, body: new Uint8Array() }), token, digest, [
      TEST_CALENDAR,
    ]);
    expect(notYet).toEqual({ token, changed: false, complete: false });
    const up = await upgradeOts(http, token, digest, [TEST_CALENDAR]);
    expect(up.changed && up.complete).toBe(true);
    expect(requests).toEqual([
      `POST ${TEST_CALENDAR}/digest`,
      `GET ${TEST_CALENDAR}/timestamp/${toHex(commitment)}`,
    ]);
    const sum = summarizeOts(parseOts(up.token, digest));
    expect(sum.bitcoin.map((b) => b.height)).toEqual([920_001]);
    expect(checkBitcoinHeader(sum.bitcoin[0]!.merkleRoot, header)).toBe(blockTime);
    expect(checkBitcoinHeader(digest, header)).toBeUndefined();
    expect(blockHash(header)).toHaveLength(64);
  });

  it('only contacts allowed https calendars', async () => {
    const { token } = testPendingOts(digest, 'https://evil.test');
    let calls = 0;
    const r = await upgradeOts(
      async () => {
        calls++;
        return { status: 404, body: new Uint8Array() };
      },
      token,
      digest,
      [TEST_CALENDAR],
    );
    expect(calls).toBe(0);
    expect(r.changed).toBe(false);
  });
});
