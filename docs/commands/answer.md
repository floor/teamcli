# team answer

Presses the one recorded key of a dialog, and only that key. `trust` answers a folder-trust
dialog: every check has to pass on two fresh reads of the pane, and the folder must be the lobby
on three readings at once — the path the screen shows, the folder the pane itself reports
working in, and the lobby's parent directory. `question` answers a question, plan approval or
confirmation dialog: the CLI's recorded let-me-type-or-cancel key dismisses the dialog, never
an option, and the seat then receives one decision line through the ordinary send path — decide
within your rules or ask your orchestrator with team send. Its two fresh reads must agree on the
dialog and on its text. A permission, login or trust-to-run-a-command prompt is never answered
by either word. A seat the file marks `human: true` never takes a dialog key or a rules line: no
key is pressed and no line is typed; left as it is.

## Synopsis

    team answer <seat> trust [--session <name>] [--file <path>] [--json]
    team answer <seat> question [--session <name>] [--file <path>] [--json]

`<seat>` names one seat of the team file. `trust` and `question` are the dialog words. No option takes a key, a text, or another dialog. The pane is the one agent of that name the terminal host lists; a pane recorded in the state selects nothing. A name the file does not carry is left as it is. Two agents of the name send nothing.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the terminal host session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--json` | — | print one JSON document and nothing on stderr; a failure is the structured error document |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from outside the terminal host | answer the dialog; `--file` and `--session` are the owner's alone, refused before the flagged file or session is read at all |
| a run with no terminal | nothing: `team answer: only the owner or the orchestrator from its own seat runs this, from a terminal outside herdr or its own seat` |
| the orchestrator, from its own seat | the same, in a session this project's state records, on the pane the state records for that name |
| the operator, from its own seat | the same, while dev mode is on and the `lead-gates` policy reads `lead+operator` for the caller's chain — the same placement proof, its own warning, and an audit line naming `admitted as operator` beside the answered one (the development-mode page names the policy) |
| anyone else | nothing |

Both words admit the same callers. Dialog answering is the owner's to turn on, and the switch
is a live grant read before either word: `team grant @team --capabilities dialogs.trust` writes
it for the project's team id, and `team revoke` ends it. With no grant in force nobody sends a
key, the owner included, and the refusal names the setting: `<seat>: use team up and [o]
(dialogs.trust is off; only the owner can turn it on: team grant @team --capabilities
dialogs.trust)`. The record is read on every run, so a revocation takes effect at the next
dialog.

`question` never selects a choice. The key it presses is the CLI's recorded
let-me-type-or-cancel key — `escape` or `ctrl+c` — and a record outside that closed set refuses
rather than sending. After the dismissal the seat receives one line in its own conversation,
put there by the ordinary send path with that path's own admission, delivery order and record,
and never a keystroke at a choice: `decide within your rules or ask your orchestrator with team
send`. The line is sent from this run's folder, so that folder must hold this seat's team file —
compared whole, so a second file for another team or session is refused — in the team's own
session; otherwise the run refuses before any key. When the line cannot be delivered, the dialog
stays dismissed and the recovery stays recorded: a retry delivers the line and never presses a
second key. Once the line is out the record says so, and a retry after a readiness-only failure
finishes the seat without sending it again.

The question text is read to the end of the dialog's block. A question still going when the
version's supported rows run out is refused, and the pane is left as it is — never answered on
the part of it that was visible.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| answered (trust) | `team <project>, session "<session>"` on stdout, then `<seat>: answered trust (<folder>)` | 0 |
| answered (question) | `team <project>, session "<session>"` on stdout, then `<seat>: answered question (<dialog>)` | 0 |
| refused | `<seat>: <reason>` on stderr | 1 |
| recovery | `<seat>: trust sent; recovery required`, `<seat>: question sent; recovery required`, `<seat>: the key could not be sent; recovery required` or `<seat>: the decision line was delivered, but its record could not be marked; recovery required` on stderr | 1 |
| delivery | `<seat>: the dialog was dismissed, but the decision line could not be delivered; recovery required`, or on a retry `<seat>: the decision line could not be delivered; recovery required`, on stderr | 1 |
| usage | `team answer: <message>` and the usage, on stderr | 2 |
| configuration | `team answer: <message>` on stderr | 2 |

Every answer opens on the team's context line and closes on one summary line naming the seat
and the dialog it answered — the lobby folder for `trust`, the dialog kind for `question`
(`question`, `plan approval` or `confirmation`). `--json` prints one document instead of the
lines — the action surface and the answered dialog in one: `{format, dry_run, status,
action_summary, project, session, seat, pane, dialog, dialog_kind?, state, folder?}`, with
`status` `answered`, `dialog` `trust` or `question`, `state` `ready`, `folder` only for `trust`,
and `dialog_kind` only for `question`. A run that exits 1 or 2 writes the structured error
document instead — `{error: {id, message, repair}}` — and stderr stays empty; `error.id` is the
`answer.*` row of [the exit-code contract](../reference/exit-codes.md), `error.message` the
sentence without a `team answer: ` prefix, and `error.repair` a repair when one applies
(`answer.detached` carries the terminal to run from).

A key is written into the seat's state as a recovery before it is sent:
`trust-sent-recovery` or `question-sent-recovery`. A retry of the same word only observes it —
it delivers what is still owed or finishes the seat ready, and never presses the key again —
and the other word refuses it and names the word that completes it.

Exits are documented in the usage: `Exits 0 when the dialog is answered and the seat is ready,
1 when the answer is refused or does not complete, 2 when the invocation or team file can't be
read.`

## Example

```console
$ team answer
team answer: a seat and trust or question are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
       team answer <seat> question [--session <name>] [--file <path>] [--json]

Presses the one recorded key of a dialog, and only that key. trust answers a folder-trust
dialog, and the folder must be the lobby on three readings at once: the path the screen
shows, the folder the pane itself reports working in, and the lobby's parent directory.
question dismisses a question, plan approval or confirmation dialog with that CLI's recorded
let-me-type-or-cancel key, then sends the seat one line through the ordinary send path and
never a keystroke at a choice: decide within your rules or ask your orchestrator with team
send. A permission, login or trust-to-run-a-command prompt is never answered. Every check
has to pass on two fresh reads of the pane, and the question word's two reads must agree on
the dialog and on its text. <seat> names one seat of the team file. No option takes a key,
a text, or another dialog. The pane is the terminal host's one agent of that name; a pane
recorded in the state selects nothing. A name the file does not carry is left as it is, and
two agents of the name send nothing. --session is the owner's alone, and so is --file: each
is refused before the flagged session or file is read. The answer opens on the team's
context line and closes on <seat>: answered trust (<folder>) or <seat>: answered question
(<dialog>). A refused or incomplete answer names its reason on stderr, and a recovery stays
recorded for the next answer to observe. --json prints one document instead of the lines:
{format, dry_run, status, action_summary, project, session, seat, pane, dialog,
dialog_kind?, state, folder?}. A run that exits 1 or 2 writes the structured error document
instead — {error: {id, message, repair}} — and stderr stays empty.

Exits 0 when the dialog is answered and the seat is ready, 1 when the answer is refused or
does not complete, 2 when the invocation or team file can't be read.
```

Rationale, behaviour, refusals and known limits: [docs/internal/answer.md](../internal/answer.md).
