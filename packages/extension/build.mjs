// Bundles the extension (and, with --tests, the integration tests) with esbuild, and copies the
// viewer (@tap/ui, built first if its sources changed) into dist/webview.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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

/** Newest modification time of the files under `dir`. */
function newest(dir) {
  let t = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) t = Math.max(t, statSync(join(entry.parentPath ?? entry.path, entry.name)).mtimeMs);
  }
  return t;
}

/** Builds the viewer bundle when it is missing or older than its sources, then copies it. */
function viewer() {
  const ui = join(here, '..', 'ui');
  const bundle = join(ui, 'dist', 'viewer.js');
  const sources = Math.max(newest(join(ui, 'src')), newest(join(here, '..', 'core', 'src')));
  if (!existsSync(bundle) || statSync(bundle).mtimeMs < sources) {
    const result = spawnSync(process.execPath, [join(ui, 'build.mjs')], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('building the viewer (@tap/ui) failed');
  }
  const out = join(here, 'dist', 'webview');
  mkdirSync(out, { recursive: true });
  for (const name of ['viewer.js', 'viewer.css']) copyFileSync(join(ui, 'dist', name), join(out, name));
}

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
  viewer();
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
