import * as fs from 'node:fs';

/** A lock is considered abandoned when its heartbeat is older than this. */
export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;

interface LockContent {
  pid: number;
  session: string;
  heartbeat: number;
}

export type LockResult = { acquired: true } | { acquired: false; heldBy: LockContent };

/**
 * Per-folder lock so only one VS Code window records a folder at a time (design §11.6).
 * A second window sees a fresh heartbeat and stays read-only.
 */
export class FolderLock {
  private owned = false;

  constructor(
    readonly lockPath: string,
    readonly session: string,
    private readonly now: () => number = Date.now,
  ) {}

  get isOwned(): boolean {
    return this.owned;
  }

  acquire(): LockResult {
    const content = (): LockContent => ({ pid: process.pid, session: this.session, heartbeat: this.now() });
    try {
      fs.writeFileSync(this.lockPath, JSON.stringify(content()), { flag: 'wx' });
      this.owned = true;
      return { acquired: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const existing = this.read();
    if (existing && existing.session !== this.session && this.now() - existing.heartbeat < LOCK_STALE_MS) {
      return { acquired: false, heldBy: existing };
    }
    // Stale, unreadable or our own: take it over.
    fs.writeFileSync(this.lockPath, JSON.stringify(content()));
    this.owned = true;
    return { acquired: true };
  }

  /** Refreshes the heartbeat. Returns false if another window has taken the lock over. */
  heartbeat(): boolean {
    if (!this.owned) return false;
    const existing = this.read();
    if (existing && existing.session !== this.session) {
      this.owned = false;
      return false;
    }
    fs.writeFileSync(
      this.lockPath,
      JSON.stringify({ pid: process.pid, session: this.session, heartbeat: this.now() }),
    );
    return true;
  }

  release(): void {
    if (!this.owned) return;
    this.owned = false;
    const existing = this.read();
    if (existing && existing.session !== this.session) return;
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }

  private read(): LockContent | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as Partial<LockContent>;
      if (typeof parsed.session !== 'string' || typeof parsed.heartbeat !== 'number') return undefined;
      return { pid: Number(parsed.pid) || 0, session: parsed.session, heartbeat: parsed.heartbeat };
    } catch {
      return undefined;
    }
  }
}
