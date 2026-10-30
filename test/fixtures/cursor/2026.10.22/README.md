# Cursor Agent 2026.10.22 captures

The header of the screen here reads `Cursor Agent` and `v2026.10.22-27dcf5f`, which names the
version. Only rules-delivery screens were added at this version.

## Captured screen

- `rules-unsent-reviewer-cursor.txt`: a reviewer seat's box holding a typed rules line, read
  `unsent`. Added in commit `9e68204b7` (floor, 2026-10-28 10:51 +0100, "up rules delivery: wait
  out a busy seat instead of reporting a read-back mismatch"), whose message says it is a real
  Cursor screen. Who captured it, when, and the launch line are not recorded: unknown. 12 lines,
  1,110 bytes as added. Read by `test/launch/rules-busy-seat.test.ts`.

## Not produced

- `idle`, `trust`, `working`, `question`, `permission`, `unsent`, `unknown`: not produced as their own frames at this version (no `unsent.txt` or `exit.txt`); the one `unsent` screen here is the rules line above, and the other shapes keep their `2026.10.16` and `2026.10.19` captures.
