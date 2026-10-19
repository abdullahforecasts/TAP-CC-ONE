# Changelog

## Unreleased

- Replay: code that a tool rewrote unchanged keeps the origin it had; only the parts that really changed get the tool's colour.
- Replay: undo and redo bring text back with the origin it had, and the viewer underlines it (dashed blue) so the undo stays visible.
- Recorder: renaming a file in the Explorer no longer records a separate created file.

## 0.2.0 — Part 3: viewer (development build)

- **TAP: View Log** opens a read-only viewer: Save History with line diffs, runs and how the code arrived; replay of any file or any save interval (1×–64×, skip idle time) with origin highlighting; timeline; composition per file; events list; "About this log".
- The viewer updates while you work and compares the log with the folder's current files.
- Verify Log Integrity now compares with unsaved editor text too, and offers to open the viewer.
- Recorder: the first edit after opening or saving a file is no longer mistaken for a reload from disk; closed files are re-checked every minute and before every verification in case the file watcher missed a change; closing a file without saving is recorded as an undo.

## 0.1.0 — Part 2: recorder (development build)

- Records text changes, saves, file operations, external changes, runs, focus and notes into `.tap/log.codelog`.
- Paste detection by clipboard comparison (the clipboard is never stored); bulk, undo, redo, multi-cursor and save-time edits are flagged.
- Signed checkpoints every 5 minutes and at every pause and session end.
- Crash recovery, a lock so one window records a folder, and a backup copy of the log.
- Commands: start, stop, pause, resume, add note, verify, show key fingerprint.
