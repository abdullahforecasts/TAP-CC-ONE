import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { LogWriter, type RecoveryBody, readLog, scanForRecovery, toHex } from '@tap/core';
import type { LogSink } from '../recorder/recorder.js';
import { type ResumeInfo, resumeInfo } from '../recorder/resumeInfo.js';

const write = promisify(fs.write);
const fdatasync = promisify(fs.fdatasync);

/**
 * Append-only file sink for a log, mirrored to a shadow copy (design §11.2). Every append is
 * followed by fdatasync so a crash loses at most the block being written, which recovery then
 * quarantines.
 */
export class LogStore implements LogSink {
  private fd: number | undefined;
  private mirrorFd: number | undefined;

  constructor(
    readonly logPath: string,
    readonly mirrorPath: string | undefined,
  ) {
    this.fd = fs.openSync(logPath, 'a');
    if (mirrorPath) {
      try {
        this.mirrorFd = fs.openSync(mirrorPath, 'a');
      } catch {
        this.mirrorFd = undefined;
      }
    }
  }

  async append(bytes: Uint8Array): Promise<void> {
    if (this.fd === undefined) throw new Error('log store is closed');
    await writeAll(this.fd, bytes);
    await fdatasync(this.fd);
    if (this.mirrorFd !== undefined) {
      try {
        await writeAll(this.mirrorFd, bytes);
      } catch {
        // The shadow copy is best effort; the workspace log is authoritative.
        this.mirrorFd = undefined;
      }
    }
  }

  appendSync(bytes: Uint8Array): void {
    if (this.fd === undefined) throw new Error('log store is closed');
    writeAllSync(this.fd, bytes);
    fs.fdatasyncSync(this.fd);
    if (this.mirrorFd !== undefined) {
      try {
        writeAllSync(this.mirrorFd, bytes);
      } catch {
        this.mirrorFd = undefined;
      }
    }
  }

  close(): void {
    for (const fd of [this.fd, this.mirrorFd]) {
      if (fd === undefined) continue;
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    this.fd = undefined;
    this.mirrorFd = undefined;
  }
}

async function writeAll(fd: number, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await write(fd, bytes, offset, bytes.length - offset, null);
    offset += bytesWritten;
  }
}

function writeAllSync(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
}

export interface OpenLogOptions {
  /** .tap folder of the workspace. */
  tapDir: string;
  /** Folder for shadow copies (extension global storage), optional. */
  mirrorDir?: string;
  label: string;
  tool: string;
  now: number;
}

export interface OpenedLog {
  writer: LogWriter;
  store: LogStore;
  info: ResumeInfo;
  isNew: boolean;
  /** Present when a damaged tail was cut off and quarantined. */
  recovery?: RecoveryBody;
  quarantinedTo?: string;
}

export function logPathOf(tapDir: string): string {
  return path.join(tapDir, 'log.codelog');
}

/**
 * Opens the folder's log for appending, creating it if needed (design §7.12, §11.2):
 * damaged tails are quarantined and cut off; logs with a broken chain are refused (TapError).
 */
export function openLog(options: OpenLogOptions): OpenedLog {
  const logPath = logPathOf(options.tapDir);
  fs.mkdirSync(options.tapDir, { recursive: true });
  let writer: LogWriter;
  let info: ResumeInfo = { diskHashes: new Map(), sessionOpen: false, lastAnchoredCk: -1 };
  let recovery: RecoveryBody | undefined;
  let quarantinedTo: string | undefined;
  let isNew = false;

  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 0) {
    const bytes = new Uint8Array(fs.readFileSync(logPath));
    const scan = scanForRecovery(bytes);
    if (scan.lost.length > 0) {
      const quarantineDir = path.join(options.tapDir, 'quarantine');
      fs.mkdirSync(quarantineDir, { recursive: true });
      quarantinedTo = path.join(quarantineDir, `tail-${options.now}.bin`);
      fs.writeFileSync(quarantinedTo, scan.lost);
      fs.truncateSync(logPath, scan.validLength);
      recovery = LogWriter.recoveryBody(scan);
    }
    const valid = bytes.subarray(0, scan.validLength);
    writer = LogWriter.resume(valid);
    info = resumeInfo(readLog(valid).records.map((r) => r.record));
  } else {
    writer = LogWriter.create({ created: options.now, tool: options.tool, label: options.label });
    const initial = writer.drain();
    const fd = fs.openSync(logPath, 'w');
    try {
      writeAllSync(fd, initial);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    isNew = true;
  }

  let mirrorPath: string | undefined;
  if (options.mirrorDir) {
    try {
      fs.mkdirSync(options.mirrorDir, { recursive: true });
      mirrorPath = path.join(options.mirrorDir, `${toHex(writer.header.logId)}.codelog`);
      // Re-seed the shadow copy whenever it does not mirror the log exactly in size.
      const logSize = fs.statSync(logPath).size;
      if (!fs.existsSync(mirrorPath) || fs.statSync(mirrorPath).size !== logSize)
        fs.copyFileSync(logPath, mirrorPath);
    } catch {
      mirrorPath = undefined;
    }
  }
  const opened: OpenedLog = { writer, store: new LogStore(logPath, mirrorPath), info, isNew };
  if (recovery) opened.recovery = recovery;
  if (quarantinedTo) opened.quarantinedTo = quarantinedTo;
  return opened;
}
