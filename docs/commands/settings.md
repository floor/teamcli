# team settings

One seat's settings, each with where its value comes from: a signed settings record at the seat,
team, project or entity level; the team file; the team's own order standing under a seat that
writes none; the release default; or `unset`. The read is the team file, the signed records in the
registry, and the registry's key list (`team config keys`); it writes nothing. `set` and `unset`
record one seat's setting as a signed record in the seat's agent file.

A setting is a value, not a permission. `team settings` shows no value it would not accept: the
`model` it prints is the value the file decides, or `unset` when the field is empty or the
launcher chooses the model, and `team config keys` names the `allowed-models` policy that bounds
it.

## Synopsis

    team settings <seat> [--file <path>] [--json]
    team settings set <seat> <key> <value> [--file <path>] [--dry-run] [--json]
    team settings set <seat> <key=value> [<key=value> …] [--dry-run] [--json]
    team settings unset <seat> <key> [--file <path>] [--dry-run] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's |
| `--json` | — | print a JSON document (`format: 1`, `project`, `seat`, `settings`), one entry per key with `value`, `source` and `applies`, and `source_file` when a signed record wins the key; the write forms print `team.settings-change` |
| `--dry-run` | — | the write forms: print the change and write nothing |
| `--help`, `-h` | — | the usage, and exit 0 |

## Writing a setting

`team settings set` takes one `<key> <value>` pair, or several `<key>=<value>` words, and records
them together as one signed generation in the seat's agent file; `team settings unset` removes
one key, and the level below shows through again. Only the owner writes. The value passes the
same checks the read describes: the key must be one a seat holds (`model`, `effort`, `nickname`,
`delivery_order`, `human`), a model must be one the seat's launch profile names — it is recorded
as the launch id — an effort must be one the seat's vendor
carries, and a nickname must not clash with another seat's name or nickname — the word another seat
signed standing where its file word does, so a signed word is what a new one is checked against. A
governed key then
passes the policy in force over the seat: a value that drops or reorders the delivery order is
within, one that adds a leg the policy does not is refused.

The change is signed, appended to the team log, and raised as `config.changed` with the setting's
generation; a failed event append leaves the written record in place and the reconcile pass adds
the missing event. A dry run prints the same summary with `would set`/`would unset` and stops
before any record, setting, generation or event is written.

A seat the team file declares that has never launched has no agent record yet. The first
successful `set` aimed at it creates that record, seeded from the seat's declaration — its name,
signing words, lab, CLI and launch line, with no pane, session or state — and signs the setting
there; a later launch finds the same record and keeps its id, so the settings signed before it
stay with the seat's agent. The create is the record, not a launch: nothing starts, attaches or
types. A preview and a refused write create nothing: a `--dry-run`, an unknown key or value, a
policy refusal and a nickname collision leave the registry, the settings, the generation and the
event log as they were. An unset on such a seat reports the setting is not set and creates
nothing either. A printed `team settings <seat>` reads the declaration and the team's records
without creating anything.

`team settings set lead nickname=Ada` therefore works on a declared seat before its first
launch, and the `settings.no-agent` refusal is left for a registry that cannot hold the record at
all, such as a path that is not a directory.

## Where a value comes from

| Source | Meaning |
| --- | --- |
| `seat record` | a signed record at the seat level writes the value, ahead of the seat's team-file entry |
| `team record` | a signed record at the team level writes it, unless the seat's own entry does |
| `project record` | a signed record at the project level writes it, under any nearer level |
| `entity record` | a signed record at the entity level writes it, under any nearer level |
| `team file` | the seat's own entry in the team file writes the value |
| `team order` | the seat writes no `delivery_order`, so the team's order stands in |
| `default` | neither the seat nor the team writes the key: the release default applies |
| `none` | no value is in force and the key has no release default: the cell reads `-` |

`APPLIES` is the registry's timing for the key: `restart that resumes` for the values a CLI takes at
its next start, `at once` for the ones TeamCLI reads on its next command. A signed `model` or
`effort` is recorded for a launch to read; this release records it without yet applying it at
launch, so that timing is declared for those two keys, not performed. A signed `nickname` is
the name `team send` prints and addresses (`@<nickname>`, `<nickname>@<team>`, `team send --list`)
in place of the team file's; a signed `delivery_order` and `human` are the words the next send
walks. The replaced file word addresses nobody.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the seat's settings were printed, a write was recorded, or a dry run printed its change |
| 1 | `--file` is not the caller's, the team file declares no seat of that name, a write is not the owner's, the seat's agent record cannot be created, a policy forbids the value, or an unset names a setting that is not set |
| 2 | the invocation, the team file, the caller's right to read this team, a signed settings record cannot be read, a value is outside what the seat's profile accepts, or the record cannot be written |

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
  delivery_order  mcp-inbox, typed, drop  default    at once
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
  delivery_order  mcp-inbox, typed, drop  default    at once
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
        "typed",
        "drop"
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
