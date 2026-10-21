/**
 * Network side of anchoring (used by the recorder): asks a TSA or an OpenTimestamps calendar to
 * timestamp a 32-byte digest, and upgrades pending OpenTimestamps proofs. Only the digest (and,
 * for upgrades, values derived from it) leaves the machine.
 */
import { AnchorError, toHex } from './der.js';
import { findNode, leaves, mergeOts, parseOts, serializeOts, summarizeOts } from './ots.js';
import { buildTimeStampReq, checkResponse, parseTimeStampResp } from './rfc3161.js';

export interface HttpResponse {
  status: number;
  body: Uint8Array;
}

/** Minimal HTTP client; the caller applies timeouts and size limits. */
export type HttpClient = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Uint8Array },
) => Promise<HttpResponse>;

/** Requests an RFC 3161 token for `digest32`; returns the checked TimeStampToken. */
export async function requestRfc3161(
  http: HttpClient,
  url: string,
  digest32: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const res = await http(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
    body: buildTimeStampReq(digest32, nonce, true),
  });
  if (res.status !== 200) throw new AnchorError('HTTP', `${url} answered HTTP ${res.status}`);
  return checkResponse(parseTimeStampResp(res.body), digest32, nonce);
}

/** Submits `digest32` to an OpenTimestamps calendar; returns the pending proof. */
export async function submitOts(
  http: HttpClient,
  calendar: string,
  digest32: Uint8Array,
): Promise<Uint8Array> {
  const res = await http(`${calendar.replace(/\/+$/, '')}/digest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/vnd.opentimestamps.v1',
    },
    body: digest32,
  });
  if (res.status !== 200) throw new AnchorError('HTTP', `${calendar} answered HTTP ${res.status}`);
  const ts = parseOts(res.body, digest32);
  if (summarizeOts(ts).pending.length === 0)
    throw new AnchorError('OTS_MALFORMED', 'calendar returned no pending attestation');
  return res.body;
}

export interface OtsUpgrade {
  token: Uint8Array;
  /** The proof now reaches a Bitcoin block. */
  complete: boolean;
  changed: boolean;
}

/**
 * Asks the calendars named in a pending proof for the rest of the path. Only calendars whose
 * origin is in `allowed` are contacted (a proof could name any host).
 */
export async function upgradeOts(
  http: HttpClient,
  token: Uint8Array,
  digest32: Uint8Array,
  allowed: readonly string[],
): Promise<OtsUpgrade> {
  const ts = parseOts(token, digest32);
  const origins = new Set(allowed.map((u) => new URL(u).origin));
  let changed = false;
  for (const leaf of leaves(ts)) {
    if (leaf.attestation.kind !== 'pending') continue;
    let origin: string;
    try {
      origin = new URL(leaf.attestation.uri).origin;
    } catch {
      continue;
    }
    if (!origins.has(origin) || !origin.startsWith('https://')) continue;
    const res = await http(`${leaf.attestation.uri.replace(/\/+$/, '')}/timestamp/${toHex(leaf.msg)}`, {
      method: 'GET',
      headers: { Accept: 'application/vnd.opentimestamps.v1' },
    });
    if (res.status === 404) continue; // not in a Bitcoin block yet
    if (res.status !== 200) throw new AnchorError('HTTP', `${origin} answered HTTP ${res.status}`);
    const upgrade = parseOts(res.body, leaf.msg);
    if (summarizeOts(upgrade).bitcoin.length === 0) continue;
    mergeOts(findNode(ts, leaf.msg)!, upgrade);
    changed = true;
  }
  return {
    token: changed ? serializeOts(ts) : token,
    changed,
    complete: summarizeOts(ts).bitcoin.length > 0,
  };
}
