/**
 * Runs the integration tests inside a real VS Code (downloaded by @vscode/test-electron).
 * On Linux CI it must run under a virtual display: `xvfb-run -a pnpm test:integration`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.cjs');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-it-ws-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-it-user-'));
  fs.writeFileSync(path.join(workspace, 'main.c'), '#include <stdio.h>\n\nint main(void) {\n}\n');
  fs.writeFileSync(path.join(workspace, 'other.c'), 'int other = 1;\n');
  fs.mkdirSync(path.join(workspace, '.vscode'));
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify(
      {
        'tap.promptOnOpen': false,
        'tap.include': ['**/*.{c,h,txt}'],
        // No requests to real timestamp services from CI (scripts/record-real.ts covers them).
        'tap.anchoring.enabled': false,
        'files.trimTrailingWhitespace': true,
        'files.autoSave': 'off',
        'editor.formatOnPaste': false,
        'git.enabled': false,
      },
      null,
      2,
    ),
  );
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION ?? 'stable',
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { TAP_DEBUG: '1' },
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir',
        userData,
      ],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
