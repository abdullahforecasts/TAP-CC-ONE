import { bytesEqual, toHex } from './bytes.js';
import { Flag, Kind } from './constants.js';
import { checkpointMessage, keyFingerprint, verifySignature } from './crypto.js';
import { TapError } from './errors.js';
import { genesisHash, recordHash } from './hash.js';
import { toLogPath } from './paths.js';
import type { Composition } from './provenance.js';
import { type ParsedLog, readLog } from './reader.js';
import { Replayer, type Severity } from './replay.js';
import { contentHash } from './text.js';

export type Stage = 'parse' | 'chain' | 'signatures' | 'anchors' | 'replay' | 'submission';

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

export interface VerifyOptions {
  /** The submitted code to compare with the final logged state (stage 6). */
  submission?: readonly SubmittedFile[];
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
}

const MAX_CLOCK_FINDINGS = 10;
const CLOCK_TOLERANCE_MS = 2000;

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
 * Verifies a log (design §13.2, stages 1–6 except third-party timestamp tokens, which arrive with
 * the anchoring part). Never throws for bad input: every problem becomes a finding.
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

  // ---- Stage 4: anchors (internal consistency) ------------------------------------------------
  for (const rec of records) {
    if (rec.k !== Kind.ANCHOR) continue;
    report.stats.anchors++;
    const target = records[rec.b.ck];
    if (rec.b.ck >= rec.s || !target || target.k !== Kind.CHECKPOINT) {
      add({
        stage: 'anchors',
        severity: 'fail',
        code: 'ANCHOR_REF_INVALID',
        message: `anchor refers to record ${rec.b.ck}, which is not an earlier checkpoint`,
        seq: rec.s,
      });
    } else if (!bytesEqual(rec.b.d, hashes[rec.b.ck]!)) {
      add({
        stage: 'anchors',
        severity: 'fail',
        code: 'ANCHOR_DIGEST_MISMATCH',
        message: `anchored digest does not match checkpoint ${rec.b.ck}: records before it were changed after it was timestamped`,
        seq: rec.s,
      });
    }
  }
  if (report.stats.anchors === 0) {
    add({
      stage: 'anchors',
      severity: 'warn',
      code: 'NO_ANCHORS',
      message: 'no third-party timestamps: record times are self-asserted',
    });
  } else if (!findings.some((f) => f.stage === 'anchors' && f.severity === 'fail')) {
    add({
      stage: 'anchors',
      severity: 'info',
      code: 'ANCHOR_TOKENS_NOT_VERIFIED',
      message: `${report.stats.anchors} anchor(s) reference their checkpoints correctly; timestamp tokens are not verified by this version`,
    });
  }

  // ---- Stage 5: replay ------------------------------------------------------------------------
  const replayer = new Replayer({ provenance: true });
  let replayFailed = false;
  let inSession = false;
  let sessionSid: Uint8Array | null = null;
  let prevT: number | null = null;
  let prevM: number | null = null;
  let clockFindings = 0;
  const stats = report.stats;
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
        break;
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
      add({
        stage: 'replay',
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        seq: issue.seq,
      });
      if (issue.severity === 'fail') replayFailed = true;
    }
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

  report.verdict = verdictOf(findings);
  return report;
}

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
