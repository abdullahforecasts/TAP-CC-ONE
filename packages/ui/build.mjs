// Builds the viewer bundle: dist/viewer.js (one IIFE script with the worker inlined) and
// dist/viewer.css. The extension copies both into its webview folder.
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: { conditions: ['source', 'browser', 'import', 'module', 'default'] },
  worker: { format: 'iife' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.tsx',
      formats: ['iife'],
      name: 'TapViewer',
      fileName: () => 'viewer.js',
      cssFileName: 'viewer',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
console.log('dist/viewer.js, dist/viewer.css');
