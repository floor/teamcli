# team up

Starts the team.

## Usage

    team up
    team up --dry-run

## What it does

`team up` starts the herdr session, opens a pane for every seat the team declares, and starts the
watch. Seats that are already running are left alone. The coordinator and operator start in the
project folder; the other seats start in the team's lobby. `--dry-run` prints every command it
would run, and anything that would stop it, without starting anything.

## Examples

```yaml file=.agents/team.yaml hidden=1
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
    nickname: agamemnon
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: gpt-reviewer
    label: reviewer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
```

See the plan first. Here both seats are already running, so it would only relabel their panes:

```console
$ team up --dry-run ; echo "exit $?"
+ herdr --session beacon workspace rename w1 coordinator
+ herdr --session beacon pane report-metadata w1:p1 --source team --display-agent 'Claude Opus 5.5 default'
  skip claude-keeper: already ready; left as it is
+ herdr --session beacon workspace rename w2 reviewer
+ herdr --session beacon pane report-metadata w2:p1 --source team --display-agent 'GPT Sol 6 default'
  skip gpt-reviewer: already ready; left as it is
dry run: nothing was run
exit 0
```

An agent that isn't the team's lead is refused:

```console caller=agent
$ team up ; echo "exit $?"
deny
exit 1
```

## Options

| Option | Meaning |
| --- | --- |
| `--dry-run` | print the plan and start nothing |
| `--serial` | start one seat at a time |
| `--session <name>` | start a different herdr session than the team's own |
| `--json` | print the result as JSON |

## Who can run it

The owner, from a terminal outside herdr, or the team's lead seat from its own pane.

## See also

[team down](down.md) · [team status](status.md) · [team doctor](doctor.md) ·
[team add](add.md)
