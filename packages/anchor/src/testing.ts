/**
 * A deterministic test time-stamp authority and OpenTimestamps calendar, for unit tests and the
 * conformance vectors. Uses ECDSA P-256 with RFC 6979 nonces, so the same inputs always give the
 * same bytes. Never trusted by default: callers pass `testTsa().roots` explicitly.
 */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bool,
  concat,
  generalizedTime,
  octets,
  oid,
  seq,
  set,
  tlv,
  uint,
  uintBytes,
  utcTime,
  utf8,
} from './der.js';
import { OID } from './oids.js';
import { serializeOts, type Timestamp } from './ots.js';
import { base64Encode, type Certificate, parseCertificate } from './x509.js';

const ECDSA_SHA256 = seq(oid(OID.ecdsaWithSHA256));

function name(cn: string): Uint8Array {
  return seq(set(seq(oid(OID.commonName), utf8(cn))));
}

function time(ms: number): Uint8Array {
  return new Date(ms).getUTCFullYear() < 2050 ? utcTime(ms) : generalizedTime(ms);
}

function sign(secret: Uint8Array, data: Uint8Array): Uint8Array {
  return p256.sign(sha256(data), secret, { prehash: false, format: 'der', lowS: true });
}

export interface TestCertOptions {
  cn: string;
  serial: number;
  issuerCn: string;
  issuerSecret: Uint8Array;
  secret: Uint8Array;
  notBefore: number;
  notAfter: number;
  ca?: boolean;
  timeStamping?: boolean;
}

export function makeCert(o: TestCertOptions): Uint8Array {
  const pub = p256.getPublicKey(o.secret, false);
  const exts: Uint8Array[] = [];
  if (o.ca) exts.push(seq(oid(OID.basicConstraints), bool(true), octets(seq(bool(true)))));
  if (o.timeStamping) exts.push(seq(oid(OID.extKeyUsage), bool(true), octets(seq(oid(OID.timeStamping)))));
  const tbs = seq(
    tlv(0xa0, uint(2)),
    uint(o.serial),
    ECDSA_SHA256,
    name(o.issuerCn),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.cn),
    seq(seq(oid(OID.ecPublicKey), oid(OID.p256)), tlv(0x03, new Uint8Array([0]), pub)),
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  return seq(tbs, ECDSA_SHA256, tlv(0x03, new Uint8Array([0]), sign(o.issuerSecret, tbs)));
}

export interface TokenOptions {
  digest: Uint8Array;
  genTime: number;
  nonce?: Uint8Array;
  serial?: number;
  /** Timestamp this digest instead (wrong imprint). */
  imprint?: Uint8Array;
  /** Flip a byte of the signed content after signing. */
  tamper?: boolean;
  /** Sign with a key that does not match the included certificate. */
  wrongKey?: boolean;
  /** Use a signer certificate without the timeStamping usage. */
  noTimeStampingUsage?: boolean;
  /** Use an expired signer certificate. */
  expiredCert?: boolean;
  /** Sign with a certificate issued by an intermediate CA that the token leaves out. */
  viaIntermediate?: boolean;
}

const seed = (label: string) => sha256(new TextEncoder().encode(`tap test tsa/${label}`));

export interface TestTsa {
  rootDer: Uint8Array;
  rootPem: string;
  roots: Certificate[];
  /** The intermediate CA behind `viaIntermediate` tokens. */
  intermediateDer: Uint8Array;
  token(o: TokenOptions): Uint8Array;
  /** Wraps a token in a granted TimeStampResp (or a rejection with status 2). */
  response(token: Uint8Array | undefined, status?: number): Uint8Array;
}

const Y2024 = Date.UTC(2024, 0, 1);
const Y2040 = Date.UTC(2040, 0, 1);

