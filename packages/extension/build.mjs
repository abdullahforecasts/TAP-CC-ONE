// Bundles the extension (and, with --tests, the integration tests) with esbuild.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // Resolve workspace packages (@tap/core) from their TypeScript sources.
  conditions: ['source'],
  logLevel: 'warning',
};

if (tests) {
  rmSync(join(here, 'out'), { recursive: true, force: true });
  const suite = join(here, 'test-integration', 'suite');
  const entryPoints = [
    join(here, 'test-integration', 'runTest.ts'),
    join(suite, 'index.ts'),
    ...readdirSync(suite)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => join(suite, f)),
  ];
  await esbuild.build({
    ...common,
    entryPoints,
    outdir: join(here, 'out', 'test'),
    outExtension: { '.js': '.cjs' },
    outbase: join(here, 'test-integration'),
    external: ['vscode', 'mocha', '@vscode/test-electron'],
    sourcemap: true,
  });
} else {
  const options = {
    ...common,
    entryPoints: [join(here, 'src', 'extension.ts')],
    outfile: join(here, 'dist', 'extension.cjs'),
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    metafile: true,
  };
  if (production) {
    rmSync(join(here, 'dist'), { recursive: true, force: true });
    mkdirSync(join(here, 'dist'), { recursive: true });
    // vsce expects the license next to the manifest.
    copyFileSync(join(here, '..', '..', 'LICENSE'), join(here, 'LICENSE'));
  }
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('watching…');
  } else {
    const result = await esbuild.build(options);
    const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
    console.log(`dist/extension.cjs: ${(bytes / 1024).toFixed(0)} KB${production ? ' (production)' : ''}`);
  }
}
