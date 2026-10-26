# team config

Reads and edits your team's configuration.

## Usage

    team config get <path>
    team config set <path> <value>
    team config unset <path>
    team config edit
    team config keys

## What it does

Your team lives in this machine's registry, and `team config` is how you read and change it.
A path is dotted keys, and a seat is named by its name: `seats.lead.model`. `edit` opens the
whole team as YAML in your editor. Every change is checked before it is saved; a change that
doesn't validate is refused, and nothing is written. `keys` lists the per-seat settings TeamCLI
knows.

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

Read a value:

```console
$ team config get seats.claude-keeper.model ; echo "exit $?"
Claude Opus
exit 0
```

Change one, or edit the whole team:

```sh
team config set seats.claude-keeper.effort high
team config unset seats.claude-keeper.label
team config edit
```

List the settings TeamCLI knows:

```console
$ team config keys ; echo "exit $?"
  KEY             LEVELS  ALLOWED                                                          DEFAULT                 GOVERNED BY     APPLIES
  model           seat    a model the seat's profile and the allowed-models policy accept  -                       allowed-models  restart that resumes
  effort          seat    one of the CLI profile's effort levels                           -                       -               restart that resumes
  nickname        seat    unique in the team, never lead                                   -                       -               at once
  delivery_order  seat    delivery legs, tighten only                                      mcp-inbox, typed, drop  delivery-order  at once
  human           seat    true or false                                                    false                   -               at once
exit 0
```

## Options

| Option | Meaning |
| --- | --- |
| `get <path>` | print one value |
| `set <path> <value>` | change one value |
| `unset <path>` | remove one value |
| `edit` | edit the whole team in `$VISUAL` or `$EDITOR` |
| `keys [<level>]` | list the settings TeamCLI knows |
| `--json` | print the result as JSON |

## Who can run it

Anyone can read; only the owner, from a terminal outside herdr, can change the team.

## See also

[Team configuration](../team-file.md) · [team init](init.md) · [team migrate](migrate.md) ·
[team settings](settings.md)