export function testTsa(): TestTsa {
  const rootSecret = seed('root').slice(0, 32);
  const tsaSecret = seed('tsa').slice(0, 32);
  const otherSecret = seed('other').slice(0, 32);
  const intermediateSecret = seed('intermediate').slice(0, 32);
  const rootDer = makeCert({
    cn: 'TAP Test Root',
    serial: 1,
    issuerCn: 'TAP Test Root',
    issuerSecret: rootSecret,
    secret: rootSecret,
    notBefore: Y2024,
    notAfter: Y2040,
    ca: true,
  });
  const intermediateDer = makeCert({
    cn: 'TAP Test Intermediate',
    serial: 10,
    issuerCn: 'TAP Test Root',
    issuerSecret: rootSecret,
    secret: intermediateSecret,
    notBefore: Y2024,
    notAfter: Y2040,
    ca: true,
  });
  const viaIntermediate = makeCert({
    cn: 'TAP Test TSA (via intermediate)',
    serial: 5,
    issuerCn: 'TAP Test Intermediate',
    issuerSecret: intermediateSecret,
    secret: tsaSecret,
    notBefore: Y2024,
    notAfter: Y2040,
    timeStamping: true,
  });
  const leaf = (variant: 'ok' | 'no-eku' | 'expired') =>
    makeCert({
      cn: variant === 'ok' ? 'TAP Test TSA' : `TAP Test TSA (${variant})`,
      serial: variant === 'ok' ? 2 : variant === 'no-eku' ? 3 : 4,
      issuerCn: 'TAP Test Root',
      issuerSecret: rootSecret,
      secret: tsaSecret,
      notBefore: variant === 'expired' ? Date.UTC(2020, 0, 1) : Y2024,
      notAfter: variant === 'expired' ? Date.UTC(2021, 0, 1) : Y2040,
      timeStamping: variant !== 'no-eku',
    });
  const b64 = base64Encode(rootDer);
  const rootPem = `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;

  return {
    rootDer,
    rootPem,
    roots: [parseCertificate(rootDer)],
    intermediateDer,
    token(o: TokenOptions): Uint8Array {
      const variant = o.expiredCert ? 'expired' : o.noTimeStampingUsage ? 'no-eku' : 'ok';
      const cert = o.viaIntermediate ? viaIntermediate : leaf(variant);
      const issuerName = o.viaIntermediate ? 'TAP Test Intermediate' : 'TAP Test Root';
      const serial = o.viaIntermediate ? 5 : variant === 'ok' ? 2 : variant === 'no-eku' ? 3 : 4;
      const tst = seq(
        uint(1),
        oid('1.3.6.1.4.1.99999.1'),
        seq(seq(oid(OID.sha256)), octets(o.imprint ?? o.digest)),
        uint(o.serial ?? 1),
        generalizedTime(o.genTime),
        seq(uint(1)),
        ...(o.nonce ? [uintBytes(o.nonce)] : []),
      );
      const attrs = [
        seq(oid(OID.contentType), set(oid(OID.tstInfo))),
        seq(oid(OID.messageDigest), set(octets(sha256(tst)))),
        seq(oid(OID.signingCertificateV2), set(seq(seq(seq(octets(sha256(cert))))))),
      ].sort((a, b) => {
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
        return a.length - b.length;
      });
      const signedAttrs = set(...attrs);
      const signature = sign(o.wrongKey ? otherSecret : tsaSecret, signedAttrs);
      const content = o.tamper ? tst.slice() : tst;
      if (o.tamper) content[content.length - 1]! ^= 1;
      const signerInfo = seq(
        uint(1),
        seq(name(issuerName), uint(serial)),
        seq(oid(OID.sha256)),
        tlv(0xa0, ...attrs),
        ECDSA_SHA256,
        octets(signature),
      );
      const signedData = seq(
        uint(3),
        set(seq(oid(OID.sha256))),
        seq(oid(OID.tstInfo), tlv(0xa0, octets(content))),
        o.viaIntermediate ? tlv(0xa0, cert) : tlv(0xa0, cert, rootDer),
        set(signerInfo),
      );
      return seq(oid(OID.signedData), tlv(0xa0, signedData));
    },
    response(token: Uint8Array | undefined, status = 0): Uint8Array {
      return seq(seq(uint(status)), ...(token ? [token] : []));
    },
  };
}

// ---- OpenTimestamps -------------------------------------------------------------------------

export const TEST_CALENDAR = 'https://calendar.test.invalid';

/** A pending proof as a calendar returns it: append a nonce, sha256, pending attestation. */
export function testPendingOts(
  digest: Uint8Array,
  calendar = TEST_CALENDAR,
): { token: Uint8Array; commitment: Uint8Array } {
  const nonce = sha256(concat(new TextEncoder().encode('nonce'), digest)).slice(0, 16);
  const commitment = sha256(concat(digest, nonce));
  const ts: Timestamp = {
    msg: digest,
    attestations: [],
    ops: [
      {
        op: { kind: 'append', arg: nonce },
        stamp: {
          msg: concat(digest, nonce),
          attestations: [],
          ops: [
            {
              op: { kind: 'sha256' },
              stamp: { msg: commitment, attestations: [{ kind: 'pending', uri: calendar }], ops: [] },
            },
          ],
        },
      },
    ],
  };
  return { token: serializeOts(ts), commitment };
}

/**
 * The calendar's answer to an upgrade request for `commitment`: a path to a Bitcoin block, plus
 * a matching 80-byte block header with the given time.
 */
export function testBitcoinUpgrade(
  commitment: Uint8Array,
  height: number,
  blockTimeMs: number,
): { upgrade: Uint8Array; header: Uint8Array } {
  const sibling = sha256(new TextEncoder().encode(`sibling ${height}`));
  const root = sha256(concat(commitment, sibling));
  const ts: Timestamp = {
    msg: commitment,
    attestations: [],
    ops: [
      {
        op: { kind: 'append', arg: sibling },
        stamp: {
          msg: concat(commitment, sibling),
          attestations: [],
          ops: [
            {
              op: { kind: 'sha256' },
              stamp: { msg: root, attestations: [{ kind: 'bitcoin', height }], ops: [] },
            },
          ],
        },
      },
    ],
  };
  const header = new Uint8Array(80);
  header[0] = 4; // version
  header.set(root, 36);
  const t = Math.floor(blockTimeMs / 1000);
  header[68] = t & 0xff;
  header[69] = (t >>> 8) & 0xff;
  header[70] = (t >>> 16) & 0xff;
  header[71] = (t >>> 24) & 0xff;
  return { upgrade: serializeOts(ts), header };
}
