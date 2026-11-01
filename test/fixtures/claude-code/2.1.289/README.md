# Claude Code 2.1.289 terminal captures

Captured on 2026-10-04 with herdr 0.7.1, `pane read --source visible --format ansi
--lines 8`, from a Claude Code session on a GLM endpoint (no Anthropic quota) in the
scratch sessions `glm-scratch-placeholder` and `glm-scratch-style2`. The panes were the
captures' own; no other seat was read or typed into. Both sessions were stopped and
deleted afterwards, and the default session was not touched.

The captures hold what `paneRead` returns: ANSI-styled text with CRLF folded to LF.
Personal text is swapped for neutral words — the home path, the worktree name, the
model name, the account line, the usage figure — and nothing else is changed; every
SGR byte is the capture's own. The greyed suggestion is `ESC[0m ESC[2m` … `ESC[0m`
(faint), and typed text carries no styling at all. The gap after the `❯` is U+00A0, as
the CLI renders it.

- `idle-suggestion-ansi.txt`, `idle-suggestion-plain.txt`: an idle box greying
  `Try "fix typecheck errors"`, in the styled and the plain read. The suggestion is
  the session-start one; after turns the box renders empty.
- `unsent-typed-ansi.txt`: the same pane after typing `Fix the` (no Enter).
- `trust-ansi.txt`: the workspace-trust dialog of an untrusted worktree, styled. The
  workspace was closed without answering it; nothing on the owner's account changed.
  2.1.289 draws this dialog's choices without numbers, so the profile's trust stage —
  which wants `1. Yes` — does not match and the dialog reads `question`, on the plain
  capture as on this one. A question is attention either way; the safety floor holds.

## Constructed

Built from the captures above by replacing text, never bytes of styling:

- `idle-suggestion-other-ansi.txt`, `idle-suggestion-other-plain.txt`: the idle capture
  with the faint run's text swapped for `Resume briefly.`, a suggestion the placeholder
  list does not name. The styled one is idle by `placeholder_style: dim`; the plain one
  stays `unsent`, the documented limit of the plain fallback.
- `unsent-faint-first-ansi.txt`: the typed capture with the typed word opened in the
  suggestion's own faint bytes and closed after one character. Text with any normally
  styled character stays `unsent`.

No `Resume briefly.` suggestion could be produced in a scratch session — the sessions
showed their start-up suggestion and, after turns, an empty box — so the non-`Try`
fixtures are the constructed ones above.

## Round 2: the unsafe direction

Captured the same day, the same way, in the scratch session `glm-scratch-r2`. A paste
chip needed the bytes a terminal sends a paste — `ESC[200~`, the lines, `ESC[201~` —
delivered with `pane send-text`; herdr has no paste command of its own, and unwrapped
newlines only open continuation lines. Everything personal is swapped as above, plus
the cost figure; the model name in the status rows reads `Opus 5.5`.

- `unsent-slash-ansi.txt`: `/effort` typed, the slash menu open above the box. The
  command text carries a truecolour style (`38;2;177;185;249`): a colour, so unsent.
- `unsent-paste-ansi.txt`: `[Pasted text #2 +7 lines]` in the box after the wrapped
  paste. The chip renders with no styling at all — real content, unsent by the list.
- `unsent-typing-while-running-ansi.txt`: `hurry please` typed while a turn runs. The
  spinner line works; the prompt itself is styled `38;2;153;153;153` — grey, and only
  faint is a placeholder — with the typed text plain after the reset.
- `bash-mode-ansi.txt`: `!` bash mode, `ls -la /tmp` typed. The `!` replaces the
  prompt glyph (styled `38;2;253;93;177`), so the composer finds no input line and
  the screen reads unknown — never idle. Whether `!` belongs in the prompt set is an
  open question for the profile, not this change.

Every captured composer draws its rows directly between the two rules — `unsent-typed-ansi.txt`
is the typed box as the pane drew it — with no empty row of its own inside the box. The
profile counts no frame rows (`frame_rows` omitted, zero): the box read keeps every
trailing empty row, and a box showing one the typed text does not have is refused.

## Round 3: the permission, question and trust screens

