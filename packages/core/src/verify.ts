import {
  type ActivitySummary,
  aiOnWhileDeclaredOff,
  codeLinesOf,
  compareVersions,
  REUSE_MIN_LINES,
  REUSE_MIN_SHARE,
  REUSE_WINDOW_MS,
  summarizeActivity,
  type TerminalReuse,
  weakenedSetting,
} from './activity.js';
import { bytesEqual, toHex } from './bytes.js';
import { Flag, Kind } from './constants.js';
import { checkpointMessage, keyFingerprint, verifySignature } from './crypto.js';
import { TapError } from './errors.js';
import { genesisHash, recordHash, sha256 } from './hash.js';
import { toLogPath } from './paths.js';
import type { Composition } from './provenance.js';
import { type ParsedLog, readLog } from './reader.js';
import type { AnchorBody, AnyRecord } from './records.js';
import { Replayer, type Severity } from './replay.js';
import { contentHash } from './text.js';

export type Stage = 'parse' | 'chain' | 'signatures' | 'anchors' | 'replay' | 'submission' | 'activity';

export interface Finding {
  stage: Stage;
  severity: Severity | 'pass';
  code: string;
  message: string;
  seq?: number;
  offset?: number;
}

export type Verdict = 'INTACT' | 'INTACT_WITH_WARNINGS' | 'NOT_INTACT';

export interface SubmittedFile {
  /** Path relative to the submission root; '\\' separators are accepted. */
  path: string;
  content: Uint8Array | string;
}

/** A shipped attachment given by its SHA-256 instead of its content. */
export interface AttachmentRef {
  path: string;
  sha256: Uint8Array;
}

/** Result of checking one ANCHOR token (supplied by @tap/anchor; the core does no X.509/CMS). */
export interface AnchorCheck {
  /**
   * valid: an RFC 3161 token signed by a trusted TSA; untrusted: correct but from a TSA that is
   * not trusted; confirmed: an OpenTimestamps proof down to a Bitcoin block; pending: an
   * OpenTimestamps proof that is still waiting at a calendar; invalid: the token is wrong.
   */
  status: 'valid' | 'untrusted' | 'confirmed' | 'pending' | 'invalid';
  /** Independent time: the TSA's genTime, or the Bitcoin block time when known (unix ms). */
  time?: number;
  /** Who vouches for the time (TSA certificate name, or "Bitcoin block N"). */
  authority?: string;
  bitcoinHeight?: number;
  problem?: string;
  message?: string;
}

/** Checks the token of an ANCHOR record whose digest already matches its checkpoint. */
export type AnchorVerifier = (anchor: AnchorBody) => AnchorCheck;

export interface VerifyOptions {
  /** The submitted code to compare with the final logged state (stage 6). */
  submission?: readonly SubmittedFile[];
  /** Verifies timestamp tokens (stage 4). Without it, tokens are reported as not verified. */
  anchorVerifier?: AnchorVerifier;
  /**
   * Files that are not code shipped with the submission (an export's attachments/ folder,
   * 0.3.4), compared with what the log recorded about them (stage 7). Content or its SHA-256.
   */
  attachments?: readonly (SubmittedFile | AttachmentRef)[];
}

/** One ANCHOR record as the verifier saw it. */
export interface AnchorInfo {
  seq: number;
  ck: number;
  /** Time of the ANCHOR record itself (self-asserted). */
  t: number;
  type: 'rfc3161' | 'ots';
  src: string;
  status: AnchorCheck['status'] | 'unverified';
  time?: number;
  authority?: string;
  bitcoinHeight?: number;
  message?: string;
}

/** Independent timestamps over the log (design §9.7). */
export interface AnchoringSummary {
  checkpoints: number;
  /** Checkpoints with at least one valid timestamp (RFC 3161 or a time-checked Bitcoin proof). */
  anchoredCheckpoints: number;
  /** Share (0–1) of edit records followed by an anchored checkpoint. */
  coverage: number;
  anchors: AnchorInfo[];
  /**
   * For each anchored checkpoint, in log order: the earliest independent time vouching for it.
   * Every record up to `seq` existed by the minimum `time` of this entry and all later ones.
   */
  existedBy: Array<{ seq: number; time: number }>;
}

export interface FinalFile {
  f: number;
  path: string;
  /** Length in UTF-16 code units. */
  length: number;
  /** Hex SHA-256 of the normalised content. */
  sha256: string;
}

export interface LogStats {
  sessions: number;
  changes: number;
  pastes: number;
  bulkInserts: number;
  saves: number;
  runs: number;
  checkpoints: number;
  anchors: number;
  pauses: number;
  recoveries: number;
  resyncs: number;
  firstTime?: number;
  lastTime?: number;
}

export interface VerifyReport {
  verdict: Verdict;
  findings: Finding[];
  size: number;
  header?: { logId: string; created: number; tool: string; label?: string };
  blockCount: number;
  recordCount: number;
  /** Fingerprints of every signing key seen, in order of first use. */
  keys: string[];
  notes: Array<{ seq: number; t: number; text: string }>;
  stats: LogStats;
  finalFiles: FinalFile[];
  /** Final-code composition: all live files, or only the matched submitted files. */
  composition?: Composition;
  anchoring?: AnchoringSummary;
  /** How the code was written around the edits (stage 7, 0.3.3). */
  activity?: ActivitySummary;
}

const MAX_CLOCK_FINDINGS = 10;
const CLOCK_TOLERANCE_MS = 2000;
/** A checkpoint time more than this after its independent time means the clock ran ahead (§9.7). */
export const ANCHOR_FUTURE_TOLERANCE_MS = 120_000;
/** Anchored more than this after the checkpoint: "anchored late (offline?)". */
export const ANCHOR_LATE_MS = 15 * 60_000;
/** Clock behind real time by more than this is reported (0.3.3). */
export const CLOCK_BEHIND_MS = 10 * 60_000;

function verdictOf(findings: readonly Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'fail')) return 'NOT_INTACT';
  if (findings.some((f) => f.severity === 'warn')) return 'INTACT_WITH_WARNINGS';
  return 'INTACT';
}

