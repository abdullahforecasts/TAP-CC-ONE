import type { Composition, Origin, Span, VerifyReport } from '@tap/core';

/** One change to a file, as the replay player applies it. */
export interface TrackEvent {
  seq: number;
  /** Wall-clock time of the record (unix ms). */
  t: number;
  off: number;
  del: number;
  ins: string;
  origin: Origin;
  copiedFrom?: string;
}

/** Full text and origins after `index` events (0 = before the first event). */
export interface Keyframe {
  index: number;
  text: string;
  spans: Span[];
}

/** Everything that happened to one file's text, for the replay player. */
export interface FileTrack {
  f: number;
  /** Path at the end of the log (or when it was deleted). */
  path: string;
  events: TrackEvent[];
  keyframes: Keyframe[];
}

export interface FileInfo {
  f: number;
  path: string;
  /** Every path the file had, oldest first. */
  paths: string[];
  deleted: boolean;
  /** Final composition of this file's text (live files only). */
  composition?: Composition;
}

export interface RunInfo {
  rid: number;
  session: number;
  kind: 'debug' | 'task' | 'terminal';
  name?: string;
  seq: number;
  t: number;
  endSeq?: number;
  endT?: number;
  exit?: number;
  /** The session ended (VS Code closed, crash) before the run reported a result. */
  cutOff?: boolean;
}

export interface PasteInfo {
  seq: number;
  chars: number;
  lines: number;
  origin: Origin;
  copiedFrom?: string;
}

/** How the code between two saves arrived (design §12.1). */
export interface IntervalStats {
  /** From the previous save of the file (or when the file appeared) to this save. */
  durationMs: number;
  /** Sum of gaps between consecutive changes, counting gaps of at most 5 minutes. */
  activeMs: number;
  /** Number of changes. */
  edits: number;
  insertedChars: number;
  deletedChars: number;
  /** Inserted non-whitespace characters by origin. */
  byOrigin: Partial<Record<Origin, number>>;
  pastes: PasteInfo[];
}

/** One entry in Save History: a save of a file (with the runs that followed it) or a run. */
export interface HistoryEntry {
  id: number;
  kind: 'save' | 'run';
  seq: number;
  t: number;
  f?: number;
  path?: string;
  /** Per-file save number (1 = first save of the file). */
  number?: number;
  /** Saves merged into this entry because nothing changed in between. */
  repeats: number;
  /** Replay positions in the file's track: the interval this save covers. */
  fromIndex?: number;
  toIndex?: number;
  fromSeq?: number;
  added?: number;
  removed?: number;
  since?: IntervalStats;
  runs: RunInfo[];
}

export type EventCategory =
  | 'paste'
  | 'bulk'
  | 'external'
  | 'run'
  | 'note'
  | 'file'
  | 'session'
  | 'pause'
  | 'integrity';

export interface LogEvent {
  seq: number;
  t: number;
  category: EventCategory;
  label: string;
  detail?: string;
  f?: number;
  path?: string;
  /** Characters involved (pastes, bulk inserts, external changes). */
  chars?: number;
  /** Severity hint for the list. */
  tone?: 'normal' | 'notice' | 'warning';
}

export interface SessionInfo {
  index: number;
  seq: number;
  t: number;
  endSeq?: number;
  endT?: number;
  endReason?: string;
  /** Time of the session's last record when it has no SESSION_END (crash, or still recording). */
  lastT?: number;
  app: string;
  vsc: string;
  os: string;
  ext: string;
  aiExt: string[];
  liveShare: boolean;
  settings: Record<string, string | number | boolean>;
  /** Fingerprint of the session's signing key. */
  key: string;
}

/** One minute of activity, for the timeline's typing lane. */
export interface ActivityBucket {
  /** Start of the minute (unix ms). */
  t: number;
  typed: number;
  pasted: number;
  bulk: number;
  other: number;
}

export interface Range {
  from: number;
  to: number;
  seqFrom: number;
}

export interface Marker {
  t: number;
  seq: number;
  lane: 'paste' | 'bulk' | 'run' | 'save' | 'external' | 'note' | 'anchor';
  label: string;
  /** Runs: exit code; pastes/bulk: characters. */
  value?: number;
  failed?: boolean;
  /** File the marker belongs to (opens the replay there). */
  f?: number;
}

export interface TimelineData {
  start: number;
  end: number;
  activity: ActivityBucket[];
  markers: Marker[];
  pauses: Range[];
  unfocused: Range[];
  sessions: Range[];
}

export interface Weakening {
  setting: string;
  value: string;
  why: string;
}

export interface LogModel {
  header?: { logId: string; created: number; tool: string; label?: string };
  recordCount: number;
  files: FileInfo[];
  tracks: FileTrack[];
  history: HistoryEntry[];
  events: LogEvent[];
  sessions: SessionInfo[];
  timeline: TimelineData;
  /** Composition of all live files at the end of the log. */
  composition: Composition;
  weakenings: Weakening[];
  /** Set when the log could not be read past some point. */
  problem?: string;
}

/** What the viewer shows: the model plus the verifier's report. */
export interface ViewData {
  model: LogModel;
  report: VerifyReport;
  /** Where the submission came from (e.g. "files in the workspace"). */
  comparedWith?: string;
}
