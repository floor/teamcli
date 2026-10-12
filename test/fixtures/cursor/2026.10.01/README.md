# Cursor Agent 2026.10.01 terminal captures

Captured from the installed macOS `cursor-agent` CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `team-test-cursor`.
There was at most one Cursor seat at a time. The session was stopped and deleted;
the default session had eight agents before and after.

- `startup.txt` and `idle.txt`: `cursor-agent --force --sandbox disabled` in an
  already-trusted folder. No update, login, or trust dialog appeared. The first
  settled screen is the idle prompt, so both files are that screen.
- `trust.txt`: the same command in an untrusted directory. The workspace was
  closed without answering the trust question. `--trust` was not passed.
- `trust-54.txt`: `cursor-agent` with no `--force` and no `--trust`, on 2026-10-04,
  herdr 0.7.1, `pane read --source visible` (plain and ansi) of a pane created in a
  scratch session. Cursor Agent `2026.10.01-14929f9`. The pane was 54 columns by 23
  rows; zoom and resize left it that size, so there is no second width. A new empty
  git directory showed the trust dialog. Escape returned to the shell. The dialog
  was not answered. The same dialog appeared again when asked to run `ls`, and
  again when asked to offer a choice of file names; Escape each time. The shell
  launch line above the box is omitted. The directory path is replaced by
  `<untrusted-scratch-directory-place>`, the same length, so the box stays put.
- `question.txt`: `cursor-agent` with no `--force` and no `--trust`, on 2026-10-04,
  herdr 0.7.1, `pane read --source visible` (plain and ansi) of a pane created in a
  scratch session. Cursor Agent `2026.10.01-14929f9`. The pane was 54 columns by 23
  rows. Resize and zoom left it that size, and a wider terminal did not change it,
  so there is no second width. The folder was already trusted, so no trust dialog
  appeared. The request was to use the question tool to choose between two file
  names before doing anything else. The choice box was read, then Escape skipped it.
  Nothing was selected. The ansi read had the same text and no styling, so it is
  not stored. The visible frame holds no directory path, name, account, or usage
  figure, so nothing was replaced.
- `permission-plan.txt`: the same date, herdr, and pane size, on a later launch of
  `cursor-agent --sandbox disabled` with no `--force` and no `--trust`, after the
  first process was closed. The request was to switch to plan mode before doing
  anything else. The approval dialog was read while its countdown bar was full,
  then Escape rejected it. The mode switch was not approved, and no file was
  edited. The ansi read matched the plain text and had no styling, so it is not
  stored. The visible frame holds no directory path, name, account, or usage
  figure. Asking the CLI to run `ls`, to create a notes file, and to edit the
  README produced no allow/deny dialog: each action ran. The created file was
  removed and the README restored. Those shapes were not captured.
- `unsent.txt`, `working.txt`, `thinking.txt`, `rules-accepted.txt`: the same
  command in the already-trusted folder. The rules message was pasted, read back,
  and submitted. `working.txt` and `thinking.txt` coincided with herdr reporting
  `working`; the composer showed the empty follow-up placeholder and
  `ctrl+c to stop`. The only model response was `RULES_RECEIVED`. It was
  instructed to use no tools or files.
- `exit-typed.txt`, `exit.txt`: `/exit` pasted at idle, read back, then submitted.
  The suggestion menu also listed `/quit`. Herdr subsequently listed zero agents
  and the foreground process was the shell.

Paths and the session id are replaced with placeholders. Shell launch scrollback
before Cursor Agent's header is removed from idle and unsent captures. All other
visible text is retained, including wrapping and the model footer. The model was
the owner's CLI default; the profile does not select a model. These fixtures do
not assert a permission or question layout that was not observed. Unknown screens
permit no input.

No trust, login, settings, permission, or question dialog was answered, and no vendor configuration was edited.

## Round 2: the person's own box, typed and never sent

Captured from the same installed CLI on 2026-10-04 with herdr 0.7.1,
`pane read --source visible --lines 80` (plain and ansi), in the scratch session
`team-test-pc-cursor`; the pane was 53 columns by 23 rows. One Cursor seat at a
time; it was launched as a seat is launched:

`AGENT_UNATTENDED=1 cursor-agent --model grok-4.7-high --force --sandbox disabled`

