# team plan

Prints the queue a claim would consider, in the order `team next` would consider it, and claims
nothing: no lease, no renewal, no state write, no tracker write. A seat cannot pull until `team up`
has recorded its pane; the owner is refused, and so is a name that is not a seat. A record another
seat holds can still appear, and a deadline the clock has passed is marked, never acted on.

## Synopsis

    team plan

## Who may run it

| Caller | May |
| --- | --- |
| a declared seat of this team, on the pane the state records for that seat | plan; any declared seat, not only the orchestrator |
| the owner, or a name that is not a seat | nothing: `team plan: only a seat of this team pulls a task; this call is <caller>` |

The refusals are `team next`'s, with this command's prefix.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the queue was printed, or there was nothing to take | the takeable records, one `team issues` block each, in `team next`'s order — a deadline the clock has passed gains ` (overdue)` — or `team plan: nothing is takeable` | 0 |
| refused: not a seat on its recorded pane, the team file can't be read, the task file is missing or not a list, nothing was printed and a record is not a task, or the broker path refused | `team plan: <reason>` | 1 |
| the invocation can't be read, or this folder is not a git checkout | `team plan: <problem>`, with the usage for the invocation | 2 |

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
m1  the task title
  deadline: 2026-01-01T00:00:00Z (overdue)
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/plan.md](../internal/plan.md).