Captured on 2026-10-04 with herdr 0.7.1, `pane read --source visible` in the plain and
`--format ansi` reads, from Claude Code 2.1.289 in a scratch herdr session of the
captures' own (created for this, stopped and deleted after; `herdr session list` no
longer shows it, and no other pane was read, typed into, resized or closed). The CLI
ran in two throwaway directories under /private/tmp (`git init` and one file each),
launched through a symlink to the seat's launcher script so the pane's own command
line stays neutral. This machine's user settings open sessions in bypass-permissions
mode, so each scratch launch passed `--permission-mode manual` (or `plan`) to make the
prompts appear at all. Every dialog below was dismissed with Escape, with one
exception: the first throwaway directory's workspace-trust dialog was answered once,
early on, before the no-grant rule reached this work. That answer trusted only a
throwaway directory under /private/tmp — no command or other permission was granted —
and the directory was removed afterwards. So the narrow permission and question
captures sit in an already-trusted scratch directory; the second directory's trust
dialog was never answered and its captures are of the dialog itself. Everything was
closed afterwards: each claude exited, the helper client was killed, the session was
stopped and deleted, and both directories were removed.

The wide captures come from a helper client attached on a 160x40 pty (herdr's nesting
guard allowed in a temporary config used only by that client), so the session's panes
ran at 134x39; the narrow ones are 54x23, the headless session's own size.

Sanitising: the model name in the welcome banner is swapped for `Opus 5.5`, the
banner's account label is swapped for `Acme billing` (the same form as the earlier
captures), and the plan file name in the plan-approval capture is swapped for
`plan-example.md`. Everything else — including every SGR byte — is the capture's own;
the throwaway directory names are left as they were.

- `permission-create-plain.txt`, `permission-create-ansi.txt` (54x23) and
  `permission-create-wide-plain.txt`, `permission-create-wide-ansi.txt` (134x39): the
  Write-tool permission asking to create `notes.txt`, from "Create a file notes.txt
  with the text hello."; the wide pair is the same prompt from a fresh scratch
  session. Each was denied with Escape, and the transcript above the dialog shows
  the rejection.
- `permission-plan-wide-plain.txt`, `permission-plan-wide-ansi.txt` (134x39): the
  plan-approval dialog — "Claude has written up a plan and is ready to execute. Would
  you like to proceed?" — from a `--permission-mode plan` session asked to plan
  adding a README. Denied with Escape.
- `permission-read-wide-plain.txt`, `permission-read-wide-ansi.txt` (134x39): the
  Read-tool prompt asking to allow a read outside the working directories, raised
  while the plan-mode model tried to read the launcher symlink. Denied with Escape.
- `question-plain.txt`, `question-ansi.txt` (54x23) and `question-wide-plain.txt`,
  `question-wide-ansi.txt` (134x39): the question tool's choice screen, from "ask me,
  with your question tool, which of two names to use for a file"; the footer is
  `Enter to select · ↑/↓ to navigate · Esc to cancel`. Dismissed with Escape without
  selecting anything.
- `trust-plain.txt` (54x23): the workspace-trust dialog of the first throwaway
  directory, taken before it was answered; `trust-wide-plain.txt`,
  `trust-wide-ansi.txt` (134x39): the same dialog in the second, never-answered
  throwaway directory, dismissed with Escape.

Not produced: a Bash-command permission prompt. `ls`, `mkdir`, a redirected `sort`
and `python3 -c` all ran without a dialog in this scratch launch, so no such prompt
could be provoked honestly with a harmless command.

## No question answer record: no saved `--version` print

The plan-approval dialog above was "Denied with Escape" and the question tool's choice screen
"Dismissed with Escape without selecting anything": both keys were measured here. But no
capture or note in this folder saves a `claude --version` print at 2.1.289 — the folder title
names the build, which is not the print the answer layer compares against. A record that sends
a key names one captured version, spelled as the CLI prints it, so the profile ships no
question answer at 2.1.289, of either kind: a seat printing it is refused as a version with no
answer rather than pressed on an inferred spelling. The dialog readings are unchanged — these
captures still classify as plan approval, question and trust. The saved prints are in the later
folders: `2.1.299/README.md` records `claude --version` printed `2.1.299 (Claude Code)`, and
`2.1.302/README.md` the same for `2.1.302 (Claude Code)`.