`--model grok-4.7-high` was passed so the composer's status row reads as a model
the shipped profile recognizes; the owner's CLI default that day was a different
model, and a capture under it read `unknown`. The flag is capture-only; the
profile is unchanged. Text was typed into the CLI's own box and never sent: each
capture is one box, the box was cleared afterwards with ctrl+c (once clears the
whole box; it is the CLI's own key), and the session was stopped and deleted.

- `typed-two-line.txt`: `alpha typed line one` / `beta typed line two`, the second
  line typed with the CLI's newline key (ctrl+j).
- `pasted-two-line.txt`: the same shape pasted in one piece (the newline inside
  one `pane send-text`): `gamma pasted first` / `delta pasted second`. The pane
  draws it exactly as the typed one.
- `typed-glyph-second.txt`: `epsilon first line` / `→ zeta glyph second` — the
  second line begins with the CLI's own prompt glyph.
- `typed-gt-second.txt`: `eta first line` / `> theta gt second`.
- `typed-wrap.txt`: one line longer than the pane, wrapped by the CLI onto two
  more rows.
- `typed-blank-middle.txt`: `kappa first line`, a blank line, `lambda third line`.

What they prove: the CLI continues a person's line at the fourth column — the
content column, the prompt's own width — in every case, including a second line
that itself begins with `→` (which lands at the fourth column as content) and a
wrapped line. No capture draws a person's own glyph at the prompt column (the
second); only the CLI draws `  →` there, on its input row. A later row at the
prompt column is therefore a shape the captures do not show for a person's text,
and the reader fails closed on it rather than take it for the input row.

Sanitised as the captures above: the shell launch scrollback before Cursor Agent's
header is removed, and the workspace path is `<workspace>`. All other visible text
is retained. The ansi reads keep the box's painted padding — rows of trailing
spaces, trimmed to empty by the plain reads and by the readers' own line trim —
and otherwise read as the plain captures do.

No trust, login, or settings dialog was answered, and no vendor configuration was edited.

## Other models

Captured on 2026-10-05 from `cursor-agent` `2026.10.01-14929f9` with herdr 0.7.1,
`pane read --source visible`, in a scratch session started for these captures. The pane
was 54 columns by 23 rows. Each launch was one seat, in a folder that showed no trust
dialog, and was left with `/exit` after the box was read back as exactly `/exit`. The
shell scrollback before the Cursor Agent header is removed, and the workspace path is
`<workspace>`. No trust, login, permission, or question dialog appeared, and none was
answered.

- `gpt-sol-idle.txt` and `gpt-sol-unsent.txt`: `cursor-agent --model gpt-5.6-sol-high --force --sandbox disabled`. The status row read `GPT-5.6 Sol 272K High` and `Run Everything`. `alpha typed line one` was typed into the box and not sent, then the box was cleared with ctrl+c.
- `gemini-flash-idle.txt` and `gemini-flash-unsent.txt`: the same flags with `--model gemini-3.8-flash-high`. The status row read `Gemini 3.8 Flash High` and `Run Everything`. `beta typed line two` was typed and not sent.
- `composer-idle.txt` and `composer-unsent.txt`: the same flags with `--model composer-2.5`. The status row read `Composer 2.5` and `Run Everything`. `gamma typed line three` was typed and not sent.

A later launch of `cursor-agent --force --sandbox disabled` with no `--model`, after the GPT launch, showed `GPT-5.6 Sol 272K High`. The same model-less launch after the Gemini launch showed `Gemini 3.8 Flash High`.

## The rules line

- `rules-line.txt`: the one line delivery types instead of the whole message, captured
  2026-10-05 with herdr 0.7.1, `pane read --source visible --lines 200` (plain), in a
  fresh scratch session (stopped and deleted), one Cursor seat launched as a seat is
  launched, with the same model flag, in a 54-by-23 pane. The line, a neutral store
  path of the same shape, 166 characters: `Read
  /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md (sha256
  5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your
  brief.` The pane draws it in four rows; a break before a `/` hides nothing and a
  break at a space hides that one space. Read `unsent`. Typed with `pane send-text`,
  never sent, cleared with ctrl+c (once clears the whole box), the box verified empty.
  The whole-message captures above stay as documentation of why a whole paste cannot
  be proved on this CLI: past this line, the rules arrive in a file the line points at.
## The bordered box (2026-10-05)

Captured from the same installed `cursor-agent` `2026.10.01-14929f9` (the build the
fixtures above were read from) with herdr 0.7.1, `pane read --source visible --lines 80`,
in a scratch session started for these captures, in the scratch folder the Round 2
captures used. Launched as a seat is launched:

