# team plan

Prints the queue a claim would consider, in the order `team next` would consider it, and claims
nothing: no lease, no renewal, no state write, no tracker write. A seat cannot pull until `team up`
has recorded its pane; the owner is refused, and so is a name that is not a seat. A record another
seat holds can still appear, and a deadline the clock has passed reads `overdue` in the STATE
column and is never acted on.

## Synopsis

    team plan [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | print a JSON document (`format: 1`, `project`, `session`, `tasks`), each task carrying its `step`, `state` and whole record |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| a declared seat of this team, on the pane the state records for that seat | plan; any declared seat, not only the orchestrator |
| the owner, or a name that is not a seat | nothing: `team plan: only a seat of this team pulls a task; this call is <caller>` |

The refusals are `team next`'s, with this command's prefix.

## Columns

| Column | Meaning |
| --- | --- |
| STEP | the record's place in the queue, from 1 |
| STATE | `overdue` when the clock has passed the record's deadline, `open` otherwise |
| OWNER | the record's assignee, or `-` when the file names none |
| TITLE | the record's title |

The other record fields are carried whole in `--json`; the plain plan is the four columns above.
The STATE mark decides nothing: an overdue record is still takeable and is never dropped, blocked,
reordered or released by lateness.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the queue was shown | `team <project>, session "<session>"`, the `STEP  STATE  OWNER  TITLE` table, and `<n> task(s)`, in `team next`'s order | 0 |
| nothing was takeable | the context line and `0 task(s)` | 0 |
| refused: not a seat on its recorded pane, the team file can't be read, the task file is missing or not a list, nothing was shown and a record is not a task, or the broker path refused | `team plan: <reason>` (with `--json`, a `team.error` document) | 1 |
| the invocation can't be read, or this folder is not a git checkout | `team plan: <problem>`, with the usage for the invocation (with `--json`, a `team.error` document) | 2 |

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

tasks:
  source: file
  path: .agents/tasks.yaml

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```yaml file=.agents/tasks.yaml
- id: m1
  title: the task title
  deadline: 2026-01-01T00:00:00Z
```

```console caller=claude-keeper
$ team plan ; echo "exit $?"
team beacon, session "beacon"
  STEP  STATE    OWNER  TITLE
  1     overdue  -      the task title
1 task(s)
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/plan.md](../internal/plan.md).
