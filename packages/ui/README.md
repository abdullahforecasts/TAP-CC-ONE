# @tap/ui

The TAP-CC-ONE log viewer (design §12): Save History, replay player, timeline, composition, events
and "About this log", plus the integrity checklist. Preact + signals, CodeMirror 6 (read-only).

- `src/model/` — framework-free: reads log bytes block by block (`LogLoader`), builds the view model
  (`LogModelBuilder`), line diffs and replay helpers. Runs in a Web Worker in the viewer and in tests.
- `src/components/` — the panels.
- `node build.mjs` — builds `dist/viewer.js` (one script, worker inlined) and `dist/viewer.css`. The
  VS Code extension shows them in a webview; any static page can host them too.
- `pnpm e2e` — Playwright tests of the built bundle under the webview's content security policy.

Author: Abdullah Nawaz · MIT
