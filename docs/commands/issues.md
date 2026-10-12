# team issues

Lists the typed records in the one file the team file names. Anyone in the checkout may run it.
It reads: it writes nothing, and it creates no key. The list is file order — a priority is shown and
does not reorder. A listing is not a claim and not the intake rule:
`team plan` prints the takeable queue and claims nothing. A broker source is read by `team next`,
never from here: this command connects to no broker, holds no tracker credential, and has no seat
gate.

## Synopsis

    team issues

## Who may run it

Anyone in the checkout.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the records were listed | each record's block, in file order | 0 |
| the list was empty | `team issues: nothing is waiting` | 0 |
| the team file can't be read, it declares no task source or one that is a broker's, the task file is missing or not a list, or a record is not a task | `team issues: <reason>` | 1 |
| the invocation can't be read, or this folder is not a git checkout | `team issues: <problem>`, with the usage for the invocation | 2 |

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
m1  the task title
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/issues.md](../internal/issues.md).