`AGENT_UNATTENDED=1 cursor-agent --model grok-4.7-high --force --sandbox disabled`

The pane was 53 columns by 23 rows. Herdr set the size from its own configuration
(`HERDR_CONFIG_PATH` pointing at a scratch `config.toml` with `mobile_width_threshold = 60`
and `sidebar_min_width`/`sidebar_max_width` 27, then `server reload-config`); herdr could
not set 120 or 173 columns or 50 rows — a split and a `pane resize` left the pane's child
tty at `23 53` (`stty size` in the pane, before the split, after the split and after the
resize) — so these frames are at the one size herdr can set for this work.

These captures draw the CLI's own border around its box — ` ▄▄…▄` directly above the
input row, ` ▀▀…▀` directly below the input rows, the status row and the workspace line
directly under it — where the 2026-10-01 captures above draw up to four empty rows above
the input row and two under the text. Both frames come from the same installed build;
the owner's CLI files are not read here, so what differs between the two capture days is
not established by these fixtures.

- `bordered-idle.txt`: the settled home screen, the `  → Plan, search, build anything`
  placeholder between the border rows.
- `bordered-typed-one.txt`, `bordered-typed-three.txt`: `alpha bordered line one`, and
  one line followed by `beta bordered line two` / `gamma bordered line three`, typed into
  the CLI's own box and never sent (the three lines in one multi-line paste, the Round 2
  pasted form). The box was cleared with ctrl+c afterwards; the cleared frame is
  byte-for-byte `bordered-idle.txt`, so it is not stored twice.
- `bordered-after-round.txt`: the one message these captures sent — `Reply with the
  single word ok.` — typed, submitted with Enter, the settled frame after the reply
  (`ok`) came back. No other message was sent.
- `bordered-working.txt`, `bordered-working-typed.txt`: during that turn — the spinner
  frame with the sent text still in the box, and `delta typed` typed after it while the
  turn ran, never sent.
- `bordered-after-exit.txt`: `/exit` sent at the settled frame; the box's rows and the
  resume line are visible, and the shell prompt is back.

Sanitised as the captures above: the shell scrollback before Cursor Agent's header is
reduced to the launch command itself (the `cd` into the scratch folder and its path
dropped; what remains wrapped at the pane's width, as the pane drew it), the workspace
path is `<workspace>`, and the resume session id is `<session>`. All other visible text
is retained.

## The background-task row (2026-10-12)

Captured from `cursor-agent` `2026.10.01-14929f9` with herdr 0.7.1, `pane read --source
visible`, in the scratch session `b2-cursor-task`. The pane was 54 columns. The folder
was trusted (`--trust --force --sandbox disabled`). A background `sleep` was started and
the turn settled: herdr reported idle, the box held only `→ Add a follow-up`, and the
row above the model line was the task count. The workspace path is `<workspace>`.

- `task-idle.txt`: one background sleep, the row `  1 task`.
- `tasks-idle.txt`: two background sleeps, the row `  2 tasks`.

## Constructed

- `working-no-spinner.txt`: constructed from `working.txt` by removing the braille spinner line. Not a capture. That line sits several lines above the prompt, so a longer tool transcript pushes it out of the 20-line window. The prompt still ends in `ctrl+c to stop`.
- `follow-up-queue-two.txt`, `follow-up-queue-hint.txt`, `follow-up-queue-one.txt`,
  `follow-up-queue-typed.txt`: transcribed by the operator on 2026-10-04 from plain
  `herdr pane read` output of a working seat, with Cursor's follow-up queue open.
  **Transcribed, not captured with styling** — no CLI was started for them. Message
  text is replaced, widths are shortened and the box borders re-padded to one width,
  and the workspace path is `<workspace>`. The three frames show a running turn (the
  spinner verb differs: `Thinking` in the first two, `Reading` in the third) with one
  or two messages queued behind it and the empty `→ Add a follow-up` placeholder on
  the prompt row; frame 2 is frame 1 after one Enter, so its box top has scrolled out
  of the read. `follow-up-queue-typed.txt` puts frame 3's one-message box (frame 1's
  spinner and status rows) over the rules message typed on the prompt row, as
  `unsent.txt` has it.

## Constructed: delivery-verification boxes

