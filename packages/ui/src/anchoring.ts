/** Independent timestamps as the viewer shows them (design §9.7). */
import type { AnchorInfo, VerifyReport } from '@tap/core';
import { hostOf } from './model/builder.js';

export interface ExistedBy {
  time: number;
  /** Who vouches for it (TSA name or "Bitcoin block N"). */
  authority: string;
}

/**
 * "This record existed by …": the earliest independent time of any anchored checkpoint at or
 * after the record. Returns a lookup by sequence number.
 */
export function existedByLookup(report: VerifyReport): (seq: number) => ExistedBy | undefined {
  const a = report.anchoring;
  if (!a || a.existedBy.length === 0) return () => undefined;
  const authorityOf = new Map<number, string>();
  for (const info of a.anchors) {
    if ((info.status === 'valid' || info.status === 'confirmed') && info.time !== undefined) {
      const best = a.existedBy.find((e) => e.seq === info.ck);
      if (best && best.time === info.time && !authorityOf.has(info.ck)) authorityOf.set(info.ck, label(info));
    }
  }
  // Suffix minima: entry i holds the earliest time over checkpoints i..end.
  const suffix: ExistedBy[] = new Array(a.existedBy.length);
  for (let i = a.existedBy.length - 1; i >= 0; i--) {
    const e = a.existedBy[i]!;
    const here = { time: e.time, authority: authorityOf.get(e.seq) ?? 'an independent service' };
    const next = suffix[i + 1];
    suffix[i] = next && next.time < here.time ? next : here;
  }
  return (seq: number) => {
    let lo = 0;
    let hi = a.existedBy.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a.existedBy[mid]!.seq < seq) lo = mid + 1;
      else hi = mid;
    }
    return suffix[lo];
  };
}

export function label(info: AnchorInfo): string {
  return info.authority ?? hostOf(info.src);
}

export const STATUS_TEXT: Record<AnchorInfo['status'], string> = {
  valid: 'verified',
  confirmed: 'in Bitcoin',
  pending: 'waiting for Bitcoin',
  untrusted: 'unknown authority',
  invalid: 'not valid',
  unverified: 'not checked',
};
