/** Plugs token verification into the core verifier (`verifyLog(bytes, { anchorVerifier })`). */

import { sha256 } from '@noble/hashes/sha2.js';
import type { AnchorBody, AnchorCheck, AnchorVerifier } from '@tap/core';
import { AnchorError, toHex } from './der.js';
import { checkBitcoinHeader, parseOts, summarizeOts } from './ots.js';
import { verifyTimestampToken } from './rfc3161.js';
import { trustedIntermediates, trustedRoots } from './roots.js';
import type { Certificate } from './x509.js';

export interface AnchorVerifierOptions {
  /** Trusted TSA roots (default: the bundled list). */
  roots?: readonly Certificate[];
  /**
   * Intermediate CA certificates that TSAs leave out of their tokens (default: the bundled list,
   * or none when `roots` is given). They only help build chains; trust still ends at a root.
   */
  intermediates?: readonly Certificate[];
  /**
   * Known Bitcoin block headers by height (80 bytes each). With a header, an OpenTimestamps
   * proof is checked against the block's merkle root and gets the block's time; without one it
   * is reported as confirmed at that height, with no time.
   */
  bitcoinHeaders?: ReadonlyMap<number, Uint8Array>;
}

/** Results are cached per token, so re-verifying a growing log only checks new tokens. */
export function createAnchorVerifier(options: AnchorVerifierOptions = {}): AnchorVerifier {
  const roots = options.roots ?? trustedRoots();
  const intermediates = options.intermediates ?? (options.roots ? [] : trustedIntermediates());
  const cache = new Map<string, AnchorCheck>();
  return (anchor: AnchorBody) => {
    const key = `${anchor.type}:${anchor.src}:${toHex(anchor.d)}:${toHex(sha256(anchor.tok))}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const result =
      anchor.type === 'rfc3161'
        ? checkRfc3161(anchor, roots, intermediates)
        : checkOts(anchor, options.bitcoinHeaders);
    cache.set(key, result);
    return result;
  };
}

function checkRfc3161(
  anchor: AnchorBody,
  roots: readonly Certificate[],
  intermediates: readonly Certificate[],
): AnchorCheck {
  const r = verifyTimestampToken(anchor.tok, anchor.d, roots, intermediates);
  const out: AnchorCheck = { status: r.status };
  if (r.genTime !== undefined && r.status !== 'invalid') out.time = r.genTime;
  if (r.tsa !== undefined) out.authority = r.tsa;
  if (r.problem !== undefined) out.problem = r.problem;
  if (r.message !== undefined) out.message = r.message;
  return out;
}

function checkOts(anchor: AnchorBody, headers: ReadonlyMap<number, Uint8Array> | undefined): AnchorCheck {
  try {
    const ts = parseOts(anchor.tok, anchor.d);
    const sum = summarizeOts(ts);
    for (const att of sum.bitcoin) {
      const header = headers?.get(att.height);
      if (!header) continue;
      const time = checkBitcoinHeader(att.merkleRoot, header);
      if (time === undefined) {
        return {
          status: 'invalid',
          problem: 'OTS_BITCOIN_MISMATCH',
          message: `the proof does not match Bitcoin block ${att.height}`,
          bitcoinHeight: att.height,
        };
      }
      return {
        status: 'confirmed',
        time,
        authority: `Bitcoin block ${att.height}`,
        bitcoinHeight: att.height,
      };
    }
    if (sum.bitcoin.length > 0) {
      const h = sum.bitcoin[0]!.height;
      return {
        status: 'confirmed',
        authority: `Bitcoin block ${h}`,
        bitcoinHeight: h,
        message: `recorded in Bitcoin block ${h} (block header not checked here)`,
      };
    }
    if (sum.pending.length > 0) {
      return { status: 'pending', authority: sum.pending[0]!, message: 'waiting for a Bitcoin block' };
    }
    return { status: 'invalid', problem: 'OTS_NO_ATTESTATION', message: 'the proof has no attestation' };
  } catch (e) {
    return {
      status: 'invalid',
      problem: e instanceof AnchorError ? e.code : 'OTS_MALFORMED',
      message: (e as Error).message,
    };
  }
}