function emptyStats(): LogStats {
  return {
    sessions: 0,
    changes: 0,
    pastes: 0,
    bulkInserts: 0,
    saves: 0,
    runs: 0,
    checkpoints: 0,
    anchors: 0,
    pauses: 0,
    recoveries: 0,
    resyncs: 0,
  };
}

/**
 * Verifies a log (design §13.2, stages 1–6). Timestamp tokens are checked when an
 * `anchorVerifier` is given (see @tap/anchor). Never throws for bad input: every problem becomes
 * a finding.
 */
export function verifyLog(bytes: Uint8Array, options: VerifyOptions = {}): VerifyReport {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const report: VerifyReport = {
    verdict: 'NOT_INTACT',
    findings,
    size: bytes.length,
    blockCount: 0,
    recordCount: 0,
    keys: [],
    notes: [],
    stats: emptyStats(),
    finalFiles: [],
  };

  // ---- Stage 1: parse -------------------------------------------------------------------------
  let log: ParsedLog;
  try {
    log = readLog(bytes);
  } catch (e) {
    if (!(e instanceof TapError)) throw e;
    const f: Finding = { stage: 'parse', severity: 'fail', code: e.code, message: e.message };
    if (e.offset !== undefined) f.offset = e.offset;
    if (e.seq !== undefined) f.seq = e.seq;
    add(f);
    report.verdict = verdictOf(findings);
    return report;
  }
  const records = log.records.map((r) => r.record);
  report.header = {
    logId: toHex(log.header.logId),
    created: log.header.created,
    tool: log.header.tool,
    ...(log.header.label !== undefined ? { label: log.header.label } : {}),
  };
  report.blockCount = log.blockCount;
  report.recordCount = records.length;
  add({
    stage: 'parse',
    severity: 'pass',
    code: 'PARSE_OK',
    message: `File structure valid (${log.blockCount} blocks, ${records.length} records)`,
  });

  // ---- Stage 2: chain -------------------------------------------------------------------------
  const hashes: Uint8Array[] = [];
  let head = genesisHash(log.headerBytes);
  for (let i = 0; i < log.records.length; i++) {
    const { record, bytes: recBytes, blockOffset } = log.records[i]!;
    if (record.s !== i) {
      add({
        stage: 'chain',
        severity: 'fail',
        code: 'SEQ_GAP',
        message: `expected sequence ${i}, found ${record.s}`,
        seq: i,
        offset: blockOffset,
      });
      break;
    }
    if (!bytesEqual(record.p, head)) {
      add({
        stage: 'chain',
        severity: 'fail',
        code: 'CHAIN_BROKEN',
        message: `record ${i} does not link to ${i === 0 ? 'the header' : `record ${i - 1}`}: the log was modified`,
        seq: i,
        offset: blockOffset,
      });
      break;
    }
    head = recordHash(recBytes);
    hashes.push(head);
  }
  if (records.length > 0 && records[0]!.k !== Kind.SESSION_START && hashes.length === records.length) {
    add({
      stage: 'chain',
      severity: 'fail',
      code: 'FIRST_RECORD_NOT_SESSION_START',
      message: 'the first record must be SESSION_START',
      seq: 0,
    });
  }
  if (findings.some((f) => f.severity === 'fail')) {
    report.verdict = verdictOf(findings);
    return report;
  }
  add({
    stage: 'chain',
    severity: 'pass',
    code: 'CHAIN_OK',
    message: `Hash chain intact (${records.length} records)`,
  });

  // ---- Stage 3: signatures --------------------------------------------------------------------
  const keyHexes: string[] = [];
  let activeKey: Uint8Array | null = null;
  let announcedKey: Uint8Array | null = null;
  let lastCheckpoint = -1;
  for (const rec of records) {
    if (rec.k === Kind.SESSION_START) {
      const pub = rec.b.pub;
      if (activeKey && !bytesEqual(pub, activeKey) && !(announcedKey && bytesEqual(pub, announcedKey))) {
        add({
          stage: 'signatures',
          severity: 'warn',
          code: 'KEY_CHANGED',
          message: `signing key changed to ${keyFingerprint(pub)} without a KEY_ROTATION record`,
          seq: rec.s,
        });
      }
      if (!keyHexes.includes(toHex(pub))) {
        keyHexes.push(toHex(pub));
        report.keys.push(keyFingerprint(pub));
      }
      activeKey = pub;
      announcedKey = null;
    } else if (rec.k === Kind.KEY_ROTATION) {
      add({
        stage: 'signatures',
        severity: 'warn',
        code: 'KEY_ROTATED',
        message: `signing key replaced (${rec.b.why}); new key ${keyFingerprint(rec.b.newPub)}`,
        seq: rec.s,
      });
      announcedKey = rec.b.newPub;
    } else if (rec.k === Kind.CHECKPOINT) {
      report.stats.checkpoints++;
      lastCheckpoint = rec.s;
      // Stage 2 guarantees record 0 is SESSION_START, so a session key is always active here.
      const msg = checkpointMessage({
        logId: log.header.logId,
        s: rec.s,
        p: rec.p,
        state: rec.b.state,
        t: rec.t,
      });
      if (!verifySignature(rec.b.sig, msg, activeKey!)) {
        add({
          stage: 'signatures',
          severity: 'fail',
          code: 'BAD_SIGNATURE',
          message: `checkpoint ${rec.s} signature is not valid for the session key`,
          seq: rec.s,
        });
      }
    }
  }
  if (report.stats.checkpoints === 0) {
    add({
      stage: 'signatures',
      severity: 'warn',
      code: 'NO_CHECKPOINTS',
      message: 'the log has no signed checkpoints',
    });
  } else if (!findings.some((f) => f.stage === 'signatures' && f.severity === 'fail')) {
    add({
      stage: 'signatures',
      severity: 'pass',
      code: 'SIGNATURES_OK',
      message: `${report.stats.checkpoints} checkpoint signatures valid (${report.keys.length} key${
        report.keys.length === 1 ? '' : 's'
      })`,
    });
  }
  const tailEdits = records.slice(lastCheckpoint + 1).filter((r) => r.k === Kind.EDIT_BATCH).length;
  if (report.stats.checkpoints > 0 && tailEdits > 0) {
    add({
      stage: 'signatures',
      severity: 'info',
      code: 'UNCHECKPOINTED_TAIL',
      message: `${tailEdits} edit record(s) after the last checkpoint`,
      seq: lastCheckpoint + 1,
    });
  }

  // ---- Stage 4: anchors -----------------------------------------------------------------------
  report.anchoring = verifyAnchors(records, hashes, options.anchorVerifier, add);
  report.stats.anchors = records.filter((r) => r.k === Kind.ANCHOR).length;

  // ---- Stage 5: replay ------------------------------------------------------------------------
  const replayer = new Replayer({ provenance: true });
  let replayFailed = false;
  let inSession = false;
  let sessionSid: Uint8Array | null = null;
  let prevT: number | null = null;
  let prevM: number | null = null;
  let clockFindings = 0;
  const stats = report.stats;
  // Terminal output waiting to be compared with the code (D2), and the last terminal command (D9).
  const runCmds = new Map<number, { cmd: string; t: number }>();
  let lastTerminal: { cmd: string; t: number } | undefined;
  const pendingOutput: Array<{
    seq: number;
    t: number;
    cmd: string;
    lines: Map<string, string>;
    before: Set<string>;
    best?: TerminalReuse;
  }> = [];
  const reuse: TerminalReuse[] = [];
  const liveCodeLines = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const file of replayer.liveFiles()) {
      for (const n of codeLinesOf(file.text).keys()) if (!out.has(n)) out.set(n, file.path);
    }
    return out;
  };
  const settleOutput = (p: (typeof pendingOutput)[number]) => {
    if (p.best) reuse.push(p.best);
  };
  const compareOutput = (t: number) => {
    if (pendingOutput.length === 0) return;
    const now = liveCodeLines();
    for (let i = pendingOutput.length - 1; i >= 0; i--) {
      const p = pendingOutput[i]!;
      const matched = [...p.lines.keys()].filter((n) => now.has(n) && !p.before.has(n));
      if (
        matched.length >= REUSE_MIN_LINES &&
        matched.length / p.lines.size >= REUSE_MIN_SHARE &&
        (!p.best || matched.length > p.best.lines)
      ) {
        p.best = {
          seq: p.seq,
          t: p.t,
          cmd: p.cmd,
          lines: matched.length,
          outputLines: p.lines.size,
          files: [...new Set(matched.map((n) => now.get(n)!))].sort(),
          sample: matched.slice(0, 5).map((n) => p.lines.get(n)!),
          foundAt: t,
        };
      }
      if (t - p.t > REUSE_WINDOW_MS) {
        settleOutput(p);
        pendingOutput.splice(i, 1);
      }
    }
  };
  for (const rec of records) {
    stats.firstTime ??= rec.t;
    stats.lastTime = rec.t;
    // Session structure and clocks.
    if (rec.k === Kind.SESSION_START) {
      if (inSession) {
        add({
          stage: 'replay',
          severity: 'info',
          code: 'SESSION_NOT_CLOSED',
          message: 'previous session ended without SESSION_END (crash or forced quit)',
          seq: rec.s,
        });
      }
      inSession = true;
      sessionSid = rec.b.sid;
      prevM = null;
      stats.sessions++;
    } else if (rec.k === Kind.RECOVERY) {
      // Recovery happens when a log is reopened after a crash: it closes any session left open.
      if (inSession) {
        add({
          stage: 'replay',
          severity: 'info',
          code: 'SESSION_NOT_CLOSED',
          message: 'previous session ended without SESSION_END (crash or forced quit)',
          seq: rec.s,
        });
      }
      inSession = false;
      sessionSid = null;
      prevM = null;
    } else if (!inSession && rec.k !== Kind.KEY_ROTATION) {
      add({
        stage: 'replay',
        severity: 'warn',
        code: 'RECORD_OUTSIDE_SESSION',
        message: 'record appears between sessions',
        seq: rec.s,
      });
    }
    if (prevT !== null && rec.t + CLOCK_TOLERANCE_MS < prevT && clockFindings < MAX_CLOCK_FINDINGS) {
      clockFindings++;
      add({
        stage: 'replay',
        severity: 'warn',
        code: 'CLOCK_BACKWARDS',
        message: `wall clock went back ${prevT - rec.t} ms`,
        seq: rec.s,
      });
    }
    if (prevM !== null && rec.m < prevM && clockFindings < MAX_CLOCK_FINDINGS) {
      clockFindings++;
      add({
        stage: 'replay',
        severity: 'warn',
        code: 'MONO_BACKWARDS',
        message: 'monotonic time decreased within a session',
        seq: rec.s,
      });
    }
    prevT = rec.t;
    if (inSession) prevM = rec.m;

    switch (rec.k) {
      case Kind.SESSION_END:
        if (sessionSid && !bytesEqual(sessionSid, rec.b.sid)) {
          add({
            stage: 'replay',
            severity: 'warn',
            code: 'SESSION_ID_MISMATCH',
            message: 'SESSION_END does not match the open session',
            seq: rec.s,
          });
        }
        inSession = false;
        sessionSid = null;
        break;
      case Kind.EDIT_BATCH:
        for (const c of rec.b.c) {
          stats.changes++;
          const flags = c[4] ?? 0;
          if (flags & Flag.PASTE) stats.pastes++;
          if (flags & Flag.BULK) stats.bulkInserts++;
        }
        break;
      case Kind.SAVE:
        stats.saves++;
        break;
      case Kind.RUN_START:
        stats.runs++;
        if (rec.b.kind === 'terminal' && rec.b.cmd) {
          runCmds.set(rec.b.rid, { cmd: rec.b.cmd, t: rec.t });
          lastTerminal = { cmd: rec.b.cmd, t: rec.t };
        }
        break;
      case Kind.RUN_END: {
        const run = runCmds.get(rec.b.rid);
        if (run && rec.b.out !== undefined && !replayFailed) {
          const lines = codeLinesOf(rec.b.out);
          if (lines.size >= REUSE_MIN_LINES) {
            pendingOutput.push({
              seq: rec.s,
              t: rec.t,
              cmd: run.cmd,
              lines,
              before: new Set(liveCodeLines().keys()),
            });
          }
        }
        runCmds.delete(rec.b.rid);
        break;
      }
      case Kind.PAUSE:
        stats.pauses++;
        add({ stage: 'replay', severity: 'info', code: 'PAUSED', message: 'recording paused', seq: rec.s });
        break;
      case Kind.RECOVERY:
        stats.recoveries++;
        add({
          stage: 'replay',
          severity: 'warn',
          code: 'RECOVERED',
          message: `recorder recovered from a damaged log tail (${rec.b.lostBytes} bytes quarantined)`,
          seq: rec.s,
        });
        break;
      case Kind.CLOCK_ANOMALY:
        add({
          stage: 'replay',
          severity: 'warn',
          code: 'CLOCK_ANOMALY',
          message: `recorder noticed a clock jump (wall ${rec.b.wallDelta} ms vs monotonic ${rec.b.monoDelta} ms)`,
          seq: rec.s,
        });
        break;
      case Kind.NOTE:
        report.notes.push({ seq: rec.s, t: rec.t, text: rec.b.text });
        break;
      case Kind.FILE_SNAPSHOT:
        if (rec.b.origin === 'resync') stats.resyncs++;
        break;
      case Kind.CHECKPOINT: {
        if (replayFailed) break;
        const digest = replayer.stateDigest();
        if (!bytesEqual(digest, rec.b.state) || replayer.files.size !== rec.b.files) {
          add({
            stage: 'replay',
            severity: 'fail',
            code: 'CHECKPOINT_STATE_MISMATCH',
            message: `checkpoint ${rec.s} does not match the replayed code`,
            seq: rec.s,
          });
          replayFailed = true;
        }
        break;
      }
      default:
        break;
    }
    if (replayFailed) continue;
    for (const issue of replayer.apply(rec)) {
      let message = issue.message;
      if (
        (issue.code === 'EXTERNAL_CHANGE' || issue.code === 'EXTERNAL_FILE') &&
        lastTerminal &&
        rec.t - lastTerminal.t >= 0 &&
        rec.t - lastTerminal.t <= 120_000
      ) {
        message += ` (${Math.round((rec.t - lastTerminal.t) / 1000)} s after the terminal command "${shorten(lastTerminal.cmd, 120)}")`;
      }
      add({
        stage: 'replay',
        severity: issue.severity,
        code: issue.code,
        message,
        seq: issue.seq,
      });
      if (issue.severity === 'fail') replayFailed = true;
    }
    if (!replayFailed && (rec.k === Kind.CHECKPOINT || rec.k === Kind.SAVE)) compareOutput(rec.t);
  }
  if (!replayFailed) {
    compareOutput(stats.lastTime ?? 0);
    for (const p of pendingOutput) settleOutput(p);
  }
  if (!replayFailed) {
    for (const issue of replayer.finish()) {
      add({
        stage: 'replay',
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        seq: issue.seq,
      });
    }
    add({
      stage: 'replay',
      severity: 'pass',
      code: 'REPLAY_OK',
      message: `Replay consistent with all ${stats.saves} saves and ${stats.checkpoints} checkpoints`,
    });
    report.finalFiles = replayer.liveFiles().map((file) => ({
      f: file.f,
      path: file.path,
      length: file.text.length,
      sha256: toHex(contentHash(file.text)),
    }));
  }

  // ---- Stage 6: submission match --------------------------------------------------------------
  if (!replayFailed && options.submission) {
    const matched = compareSubmission(replayer, options.submission, add);
    report.composition = replayer.composition(matched);
  } else if (!replayFailed) {
    report.composition = replayer.composition();
  }

  // ---- Stage 7: activity ----------------------------------------------------------------------
  const activity = summarizeActivity(records);
  activity.terminalReuse = reuse.sort((a, b) => a.t - b.t);
  report.activity = activity;
  activityFindings(records, report, add);
  if (options.attachments) compareAttachments(activity, options.attachments, add);

  report.verdict = verdictOf(findings);
  return report;
}

