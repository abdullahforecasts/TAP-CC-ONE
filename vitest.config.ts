import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fakeVscode = fileURLToPath(new URL('./packages/extension/test/support/fakeVscode.ts', import.meta.url));

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (see the "source" export condition).
  resolve: {
    conditions: ['source', 'import', 'module', 'node', 'default'],
    // Extension unit tests run against an in-memory stand-in for the VS Code API.
    alias: { vscode: fakeVscode },
  },
  ssr: {
    resolve: {
      conditions: ['source', 'import', 'module', 'node', 'default'],
      externalConditions: ['source'],
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**/*.ts',
        'packages/extension/src/recorder/**/*.ts',
        'packages/extension/src/storage/**/*.ts',
        'packages/extension/src/vscode/**/*.ts',
      ],
      exclude: ['packages/core/src/index.ts', 'packages/core/src/globals.d.ts'],
      reporter: ['text-summary', 'text', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
