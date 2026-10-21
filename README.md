# TAP-CC-ONE

A VS Code extension that records a tamper-evident, independently timestamped history of how code was written. Students attach this history to their submissions so they can counter false plagiarism or AI-use allegations.

**Author:** Abdullah Nawaz · **License:** [PolyForm Noncommercial 1.0.0](LICENSE) (free for education, research and personal use; [commercial use](#license) by agreement)

## Status

| Part | Scope | Status |
|---|---|---|
| 1 | Foundations & core format (`@tap/core`, spec, test vectors, CI) | **Done** |
| 2 | Recorder extension | **Done** (0.1.0 development build) |
| 3 | Viewer: Save History & Replay | **Done** (0.2.0 development build) |
| 4 | Timestamp anchoring, export and opening submissions | **Done** (0.3.0 development build) |
| 5 | Verifier (web + CLI) | Planned |
| 6 | Hardening, beta & publishing | Planned |

See [`design.md`](design.md) for the full design and [`implementationGoals.md`](implementationGoals.md) for the plan.

## Repository layout

```
design.md                 design document
docs/anchoring-providers.md   timestamp services, trusted roots, recording real answers
implementationGoals.md    six-part implementation plan
spec/
  log-format-v1.md        normative log format and verification rules
  schema-v1.cddl          CDDL schema for every record
  vectors/                conformance test vectors (generated, byte-exact)
packages/
  core/                   @tap/core — format, chain, signatures, replay, provenance, verification
  ui/                     @tap/ui — the log viewer (Save History, replay, timeline, composition)
  extension/              the VS Code extension (recorder, viewer panel, storage, tests)
  anchor/                 @tap/anchor — RFC 3161 and OpenTimestamps clients and token verification
  verifier-web/ cli/      placeholders for Part 5
tools/
  gen-vectors/            deterministic test vector generator
  bench/                  performance benchmark (4-hour DSA session simulation)
  fuzz/                   mutation fuzzer for the verifier
```

## Getting started

Requirements: Node.js 20.11 or newer (22 recommended) and pnpm 10. If pnpm is not installed, Node's Corepack provides it:

```bash
corepack enable          # once; makes the pinned pnpm version available
pnpm install
pnpm check               # lint, typecheck, tests with coverage, build, browser check, vectors and roots checks
```

Individual commands:

| Command | What it does |
|---|---|
| `pnpm test` | Unit, property-based and conformance tests |
| `pnpm test:coverage` | Same, with coverage thresholds (90% lines) |
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format |
| `pnpm typecheck` | TypeScript strict checks for every package |
| `pnpm build` | Builds `@tap/core`, the viewer bundle and the extension |
| `pnpm build:browser-check` | Bundles `@tap/core` for browsers (fails on Node-only APIs) |
| `pnpm vectors:generate` | Regenerates `spec/vectors/` |
| `pnpm vectors:check` | Fails if regenerated vectors differ from the committed ones |
| `pnpm bench` | Simulates a 4-hour assignment and reports speed and log size |
| `pnpm fuzz --seconds 60` | Fuzzes the verifier with mutated logs |
| `pnpm --filter @tap/ui run e2e` | Viewer end-to-end tests in Chromium (needs `pnpm --filter @tap/ui exec playwright install chromium` once) |
| `pnpm --filter tap-cc-one run package` | Builds `packages/extension/tap-cc-one-0.3.0.vsix` |
| `pnpm --filter @tap/anchor roots --check` | Fails if a trusted timestamp root expired or `roots.generated.ts` is stale |
| `pnpm --filter @tap/anchor real` | Records real answers from the timestamp services (needs internet; see `docs/anchoring-providers.md`) |
| `pnpm --filter tap-cc-one test:integration` | Runs the extension tests inside a real VS Code (downloads VS Code; on Linux use `xvfb-run -a`) |

## Trying the extension

- **From source:** open the repo in VS Code and press **F5** (uses `.vscode/launch.json`). A second VS Code window opens with the extension loaded; open any folder with code there and choose **Start**.
- **From the VSIX:** run `pnpm --filter tap-cc-one run package`, then in VS Code: Extensions view → `⋯` → **Install from VSIX…** → pick `packages/extension/tap-cc-one-0.3.0.vsix`.
- **The viewer on its own:** `pnpm --filter @tap/ui build`, then serve `packages/ui/dist` with any static server and open a `.codelog` file in the page.

Set `TAP_PROPERTY_RUNS=2000` to run the property tests harder than the default 150 cases.

## Using `@tap/core`

```ts
import { LogWriter, contentHash, verifyLog, generateKeyPair } from '@tap/core';

const key = generateKeyPair();
const log = LogWriter.create({ created: Date.now(), tool: 'my-recorder/0.1.0', label: 'assignment-1' });

log.append('SESSION_START', {
  sid: crypto.getRandomValues(new Uint8Array(16)),
  pub: key.publicKey,
  vsc: '1.105.0', app: 'vscode', os: 'linux', ext: '0.1.0',
  aiExt: [], liveShare: false, cfgHash: new Uint8Array(32),
}, { t: Date.now(), m: 0 });

log.append('FILE_OP', { op: 'create', f: 0, path: 'main.py', origin: 'editor' }, { t: Date.now(), m: 10 });
log.append('EDIT_BATCH', { f: 0, c: [[0, 0, 0, 'p'], [140, 1, 0, 'r']] }, { t: Date.now(), m: 300 });
log.appendCheckpoint(key.secretKey, { t: Date.now(), m: 400 });

const bytes = log.drain();          // append these bytes to .tap/log.codelog
const report = verifyLog(bytes);    // { verdict, findings, finalFiles, composition, ... }
```

The writer does no I/O, replays everything it appends (so `log.state` is exactly what a verifier will reconstruct), and refuses records that would not replay.

## License

The code is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Free** for noncommercial use: students, teachers, schools and universities, research, and personal projects.
- **Commercial use** (for example a company, a paid course or proctoring platform, or a product that includes this code) needs a separate commercial licence. Contact Abdullah Nawaz at abdullahforecasts@gmail.com.
- The **log format specification and test vectors** in [`spec/`](spec/) are under the [MIT License](spec/LICENSE), so any tool may read and verify TAP-CC-ONE logs.

Versions published before this change (up to commit `f1d6530`) remain available under the MIT License.
