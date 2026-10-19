import { bytesEqual, concatBytes } from './bytes.js';
import { encodeCanonical } from './cbor.js';
import { DS_STATE, Flag, Kind, MAX_FILES } from './constants.js';
import { ds, sha256 } from './hash.js';
import { comparePaths } from './paths.js';
import {
  addToComposition,
  type Composition,
  emptyComposition,
  type Origin,
  originFromFlags,
  type Span,
  SpanList,
} from './provenance.js';
import type { AnyRecord, FileSnapshotBody, SnapshotOrigin } from './records.js';
import { contentHash, detectEol, normalizeText } from './text.js';
import { minimalEdits } from './textdiff.js';

export type Severity = 'fail' | 'warn' | 'info';

export interface ReplayIssue {
  code: string;
  severity: Severity;
  message: string;
  seq: number;
}

export interface FileState {
  f: number;
  path: string;
  text: string;
  /** Present when provenance tracking is enabled. */
  spans?: SpanList;
}

/** One change to a file's text, as seen by the replay (for viewers that animate the log). */
export interface EditEvent {
  f: number;
  /** Sequence number of the record that made the change. */
  seq: number;
  off: number;
  del: number;
  ins: string;
  origin: Origin;
  /** Change flags (0 for snapshots). */
  flags: number;
  /** For an internal copy: a live file that already contained the pasted text. */
  copiedFrom?: string;
}

export interface ReplayerOptions {
  /** Track per-character origins (needed for composition). Default false. */
  provenance?: boolean;
  /**
   * Called for every change to a file's text: edits, and the regions replaced by snapshots
   * (a new file's snapshot is an insertion at 0). Not called for changes the replay rejects.
   */
  onEdit?: (event: EditEvent) => void;
}

/** Plain copy of replay state, used for checkpoint caching and seeking. */
export interface ReplaySnapshot {
  /** Sequence number of the last applied record (-1 = nothing applied). */
  seq: number;
  files: Array<{ f: number; path: string; text: string; spans?: SpanList }>;
  retired: number[];
  /** Recently removed text per file, for undo/redo provenance. */
  removed?: Array<[number, Array<{ text: string; spans: Span[] }>]>;
}

const DS_STATE_BYTES = ds(DS_STATE);

/** Removed texts remembered per file for undo/redo provenance (spec §7.1). */
export const REMOVED_HISTORY = 64;

interface RemovedText {
  text: string;
  spans: Span[];
}

const SNAPSHOT_PROVENANCE: Record<SnapshotOrigin, Origin> = {
  preexisting: 'preexisting',
  created: 'created',
  external: 'external',
  resync: 'resync',
  'paused-gap': 'paused-gap',
  periodic: 'resync',
};

/**
 * State digest over live files (spec §6.3):
 *   entries = [[path, f, SHA-256(utf8(normalize(text)))], ...] sorted by UTF-8 bytes of path
 *   state   = SHA-256(DS("CLG1/state") || canonical(entries))
 */
