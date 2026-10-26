# team answer

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has to pass on
two fresh reads of the pane, and the folder must be the lobby on three readings at once: the path
the screen shows, the folder the pane itself reports working in, and the lobby's parent directory.
Anything else sends nothing. A seat the file marks `human: true` never takes a dialog key or a
rules line: no dialog key is pressed and no rules line is typed; left as it is.

## Synopsis

    team answer <seat> trust [--session <name>] [--file <path>] [--json]

`<seat>` names one seat of the team file. `trust` is the only dialog word. No option takes a key, a text, or another dialog. The pane is herdr's one agent of that name; a pane recorded in the state selects nothing. A name the file does not carry is left as it is. Two agents of the name send nothing.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--json` | — | print one JSON document and nothing on stderr; a failure is the structured error document |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from outside herdr | answer the dialog; `--file` and `--session` are the owner's alone, refused before the flagged file or session is read at all |
| a run with no terminal | nothing: `team answer: only the owner or the orchestrator from its own seat runs this, from a terminal outside herdr or its own seat` |
| the orchestrator, from its own seat | the same, in a session this project's state records, on the pane the state records for that name |
| anyone else | nothing |

Trust answering is the owner's to turn on, and the switch is a live grant: `team grant @team
--capabilities dialogs.trust` writes it for the project's team id, and `team revoke` ends it.
With no grant in force nobody sends a key, the owner included, and the refusal names the
setting: `<seat>: use team up and [o] (dialogs.trust is off; only the owner can turn it on:
team grant @team --capabilities dialogs.trust)`. The record is read on every run, so a
revocation takes effect at the next dialog.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| answered | `team <project>, session "<session>"` on stdout, then `<seat>: answered trust (<folder>)` | 0 |
| refused | `<seat>: <reason>` on stderr | 1 |
| recovery | `<seat>: trust sent; recovery required` or `<seat>: the key could not be sent; recovery required` on stderr | 1 |
| usage | `team answer: <message>` and the usage, on stderr | 2 |
| configuration | `team answer: <message>` on stderr | 2 |

Every answer opens on the team's context line and closes on one summary line naming the seat
and the lobby folder it answered. `--json` prints one document instead of the lines — the
action surface and the answered dialog in one: `{format, dry_run, status, action_summary,
project, session, seat, pane, dialog, state, folder?}`, with `status` `answered`, `dialog`
`trust` and `state` `ready`. A run that exits 1 or 2 writes the structured error document
instead — `{error: {id, message, repair}}` — and stderr stays empty; `error.id` is the
`answer.*` row of [the exit-code contract](../reference/exit-codes.md), `error.message` the
sentence without a `team answer: ` prefix, and `error.repair` a repair when one applies
(`answer.detached` carries the terminal to run from).

Exits are documented in the usage: `Exits 0 when the trust dialog is answered and the seat is
ready, 1 when the answer is refused or does not complete, 2 when the invocation or team file
can't be read.`

## Example

```console
$ team answer
team answer: a seat and trust are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has
to pass on two fresh reads of the pane, and the folder must be the lobby on three readings
at once: the path the screen shows, the folder the pane itself reports working in, and the
lobby's parent directory. <seat> names one seat of the team file; trust is the only
dialog word. No option takes a key, a text, or another dialog. The pane is herdr's one agent
of that name; a pane recorded in the state selects nothing. A name the file does not carry
is left as it is, and two agents of the name send nothing. --session is the owner's alone,
and so is --file: each is refused before the flagged session or file is read. The answer
opens on the team's context line and closes on <seat>: answered trust (<folder>). A refused
or incomplete answer names its reason on stderr, and a recovery stays recorded for the next
answer to observe. --json prints one document instead of the lines: {format, dry_run,
status, action_summary, project, session, seat, pane, dialog, state, folder?}. A run that
exits 1 or 2 writes the structured error document instead — {error: {id, message, repair}} —
and stderr stays empty.

Exits 0 when the trust dialog is answered and the seat is ready, 1 when the answer is
refused or does not complete, 2 when the invocation or team file can't be read.
```

Rationale, behaviour, refusals and known limits: [docs/internal/answer.md](../internal/answer.md).
