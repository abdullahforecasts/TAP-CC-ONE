import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

/** Entry point VS Code calls inside the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  for (const file of fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.cjs'))
    .sort()) {
    mocha.addFile(path.join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve(),
    );
  });
}
