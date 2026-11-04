# team checkpoint

Records a standing checkpoint ask for a declared seat in `.agents/team.state.json`
(`checkpoints[seat]`), minting its handover file path
(`.agents/handovers/<seat>-<timestamp>.md`) and a 30-minute deadline.

The command does not require the seat to be running or idle at the moment the ask is recorded, and
does not send a message itself. The lead sends the seat its checkpoint instruction separately, the
seat writes the handover file on disk, and the next [`team restart <seat>`](restart.md) (or
[`team down`](down.md)) reads the standing ask, links the handover file onto the session chain, and
tells the fresh conversation to read it before anything else.

Who may run it: the owner, a placed `leads` seat of this team on its recorded pane, or the entity's
main orchestrator on its own recorded pane.

## Synopsis

    team checkpoint <seat> [--session <name>] [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the terminal-host session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | a team file to read instead of the team's registry record; the owner's alone |
| `--json` | — | emit a `team.checkpoint` JSON envelope (`status: "recorded"`) on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

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
panes: neutral
```

Recording a checkpoint ask for `claude-beacon`:

```console
$ team checkpoint claude-beacon ; echo "exit $?"
team checkpoint: recorded claude-beacon -> ./.agents/handovers/claude-beacon-2026-10-04T09-00-00-000Z.md (by 2026-10-04T09:30:00.000Z)
exit 0
```

A seat that does not hold `leads` is refused:

```console caller=claude-beacon
$ team checkpoint claude-beacon ; echo "exit $?"
team checkpoint: only the owner or `leads` records a checkpoint ask; this call is claude-beacon
exit 1
```
