# TAP-CC-ONE: Code Authorship Log

Records a tamper-evident history of how your code was written, so you can show that your work is your own if a plagiarism or AI-use question ever comes up.

**Author:** Abdullah Nawaz · **License:** PolyForm Noncommercial 1.0.0 (commercial use by agreement) · **Source:** [github.com/abdullahforecasts/TAP-CC-ONE](https://github.com/abdullahforecasts/TAP-CC-ONE)

> Status: 0.3.0, development build (Part 4 of the plan). The teacher's batch checker arrives in the next release.

## How it works

1. Open a folder with code. The extension asks: **Record authorship history for this folder?** Choose **Start**.
2. Code as usual. The status bar shows `● TAP` while recording.
3. Everything is written to `.tap/log.codelog` in your folder: what you typed, pasted, undid, saved and ran, with timing. The file is binary and every record is linked to the previous one by a hash chain, and signed checkpoints are written every few minutes, so any later edit to the file is detectable.
4. Every 10 minutes while you work, and whenever you pause, stop or export, the newest checkpoint is timestamped by independent services (see below), which proves the work existed at that time.
5. When you are done, run **TAP: Export for Submission**. It saves one `.zip` with your code, the log and a `HOW-TO-VERIFY.txt` for the reader. Submit that zip.

Click `TAP` in the status bar for the log viewer, pause, resume, notes, verification and your key fingerprint.

## Viewing your log

**TAP: View Log** opens your log inside VS Code, read-only:

- **Save History**: every save of every file, newest first, like local version control: what changed (line diff), whether you ran the code and the result, how long you worked since the previous save, and how the new code arrived (typed, pasted, copied from another file of yours, inserted by a tool). **Replay** plays back exactly that stretch of work.
- **Replay**: any file's whole history with a scrubber, 1× to 64× speed and "skip idle time". Pasted and inserted text is highlighted.
- **Timeline**, **Composition** (how the final code arrived, per file), **Events** (pastes, runs, notes, outside changes…) and **About this log** (log ID, key fingerprint, editor versions, AI-assist extensions, settings that weaken the evidence).

The checklist at the top shows whether the log is intact, whether it matches the files in your folder, and how much of the work is covered by independent timestamps. The viewer updates while you work.

**TAP: Open Log File or Submission...** opens someone else's export (the `.zip`, or a `.codelog` file) in the same viewer and compares the log with the code in the zip. Right-click a `.zip` or `.codelog` in the Explorer for the same command.

## Independent timestamps

Times written by your own computer can be changed by changing its clock. So TAP-CC-ONE asks outside services to timestamp each checkpoint:

- two **RFC 3161 time-stamp authorities** per round, in turn: FreeTSA, DigiCert and Sectigo. Each returns a signed token saying "this fingerprint existed at this time".
- one **OpenTimestamps** calendar, whose proof is later anchored in a Bitcoin block (the proof is completed the next time you open the folder, a few hours later).

**Only a 32-byte fingerprint (a SHA-256 hash) of the log is sent. Your code, file names and anything else never leave your computer.** The fingerprint cannot be turned back into your code.

**Offline?** Nothing is lost. Requests wait in a queue (kept across restarts, for up to 14 days) and are sent when you are back online; the status bar shows `⧗3` for three waiting timestamps. A timestamp obtained later still proves that everything before that checkpoint existed by then. Before exporting, connect to the internet if you can: the export waits up to 30 seconds for a final timestamp.

Turning timestamps off (`tap.anchoring.enabled`) is allowed but is shown to the reader in the log.

## What is recorded

| Recorded | Not recorded |
|---|---|
| Text changes in the folder's code files, grouped every 2 seconds, with timing | Individual key presses, cursor moves, selections, scrolling, the mouse |
| Whether an insertion matched the clipboard (a paste); the clipboard itself is never stored | The clipboard contents |
| Undo, redo, multi-cursor and save-time formatting edits | Anything outside the recorded folder |
| Saves, file creation, renames and deletions | Absolute paths, your user name, your computer's name |
| Changes made to files by other programs (as snapshots) | Other programs, browser tabs, websites you visit |
| Debug sessions and tasks you run, with exit codes | Terminal output, and anything you type into a running program |
| Commands you run in VS Code's terminal (full command line, passwords and tokens masked), with exit codes | |
| Timestamp tokens from the services above | |
| Window focus changes (can be turned off) | |
| Pauses, and what changed while paused | |
| Your notes (`TAP: Add Note to Log`) | |
| VS Code version, editor name, operating system, and which AI-assistant extensions are enabled | |

## Commands

| Command | What it does |
|---|---|
| TAP: View Log (Save History & Replay) | Opens the log viewer |
| TAP: Start Recording This Folder | Creates `.tap/` and starts (or continues) the log |
| TAP: Stop Recording This Folder | Ends the session; the log stays in `.tap/` |
| TAP: Pause Recording / Resume Recording | Pauses are recorded; changes made while paused are marked on resume |
| TAP: Add Note to Log | Adds context, e.g. "starter code copied from the course page" |
| TAP: Verify Log Integrity | Checks the log and compares it with the files in your folder (including unsaved changes) |
| TAP: Show Key Fingerprint | Shows the fingerprint of this computer's signing key |
| TAP: Timestamp Now | Timestamps the newest checkpoint right away |
| TAP: Export for Submission | Saves a `.zip` with the code, the log and `HOW-TO-VERIFY.txt` |
| TAP: Open Log File or Submission... | Opens an exported `.zip` or a `.codelog` read-only in the viewer |

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
| `tap.record.terminalCommands` | `true` | Record terminal commands (needs terminal shell integration) |
| `tap.anchoring.enabled` | `true` | Timestamp checkpoints with independent services |
| `tap.anchoring.intervalSec` | `600` | How often the newest checkpoint is timestamped while you work |
| `tap.anchoring.tsa` / `tap.anchoring.ots` | FreeTSA, DigiCert, Sectigo / three public calendars | Which services to use |

## Files in `.tap/`

| File | Purpose |
|---|---|
| `log.codelog` | The log. Commit or submit it. |
| `config.json` | What is recorded in this folder (its hash is part of the log) |
| `lock` | Prevents two VS Code windows recording the same folder (ignored by git) |
| `quarantine/` | Damaged bytes cut off after a crash, kept for transparency (ignored by git) |

A backup copy of each log is kept in VS Code's extension storage and restored automatically if `.tap/log.codelog` is deleted. The queue of waiting timestamps is kept there too.
