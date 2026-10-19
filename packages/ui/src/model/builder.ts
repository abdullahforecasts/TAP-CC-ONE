/**
 * Builds the viewer's model from log records in one pass (design §12). Incremental: records can
 * be appended as the log grows (live refresh), and `result()` reflects everything appended so
 * far. Pure data in, pure data out — no DOM, so it runs in a Web Worker and in unit tests.
 */
import {
  type AnyRecord,
  type Composition,
  countNonWhitespace,
  type EditEvent,
  emptyComposition,
  Flag,
  Kind,
  keyFingerprint,
  type LogHeader,
  type Origin,
  Replayer,
  type Span,
  SpanList,
  toHex,
} from '@tap/core';
import { diffStats } from './diff.js';
import { applyUndoMark } from './playback.js';
import type {
  ActivityBucket,
  EventCategory,
  FileInfo,
  FileTrack,
  HistoryEntry,
  IntervalStats,
  Keyframe,
  LogEvent,
  LogModel,
  Marker,
  PasteInfo,
  Range,
  RunInfo,
  SessionInfo,
  TrackEvent,
  Weakening,
} from './types.js';

/** A keyframe (full text and origins) is kept every this many events per file. */
export const KEYFRAME_EVERY = 256;
/** Gaps between changes longer than this do not count as active time (design §13.4). */
export const ACTIVE_GAP_MS = 5 * 60_000;
const MINUTE = 60_000;

interface TrackState {
  track: FileTrack;
  text: string;
  spans: SpanList;
  /** Text brought back by undo or redo (see Keyframe.undo). */
  undo: SpanList;
}

interface SavePoint {
  text: string;
  index: number;
  seq: number;
  t: number;
  entry?: HistoryEntry;
}

const PASTE_ORIGINS = new Set<Origin>(['paste', 'internal-copy']);

export class LogModelBuilder {
  private header: LogModel['header'];
  private recordCount = 0;
  private readonly replayer: Replayer;
  private rec: AnyRecord | undefined;
  private recInserted = 0;
  private recDeleted = 0;
  private recEvents: TrackEvent[] = [];

  private readonly tracks = new Map<number, TrackState>();
  private readonly files = new Map<number, FileInfo>();
  private readonly lastSave = new Map<number, SavePoint>();
  private readonly saveCount = new Map<number, number>();
  private readonly history: HistoryEntry[] = [];
  private lastSaveEntry: HistoryEntry | undefined;
  private lastEditSeq = -1;

  private readonly events: LogEvent[] = [];
  private readonly sessions: SessionInfo[] = [];
  private readonly runs = new Map<string, RunInfo>();
  private readonly runEvents = new Map<RunInfo, LogEvent>();
  private readonly vcsHint = new Set<number>();

  private readonly activity = new Map<number, ActivityBucket>();
  private readonly markers: Marker[] = [];
  private readonly pauses: Range[] = [];
  private readonly unfocused: Range[] = [];
  private readonly sessionRanges: Range[] = [];
  private openPause: Range | undefined;
  private openUnfocus: Range | undefined;
  private openSession: Range | undefined;
  private firstT: number | undefined;
  private lastT = 0;
  /** Time of the last record that belongs to a session (the end of one that crashed). A recovery
   * record is written by the next session, so it is not counted. */
  private sessionLastT = 0;
  private problem: string | undefined;

  constructor() {
    this.replayer = new Replayer({ provenance: true, onEdit: (e) => this.onEdit(e) });
  }

  setHeader(header: LogHeader): void {
    this.header = { logId: toHex(header.logId), created: header.created, tool: header.tool };
    if (header.label !== undefined) this.header.label = header.label;
  }

  /** Marks the model as incomplete (the log could not be read past some point). */
  setProblem(message: string): void {
    this.problem = message;
  }

  append(records: Iterable<AnyRecord>): void {
    for (const rec of records) this.appendOne(rec);
  }

  private appendOne(rec: AnyRecord): void {
    this.recordCount++;
    this.rec = rec;
    this.recInserted = 0;
    this.recDeleted = 0;
    this.recEvents = [];
    if (this.firstT === undefined) this.firstT = rec.t;
    this.lastT = Math.max(this.lastT, rec.t);
    const existed = 'f' in rec.b && typeof rec.b.f === 'number' ? this.replayer.files.has(rec.b.f) : false;

    for (const issue of this.replayer.apply(rec)) {
      if (issue.severity === 'fail') {
        this.event(rec, 'integrity', issue.message, { tone: 'warning', detail: issue.code });
      }
    }
    this.afterApply(rec, existed);
    this.rec = undefined;
    if (rec.k !== Kind.RECOVERY) this.sessionLastT = rec.t;
  }

