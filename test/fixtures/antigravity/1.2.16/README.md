# Antigravity (agy) 1.2.16 terminal captures

Captured from the installed macOS Antigravity CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `sandbox-agy`.
There was at most one Antigravity seat at a time. The session was stopped and deleted;
the default session had nine agents before and after. Config and auth hashes were unchanged.

- `trust.txt`: `AGENT_UNATTENDED=1 agy --dangerously-skip-permissions` launched in a fresh,
  untrusted temporary directory. The workspace trust prompt appeared (`Do you trust the contents
  of this project?`). The workspace was closed without answering the question.
- `trust-54.txt`: `AGENT_UNATTENDED=1 agy` without `--dangerously-skip-permissions`, in a fresh,
  untrusted throwaway directory, captured 2026-10-04 in a scratch session created for the purpose
  (closed and deleted afterwards), in a 54-column, 23-row pane. The same trust prompt appeared,
  with the model footer visible at this width. Escape was the only answer given: it exits the CLI,
  so no capture exists past this dialog from this run. The directory path is replaced with
  `<project-dir>`.
- `idle.txt`, `unsent.txt`, `working.txt`, `rules-accepted.txt`: the same launch command in
  an already-trusted folder. The rules message was pasted, read back, and submitted.
  `working.txt` coincided with the CLI showing `Generating...` and herdr reporting `working`
  with the composer empty again. The model response was `RULES_RECEIVED`.
- `exit-typed.txt`, `exit.txt`: `/exit` typed at idle, read back, then submitted.
  Herdr subsequently listed zero agents and the foreground process was `zsh`.
- `permission-command-54.txt`: `AGENT_UNATTENDED=1 agy` without `--dangerously-skip-permissions`,
  captured 2026-10-04 in a throwaway folder the owner had trusted for the purpose, in a scratch
  session created for the purpose (closed and deleted afterwards), in a 54-column, 23-row pane.
  Asked to run `ls`, the CLI showed its command permission prompt (`Requesting permission for:`
  with four numbered options). Escape dismissed it; nothing was approved.
- `permission-write-54.txt`: the same session and launch. Asked to create `notes.txt`, the CLI
  showed its file-creation prompt (`Allow creation of this file?` with the new file's lines and
  two numbered options). Escape dismissed it; the file was never created.
- `permission-edit-54.txt`: the same session and launch. Asked to change the folder README's
  title, the CLI showed its edit prompt (`Accept this file edit?` with the diff and two numbered
  options). Escape dismissed it; the README was never edited.
- `question-unsent-54.txt`: the same session. While the edit prompt's diff review view was open,
  keys typed into it became a draft comment, and leaving the view raised the CLI's
  `Unsent Comments` dialog (`You have unsent comments. Ready to send?` — `y` send and exit,
  `n` exit without sending, `esc` cancel). Nothing was sent; the CLI was closed from this dialog.
- `question-54.txt`: the same folder and launch command, after the CLI was started afresh.
  Asked to use its question tool to offer a choice of two file names before doing anything,
  the CLI showed `Question 1/1:` with the two options and `Write-in...`. Escape dismissed it;
  no option was chosen.

For the five 2026-10-04 captures: the prompt's truncated absolute path row and the elided paths
in the tool lines (`Create(...)`, `Read(...)`, `Edit(...)`) are replaced with `<project-dir>`,
as is the banner's project line. The profile's permission and question rules are the rounds these
captures taught it: the command prompt was already known; the file-creation, file-edit, question
and unsent-comments shapes were added from them, each anchored to the dialog's own structure.

Paths, user email, plan, and conversation UUID are replaced with placeholders. Shell launch scrollback
before Antigravity's header banner is removed. All other visible text is retained, including the
box borders, prompts, and model footer (`Gemini 3.8 Flash · high`). Unknown screens permit no input.
No vendor configuration in `~/.gemini` was edited.

## The rules line