export function stateDigest(files: Iterable<{ f: number; path: string; text: string }>): Uint8Array {
  const entries = [...files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((file) => [file.path, file.f, contentHash(file.text)]);
  return sha256(concatBytes(DS_STATE_BYTES, encodeCanonical(entries)));
}

/**
 * Deterministic replay of a log (design §10). `apply` never throws for content problems; it
 * returns issues instead, so a verifier can report them and a writer can refuse them.
 */
export class Replayer {
  readonly files = new Map<number, FileState>();
  readonly retired = new Set<number>();
  private readonly pendingExternal = new Map<number, { h: Uint8Array; seq: number }>();
  /** Recently removed text per file with its origins (provenance only), for undo and redo. */
  private readonly removed = new Map<number, RemovedText[]>();
  private readonly provenance: boolean;
  private readonly onEdit: ((event: EditEvent) => void) | undefined;
  lastSeq = -1;

  constructor(options: ReplayerOptions = {}) {
    this.provenance = options.provenance ?? false;
    this.onEdit = options.onEdit;
  }

  static fromSnapshot(snapshot: ReplaySnapshot, options: ReplayerOptions = {}): Replayer {
    const r = new Replayer(options);
    for (const file of snapshot.files) {
      const state: FileState = { f: file.f, path: file.path, text: file.text };
      if (r.provenance) state.spans = file.spans?.clone() ?? SpanList.of(file.text.length, 'resync', -1);
      r.files.set(file.f, state);
    }
    for (const f of snapshot.retired) r.retired.add(f);
    if (r.provenance && snapshot.removed) {
      for (const [f, list] of snapshot.removed) {
        r.removed.set(
          f,
          list.map((e) => ({ text: e.text, spans: e.spans.map((x) => ({ ...x })) })),
        );
      }
    }
    r.lastSeq = snapshot.seq;
    return r;
  }

  snapshot(): ReplaySnapshot {
    return {
      seq: this.lastSeq,
      files: [...this.files.values()].map((file) => {
        const copy: ReplaySnapshot['files'][number] = { f: file.f, path: file.path, text: file.text };
        if (file.spans) copy.spans = file.spans.clone();
        return copy;
      }),
      retired: [...this.retired],
      removed: [...this.removed].map(([f, list]) => [
        f,
        list.map((e) => ({ text: e.text, spans: e.spans.map((x) => ({ ...x })) })),
      ]),
    };
  }

  /** Live files sorted by path. */
  liveFiles(): FileState[] {
    return [...this.files.values()].sort((a, b) => comparePaths(a.path, b.path));
  }

  fileByPath(path: string): FileState | undefined {
    for (const file of this.files.values()) if (file.path === path) return file;
    return undefined;
  }

  stateDigest(): Uint8Array {
    return stateDigest(this.files.values());
  }

  /** Composition of the given files (default: all live files). Requires provenance tracking. */
  composition(paths?: readonly string[]): Composition {
    if (!this.provenance) throw new Error('composition requires provenance tracking');
    const total = emptyComposition();
    for (const file of this.liveFiles()) {
      if (paths && !paths.includes(file.path)) continue;
      addToComposition(total, file.text, file.spans!);
    }
    return total;
  }

  /** Issues that can only be detected at the end of the log. */
  finish(): ReplayIssue[] {
    return [...this.pendingExternal.entries()].map(([f, { seq }]) => ({
      code: 'EXTERNAL_WITHOUT_SNAPSHOT',
      severity: 'warn' as const,
      message: `external change to file ${f} was never followed by a snapshot`,
      seq,
    }));
  }

  apply(rec: AnyRecord): ReplayIssue[] {
    const issues: ReplayIssue[] = [];
    const issue = (code: string, severity: Severity, message: string) =>
      issues.push({ code, severity, message, seq: rec.s });
    this.lastSeq = rec.s;

    switch (rec.k) {
      case Kind.FILE_SNAPSHOT:
        this.applySnapshot(rec.b, rec.s, issue);
        break;

      case Kind.EDIT_BATCH: {
        const file = this.liveFile(rec.b.f, issue);
        if (!file) break;
        // Bounds-check the whole batch first so a bad batch leaves the state untouched.
        let len = file.text.length;
        let bad = -1;
        for (let i = 0; i < rec.b.c.length && bad < 0; i++) {
          const [, off, del, ins] = rec.b.c[i]!;
          if (off + del > len) bad = i;
          else len += ins.length - del;
        }
        if (bad >= 0) {
          const [, off, del] = rec.b.c[bad]!;
          issue('EDIT_OUT_OF_BOUNDS', 'fail', `change #${bad} (${off}+${del}) falls outside ${file.path}`);
          break;
        }
        const tracking = file.spans !== undefined || this.onEdit !== undefined;
        for (const [, off, del, ins, flags = 0] of rec.b.c) {
          let origin: Origin = 'typed';
          let source: string | undefined;
          if (tracking) {
            if (ins.length > 0 && (flags & Flag.PASTE) !== 0) source = this.copySource(ins);
            origin = originFromFlags(flags, source !== undefined);
          }
          // A change that replaces text (an editor, tool or AI rewriting a whole region) only
          // re-attributes what really differs; unchanged code keeps its origin (spec §7.1).
          const parts =
            tracking && del > 0 && ins.length > 0
              ? minimalEdits(file.text.slice(off, off + del), ins).map((e) => ({ ...e, off: off + e.off }))
              : [{ off, del, ins }];
          const undoRedo = (flags & (Flag.UNDO | Flag.REDO)) !== 0;
          for (const part of parts) {
            // Undo and redo bring back text with the origin it had when it was removed.
            let pieces: Array<{ text: string; origin: Origin; seq: number }> = [
              { text: part.ins, origin, seq: rec.s },
            ];
            if (file.spans) {
              if (part.del > 0) this.rememberRemoved(file, part.off, part.del);
              if (undoRedo && part.ins !== '') {
                const restored = this.restoredSpans(file, part.ins);
                if (restored) pieces = restored;
              }
              file.spans.remove(part.off, part.del);
              let at = part.off;
              for (const piece of pieces) {
                file.spans.insert(at, piece.text.length, piece.origin, rec.s);
                at += piece.text.length;
              }
            }
            file.text = file.text.slice(0, part.off) + part.ins + file.text.slice(part.off + part.del);
            if (this.onEdit) {
              let at = part.off;
              pieces.forEach((piece, i) => {
                const event: EditEvent = {
                  f: file.f,
                  seq: rec.s,
                  off: at,
                  del: i === 0 ? part.del : 0,
                  ins: piece.text,
                  origin: piece.origin,
                  flags,
                };
                if (source !== undefined) event.copiedFrom = source;
                this.onEdit!(event);
                at += piece.text.length;
              });
            }
          }
        }
        break;
      }

      case Kind.SAVE: {
        const file = this.liveFile(rec.b.f, issue);
        if (!file) break;
        if (!bytesEqual(contentHash(file.text), rec.b.h)) {
          issue(
            'SAVE_HASH_MISMATCH',
            'fail',
            `saved content of ${file.path} does not match the replayed text`,
          );
        } else if (file.text.length !== rec.b.n) {
          issue(
            'SAVE_LENGTH_MISMATCH',
            'fail',
            `${file.path}: length ${file.text.length}, SAVE says ${rec.b.n}`,
          );
        }
        break;
      }

      case Kind.FILE_OP: {
        const b = rec.b;
        if (b.op === 'create') {
          if (this.files.has(b.f) || this.retired.has(b.f)) {
            issue('FILE_ID_REUSED', 'fail', `file id ${b.f} is already in use`);
            break;
          }
          if (!this.checkNewPath(b.path, issue)) break;
          this.addFile(b.f, b.path, '', 'created', rec.s);
          if (b.origin === 'external')
            issue('EXTERNAL_FILE_CREATED', 'info', `${b.path} created outside the editor`);
          break;
        }
        const file = this.liveFile(b.f, issue);
        if (!file) break;
        if (file.path !== b.path) {
          issue('OP_PATH_MISMATCH', 'fail', `FILE_OP says ${b.path}, file ${b.f} is ${file.path}`);
          break;
        }
        if (b.op === 'delete') {
          this.files.delete(b.f);
          this.retired.add(b.f);
          this.pendingExternal.delete(b.f);
        } else {
          if (!this.checkNewPath(b.newPath!, issue)) break;
          file.path = b.newPath!;
        }
        break;
      }

      case Kind.EXTERNAL_CHANGE: {
        const file = this.liveFile(rec.b.f, issue);
        if (!file) break;
        this.pendingExternal.set(rec.b.f, { h: rec.b.h, seq: rec.s });
        if (rec.b.hint === 'vcs')
          issue('VCS_OPERATION', 'info', `${file.path} changed by a version-control operation`);
        break;
      }

      default:
        // Other kinds do not change file state.
        break;
    }
    return issues;
  }

  private liveFile(
    f: number,
    issue: (code: string, severity: Severity, message: string) => void,
  ): FileState | undefined {
    const file = this.files.get(f);
    if (!file) {
      issue(
        this.retired.has(f) ? 'FILE_DELETED' : 'UNKNOWN_FILE',
        'fail',
        this.retired.has(f) ? `file ${f} was deleted earlier` : `file id ${f} has not been introduced`,
      );
    }
    return file;
  }

  private checkNewPath(
    path: string,
    issue: (code: string, severity: Severity, message: string) => void,
  ): boolean {
    if (this.fileByPath(path)) {
      issue('DUPLICATE_PATH', 'fail', `two live files would share the path ${path}`);
      return false;
    }
    if (this.files.size >= MAX_FILES) {
      issue('TOO_MANY_FILES', 'fail', `more than ${MAX_FILES} files`);
      return false;
    }
    return true;
  }

  /** Remembers removed text with its origins, so a later undo or redo can restore them. */
  private rememberRemoved(file: FileState, off: number, len: number): void {
    if (!file.spans) return;
    const list = this.removed.get(file.f) ?? [];
    list.push({ text: file.text.slice(off, off + len), spans: file.spans.slice(off, len) });
    if (list.length > REMOVED_HISTORY) list.shift();
    this.removed.set(file.f, list);
  }

  /** The origins `text` had when it was last removed from the file, newest removal first. */
  private restoredSpans(
    file: FileState,
    text: string,
  ): Array<{ text: string; origin: Origin; seq: number }> | undefined {
    const list = this.removed.get(file.f);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]!;
      if (entry.text !== text) continue;
      const out: Array<{ text: string; origin: Origin; seq: number }> = [];
      let pos = 0;
      for (const span of entry.spans) {
        out.push({ text: text.slice(pos, pos + span.len), origin: span.origin, seq: span.seq });
        pos += span.len;
      }
      return out;
    }
    return undefined;
  }

  private addFile(f: number, path: string, text: string, origin: Origin, seq: number): void {
    const state: FileState = { f, path, text };
    if (this.provenance) state.spans = SpanList.of(text.length, origin, seq);
    this.files.set(f, state);
    if (text !== '') this.onEdit?.({ f, seq, off: 0, del: 0, ins: text, origin, flags: 0 });
  }

  /** A live file whose text (EOL-normalised) already contains `text`: a copy within the workspace. */
  private copySource(text: string): string | undefined {
    const needle = normalizeText(text);
    if (needle.trim().length === 0) return undefined;
    for (const file of this.liveFiles()) if (normalizeText(file.text).includes(needle)) return file.path;
    return undefined;
  }

  private applySnapshot(
    b: FileSnapshotBody,
    seq: number,
    issue: (code: string, severity: Severity, message: string) => void,
  ): void {
    if (!bytesEqual(contentHash(b.text), b.h)) {
      issue('SNAPSHOT_HASH_MISMATCH', 'fail', `snapshot of ${b.path} has a wrong content hash`);
      return;
    }
    if (detectEol(b.text) !== b.eol) {
      issue('SNAPSHOT_EOL_MISMATCH', 'warn', `snapshot of ${b.path} declares eol=${b.eol}`);
    }
    const existing = this.files.get(b.f);
    if (!existing) {
      if (this.retired.has(b.f)) {
        issue('FILE_ID_REUSED', 'fail', `file id ${b.f} was deleted earlier and cannot be reused`);
        return;
      }
      if (b.origin === 'resync' || b.origin === 'periodic') {
        issue('SNAPSHOT_ORIGIN_INVALID', 'fail', `"${b.origin}" snapshot for unknown file ${b.f}`);
        return;
      }
      if (!this.checkNewPath(b.path, issue)) return;
      this.addFile(b.f, b.path, b.text, SNAPSHOT_PROVENANCE[b.origin], seq);
      if (b.origin === 'external') issue('EXTERNAL_FILE', 'info', `${b.path} appeared outside the editor`);
      if (b.origin === 'paused-gap')
        issue('PAUSED_GAP_CHANGES', 'warn', `${b.path} was created while paused`);
      return;
    }

    if (existing.path !== b.path) {
      issue('SNAPSHOT_PATH_MISMATCH', 'fail', `snapshot says ${b.path}, file ${b.f} is ${existing.path}`);
      return;
    }
    if (b.origin === 'preexisting' || (b.origin === 'created' && existing.text !== '')) {
      issue('SNAPSHOT_ORIGIN_INVALID', 'fail', `"${b.origin}" snapshot for already-known file ${b.path}`);
      return;
    }
    const pending = this.pendingExternal.get(b.f);
    if (b.origin === 'external' && pending) {
      if (!bytesEqual(pending.h, b.h)) {
        issue(
          'EXTERNAL_HASH_MISMATCH',
          'fail',
          `external snapshot of ${b.path} does not match EXTERNAL_CHANGE`,
        );
        return;
      }
      this.pendingExternal.delete(b.f);
    }
    if (existing.text === b.text) return;

    switch (b.origin) {
      case 'external':
        issue('EXTERNAL_CHANGE', 'info', `${b.path} was changed outside the editor`);
        break;
      case 'resync':
        issue('RESYNC', 'warn', `recorder re-synchronised ${b.path} (some edits were not captured)`);
        break;
      case 'paused-gap':
        issue('PAUSED_GAP_CHANGES', 'warn', `${b.path} changed while recording was paused`);
        break;
      case 'periodic':
        issue('PERIODIC_SNAPSHOT_DIVERGED', 'warn', `periodic snapshot of ${b.path} differs from replay`);
        break;
      default:
        break;
    }
    // Replace only what differs, so unchanged code keeps its origin (spec §7.1).
    const origin = SNAPSHOT_PROVENANCE[b.origin];
    for (const e of minimalEdits(existing.text, b.text)) {
      if (existing.spans) {
        existing.spans.remove(e.off, e.del);
        existing.spans.insert(e.off, e.ins.length, origin, seq);
      }
      existing.text = existing.text.slice(0, e.off) + e.ins + existing.text.slice(e.off + e.del);
      this.onEdit?.({ f: b.f, seq, off: e.off, del: e.del, ins: e.ins, origin, flags: 0 });
    }
  }
}

/**
 * Checkpoint-cached index over a replay, for random access (the viewer's scrubber).
 * Caches the state after every CHECKPOINT and at least every `interval` records.
 */
export class ReplayIndex {
  private readonly cache: ReplaySnapshot[] = [];

  constructor(
    private readonly records: readonly AnyRecord[],
    private readonly interval = 1000,
  ) {
    const r = new Replayer();
    let sinceCache = 0;
    this.cache.push(r.snapshot());
    for (const rec of records) {
      r.apply(rec);
      sinceCache++;
      if (rec.k === Kind.CHECKPOINT || sinceCache >= this.interval) {
        this.cache.push(r.snapshot());
        sinceCache = 0;
      }
    }
  }

  get cachedPoints(): number {
    return this.cache.length;
  }

  /** State after applying every record with sequence number <= seq. */
  stateAt(seq: number): Replayer {
    let base = this.cache[0]!;
    for (const snap of this.cache) {
      if (snap.seq <= seq) base = snap;
      else break;
    }
    const r = Replayer.fromSnapshot(base);
    for (let i = base.seq + 1; i <= seq && i < this.records.length; i++) r.apply(this.records[i]!);
    return r;
  }
}
