# TAP-CC-ONE: Code Authorship Log

Records a tamper-evident history of how your code was written, so you can show that your work is your own if a plagiarism or AI-use question ever comes up.

**Author:** Abdullah Nawaz · **License:** MIT · **Source:** [github.com/abdullahforecasts/TAP-CC-ONE](https://github.com/abdullahforecasts/TAP-CC-ONE)

> Status: 0.1.0, development build (Part 2 of the plan). Timestamps from third-party services, the log viewer and the teacher's verifier arrive in the next releases.

## How it works

1. Open a folder with code. The extension asks: **Record authorship history for this folder?** Choose **Start**.
2. Code as usual. The status bar shows `● TAP` while recording.
3. Everything is written to `.tap/log.codelog` in your folder: what you typed, pasted, undid, saved and ran, with timing. The file is binary and every record is linked to the previous one by a hash chain, and signed checkpoints are written every few minutes, so any later edit to the file is detectable.
4. Submit `.tap/log.codelog` together with your code.

Click `TAP` in the status bar for pause, resume, notes, verification and your key fingerprint.

## What is recorded

| Recorded | Not recorded |
|---|---|
| Text changes in the folder's code files, grouped every 2 seconds, with timing | Individual key presses, cursor moves, selections, scrolling, the mouse |
| Whether an insertion matched the clipboard (a paste) — the clipboard itself is never stored | The clipboard contents |
| Undo, redo, multi-cursor and save-time formatting edits | Anything outside the recorded folder |
| Saves, file creation, renames and deletions | Absolute paths, your user name, your computer's name |
| Changes made to files by other programs (as snapshots) | Network activity of any kind (this version makes no network requests) |
| Debug sessions and tasks you run, with exit codes | |
| Window focus changes (can be turned off) | |
| Pauses, and what changed while paused | |
| Your notes (`TAP: Add Note to Log`) | |
| VS Code version, editor name, operating system, and which AI-assistant extensions are enabled | |

## Commands

| Command | What it does |
|---|---|
| TAP: Start Recording This Folder | Creates `.tap/` and starts (or continues) the log |
| TAP: Stop Recording This Folder | Ends the session; the log stays in `.tap/` |
| TAP: Pause Recording / Resume Recording | Pauses are recorded; changes made while paused are marked on resume |
| TAP: Add Note to Log | Adds context, e.g. "starter code copied from the course page" |
| TAP: Verify Log Integrity | Checks the log and compares it with your files on disk |
| TAP: Show Key Fingerprint | Shows the fingerprint of this computer's signing key |

## Settings

| Setting | Default | |
|---|---|---|
| `tap.promptOnOpen` | `true` | Ask to record folders that contain code |
| `tap.include` / `tap.exclude` | code files / build and dependency folders | Copied into `.tap/config.json` when recording starts |
| `tap.maxFileSizeKB` | `1024` | Larger files are not recorded |
| `tap.record.focus` | `true` | Record window focus changes |
| `tap.classify.clipboardCheckMinChars` | `2` | Insertions this long are compared with the clipboard |
| `tap.classify.bulkMinChars` | `40` | Longer non-paste insertions are marked as bulk (completions, snippets, AI) |
| `tap.checkpoint.intervalSec` | `300` | How often a signed checkpoint is written |

## Files in `.tap/`

| File | Purpose |
|---|---|
| `log.codelog` | The log. Commit or submit it. |
| `config.json` | What is recorded in this folder (its hash is part of the log) |
| `lock` | Prevents two VS Code windows recording the same folder (ignored by git) |
| `quarantine/` | Damaged bytes cut off after a crash, kept for transparency (ignored by git) |

A backup copy of each log is kept in VS Code's extension storage and restored automatically if `.tap/log.codelog` is deleted.