  /** Runs still open when their session ends never get a result (closed VS Code, crash). */
  private cutOffRuns(): void {
    for (const [key, run] of this.runs) {
      if (run.endSeq === undefined) {
        run.cutOff = true;
        const ev = this.runEvents.get(run);
        if (ev) ev.detail = 'no result: the session ended before it finished';
      }
      this.runs.delete(key);
    }
  }

  private afterApply(rec: AnyRecord, existed: boolean): void {
    switch (rec.k) {
      case Kind.SESSION_START: {
        this.cutOffRuns();
        const prev = this.sessions.at(-1);
        if (prev && prev.endT === undefined) prev.lastT = this.sessionLastT;
        this.closeSession(this.sessionLastT);
        const b = rec.b;
        const settings: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(b.settings ?? {})) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') settings[k] = v;
        }
        const session: SessionInfo = {
          index: this.sessions.length + 1,
          seq: rec.s,
          t: rec.t,
          app: b.app,
          vsc: b.vsc,
          os: b.os,
          ext: b.ext,
          aiExt: [...b.aiExt],
          liveShare: b.liveShare,
          settings,
          key: keyFingerprint(b.pub),
        };
        this.sessions.push(session);
        this.openSession = { from: rec.t, to: rec.t, seqFrom: rec.s };
        const ai = b.aiExt.length > 0 ? ` · AI extensions: ${b.aiExt.join(', ')}` : '';
        this.event(rec, 'session', `Session ${session.index} started`, {
          detail: `${b.app} ${b.vsc} on ${b.os}, recorder ${b.ext}${ai}`,
        });
        break;
      }
      case Kind.SESSION_END: {
        const session = this.sessions.at(-1);
        if (session) {
          session.endSeq = rec.s;
          session.endT = rec.t;
          session.endReason = rec.b.reason;
        }
        this.cutOffRuns();
        this.closeSession(rec.t);
        this.event(rec, 'session', `Session ${session?.index ?? '?'} ended`, { detail: rec.b.reason });
        break;
      }
      case Kind.FILE_SNAPSHOT: {
        const b = rec.b;
        const file = this.replayer.files.get(b.f);
        if (!file) break;
        if (!existed) {
          this.introduce(b.f, b.path, rec);
          if (b.origin === 'external') {
            this.event(rec, 'external', `${b.path} appeared outside the editor`, {
              f: b.f,
              chars: b.text.length,
              tone: 'notice',
            });
            this.marker(rec, 'external', `${b.path} appeared`, b.text.length, b.f);
          } else if (b.origin === 'paused-gap') {
            this.event(rec, 'pause', `${b.path} appeared while recording was paused`, {
              f: b.f,
              tone: 'notice',
            });
          } else if (b.origin === 'created') {
            this.event(rec, 'file', `${b.path} created`, { f: b.f, chars: b.text.length });
          }
          break;
        }
        if (this.recInserted === 0 && this.recDeleted === 0) break;
        const delta = `+${this.recInserted} −${this.recDeleted} characters`;
        if (b.origin === 'external') {
          const vcs = this.vcsHint.delete(b.f);
          this.event(rec, 'external', `${b.path} changed outside the editor`, {
            f: b.f,
            detail: vcs ? `${delta} · during a version-control operation` : delta,
            tone: 'notice',
          });
          this.marker(rec, 'external', `${b.path} changed outside the editor`, this.recInserted, b.f);
        } else if (b.origin === 'resync') {
          this.event(rec, 'integrity', `Recorder re-synchronised ${b.path}`, {
            f: b.f,
            detail: `${delta} · some edits were not captured`,
            tone: 'warning',
          });
        } else if (b.origin === 'paused-gap') {
          this.event(rec, 'pause', `${b.path} changed while recording was paused`, {
            f: b.f,
            detail: delta,
            tone: 'notice',
          });
        }
        break;
      }
      case Kind.EDIT_BATCH: {
        this.lastEditSeq = rec.s;
        // The record's time is that of its last change; each change carries the gap since the
        // previous one, so earlier changes get earlier times.
        const changes = rec.b.c;
        if (this.recEvents.length === changes.length) {
          let t = rec.t;
          for (let i = changes.length - 1; i >= 0; i--) {
            this.recEvents[i]!.t = t;
            t -= changes[i]![0];
          }
        }
        break;
      }
      case Kind.SAVE:
        this.onSave(rec.s, rec.t, rec.b.f);
        break;
      case Kind.FILE_OP: {
        const b = rec.b;
        const where = b.origin === 'external' ? ' outside the editor' : '';
        if (b.op === 'create') {
          if (!this.replayer.files.has(b.f)) break;
          this.introduce(b.f, b.path, rec);
          this.event(rec, 'file', `${b.path} created${where}`, { f: b.f });
        } else if (b.op === 'delete') {
          const info = this.files.get(b.f);
          if (info) info.deleted = true;
          this.event(rec, 'file', `${b.path} deleted${where}`, { f: b.f });
        } else if (b.newPath !== undefined && this.replayer.files.get(b.f)?.path === b.newPath) {
          const info = this.files.get(b.f);
          if (info) {
            info.path = b.newPath;
            info.paths.push(b.newPath);
          }
          const track = this.tracks.get(b.f);
          if (track) track.track.path = b.newPath;
          this.event(rec, 'file', `${b.path} renamed to ${b.newPath}${where}`, { f: b.f });
        }
        break;
      }
      case Kind.EXTERNAL_CHANGE:
        if (rec.b.hint === 'vcs') this.vcsHint.add(rec.b.f);
        break;
      case Kind.RUN_START: {
        const b = rec.b;
        const run: RunInfo = {
          rid: b.rid,
          session: this.sessions.length,
          kind: b.kind,
          seq: rec.s,
          t: rec.t,
        };
        if (b.name !== undefined) run.name = b.name;
        this.runs.set(`${run.session}:${b.rid}`, run);
        const target = this.lastSaveEntry;
        if (target && this.lastEditSeq < target.seq) {
          target.runs.push(run);
        } else {
          this.history.push({
            id: this.history.length,
            kind: 'run',
            seq: rec.s,
            t: rec.t,
            repeats: 0,
            runs: [run],
          });
        }
        const ev = this.event(rec, 'run', `Ran ${runLabel(run)}`, { detail: 'still running' });
        this.runEvents.set(run, ev);
        break;
      }
      case Kind.RUN_END: {
        const run = this.runs.get(`${this.sessions.length}:${rec.b.rid}`);
        if (!run) break;
        run.endSeq = rec.s;
        run.endT = rec.t;
        if (rec.b.exit !== undefined) run.exit = rec.b.exit;
        const ev = this.runEvents.get(run);
        const failed = run.exit !== undefined && run.exit !== 0;
        if (ev) {
          ev.detail = run.exit === undefined ? 'finished' : `exit code ${run.exit}`;
          if (failed) ev.tone = 'notice';
        }
        const m: Marker = {
          t: run.t,
          seq: run.seq,
          lane: 'run',
          label: `${runLabel(run)}: ${ev?.detail ?? ''}`,
        };
        if (run.exit !== undefined) m.value = run.exit;
        if (failed) m.failed = true;
        this.markers.push(m);
        break;
      }
      case Kind.FOCUS:
        if (!rec.b.on && !this.openUnfocus) this.openUnfocus = { from: rec.t, to: rec.t, seqFrom: rec.s };
        else if (rec.b.on && this.openUnfocus) {
          this.openUnfocus.to = rec.t;
          this.unfocused.push(this.openUnfocus);
          this.openUnfocus = undefined;
        }
        break;
      case Kind.PAUSE:
        if (!this.openPause) this.openPause = { from: rec.t, to: rec.t, seqFrom: rec.s };
        this.event(rec, 'pause', 'Recording paused', rec.b.why ? { detail: rec.b.why } : {});
        break;
      case Kind.RESUME:
        this.closePause(rec.t);
        this.event(rec, 'pause', 'Recording resumed');
        break;
      case Kind.ANCHOR:
        this.marker(rec, 'anchor', `${rec.b.type} timestamp (${rec.b.status})`);
        this.event(rec, 'integrity', `Timestamp from ${rec.b.src}`, {
          detail: `${rec.b.type}, ${rec.b.status}`,
        });
        break;
      case Kind.RECOVERY:
        this.event(rec, 'integrity', 'Recovered after an unexpected shutdown', {
          detail: `${rec.b.lostBytes} damaged bytes set aside`,
          tone: 'warning',
        });
        break;
      case Kind.NOTE:
        this.event(rec, 'note', rec.b.text);
        this.marker(rec, 'note', rec.b.text);
        break;
      case Kind.KEY_ROTATION:
        this.event(rec, 'integrity', 'Signing key changed', {
          detail: `new key ${keyFingerprint(rec.b.newPub)} (${rec.b.why === 'lost' ? 'previous key unavailable' : 'replaced'})`,
          tone: 'notice',
        });
        break;
      case Kind.CLOCK_ANOMALY:
        this.event(rec, 'integrity', 'The computer clock jumped', {
          detail: `wall clock moved ${Math.round(rec.b.wallDelta / 1000)} s while ${Math.round(rec.b.monoDelta / 1000)} s passed`,
          tone: 'warning',
        });
        break;
      case Kind.ENV_CHANGE: {
        const parts: string[] = [];
        if (rec.b.aiExt) parts.push(`AI extensions: ${rec.b.aiExt.length ? rec.b.aiExt.join(', ') : 'none'}`);
        if (rec.b.liveShare !== undefined) parts.push(`Live Share ${rec.b.liveShare ? 'on' : 'off'}`);
        if (rec.b.vsc) parts.push(`editor ${rec.b.vsc}`);
        this.event(rec, 'session', 'Environment changed', { detail: parts.join(' · ') });
        break;
      }
      default:
        break;
    }
  }

  private onEdit(e: EditEvent): void {
    const rec = this.rec!;
    const state = this.track(e.f);
    state.text = state.text.slice(0, e.off) + e.ins + state.text.slice(e.off + e.del);
    state.spans.remove(e.off, e.del);
    state.spans.insert(e.off, e.ins.length, e.origin, e.seq);
    const ev: TrackEvent = { seq: e.seq, t: rec.t, off: e.off, del: e.del, ins: e.ins, origin: e.origin };
    if (e.copiedFrom !== undefined) ev.copiedFrom = e.copiedFrom;
    if (e.ins.length > 0 && (e.flags & (Flag.UNDO | Flag.REDO)) !== 0) ev.undo = true;
    applyUndoMark(state.undo, ev);
    const events = state.track.events;
    events.push(ev);
    this.recEvents.push(ev);
    if (events.length % KEYFRAME_EVERY === 0) state.track.keyframes.push(keyframe(state, events.length));
    this.recInserted += e.ins.length;
    this.recDeleted += e.del;

    if (rec.k !== Kind.EDIT_BATCH || e.ins.length === 0) return;
    const minute = Math.floor(rec.t / MINUTE) * MINUTE;
    let bucket = this.activity.get(minute);
    if (!bucket) {
      bucket = { t: minute, typed: 0, pasted: 0, bulk: 0, other: 0 };
      this.activity.set(minute, bucket);
    }
    if (e.origin === 'typed') bucket.typed += e.ins.length;
    else if (PASTE_ORIGINS.has(e.origin)) bucket.pasted += e.ins.length;
    else if (e.origin === 'bulk') bucket.bulk += e.ins.length;
    else bucket.other += e.ins.length;

    if (PASTE_ORIGINS.has(e.origin) || e.origin === 'bulk') {
      const category: EventCategory = e.origin === 'bulk' ? 'bulk' : 'paste';
      const last = this.events.at(-1);
      // Multi-cursor pastes produce several changes in one record: one list entry.
      if (last && last.seq === rec.s && last.category === category && last.f === e.f) {
        last.chars = (last.chars ?? 0) + e.ins.length;
        return;
      }
      const path = state.track.path;
      const lines = e.ins.split('\n').length;
      const what =
        e.origin === 'bulk'
          ? 'Inserted by a tool or AI (completion, agent, snippet)'
          : e.origin === 'internal-copy'
            ? `Pasted a copy of code from ${e.copiedFrom ?? 'this workspace'}`
            : 'Pasted from outside the workspace';
      this.event(rec, category, what, {
        f: e.f,
        chars: e.ins.length,
        detail: `${path} · ${lines} line${lines === 1 ? '' : 's'}`,
        tone: e.origin === 'internal-copy' ? 'normal' : 'notice',
      });
      this.marker(rec, category, `${what} (${e.ins.length} characters)`, e.ins.length, e.f);
    }
  }

  private track(f: number): TrackState {
    let state = this.tracks.get(f);
    if (!state) {
      const path = this.replayer.files.get(f)?.path ?? `file ${f}`;
      state = {
        track: { f, path, events: [], keyframes: [{ index: 0, text: '', spans: [], undo: [] }] },
        text: '',
        spans: new SpanList(),
        undo: new SpanList(),
      };
      this.tracks.set(f, state);
    }
    return state;
  }

  private introduce(f: number, path: string, rec: AnyRecord): void {
    if (!this.files.has(f)) this.files.set(f, { f, path, paths: [path], deleted: false });
    const state = this.track(f);
    state.track.path = path;
    this.lastSave.set(f, {
      text: state.text,
      index: state.track.events.length,
      seq: rec.s,
      t: rec.t,
    });
  }

  private onSave(seq: number, t: number, f: number): void {
    const file = this.replayer.files.get(f);
    const state = this.tracks.get(f) ?? this.track(f);
    if (!file) return;
    const text = file.text;
    const index = state.track.events.length;
    const prev = this.lastSave.get(f) ?? { text: '', index: 0, seq, t };
    this.markers.push({ t, seq, lane: 'save', label: `Saved ${file.path}`, f });
    if (prev.entry && prev.text === text) {
      // Nothing changed since the previous save: fold it into that entry.
      prev.entry.repeats++;
      this.lastSaveEntry = prev.entry;
      return;
    }
    const number = (this.saveCount.get(f) ?? 0) + 1;
    this.saveCount.set(f, number);
    const { added, removed } = diffStats(prev.text, text);
    const entry: HistoryEntry = {
      id: this.history.length,
      kind: 'save',
      seq,
      t,
      f,
      path: file.path,
      number,
      repeats: 0,
      fromIndex: prev.index,
      toIndex: index,
      fromSeq: prev.seq,
      added,
      removed,
      since: intervalStats(state.track.events, prev.index, index, t - prev.t),
      runs: [],
    };
    this.history.push(entry);
    this.lastSave.set(f, { text, index, seq, t, entry });
    this.lastSaveEntry = entry;
  }

  private event(
    rec: AnyRecord,
    category: EventCategory,
    label: string,
    extra: Partial<Omit<LogEvent, 'seq' | 't' | 'category' | 'label'>> = {},
  ): LogEvent {
    const ev: LogEvent = { seq: rec.s, t: rec.t, category, label, ...extra };
    if (ev.f !== undefined && ev.path === undefined) {
      const path = this.replayer.files.get(ev.f)?.path ?? this.files.get(ev.f)?.path;
      if (path !== undefined) ev.path = path;
    }
    this.events.push(ev);
    return ev;
  }

  private marker(rec: AnyRecord, lane: Marker['lane'], label: string, value?: number, f?: number): void {
    const m: Marker = { t: rec.t, seq: rec.s, lane, label };
    if (value !== undefined) m.value = value;
    if (f !== undefined) m.f = f;
    this.markers.push(m);
  }

  private closePause(t: number): void {
    if (!this.openPause) return;
    this.openPause.to = t;
    this.pauses.push(this.openPause);
    this.openPause = undefined;
  }

  private closeSession(t: number): void {
    this.closePause(t);
    if (this.openUnfocus) {
      this.openUnfocus.to = t;
      this.unfocused.push(this.openUnfocus);
      this.openUnfocus = undefined;
    }
    if (this.openSession) {
      this.openSession.to = Math.max(this.openSession.from, t);
      this.sessionRanges.push(this.openSession);
      this.openSession = undefined;
    }
  }

  /** Snapshot of everything appended so far. */
  result(): LogModel {
    const end = this.lastT;
    const open = this.sessions.at(-1);
    const sessions =
      open && open.endT === undefined
        ? [...this.sessions.slice(0, -1), { ...open, lastT: this.sessionLastT }]
        : this.sessions;
    const close = (open: Range | undefined, list: Range[]) => (open ? [...list, { ...open, to: end }] : list);
    const composition: Composition = this.compositionOf();
    const files = [...this.files.values()]
      .map((info) => {
        const copy: FileInfo = { ...info, paths: [...info.paths] };
        const live = this.replayer.files.get(info.f);
        if (live?.spans) {
          const c = emptyComposition();
          addSpans(c, live.text, live.spans.toArray());
          copy.composition = c;
        }
        return copy;
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const model: LogModel = {
      recordCount: this.recordCount,
      files,
      tracks: [...this.tracks.values()].map((s) => s.track),
      history: this.history,
      events: this.events,
      sessions,
      timeline: {
        start: this.firstT ?? 0,
        end,
        activity: [...this.activity.values()],
        markers: this.markers,
        pauses: close(this.openPause, this.pauses),
        unfocused: close(this.openUnfocus, this.unfocused),
        sessions: close(this.openSession, this.sessionRanges),
      },
      composition,
      weakenings: weakenings(this.sessions.at(-1)),
    };
    if (this.header) model.header = this.header;
    if (this.problem) model.problem = this.problem;
    return model;
  }

  private compositionOf(): Composition {
    const total = emptyComposition();
    for (const file of this.replayer.files.values())
      if (file.spans) addSpans(total, file.text, file.spans.toArray());
    return total;
  }
}

function keyframe(state: TrackState, index: number): Keyframe {
  return {
    index,
    text: state.text,
    spans: state.spans.toArray().map((s) => ({ ...s })),
    undo: state.undo.toArray().map((s) => ({ ...s })),
  };
}

function addSpans(total: Composition, text: string, spans: readonly Span[]): void {
  let pos = 0;
  for (const span of spans) {
    const nonWs = countNonWhitespace(text.slice(pos, pos + span.len));
    const entry = total.byOrigin[span.origin] ?? { chars: 0, nonWs: 0 };
    entry.chars += span.len;
    entry.nonWs += nonWs;
    total.byOrigin[span.origin] = entry;
    total.chars += span.len;
    total.nonWs += nonWs;
    pos += span.len;
  }
}

export function intervalStats(
  events: readonly TrackEvent[],
  from: number,
  to: number,
  durationMs: number,
): IntervalStats {
  const stats: IntervalStats = {
    durationMs: Math.max(0, durationMs),
    activeMs: 0,
    edits: to - from,
    insertedChars: 0,
    deletedChars: 0,
    byOrigin: {},
    pastes: [],
  };
  let prevT: number | undefined;
  for (let i = from; i < to; i++) {
    const e = events[i]!;
    if (prevT !== undefined && e.t - prevT <= ACTIVE_GAP_MS) stats.activeMs += Math.max(0, e.t - prevT);
    prevT = e.t;
    stats.insertedChars += e.ins.length;
    stats.deletedChars += e.del;
    const nonWs = countNonWhitespace(e.ins);
    if (nonWs > 0) stats.byOrigin[e.origin] = (stats.byOrigin[e.origin] ?? 0) + nonWs;
    if (PASTE_ORIGINS.has(e.origin) && e.ins.length > 0) {
      const last = stats.pastes.at(-1);
      if (last && last.seq === e.seq) {
        last.chars += e.ins.length;
        continue;
      }
      const paste: PasteInfo = {
        seq: e.seq,
        chars: e.ins.length,
        lines: e.ins.split('\n').length,
        origin: e.origin,
      };
      if (e.copiedFrom !== undefined) paste.copiedFrom = e.copiedFrom;
      stats.pastes.push(paste);
    }
  }
  return stats;
}

function runLabel(run: RunInfo): string {
  const what = run.kind === 'debug' ? 'debug session' : run.kind;
  return run.name ? `${what} "${run.name}"` : what;
}

/** Settings that make the log weaker evidence than the defaults would (design §12.1 panel 6). */
export function weakenings(session: SessionInfo | undefined): Weakening[] {
  if (!session) return [];
  const out: Weakening[] = [];
  const s = session.settings;
  if (s['tap.record.focus'] === false) {
    out.push({ setting: 'tap.record.focus', value: 'false', why: 'Window focus changes are not recorded.' });
  }
  const clip = s['tap.classify.clipboardCheckMinChars'];
  if (typeof clip === 'number' && clip > 2) {
    out.push({
      setting: 'tap.classify.clipboardCheckMinChars',
      value: String(clip),
      why: `Insertions shorter than ${clip} characters are not compared with the clipboard.`,
    });
  }
  const bulk = s['tap.classify.bulkMinChars'];
  if (typeof bulk === 'number' && bulk > 40) {
    out.push({
      setting: 'tap.classify.bulkMinChars',
      value: String(bulk),
      why: `Insertions up to ${bulk - 1} characters that did not come from the clipboard count as typed.`,
    });
  }
  if (session.liveShare) {
    out.push({ setting: 'Live Share', value: 'active', why: 'Other people could edit through Live Share.' });
  }
  return out;
}
