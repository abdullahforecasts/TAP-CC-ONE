# TAP-CC-ONE: Code Authorship Log

Records a tamper-evident history of how your code was written, so you can show that your work is your own if a plagiarism or AI-use question ever comes up.

**Author:** Abdullah Nawaz · **License:** PolyForm Noncommercial 1.0.0 (commercial use by agreement) · **Source:** [github.com/abdullahforecasts/TAP-CC-ONE](https://github.com/abdullahforecasts/TAP-CC-ONE)

> Status: 0.3.5, development build (Part 4 of the plan, with the fixes from the first classroom test). The teacher's batch checker arrives in the next release.

## How it works

1. Open a folder with code. The extension asks: **Record authorship history for this folder?** Choose **Start**. The first time, it asks for the mode: **Exam mode** (preselected: AI features and code suggestions off, TAP settings locked) or **Practice mode** (nothing changed; the log records when AI was available). The mode is written in the log and shown in the status bar (`● TAP · Exam`).
2. Code as usual. The status bar shows `● TAP` while recording.
3. Everything is written to `.tap/log.codelog` in your folder: what you typed, pasted, undid, saved and ran, with timing. The file is binary and every record is linked to the previous one by a hash chain, and signed checkpoints are written every few minutes, so any later edit to the file is detectable.
4. Every 10 minutes while you work, and whenever you pause, stop or export, the newest checkpoint is timestamped by independent services (see below), which proves the work existed at that time.
5. When you are done, run **TAP: Export for Submission**. It saves one `.zip` with your code, the log, any images, PDFs and other files from the folder (under `attachments/`) and a `HOW-TO-VERIFY.txt` for the reader. Submit that zip.

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
| The names of files, web pages and terminals open in VS Code outside the folder | Their contents and full paths |
| Images, PDFs and other files in the folder that are not code: name, size, SHA-256, when they were added, changed, deleted or shown | Their content (it goes into the export's `attachments/` instead) |
| Debug sessions and tasks you run, with exit codes | Anything you type into a running program |
| Commands you run in VS Code's terminal (full command line, passwords and tokens masked), with exit codes and output (at most 64 000 characters per command) | |
| Timestamp tokens from the services above | |
| Window focus changes (can be turned off) | |
| Pauses, and what changed while paused | |
| Your notes (`TAP: Add Note to Log`) | |
| VS Code version, editor name, operating system, which AI-assistant extensions are enabled, whether AI features were on or off, and your answer to the AI question | |
| The TAP settings in effect, and every change to them | |
| Suggestion settings, and how many snippets and text-typing keybindings you have (not their contents) | |

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
| TAP: Choose Recording Mode (Exam / Practice) | Switches the mode; the switch is written in the log |

## Settings

| Setting | Default | |
|---|---|---|
| `tap.promptOnOpen` | `true` | Ask to record folders that contain code |
| `tap.include` / `tap.exclude` | code files / build and dependency folders | Copied into `.tap/config.json` when recording starts |
| `tap.maxFileSizeKB` | `1024` | Larger files are not recorded |
| `tap.record.focus` | `true` | Record window focus changes |
| `tap.classify.clipboardCheckMinChars` | `2` | Insertions this long are compared with the clipboard (1–2) |
| `tap.classify.bulkMinChars` | `40` | Longer non-paste insertions are marked as bulk (2–40; the verifier also applies 40 itself) |
| `tap.checkpoint.intervalSec` | `300` | How often a signed checkpoint is written (60–600) |
| `tap.record.terminalCommands` | `true` | Record terminal commands and their output (needs terminal shell integration) |
| `tap.anchoring.enabled` | `true` | Timestamp checkpoints with independent services |
| `tap.anchoring.intervalSec` | `600` | How often the newest checkpoint is timestamped while you work (120–900) |
| `tap.anchoring.tsa` / `tap.anchoring.ots` | FreeTSA, DigiCert, Sectigo / three public calendars | Which services to use |
| `tap.checkForUpdates` | `true` | Check once a day for a newer release |
| `tap.defaultMode` | `ask` | Mode for a folder recorded for the first time: `ask`, `exam` or `practice` |

The settings in effect are written in the log when recording starts, and every change is recorded. Values outside the ranges above are ignored, and the attempt is recorded.

### Modes

**Exam mode** (the default) writes these settings for the folder: AI features off (`chat.disableAIFeatures`, inline suggestions, Copilot), word, snippet and tab-completion suggestions off, terminal shell integration on, and `.tap` hidden in the Explorer. Some editors accept the AI setting only in the user settings; TAP then sets it there and puts it back when recording stops. The TAP settings are locked to their defaults.

Exam mode also turns off AI extensions (Kilo Code, Cline, Continue, Codeium…) and extensions with a terminal of their own, through VS Code's `extensions.allowed` user setting (VS Code 1.96 or newer); VS Code asks for a window reload to stop them. They are turned back on when recording stops or in practice mode. Language support (C/C++, Python, Java…) stays on. VS Code's own suggestion list (after `.` or `->`) stays on too; what it inserts is shown as "completion" in the replay. **Practice mode** puts back what exam mode changed. Whatever the mode, the log records when AI was actually available.

### Teacher policy

Start recording the starter folder once so `.tap/config.json` is created, stop, add a `policy` to that file, and hand the folder out (without `.tap/log.codelog`):

```json
"policy": { "ai": "off", "suggestions": "off", "lockSettings": true, "requireShellIntegration": true }
```

| Key | Values | |
|---|---|---|
| `ai` | `ask` (default), `off`, `on` | `off`: exam mode (AI features off); otherwise practice mode. Students cannot switch the mode of a folder with a policy |
| `suggestions` | `on` (default), `off` | `off` turns word-based, snippet and tab-completion suggestions off for the folder |
| `lockSettings` | `false` (default), `true` | The recorder ignores the student's TAP settings and uses the defaults |
| `requireShellIntegration` | `false` (default), `true` | Turns terminal shell integration on so commands and output can be recorded |
| `extensions` | `block-ai` (default), `allowlist` | With `ai: off`: `allowlist` turns off every extension except TAP-CC-ONE and `allowExtensions` |
| `allowExtensions` | list of extension ids | Never turned off, e.g. `["ms-vscode.cpptools", "ms-python.python"]` |

The config file's hash is in every session of the log, so a changed policy is visible.

## Files in `.tap/`

| File | Purpose |
|---|---|
| `log.codelog` | The log. Commit or submit it. |
| `config.json` | What is recorded in this folder (its hash is part of the log) |

Anything else written in `.tap` is not recorded as code. TAP-CC-ONE notes it in the log, ships it in the export, and offers to move it into the folder.
| `lock` | Prevents two VS Code windows recording the same folder (ignored by git) |
| `quarantine/` | Damaged bytes cut off after a crash, kept for transparency (ignored by git) |

A backup copy of each log is kept in VS Code's extension storage and restored automatically if `.tap/log.codelog` is deleted. The queue of waiting timestamps is kept there too.
