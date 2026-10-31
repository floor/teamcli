# Cursor Agent 2026.10.22 terminal captures

Captured from the installed macOS Cursor Agent (`v2026.10.22-27dcf5f`) on 2026-10-28 with
herdr `pane read --source visible --format ansi`, from a live seat pane of a team on this
machine.

- `rules-unsent-reviewer-cursor.txt`: the seat's box holding the rules line `team up` had put
  there while the resumed seat was busy on its queued drops; read `unsent`. It pins the
  busy-seat wait in `src/launch/deliver.ts` (commit 9e68204b7) and is used by
  `test/launch/rules-busy-seat.test.ts`.

## Not produced

- `idle`, `trust`, `working`, `question`, `permission`, `unknown`: not produced. Only the
  busy-seat box above was captured at `2026.10.22`; those shapes keep their `2026.10.16` and
  `2026.10.19` captures.
- `unsent` as a plain `unsent.txt`: not produced. The one unsent shape at this version is the
  rules line above; the plain draft keeps its `2026.10.16` capture.
