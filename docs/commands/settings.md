# team settings

One seat's settings, each with where its value comes from: the team file, the team's own order
standing under a seat that writes none, the release default, or `unset`. The read is the team file
and the registry (`team config keys`); it writes nothing, and the value verbs wait on the
signed-record store the decision leaves open.

A setting is a value, not a permission. `team settings` shows no value it would not accept: the
`model` it prints is the file's value, and `team config keys` names the `allowed-models` policy that
bounds it.

## Synopsis

    team settings <seat> [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's |
| `--json` | — | print a JSON document (`format: 1`, `project`, `seat`, `settings`), one entry per key with `value`, `source` and `applies` |
| `--help`, `-h` | — | the usage, and exit 0 |

## Where a value comes from

| Source | Meaning |
| --- | --- |
| `team file` | the seat's own entry in the team file writes the value |
| `team order` | the seat writes no `delivery_order`, so the team's order stands in |
| `default` | neither the seat nor the team writes the key: the release default applies |
| `none` | no value is in force and the key has no release default: the cell reads `-` |

`APPLIES` is the registry's timing for the key: `restart that resumes` for the values a CLI takes at
its next start, `at once` for the ones TeamCLI reads on its next command.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the seat's settings were printed |
| 1 | `--file` is not the caller's, or the team file declares no seat of that name |
| 2 | the invocation, the team file, or the caller's right to read this team cannot be read |

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
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
    leads: true
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    effort: max
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

The coordinator writes every key but `delivery_order`, which takes the team's order, and `human`,
which is not written anywhere and reads the default:

```console
$ team settings claude-keeper ; echo "exit $?"
  KEY             VALUE                   SOURCE     APPLIES
  model           Claude Opus             team file  restart that resumes
  effort          max                     team file  restart that resumes
  nickname        agamemnon               team file  at once
  delivery_order  mcp-inbox, drop, typed  default    at once
  human           false                   default    at once
exit 0
```

A seat that writes neither `effort` nor `nickname` reads `-` for both, `unset` for where the value
comes from:

```console
$ team settings claude-beacon ; echo "exit $?"
  KEY             VALUE                   SOURCE     APPLIES
  model           Claude Opus             team file  restart that resumes
  effort          -                       unset      restart that resumes
  nickname        -                       unset      at once
  delivery_order  mcp-inbox, drop, typed  default    at once
  human           false                   default    at once
exit 0
```

A name the team file does not declare is refused:

```console
$ team settings ghost ; echo "exit $?"
team settings: no seat "ghost" is declared in beacon
exit 1
```

`--json` carries the same values with their sources:

```console
$ team settings claude-keeper --json ; echo "exit $?"
{
  "schema": {
    "name": "team.settings",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "seat": "claude-keeper",
  "settings": [
    {
      "key": "model",
      "value": "Claude Opus",
      "source": "team file",
      "applies": "restart-resume"
    },
    {
      "key": "effort",
      "value": "max",
      "source": "team file",
      "applies": "restart-resume"
    },
    {
      "key": "nickname",
      "value": "agamemnon",
      "source": "team file",
      "applies": "at-once"
    },
    {
      "key": "delivery_order",
      "value": [
        "mcp-inbox",
        "drop",
        "typed"
      ],
      "source": "default",
      "applies": "at-once"
    },
    {
      "key": "human",
      "value": false,
      "source": "default",
      "applies": "at-once"
    }
  ]
}
exit 0
```
