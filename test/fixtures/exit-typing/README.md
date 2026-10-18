# Exit-typing captures, three CLIs

What `team down` and `team remove` see between typing an exit text and the Enter, captured on
2026-10-06 to prove `typeExit` (src/commands/down.ts) against real screens.

Captured with herdr 0.7.1, `pane read <pane> --source visible --lines 200 --format ansi` — the
call and window `down`'s own screen reader makes (`paneRead(pane, 200, session)`), CRLF folded to
LF as `paneRead` returns it — from *plain* `claude` (Claude Code 2.1.291), `codex` (0.160.0) and
`cursor-agent` (2026.10.01-14929f9), no vendor launcher, each in its own pane of a scratch
project in a scratch herdr session of mine. The panes were the captures' own; no other seat was
read or typed into. No text was swapped for neutral words — the scratch project path and the
model name the scratch seat ran under are as the CLI drew them — so every byte, SGR included, is
the capture's own.

Each CLI has the same pair, and the pair is the point: `pane send-text <pane> /exit` returns
before the pane draws what it sent, so the reading taken the instant after the send is still the
idle screen with its placeholder — the text is not drawn yet — and the reading taken about two
seconds later is the box holding exactly `/exit` with the slash menu open over it. `typeExit`
reads the box between the send and the Enter and only presses Enter on the second reading.

- `claude-code-idle-ansi.txt`: Claude Code at an empty, idle box, the reading the instant after
  `/exit` was sent. The placeholder is faint; the box is empty. Reads `idle`.
- `claude-code-unsent-ansi.txt`: the same pane about two seconds later. The box holds exactly
  `/exit`, the slash menu open above it. Reads `unsent`, and the box reads back as the typed text.
- `codex-idle-ansi.txt`: Codex at an empty, idle box, the instant after the send; its placeholder
  is `Ask Codex to do anything`. Reads `idle`.
- `codex-unsent-ansi.txt`: the same pane later. The box holds exactly `/exit` with the command
  menu's own `exit Codex` row above it. Reads `unsent`, box exactly the text.
- `cursor-idle-ansi.txt`: cursor-agent at an empty, idle box, the instant after the send; its
  placeholder is `Plan, search, build anything`. Reads `idle`.
- `cursor-unsent-ansi.txt`: the same pane later. The box holds exactly `/exit` with the slash
  menu's `→ /exit  Exit` rows below it. Reads `unsent`, box exactly the text.
