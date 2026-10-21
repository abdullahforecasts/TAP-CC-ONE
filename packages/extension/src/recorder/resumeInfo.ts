import { type AnyRecord, Kind } from '@tap/core';

/** What a recorder needs to know about an existing log before continuing it. */
export interface ResumeInfo {
  /** Public key of the most recent session (or announced by KEY_ROTATION). */
  lastPub?: Uint8Array;
  /**
   * Last known on-disk content hash per file id: from SAVE records and from snapshots that were
   * read from disk. Used to tell "unsaved editor changes" apart from "file changed on disk".
   */
  diskHashes: Map<number, Uint8Array>;
  /** Whether the last session was left open (crash or forced quit). */
  sessionOpen: boolean;
  /** Highest checkpoint that already has an RFC 3161 timestamp (-1 if none). */
  lastAnchoredCk: number;
}

export function resumeInfo(records: readonly AnyRecord[]): ResumeInfo {
  const info: ResumeInfo = { diskHashes: new Map(), sessionOpen: false, lastAnchoredCk: -1 };
  for (const rec of records) {
    switch (rec.k) {
      case Kind.SESSION_START:
        info.lastPub = rec.b.pub;
        info.sessionOpen = true;
        break;
      case Kind.SESSION_END:
        info.sessionOpen = false;
        break;
      case Kind.ANCHOR:
        if (rec.b.type === 'rfc3161') info.lastAnchoredCk = Math.max(info.lastAnchoredCk, rec.b.ck);
        break;
      case Kind.KEY_ROTATION:
        info.lastPub = rec.b.newPub;
        break;
      case Kind.SAVE:
        info.diskHashes.set(rec.b.f, rec.b.h);
        break;
      case Kind.FILE_SNAPSHOT:
        if (rec.b.origin !== 'resync') info.diskHashes.set(rec.b.f, rec.b.h);
        break;
      case Kind.FILE_OP:
        if (rec.b.op === 'delete') info.diskHashes.delete(rec.b.f);
        break;
      default:
        break;
    }
  }
  return info;
}
