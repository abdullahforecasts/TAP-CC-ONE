/**
 * RFC 3161 timestamps: request building, response parsing and token verification
 * (RFC 3161 §2.4, CMS SignedData per RFC 5652, ESS signing-certificate per RFC 2634 / 5035).
 */
import {
  AnchorError,
  bool,
  bytesEqual,
  children,
  type Der,
  decodeOid,
  decodeSmallInt,
  decodeTime,
  decodeUint,
  expect,
  nullDer,
  octets,
  oid,
  parseDer,
  seq,
  Tag,
  toHex,
  uint,
  uintBytes,
} from './der.js';
import { OID } from './oids.js';
import { algorithm, digest, hashOfAlgorithm, verifySignature } from './sig.js';
import { type Certificate, checkChain, parseCertificate } from './x509.js';

/** TimeStampReq for a SHA-256 digest (RFC 3161 §2.4.1). */
export function buildTimeStampReq(digest32: Uint8Array, nonce: Uint8Array, certReq = true): Uint8Array {
  if (digest32.length !== 32) throw new RangeError('digest must be 32 bytes');
  const imprint = seq(seq(oid(OID.sha256), nullDer()), octets(digest32));
  return seq(uint(1), imprint, uintBytes(nonce), ...(certReq ? [bool(true)] : []));
}

/** Reads a TimeStampReq back (test TSAs and diagnostics). */
export function parseTimeStampReq(bytes: Uint8Array): {
  digest: Uint8Array;
  nonce?: Uint8Array;
  certReq: boolean;
} {
  const p = children(expect(parseDer(bytes), Tag.SEQUENCE, 'TimeStampReq'));
  const imprint = children(expect(p[1], Tag.SEQUENCE, 'MessageImprint'));
  const out: { digest: Uint8Array; nonce?: Uint8Array; certReq: boolean } = {
    digest: expect(imprint[1], Tag.OCTET_STRING, 'hashedMessage').content,
    certReq: false,
  };
  for (const q of p.slice(2)) {
    if (q.tag === Tag.INTEGER) out.nonce = q.content;
    else if (q.tag === Tag.BOOLEAN) out.certReq = q.content[0] !== 0;
  }
  return out;
}

export interface TimeStampResp {
  /** 0 granted, 1 grantedWithMods, 2 rejection, 3 waiting, 4 revocationWarning, 5 revocationNotification. */
  status: number;
  statusText?: string;
  token?: Uint8Array;
}

export function parseTimeStampResp(bytes: Uint8Array): TimeStampResp {
  const parts = children(expect(parseDer(bytes), Tag.SEQUENCE, 'TimeStampResp'));
  const info = children(expect(parts[0], Tag.SEQUENCE, 'PKIStatusInfo'));
  const out: TimeStampResp = { status: decodeSmallInt(info[0]!) };
  const text = info.find((p) => p.tag === Tag.SEQUENCE);
  if (text)
    out.statusText = children(text)
      .map((t) => new TextDecoder().decode(t.content))
      .join(' ');
  if (parts[1]) out.token = parts[1].bytes;
  return out;
}

export interface TstInfo {
  policy: string;
  hashAlg: string;
  imprint: Uint8Array;
  serial: string;
  genTime: number;
  accuracyMs?: number;
  nonce?: bigint;
}

export interface ParsedToken {
  tstInfo: TstInfo;
  eContent: Uint8Array;
  certificates: Certificate[];
  signer: {
    sid: { issuer?: Uint8Array; serial?: Uint8Array; ski?: Uint8Array };
    digestAlg: Der;
    signedAttrs?: Der;
    sigAlg: Der;
    signature: Uint8Array;
  };
}

function parseTstInfo(der: Uint8Array): TstInfo {
  const p = children(expect(parseDer(der), Tag.SEQUENCE, 'TSTInfo'));
  if (decodeSmallInt(p[0]!) !== 1) throw new AnchorError('TOKEN_MALFORMED', 'unsupported TSTInfo version');
  const imprint = children(expect(p[2], Tag.SEQUENCE, 'MessageImprint'));
  const out: TstInfo = {
    policy: decodeOid(p[1]!),
    hashAlg: algorithm(imprint[0]!).oid,
    imprint: expect(imprint[1], Tag.OCTET_STRING, 'hashedMessage').content,
    serial: toHex(expect(p[3], Tag.INTEGER, 'serialNumber').content),
    genTime: decodeTime(expect(p[4], Tag.GENERALIZED_TIME, 'genTime')),
  };
  for (const q of p.slice(5)) {
    if (q.tag === Tag.SEQUENCE) {
      let ms = 0;
      for (const a of children(q)) {
        if (a.tag === Tag.INTEGER) ms += decodeSmallInt(a) * 1000;
        else if (a.tag === 0x80) ms += decodeSmallInt({ ...a, tag: Tag.INTEGER });
        else if (a.tag === 0x81) ms += decodeSmallInt({ ...a, tag: Tag.INTEGER }) / 1000;
      }
      out.accuracyMs = ms;
    } else if (q.tag === Tag.INTEGER) {
      out.nonce = decodeUint(q);
    }
  }
  return out;
}