const shorten = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s);
const fmtMin = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
const fmtClock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Recorder versions older than this lack independent timestamps and the export command. */
export const OLDEST_FULL_RECORDER = '0.3.0';
/** Logs tracking more files than this probably recorded a folder broader than the assignment. */
export const BROAD_FOLDER_FILES = 50;
/** Time away shorter than this is not listed. */
const AWAY_MIN_MS = 60_000;

function activityFindings(
  records: readonly AnyRecord[],
  report: VerifyReport,
  add: (f: Finding) => void,
): void {
  const activity = report.activity!;
  const act = (severity: Finding['severity'], code: string, message: string, seq?: number) =>
    add({ stage: 'activity', severity, code, message, ...(seq !== undefined ? { seq } : {}) });

  // Recorder versions and settings.
  const versions = new Set<string>();
  for (const rec of records) {
    if (rec.k !== Kind.SESSION_START) continue;
    versions.add(rec.b.ext);
    for (const [key, value] of Object.entries(rec.b.settings ?? {})) {
      const why = weakenedSetting(key, value);
      if (why) act('warn', 'SETTINGS_WEAKENED', `recorded with ${key} = ${String(value)}: ${why}`, rec.s);
    }
  }
  // Only for logs written by the extension itself (other tools may use their own numbering).
  const byExtension = /^tap-cc-one\/\d+\.\d+\.\d+$/.test(report.header?.tool ?? '');
  const old = byExtension ? [...versions].filter((v) => compareVersions(v, OLDEST_FULL_RECORDER) < 0) : [];
  if (old.length > 0) {
    act(
      'warn',
      'RECORDER_OUTDATED',
      `recorded with TAP-CC-ONE ${old.join(', ')}: no independent timestamps, no AI or terminal-output records. Ask students to install the latest version`,
    );
  }
  for (const c of activity.settingsChanges) {
    const why = weakenedSetting(c.key, c.to);
    act(
      why ? 'warn' : 'info',
      'SETTINGS_CHANGED',
      `${c.key} changed from ${String(c.from)} to ${String(c.to)} at ${fmtClock(c.t)} UTC${why ? `: ${why}` : ''}`,
      c.seq,
    );
  }

  // AI: declared choice and actual availability.
  const choice = activity.aiChoices[activity.aiChoices.length - 1];
  const aiOnMs = activity.aiOn.reduce((n, p) => n + (p.to - p.from), 0);
  const periods = activity.aiOn
    .slice(0, 5)
    .map((p) => `${fmtClock(p.from)}-${fmtClock(p.to)}`)
    .join(', ');
  if (choice === 'off' || choice === 'enforced-off') {
    act(
      'info',
      'AI_DECLARED_OFF',
      choice === 'enforced-off'
        ? 'AI features were turned off by the course policy'
        : 'the student chose to turn AI features off when recording started',
    );
    const breach = aiOnWhileDeclaredOff(activity);
    if (breach.ms > 0) {
      act(
        'warn',
        'AI_ON_AFTER_DECLARED_OFF',
        `AI features were available for ${fmtMin(breach.ms)} although they were declared off (UTC ${breach.periods
          .slice(0, 5)
          .map((p) => `${fmtClock(p.from)}-${fmtClock(p.to)}`)
          .join(', ')})`,
      );
    }
  } else if (choice === 'on' || choice === 'unanswered') {
    act(
      'info',
      choice === 'on' ? 'AI_DECLARED_ON' : 'AI_NOT_ANSWERED',
      choice === 'on'
        ? 'the student chose to keep AI features on'
        : 'the student did not answer the "turn off AI features?" question',
    );
    if (aiOnMs > 0) {
      act(
        'info',
        'AI_AVAILABLE',
        `AI suggestions or chat were available for ${fmtMin(aiOnMs)} (UTC ${periods})`,
      );
    }
  }

  // Changes made outside the editor while AI was available: an AI agent (Copilot edits or agent
  // mode, a CLI agent) writes files directly, so its code arrives as an outside change (0.3.4).
  const outsideWhileAi: string[] = [];
  let sessionAt = 0;
  for (const rec of records) {
    if (rec.k === Kind.SESSION_START) sessionAt = rec.t;
    if (rec.k !== Kind.FILE_SNAPSHOT || rec.b.origin !== 'external') continue;
    // Files found changed when a session starts changed while nothing was recorded; editor
    // settings are written by the editor (and by exam mode).
    if (rec.t - sessionAt < 5000 || rec.b.path.startsWith('.vscode/')) continue;
    if (activity.agentOn.some((p) => rec.t >= p.from && rec.t <= p.to)) {
      outsideWhileAi.push(`${rec.b.path} ${fmtClock(rec.t)}`);
    }
  }
  if (outsideWhileAi.length > 0) {
    act(
      'warn',
      'OUTSIDE_CHANGE_WHILE_AI',
      `${outsideWhileAi.length} change(s) arrived from outside the editor while AI features were available (an AI agent such as Copilot's edit or agent mode writes files directly): ${outsideWhileAi.slice(0, 5).join(', ')} UTC${outsideWhileAi.length > 5 ? ', ...' : ''}`,
    );
  }

  // Recording mode (0.3.4).
  const lastMode = activity.modes[activity.modes.length - 1];
  if (lastMode) {
    act(
      'info',
      lastMode === 'exam' ? 'MODE_EXAM' : 'MODE_PRACTICE',
      lastMode === 'exam'
        ? 'recorded in exam mode: AI features and code suggestions turned off, TAP settings locked'
        : 'recorded in practice mode: AI features and suggestions allowed (and recorded)',
    );
  }
  for (const m of activity.modeSwitches) {
    act(
      m.to === 'practice' ? 'warn' : 'info',
      'MODE_SWITCHED',
      `switched from ${m.from ?? 'no'} mode to ${m.to} mode at ${fmtClock(m.t)} UTC`,
      m.seq,
    );
  }

  // Files that are not recorded as text: images, PDFs... (0.3.4).
  const initial = activity.assets.filter((x) => x.initial && !x.skipped);
  if (initial.length > 0) {
    act(
      'info',
      'ASSETS_PRESENT',
      `${initial.length} file(s) that are not code were in the folder when recording started: ${initial
        .slice(0, 5)
        .map((x) => x.p)
        .join(', ')}${initial.length > 5 ? ', ...' : ''}`,
    );
  }
  for (const x of activity.assets) {
    if (x.skipped) {
      // A file in .tap/ or build output: its edits are not recorded and it is not in the code.
      act(
        'warn',
        'UNRECORDED_CODE_FILE',
        `"${x.p}" (${fmtBytes(x.n)}) is in a folder TAP does not record${x.p.startsWith('.tap/') ? " (TAP's own folder)" : ''}: how it was written is not in the log${x.added !== undefined ? ` (appeared ${fmtClock(x.added)} UTC${x.addedOffline ? ', while recording was off' : ''})` : ''}`,
        x.addedSeq,
      );
      continue;
    }
    const readable = x.k === 'image' || x.k === 'pdf' || x.k === 'document';
    const what = `${ASSET_TEXT[x.k]} "${x.p}" (${fmtBytes(x.n)})`;
    if (x.added !== undefined) {
      act(
        readable ? 'warn' : 'info',
        'ASSET_ADDED',
        x.addedOffline
          ? `${what} was added to the folder while recording was off (found at ${fmtClock(x.added)} UTC)`
          : `${what} was added to the folder at ${fmtClock(x.added)} UTC`,
        x.addedSeq,
      );
    }
    if (readable && x.visibleMs >= 60_000) {
      act('warn', 'ASSET_VIEWED', `${what} was shown in VS Code for ${fmtMin(x.visibleMs)}`);
    }
    if (x.deleted !== undefined && (readable || x.added !== undefined)) {
      act(
        readable ? 'warn' : 'info',
        'ASSET_REMOVED',
        `${what} was deleted from the folder at ${fmtClock(x.deleted)} UTC`,
      );
    }
  }

  // Away from the editor.
  const longAway = activity.away.filter((p) => p.to - p.from >= AWAY_MIN_MS);
  if (activity.awayMs >= AWAY_MIN_MS) {
    const longest = activity.away.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    act(
      'info',
      'AWAY_FROM_EDITOR',
      `away from the editor window ${activity.away.length} time(s), ${fmtMin(activity.awayMs)} in total; ${longAway.length} time(s) for a minute or more (longest ${fmtMin(longest.to - longest.from)} at ${fmtClock(longest.from)} UTC)`,
    );
  }

  // Extensions (0.3.5): AI or terminal extensions added during recording, terminals of their own,
  // panels of AI extensions, and what exam mode disabled.
  for (const e of activity.extensionsAdded) {
    const when = e.offline
      ? `while recording was off (found at ${fmtClock(e.t)} UTC)`
      : `at ${fmtClock(e.t)} UTC`;
    if (e.kind === 'ai') {
      act('warn', 'AI_EXTENSION_ADDED', `the AI extension ${e.id} was installed or enabled ${when}`, e.seq);
    } else if (e.kind === 'terminal') {
      act(
        'warn',
        'TERMINAL_EXTENSION_ADDED',
        `the terminal extension ${e.id} was installed or enabled ${when}: commands run in it are not recorded`,
        e.seq,
      );
    } else {
      act('info', 'EXTENSION_ADDED', `the extension ${e.id} was installed or enabled ${when}`, e.seq);
    }
  }
  const addedTerm = new Set(activity.extensionsAdded.filter((e) => e.kind === 'terminal').map((e) => e.id));
  const otherTerm = activity.terminalExtensions.filter((id) => !addedTerm.has(id));
  if (otherTerm.length > 0) {
    act(
      'warn',
      'TERMINAL_EXTENSION',
      `${otherTerm.join(', ')} ${otherTerm.length === 1 ? 'provides' : 'provide'} a terminal of ${otherTerm.length === 1 ? 'its' : 'their'} own: commands run there are not recorded`,
    );
  }
  for (const o of activity.aiPanels) {
    act(
      o.visibleMs >= 10_000 ? 'warn' : 'info',
      'AI_PANEL_SHOWN',
      `the AI panel "${o.name}" was shown for ${fmtMin(o.visibleMs)} (open ${fmtMin(o.openMs)})`,
    );
  }
  if (activity.blocked.length > 0) {
    act(
      'info',
      'EXTENSIONS_BLOCKED',
      `exam mode turned off ${activity.blocked.length} AI or terminal extension(s): ${activity.blocked.slice(0, 8).join(', ')}${activity.blocked.length > 8 ? ', ...' : ''}`,
    );
  }

  // Open outside the recorded folder.
  for (const o of activity.outside) {
    const risky = (o.k === 'web' || o.k === 'file' || o.k === 'notebook') && o.visibleMs >= 60_000;
    if (o.k === 'terminal') continue;
    act(
      risky ? 'warn' : 'info',
      'OPEN_OUTSIDE_FOLDER',
      `${KIND_TEXT[o.k]} "${o.name}" was open outside the recorded folder (shown ${fmtMin(o.visibleMs)}, open ${fmtMin(o.openMs)})`,
    );
  }

  // Terminals.
  for (const name of activity.unmonitoredTerminals) {
    act(
      'warn',
      'TERMINAL_NOT_MONITORED',
      `terminal "${name}" could not be monitored (no shell integration): its commands and output are not in the log`,
    );
  }
  if (activity.terminalOutside > 0) {
    act(
      'info',
      'TERMINAL_OUTSIDE_FOLDER',
      `${activity.terminalOutside} terminal command(s) ran outside the recorded folder`,
    );
  }
  for (const r of activity.terminalReuse) {
    act(
      'warn',
      'TERMINAL_CODE_REUSED',
      `${r.lines} of ${r.outputLines} code lines printed by the terminal command "${shorten(r.cmd, 120)}" at ${fmtClock(r.t)} UTC later appeared in ${r.files.join(', ')} (found by ${fmtClock(r.foundAt)} UTC)`,
      r.seq,
    );
  }

  // A log that tracks a whole home or Documents folder.
  if (report.finalFiles.length > BROAD_FOLDER_FILES) {
    act(
      'info',
      'BROAD_FOLDER',
      `the log tracks ${report.finalFiles.length} files: the recorded folder may be much broader than the assignment`,
    );
  }
}

