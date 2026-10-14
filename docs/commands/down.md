# team down

Stops the team: asks every running seat the approved copy names to exit, closes its workspace, and
stops the herdr session. A pane herdr names with something that copy does not carry is closed when
the state records that pane and that workspace for one seat, and left running when no seat record
accounts for it: the name is not what decides. A pane with no name is closed on that same record.
When the record also holds the process `up` launched, the pane is closed only while that process
is still in the pane. Any other such pane is left as it is and named. A seat is only asked when it
is free, so a working, blocked or half-typed seat is left running and named. `--dry-run` prints the
plan and runs nothing.

## Synopsis

    team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | print the plan, and the refusals the real run would stop on; a run that reaches its plan runs nothing |
| `--wait` | — | give a working seat up to 120 seconds to come free, then stop it |
| `--abandon` | — | the owner's: close the workspace of a seat that can't be asked, typing nothing into it; a seat this run asks and cannot stop is closed in the same run |
| `--session` | `<name>` | the herdr session to stop, instead of `team.session`; the owner's alone — a delegate is refused it by the gate |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone — a delegate is refused it by the gate |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--abandon`, `--session` and `--file` are the owner's own |
| the orchestrator's seat | stop the other seats, and leave its own seat and the operator's seat running. When the file has a `grant`, this needs `down` in that grant. `--abandon`, `--session` and `--file` stay the owner's |
| the operator's seat | stop the team; never the orchestrator's or the operator's own seat |
| the approved delegate, when the file's `delegates` section names it | stop the whole team, the orchestrator's and the operator's seats included; never `--abandon`, `--session` or `--file` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seats it could stop were stopped | `<seat>: stopped` per seat; `session <session>: stopped and cleared` | 0 |
| a seat was left running — busy, blocked, at its own exit question, on an unreadable screen | its `  skip` line, and the last line naming it | 0 |
| there was nothing to stop | `session <session> is not running: nothing to stop` | 0 |
| `--dry-run` | the plan; `dry run: nothing was run` | the refusal's own exit, else 0 |
| the run was refused, or a step failed | `team down: <reason>` | 1 |
| the invocation, the team file or herdr can't be read | `team down: <problem>` and the usage | 2 |

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
agents: all
watch: alive
state:
  seats:
    claude-beacon: {stage: ready, cli: claude-code}
```

Two seats idle, a watch running: this is the whole plan. The watch is named and left running.

```console
$ team down --dry-run ; echo "exit $?"
watch: its pid is only in the state; left running
+ herdr --session beacon pane run w1:p1 /exit
  wait until claude-keeper's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w1
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ herdr session stop beacon
    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)
dry run: nothing was run
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/down.md](../internal/down.md).
