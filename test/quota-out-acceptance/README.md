# Quota-out acceptance fixtures (independent)

Every file here is labelled by provenance:

- **capture** — a byte-for-byte copy of a retained real pane capture already in this repository.
- **synthetic** — a frame I composed. Its layout comes from a named capture and its quota text
  comes from a 2026-10-21 field report (agy) or from a retained capture's own sentences. It is
  not, and must never be read as, a native agy/Codex/Cursor trace.
- **source-derived** — no frame; the test names the source line it pins.

| file | provenance | built from |
| --- | --- | --- |
| `agy-individual-quota.txt` | synthetic | reported frame `Individual quota reached` / `Resets in 47h31m` laid above the retained `antigravity/1.4.2/idle.txt` composer box |
| `agy-individual-quota-no-reset.txt` | synthetic | the same frame with the reset sentence removed |
| `claude-quota-history.txt` | synthetic | `claude-code/rate-limit.txt` (capture) plus the profile's own captured turn-end row shape, `^✻ .+ · done [0-9]{1,2}:[0-9]{2} [AP]M` |
| `claude-quota-in-turn-quote.txt` | synthetic | the capture's 429 sentence quoted inside a working turn, above the captured composer box |
| `codex-weekly-zero.txt` | synthetic | `codex/0.161.0/idle.txt` with its truncated `weekly 9…` row completed as `weekly 0% left` (the elision marker is dropped with it) |
| `cursor-zero.txt` | synthetic | `cursor/2026.10.01/task-idle.txt` with `· 6%` changed to `· 0%` |

`team.yaml` is `test/fixtures/example.yaml` (an existing test team) with antigravity, legacy
gemini and cursor seats added, so one report can carry every profile the task names. The
`claude-code/rate-limit.txt`, `gemini/0.64.0/rate-limit.txt` and `codex/0.157.0/idle.txt`
captures are read directly from `test/fixtures/`, never copied, so their identity stays the
repository's. Codex's `0.157.0` capture carries its retained near-cap warning (less than 25% of
the weekly limit left): a real capture of a warning that must not read as a wall.

## What `acceptance.test.ts` pins

- **send**: a positively read wall refuses (`send.refused`, exit 1) before any drop, fallback,
  `.pending` retry, socket frame or typing — including when the host still reports the seat
  working, and including a wall frame whose composer cannot be read. A quote inside a working
  turn, a wall above a finished turn (history), and a healthy idle prompt keep ordinary sends.
  An ordinary provider error keeps its existing caution.
- **status**: one canonical `blocked: quota` seat state in the human row and in JSON `rows[].seat_state`,
  with the reset as displayed — `resets at 11:00`, `resets in 47h31m`, the Gemini capture's
  `2:10 PM GMT+2` verbatim, or an explicit no-reset — and never a parsed instant or invented zone.
  Codex `weekly 0% left` and Cursor `· 0%` rows are not walls.
- **watch**: the watch types no work nudge into a walled agy pane at `idle_first`, at
  `idle_repeat`, or past the frame's named reset while the wall is still on screen; a healthy idle
  seat in the same pass is nudged as the control, and the same agy seat on its retained idle frame
  is nudged.
- **check**: the existing `stuck at a quota prompt` difference and exit 1, now reached by agy,
  with the reset form it read; a quote in a working turn and a wall above a finished turn are not
  named quota.

## Floor addition of 2026-10-22

Floor's acceptance, relayed by the orchestrator, supersedes the earlier status word: a recognised
Antigravity `Individual quota reached … Resets in <time>` line is a distinct blocked state, and
status shows `blocked: quota, resets <time>` (human row and JSON seat state); the watch stops
waking that seat until the reset. The send and check rows keep the wording already pinned; the
follow-up commit that adds this section also changes the status assertions from the earlier
`quota out` word to `blocked: quota`. Per-seat `team pause <seat>` / `team resume <seat>` are
covered in `seat-pause.test.ts`.

## Composer-less wall frames

A wall frame whose pane draws no readable composer is a wall on every surface, as it is at the
pinned source: its send is held, status carries the quota-out word and the reset, and check
reports the prompt. The no-composer rows in `acceptance.test.ts` pin all three.
