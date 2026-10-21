# TAP-CC-ONE Log Format, version 1

| | |
|---|---|
| **Status** | Draft. Frozen at extension release 1.0; until then it may change, always together with the test vectors. |
| **Author** | Abdullah Nawaz |
| **Reference implementation** | `packages/core` (`@tap/core`) |
| **Conformance** | `spec/vectors/`: an implementation conforms when it produces the expected result for every vector |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

This document is normative for the file format and the verification rules. `design.md` explains the reasons; where the two differ, this document wins. Differences from `design.md` §7 are listed in [Appendix A](#appendix-a--changes-from-designmd).

---

## 1. Overview

A `.codelog` file is an append-only sequence of **records** describing how the code in one workspace folder was written. Records are linked into a SHA-256 **hash chain**, periodically **checkpointed** (each checkpoint commits to the full code state and is signed with Ed25519), and checkpoints can be **anchored** by third-party timestamp services.

```
+------------------------------------------------+
| MAGIC (8 bytes)                                |
| HEADER BLOCK (uncompressed, one CBOR map)      |
| BLOCK 0 (CBOR sequence of records)             |
| BLOCK 1                                        |
| ...                                            |
+------------------------------------------------+
```

## 2. Magic

The file MUST start with these 8 bytes:

```
89 43 4C 47 0D 0A 1A 0A      (0x89 "CLG" CR LF ^Z LF)
```

The high-bit first byte detects 7-bit transfers, CR LF detects line-ending conversion, and 0x1A stops `type` on Windows. Readers MUST reject a file whose first 8 bytes differ (`BAD_MAGIC`).

## 3. Blocks

Every block, including the header block, is framed as:

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 4 | `payload_len` | u32 big-endian: bytes of payload as stored |
| 4 | 1 | `codec` | 0 = none, 1 = deflate-raw (RFC 1951, no zlib/gzip wrapper) |
| 5 | 4 | `raw_len` | u32 big-endian: payload length after decompression |
| 9 | n | `payload` | `payload_len` bytes |
| 9+n | 4 | `crc32` | CRC-32/ISO-HDLC (zlib/PNG polynomial) over bytes `[0, 9+n)` |

Rules (readers MUST check them in this order, before allocating memory for the payload):

1. At least 13 bytes remain, otherwise `TRUNCATED`.
2. `raw_len` ≥ 1, otherwise `EMPTY_BLOCK`.
3. `raw_len` ≤ 8 388 608 (8 MiB), otherwise `BLOCK_TOO_LARGE`.
4. `codec` ∈ {0, 1}, otherwise `BAD_CODEC`.
5. If `codec` = 0 then `payload_len` = `raw_len`, otherwise `RAW_LEN_MISMATCH`.
6. `payload_len` ≤ `raw_len` + 1024, otherwise `BLOCK_TOO_LARGE`.
7. The whole frame fits in the file, otherwise `TRUNCATED`.
8. The CRC matches, otherwise `BAD_CRC`.
9. For `codec` = 1, decompression MUST stop after at most `raw_len` + 1 output bytes. Invalid deflate data is `DECOMPRESS_FAILED`; output of any length other than `raw_len` is `RAW_LEN_MISMATCH`. This bounds memory use (decompression-bomb guard).

Writers SHOULD use codec 1 only when it makes the payload smaller. Compression settings are not normative: verification never depends on the compressed bytes, only on the decompressed payload.

The CRC protects against storage corruption. Protection against tampering comes from the hash chain (§6).

## 4. Encoding

All structured data is CBOR (RFC 8949) restricted to this subset:

- unsigned and negative integers in the range ±(2⁵³ − 1)
- byte strings
- UTF-8 text strings
- arrays
- maps whose keys are text strings
- `true` and `false`

Floats, `null`, `undefined`, tags, big integers and simple values other than `true`/`false` MUST NOT appear. Absent optional fields are omitted, never encoded as `null`.

Every item MUST use **deterministic encoding** (RFC 8949 §4.2.1): shortest-form integers and lengths, definite lengths only, map keys sorted by the bytewise order of their encoded form, no duplicate keys. Readers MUST reject any item whose bytes differ from the deterministic encoding of its decoded value (`CBOR_NONCANONICAL` or `CBOR_INVALID`). This makes every value have exactly one byte representation, so hashes cannot be changed without changing content.

Text MUST be well-formed Unicode. Writers MUST NOT emit strings containing lone UTF-16 surrogates; a recorder replaces them with U+FFFD before recording.

## 5. Header and records

### 5.1 Header

The header block's payload is exactly one CBOR map. Unknown keys MUST be rejected (`HEADER_INVALID`).

| Key | Type | Value |
|---|---|---|
| `fmt` | uint | `1` |
| `logId` | bstr (16) | random, from a CSPRNG |
| `created` | uint | Unix time in ms (UTC) |
| `tool` | tstr (1–200) | recorder name and version |
| `hash` | tstr | `"sha-256"` |
| `sig` | tstr | `"ed25519"` |
| `label` | tstr (≤ 200), optional | workspace label |

### 5.2 Record envelope

Each later block's payload is a CBOR sequence (RFC 8742) of one or more records. Each record is a map with exactly these keys (unknown keys MUST be rejected):

| Key | Type | Meaning |
|---|---|---|
| `s` | uint | sequence number: 0 for the first record, then +1 |
| `k` | uint | kind (§5.3); unknown kinds MUST be rejected |
| `t` | uint | wall-clock time, Unix ms UTC (self-asserted) |
| `m` | uint | monotonic ms since the current session's SESSION_START |
| `p` | bstr (32) | hash of the previous record (§6) |
| `b` | map | kind-specific body |

Inside a body, unknown keys MUST be ignored, so optional fields can be added in minor revisions without changing `fmt`. Known fields MUST have the documented types.

### 5.3 Record kinds

Field types are given in `schema-v1.cddl`. Summary:

| Code | Kind | Body |
|---|---|---|
| 1 | SESSION_START | `sid` bstr16, `pub` bstr32 (Ed25519 public key), `vsc`, `app`, `os`, `ext` tstr, `aiExt` [tstr], `liveShare` bool, `cfgHash` bstr32, `settings`? map |
| 2 | SESSION_END | `sid`, `reason` ∈ close, reload, deactivate |
| 3 | FILE_SNAPSHOT | `f` uint, `path`, `origin`, `text` tstr, `h` bstr32, `eol` ∈ lf, crlf, `enc` tstr |
| 4 | EDIT_BATCH | `f`, `c`: one or more change tuples (§5.4) |
| 5 | SAVE | `f`, `h` bstr32, `n` uint |
| 6 | FILE_OP | `op` ∈ create, delete, rename; `f`; `path`; `newPath` (required for rename, forbidden otherwise); `origin` ∈ editor, external, fromUntitled |
| 7 | EXTERNAL_CHANGE | `f`, `h`, `hint`? = "vcs" |
| 8 | RUN_START | `rid` uint, `kind` ∈ debug, task, terminal, `name`?, `cmd`?, `cwd`? path |
| 9 | RUN_END | `rid`, `exit`? int |
| 10 | FOCUS | `on` bool |
| 11 | PAUSE | `why`? tstr |
| 12 | RESUME | (empty) |
| 13 | CHECKPOINT | `state` bstr32, `files` uint, `sig` bstr64 |
| 14 | ANCHOR | `ck` uint, `d` bstr32, `type` ∈ rfc3161, ots, `src` tstr, `tok` bstr, `status` ∈ complete, pending, upgraded |
| 15 | RECOVERY | `lostBytes`, `quarantineHash` bstr32, `atOffset` |
| 16 | NOTE | `text`: 1 to 2000 code points |
| 17 | KEY_ROTATION | `oldPub`? bstr32, `newPub` bstr32, `why` ∈ lost, manual |
| 18 | CLOCK_ANOMALY | `wallDelta` int, `monoDelta` uint |
| 19 | ENV_CHANGE | any of `vsc`, `aiExt`, `liveShare`, `cfgHash`, `settings` |

Snapshot `origin` ∈ preexisting, created, external, resync, paused-gap, periodic.

### 5.4 Change tuples

A change is `[dt, off, del, ins]` or `[dt, off, del, ins, flags]`:

| Element | Meaning |
|---|---|
| `dt` | uint: ms since the previous change to this file (monotonic) |
| `off` | uint: offset in **UTF-16 code units** into the file text as it is when this change is applied |
| `del` | uint: UTF-16 code units deleted at `off` |
| `ins` | tstr: inserted text (may be empty) |
| `flags` | uint: present only when non-zero |

Changes within a record, and records within the log, are applied **sequentially** in stored order. A recorder converts one editor event's simultaneous changes to this order by sorting them by descending offset (ties: longer range first). Offsets count characters exactly as they are in the document, so CR LF counts as two units.

A change MUST NOT be empty (`del` = 0 and `ins` = ""). Flags:

| Bit | Name | Meaning |
|---|---|---|
| 0x01 | UNDO | produced by undo |
| 0x02 | REDO | produced by redo |
| 0x04 | PASTE | inserted text equals the clipboard |
| 0x08 | BULK | multi-character insertion that is not a paste (completion, snippet, AI, drop) |
| 0x10 | MULTI_CURSOR | part of a multi-cursor edit |
| 0x20 | FORMAT_ON_SAVE | made by a formatter during save |
| 0x40 | LARGE | set **exactly** when `ins` is longer than 262 144 code units |
| 0x80 | CLASSIFY_TIMEOUT | the clipboard comparison did not finish in time |

UNDO and REDO are mutually exclusive, as are PASTE and BULK. Other bits MUST be zero.

### 5.5 Paths

Paths are workspace-relative: `/` separators, non-empty segments, no `.` or `..` segments, no leading `/`, no backslash, no NUL, no drive letter, at most 4096 characters.

## 6. Hashing and the chain

```
DS(label) = UTF-8(label) || 0x00

genesis   = SHA-256( DS("CLG1/genesis") || header_bytes )
H(record) = SHA-256( DS("CLG1/record")  || record_bytes )

record[0].p = genesis
record[i].p = H(record[i-1])
```

`header_bytes` and `record_bytes` are the exact (deterministic) CBOR bytes as stored.

### 6.1 Text normalisation

Used only when hashing text for comparison (`h` fields, state digest, submission matching), never for replay:

1. Remove one leading U+FEFF.
2. Replace every run of one or more CR characters directly followed by LF with nothing, keeping the LF (`\r\n` → `\n`, `\r\r\n` → `\n`).
3. Replace every remaining CR with LF.

No other changes (no trimming, no Unicode normalisation). Step 2 removes a whole CR run so that the result does not change when Git or an editor converts line endings in either direction.

`contentHash(text) = SHA-256(UTF-8(normalise(text)))`.

### 6.2 State digest

```
entries = [ [path, f, contentHash(text)], ... ]   for every live file,
          sorted by the bytes of UTF-8(path)
state   = SHA-256( DS("CLG1/state") || deterministic_cbor(entries) )
```

### 6.3 Checkpoint signature

```
msg = DS("CLG1/checkpoint") || logId || u64be(s) || p || state || u64be(t)
sig = Ed25519.sign(secretKey, msg)
```

`s`, `p` and `t` are the checkpoint record's own envelope fields. The signing key is the `pub` of the most recent SESSION_START.

### 6.4 Anchors

An ANCHOR's `ck` is the sequence number of an earlier CHECKPOINT, and `d` MUST equal `H(that checkpoint record)`. `tok` carries the third-party proof over `d`. `src` names the service that issued it (informative: verification never depends on it). A checkpoint may have any number of anchors, written by the same session or a later one.

**`type` rfc3161.** `tok` is a DER TimeStampToken (RFC 3161 §2.4.2: a CMS ContentInfo with SignedData whose content is a TSTInfo). `status` is `complete`. A token is **valid** when all of the following hold, **invalid** when any of 1 to 6 fails, and **untrusted** when only 7 fails:

1. It parses as DER (definite lengths, minimal length encodings) with exactly one SignerInfo, and the encapsulated content type is id-ct-TSTInfo.
2. TSTInfo `version` is 1, its `messageImprint` uses SHA-256, and the imprint equals `d`.
3. If signed attributes are present, they contain content-type id-ct-TSTInfo and a message-digest equal to the digest of the encapsulated TSTInfo; an ESS signing-certificate (SHA-1) or signing-certificate-v2 attribute, when present, has a first hash that matches the signer certificate.
4. The signer certificate is the one the SignerInfo sid identifies among the token's certificates.
5. The signature verifies with the signer key, over the DER of the signed attributes re-tagged as SET OF (or over the TSTInfo when there are none). Accepted: RSA PKCS #1 v1.5 and PSS with SHA-1, SHA-256, SHA-384 or SHA-512 (keys of at least 2048 bits) and ECDSA on P-256, P-384 or P-521.
6. The signer certificate has the extended key usage id-kp-timeStamping, every certificate on the path is within its validity period at `genTime`, and every certificate signature on the path verifies (issuers being CA certificates).
7. The path from the signer through the token's certificates (at most 8 steps) reaches a certificate the verifier trusts. Trusted certificates are taken as given.

The token's **time** is TSTInfo `genTime`. Revocation is not checked (TSA certificates are rarely revoked, and offline verification is a goal).

**`type` ots.** `tok` is an OpenTimestamps detached proof without the file header: the serialised timestamp tree for message `d` (operations append `0xf0`, prepend `0xf1`, reverse `0xf2`, hexlify `0xf3`, sha1 `0x02`, ripemd160 `0x03`, sha256 `0x08`, keccak256 `0x67`; attestations tag `0x00`; fork marker `0xff`). Limits: messages at most 4096 bytes, depth at most 256, at most 10 000 nodes. `status` is `pending` (only calendar attestations) or `upgraded` (at least one Bitcoin attestation). A proof is **confirmed** when it has a Bitcoin attestation. When the verifier knows the 80-byte header of that block, the attested message MUST equal header bytes 36 to 68 (the Merkle root, as stored), otherwise the proof is invalid; the proof's **time** is then the header's block time (bytes 68 to 72, little-endian seconds). Without the header, a confirmed proof has no time. A proof with only pending attestations is **pending**; one with no attestation is invalid.

A checkpoint is **anchored** when at least one of its anchors is valid or confirmed with a time. Its **existed-by** time is the earliest such time.

## 7. Replay

Replay reconstructs the set of **live files**, each with an id `f`, a path and a text.

| Record | Effect | Failures |
|---|---|---|
| FILE_SNAPSHOT, new id | adds the file | `h` ≠ contentHash(text) → SNAPSHOT_HASH_MISMATCH; id deleted earlier → FILE_ID_REUSED; origin resync or periodic → SNAPSHOT_ORIGIN_INVALID; path already live → DUPLICATE_PATH |
| FILE_SNAPSHOT, live id | replaces the text | path differs → SNAPSHOT_PATH_MISMATCH; origin preexisting, or created when the text is not empty → SNAPSHOT_ORIGIN_INVALID; external with a pending EXTERNAL_CHANGE whose `h` differs → EXTERNAL_HASH_MISMATCH |
| EDIT_BATCH | applies changes in order | unknown or deleted id → UNKNOWN_FILE / FILE_DELETED; any change outside the text → EDIT_OUT_OF_BOUNDS (the whole batch is rejected) |
| SAVE | none | contentHash(text) ≠ `h` → SAVE_HASH_MISMATCH; UTF-16 length ≠ `n` → SAVE_LENGTH_MISMATCH |
| FILE_OP create | adds an empty file | id used before → FILE_ID_REUSED; path live → DUPLICATE_PATH |
| FILE_OP delete / rename | removes / renames | `path` ≠ current path → OP_PATH_MISMATCH; new path live → DUPLICATE_PATH |
| EXTERNAL_CHANGE | marks the file as changed outside the editor | unknown id → UNKNOWN_FILE |
| other kinds | none | |

File ids are never reused within a log. There are at most 50 000 live files (TOO_MANY_FILES).

A snapshot that changes a live file's text is reported as: `external` → EXTERNAL_CHANGE (info); `resync` → RESYNC (warn); `paused-gap` → PAUSED_GAP_CHANGES (warn); `periodic` → PERIODIC_SNAPSHOT_DIVERGED (warn). A new file from an `external` snapshot is EXTERNAL_FILE (info), from a `paused-gap` snapshot PAUSED_GAP_CHANGES (warn), and from FILE_OP create with origin external EXTERNAL_FILE_CREATED (info). An EXTERNAL_CHANGE with hint `vcs` is VCS_OPERATION (info). A snapshot whose `eol` does not match its text (`crlf` exactly when the text contains CR LF) is SNAPSHOT_EOL_MISMATCH (warn).

### 7.1 Provenance (informative)

Verifiers SHOULD track the origin of every UTF-16 unit of each file: `typed`, `paste`, `internal-copy`, `bulk`, `format`, `undo-redo` (from change flags, in that precedence order: undo/redo, format, paste, bulk, typed), and `preexisting`, `created`, `external`, `resync`, `paused-gap` (from snapshots). A paste whose EOL-normalised, non-blank text already occurs in a live file is `internal-copy`. When a change or a snapshot replaces text, only what differs gets the new origin: the deleted and inserted texts (for a snapshot, the old and new file) are reduced by `minimalEdits` — strip the longest common prefix and suffix, diff the remaining lines with Myers' algorithm (at most 1000 line edits and 20000 lines per side, otherwise the remainder is one edit), and strip each differing run's own common prefix and suffix — and only those edits take the change's or snapshot's origin; the rest keeps its origin. Text inserted by an undo or redo change that equals text removed earlier from the same file (the newest of the last 64 removals per file) regains the origins it had when removed; otherwise it is `undo-redo`. Provenance never affects the verdict.

## 8. Recovery

A writer that reopens a log after a crash MUST find the longest prefix of complete, valid blocks (all §3 checks pass), move the remainder to quarantine, truncate the file to that prefix, and append

```
RECOVERY { lostBytes, quarantineHash = SHA-256(remainder), atOffset = prefix length }
```

before the next SESSION_START. Only framing damage is recoverable; a damaged header block is not.

## 9. Verification

A verifier MUST NOT throw on any input. It reports **findings** `{ stage, severity, code, message, seq?, offset? }` with severity `pass`, `info`, `warn` or `fail`, and a verdict:

| Verdict | Condition |
|---|---|
| INTACT | no `fail`, no `warn` |
| INTACT_WITH_WARNINGS | no `fail`, at least one `warn` |
| NOT_INTACT | at least one `fail` |

Stages, in order:

1. **parse**: §2–§5. Any error is a `fail` with the error code and stops verification.
2. **chain**: `s` MUST equal the record's index (SEQ_GAP), `p` MUST link (CHAIN_BROKEN, reported at the first record whose link fails), and record 0 MUST be SESSION_START (FIRST_RECORD_NOT_SESSION_START). Any failure stops verification.
3. **signatures**: every CHECKPOINT signature verifies under the active session key (BAD_SIGNATURE, fail). A SESSION_START whose key differs from the previous one is KEY_CHANGED (warn) unless announced by a KEY_ROTATION; a KEY_ROTATION is KEY_ROTATED (warn). No checkpoints at all is NO_CHECKPOINTS (warn). EDIT_BATCH records after the last checkpoint give UNCHECKPOINTED_TAIL (info).
4. **anchors**: ANCHOR_REF_INVALID (fail) when `ck` is not an earlier CHECKPOINT; ANCHOR_DIGEST_MISMATCH (fail) when `d` ≠ H(checkpoint). No anchors at all is NO_ANCHORS (warn): record times are then self-asserted. A verifier without token verification reports ANCHOR_TOKENS_NOT_VERIFIED (info) and stops this stage. Otherwise each remaining token is checked as in §6.4: ANCHOR_TOKEN_INVALID (fail), ANCHOR_TSA_UNTRUSTED (warn). Then, for every anchored checkpoint in sequence order:
   - CLOCK_INCONSISTENT (fail) when the checkpoint's `t` is more than 120 s after its existed-by time: a record cannot be written after it was timestamped.
   - ANCHOR_TIME_ORDER (warn, at most once) when its existed-by time is more than 2 s before that of an earlier checkpoint.
   - It counts as late when its earliest valid RFC 3161 time is more than 15 minutes after its `t` (Bitcoin confirmations are slow by nature and do not count); any late checkpoint gives one ANCHORED_LATE (info).

   **Coverage** is the share of EDIT_BATCH records that come before the last anchored checkpoint. Also reported: OTS_PENDING (info) when a checkpoint has a pending OpenTimestamps proof and no confirmed one; NO_VALID_ANCHORS (warn) when no checkpoint is anchored and no token is invalid; ANCHORS_OK (pass) otherwise, with ANCHOR_COVERAGE_PARTIAL (info) when coverage is below 95 %.
5. **replay**: §7, stopping at the first failure. Before applying each CHECKPOINT, the state digest and live-file count MUST equal its `state` and `files` (CHECKPOINT_STATE_MISMATCH, fail). Also reported: SESSION_NOT_CLOSED (info: a SESSION_START or RECOVERY while a session is open), RECORD_OUTSIDE_SESSION (warn: any record other than RECOVERY or KEY_ROTATION between SESSION_END and the next SESSION_START), SESSION_ID_MISMATCH (warn), CLOCK_BACKWARDS (warn: `t` decreases by more than 2 s), MONO_BACKWARDS (warn: `m` decreases within a session; at most 10 CLOCK_BACKWARDS and MONO_BACKWARDS findings in total), CLOCK_ANOMALY (warn), RECOVERED (warn), PAUSED (info), EXTERNAL_WITHOUT_SNAPSHOT (warn).
6. **submission** (when submitted files are given): each submitted path (with `\` converted to `/` and a leading `./` removed) is compared by contentHash with the live file of that path. SUBMISSION_MISMATCH and SUBMISSION_NOT_UTF8 are `fail`; UNTRACKED_SUBMITTED_FILE is `warn`; SUBMISSION_FILE_MISSING (logged but not submitted) is `info`.

Resource limits: at most 10 000 000 records and 50 000 live files.

### 9.1 What the chain does not protect

The chain detects any change to a record that has a later record linking to it. Records after the last CHECKPOINT can be removed, and the very last record can be changed, without breaking the chain. Recorders therefore write a CHECKPOINT at every SESSION_END, PAUSE and export, and anchor it, so that the unprotected tail is at most a SESSION_END. Removing records only removes evidence, which does not help the person who recorded the log.

---

## Appendix A — Changes from design.md

| Topic | design.md | This spec | Why |
|---|---|---|---|
| Maximum block size | 1 MiB | 8 MiB | A tracked file may be up to 1 MiB, and a FILE_SNAPSHOT of non-ASCII text can take up to 3 bytes per character in UTF-8, so 1 MiB blocks could not hold every legal snapshot. |
| Line-ending normalisation | CRLF and lone CR → LF | A whole run of CRs before LF is removed, then lone CR → LF | Found by property testing: with single-CR handling, text like `a\r\r\n` hashed differently after Git's CRLF → LF conversion, so an honest submission could fail to match. |
| Change tuple flags | omitted when 0 | omitted when 0, MUST be non-zero when present; LARGE set exactly above 256 KiB; UNDO/REDO and PASTE/BULK mutually exclusive | Gives every change a single valid encoding. |
| Unknown header keys | not specified | rejected | Header changes are format changes and bump `fmt`. |
| RECOVERY / KEY_ROTATION | not specified relative to sessions | allowed between sessions; RECOVERY closes a session left open by a crash | Matches what a recorder does after a crash or key loss. |
| Snapshot replacement | whole file gets the snapshot's origin | only the changed region does | Keeps typed code attributed to the student when one line changes outside the editor. |
| Change that replaces text (tool or AI rewriting a whole file) | everything inserted gets the change's origin | only the lines that really differ do (`minimalEdits`) | Copilot's apply replaced a whole file to add one line, turning the student's own code purple. |
| Undo / redo | always `undo-redo` | regains the origin the text had when removed | Undoing an AI change no longer hides the student's own code. |
| Anchor verification | §9.7 | §6.4 and §9 stage 4, with fixed tolerances (120 s ahead, 15 min late, 95 % coverage) | Makes the result reproducible across implementations. |
| RFC 3161 `certReq` | true for the first token only | always true | Every token then verifies on its own, offline, at the cost of about 2 KB per token. |
| Token parsing library | PKI.js | a small DER reader and synchronous signature checks | Keeps the viewer bundle small and the verifier synchronous; interoperability is tested against OpenSSL-made tokens. |
| Late anchors | not specified | a checkpoint written while offline is anchored when the network returns, possibly in a later session; ANCHORED_LATE is informational | Students work offline; the anchor still bounds everything before the checkpoint. |
