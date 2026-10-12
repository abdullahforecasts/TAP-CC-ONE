import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPair, Kind, readLog, toHex, verifyLog } from '@tap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Recorder } from '../src/recorder/recorder.js';
import { readTrackedFile } from '../src/storage/diskReader.js';
import { createConfig, createMatcher, hasConfig, loadConfig } from '../src/storage/folderConfig.js';
import { loadOrCreateKey, SECRET_KEY_NAME } from '../src/storage/keystore.js';
import { FolderLock, LOCK_STALE_MS } from '../src/storage/lock.js';
import { LogStore, logPathOf, openLog } from '../src/storage/logStore.js';
import { FAST, SimHost, testKey } from './support/sim.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ext-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  vsc: '1.105.0',
  app: 'vscode',
  os: 'linux',
  ext: '0.1.0',
  aiExt: [],
  liveShare: false,
  cfgHash: new Uint8Array(32),
  settings: {},
};

async function recordSession(
  tapDir: string,
  mirrorDir: string,
  act: (r: Recorder, host: SimHost) => void,
  stop = true,
) {
  const opened = openLog({ tapDir, mirrorDir, label: 'test', tool: 'ext-test', now: Date.now() });
  const host = new SimHost();
  host.disk.set('a.c', 'int a;\n');
  const options: ConstructorParameters<typeof Recorder>[0] = {
    writer: opened.writer,
    sink: opened.store,
    host,
    key: testKey(),
    env: ENV,
    settings: FAST,
    diskHashes: opened.info.diskHashes,
  };
  if (opened.info.lastPub) options.lastPub = opened.info.lastPub;
  if (opened.recovery) options.recovery = opened.recovery;
  const recorder = new Recorder(options);
  await recorder.start();
  act(recorder, host);
  await new Promise((r) => setTimeout(r, 30));
  await recorder.flush();
  if (stop) await recorder.stop();
  opened.store.close();
  return { opened, recorder, host };
}

describe('openLog and LogStore', () => {
  it('creates a new log, appends sessions and mirrors them', async () => {
    const tapDir = path.join(dir, '.tap');
    const mirrorDir = path.join(dir, 'mirror');
    const first = await recordSession(tapDir, mirrorDir, (r) => {
      r.onDocumentChanged(
        'a.c',
        [{ rangeOffset: 7, rangeLength: 0, text: 'x' }],
        undefined,
        true,
        () => 'int a;\nx',
      );
    });
    expect(first.opened.isNew).toBe(true);
    const logPath = logPathOf(tapDir);
    const mirrorPath = path.join(mirrorDir, `${toHex(first.opened.writer.header.logId)}.codelog`);
    expect(fs.readFileSync(mirrorPath)).toEqual(fs.readFileSync(logPath));

    const second = await recordSession(tapDir, mirrorDir, () => {});
    expect(second.opened.isNew).toBe(false);
    const bytes = new Uint8Array(fs.readFileSync(logPath));
    const report = verifyLog(bytes);
    expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(report.stats.sessions).toBe(2);
    expect(fs.readFileSync(mirrorPath)).toEqual(fs.readFileSync(logPath));
  });

  it('quarantines a damaged tail and records RECOVERY', async () => {
    const tapDir = path.join(dir, '.tap');
    await recordSession(tapDir, path.join(dir, 'm'), () => {}, false);
    const logPath = logPathOf(tapDir);
    fs.appendFileSync(logPath, Buffer.from([0, 0, 0, 50, 1, 0, 0, 0, 60, 1, 2, 3]));
    const second = await recordSession(tapDir, path.join(dir, 'm'), () => {});
    expect(second.opened.recovery?.lostBytes).toBe(12);
    expect(fs.existsSync(second.opened.quarantinedTo!)).toBe(true);
    const report = verifyLog(new Uint8Array(fs.readFileSync(logPath)));
    expect(report.findings.map((f) => f.code)).toContain('RECOVERED');
    expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
  });

  it('refuses to continue a log with a damaged header or a broken chain', async () => {
    const tapA = path.join(dir, 'a', '.tap');
    const tapB = path.join(dir, 'b', '.tap');
    await recordSession(tapA, path.join(dir, 'm'), () => {});
    await recordSession(tapB, path.join(dir, 'm'), () => {});
    const a = new Uint8Array(fs.readFileSync(logPathOf(tapA)));
    const b = new Uint8Array(fs.readFileSync(logPathOf(tapB)));
    // Header of A followed by the records of B: every block is valid, but the chain is not.
    const spliced = Buffer.concat([
      a.subarray(0, readLog(a).records[0]!.blockOffset),
      b.subarray(readLog(b).records[0]!.blockOffset),
    ]);
    fs.writeFileSync(logPathOf(tapA), spliced);
    expect(() => openLog({ tapDir: tapA, label: 'x', tool: 't', now: 1 })).toThrow(/WRITER_STATE/);
    const damaged = b.slice();
    damaged[12] = damaged[12]! ^ 0xff;
    fs.writeFileSync(logPathOf(tapB), damaged);
    expect(() => openLog({ tapDir: tapB, label: 'x', tool: 't', now: 1 })).toThrow(/HEADER_INVALID/);
  });

  it('works without a mirror and tolerates a broken mirror folder', async () => {
    const tapDir = path.join(dir, '.tap');
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const opened = openLog({ tapDir, mirrorDir: blocker, label: 'x', tool: 't', now: 1 });
    await opened.store.append(new Uint8Array([1, 2]));
    opened.store.appendSync(new Uint8Array([3]));
    opened.store.close();
    opened.store.close();
    await expect(opened.store.append(new Uint8Array([1]))).rejects.toThrow(/closed/);
    expect(() => opened.store.appendSync(new Uint8Array([1]))).toThrow(/closed/);
    const size = fs.statSync(logPathOf(tapDir)).size;
    expect(size).toBe(readLogSize(tapDir));
  });

  it('LogStore writes to the mirror when it can', async () => {
    const log = path.join(dir, 'l.bin');
    const mirror = path.join(dir, 'm.bin');
    const store = new LogStore(log, mirror);
    await store.append(new Uint8Array([1, 2, 3]));
    store.appendSync(new Uint8Array([4]));
    store.close();
    expect([...fs.readFileSync(mirror)]).toEqual([1, 2, 3, 4]);
    const noMirror = new LogStore(path.join(dir, 'n.bin'), path.join(dir, 'missing-dir', 'm.bin'));
    await noMirror.append(new Uint8Array([9]));
    noMirror.close();
  });
});

