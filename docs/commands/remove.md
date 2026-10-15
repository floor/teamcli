# team remove

Takes one seat out of the team: asks it to exit, waits for its pane to come back to its shell,
closes its workspace, and edits the file so the seat is not started again. `--keep` leaves the seat
in the file as `stopped: true`; a seat that is busy — working, blocked at a prompt, at its own exit
question, on a screen the profile does not recognise, or holding unsent text — is left as it is,
unless its owner abandons it.

## Synopsis

    team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--keep` | — | leave the seat in the file with `stopped: true`: `team up` leaves it out, and `team add <name>` starts it again |
| `--abandon` | — | the owner's: close the workspace of a seat that can't be asked, typing nothing into it |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--abandon`, `--session` and `--file` are the owner's own |
| a run with no terminal | nothing: `team remove: only the owner runs this, from a terminal outside herdr` |
| the orchestrator's seat, the operator's seat | remove another seat; never the orchestrator's or the operator's own seat, and never `--abandon` |
| the approved delegate, when the file's `delegates` section names it | remove a named seat; never `--keep`, `--abandon`, `--session` or `--file` |

A caller other than the owner meeting a seat herdr reports idle or done that is not free takes the
seat out of the team and leaves its pane running: nothing typed, the workspace left open, the
pane's agent renamed so it no longer answers the seat's name.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat was stopped, or was not running | `<seat>: stopped`, then `removed <name>` — or `stopped <name>` with `--keep`, `removed temporary <name>` for a temporary seat | 0 |
| a caller other than the owner took the seat out with its pane left running | `removed <name> (its pane <pane> was left running; nothing was typed; it now reads as <name>-left)` | 0 |
| the run was refused, or the seat was left behind | `team remove: <reason>`, and the file is not edited | 1 |
| the invocation, the team file or the state can't be read, or the edit would not validate | `team remove: <problem>` and the usage | 2 |

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

  - role: implementer
    name: claude-reviewer
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: all
```

A seat mid-turn is not interrupted — its work would be lost — and `remove` says which state it was
in:

```console screens="claude-beacon=working"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon is working; left as it is
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/remove.md](../internal/remove.md).
