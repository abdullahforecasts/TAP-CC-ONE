import { ed25519 } from '@noble/curves/ed25519.js';
import { base32, concatBytes, u64be } from './bytes.js';
import { DS_CHECKPOINT } from './constants.js';
import { ds, sha256 } from './hash.js';

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** New random Ed25519 key pair (CSPRNG via crypto.getRandomValues). */
export function generateKeyPair(): KeyPair {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** Deterministic key pair from a 32-byte seed (tests and vectors only). */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new RangeError('seed must be 32 bytes');
  const secretKey = new Uint8Array(seed);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

const DS_CHECKPOINT_BYTES = ds(DS_CHECKPOINT);

/** msg = DS("CLG1/checkpoint") || logId || u64be(s) || p || state || u64be(t)   (spec §6.4) */
export function checkpointMessage(args: {
  logId: Uint8Array;
  s: number;
  p: Uint8Array;
  state: Uint8Array;
  t: number;
}): Uint8Array {
  return concatBytes(DS_CHECKPOINT_BYTES, args.logId, u64be(args.s), args.p, args.state, u64be(args.t));
}

export function signMessage(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verifySignature(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Human-readable key fingerprint: base32(SHA-256(pub)), first 20 chars, groups of 4. */
export function keyFingerprint(publicKey: Uint8Array): string {
  return base32(sha256(publicKey))
    .slice(0, 20)
    .replace(/(.{4})(?!$)/g, '$1-');
}
