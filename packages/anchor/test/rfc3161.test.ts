import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { children, decodeOid, decodeTime, decodeUint, parseDer, readDer } from '../src/der.js';
import {
  buildTimeStampReq,
  checkResponse,
  parseCertificate,
  parseTimeStampResp,
  parseToken,
  requestRfc3161,
  rootsFromPem,
  trustedRoots,
  verifyTimestampToken,
} from '../src/index.js';
import { testTsa } from '../src/testing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', 'openssl', name)));
const interopDigest = new Uint8Array(createHash('sha256').update('interop').digest());
const interopRoots = rootsFromPem(fs.readFileSync(path.join(here, 'fixtures', 'openssl', 'ca.crt'), 'utf8'));
const RUNS = Number(process.env.TAP_PROPERTY_RUNS ?? 100);

const tsa = testTsa();
const digest = new Uint8Array(32).fill(0xab);
const genTime = Date.UTC(2026, 9, 21, 9, 30, 15, 250);
const nonce = new Uint8Array([0x81, 2, 3, 4, 5, 6, 7, 8]);

describe('DER', () => {
  it('rejects indefinite and non-minimal lengths and trailing bytes', () => {
    expect(() => readDer(new Uint8Array([0x30, 0x80, 0, 0]))).toThrow(/indefinite/);
    expect(() => readDer(new Uint8Array([0x04, 0x81, 0x05, 1, 2, 3, 4, 5]))).toThrow(/non-minimal/);
    expect(() => parseDer(new Uint8Array([0x05, 0x00, 0x00]))).toThrow(/trailing/);
    expect(() => readDer(new Uint8Array([0x04, 0x05, 1]))).toThrow(/past the end/);
  });

  it('decodes both time forms', () => {
    const t = (tag: number, s: string) =>
      decodeTime(parseDer(new Uint8Array([tag, s.length, ...new TextEncoder().encode(s)])));
    expect(t(0x17, '260101120000Z')).toBe(Date.UTC(2026, 0, 1, 12));
    expect(t(0x17, '991231235959Z')).toBe(Date.UTC(1999, 11, 31, 23, 59, 59));
    expect(t(0x18, '20261021093015.25Z')).toBe(Date.UTC(2026, 9, 21, 9, 30, 15, 250));
    expect(() => t(0x18, '2026102109Z')).toThrow();
  });
});

