# team next

Claims one record from the file the team file names, and holds it with a lease in this clone: the
record, the issues block, nothing else. A seat cannot pull until `team up` has recorded its pane;
the owner is refused, and so is a name that is not a seat. The source is a file the owner
committed, or a tracker the owner's broker reads — with no broker running, `next` refuses and
claims nothing.

## Synopsis

    team next [--mine | --release] [--wait]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--mine` | — | a new take keeps only records whose `assignee` is the caller's seat name; a renewal is not filtered |
| `--release` | — | unlink the caller's lease and print `team next: released <id>`; records no progress |
| `--wait` | — | re-reads the source every `tasks.cadence` while a pass finds nothing takeable, until a record is taken, the wait is stopped, or a read breaks; without `tasks.cadence` it refuses; off unless set |
| `--help`, `-h` | — | the usage, and exit 0 |

`--mine` and `--release` together are refused, and no file is written. `--wait` and `--release` together are refused the same way, and so is `--wait` without `tasks.cadence` in the team file: the pace is always the team's own declared one.

## Who may run it

| Caller | May |
| --- | --- |
| a declared seat of this team, on the pane the state records for that seat | pull; any declared seat, not only the orchestrator |
| the owner, or a name that is not a seat | nothing: `team next: only a seat of this team pulls a task; this call is <caller>` |

A team that has never been started has no recorded pane, so a seat cannot pull until `team up` has
recorded one.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a record was claimed, or the caller's live lease was renewed | the record: the `team issues` block, one record, nothing else on stdout | 0 |
| a lease was released, or there was nothing to take or to release | `team next: released <id>`, or `team next: nothing is takeable` / `team next: nothing is assigned to you` / `team next: nothing is held` | 0 |
| the wait ended on a stop signal, or a clock that did not advance | `team next: stopped waiting` | 0 |
| refused: not a seat on its recorded pane, the team file can't be read or its policy is refused, the task file is missing or not a list, nothing was taken and a record is not a task, or the broker path refused | `team next: <reason>` | 1 |
| the invocation can't be read, or this folder is not a git checkout | `team next: <problem>`, with the usage for the invocation | 2 |

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

```console caller=claude-keeper
$ team next ; echo "exit $?"
m1  the task title
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/next.md](../internal/next.md).
