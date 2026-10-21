/**
 * Timestamp anchoring for every recorded log (design §9.4–9.6): a persistent queue of requests to
 * RFC 3161 TSAs and OpenTimestamps calendars, retried with backoff while offline, and delivered
 * as ANCHOR records to the log once it is open for recording.
 *
 * Only the 32-byte checkpoint digest (and, for OpenTimestamps upgrades, values derived from it)
 * leaves the machine. The queue is stored in the extension's global storage, so it survives
 * restarts and works across folders.
 */
import {
  type HttpClient,
  parseOts,
  parseToken,
  requestRfc3161,
  submitOts,
  summarizeOts,
  upgradeOts,
} from '@tap/anchor';
import { type AnchorBody, fromHex, toHex } from '@tap/core';

export const DEFAULT_TSAS = [
  'https://freetsa.org/tsr',
  'http://timestamp.digicert.com',
  'http://timestamp.sectigo.com',
];
export const DEFAULT_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];

export interface AnchorConfig {
  enabled: boolean;
  tsas: string[];
  calendars: string[];
}

type JobType = 'rfc3161' | 'ots' | 'ots-upgrade';

interface Job {
  id: string;
  logId: string;
  ck: number;
  d: string;
  type: JobType;
  src: string;
  /** Pending OpenTimestamps proof (ots-upgrade), base64. */
  tok?: string;
  /** Network part done: the ANCHOR body waits for its log to be open. */
  ready?: { tok: string; status: AnchorBody['status'] };
  attempts: number;
  nextAt: number;
  createdAt: number;
  lastError?: string;
  /** TSAs whose tokens would not verify for this job (rfc3161). */
  unusable?: string[];
}

interface QueueFile {
  version: 1;
  tsaTurn: number;
  calendarTurn: number;
  jobs: Job[];
}

/** Where ANCHOR records go: the recorder of an open log. */
export interface AnchorSink {
  /** Appends the record; false when the log cannot take it right now (paused writes are fine). */
  appendAnchor(body: AnchorBody): Promise<boolean>;
}

export interface AnchorServiceDeps {
  http: HttpClient;
  now(): number;
  random(n: number): Uint8Array;
  load(): string | undefined;
  save(json: string): void;
  log(message: string): void;
  config(): AnchorConfig;
  /**
   * Checks a new RFC 3161 token the way a reader's verifier will. A token that would not verify
   * (for example a TSA whose root is not bundled) is dropped and another TSA is tried, so the log
   * never collects timestamps that only produce warnings.
   */
  checkToken?(token: Uint8Array, digest: Uint8Array): { status: string; message?: string };
}

