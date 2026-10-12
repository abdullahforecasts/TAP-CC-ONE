import * as fs from 'node:fs/promises';
import type { DiskRead } from '../recorder/recorder.js';

const decoder = new TextDecoder('utf-8');
const BINARY_SNIFF = 8192;

/**
 * Reads a file for recording: missing, too large or binary (NUL byte in the first 8 KB) files
 * are reported instead of read. A UTF-8 BOM is dropped, as the editor does.
 */
export async function readTrackedFile(absPath: string, maxBytes: number): Promise<DiskRead> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return { kind: 'missing' };
  }
  if (!stat.isFile()) return { kind: 'missing' };
  if (stat.size > maxBytes) return { kind: 'skip', reason: 'large' };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(absPath));
  } catch {
    return { kind: 'missing' };
  }
  const sniff = bytes.subarray(0, BINARY_SNIFF);
  if (sniff.includes(0)) return { kind: 'skip', reason: 'binary' };
  return { kind: 'text', text: decoder.decode(bytes) };
}
