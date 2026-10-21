/**
 * Signature verification for X.509 and CMS, synchronous and dependency-light: RSA (PKCS #1 v1.5
 * and PSS) with BigInt arithmetic, ECDSA with @noble/curves. Verification only, so no secret
 * material is handled and constant time is not needed. Every check compares against a freshly
 * built expected encoding instead of parsing the decrypted block, which avoids the classic
 * PKCS #1 v1.5 parsing pitfalls.
 */
import { p256, p384, p521 } from '@noble/curves/nist.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import {
  AnchorError,
  bytesEqual,
  children,
  concat,
  type Der,
  decodeBitString,
  decodeOid,
  decodeSmallInt,
  expect,
  nullDer,
  octets,
  oid,
  parseDer,
  seq,
  Tag,
} from './der.js';
import { HASH_BY_OID, type HashName, OID } from './oids.js';

export function digest(name: HashName, data: Uint8Array): Uint8Array {
  switch (name) {
    case 'SHA-1':
      return sha1(data);
    case 'SHA-256':
      return sha256(data);
    case 'SHA-384':
      return sha384(data);
    case 'SHA-512':
      return sha512(data);
  }
}

const OID_BY_HASH: Record<HashName, string> = {
  'SHA-1': OID.sha1,
  'SHA-256': OID.sha256,
  'SHA-384': OID.sha384,
  'SHA-512': OID.sha512,
};

const HASH_LEN: Record<HashName, number> = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };

/** AlgorithmIdentifier → { oid, params }. */
export function algorithm(el: Der): { oid: string; params?: Der } {
  const parts = children(expect(el, Tag.SEQUENCE, 'AlgorithmIdentifier'));
  const id = decodeOid(parts[0]!);
  return parts[1] ? { oid: id, params: parts[1] } : { oid: id };
}

export function hashOfAlgorithm(el: Der): HashName {
  const { oid: id } = algorithm(el);
  const h = HASH_BY_OID[id];
  if (!h) throw new AnchorError('UNSUPPORTED_ALGORITHM', `unsupported digest algorithm ${id}`);
  return h;
}

export interface PublicKey {
  kind: 'rsa' | 'ec';
  /** RSA modulus and exponent. */
  n?: bigint;
  e?: bigint;
  /** EC curve and uncompressed point. */
  curve?: 'P-256' | 'P-384' | 'P-521';
  point?: Uint8Array;
  /** Modulus length in bytes (RSA). */
  size: number;
}

function toBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function toBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new AnchorError('SIGNATURE', 'value does not fit');
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** SubjectPublicKeyInfo DER → key. */
export function parsePublicKey(spki: Der): PublicKey {
  const [alg, bits] = children(expect(spki, Tag.SEQUENCE, 'SubjectPublicKeyInfo'));
  const { oid: id, params } = algorithm(alg!);
  const keyBytes = decodeBitString(bits!);
  if (id === OID.rsaEncryption || id === OID.rsassaPss) {
    const [n, e] = children(parseDer(keyBytes));
    const nBytes = expect(n, Tag.INTEGER, 'modulus').content;
    const modulus = toBigInt(nBytes);
    const exponent = toBigInt(expect(e, Tag.INTEGER, 'exponent').content);
    const size = Math.ceil(modulus.toString(16).length / 2);
    if (size < 256) throw new AnchorError('WEAK_KEY', 'RSA keys shorter than 2048 bits are not accepted');
    return { kind: 'rsa', n: modulus, e: exponent, size };
  }
  if (id === OID.ecPublicKey) {
    const curveOid = params ? decodeOid(params) : '';
    const curve =
      curveOid === OID.p256
        ? 'P-256'
        : curveOid === OID.p384
          ? 'P-384'
          : curveOid === OID.p521
            ? 'P-521'
            : undefined;
    if (!curve) throw new AnchorError('UNSUPPORTED_ALGORITHM', `unsupported curve ${curveOid}`);
    return { kind: 'ec', curve, point: keyBytes, size: keyBytes.length };
  }
  throw new AnchorError('UNSUPPORTED_ALGORITHM', `unsupported public key algorithm ${id}`);
}

/** DigestInfo for PKCS #1 v1.5 (with explicit NULL parameters, as RFC 8017 requires). */
function digestInfo(hash: HashName, h: Uint8Array): Uint8Array {
  return seq(seq(oid(OID_BY_HASH[hash]), nullDer()), octets(h));
}

function rsaPkcs1(key: PublicKey, hash: HashName, data: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== key.size) return false;
  const s = toBigInt(sig);
  if (s >= key.n!) return false;
  const em = toBytes(modPow(s, key.e!, key.n!), key.size);
  const t = digestInfo(hash, digest(hash, data));
  if (t.length + 11 > key.size) return false;
  const expected = new Uint8Array(key.size);
  expected[1] = 1;
  expected.fill(0xff, 2, key.size - t.length - 1);
  expected.set(t, key.size - t.length);
  return bytesEqual(em, expected);
}