describe('RFC 3161 requests and responses', () => {
  it('builds a TimeStampReq with a SHA-256 imprint, a positive nonce and certReq', () => {
    const req = children(parseDer(buildTimeStampReq(digest, nonce)));
    expect(decodeUint(req[0]!)).toBe(1n);
    const imprint = children(req[1]!);
    expect(decodeOid(children(imprint[0]!)[0]!)).toBe('2.16.840.1.101.3.4.2.1');
    expect(imprint[1]!.content).toEqual(digest);
    expect(decodeUint(req[2]!)).toBe(0x8102030405060708n); // leading zero added: still positive
    expect(req[3]!.content).toEqual(new Uint8Array([0xff]));
    expect(() => buildTimeStampReq(new Uint8Array(31), nonce)).toThrow();
  });

  it('accepts a matching response and rejects refusals, wrong digests and wrong nonces', () => {
    const token = tsa.token({ digest, genTime, nonce });
    expect(checkResponse(parseTimeStampResp(tsa.response(token)), digest, nonce)).toEqual(token);
    expect(() => checkResponse(parseTimeStampResp(tsa.response(undefined, 2)), digest, nonce)).toThrow(
      /refused/,
    );
    expect(() => checkResponse(parseTimeStampResp(tsa.response(token)), new Uint8Array(32), nonce)).toThrow(
      /different digest/,
    );
    expect(() => checkResponse(parseTimeStampResp(tsa.response(token)), digest, new Uint8Array([1]))).toThrow(
      /nonce/,
    );
  });

  it('requests a token over HTTP and checks it', async () => {
    const calls: string[] = [];
    const token = await requestRfc3161(
      async (url, init) => {
        calls.push(`${init.method} ${url} ${init.headers['Content-Type']}`);
        const req = children(parseDer(init.body!));
        const n = req[2]!.content;
        return { status: 200, body: tsa.response(tsa.token({ digest, genTime, nonce: n })) };
      },
      'http://tsa.test',
      digest,
      nonce,
    );
    expect(calls).toEqual(['POST http://tsa.test application/timestamp-query']);
    expect(parseToken(token).tstInfo.genTime).toBe(genTime);
    await expect(
      requestRfc3161(async () => ({ status: 503, body: new Uint8Array() }), 'http://tsa.test', digest, nonce),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe('RFC 3161 token verification', () => {
  it('verifies tokens made by OpenSSL (RSA, ECDSA P-384, RSA-PSS chain)', () => {
    for (const name of ['resp.tsr', 'resp-ec.tsr', 'resp-pss-chain.tsr']) {
      const token = parseTimeStampResp(fixture(name)).token!;
      const r = verifyTimestampToken(token, interopDigest, interopRoots);
      expect(r.status, name).toBe('valid');
      expect(r.tsa).toMatch(/^OpenSSL Interop/);
      expect(r.accuracyMs).toBe(1000);
      expect(verifyTimestampToken(token, interopDigest, []).status).toBe('untrusted');
      expect(verifyTimestampToken(token, digest, interopRoots).problem).toBe('IMPRINT_MISMATCH');
    }
  });

  it('verifies the test TSA and reports every kind of problem', () => {
    const ok = verifyTimestampToken(tsa.token({ digest, genTime, nonce }), digest, tsa.roots);
    expect(ok).toMatchObject({
      status: 'valid',
      genTime,
      tsa: 'TAP Test TSA',
      path: ['TAP Test TSA', 'TAP Test Root'],
    });
    const problem = (o: Parameters<typeof tsa.token>[0]) =>
      verifyTimestampToken(tsa.token(o), digest, tsa.roots).problem;
    expect(problem({ digest, genTime, tamper: true })).toBe('TOKEN_SIGNATURE_INVALID');
    expect(problem({ digest, genTime, wrongKey: true })).toBe('TOKEN_SIGNATURE_INVALID');
    expect(problem({ digest, genTime, noTimeStampingUsage: true })).toBe('NOT_A_TSA');
    expect(problem({ digest, genTime, expiredCert: true })).toBe('CERT_EXPIRED');
    expect(problem({ digest, genTime, imprint: new Uint8Array(32) })).toBe('IMPRINT_MISMATCH');
    expect(verifyTimestampToken(tsa.token({ digest, genTime }), digest, trustedRoots()).status).toBe(
      'untrusted',
    );
    expect(verifyTimestampToken(new Uint8Array([0x30, 0x00]), digest, tsa.roots).problem).toBe(
      'TOKEN_MALFORMED',
    );
  });

  it('builds chains through bundled intermediates that a TSA leaves out of its tokens', () => {
    const token = tsa.token({ digest, genTime, viaIntermediate: true });
    expect(verifyTimestampToken(token, digest, tsa.roots).status).toBe('untrusted');
    const intermediates = [parseCertificate(tsa.intermediateDer)];
    expect(verifyTimestampToken(token, digest, tsa.roots, intermediates)).toMatchObject({
      status: 'valid',
      path: ['TAP Test TSA (via intermediate)', 'TAP Test Intermediate', 'TAP Test Root'],
    });
    // An intermediate is not a trust anchor by itself.
    expect(verifyTimestampToken(token, digest, [], intermediates).status).toBe('untrusted');
  });

  it('never throws, and no change to a token yields a different valid time', () => {
    const token = tsa.token({ digest, genTime, nonce });
    fc.assert(
      fc.property(fc.nat(token.length - 1), fc.integer({ min: 1, max: 255 }), (pos, x) => {
        const bad = token.slice();
        bad[pos]! ^= x;
        const r = verifyTimestampToken(bad, digest, tsa.roots);
        if (r.status === 'valid') expect(r.genTime).toBe(genTime);
      }),
      { numRuns: RUNS * 5 },
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (junk) => {
        expect(verifyTimestampToken(junk, digest, tsa.roots).status).toBe('invalid');
      }),
      { numRuns: RUNS },
    );
  });

  it('bundles trusted roots that parse and are valid for years', () => {
    const roots = trustedRoots();
    expect(roots.length).toBeGreaterThanOrEqual(2);
    for (const r of roots) expect(r.notAfter).toBeGreaterThan(Date.UTC(2030, 0, 1));
  });
});
