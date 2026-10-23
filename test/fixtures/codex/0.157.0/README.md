# Codex 0.157.0 terminal captures

Captured from the installed macOS Codex CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `sandbox-codex`.
There was at most one Codex seat at a time. The session was stopped and deleted;
the default session had eight agents before and after. Config and auth hashes were unchanged.

- `startup.txt`: `codex -a never -s danger-full-access --no-daemon --no-alt-screen`
  reached an update notice. Its workspace was closed without input.
- `trust.txt`: the same command with the invocation-only
  `-c check_for_update_on_startup=false`, in an untrusted worktree. The workspace
  was closed without answering the trust question.
- `trust-folder.txt`: plain `codex --no-daemon` with no other flag, on 2026-10-04,
  herdr 0.7.1; a 54 by 23 pane. The folder trust question drew before any composer —
  the folder is not inside a Git project, so the path is drawn wrapped over two rows.
  Read plain and ansi; Escape quit the question back to the shell. Nothing was
  answered.
- `trust-folder-163.txt`: the same folder trust question at 163 by 47, where the
  whole path fits on one row, on 2026-10-04, herdr 0.7.1. Read plain and ansi;
  Escape quit the question and Codex exited to the shell. Nothing was answered.
- `typed-two-lines.txt`: a two-line text typed into the composer and never sent,
  with the CLI's newline key, Ctrl+J, joining the lines. Every later line at the
  continuation column, two.
- `pasted-two-lines.txt`: a two-line text delivered in one write — the same
  multi-line paste a rules message travels by. The same continuation column.
- `second-line-glyph.txt`: a two-line text whose second line begins with the prompt
  glyph `›` — drawn at the continuation column, two, never the prompt column.
- `second-line-gt.txt`: a two-line text whose second line begins with `>` — drawn
  at the continuation column, two.
- `wrapped-line.txt`: one long line that wraps; the wrap's continuation is at
  column two.
- `blank-middle.txt`: three lines with an empty middle line; the blank row is empty
  and the third line sits at column two.
- `idle.txt`, `unsent.txt`, `working.txt`, `rules-accepted.txt`: the second command
  in an already-trusted folder. The rules message was pasted, read back, and submitted.
  `working.txt` coincided with herdr reporting `working`; the composer was empty.
  The only model response was `RULES_RECEIVED`. It was instructed to use no tools or files.
- `exit-typed.txt`, `exit.txt`: `/exit` pasted at idle, read back, then submitted.
  Herdr subsequently listed zero agents and the foreground process was `zsh`.

Paths and the session UUID are replaced with placeholders. Shell launch scrollback before
Codex's header is removed from idle and unsent captures. All other visible text is retained,
including wrapping and the configured model footer. The model was the owner's CLI default;
the profile does not select a model. These fixtures do not assert a vendor permission or
question layout that was not observed. Unknown screens permit no input.

