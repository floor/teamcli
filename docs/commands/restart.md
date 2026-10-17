# team restart

Restarts one declared seat in place without editing `.agents/team.yaml`: prints the seat's input-box,
turn and context facts, asks a free seat to exit and waits for its pane to return to its shell,
closes its workspace, and launches the seat again in a fresh workspace. A seat that is busy —
working, blocked at a prompt, at its own exit question, or holding unsent text — is left as it is
unless `--abandon` is given. A screen the profile does not recognise is advice, not a block: when
herdr reports the seat idle or done, the workspace is closed without typing into it, and the run
says the screen was not read. A seat whose profile says herdr cannot report it
(`herdr_status: unreliable`) is free when its own screen reads idle, and it is stopped on its
profile's exit key there.

## Synopsis

    team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--abandon` | — | close the workspace of a stuck seat without typing into its pane; a seat caller cannot abandon a `working` seat or a lead seat |
| `--dry-run` | — | check the seat and print the stop and launch plan without touching the session |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--json` | — | one `team.restart` document instead of the working lines; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--session` and `--file` are the owner's own |
| a run with no terminal | nothing: `team restart: only the owner runs this, from a terminal outside herdr` |
| the orchestrator's seat — and any seat the record marks a lead: the map's `leads` | restart another declared seat; never its own recorded pane, never `--abandon` on the orchestrator's or the operator's seat, and never `--abandon` on a `working` seat |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat was restarted | the three pre-close facts, `<seat>: stopped`, the launch record, and `team restart: restarted <seat>; pane <old-pane> -> <new-pane>` | 0 |
| `--dry-run` succeeded | the stop line and the launch plan | 0 |
| the run was refused, or the seat was left behind | `team restart: <reason>` | 1 |
| the invocation or the team file can't be read | `team restart: <problem>` and the usage | 2 |

`--json` prints one `team.restart` document instead: `project`, `session`, `seat`, the new `pane`,
the working lines (the pre-close facts and the stop's own lines) as collapsed `notes`, and the
closing line as `action_summary`; `dry_run` is `false` and `status` is `ready`. With `--dry-run` it
prints the plan as `plan` — the stop step first, then one step per launch plan line, `prefix` `+`,
`!` or `skip` — with `dry_run` `true` and `status` `dry-run`. A refusal under `--json` prints the
`team.error` document on stdout — its `id` is the contract row for that refusal (`restart.unknown`,
`restart.caller`, …) — and nothing on stderr.

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

A seat mid-turn is not interrupted — its work would be lost — and `restart` says which state it was
in:

```console screens="claude-beacon=working"
$ team restart claude-beacon ; echo "exit $?"
team restart: claude-beacon is working; left as it is
exit 1
```

Design and behaviour: [docs/design/restart.md](../design/restart.md).
