# team config

Two things: the team's own record, read and edited with `get`, `set`, `unset` and `edit` — what
`.agents/team.yaml` used to hold, before [`team migrate`](migrate.md) moved it into the registry —
and the settings registry, printed with `keys`.

## The team's record: get, set, unset, edit

    team config get <path> [--json]
    team config set <path> <value>
    team config unset <path>
    team config edit

`<path>` is dotted keys into the record. Under a list, a segment names the item by its `name`, or
by its index: `project`, `watch.unread_after`, `seats.lead.model`, `seats.0.cli`. `<value>` is
read as YAML — a number, `true`, a one-line `[list]` or `{map}` — and otherwise as text.
`edit` opens the record as YAML in `$VISUAL` (else `$EDITOR`, else `vi`), and writes it back when
the editor exits 0 and the edited text validates.

Every write is validated by the team-file validator (the schema at `schema/team.schema.json` and
the rules behind it) before it is stored, and refused whole when it does not validate: nothing is
written. An `edit` that does not validate is kept in its temporary file, and the refusal names it.
`set` and `unset` rewrite the record's text, so its comments are not kept; `edit` edits the text
itself and keeps them. A record the registry holds is written there (`edited_by: config <verb>`);
on the legacy `file` source the team file is written instead.

Writes are the owner's, from a terminal outside herdr, as editing the file was; `get` is any
caller's. A change to an owner section leaves the approval stale exactly as a hand edit of the
file did — the approval is compared by canonical record — and the run names what the approval no
longer covers: `the approval no longer covers: …; approve the team again with the owner seat`.

| Outcome | Exit |
| --- | --- |
| a value printed, a change written, or nothing to change | 0 |
| the path holds nothing (`get`), cannot be set, the caller is not the owner, or the change does not validate | 1 |
| a bad invocation, no team found, a record that cannot be read, or the editor failed | 2 |

## The settings registry: keys

The settings registry: which settings TeamCLI knows, the levels each may be set at, what each
accepts, its release default, the policy that governs it, and when a change takes effect. The
command reads the registry and the filesystem does not answer it; it is the reference a `team
settings` value is read against, and it writes nothing.

Settings are values; policies are limits. A setting never loosens a policy: the `model` a seat may
be set to is bounded by the `allowed-models` policy, and a `delivery_order` may only tighten the
order in force. The registry names the policy on each row so the two can be told apart.

## Synopsis

    team config keys [<level>] [--json]

## The keys

| Key | Level | Accepts | Default | Governed by | Applies |
| --- | --- | --- | --- | --- | --- |
| `model` | seat | a model the seat's profile and the `allowed-models` policy accept | unset | `allowed-models` | the CLI's next start: a restart that resumes |
| `effort` | seat | one of the CLI profile's effort levels | unset | — | the CLI's next start: a restart that resumes |
| `nickname` | seat | unique in the team, never `lead` | unset | — | at once |
| `delivery_order` | seat | delivery legs, tighten only | the team's order, else `mcp-inbox, typed, drop` | `delivery-order` | at once |
| `human` | seat | true or false | false | — | at once |

`restart that resumes` is what `team restart` does for a CLI that keeps its session: the value is
handed to the CLI at its next start. `at once` is a value TeamCLI reads on its next command with no
restart.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<level>` | `entity`, `project`, `team` or `seat` | list only the keys a setting may be made at that level; a level with no registered keys prints that in one line |
| `--json` | — | print a JSON document (`format: 1`, `level`, `keys`), one entry per key with `levels`, `type`, `allowed`, `default`, `governed_by` and `applies` |
| `--help`, `-h` | — | the usage, and exit 0 |

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the registry was listed |
| 2 | the invocation is not one of the command's forms |

## Example

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

Every key is a seat key today, so `seat` lists them all and a level above a seat has none yet:

```console
$ team config keys team ; echo "exit $?"
no settings are registered at team level
exit 0
```

`--json` carries the same fields:

```console
$ team config keys seat --json ; echo "exit $?"
{
  "schema": {
    "name": "team.config-keys",
    "version": 1
  },
  "format": 1,
  "level": "seat",
  "keys": [
    {
      "key": "model",
      "levels": [
        "seat"
      ],
      "type": "model",
      "allowed": "a model the seat's profile and the allowed-models policy accept",
      "default": null,
      "governed_by": "allowed-models",
      "applies": "restart-resume"
    },
    {
      "key": "effort",
      "levels": [
        "seat"
      ],
      "type": "effort",
      "allowed": "one of the CLI profile's effort levels",
      "default": null,
      "governed_by": null,
      "applies": "restart-resume"
    },
    {
      "key": "nickname",
      "levels": [
        "seat"
      ],
      "type": "nickname",
      "allowed": "unique in the team, never lead",
      "default": null,
      "governed_by": null,
      "applies": "at-once"
    },
    {
      "key": "delivery_order",
      "levels": [
        "seat"
      ],
      "type": "order",
      "allowed": "delivery legs, tighten only",
      "default": [
        "mcp-inbox",
        "typed",
        "drop"
      ],
      "governed_by": "delivery-order",
      "applies": "at-once"
    },
    {
      "key": "human",
      "levels": [
        "seat"
      ],
      "type": "boolean",
      "allowed": "true or false",
      "default": false,
      "governed_by": null,
      "applies": "at-once"
    }
  ]
}
exit 0
```