/** Parses a TimeStampToken (CMS ContentInfo with SignedData over a TSTInfo). */
export function parseToken(token: Uint8Array): ParsedToken {
  const ci = children(expect(parseDer(token), Tag.SEQUENCE, 'ContentInfo'));
  if (decodeOid(ci[0]!) !== OID.signedData) throw new AnchorError('TOKEN_MALFORMED', 'not CMS SignedData');
  const sd = children(expect(children(expect(ci[1], 0xa0, '[0] content'))[0], Tag.SEQUENCE, 'SignedData'));
  let i = 1; // version
  i++; // digestAlgorithms
  const encap = children(expect(sd[i++], Tag.SEQUENCE, 'EncapsulatedContentInfo'));
  if (decodeOid(encap[0]!) !== OID.tstInfo)
    throw new AnchorError('TOKEN_MALFORMED', 'content is not TSTInfo');
  const eContent = expect(
    children(expect(encap[1], 0xa0, '[0] eContent'))[0],
    Tag.OCTET_STRING,
    'eContent',
  ).content;
  const certificates: Certificate[] = [];
  if (sd[i]?.tag === 0xa0) {
    for (const c of children(sd[i]!)) {
      if (c.tag !== Tag.SEQUENCE) continue;
      try {
        certificates.push(parseCertificate(c.bytes));
      } catch {
        // An unusable extra certificate does not invalidate the token by itself.
      }
    }
    i++;
  }
  if (sd[i]?.tag === 0xa1) i++; // crls
  const signerInfos = children(expect(sd[i], Tag.SET, 'SignerInfos'));
  if (signerInfos.length !== 1) throw new AnchorError('TOKEN_MALFORMED', 'expected exactly one signer');
  const si = children(signerInfos[0]!);
  let j = 1; // version
  const sidEl = si[j++]!;
  const sid: ParsedToken['signer']['sid'] = {};
  if (sidEl.tag === Tag.SEQUENCE) {
    const [issuer, serial] = children(sidEl);
    sid.issuer = issuer!.bytes;
    sid.serial = expect(serial, Tag.INTEGER, 'serial').content;
  } else if (sidEl.tag === 0x80) {
    sid.ski = sidEl.content;
  } else throw new AnchorError('TOKEN_MALFORMED', 'bad signer identifier');
  const digestAlg = si[j++]!;
  let signedAttrs: Der | undefined;
  if (si[j]?.tag === 0xa0) signedAttrs = si[j++];
  const sigAlg = si[j++]!;
  const signature = expect(si[j], Tag.OCTET_STRING, 'signature').content;
  const signer: ParsedToken['signer'] = { sid, digestAlg, sigAlg, signature };
  if (signedAttrs) signer.signedAttrs = signedAttrs;
  return { tstInfo: parseTstInfo(eContent), eContent, certificates, signer };
}

/** Checks a TSA response against the request we sent (RFC 3161 §2.4.2). */
export function checkResponse(resp: TimeStampResp, digest32: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (resp.status > 1 || !resp.token) {
    throw new AnchorError(
      'TSA_REJECTED',
      `timestamp refused (status ${resp.status}${resp.statusText ? `: ${resp.statusText}` : ''})`,
    );
  }
  const parsed = parseToken(resp.token);
  if (parsed.tstInfo.hashAlg !== OID.sha256 || !bytesEqual(parsed.tstInfo.imprint, digest32)) {
    throw new AnchorError('IMPRINT_MISMATCH', 'the timestamp is for a different digest');
  }
  let n = 0n;
  for (const b of nonce) n = (n << 8n) | BigInt(b);
  if (parsed.tstInfo.nonce !== n)
    throw new AnchorError('NONCE_MISMATCH', 'the timestamp nonce does not match');
  return resp.token;
}

export interface TokenCheck {
  /** valid: signed by a trusted TSA; untrusted: correct but the TSA is not in the trusted list. */
  status: 'valid' | 'untrusted' | 'invalid';
  problem?: string;
  message?: string;
  genTime?: number;
  accuracyMs?: number;
  /** Name of the signing TSA certificate. */
  tsa?: string;
  path?: string[];
}

function attribute(attrs: Der, id: string): Der | undefined {
  for (const a of children(attrs)) {
    const [type, values] = children(a);
    if (decodeOid(type!) === id) return children(values!)[0];
  }
  return undefined;
}

/**
 * Verifies a stored TimeStampToken over `digest32`: structure, imprint, CMS signature, the ESS
 * signing-certificate binding, and the certificate chain up to `roots` at genTime.
 */