function readLogSize(tapDir: string): number {
  return fs.statSync(logPathOf(tapDir)).size;
}

describe('FolderLock', () => {
  it('lets one window hold the lock; a second one waits until it is stale', () => {
    const lockPath = path.join(dir, 'lock');
    let now = 1_000_000;
    const a = new FolderLock(lockPath, 'window-a', () => now);
    const b = new FolderLock(lockPath, 'window-b', () => now);
    expect(a.acquire()).toEqual({ acquired: true });
    const blocked = b.acquire();
    expect(blocked.acquired).toBe(false);
    expect(a.heartbeat()).toBe(true);
    now += LOCK_STALE_MS + 1;
    expect(b.acquire()).toEqual({ acquired: true });
    expect(a.heartbeat()).toBe(false);
    expect(a.isOwned).toBe(false);
    a.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    b.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    b.release();
    expect(b.heartbeat()).toBe(false);
  });

  it('takes over its own or an unreadable lock', () => {
    const lockPath = path.join(dir, 'lock');
    fs.writeFileSync(lockPath, 'garbage');
    const a = new FolderLock(lockPath, 'a');
    expect(a.acquire()).toEqual({ acquired: true });
    const again = new FolderLock(lockPath, 'a');
    expect(again.acquire()).toEqual({ acquired: true });
    fs.unlinkSync(lockPath);
    again.release();
  });

  it('does not delete a lock another window took over', () => {
    const lockPath = path.join(dir, 'lock');
    const a = new FolderLock(lockPath, 'a');
    a.acquire();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, session: 'b', heartbeat: Date.now() }));
    a.release();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('reports unexpected file-system errors', () => {
    const a = new FolderLock(path.join(dir, 'no', 'such', 'dir', 'lock'), 'a');
    expect(() => a.acquire()).toThrow();
  });
});

