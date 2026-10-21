/** X.509 certificates (RFC 5280): parsing and chain checks for timestamp signers. */
import {
  AnchorError,
  bytesEqual,
  children,
  type Der,
  decodeBitString,
  decodeOid,
  decodeTime,
  expect,
  parseDer,
  Tag,
  toHex,
} from './der.js';
import { OID } from './oids.js';
import { type PublicKey, parsePublicKey, verifySignature } from './sig.js';

export interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  sigAlg: Der;
  signature: Uint8Array;
  serial: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  /** Short display name: CN, else O. */
  subjectName: string;
  issuerName: string;
  notBefore: number;
  notAfter: number;
  key: PublicKey;
  isCa: boolean;
  /** Extended key usages, or undefined when the extension is absent. */
  eku?: string[];
  ski?: Uint8Array;
}

/** "CN" (or "O") from a Name. */
export function displayName(name: Der): string {
  let cn = '';
  let o = '';
  for (const rdn of children(name)) {
    for (const atv of children(rdn)) {
      const [type, value] = children(atv);
      const id = decodeOid(type!);
      const text = new TextDecoder().decode(value!.content);
      if (id === OID.commonName) cn = text;
      else if (id === OID.organization) o = text;
    }
  }
  return cn || o || '(unnamed)';
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = parseDer(der);
  const [tbsEl, sigAlg, sigBits] = children(expect(cert, Tag.SEQUENCE, 'Certificate'));
  const tbsParts = children(expect(tbsEl, Tag.SEQUENCE, 'TBSCertificate'));
  let i = 0;
  if (tbsParts[0]?.tag === 0xa0) i++; // version
  const serial = expect(tbsParts[i++], Tag.INTEGER, 'serialNumber').content;
  i++; // signature algorithm (repeated)
  const issuer = expect(tbsParts[i++], Tag.SEQUENCE, 'issuer');
  const validity = children(expect(tbsParts[i++], Tag.SEQUENCE, 'validity'));
  const subject = expect(tbsParts[i++], Tag.SEQUENCE, 'subject');
  const spki = expect(tbsParts[i++], Tag.SEQUENCE, 'subjectPublicKeyInfo');
  const out: Certificate = {
    der,
    tbs: tbsEl!.bytes,
    sigAlg: sigAlg!,
    signature: decodeBitString(sigBits!),
    serial,
    issuer: issuer.bytes,
    subject: subject.bytes,
    subjectName: displayName(subject),
    issuerName: displayName(issuer),
    notBefore: decodeTime(validity[0]!),
    notAfter: decodeTime(validity[1]!),
    key: parsePublicKey(spki),
    isCa: false,
  };
  for (; i < tbsParts.length; i++) {
    const part = tbsParts[i]!;
    if (part.tag !== 0xa3) continue;
    for (const ext of children(children(part)[0]!)) {
      const fields = children(ext);
      const id = decodeOid(fields[0]!);
      const value = parseDer(fields[fields.length - 1]!.content);
      if (id === OID.basicConstraints) {
        const bc = children(value);
        out.isCa = bc[0]?.tag === Tag.BOOLEAN && bc[0].content[0] !== 0;
      } else if (id === OID.extKeyUsage) {
        out.eku = children(value).map(decodeOid);
      } else if (id === OID.subjectKeyIdentifier) {
        out.ski = value.content;
      }
    }
  }
  return out;
}

/** PEM (one or more certificates) → DER blobs. */
export function pemToDer(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (let m = re.exec(pem); m; m = re.exec(pem)) {
    const b64 = m[1]!.replace(/\s+/g, '');
    out.push(base64Decode(b64));
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let pos = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new AnchorError('PEM', 'bad base64');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, pos);
}

export function base64Encode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    s += i + 1 < b.length ? B64[(n >> 6) & 63]! : '=';
    s += i + 2 < b.length ? B64[n & 63]! : '=';
  }
  return s;
}

export interface ChainResult {
  ok: boolean;
  /** Problem code when not ok: CHAIN_UNTRUSTED, CERT_SIGNATURE_INVALID, CERT_EXPIRED, NOT_A_TSA. */
  problem?: string;
  /** Subject names from the signer up to the trusted root. */
  path: string[];
}

const MAX_CHAIN = 8;

/**
 * Builds and checks a chain from `signer` to one of `roots`, using `pool` for intermediates.
 * Every certificate must be valid at `at` (the token's genTime); the signer must carry the
 * timeStamping extended key usage, issuers must be CAs. Roots are trusted as given (their own
 * signature and validity are not checked, as is usual for trust anchors).
 */
export function checkChain(
  signer: Certificate,
  pool: readonly Certificate[],
  roots: readonly Certificate[],
  at: number,
): ChainResult {
  const path = [signer.subjectName];
  if (!signer.eku?.includes(OID.timeStamping)) return { ok: false, problem: 'NOT_A_TSA', path };
  let cert = signer;
  const seen = new Set<string>([toHex(signer.der)]);
  for (let depth = 0; depth < MAX_CHAIN; depth++) {
    if (at < cert.notBefore || at > cert.notAfter) return { ok: false, problem: 'CERT_EXPIRED', path };
    const root = roots.find(
      (r) => bytesEqual(r.der, cert.der) || (bytesEqual(r.subject, cert.issuer) && signedBy(cert, r)),
    );
    if (root) {
      if (!bytesEqual(root.der, cert.der)) path.push(root.subjectName);
      return { ok: true, path };
    }
    const issuer = pool.find(
      (c) => !seen.has(toHex(c.der)) && bytesEqual(c.subject, cert.issuer) && c.isCa && signedBy(cert, c),
    );
    if (!issuer) {
      const candidate = pool.find((c) => bytesEqual(c.subject, cert.issuer));
      if (candidate && !signedBy(cert, candidate))
        return { ok: false, problem: 'CERT_SIGNATURE_INVALID', path };
      return { ok: false, problem: 'CHAIN_UNTRUSTED', path };
    }
    seen.add(toHex(issuer.der));
    path.push(issuer.subjectName);
    cert = issuer;
  }
  return { ok: false, problem: 'CHAIN_UNTRUSTED', path };
}

function signedBy(cert: Certificate, issuer: Certificate): boolean {
  try {
    return verifySignature(cert.sigAlg, issuer.key, cert.tbs, cert.signature);
  } catch {
    return false;
  }
}