export function verifyTimestampToken(
  token: Uint8Array,
  digest32: Uint8Array,
  roots: readonly Certificate[],
  /** Extra intermediate CA certificates for chain building (not trusted by themselves). */
  intermediates: readonly Certificate[] = [],
): TokenCheck {
  let t: ParsedToken;
  try {
    t = parseToken(token);
  } catch (e) {
    return { status: 'invalid', problem: 'TOKEN_MALFORMED', message: (e as Error).message };
  }
  const base: TokenCheck = { status: 'invalid', genTime: t.tstInfo.genTime };
  if (t.tstInfo.accuracyMs !== undefined) base.accuracyMs = t.tstInfo.accuracyMs;
  if (t.tstInfo.hashAlg !== OID.sha256 || !bytesEqual(t.tstInfo.imprint, digest32)) {
    return { ...base, problem: 'IMPRINT_MISMATCH', message: 'the token timestamps a different digest' };
  }
  try {
    const { sid } = t.signer;
    const signer = t.certificates.find((c) =>
      sid.ski
        ? c.ski !== undefined && bytesEqual(c.ski, sid.ski)
        : bytesEqual(c.issuer, sid.issuer!) && bytesEqual(c.serial, sid.serial!),
    );
    if (!signer) {
      return {
        ...base,
        problem: 'SIGNER_CERT_MISSING',
        message: 'the token does not include its signing certificate',
      };
    }
    base.tsa = signer.subjectName;
    const hash = hashOfAlgorithm(t.signer.digestAlg);
    let signed: Uint8Array;
    if (t.signer.signedAttrs) {
      const attrs = t.signer.signedAttrs;
      const ct = attribute(attrs, OID.contentType);
      const md = attribute(attrs, OID.messageDigest);
      if (!ct || decodeOid(ct) !== OID.tstInfo || !md) {
        return {
          ...base,
          problem: 'TOKEN_MALFORMED',
          message: 'missing content type or message digest attribute',
        };
      }
      if (!bytesEqual(md.content, digest(hash, t.eContent))) {
        return {
          ...base,
          problem: 'TOKEN_SIGNATURE_INVALID',
          message: 'the timestamp content was changed after signing',
        };
      }
      const v2 = attribute(attrs, OID.signingCertificateV2);
      const v1 = attribute(attrs, OID.signingCertificate);
      if (v2 || v1) {
        const certs = children(children((v2 ?? v1)!)[0]!);
        const first = children(certs[0]!);
        let certHash: Uint8Array;
        let hashName: Parameters<typeof digest>[0] = v2 ? 'SHA-256' : 'SHA-1';
        if (v2 && first[0]!.tag === Tag.SEQUENCE) {
          hashName = hashOfAlgorithm(first[0]!);
          certHash = expect(first[1], Tag.OCTET_STRING, 'certHash').content;
        } else certHash = expect(first[0], Tag.OCTET_STRING, 'certHash').content;
        if (!bytesEqual(certHash, digest(hashName, signer.der))) {
          return {
            ...base,
            problem: 'SIGNER_CERT_MISMATCH',
            message: 'the signing certificate does not match the token',
          };
        }
      }
      // The signature covers the attributes encoded as a SET (RFC 5652 §5.4).
      signed = new Uint8Array(attrs.bytes);
      signed[0] = Tag.SET;
    } else {
      signed = t.eContent;
    }
    if (!verifySignature(t.signer.sigAlg, signer.key, signed, t.signer.signature, hash)) {
      return { ...base, problem: 'TOKEN_SIGNATURE_INVALID', message: 'the TSA signature is not valid' };
    }
    const chain = checkChain(signer, [...t.certificates, ...intermediates], roots, t.tstInfo.genTime);
    if (!chain.ok) {
      if (chain.problem === 'CHAIN_UNTRUSTED') {
        return {
          ...base,
          status: 'untrusted',
          problem: 'TSA_UNTRUSTED',
          message: `signed by ${signer.subjectName}, which is not one of the trusted timestamp authorities`,
          path: chain.path,
        };
      }
      return {
        ...base,
        problem: chain.problem!,
        message:
          chain.problem === 'CERT_EXPIRED'
            ? 'a certificate in the TSA chain was not valid at the timestamp time'
            : chain.problem === 'NOT_A_TSA'
              ? 'the signing certificate is not allowed to issue timestamps'
              : 'a certificate in the TSA chain has an invalid signature',
        path: chain.path,
      };
    }
    return { ...base, status: 'valid', path: chain.path };
  } catch (e) {
    const code = e instanceof AnchorError ? e.code : 'TOKEN_MALFORMED';
    return { ...base, problem: code === 'DER' ? 'TOKEN_MALFORMED' : code, message: (e as Error).message };
  }
}
