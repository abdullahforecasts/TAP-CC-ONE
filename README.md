# TAP-CC-ONE

A VS Code extension that records a tamper-evident, independently timestamped history of how code was written. Students attach this history to their submissions so they can counter false plagiarism or AI-use allegations.

**Author:** Abdullah Nawaz · **License:** MIT

## Status

| Part | Scope | Status |
|---|---|---|
| 1 | Foundations & core format (`@tap/core`, spec, test vectors, CI) | **Done** |
| 2 | Recorder extension | Planned |
| 3 | Viewer: Save History & Replay | Planned |
| 4 | Timestamp anchoring | Planned |
| 5 | Verifier (web + CLI) | Planned |
| 6 | Hardening, beta & publishing | Planned |

See [`design.md`](design.md) for the full design and [`implementationGoals.md`](implementationGoals.md) for the plan.

## Repository layout

```
design.md                 design document
implementationGoals.md    six-part implementation plan
spec/
  log-format-v1.md        normative log format and verification rules
  schema-v1.cddl          CDDL schema for every record
  vectors/                conformance test vectors (generated, byte-exact)
packages/
  core/                   @tap/core — format, chain, signatures, replay, provenance, verification
  anchor/ ui/ extension/ verifier-web/ cli/   placeholders for Parts 2–5
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
pnpm check               # lint, typecheck, tests with coverage, build, browser check, vectors check
```

Individual commands:

| Command | What it does |
|---|---|
| `pnpm test` | Unit, property-based and conformance tests |
| `pnpm test:coverage` | Same, with coverage thresholds (90% lines) |
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format |
| `pnpm typecheck` | TypeScript strict checks for every package |
| `pnpm build` | Compiles `@tap/core` to `packages/core/dist` |
| `pnpm build:browser-check` | Bundles `@tap/core` for browsers (fails on Node-only APIs) |
| `pnpm vectors:generate` | Regenerates `spec/vectors/` |
| `pnpm vectors:check` | Fails if regenerated vectors differ from the committed ones |
| `pnpm bench` | Simulates a 4-hour assignment and reports speed and log size |
| `pnpm fuzz --seconds 60` | Fuzzes the verifier with mutated logs |

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