The update-check override was for capture only, not added by the profile. It is documented in
[OpenAI's configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
No update, login, trust, or settings dialog was answered, and no vendor configuration was edited.

## Round 2

The profile now adds `--no-daemon --no-alt-screen`, matching these captures. Inline
mode preserves the readable pane composer and scrollback; a dedicated process avoids
depending on a shared daemon. This is the smaller fix: keep the observed launch mode
and fixtures instead of claiming they cover a different mode.

The repeat scratch run used `launchCommand(codex, 'codex -c check_for_update_on_startup=false', rules)`
directly: only the update-check override was supplied by the seat launch, as above.
The profile supplied every other flag. One seat verified idle, pasted rules, working,
acknowledgement and `/exit`, then its workspace and scratch session were removed.

- The repeat run also captured `startup-loading.txt`: Codex draws a composer while the
  model is still loading. That screen stays unknown until initialization finishes.
  The final run waited for the startup prompt to settle before delivery; two earlier
  attempts refused delivery during startup and were torn down without submitting a
  message. The default session remained at eight agents, with unchanged config/auth hashes.

## Round 3: the person's own box — the trust question before the composer

A repeat scratch run on 2026-10-04 (`sandbox-pc-codex`, the profile's own
`codex -a never -s danger-full-access --no-daemon --no-alt-screen`) opened on the
workspace trust question before any composer was drawn: `capture-sandbox/codex` is
not trusted, the question shows `1. Trust and continue`, and the capture rule allows
no answer that grants anything. The dialog was read plain and ansi, Escape returned
to the shell, and the session was stopped and deleted. No box was typed into,
nothing was sent, and no question was answered.

So there is still no capture of a person's own multi-line box for Codex. The
continuation shapes this folder asserts are the ones its captures show — the input
row at column 0, continuations at column 2 (`unsent.txt`), and transcript rows
`› …` also at column 0 but separated from the input row by a blank row
(`exit-typed.txt` draws its menu row at 0 with a blank between it and the typed
input row). A later row at the prompt column with no capture to explain it is a
shape the reader fails closed on rather than guesses about.

## Round 4: the folder trust question, and a person's own multi-line box

These eight captures: Codex 0.157.0, plain `codex --no-daemon` with no other flag, on
2026-10-04, herdr 0.7.1, read plain and ansi with `pane read --source visible
--lines 80`. Codex asks its folder trust question before the composer in a folder it
has not been told to trust; both `trust-folder` captures show that question, before
any composer, and nothing was answered in either — Escape quit it back to the shell.

`trust-folder.txt` (54 by 23) is the folder variant: the folder is not inside a Git
project, so the path is drawn wrapped over two rows. `trust-folder-163.txt` (163 by
47) is the same question with the whole path on one row. In the six box captures (163
by 47) a person's own text sat in the composer — a two-line text joined with the
CLI's newline key, Ctrl+J, or delivered in one write, the same multi-line paste a
rules message travels by — and was never sent; the box was cleared and read empty
again between shapes, and Codex was left running at its prompt.

Sanitising: the parent path in the two trust captures is replaced by
`<untrusted-scratch-directory-placeholder-sandbox>` — the same 49 and 55 characters,
so the two-row and one-row layouts stay put — and the header's directory in the six
box captures by `<untrusted-scratch-placeholder-folder>/codex`, the same 44
characters, so the header box stays put; the box captures' live usage figures are
replaced by `…`, as `idle.txt`'s already are. Nothing else is changed. The ansi reads
show `Folder access` bold and the path dim in the trust question, and the composer
band painted `48;2;65;69;76`, the input row's `›` bold and every later row plain, in
the box captures.

What the six box captures show: every later line of the person's text — typed,
pasted, wrapped, after a blank line, or beginning with the prompt glyph or `>` — is
drawn at the continuation column, two; none is drawn at the prompt column. This is
the typed-newline proof the fix's comment named as still to be taken, and
`src/watch/screen-core.ts` now names these fixtures where that clause stood.

## Constructed

- `lobby-constructed.txt`: a one-line file that is not a screen, so a trust-answer record cannot cite it as lobby evidence.

`owner-status.txt` is constructed, not a capture. Nothing in it was read from a live pane.
It is `idle.txt` with the status row replaced by an owner's configured status line: session
and weekly use, and the time until each resets. The row is one the shipped composer already
recognizes. Without an override pattern the line reads no figure.

## Permission dialog

- `permission.txt` was captured on 2026-10-04 in `sandbox-codex-perm`, with one
seat in a throwaway folder under an already-trusted project. The command was
`codex -a on-request -s danger-full-access --no-daemon --no-alt-screen -c check_for_update_on_startup=false`
with an initial prompt requesting approval for `ls`. No input followed launch;
the permission dialog was read, then the workspace closed without answering it.

Full-access sandboxing allowed the first attempt's `ls` without a dialog. The
successful capture used a temporary project-local `.codex/config.toml` and
`.codex/rules/capture.rules` with `prefix_rule` entries for `ls` and `/bin/ls`,
`decision="prompt"`, and justification `Permission dialog capture`, as described
in [OpenAI's rules documentation](https://learn.chatgpt.com/docs/agent-configuration/rules).
Those files and the throwaway folder were removed. These are capture-only settings;
the launch profile is unchanged. Visible text is retained, including the quota notice.

Both attempts were torn down. The scratch session was stopped and deleted, with
zero agents after workspace closure; the default session had 14 agents before and
after. No owner configuration was written by the harness. The auth hash stayed
unchanged; the config hash changed during the capture window, so this run does
not assert that the owner's configuration remained unchanged.

## Constructed: `permission-pinned.txt`

Not a capture. It is the captured dialog with the captured status line below it,
built from the files here with
`{ cat permission.txt; echo; tail -n 1 idle.txt; } > permission-pinned.txt`:
the dialog's own footer, a blank line, then `idle.txt`'s last line, the model
footer Codex keeps pinned at the pane's bottom. It stands for a permission dialog
drawn while that pinned status line stays below it — a screen the classifier read
as `unsent`, so `deliverRules` reported the rules delivered and the watch typed a
nudge and Enter onto the dialog. Nothing else is added or changed. Its tests are
in `test/launch/codex.test.ts` and `test/screen-core.test.ts`.

## Constructed: delivery-verification boxes

Not captures. `test/launch/codex.test.ts` builds the post-paste box from `idle.txt`:
the placeholder row is replaced by `› ` and the first line of the typed text, and each
later line is drawn at two columns, the prompt row's own width, matching the continuation
indent `unsent.txt` shows. A box built this way stands for the typed text as Codex draws
it, and the same tests paste into the captured `unsent.txt`, whose four rows read back as
the message the capture submitted. No captured box shows a wrapped line, so no wrap is
modelled for Codex: a box whose rows read back as runs of the typed text laid out in
order is the text and is entered, and a box whose rows show anything else — another
text, an extra row, one character changed, a collapsed space, a blank row the text does
not have at that place — is never entered. The pane draws one empty row of its own under
the text — `unsent.txt` and `exit-typed.txt` show the drop between the text and the status
line — and that row is the box's frame, not content: the profile counts it
(`frame_rows: 1`), the box read strips just it, and an empty row beyond it is a row the
text does not have, so the Enter is refused.

## Constructed: the Terra pair

Not captures. Both files are `idle.txt`'s header box, tip row and `GPT-5.6-Terra` status
row, drawn again around the box's two rows, and they differ only in the two anchors the
shipped composer reads:

- `terra-recognised-constructed.txt` keeps the `› Ask Codex to do anything` prompt row
  and the status row as the pane's last non-blank line, so the shipped anchors read it
  as they read the captured idle screen — idle, and idle in the composer.
- `terra-quiet-unknown-constructed.txt` breaks both on purpose — a `❯` prompt glyph the
  profile does not know, and a `? for shortcuts` row under the status line, so a
  status-last read cannot pin it. It reads unknown for the screen and for the composer:
  the shape of a quiet Terra seat whose anchors miss — a quiet seat the watch reports
  as the unknown attention, and one a non-owner's `remove` takes out of the team while
  leaving its pane as it is.

The pair stands for that screen without claiming to be it: a real capture replaces the
constructed rows, not the profile's reading of them. Constructed, so neither can feed
`trust-answer` (captures only).