Not captures. `test/launch/cursor.test.ts` builds the post-paste box from `idle.txt`:
the placeholder row is replaced by `  → ` and the first line of the typed text, and each
later line is drawn at four columns, the continuation indent `unsent.txt` shows (the
prompt row's own width). The captured `unsent.txt` is used as it is: Cursor wrapped its
sentence at that pane's 51 columns, and the composer's `wrap` rule — continuation at
the text column, broken at a space — reads the two rows as that sentence, so the
capture's test asserts the same Enter as an unwrapped box. Only the whitespace a row
break itself stands for is normalised: the run the break was made at, or a blank line
the typed text itself has. Inside a row every character must match, runs of spaces
included, and a blank row the text does not have at that place is never part of it. The
pane also draws two empty rows of its own under the text — `unsent.txt` and
`follow-up-queue-typed.txt` show the drop between the text and the status line — and those
rows are the box's frame, not content: the profile counts them (`frame_rows: 2`), the box
read strips just those, and an empty row beyond them is a row the text does not have, so
the Enter is refused.
The tests wrap the sentence themselves at 40- and 80-column panes, and refuse a wrapped box
that holds another text, an extra row, one character changed, a collapsed space, a
blank row the text does not have, or a trailing blank row the text does not end with.

## The standing-rules message, the paste marker, and the box's limits

Captured from the same installed CLI (`2026.10.01-14929f9`) on 2026-10-05 with herdr
0.7.1, `pane read --source visible --lines 200` (plain), in a scratch session of my own
with one Cursor pane, 54 by 23 — the size `up` creates. Launched as a seat is launched,
with the model this profile reads:

`cursor-agent --model grok-4.7-high --force --sandbox disabled`

Each text was pasted in one `pane send-text` and never sent. Each box was cleared
afterwards with its own key, Ctrl+C, and the box was verified empty before the next text
was typed. The session was stopped and deleted. The standing-rules texts are what
`rulesText` renders for a sample team file (no real seat names).

- `rules-pasted.txt` / `rules-pasted-medium.txt` / `rules-pasted-short.txt`: the
  standing-rules message with seven file rules (17 lines, 1193 characters), with four
  (14 lines, 1044), and with none (10 lines, 875) — each pasted in one piece. Each came
  back as a `[Pasted text #1 +N lines]` marker row, with none of the text drawn anywhere:
  the box reads `unsent`, but no row of it is a row of the message, so delivery can never
  verify the paste. The counter in the marker is the CLI's own, one per paste; the stored
  files say `#1` because the counter is an artefact of the session, not the shape.
- `rules-threshold-800.txt` / `rules-threshold-801.txt`: single-line filler texts of 800
  and 801 characters (runs of `word`, their last words `wordx` and `w`). The 800-character
  paste is drawn as text — the box shows its last six rows, its own scroll, so the paste as
  a whole still does not read back, but none of it is hidden. The 801-character paste is
  hidden behind the marker. The budget is characters, and the boundary is exact between the
  two captures: 800 is drawn, 801 is not.
- `rules-fit-6.txt` / `rules-fit-7.txt`: six and seven short lines pasted in one piece.
  The six-line box draws the prompt glyph on the first typed row, and its rows read back
  as exactly the typed text. The seven-line box scrolls: the glyph is drawn on the second
  typed row and the first is gone, so its rows read as a text that is not the typed one
  and every check of it fails. Six is the most rows delivery may send in one paste.
- `rules-part-6-after-reply.txt`: six lines typed after a sent turn that was answered.
  The transcript above the box does not stop the read-back: the box reads `unsent` and
  its rows are exactly the typed text, which is what a second part of a split delivery
  sees.
- `rules-pasted-narrow.txt`: the seven-rule message pasted in a 27-column pane (a split
  pane whose tty was set with `stty cols 27 rows 23` before the CLI started — the
  session's panes otherwise keep a 54-column tty whatever `pane layout` reports). The
  paste is hidden behind the marker again, and the marker itself is what the narrower
  pane wraps: `[Pasted text #1 +17` and then `lines]`. At this width the CLI's footer
  reflows too — the version drops to a row of its own, so the `Grok 4.7 …` row the
  profile reads is gone and the screen reads `unknown`, not `unsent`. The fixture is
  kept for what the box shows at this width, not as an `unsent` shape.

The workspace line is replaced by `<workspace>` (in `rules-pasted-narrow.txt` it had
wrapped over two rows at 27 columns and is folded back to one); the line is not part of a
box.
