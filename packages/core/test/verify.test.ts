import { describe, expect, it } from 'vitest';
import { contentHash, type Finding, stateDigest, utf8, verifyLog } from '../src/index.js';
import { RawLog, SID, sessionStart, testKey, ZERO32 } from './support/raw.js';

const key = testKey();

function nonPass(findings: Finding[]): string[] {
  return findings.filter((f) => f.severity !== 'pass').map((f) => `${f.severity}:${f.code}`);
}

function snap(f: number, path: string, text: string) {
  return { f, path, origin: 'preexisting', text, h: contentHash(text), eol: 'lf', enc: 'utf8' };
}

/** A log with one file "a.txt" = text and a valid checkpoint. */
function baseLog(text = 'abc'): RawLog {
  const log = new RawLog();
  log.push('SESSION_START', sessionStart(key.publicKey));
  log.push('FILE_SNAPSHOT', snap(0, 'a.txt', text));
  log.checkpoint(key, stateDigest([{ f: 0, path: 'a.txt', text }]), 1);
  return log;
}

describe('verifyLog', () => {
  it('reports structure failures as parse findings with offsets', () => {
    const report = verifyLog(new Uint8Array([1, 2, 3]));
    expect(report.verdict).toBe('NOT_INTACT');
    expect(report.findings[0]).toMatchObject({ stage: 'parse', code: 'BAD_MAGIC', offset: 0 });
    const bytes = baseLog().bytes(1).slice();
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0xff;
    const r2 = verifyLog(bytes);
    expect(r2.findings[0]).toMatchObject({ code: 'BAD_CRC' });
    expect(r2.findings[0]!.offset).toBeGreaterThan(0);
  });

  it('accepts a clean log and summarises it', () => {
    const log = baseLog();
    log.push('NOTE', { text: 'hello' });
    log.push('SESSION_END', { sid: SID, reason: 'close' });
    const report = verifyLog(log.bytes());
    expect(nonPass(report.findings)).toEqual(['warn:NO_ANCHORS']);
    expect(report.verdict).toBe('INTACT_WITH_WARNINGS');
    expect(report.keys).toHaveLength(1);
    expect(report.notes).toEqual([expect.objectContaining({ text: 'hello', seq: 3 })]);
    expect(report.finalFiles).toEqual([expect.objectContaining({ path: 'a.txt', length: 3 })]);
    expect(report.stats).toMatchObject({ sessions: 1, checkpoints: 1 });
    expect(report.header?.logId).toHaveLength(32);
    expect(report.findings.filter((f) => f.severity === 'pass').map((f) => f.code)).toEqual([
      'PARSE_OK',
      'CHAIN_OK',
      'SIGNATURES_OK',
      'REPLAY_OK',
    ]);
  });

  it('detects sequence gaps and broken links', () => {
    const gap = new RawLog();
    gap.push('SESSION_START', sessionStart(key.publicKey));
    gap.push('FOCUS', { on: true }, { s: 5 });
    expect(nonPass(verifyLog(gap.bytes()).findings)).toEqual(['fail:SEQ_GAP']);

    const link = new RawLog();
    link.push('SESSION_START', sessionStart(key.publicKey));
    link.push('FOCUS', { on: true }, { p: ZERO32 });
    const r = verifyLog(link.bytes());
    expect(nonPass(r.findings)).toEqual(['fail:CHAIN_BROKEN']);
    expect(r.findings.find((f) => f.code === 'CHAIN_BROKEN')?.seq).toBe(1);
  });

  it('requires the log to start with SESSION_START', () => {
    const log = new RawLog();
    log.push('FOCUS', { on: true });
    expect(nonPass(verifyLog(log.bytes()).findings)).toEqual(['fail:FIRST_RECORD_NOT_SESSION_START']);
  });

  it('checks checkpoint signatures and key continuity', () => {
    const bad = new RawLog();
    bad.push('SESSION_START', sessionStart(key.publicKey));
    bad.checkpoint(key, stateDigest([]), 0, { badSig: true });
    expect(nonPass(verifyLog(bad.bytes()).findings)).toContain('fail:BAD_SIGNATURE');

    const other = testKey('other');
    const changed = baseLog();
    changed.push('SESSION_END', { sid: SID, reason: 'close' });
    changed.push('SESSION_START', sessionStart(other.publicKey));
    changed.checkpoint(other, stateDigest([{ f: 0, path: 'a.txt', text: 'abc' }]), 1);
    const r = verifyLog(changed.bytes());
    expect(nonPass(r.findings)).toEqual(['warn:KEY_CHANGED', 'warn:NO_ANCHORS']);
    expect(r.keys).toHaveLength(2);

    const wrongKey = new RawLog();
    wrongKey.push('SESSION_START', sessionStart(key.publicKey));
    wrongKey.checkpoint(other, stateDigest([]), 0);
    expect(nonPass(verifyLog(wrongKey.bytes()).findings)).toContain('fail:BAD_SIGNATURE');
  });

  it('flags missing checkpoints and edits after the last checkpoint', () => {
    const log = baseLog();
    log.push('EDIT_BATCH', { f: 0, c: [[1, 0, 0, 'x']] });
    expect(nonPass(verifyLog(log.bytes()).findings)).toEqual(['info:UNCHECKPOINTED_TAIL', 'warn:NO_ANCHORS']);
  });

  it('checks that anchors point at earlier checkpoints with the right digest', () => {
    const log = baseLog();
    const ck = 2;
    const anchor = (ckSeq: number, d: Uint8Array) => ({
      ck: ckSeq,
      d,
      type: 'ots',
      src: 'x',
      tok: new Uint8Array([1]),
      status: 'pending',
    });
    log.push('ANCHOR', anchor(ck, log.hashes[ck]!));
    expect(nonPass(verifyLog(log.bytes()).findings)).toEqual(['info:ANCHOR_TOKENS_NOT_VERIFIED']);
    expect(verifyLog(log.bytes()).verdict).toBe('INTACT');

    const wrongRef = baseLog();
    wrongRef.push('ANCHOR', anchor(1, wrongRef.hashes[1]!));
    expect(nonPass(verifyLog(wrongRef.bytes()).findings)).toEqual(['fail:ANCHOR_REF_INVALID']);
    const future = baseLog();
    future.push('ANCHOR', anchor(9, ZERO32));
    expect(nonPass(verifyLog(future.bytes()).findings)).toEqual(['fail:ANCHOR_REF_INVALID']);
    const wrongDigest = baseLog();
    wrongDigest.push('ANCHOR', anchor(ck, ZERO32));
    expect(nonPass(verifyLog(wrongDigest.bytes()).findings)).toEqual(['fail:ANCHOR_DIGEST_MISMATCH']);
  });

  it('checks checkpoint state against the replay', () => {
    const log = new RawLog();
    log.push('SESSION_START', sessionStart(key.publicKey));
    log.push('FILE_SNAPSHOT', snap(0, 'a.txt', 'abc'));
    log.checkpoint(key, stateDigest([{ f: 0, path: 'a.txt', text: 'abd' }]), 1);
    expect(nonPass(verifyLog(log.bytes()).findings)).toEqual([
      'warn:NO_ANCHORS',
      'fail:CHECKPOINT_STATE_MISMATCH',
    ]);
    const count = new RawLog();
    count.push('SESSION_START', sessionStart(key.publicKey));
    count.checkpoint(key, stateDigest([]), 3);
    expect(nonPass(verifyLog(count.bytes()).findings)).toContain('fail:CHECKPOINT_STATE_MISMATCH');
  });

  it('stops replay at the first failure', () => {
    const log = baseLog();
    log.push('SAVE', { f: 0, h: ZERO32, n: 3 });
    log.push('SAVE', { f: 0, h: ZERO32, n: 3 });
    const r = verifyLog(log.bytes());
    expect(nonPass(r.findings)).toEqual(['warn:NO_ANCHORS', 'fail:SAVE_HASH_MISMATCH']);
    expect(r.finalFiles).toEqual([]);
    expect(r.composition).toBeUndefined();
  });

  it('checks session structure and clocks', () => {
    const log = baseLog();
    log.push('SESSION_END', { sid: ZERO32.slice(0, 16), reason: 'close' });
    log.push('FOCUS', { on: true });
    log.push('SESSION_START', sessionStart(key.publicKey));
    log.t -= 10_000;
    log.push('FOCUS', { on: false });
    log.m -= 15;
    log.push('FOCUS', { on: true });
    log.push('CLOCK_ANOMALY', { wallDelta: -10_000, monoDelta: 10 });
    log.push('SESSION_START', sessionStart(key.publicKey));
    log.push('PAUSE', {});
    log.push('RESUME', {});
    log.push('RUN_START', { rid: 1, kind: 'task' });
    log.push('RUN_END', { rid: 1, exit: 0 });
    log.push('EXTERNAL_CHANGE', { f: 0, h: ZERO32 });
    const r = verifyLog(log.bytes());
    expect(nonPass(r.findings)).toEqual([
      'warn:NO_ANCHORS',
      'warn:SESSION_ID_MISMATCH',
      'warn:RECORD_OUTSIDE_SESSION',
      'warn:CLOCK_BACKWARDS',
      'warn:MONO_BACKWARDS',
      'warn:CLOCK_ANOMALY',
      'info:SESSION_NOT_CLOSED',
      'info:PAUSED',
      'warn:EXTERNAL_WITHOUT_SNAPSHOT',
    ]);
    expect(r.stats).toMatchObject({ sessions: 3, runs: 1, pauses: 1 });
  });

  it('limits clock findings and treats RECOVERY as closing a session', () => {
    const log = baseLog();
    for (let i = 0; i < 15; i++) {
      log.t -= 5_000;
      log.push('FOCUS', { on: true });
    }
    log.push('RECOVERY', { lostBytes: 1, quarantineHash: ZERO32, atOffset: 1 });
    log.push('KEY_ROTATION', { newPub: testKey('new').publicKey, why: 'lost' });
    log.push('SESSION_START', sessionStart(testKey('new').publicKey));
    const r = verifyLog(log.bytes());
    expect(r.findings.filter((f) => f.code === 'CLOCK_BACKWARDS')).toHaveLength(10);
    expect(nonPass(r.findings)).toContain('info:SESSION_NOT_CLOSED');
    expect(nonPass(r.findings)).toContain('warn:RECOVERED');
    expect(nonPass(r.findings)).toContain('warn:KEY_ROTATED');
    expect(nonPass(r.findings)).not.toContain('warn:KEY_CHANGED');
    expect(nonPass(r.findings)).not.toContain('warn:RECORD_OUTSIDE_SESSION');
  });

  it('fails a log whose first record is a checkpoint', () => {
    const early = new RawLog();
    early.checkpoint(key, stateDigest([]), 0);
    expect(nonPass(verifyLog(early.bytes()).findings)).toEqual(['fail:FIRST_RECORD_NOT_SESSION_START']);
  });

  describe('submission matching', () => {
    it('matches LF/CRLF/BOM variants and Windows paths', () => {
      const log = new RawLog();
      log.push('SESSION_START', sessionStart(key.publicKey));
      log.push('FILE_SNAPSHOT', snap(0, 'src/a.c', 'x\r\ny\r\n'));
      const r = verifyLog(log.bytes(), {
        submission: [{ path: 'src\\a.c', content: utf8('﻿x\ny\n') }],
      });
      expect(r.findings.find((f) => f.code === 'SUBMISSION_MATCH')).toBeDefined();
      expect(r.composition?.chars).toBe(6);
      const asString = verifyLog(log.bytes(), { submission: [{ path: './src/a.c', content: 'x\ny\n' }] });
      expect(asString.findings.find((f) => f.code === 'SUBMISSION_MATCH')).toBeDefined();
    });

    it('reports mismatches, untracked, missing and non-UTF-8 files', () => {
      const log = new RawLog();
      log.push('SESSION_START', sessionStart(key.publicKey));
      log.push('FILE_SNAPSHOT', snap(0, 'a.c', 'a'));
      log.push('FILE_SNAPSHOT', snap(1, 'b.c', 'b'));
      log.push('FILE_SNAPSHOT', snap(2, 'c.c', 'c'));
      const r = verifyLog(log.bytes(), {
        submission: [
          { path: 'a.c', content: 'A' },
          { path: 'b.c', content: new Uint8Array([0xff, 0xfe]) },
          { path: 'extra.c', content: 'x' },
        ],
      });
      expect(nonPass(r.findings)).toEqual([
        'warn:NO_CHECKPOINTS',
        'warn:NO_ANCHORS',
        'fail:SUBMISSION_MISMATCH',
        'fail:SUBMISSION_NOT_UTF8',
        'warn:UNTRACKED_SUBMITTED_FILE',
        'info:SUBMISSION_FILE_MISSING',
      ]);
      expect(r.verdict).toBe('NOT_INTACT');
      expect(r.composition?.chars).toBe(0);
    });
  });
});
