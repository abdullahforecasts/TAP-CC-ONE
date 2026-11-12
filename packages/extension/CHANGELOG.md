# Changelog

## 0.3.5 (fixes from testing 0.3.4)

**Exam mode turns off AI and terminal extensions**

- AI extensions (Kilo Code, Cline, Roo Code, Continue, Codeium…) are not affected by VS Code's "Disable AI Features" setting. Exam mode now turns them off, and extensions that bring a terminal of their own (commands run there are not recorded), through VS Code's `extensions.allowed` user setting (VS Code 1.96 or newer). VS Code needs a window reload to stop them; TAP-CC-ONE asks for it. They are turned back on when recording stops or in practice mode.
- AI extensions are recognised from the known list and also by marketplace category ("AI", "Chat"), AI features they add (chat participants, language-model tools) and keywords, so new assistants are caught too.
- A teacher's policy can be stricter: `"extensions": "allowlist"` turns off every extension except TAP-CC-ONE and those in `"allowExtensions"`.
- An AI or terminal extension installed or enabled during an exam is turned off at once, and the student is told in a dialog.

**AI and extensions in the log**

- AI now counts as available whenever a third-party AI extension is enabled. 0.3.4 recorded "AI off" in exam mode although Kilo Code was running; the verifier now reads older logs this way too.
- Every installed extension is listed when recording starts, and any added during a session is reported (AI_EXTENSION_ADDED, TERMINAL_EXTENSION_ADDED, EXTENSION_ADDED). The viewer's Sessions table shows the ones added later.
- AI panels shown in a tab are reported as such (AI_PANEL_SHOWN), once per panel: the "✓" and "◔" marks some extensions put in front of a tab's title no longer split one panel into several.

**Cut and paste back**

- Code that is cut (or deleted) and pasted back, in the same file or another, keeps its colours instead of becoming "pasted from outside": Ctrl+A, Ctrl+X, Ctrl+V no longer turns a whole file red. Code still found in another file stays "copied from own files", and text that was not just removed is still a paste.

**Files TAP does not record**

- Files written in TAP's own `.tap` folder, and code in build-output folders (`build/`, `out/`, `bin/`…), were silently not recorded and not exported. They are now listed in the log (UNRECORDED_CODE_FILE), shipped under `attachments/` in the export, and the student is told in a dialog with a button that moves the file into the recorded folder.
- Exam mode hides `.tap` in the Explorer.

**Warnings in the middle of the window**

- Things the student must act on are shown as a dialog in the middle of the window instead of a corner notification: a file that is not recorded, an AI or terminal extension in exam mode (with **Reload Window**), AI still on in exam mode, the first edit of a code file outside the recorded folder (once per file), and exporting a log without code edits.

## 0.3.4 (fixes from testing 0.3.3)

**Exam mode by default**

- When a folder is recorded for the first time, TAP-CC-ONE asks for the mode, with **Exam mode** preselected (also used when the question is dismissed). Exam mode turns AI features and code suggestions off for the folder, locks the TAP settings and turns terminal shell integration on. **Practice mode** changes nothing and records when AI was available.
- The status bar shows the mode (`TAP · Exam`). Switch it from the TAP menu or with **TAP: Choose Recording Mode**; the switch is written in the log, and switching to practice is shown to the reader. A teacher's policy in `.tap/config.json` decides the mode and cannot be switched.
- New setting `tap.defaultMode` (`ask`, `exam`, `practice`).

**AI really turned off**

