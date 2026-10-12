# Changelog

## 0.1.0 — Part 2: recorder (development build)

- Records text changes, saves, file operations, external changes, runs, focus and notes into `.tap/log.codelog`.
- Paste detection by clipboard comparison (the clipboard is never stored); bulk, undo, redo, multi-cursor and save-time edits are flagged.
- Signed checkpoints every 5 minutes and at every pause and session end.
- Crash recovery, a lock so one window records a folder, and a backup copy of the log.
- Commands: start, stop, pause, resume, add note, verify, show key fingerprint.
