# team order

Re-orders the session's sidebar to the roster: the orchestrator's seat first, then the remaining
seats in the team file's order. The pane host keeps no move command — its sidebar draws one entry
per workspace in the order it created them, and a re-created workspace always lands at the end —
so `team order` closes and re-creates, through [`team restart`](restart.md), exactly the seats
from the first position where the sidebar's order and the roster's diverge. Nothing before that
position is touched. A seat re-added with [`team add`](add.md), or restarted out of place, is the
case this repairs, and each re-created seat resumes its recorded conversation exactly as a
restart does.

Who may run it: the owner, or a seat this team's file admits as `leads` on its recorded pane —
the same row as `restart`, whose act each seat's move is. A seat that is working or blocked at a
prompt is never interrupted: the run reads the pane host's status first and refuses up front,
naming them, and nothing is closed. A run from a seat whose own pane is in the moving set refuses
too, because closing that pane would end the very pass. What the pane host cannot say up front —
unsent text, an exit question — `team restart` refuses seat by seat, and the pass stops there and
says how far it got; run `team order` again once the seat clears.

Workspaces that hold no declared seat (the watch, the bus, a temporary copy) never move: closing
them is not this command's to do, and they may stay between seats. What the pass restores is the
seats' own relative order. A seat with no recorded workspace is not in the sidebar at all, and
nothing here launches it.

`--dry-run` prints the sidebar order, the roster order and the set it would close and re-create,
and touches nothing. A pass that ends verifies its own claim: the sidebar is read again, and a
session that still does not name the seats in roster order is reported, never assumed.

## Synopsis

    team order [--dry-run] [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | print the moving set and the order it would be re-created in, without closing anything |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

## Example

A team whose second seat, `claude-beacon`, was removed and re-added: the fresh workspace landed
at the end of the sidebar, so the sidebar reads `claude-keeper, claude-reviewer, claude-beacon`
while the roster reads `claude-keeper, claude-beacon, claude-reviewer`. The two orders first
diverge at the second seat, so that tail — not the whole team — is what moves.

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
sidebar: [claude-keeper, claude-reviewer, claude-beacon]
```

```console
$ team order --dry-run ; echo "exit $?"
team order: sidebar: claude-keeper, claude-reviewer, claude-beacon
team order: roster: claude-keeper, claude-beacon, claude-reviewer
team order: would close and re-create claude-beacon, claude-reviewer in roster order, each through team restart; nothing was closed
exit 0
```

A seat mid-turn stops the whole pass before anything closes:

```console screens="claude-beacon=working"
$ team order ; echo "exit $?"
team order: sidebar: claude-keeper, claude-reviewer, claude-beacon
team order: roster: claude-keeper, claude-beacon, claude-reviewer
team order: claude-beacon is working; left as they are, nothing was closed
exit 1
```

The pass itself, once the seat is idle again:

```console
$ team order ; echo "exit $?"
team order: sidebar: claude-keeper, claude-reviewer, claude-beacon
team order: roster: claude-keeper, claude-beacon, claude-reviewer
team order: closing and re-creating claude-beacon, claude-reviewer in roster order, each through team restart
claude-beacon: input box: empty
claude-beacon: turn: not working (free)
claude-beacon: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript; no recorded conversation
claude-beacon: stopped
claude-beacon: ready
team restart: restarted claude-beacon; pane w3:p1 -> w4:p1
claude-reviewer: input box: empty
claude-reviewer: turn: not working (free)
claude-reviewer: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript; no recorded conversation
claude-reviewer: stopped
claude-reviewer: ready
team restart: restarted claude-reviewer; pane w2:p1 -> w5:p1
team order: sidebar: claude-keeper, claude-beacon, claude-reviewer
exit 0
```

A sidebar already reading in roster order closes nothing:

```console
$ team order ; echo "exit $?"
team order: sidebar: claude-keeper, claude-beacon, claude-reviewer
team order: roster: claude-keeper, claude-beacon, claude-reviewer
team order: the sidebar already reads in roster order; nothing was closed
exit 0
```
