import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources (see "source" export condition).
    conditions: ['source'],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/index.ts', 'packages/core/src/globals.d.ts'],
      reporter: ['text-summary', 'text', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