- `rules-line.txt`: the one line delivery types instead of the whole message, captured
  2026-10-05 with herdr 0.7.1, `pane read --source visible --lines 200` (plain), in a
  fresh scratch session (stopped and deleted), one Antigravity seat launched as a seat
  is launched (`AGENT_UNATTENDED=1 agy --dangerously-skip-permissions`), in a 54-by-23
  pane, in a folder the owner had already trusted for the purpose: a fresh scratch
  folder showed the workspace-trust dialog of `trust-54.txt` first, and it was left
  with Escape, unanswered. The line, a neutral store path of the same shape,
  166 characters: `Read /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md
  (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for
  your brief.` The pane draws it in five rows, hard-wrapped mid-word (`…rules/im` /
  `plementer.md…`): no marker, no fold, and a break inside a word hides nothing. Read
  `unsent`. Typed with `pane send-text`, never sent. The CLI has no clear-the-box key:
  one ctrl+c armed `press ctrl+c again to exit` with the text still in the box, and a
  second ctrl+c exited the CLI; the text was never sent and the CLI was closed.
  Sanitised as the captures above: the account line's address is replaced (the tier is
  kept) and the banner's project line is `~/project`. The whole-message `unsent.txt`
  stays as documentation of a paste this CLI folds; past this line, the rules arrive in
  a file the line points at.

## Constructed

- `permission.txt`: reconstructed from an operator's quote of a real pane, not a capture
  (the line widths are approximate). A command permission prompt (`Requesting permission for:`
  with numbered options, navigation footer, and model statusline).
- `permission-cut.txt`: constructed from `permission.txt`, not a capture. The lines above the
  rule, and the rule, are removed, which is the last-20-line window once a command of about ten
  lines has pushed that rule out.
- `folded-rules.txt`: constructed, not a capture. A 54-column pane's composer holding a folded
  multi-line paste: the box's top rule, `↑ 19 more lines`, the last three rows of the text, the
  bottom rule, the model footer. The rows are the rules message `test/launch/antigravity.test.ts`
  names, hard-wrapped at 54 columns (a line longer than the width split into width-sized chunks,
  no word wrapping): 24 rows, 21 hidden. The tail is the worktree line's last row and the closing
  line, which the rules text gained in 0.1.2. The header block is copied from `unsent.txt`.

## Constructed: delivery-verification boxes

Not captures. `test/launch/antigravity.test.ts` builds the post-paste box from `idle.txt`:
the bare `>` row is replaced by `> ` and the first line of the typed text, and each later
line is drawn at two columns, the continuation indent `unsent.txt` shows. The fold tests
edit `folded-rules.txt`: the reviewer's zero-count marker with an unrelated tail, and
counts of 0 and 99 against the same 24-row text. Those screens are constructed too, and
each test names what it changes; a fold marker is never submitted unverified. No capture
shows Antigravity wrapping an ordinary composer line, so no wrap is modelled for it: a
box whose rows read back as runs of the typed text laid out in order is entered, and one
whose rows show anything else — another text, an extra row, one character changed, a
collapsed space, a blank row the text does not have at that place, a trailing blank row
the text does not end with — is never. No capture shows Antigravity drawing an empty row
of its own inside the box either — `idle.txt`'s composer is the bare `>` row and
`unsent.txt`'s rows sit directly between the rules — so the profile counts none
(`frame_rows` omitted, zero) and every trailing empty row is read as a row the text does
not have.

The round-6 fold tests insert one more row the fold read must not drop: a rule-looking row
(a 54-column run of `─`, one of `━`, two of them, or an indented one at the content column)
between the true tail and the box's closing rule, and, in the other shape, a rule-looking
row between the opening rule and the marker. The frame the read trusts is the capture's:
the opening rule directly above the marker and the closing rule the window's last rule row
at the opening rule's own width; a rule-looking row anywhere else is a row of the box, so
the box is not the typed text and nothing is entered.

The round-7 tests redraw one of `idle.txt`'s two rules at another width — the closing rule
one column shorter (52) or longer (54) than the opening, or the opening one shorter instead —
with the typed text, where the test types, drawn in the box as `unsent.txt` draws it. The
captures draw the box's two rules at one width (53 columns in `idle.txt`; 54 in
`folded-rules.txt`), so a window whose rules differ is not the frame they draw: the read
fails closed and nothing is entered.