function mgf1(hash: HashName, seed: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let pos = 0;
  for (let counter = 0; pos < len; counter++) {
    const c = new Uint8Array([
      counter >>> 24,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    ]);
    const block = digest(hash, concat(seed, c));
    out.set(block.subarray(0, Math.min(block.length, len - pos)), pos);
    pos += block.length;
  }
  return out;
}

function rsaPss(key: PublicKey, hash: HashName, saltLen: number, data: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== key.size) return false;
  const s = toBigInt(sig);
  if (s >= key.n!) return false;
  const modBits = key.n!.toString(2).length;
  const emBits = modBits - 1;
  const emLen = Math.ceil(emBits / 8);
  const em = toBytes(modPow(s, key.e!, key.n!), key.size).subarray(key.size - emLen);
  const hLen = HASH_LEN[hash];
  if (emLen < hLen + saltLen + 2 || em[emLen - 1] !== 0xbc) return false;
  const maskedDb = em.subarray(0, emLen - hLen - 1);
  const h = em.subarray(emLen - hLen - 1, emLen - 1);
  const zeroBits = 8 * emLen - emBits;
  if (zeroBits > 0 && maskedDb[0]! >> (8 - zeroBits) !== 0) return false;
  const db = mgf1(hash, h, maskedDb.length);
  for (let i = 0; i < db.length; i++) db[i]! ^= maskedDb[i]!;
  if (zeroBits > 0) db[0]! &= 0xff >> zeroBits;
  const psLen = emLen - hLen - saltLen - 2;
  for (let i = 0; i < psLen; i++) if (db[i] !== 0) return false;
  if (db[psLen] !== 1) return false;
  const salt = db.subarray(db.length - saltLen);
  const mHash = digest(hash, data);
  const hPrime = digest(hash, concat(new Uint8Array(8), mHash, salt));
  return bytesEqual(h, hPrime);
}

function ecdsa(key: PublicKey, hash: HashName, data: Uint8Array, sig: Uint8Array): boolean {
  const curve = key.curve === 'P-256' ? p256 : key.curve === 'P-384' ? p384 : p521;
  try {
    return curve.verify(sig, digest(hash, data), key.point!, { prehash: false, lowS: false, format: 'der' });
  } catch {
    return false;
  }
}

function pssParams(params: Der | undefined): { hash: HashName; saltLen: number } {
  let hash: HashName = 'SHA-1';
  let saltLen = 20;
  if (params && params.tag === Tag.SEQUENCE) {
    for (const p of children(params)) {
      if (p.tag === 0xa0) hash = hashOfAlgorithm(children(p)[0]!);
      else if (p.tag === 0xa1) {
        const mgf = algorithm(children(p)[0]!);
        if (mgf.oid !== OID.mgf1)
          throw new AnchorError('UNSUPPORTED_ALGORITHM', 'unsupported PSS mask function');
      } else if (p.tag === 0xa2) saltLen = decodeSmallInt(children(p)[0]!);
    }
  }
  return { hash, saltLen };
}

/**
 * Verifies `sig` over `data`. `alg` is the signature AlgorithmIdentifier; `fallbackHash` is used
 * when the algorithm names only the key type (CMS allows rsaEncryption as signatureAlgorithm).
 */
export function verifySignature(
  alg: Der,
  key: PublicKey,
  data: Uint8Array,
  sig: Uint8Array,
  fallbackHash?: HashName,
): boolean {
  const { oid: id, params } = algorithm(alg);
  switch (id) {
    case OID.sha1WithRSA:
    case OID.sha256WithRSA:
    case OID.sha384WithRSA:
    case OID.sha512WithRSA: {
      if (key.kind !== 'rsa') return false;
      const hash: HashName =
        id === OID.sha1WithRSA
          ? 'SHA-1'
          : id === OID.sha256WithRSA
            ? 'SHA-256'
            : id === OID.sha384WithRSA
              ? 'SHA-384'
              : 'SHA-512';
      return rsaPkcs1(key, hash, data, sig);
    }
    case OID.rsaEncryption:
      if (key.kind !== 'rsa' || !fallbackHash) return false;
      return rsaPkcs1(key, fallbackHash, data, sig);
    case OID.rsassaPss: {
      if (key.kind !== 'rsa') return false;
      const p = pssParams(params);
      return rsaPss(key, p.hash, p.saltLen, data, sig);
    }
    case OID.ecdsaWithSHA256:
    case OID.ecdsaWithSHA384:
    case OID.ecdsaWithSHA512: {
      if (key.kind !== 'ec') return false;
      const hash: HashName =
        id === OID.ecdsaWithSHA256 ? 'SHA-256' : id === OID.ecdsaWithSHA384 ? 'SHA-384' : 'SHA-512';
      return ecdsa(key, hash, data, sig);
    }
    case OID.ecPublicKey:
      if (key.kind !== 'ec' || !fallbackHash) return false;
      return ecdsa(key, fallbackHash, data, sig);
    default:
      throw new AnchorError('UNSUPPORTED_ALGORITHM', `unsupported signature algorithm ${id}`);
  }
}
