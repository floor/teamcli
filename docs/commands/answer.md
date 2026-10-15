# team answer

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has to pass on
two fresh reads of the pane, and the folder must be the lobby on three readings at once: the path
the screen shows, the folder the pane itself reports working in, and the lobby's parent directory.
Anything else sends nothing.

## Synopsis

    team answer <seat> trust [--session <name>] [--file <path>] [--json]

`<seat>` names one seat of the approved copy. `trust` is the only dialog word. No option takes a key, a text, or another dialog. The pane is herdr's one agent of that name; a pane recorded in the state selects nothing. A name the copy does not carry is left as it is. Two agents of the name send nothing.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--json` | — | print one JSON object and nothing on stderr |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from outside herdr | answer the dialog; `--file` and `--session` are the owner's alone, refused before the flagged file or session is read at all |
| a run with no terminal | nothing: `team answer: only the owner runs this, from a terminal outside herdr` |
| the orchestrator, from its own seat | the same, in a session this project's state records, on the pane the state records for that name |
| anyone else | nothing; with `dialogs.trust: owner` (the value when `dialogs` is omitted) nobody sends a key, the owner included |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| answered | `<seat>: trust answered; ready` on stdout | 0 |
| refused | `<seat>: <reason>` on stderr | 1 |
| recovery | `<seat>: trust sent; recovery required` or `<seat>: the key could not be sent; recovery required` on stderr | 1 |
| usage | `team answer: <message>` and the synopsis line, on stderr | 2 |
| configuration | `team answer: <message>` on stderr | 2 |

## Example

```console
$ team answer
team answer: a seat and trust are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
```

Rationale, behaviour, refusals and known limits: [docs/internal/answer.md](../internal/answer.md).
