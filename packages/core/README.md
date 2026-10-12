# @tap/core

Core library of TAP-CC-ONE: the `.codelog` format, hash chain, Ed25519 checkpoints, deterministic replay, per-character provenance and verification. It runs unchanged in Node, browsers and VS Code webviews: no Node-only APIs and no native modules.

**Author:** Abdullah Nawaz · **License:** MIT · **Spec:** [`spec/log-format-v1.md`](../../spec/log-format-v1.md)

## Modules

| Module | Purpose |
|---|---|
| `framing` | Magic bytes, block frames, CRC-32, bounded deflate |
| `cbor` | Deterministic CBOR encode and strict canonical decode |
| `records` | Record types and validators for all 19 kinds |
| `hash`, `crypto` | Domain-separated SHA-256, genesis and record hashes, Ed25519 checkpoints, key fingerprints |
| `text`, `paths` | Line-ending normalisation, content hashes, workspace path rules |
| `reader`, `writer` | Streaming reader; append-only writer that replays what it writes |
| `replay` | Replayer, state digest, checkpoint-cached `ReplayIndex` for seeking |
| `provenance` | Span lists of character origins and final-code composition |
| `changes` | Converts simultaneous editor changes to sequential order |
| `recovery` | Finds the valid prefix of a log damaged by a crash |
| `verify` | Verification pipeline: parse → chain → signatures → anchors → replay → submission |

## Dependencies

All pure JavaScript and audited or widely used: `@noble/hashes`, `@noble/curves` (SHA-256, Ed25519), `cborg` (CBOR), `fflate` (deflate).
