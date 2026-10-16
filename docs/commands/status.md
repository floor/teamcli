# team status

Shows the team as it stands: one line per seat with what herdr shows of it, and one `difference` for
each way the file, the state and the live session disagree, each naming the command that repairs it.
It writes nothing but the owner's `last_valid` copy; other runs write nothing.

## Synopsis

    team status [--session <name>] [--file <path>] [--all] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session`, `--file` | `<name>`, `<path>` | the herdr session or team file to read, instead of `team.session` and `.agents/team.yaml`; the owner's alone |
| `--all` | — | the expanded seat registry columns, and the same fields in every `--json` row |
| `--json` | — | the same reading as one JSON document, instead of the table, the notes and the repairs |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | read the team, and aim the read with `--file` and `--session` |
| a seat of the team, placed in the file's session, on the pane the state records for it | read the team; a seat the state records no pane for, or records on another pane, fails closed |
| a pane outside the team that the live file names in its `delegates` entries | read the team; a pane newly named by the live file also passes |
| anyone else, an owner's run without a terminal included | nothing: the fixed sentence `team status: this team is not yours to read` on stderr, stdout empty, exit 2. `--file` and `--session` aimed by anyone else are refused before any file or session is read — `--file is the owner's, from a terminal outside herdr; this call is …`, or `only the owner runs this, from a terminal outside herdr` for a run with no terminal — and exit 1. |

## What a row says

| Reading | What it means |
| --- | --- |
| the ordinary row | A pane that no longer holds the process `team` launched is not by itself a difference: when a program `team` did not launch is in front and the agent session stored at its launch is the session the pane reports now — a herdr restart brings the pane back under a new shell pid — the row is the ordinary one. |
| `missing`, or `restored, not launched by team` | Otherwise, a pane with no CLI left reads `missing` (the CLI ended, or a restore left the shell in front) and a pane fronted by any other program reads `restored, not launched by team`; both carry a difference, and the second's model is `-`, never the file's. |
| the launcher difference, and the repairs | When the seat's launch line starts a launcher — a program other than the CLI's own binary, or a file that says the launcher chooses the model — the run adds a difference of its own, `<seat>: its launch line starts a launcher, and the process in its pane is not the one team launched`; the row stays the one the live session gives it. And a pane this record cannot tie is repaired by that restart — `team remove <seat> --keep, then team add <seat>`, or `team down, then team up` for a lead — when its screen names a model the file does not carry, or its launch line starts a launcher; a pane it can say nothing about is repaired by looking at it. Nothing either report says starts a seat. |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| no difference | the seats table, the `budgets:` table when the file names an account or a reading is stored, one `note:` line per note, then `0 difference(s)` | 0 |
| at least one difference | the same, then one `difference:` line with its `  repair:` line under it per difference, and the count: `1 difference(s)`, or `2 difference(s), 1 for the owner` when a repair is the owner's | 1 |
| the invocation or the team file can't be read, herdr doesn't answer, or the caller may not read this team | `team status: <problem>`, `team status: herdr doesn't answer; is it installed and running?`, or the fixed sentence | 2 |

Every line the table prints is cleaned first: escape sequences, control characters and invisible format characters
carried by the team file, the state, a pane or herdr are removed, and the columns are padded on the cleaned text, so a
value can never move the cursor, paint the terminal or open a second line. `--json` is the one text not cleaned: the
document carries each string as it was read, escaped where JSON requires it, for a parser rather than a terminal.

Every line the table prints is cleaned first: escape sequences, control characters and invisible
format characters carried by the team file, the state, a pane or herdr are removed, and the columns
are padded on the cleaned text, so a value can never move the cursor, paint the terminal or open a
second line. `--json` is the one text not cleaned: the document carries each string as it was read,
escaped where JSON requires it, for a parser rather than a terminal.

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: [claude-beacon]
screens:
  claude-beacon: working
```

Only the implementer is up, so the orchestrator's seat is a difference with its repair. The `budgets:`
table, the `--json` document, the swap note and the readings that follow stand on the internal page:

```console
$ team status ; echo "exit $?"
team status: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
team beacon, session "beacon"
  claude-keeper  missing  Claude Opus 5.5  -
  claude-beacon  working  Claude Opus 5.5  w1:p1
note: approval #1 (2026-10-04), key fe21ef6293de
difference: claude-keeper is in the file and is not running
  repair: team add claude-keeper
1 difference(s)
exit 1
```

Rationale, behaviour, the budgets, refusals and known limits: [docs/internal/status.md](../internal/status.md).
