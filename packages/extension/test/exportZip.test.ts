import { contentHash, verifyLog } from '@tap/core';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildSubmissionZip, exportBaseName, HOW_TO, readSubmissionZip } from '../src/vscode/exportZip.js';
import { Sim } from './support/sim.js';

async function recorded() {
  const sim = new Sim();
  sim.host.disk.set('src/main.c', '');
  await sim.start();
  sim.open('src/main.c');
  sim.type('src/main.c', 0, 'int main() { return 0; }\n');
  sim.save('src/main.c');
  await sim.recorder.stop();
  return { log: sim.bytes, files: [{ path: 'src/main.c', content: 'int main() { return 0; }\n' }] };
}

describe('submission zip', () => {
  it('holds the log, the code and instructions, and reads back for checking', async () => {
    const { log, files } = await recorded();
    const report = verifyLog(log, { submission: files });
    const now = new Date(2026, 9, 21, 9, 5);
    const { zip, name } = buildSubmissionZip({
      folderName: 'Lab 3: Arrays',
      extensionVersion: '0.3.0',
      log,
      files,
      report,
      now,
    });
    expect(name).toBe('Lab-3-Arrays-2026-10-21-0905.zip');
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      HOW_TO,
      'Lab-3-Arrays-2026-10-21-0905.codelog',
      'src/main.c',
    ]);
    const howTo = new TextDecoder().decode(entries[HOW_TO]);
    expect(howTo).toContain('TAP: Open Log File');
    expect(howTo).toContain('Signing key fingerprint: ');
    expect(howTo).toContain('No independent timestamps yet');
    const back = readSubmissionZip(zip);
    expect(back.log).toEqual(log);
    expect(back.files.map((f) => f.path)).toEqual(['src/main.c']);
    expect(
      verifyLog(back.log, { submission: back.files })
        .findings.filter((f) => f.stage === 'submission')
        .map((f) => f.code),
    ).toEqual(['SUBMISSION_MATCH']);
  });

  it('reads a zipped project folder with .tap/ inside a top folder', async () => {
    const { log } = await recorded();
    const zip = zipSync({
      'proj/.tap/log.codelog': log,
      'proj/.tap/config.json': strToU8('{}'),
      'proj/src/main.c': strToU8('int main() { return 0; }\n'),
      'proj/a.out': new Uint8Array([0x7f, 0x45]),
      '__MACOSX/proj/._x': new Uint8Array([1]),
    });
    const back = readSubmissionZip(zip);
    expect(back.logName).toBe('proj/.tap/log.codelog');
    expect(back.files.map((f) => f.path).sort()).toEqual(['a.out', 'src/main.c']);
    expect(
      contentHash(
        new TextDecoder().decode(back.files.find((f) => f.path === 'src/main.c')!.content as Uint8Array),
      ),
    ).toEqual(contentHash('int main() { return 0; }\n'));
  });

  it('refuses zips without a log', () => {
    expect(() => readSubmissionZip(zipSync({ 'a.c': strToU8('x') }))).toThrow(/no \.codelog/);
  });

  it('names exports safely', () => {
    expect(exportBaseName('../evil/..', new Date(2026, 0, 2, 3, 4))).toBe('..-evil-..-2026-01-02-0304');
    expect(exportBaseName('***', new Date(2026, 0, 2, 3, 4))).toBe('code-2026-01-02-0304');
  });
});