- `claude-code-other-text-ansi.txt`: Claude Code's box holding `/exit now` — a command word plus
  an argument. Reads `unsent`, but the box does not read back as `/exit`: this is the screen the
  Enter must never go to, and the first row that differs is `/exit now`. Captured the same way,
  in the same pane as the pair above (its previous text cleared with the profile's `ctrl+c`).

## A seat with background work

Both screens are from a Claude Code seat that had run a background shell (`sleep 600` through the
Bash tool's background shell) and stayed at its prompt; the CLI's own status line says
`1 shell still running`, on the row the spinner ended on and again in the footer. A stop must
still read and type this box the same way, and the slash menu at the second reading is where an
Enter would land.

- `claude-code-shell-idle-ansi.txt`: the seat's idle box with the background shell running, the
  reading the instant after `/exit` was sent. Reads `idle`.
- `claude-code-shell-unsent-ansi.txt`: the same pane later, box exactly `/exit`, slash menu open,
  `1 shell still running` still over it. Reads `unsent`, box exactly the text.

A second pair is from a seat holding a scheduled task instead (made in-seat, `CronCreate`), so the
same two readings exist for a seat whose background work is not a shell. The task's own text is
in the screen above the box.

- `claude-code-scheduled-idle-ansi.txt`: that seat's idle box, the instant after the send. Reads
  `idle`.
- `claude-code-scheduled-unsent-ansi.txt`: the same pane later, box exactly `/exit`, slash menu
  open. Reads `unsent`, box exactly the text.

## The CLI's own question after the Enter

Both of these are what the pane shows about two seconds after the one Enter `typeExit` presses —
the seat did not exit. Asked to exit with background work outstanding, Claude Code answers with a
question of its own:

    Background work is running
    The following will stop when you exit:

    scheduled   · Runs once in 19m · Remind the user: time to stretch your legs — get
    task          …

    ❯ 1. Exit and stop tasks
      2. Stay

    Enter to confirm · Esc to cancel

`1. Exit and stop tasks` is preselected, so one more Enter confirms it and the CLI then exits —
the seat was back at its shell and out of herdr's agent list a moment later. The one Enter
`typeExit` presses does not answer this question, so a seat holding background work stays on this
screen and the `gone` step that follows can only run out its exit wait: the captures are here so
that reading is tested against the real screen. Both captured screens read `exit question` —
never `idle`, never `unsent` — so nothing that reads the screen would type into them, and the
kind is kept apart from the ordinary `question`, which no stop may ever answer. The profile
names both halves of the answer for this CLI: the stage this screen is read from
(`screen.exit_question`) and the one key that confirms it (`exit_confirm: enter`, beside the
screens' evidence in src/profiles/claude-code.yaml). The stage reads the dialog as one block of
rows — the title down to the footer as the screen's last line — and admits only the forms below,
whole; a screen that is not one of them reads as the ordinary question it looks like, and the
comment beside the rule says why. Nothing but a stop presses that key.

What the other two CLIs do with background work, from their own runs of 2026-10-06 in the same
scratch session: Codex 0.160.0 asks nothing. With a backgrounded shell running, one Enter on
`/exit` put its pane back at its shell, herdr listing no agent for it, and its exit printed only
advice — "Stop the current turn: run codex agents, select this task, and press x." — so its
profile declares no `exit_confirm`: there is no question to confirm. cursor-agent
2026.10.01-14929f9 was not observed: its run never got past the CLI's own permission dialogs for
the backgrounding command ("Run this command? Not in allowlist: disown, echo, sleep", then for
`ps`), so no exit question with background work ever reached its pane; its `/exit` pair is the
one captured above, and its profile declares no `exit_confirm` either — from no run, not from a
run that found none.

- `claude-code-scheduled-question-ansi.txt`: the seat whose background work is the scheduled task
  above, the question listing it (`scheduled task · Runs once in 19m`).
- `claude-code-shell-question-ansi.txt`: the seat whose background work is the background shell,
  the same question listing `shell · sleep 600`.

### The three-choice form

The CLI draws this question in two forms. When the session is one the CLI can move into the
background, the list gains a choice between the marked one and `Stay`:

    Background work is running
    The following will stop when you exit:

    shell · sleep 600

    ❯ 1. Exit and stop tasks
      2. Move to background and exit
      3. Stay

    Enter to confirm · Esc to cancel

The preselected marker is still on `1. Exit and stop tasks`, the row the one Enter confirms. The
added value, `Move to background and exit`, is never what a stop confirms, and the profile
carries no key that could land on it.

- `claude-code-shell-move-question.txt`: the release run's own capture of this form, taken
  2026-10-06T21:37:29Z from its Claude pane after a `team down` of a seat holding a background
  shell, with `pane read <pane> --format text --lines 80` — that run's proof output, copied
  byte for byte. Before the rule admitted this
  tail it read `question`, so the stop sent nothing and left the seat on this dialog. Reads
  `exit question`.
- `claude-code-shell-scheduled-move-question-ansi.txt`: my own scratch capture of the same form,
  taken the same way as the pair above (herdr 0.7.1 `pane read`, `--format ansi`), from a seat
  holding both kinds of background work at once — a background shell (`sleep 600`) and a
  scheduled task (`Every day at 3:00 AM`). The item rows follow the work: `shell · sleep 600`,
  and the scheduled task's label wrapped onto its own `task` continuation row. The pane ran
  Claude Code 2.1.292 and was created with the child-session marker the CLI's own warning names
  cleared (`--env CLAUDE_CODE_CHILD_SESSION=`): the panes that inherited that marker drew only
  the two-choice form above, which is why this capture needed a fresh full-height pane. Reads
  `exit question`.
- `claude-code-shell-scheduled-move-question-clipped-ansi.txt`: the same pane's dialog under a
  smaller layout. A pane too short for the item list draws the same dialog clipped by the CLI's
  own row budget — one item row, its `… +1 item` row, the marked choice and the footer, no other
  choice at all. The marked row is still the preselected `1. Exit and stop tasks`, so this is the
  first form clipped, not another dialog. Reads `exit question`.

## Constructed boundary screens

The exit question's stage reads three phrases, and prose quoting them above a live box must not
be read as the CLI's dialog: a rule matching them anywhere read an ordinary question as an exit
question, and a later stop would have sent its Enter into it. The screens below pin that
boundary: the first three quote the dialog's lines above a live question, and the rest carry
rows no run has drawn, or the form's own rows in an order no form draws. None is a capture; each
names the file it was built from.

- `claude-code-exit-lines-quoted-question.txt`: constructed from
  `claude-code/2.1.289/question-plain.txt`. The exit question's two lines
  (`Background work is running`, `❯ 1. Exit and stop tasks`) are quoted in the transcript
  directly above the box's first rule — the box's own title, choices and rule lines are the
  capture's — and the footer is the common `Enter to confirm · Esc to cancel`. Reads `question`;
  before the stage read the dialog's own frame the three phrases matched anywhere and this read
  `exit question`.
- `claude-code-exit-lines-quoted-no-rule-question.txt`: constructed from the ordinary-question
  shape `test/screen-core.test.ts` pins for a question whose composer rule has scrolled out,
  with the same two quoted lines and that same shared footer quoted above it, the live title,
  `❯ 1. main` / `2. next` choices and footer below. A rule reading the three phrases anywhere
  still read this `exit question`; what tells it apart is the frame below the quoted choice
  row, where the live question draws rows that are no part of the exit dialog. With the stage's
  frame reads — the `❯` marker on the choice row itself, the footer as the window's last
  non-blank line, and `only_after`, which admits nothing under the choice row but the dialog's
  own `2. Stay` and that footer — a quote whose block has any other row below it is not the
  live dialog, and this reads `question`.
- `claude-code-exit-question-below-quote.txt`: constructed from
  `exit-typing/claude-code-shell-question-ansi.txt`, whose last 17 lines (the `▔` bar down to
  the footer) are kept byte for byte, with a three-line transcript quoting the same two lines
  placed above them. The real dialog sits below a quoting transcript and still reads
  `exit question`: the rule reads the bottom dialog's own choice row and footer, not the quote.
- `claude-code-exit-question-other-second-row.txt`: constructed from the release run's capture
  (`claude-code-shell-move-question.txt`) with its middle row renamed to `2. Delete everything
  and exit` — a second row no run has drawn. Each form names the second row it draws (`2. Stay`,
  or `2. Move to background and exit` with its `3. Stay`), and a tail whose second row is
  anything else is not this dialog. Reads `question`.
- `claude-code-exit-question-move-without-stay.txt`: the same capture with its `3. Stay` row
  removed. The move row with no last `Stay` under it is a tail neither form draws — and the
  choice a stop must never confirm. Reads `question`.
- `claude-code-exit-question-marker-on-move.txt`: the same capture with the marker moved to
  `2. Move to background and exit`, row 1 left unmarked. The reader takes the marker as the row
  the confirming key acts on; a stop means stop, so a screen whose selection sits on the move
  row is not the screen whose key this program may send. Reads `question`.
- `claude-code-exit-question-move-above-marked.txt`: the same capture with its
  `2. Move to background and exit` row lifted above the marked `❯ 1. Exit and stop tasks`, only
  `3. Stay` left under the mark — the form's own rows in an order no form draws. Every row of it
  is a row some form draws, so the reader that checked the rows one at a time read it
  `exit question`; with the block read (`### One block, from the title to the footer` below) it
  reads `question`.

### Whole rows, in the form's order (the reviewer's MUST-FIX on 81ae276)

*The eight screens below stay; what reads them is the block at the end of this file, and they read
the same `question` there (each is also pinned by its own case in `test/exit-typing.test.ts`).*

The choice rows were anchored at their start only (`\b`), so a row that began like a form's row
and continued with anything at all still read as this dialog: the reviewer drove `typeExit`
against `3. Stay — but leave tasks running` and got the confirming Enter (`['enter', 'enter']`).
Every row of a form — the marked first row, the second row of each form, the third row and the
footer — is now anchored at both ends: the row, after its frame indentation, equals the captured
text and nothing follows on it. The eight screens below are the captured dialog with one row
given a suffix (seven) or with two rows swapped (one), built from the release run's capture
(byte for byte, as the negatives above) and its two-choice tail; each reads `question`, and on
the unfixed profile and engine six of them read `exit question` (the two footers, whose
comparison was already whole-row, are the exception).

- `claude-code-exit-question-stay-marked-suffix.txt`: `❯ 1. Exit and stop tasks and keep
  everything`.
- `claude-code-exit-question-stay-second-suffix.txt`: `2. Stay and delete work`.
- `claude-code-exit-question-stay-footer-suffix.txt`: `Enter to confirm · Esc to cancel now`.
- `claude-code-exit-question-move-marked-suffix.txt`: the marked row of the three-choice form
  with the same suffix.
- `claude-code-exit-question-move-second-suffix.txt`: `2. Move to background and exit and keep
  tasks`.
- `claude-code-exit-question-move-third-suffix.txt`: `3. Stay — but leave tasks running`.
- `claude-code-exit-question-move-footer-suffix.txt`: the footer with the same suffix.
- `claude-code-exit-question-swapped-tail.txt`: the three-choice tail with its last two rows
  swapped — the dialog's own rows in an order no form draws. `only_after` reads the tail's rows
  in the order the patterns name, so this reads `question`; with the rows read in any order it
  read `exit question`.

### One block, from the title to the footer (the reviewer's MUST-FIX on f65b95b)

Rules that read a screen row by row — this row anywhere, that row in this order — admit a frame
whose rows were each drawn by some form but stand in no form's order, and three review rounds
each found another such frame between the rules. The dialog is now read as one block instead: from
the last `Background work is running` the window draws down to the screen's last non-blank line,
every row the block draws is that row, whole, after the frame's own indentation, and the block is
the one the captured forms describe. Anything else — a row added, changed, dropped,
doubled, moved, or another dialog's row under the footer — is a step no path of the block takes,
and the screen reads as the ordinary question it looks like. The profile carries the block
(`screen.exit_question` in src/profiles/claude-code.yaml); the reader is in
src/watch/screen-core.ts, and the stage's own comment says why.

The reviewer's frame for it is `claude-code-exit-question-move-above-marked.txt` (the bullet
above): the release run's capture with its `2. Move to background and exit` row lifted above the
marked `❯ 1. Exit and stop tasks`, only `3. Stay` left under the mark. Every row of that screen
is a row some form draws, in an order no form draws, so a reader that checks the rows one at a
time accepts it — read on `f65b95b`, the pushed head before the block, it is `exit question`, and
a stop's confirming Enter would have gone into a frame no run has drawn. With the block it is
`question`.

The sweep in `test/exit-typing.test.ts` is generated rather than named: each real capture's dialog
is changed one row at a time — a row dropped, a row doubled, two rows under each other swapped,
a row given a suffix — and every change must read as the ordinary question it looks like, with
four named exceptions, each a screen that is still this dialog: a row of the CLI's own work list
changed (its text is the CLI's to fill; the marked row and the tail are untouched), the only
choice row dropped (what is left *is* the clipped form the captures show, marked row and footer
intact), the
first row doubled (a copy above the block is a transcript, the dialog under it is whole — the same
reading as `claude-code-exit-question-below-quote.txt`), and the footer dropped (no line carries a
footer at all, so the screen reads `unknown` and nothing sends a key on it). The rows above the
block are swept too: no change to a transcript reaches the reading.