const BASE_DELAY = 30_000;
const MAX_DELAY = 30 * 60_000;
const GIVE_UP_AFTER = 14 * 24 * 3_600_000;
const FIRST_UPGRADE_AFTER = 2 * 3_600_000;
const UPGRADE_EVERY = 6 * 3_600_000;
const TICK_MS = 15_000;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export class AnchorService {
  private q: QueueFile;
  private readonly sinks = new Map<string, AnchorSink>();
  private current: Promise<void> | undefined;
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  /** Called when the number of outstanding timestamps changes (status bar). */
  onChange: (() => void) | undefined;

  constructor(private readonly deps: AnchorServiceDeps) {
    this.q = this.read();
  }

  private read(): QueueFile {
    try {
      const raw = this.deps.load();
      if (raw) {
        const parsed = JSON.parse(raw) as QueueFile;
        if (parsed.version === 1 && Array.isArray(parsed.jobs)) return parsed;
      }
    } catch (e) {
      this.deps.log(`anchor queue unreadable, starting a new one: ${String(e)}`);
    }
    return { version: 1, tsaTurn: 0, calendarTurn: 0, jobs: [] };
  }

  private persist(): void {
    try {
      this.deps.save(JSON.stringify(this.q));
    } catch (e) {
      this.deps.log(`could not save the anchor queue: ${String(e)}`);
    }
    this.onChange?.();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.process(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Replaces the HTTP client (tests). */
  setHttp(http: HttpClient): void {
    this.deps.http = http;
  }

  /** Replaces the check of new tokens (tests with a test TSA). */
  setTokenCheck(check: AnchorServiceDeps['checkToken']): void {
    if (check) this.deps.checkToken = check;
    else delete this.deps.checkToken;
  }

  register(logId: string, sink: AnchorSink): void {
    this.sinks.set(logId, sink);
    void this.process();
  }

  unregister(logId: string, sink: AnchorSink): void {
    if (this.sinks.get(logId) === sink) this.sinks.delete(logId);
  }

  /** Timestamps still to be obtained or written (OpenTimestamps upgrades are not counted). */
  outstanding(logId?: string): number {
    return this.q.jobs.filter((j) => j.type !== 'ots-upgrade' && (!logId || j.logId === logId)).length;
  }

  /** Whether this checkpoint already has (or is getting) a timestamp. */
  has(logId: string, ck: number): boolean {
    return this.q.jobs.some((j) => j.logId === logId && j.ck === ck);
  }

  /** Queues one anchoring round for a checkpoint: two TSAs (rotating) and one calendar. */
  anchor(logId: string, ck: number, digest: Uint8Array): void {
    const cfg = this.deps.config();
    if (!cfg.enabled) return;
    const d = toHex(digest);
    const now = this.deps.now();
    const add = (type: JobType, src: string) => {
      if (this.q.jobs.some((j) => j.logId === logId && j.ck === ck && j.type === type && j.src === src))
        return;
      this.q.jobs.push({
        id: `${now}-${this.seq++}`,
        logId,
        ck,
        d,
        type,
        src,
        attempts: 0,
        nextAt: now,
        createdAt: now,
      });
    };
    const tsas = cfg.tsas.filter(Boolean);
    for (let i = 0; i < Math.min(2, tsas.length); i++) {
      add('rfc3161', tsas[(this.q.tsaTurn + i) % tsas.length]!);
    }
    if (tsas.length > 0) this.q.tsaTurn = (this.q.tsaTurn + 1) % tsas.length;
    const cals = cfg.calendars.filter(Boolean);
    if (cals.length > 0) {
      add('ots', cals[this.q.calendarTurn % cals.length]!);
      this.q.calendarTurn = (this.q.calendarTurn + 1) % cals.length;
    }
    this.persist();
    void this.process();
  }

  /** Asks for OpenTimestamps upgrades of a log now (session start, export). */
  upgradeNow(logId: string): void {
    const now = this.deps.now();
    for (const j of this.q.jobs)
      if (j.logId === logId && j.type === 'ots-upgrade') j.nextAt = Math.min(j.nextAt, now);
    void this.process();
  }

  /**
   * Waits until the given checkpoint's TSA timestamps are written to the log, or `ms` passes.
   * Returns how many TSA timestamps were written.
   */
  async waitFor(logId: string, ck: number, ms: number): Promise<number> {
    // A real-time limit: this is how long a person waits.
    const deadline = Date.now() + ms;
    const left = () =>
      this.q.jobs.filter((j) => j.logId === logId && j.ck === ck && j.type === 'rfc3161').length;
    const initial = left();
    while (left() > 0 && Date.now() < deadline) {
      // Requests in backoff are retried right away while someone waits, at most once a second.
      const now = this.deps.now();
      for (const j of this.q.jobs)
        if (j.logId === logId && j.ck === ck && !j.ready) j.nextAt = Math.min(j.nextAt, now);
      await this.process();
      if (left() === 0) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(10, Math.min(1000, deadline - Date.now()))),
      );
    }
    return initial - left();
  }

  /**
   * Runs every job that is due. Safe to call often: calls during a run join it, and the run
   * repeats once so that jobs added meanwhile are seen.
   */
  process(): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.again = false;
          await this.runDue();
        } while (this.again);
      } finally {
        this.current = undefined;
      }
    })();
    return this.current;
  }

  private async runDue(): Promise<void> {
    const now = this.deps.now();
    for (const job of [...this.q.jobs]) {
      if (!this.q.jobs.includes(job)) continue;
      if (now - job.createdAt > GIVE_UP_AFTER) {
        this.deps.log(`giving up on a ${job.type} timestamp for checkpoint ${job.ck} after 14 days`);
        this.remove(job);
        continue;
      }
      if (job.ready) {
        await this.deliver(job);
        continue;
      }
      if (job.nextAt > now) continue;
      if (job.type === 'ots-upgrade' && !this.sinks.has(job.logId)) continue;
      await this.run(job);
    }
  }

  private remove(job: Job): void {
    this.q.jobs = this.q.jobs.filter((j) => j !== job);
    this.persist();
  }

  private async run(job: Job): Promise<void> {
    const digest = fromHex(job.d);
    try {
      if (job.type === 'rfc3161') {
        const tok = await requestRfc3161(this.deps.http, job.src, digest, this.deps.random(8));
        const check = this.deps.checkToken?.(tok, digest);
        if (check && check.status !== 'valid') {
          this.unusable(job, check.message ?? check.status);
          return;
        }
        job.ready = { tok: b64(tok), status: 'complete' };
        this.deps.log(
          `timestamp for checkpoint ${job.ck} from ${job.src}: ${new Date(parseToken(tok).tstInfo.genTime).toISOString()}`,
        );
      } else if (job.type === 'ots') {
        const tok = await submitOts(this.deps.http, job.src, digest);
        job.ready = { tok: b64(tok), status: 'pending' };
        this.deps.log(`OpenTimestamps proof for checkpoint ${job.ck} pending at ${job.src}`);
      } else {
        const cfg = this.deps.config();
        const up = await upgradeOts(this.deps.http, unb64(job.tok!), digest, cfg.calendars);
        if (up.changed && up.complete) {
          job.ready = { tok: b64(up.token), status: 'upgraded' };
          const height = summarizeOts(parseOts(up.token, digest)).bitcoin[0]?.height;
          this.deps.log(`OpenTimestamps proof for checkpoint ${job.ck} reached Bitcoin block ${height}`);
        } else {
          job.attempts++;
          job.nextAt = this.deps.now() + UPGRADE_EVERY;
          this.persist();
          return;
        }
      }
      delete job.lastError;
      this.persist();
      await this.deliver(job);
    } catch (e) {
      job.attempts++;
      job.lastError = e instanceof Error ? e.message : String(e);
      const backoff = Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.min(job.attempts - 1, 10));
      const jitter = 0.8 + 0.4 * (this.deps.random(1)[0]! / 255);
      job.nextAt = this.deps.now() + Math.round(backoff * jitter);
      if (job.type === 'rfc3161') {
        // Try another TSA next time, avoiding the one the sibling request uses.
        const tsas = this.deps.config().tsas.filter(Boolean);
        const taken = new Set(
          this.q.jobs.filter((j) => j !== job && j.logId === job.logId && j.ck === job.ck).map((j) => j.src),
        );
        const next = tsas.filter((t) => t !== job.src && !taken.has(t))[0];
        if (next) job.src = next;
      } else if (job.type === 'ots') {
        // Try the next calendar (a pending proof can only be upgraded at its own calendar, so
        // upgrades stay where they are).
        const cals = this.deps.config().calendars.filter(Boolean);
        const i = cals.indexOf(job.src);
        if (cals.length > 1) job.src = cals[(i + 1) % cals.length]!;
      }
      this.deps.log(
        `timestamp request failed (${job.type}, checkpoint ${job.ck}): ${job.lastError}; retrying later`,
      );
      this.persist();
    }
  }

  /**
   * A TSA answered with a token that would not verify (not a network problem, so retrying the
   * same TSA does not help): use a TSA not tried yet, or give up on this one request.
   */
  private unusable(job: Job, why: string): void {
    this.deps.log(`the timestamp from ${job.src} would not verify (${why}); not using it`);
    job.unusable = [...(job.unusable ?? []), job.src];
    const taken = new Set(
      this.q.jobs.filter((j) => j !== job && j.logId === job.logId && j.ck === job.ck).map((j) => j.src),
    );
    const next = this.deps
      .config()
      .tsas.filter(Boolean)
      .find((t) => !job.unusable!.includes(t) && !taken.has(t));
    if (!next) {
      this.remove(job);
      return;
    }
    job.src = next;
    job.nextAt = this.deps.now();
    this.again = true; // ask the next TSA in this same run
    this.persist();
  }

  private async deliver(job: Job): Promise<void> {
    const sink = this.sinks.get(job.logId);
    if (!sink || !job.ready) return;
    const body: AnchorBody = {
      ck: job.ck,
      d: fromHex(job.d),
      type: job.type === 'rfc3161' ? 'rfc3161' : 'ots',
      src: job.src,
      tok: unb64(job.ready.tok),
      status: job.ready.status,
    };
    let ok = false;
    try {
      ok = await sink.appendAnchor(body);
    } catch (e) {
      this.deps.log(`could not write a timestamp to the log: ${String(e)}`);
    }
    if (!ok) return;
    if (job.type === 'ots' && job.ready.status === 'pending') {
      // Keep the pending proof to upgrade later.
      job.type = 'ots-upgrade';
      job.tok = job.ready.tok;
      delete job.ready;
      job.attempts = 0;
      job.nextAt = this.deps.now() + FIRST_UPGRADE_AFTER;
      this.persist();
      return;
    }
    this.remove(job);
  }
}