describe('folder config', () => {
  it('creates, loads and hashes the config', () => {
    expect(hasConfig(dir)).toBe(false);
    const created = createConfig(dir, {
      label: 'hw3',
      include: ['**/*.py'],
      exclude: ['venv/**'],
      maxFileSizeKB: 512,
    });
    expect(hasConfig(dir)).toBe(true);
    expect(created.config.label).toBe('hw3');
    expect(created.hash).toHaveLength(32);
    expect(fs.readFileSync(path.join(dir, '.tap', '.gitignore'), 'utf8')).toContain('lock');
    createConfig(dir, { label: 'again', include: [], exclude: [], maxFileSizeKB: 1 });
  });

  it('repairs invalid fields with defaults', () => {
    fs.mkdirSync(path.join(dir, '.tap'));
    fs.writeFileSync(
      path.join(dir, '.tap', 'config.json'),
      JSON.stringify({ label: '', include: 'x', maxFileSizeKB: 99999 }),
    );
    const { config } = loadConfig(dir);
    expect(config.label).toBe(path.basename(dir));
    expect(config.include).toEqual(['**/*']);
    expect(config.exclude).toEqual([]);
    expect(config.maxFileSizeKB).toBe(4096);
    fs.writeFileSync(path.join(dir, '.tap', 'config.json'), JSON.stringify({ maxFileSizeKB: -1 }));
    expect(loadConfig(dir).config.maxFileSizeKB).toBe(1024);
  });

  it('matches include and exclude globs, always excluding .tap and .git', () => {
    const match = createMatcher({
      version: 1,
      label: 'x',
      include: ['**/*.{c,py}', '**/Makefile'],
      exclude: ['build/**'],
      maxFileSizeKB: 1,
    });
    expect(match('main.c')).toBe(true);
    expect(match('src/deep/x.py')).toBe(true);
    expect(match('Makefile')).toBe(true);
    expect(match('.hidden/x.c')).toBe(true);
    expect(match('build/x.c')).toBe(false);
    expect(match('.tap/x.c')).toBe(false);
    expect(match('sub/.git/x.c')).toBe(false);
    expect(match('notes.txt')).toBe(false);
    expect(match('')).toBe(false);
  });
});

describe('readTrackedFile', () => {
  it('reads text, strips a BOM and rejects large, binary and missing files', async () => {
    const text = path.join(dir, 't.c');
    fs.writeFileSync(text, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62]));
    expect(await readTrackedFile(text, 100)).toEqual({ kind: 'text', text: 'ab' });
    expect(await readTrackedFile(text, 2)).toEqual({ kind: 'skip', reason: 'large' });
    const bin = path.join(dir, 'b.c');
    fs.writeFileSync(bin, Buffer.from([1, 0, 2]));
    expect(await readTrackedFile(bin, 100)).toEqual({ kind: 'skip', reason: 'binary' });
    expect(await readTrackedFile(path.join(dir, 'none'), 100)).toEqual({ kind: 'missing' });
    expect(await readTrackedFile(dir, 100)).toEqual({ kind: 'missing' });
  });
});

describe('keystore', () => {
  class Secrets {
    map = new Map<string, string>();
    fail = false;
    forget = false;
    async get(k: string) {
      if (this.fail) throw new Error('no keyring');
      return this.map.get(k);
    }
    async store(k: string, v: string) {
      if (this.fail) throw new Error('no keyring');
      if (!this.forget) this.map.set(k, v);
    }
  }

  it('creates a key in secret storage and reuses it', async () => {
    const secrets = new Secrets();
    const first = await loadOrCreateKey(secrets, dir);
    expect(first).toMatchObject({ source: 'secret-storage', created: true });
    const second = await loadOrCreateKey(secrets, dir);
    expect(second.created).toBe(false);
    expect(second.key.publicKey).toEqual(first.key.publicKey);
    expect(secrets.map.get(SECRET_KEY_NAME)).toHaveLength(64);
  });

  it('falls back to a private file when secret storage fails or forgets', async () => {
    const broken = new Secrets();
    broken.fail = true;
    const first = await loadOrCreateKey(broken, dir);
    expect(first).toMatchObject({ source: 'file', created: true });
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'signing-key.hex')).mode & 0o777).toBe(0o600);
    }
    const again = await loadOrCreateKey(broken, dir);
    expect(again).toMatchObject({ source: 'file', created: false });
    expect(again.key.publicKey).toEqual(first.key.publicKey);

    const forgetful = new Secrets();
    forgetful.forget = true;
    const viaFile = await loadOrCreateKey(forgetful, dir);
    expect(viaFile.source).toBe('file');
    expect(viaFile.key.publicKey).toEqual(first.key.publicKey);

    // A working secret store adopts the existing file key.
    const working = new Secrets();
    const adopted = await loadOrCreateKey(working, dir);
    expect(adopted).toMatchObject({ source: 'secret-storage', created: false });
    expect(adopted.key.publicKey).toEqual(first.key.publicKey);
    expect(generateKeyPair().publicKey).not.toEqual(first.key.publicKey);
  });
});

