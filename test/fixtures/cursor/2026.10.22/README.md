# Cursor Agent 2026.10.22 terminal captures

`cursor-agent --version` printed `2026.10.22-27dcf5f`.

- `idle.txt`, `unsent.txt`, `working.txt`: captured by builder-4 on 2026-11-02 with
  `bun scripts/capture-cli.ts --cli cursor`, from a scratch session created for the purpose and
  stopped afterwards (herdr 0.7.1, `pane read --source visible --format ansi`), in a throwaway
  `/tmp` workspace holding a fresh `git init` and no credentials or project files. The launch
  line was `cursor-agent --force --sandbox disabled`; the fresh workspace's trust question was
  answered with the harness's default `enter` so the later screens could be taken, and its box
  stays in the visible screen above the idle composer exactly as the `2026.10.16` captures show
  it. `<workspace>` stands for the throwaway path.
- `rules-unsent-reviewer-agent.txt`: the seat's box holding the rules line `team up` had put
  there while the resumed seat was busy on its queued drops; read `unsent`. It pins the
  busy-seat wait in `src/launch/deliver.ts` (commit 9e68204b7) and is used by
  `test/launch/rules-busy-seat.test.ts`. Captured from the installed macOS Cursor Agent
  (`v2026.10.22-27dcf5f`) on 2026-10-28 with herdr `pane read --source visible --format ansi`,
  from a live seat pane of a team on this machine.

## Captured screens

- `idle.txt`: the `Cursor Agent` / `v2026.10.22-27dcf5f` header, the tip row, the box holding
  `→ Plan, search, build anything` with the highlighted `P` in the placeholder, the status row
  `Gemini 4 Argon High` followed by `Run Everything`, and the workspace line ending `· main`.
  It reads as `idle`.
- `unsent.txt`: `Fix the failing test` typed into the box and never sent, drawn in the modified
  background. It reads as `unsent`, and the composer holds the probe text.
- `working.txt`: `Write a 300-word explanation of how a for loop works in any programming
  language.` sent, with the spinner and `Working` under the prompt box and
  `→ Add a follow-up   ctrl+c to stop` on the prompt row. It reads as `working`.
- `idle-after-edit.txt`: the bordered composer frame after a turn that edited a file, with
  `· 1 file edited` on the status row — the pane's singular count for a single changed file.
  Transcribed from a captured pane and sanitized: the transcript above the frame is synthetic
  and the workspace line is written as `<workspace>`; every frame row keeps the capture's own
  width (border rows 150 columns, the status row 149). It reads as `idle`, and it pins the
  singular and plural edited-file counts on every family (test/launch/cursor.test.ts).
- `drawing.txt` and `drawing-settled.txt`: not new captures. Each is `unsent.txt` with the
  draft replaced. `drawing.txt` holds `Read`, a row still rendering. `drawing-settled.txt`
  holds `Read /t/mail/abc and do that.`, the same row after it has stopped changing. They pin
  that Enter waits for two equal reads of the settled row.

## Not produced

- `trust`, `question`, `permission`, `unknown` (exit): not produced at `2026.10.22`; those
  shapes keep their `2026.10.16` captures. The trust question itself was drawn in this throwaway
  and is visible in `idle.txt` and `unsent.txt`, but no separate `trust.txt` was taken.