- 0.3.3 wrote "turn off AI" only to the folder's settings; VS Code refused the AI chat setting there, so AI chat stayed on (the log did show it: AI_ON_AFTER_DECLARED_OFF). Settings are now written at the narrowest level VS Code accepts (folder, then workspace, then user for the AI settings). User-level changes are put back when recording stops or when switching to practice mode.
- If AI is still on a few seconds after exam mode starts, the student is told how to turn it off.
- Code that arrives from outside the editor while AI is available (Copilot's edit or agent mode writes files directly) is reported (OUTSIDE_CHANGE_WHILE_AI).

**Images, PDFs and other files**

- Files in the folder that are not code (images, PDFs, documents, archives, audio and video, and small text files outside the include patterns) are listed in the log with size and SHA-256: those present when recording starts, and every file added, changed or deleted. When one is open in VS Code, the time it was shown is recorded.
- **Export** ships them under `attachments/` in the zip (up to 25 MB each, 50 MB in all), and opening the zip checks them against the log.
- New findings: ASSETS_PRESENT, ASSET_ADDED (also for files added while recording was off), ASSET_VIEWED, ASSET_REMOVED, ATTACHMENT_MISMATCH, ATTACHMENT_NOT_IN_LOG, ATTACHMENT_NOT_SHIPPED. About this log lists the files.

**Replay colours**

- Undo after many small edits no longer loses the origin of the text it brings back (BSCS25040: code that came from outside showed as "brought back by undo/redo" without its colour). The undo history now keeps 512 KB of removed text per file instead of 64 pieces, and restores line by line when the editor splits the text differently.
- Editors that replace the whole file for every few characters typed (some Markdown editors) no longer make typing look like a tool or AI insert: such a change is judged by what it really changed.
- The recorder's bulk flag is no longer used; the verifier decides from the text. A suggestion that completes the word being typed counts as "completion"; 40+ characters at once is "tool / AI insert".

## 0.3.3 (fixes from the first classroom test)

**AI assistance**

- When recording starts, the student is asked whether to turn off AI features (inline suggestions and AI chat) for the folder. The answer is written in the log, and so is whether AI was actually on or off afterwards (checked every 15 seconds and on every settings or extension change). The viewer shows an "AI available" lane on the timeline and warns when AI was on after the student said it was off.
- Text inserted by the editor in one go is classified from the text itself, whatever the settings say: 3 or more non-whitespace characters at once is a **completion** (an accepted suggestion, snippet or auto-complete), 40 or more characters (20 or more over several lines) is **bulk**. Raising `tap.classify.bulkMinChars` no longer hides inserted code.
- The log lists snippet files, the number of snippets and keybindings that type text, and the suggestion settings (counts only, never the snippets).

**Terminal**

- Terminal output is recorded with each command (escape sequences removed, passwords and tokens masked, at most 64 000 characters per command). Commands run outside the recorded folder are recorded too, marked "outside the folder".
- The verifier reports code printed in the terminal that later appears in your files (TERMINAL_CODE_REUSED), and names the terminal command that ran just before a change made outside the editor.
- Terminals without shell integration (whose commands cannot be recorded) are listed in the log.

**Outside the folder**

- Files from other folders, unsaved editors, web pages inside VS Code, notebooks and terminals that are open while recording are listed in the log (names only). The status bar shows "file not recorded" and a warning appears when you edit a code file outside the recorded folder.
- Time away from the editor is summarised.
- Export warns when the log has no code edits (you probably worked in another folder) and when timestamps are still waiting (Try again / Export anyway).
- A warning appears when the recorded folder is very broad (for example your home folder).

**Settings**

- The TAP settings in effect are written at the start of every session, and every change during a session is recorded. Values that weaken the evidence are shown to the reader. Settings are limited to safe ranges (paste check 1–2 characters, bulk 2–40, checkpoints every 60–600 s, timestamps every 120–900 s); values outside them are ignored and the attempt is recorded.
- Teachers can set a policy in `.tap/config.json`: `"policy": { "ai": "off", "suggestions": "off", "lockSettings": true, "requireShellIntegration": true }`.

**Verifier and viewer**

- Replay: code that arrived from outside the editor keeps that origin when an undo in the editor brings it back.
- New findings: CLOCK_BEHIND (computer clock set behind real time, from the timestamp tokens), RECORDER_OUTDATED (log written by a recorder older than 0.3.0), SETTINGS_WEAKENED, SETTINGS_CHANGED, AI_DECLARED_OFF / AI_DECLARED_ON / AI_NOT_ANSWERED, AI_ON_AFTER_DECLARED_OFF, AI_AVAILABLE, AWAY_FROM_EDITOR, OPEN_OUTSIDE_FOLDER, TERMINAL_NOT_MONITORED, TERMINAL_OUTSIDE_FOLDER, TERMINAL_CODE_REUSED, BROAD_FOLDER. None of them changes the verdict.
- The viewer's checklist has a "How the code was written" row and a "Points to review" box; Events has an "AI, settings & outside" filter and shows terminal output.
- The extension checks once a day for a newer release and offers to open the download page (`tap.checkForUpdates`).
- The export's success message and HOW-TO-VERIFY.txt say to submit the zip exactly as it is.

## 0.3.2

- Records no longer get a smaller monotonic time than the record before them when a timestamp is written while a slower job (such as a disk check) is running. This removes the MONO_BACKWARDS warning ("monotonic time decreased within a session").
- A checkpoint timestamped late (after working offline) now counts as timestamped by the earliest timestamp of any later checkpoint, since that checkpoint's seal covers it. This removes the ANCHOR_TIME_ORDER warning and most ANCHORED_LATE notes after offline work.
- HOW-TO-VERIFY.txt names the command as it appears in VS Code ("TAP: Open Log File or Submission...").

## 0.3.1

- Timestamps that waited while offline go out within about two minutes of the network coming back: retries are at most two minutes apart (was up to 30 minutes), and all waiting requests are retried as soon as one gets through or a window is opened or reloaded.

## 0.3.0 (Part 4: independent timestamps and export, development build)

- Checkpoints are timestamped by independent services: two RFC 3161 time-stamp authorities per round (FreeTSA, DigiCert, Sectigo, in turn) and one OpenTimestamps calendar (Bitcoin). Only a 32-byte hash of the log is sent.
- Works offline: timestamp requests wait in a queue that survives restarts and are sent when the network is back. The status bar shows how many are waiting.
- A token that would not verify with the bundled root certificates is not written to the log; another authority is asked instead.
- OpenTimestamps proofs are completed (upgraded to a Bitcoin block) the next time the folder is open.
- Verification checks every token (signature, certificate chain, time) and the times in the log against them: a clock set ahead is reported as CLOCK_INCONSISTENT. The viewer shows "existed by" times in Save History, timestamps on the timeline and a table in About this log.
- **TAP: Export for Submission** saves one `.zip` with the code, the log and `HOW-TO-VERIFY.txt`, after a final timestamp.
- **TAP: Open Log File or Submission...** opens an exported `.zip` or a `.codelog` read-only and compares it with the code next to it.
- **TAP: Timestamp Now**.
- Terminal commands run in VS Code's terminal are recorded with their exit codes (passwords, tokens and keys on the command line are masked). Setting `tap.record.terminalCommands`.
- Replay: code that a tool rewrote unchanged keeps the origin it had; only the parts that really changed get the tool's colour.
- Replay: undo and redo bring text back with the origin it had, and the viewer underlines it (dashed blue) so the undo stays visible.
- Recorder: renaming a file in the Explorer no longer records a separate created file.

## 0.2.0 (Part 3: viewer, development build)

- **TAP: View Log** opens a read-only viewer: Save History with line diffs, runs and how the code arrived; replay of any file or any save interval (1×–64×, skip idle time) with origin highlighting; timeline; composition per file; events list; "About this log".
- The viewer updates while you work and compares the log with the folder's current files.
- Verify Log Integrity now compares with unsaved editor text too, and offers to open the viewer.
- Recorder: the first edit after opening or saving a file is no longer mistaken for a reload from disk; closed files are re-checked every minute and before every verification in case the file watcher missed a change; closing a file without saving is recorded as an undo.

## 0.1.0 (Part 2: recorder, development build)

- Records text changes, saves, file operations, external changes, runs, focus and notes into `.tap/log.codelog`.
- Paste detection by clipboard comparison (the clipboard is never stored); bulk, undo, redo, multi-cursor and save-time edits are flagged.
- Signed checkpoints every 5 minutes and at every pause and session end.
- Crash recovery, a lock so one window records a folder, and a backup copy of the log.
- Commands: start, stop, pause, resume, add note, verify, show key fingerprint.