describe('a recorded file on disk', () => {
  it('contains the expected record kinds', async () => {
    const tapDir = path.join(dir, '.tap');
    await recordSession(tapDir, path.join(dir, 'm'), (r) => {
      r.onFocusChanged(false);
    });
    const recs = readLog(new Uint8Array(fs.readFileSync(logPathOf(tapDir)))).records.map((x) => x.record.k);
    expect(recs[0]).toBe(Kind.SESSION_START);
    expect(recs.at(-1)).toBe(Kind.SESSION_END);
    expect(recs).toContain(Kind.FOCUS);
  });
});

describe('walkFiles', () => {
  it('lists tracked files, skips heavy and excluded folders, and honours limits', async () => {
    const { walkFiles } = await import('../src/storage/walk.js');
    const write = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'x');
    };
    for (const rel of [
      'a.c',
      'src/b.c',
      'src/deep/c.c',
      'node_modules/pkg/x.c',
      'build/out.c',
      '.git/HEAD',
      '.tap/log.codelog',
      'img.png',
    ])
      write(rel);
    const match = createMatcher({
      version: 1,
      label: 'x',
      include: ['**/*.c'],
      exclude: ['**/node_modules/**', 'build/**'],
      maxFileSizeKB: 1,
    });
    expect(await walkFiles(dir, match)).toEqual(['a.c', 'src/b.c', 'src/deep/c.c']);
    expect(await walkFiles(dir, match, { firstOnly: true })).toHaveLength(1);
    expect(await walkFiles(dir, match, { limit: 2 })).toHaveLength(2);
    // A heavy folder is entered when the rules do record files inside it.
    const all = createMatcher({ version: 1, label: 'x', include: ['**/*.c'], exclude: [], maxFileSizeKB: 1 });
    expect(await walkFiles(dir, all)).toContain('node_modules/pkg/x.c');
    expect(await walkFiles(path.join(dir, 'missing'), all)).toEqual([]);
  });
});

describe('resumeInfo', () => {
  it('tracks the last key, disk hashes and whether a session is open', async () => {
    const { resumeInfo } = await import('../src/recorder/resumeInfo.js');
    const { contentHash, LogWriter } = await import('@tap/core');
    const key = testKey();
    const other = testKey('other');
    const w = LogWriter.create({ created: 1, tool: 't' });
    const T = { t: 1, m: 0 };
    const start = (pub: Uint8Array) => ({ ...ENV, sid: new Uint8Array(16), pub });
    w.append('SESSION_START', start(key.publicKey), T);
    w.append(
      'FILE_SNAPSHOT',
      { f: 0, path: 'a', origin: 'preexisting', text: 'a', h: contentHash('a'), eol: 'lf', enc: 'utf8' },
      T,
    );
    w.append(
      'FILE_SNAPSHOT',
      { f: 0, path: 'a', origin: 'resync', text: 'b', h: contentHash('b'), eol: 'lf', enc: 'utf8' },
      T,
    );
    w.append('FILE_OP', { op: 'create', f: 1, path: 'b', origin: 'editor' }, T);
    w.append('SAVE', { f: 1, h: contentHash(''), n: 0 }, T);
    w.append('FILE_OP', { op: 'delete', f: 1, path: 'b', origin: 'editor' }, T);
    w.append('SESSION_END', { sid: new Uint8Array(16), reason: 'close' }, T);
    w.append('KEY_ROTATION', { newPub: other.publicKey, why: 'lost' }, T);
    const info = resumeInfo(readLog(w.drain()).records.map((r) => r.record));
    expect(info.sessionOpen).toBe(false);
    expect(info.lastPub).toEqual(other.publicKey);
    expect([...info.diskHashes.keys()]).toEqual([0]);
    expect(info.diskHashes.get(0)).toEqual(contentHash('a'));
  });
});