const ASSET_TEXT: Record<string, string> = {
  image: 'image',
  pdf: 'PDF',
  document: 'document',
  archive: 'archive',
  media: 'audio/video file',
  other: 'file',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Compares the files shipped in attachments/ with the hashes the log recorded (0.3.4). */
function compareAttachments(
  activity: NonNullable<VerifyReport['activity']>,
  attachments: readonly (SubmittedFile | AttachmentRef)[],
  add: (f: Finding) => void,
): void {
  const shipped = new Map(attachments.map((a) => [toLogPath(a.path), a]));
  for (const x of activity.assets) {
    if (x.deleted !== undefined) continue;
    const file = shipped.get(x.p);
    if (!file) {
      add({
        stage: 'activity',
        severity: 'info',
        code: 'ATTACHMENT_NOT_SHIPPED',
        message: `${x.p} was in the folder but is not in the submission's attachments (too large, or removed)`,
      });
      continue;
    }
    shipped.delete(x.p);
    const hash =
      'sha256' in file
        ? file.sha256
        : sha256(typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content);
    if (x.h && !bytesEqual(hash, x.h)) {
      add({
        stage: 'activity',
        severity: 'warn',
        code: 'ATTACHMENT_MISMATCH',
        message: `attachments/${x.p} differs from the file the log recorded`,
      });
    }
  }
  for (const p of shipped.keys()) {
    add({
      stage: 'activity',
      severity: 'warn',
      code: 'ATTACHMENT_NOT_IN_LOG',
      message: `attachments/${p} is in the submission but the log never recorded it`,
    });
  }
}

const KIND_TEXT: Record<string, string> = {
  file: 'file',
  untitled: 'unsaved editor',
  web: 'web page',
  notebook: 'notebook',
  terminal: 'terminal',
  other: 'tab',
};

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function compareSubmission(
  replayer: Replayer,
  submission: readonly SubmittedFile[],
  add: (f: Finding) => void,
): string[] {
  const matched: string[] = [];
  const seen = new Set<string>();
  let mismatches = 0;
  for (const file of submission) {
    const path = toLogPath(file.path);
    seen.add(path);
    const logged = replayer.fileByPath(path);
    if (!logged) {
      add({
        stage: 'submission',
        severity: 'warn',
        code: 'UNTRACKED_SUBMITTED_FILE',
        message: `${path} is in the submission but not in the log`,
      });
      continue;
    }
    let text: string;
    if (typeof file.content === 'string') {
      text = file.content;
    } else {
      try {
        text = utf8Decoder.decode(file.content);
      } catch {
        mismatches++;
        add({
          stage: 'submission',
          severity: 'fail',
          code: 'SUBMISSION_NOT_UTF8',
          message: `${path} in the submission is not valid UTF-8 text`,
        });
        continue;
      }
    }
    if (!bytesEqual(contentHash(text), contentHash(logged.text))) {
      mismatches++;
      add({
        stage: 'submission',
        severity: 'fail',
        code: 'SUBMISSION_MISMATCH',
        message: `${path} differs from the final logged version`,
      });
      continue;
    }
    matched.push(path);
  }
  for (const file of replayer.liveFiles()) {
    if (!seen.has(file.path)) {
      add({
        stage: 'submission',
        severity: 'info',
        code: 'SUBMISSION_FILE_MISSING',
        message: `${file.path} is in the log but not in the submission`,
      });
    }
  }
  if (mismatches === 0 && matched.length > 0) {
    add({
      stage: 'submission',
      severity: 'pass',
      code: 'SUBMISSION_MATCH',
      message: `Submitted files match the final logged state (${matched.length} files)`,
    });
  }
  return matched;
}

const fmtTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Stage 4 (spec §9 step 4, design §9.7). */
function verifyAnchors(
  records: readonly AnyRecord[],
  hashes: readonly Uint8Array[],
  verifier: AnchorVerifier | undefined,
  add: (f: Finding) => void,
): AnchoringSummary {
  const checkpoints = records.filter((r) => r.k === Kind.CHECKPOINT);
  const summary: AnchoringSummary = {
    checkpoints: checkpoints.length,
    anchoredCheckpoints: 0,
    coverage: 0,
    anchors: [],
    existedBy: [],
  };
  /** Best independent time per checkpoint sequence number. */
  const best = new Map<number, number>();
  /** Earliest RFC 3161 time per checkpoint (Bitcoin confirmations are slow by nature). */
  const bestTsa = new Map<number, number>();
  /** Checkpoints with a pending OpenTimestamps proof, and those with a confirmed one. */
  const pendingCks = new Set<number>();
  const confirmedCks = new Set<number>();
  let refFailures = 0;
  let invalid = 0;
  for (const rec of records) {
    if (rec.k !== Kind.ANCHOR) continue;
    const target = records[rec.b.ck];
    if (rec.b.ck >= rec.s || !target || target.k !== Kind.CHECKPOINT) {
      refFailures++;
      add({
        stage: 'anchors',
        severity: 'fail',
        code: 'ANCHOR_REF_INVALID',
        message: `anchor refers to record ${rec.b.ck}, which is not an earlier checkpoint`,
        seq: rec.s,
      });
      continue;
    }
    if (!bytesEqual(rec.b.d, hashes[rec.b.ck]!)) {
      refFailures++;
      add({
        stage: 'anchors',
        severity: 'fail',
        code: 'ANCHOR_DIGEST_MISMATCH',
        message: `anchored digest does not match checkpoint ${rec.b.ck}: records before it were changed after it was timestamped`,
        seq: rec.s,
      });
      continue;
    }
    const info: AnchorInfo = {
      seq: rec.s,
      ck: rec.b.ck,
      t: rec.t,
      type: rec.b.type,
      src: rec.b.src,
      status: 'unverified',
    };
    summary.anchors.push(info);
    if (!verifier) continue;
    let check: AnchorCheck;
    try {
      check = verifier(rec.b);
    } catch (e) {
      check = { status: 'invalid', problem: 'TOKEN_MALFORMED', message: (e as Error).message };
    }
    info.status = check.status;
    if (check.time !== undefined) info.time = check.time;
    if (check.authority !== undefined) info.authority = check.authority;
    if (check.bitcoinHeight !== undefined) info.bitcoinHeight = check.bitcoinHeight;
    if (check.message !== undefined) info.message = check.message;
    if (check.status === 'invalid') {
      invalid++;
      add({
        stage: 'anchors',
        severity: 'fail',
        code: 'ANCHOR_TOKEN_INVALID',
        message: `timestamp from ${rec.b.src} for checkpoint ${rec.b.ck} is not valid: ${check.message ?? check.problem ?? 'invalid token'}`,
        seq: rec.s,
      });
    } else if (check.status === 'untrusted') {
      add({
        stage: 'anchors',
        severity: 'warn',
        code: 'ANCHOR_TSA_UNTRUSTED',
        message: `timestamp for checkpoint ${rec.b.ck}: ${check.message ?? 'TSA not trusted'}`,
        seq: rec.s,
      });
    } else if (check.status === 'pending') {
      pendingCks.add(rec.b.ck);
    } else if (check.status === 'confirmed') {
      confirmedCks.add(rec.b.ck);
    }
    if ((check.status === 'valid' || check.status === 'confirmed') && check.time !== undefined) {
      const prev = best.get(rec.b.ck);
      if (prev === undefined || check.time < prev) best.set(rec.b.ck, check.time);
      if (rec.b.type === 'rfc3161') {
        const prevTsa = bestTsa.get(rec.b.ck);
        if (prevTsa === undefined || check.time < prevTsa) bestTsa.set(rec.b.ck, check.time);
      }
    }
  }

  if (summary.anchors.length === 0 && refFailures === 0) {
    add({
      stage: 'anchors',
      severity: 'warn',
      code: 'NO_ANCHORS',
      message: 'no third-party timestamps: record times are self-asserted',
    });
    return summary;
  }
  if (!verifier) {
    if (refFailures === 0) {
      add({
        stage: 'anchors',
        severity: 'info',
        code: 'ANCHOR_TOKENS_NOT_VERIFIED',
        message: `${summary.anchors.length} anchor(s) reference their checkpoints correctly; timestamp tokens were not verified`,
      });
    }
    return summary;
  }

  // Time consistency (design §9.7). Each checkpoint's digest covers every record before it, so a
  // timestamp of a later checkpoint also bounds all earlier ones: a checkpoint existed by the
  // earliest time among its own anchors and those of the checkpoints after it. (A checkpoint
  // timestamped late, e.g. after working offline, is then bounded by a later, prompt timestamp.)
  const bound = new Map<number, { all?: number; tsa?: number }>();
  let laterAll: number | undefined;
  let laterTsa: number | undefined;
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const s = checkpoints[i]!.s;
    const own = best.get(s);
    const ownTsa = bestTsa.get(s);
    if (own !== undefined) laterAll = laterAll === undefined ? own : Math.min(laterAll, own);
    if (ownTsa !== undefined) laterTsa = laterTsa === undefined ? ownTsa : Math.min(laterTsa, ownTsa);
    const b: { all?: number; tsa?: number } = {};
    if (laterAll !== undefined) b.all = laterAll;
    if (laterTsa !== undefined) b.tsa = laterTsa;
    bound.set(s, b);
  }
  let late = 0;
  for (const ck of checkpoints) {
    if (!best.has(ck.s)) continue;
    const g = bound.get(ck.s)!.all!;
    summary.existedBy.push({ seq: ck.s, time: g });
    if (ck.t > g + ANCHOR_FUTURE_TOLERANCE_MS) {
      add({
        stage: 'anchors',
        severity: 'fail',
        code: 'CLOCK_INCONSISTENT',
        message: `checkpoint ${ck.s} claims ${fmtTime(ck.t)} UTC but was independently timestamped at ${fmtTime(g)} UTC: the computer clock was set ahead, or the time was made up`,
        seq: ck.s,
      });
    } else {
      const tsa = bound.get(ck.s)!.tsa;
      if (bestTsa.has(ck.s) && tsa !== undefined && tsa - ck.t > ANCHOR_LATE_MS) late++;
    }
  }
  summary.anchoredCheckpoints = summary.existedBy.length;

  // A clock set behind real time (B4): tokens are written right after the TSA answers, so the
  // token's time minus the ANCHOR record's own time is the computer clock's error.
  const offsets = summary.anchors
    .filter((a) => a.type === 'rfc3161' && a.status === 'valid' && a.time !== undefined)
    .map((a) => a.time! - a.t)
    .sort((x, y) => x - y);
  // Every token must show it (a single late one is an offline queue, not a clock): use the minimum.
  if (offsets.length >= 2 && offsets[0]! > CLOCK_BEHIND_MS) {
    add({
      stage: 'anchors',
      severity: 'warn',
      code: 'CLOCK_BEHIND',
      message: `the computer clock was at least ${Math.round(offsets[0]! / 60_000)} min behind real time: record times are earlier than they really were`,
    });
  }

  // Coverage: edit records that have an anchored checkpoint after them.
  const lastAnchored =
    summary.existedBy.length > 0 ? summary.existedBy[summary.existedBy.length - 1]!.seq : -1;
  let edits = 0;
  let covered = 0;
  for (const rec of records) {
    if (rec.k !== Kind.EDIT_BATCH) continue;
    edits++;
    if (rec.s < lastAnchored) covered++;
  }
  summary.coverage = edits === 0 ? (summary.anchoredCheckpoints > 0 ? 1 : 0) : covered / edits;
  const pct = `${Math.floor(summary.coverage * 100)}%`;

  if (late > 0) {
    add({
      stage: 'anchors',
      severity: 'info',
      code: 'ANCHORED_LATE',
      message: `${late} checkpoint(s) were timestamped more than 15 minutes after they were written (offline?)`,
    });
  }
  // A pending proof that was later upgraded in the same log is not outstanding.
  const pending = [...pendingCks].filter((ck) => !confirmedCks.has(ck)).length;
  if (pending > 0) {
    add({
      stage: 'anchors',
      severity: 'info',
      code: 'OTS_PENDING',
      message: `${pending} checkpoint(s) have OpenTimestamps proofs still waiting for a Bitcoin block`,
    });
  }
  if (summary.anchoredCheckpoints === 0) {
    if (invalid === 0) {
      add({
        stage: 'anchors',
        severity: 'warn',
        code: 'NO_VALID_ANCHORS',
        message: 'no checkpoint has a verified third-party timestamp: record times are self-asserted',
      });
    }
  } else if (invalid === 0) {
    add({
      stage: 'anchors',
      severity: 'pass',
      code: 'ANCHORS_OK',
      message: `${summary.anchoredCheckpoints} of ${summary.checkpoints} checkpoints independently timestamped; ${pct} of edits covered`,
    });
    if (summary.coverage < 0.95 && edits > 0) {
      add({
        stage: 'anchors',
        severity: 'info',
        code: 'ANCHOR_COVERAGE_PARTIAL',
        message: `${pct} of edits are covered by a third-party timestamp; the times of the rest rely on the computer clock`,
      });
    }
  }
  return summary;
}
