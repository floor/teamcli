# team issues

Lists the typed records in the one file the team file names. Anyone in the checkout may run it.
It reads: it writes nothing, and it creates no key. The list is file order — a priority is shown
and does not reorder. A listing is not a claim and not the intake rule:
`team plan` prints the takeable queue and claims nothing. A broker source is read by `team next`,
never from here: this command connects to no broker, holds no tracker credential, and has no seat
gate.

## Synopsis

    team issues [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | print a JSON document (`format: 1`, `project`, `session`, `issues`), each issue carrying its whole record and its `state` |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

Anyone in the checkout.

## Columns

| Column | Meaning |
| --- | --- |
| ID | the record's id |
| STATE | `open` when a claim would consider the record, `blocked` when it has `blocked-by`, `repos` or `needs` |
| ASSIGNEE | the record's assignee, or `-` when the file names none |
| TITLE | the record's title |

The other record fields are carried whole in `--json`; the plain listing is the four columns above.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the records were listed | `team <project>, session "<session>"`, the `ID  STATE  ASSIGNEE  TITLE` table, and `<n> issue` or `<n> issues`, in file order | 0 |
| the list was empty | the context line and `0 issues` | 0 |
| the team file can't be read, its source is a broker's, the task file is missing or not a list, or a record is not a task | `team issues: <reason>` (with `--json`, a `team.error` document) | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team issues: <problem>`, with the usage for the invocation (with `--json`, a `team.error` document) | 2 |

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
```

```console
$ team issues ; echo "exit $?"
team beacon, session "beacon"
  ID  STATE  ASSIGNEE  TITLE
  m1  open   -         the task title
1 issue
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/issues.md](../internal/issues.md).
