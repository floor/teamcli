# team config

Three things: the team's own record, read and edited with `get`, `set`, `unset` and `edit` — what
`.agents/team.yaml` used to hold, before [`team migrate`](migrate.md) moved it into the registry —
two keys of the owner's entity record, `<entity>.names.unique` and `<entity>.reminders`; and the
settings registry, printed with `keys`.

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
`set` and `unset` rewrite only the lines of the key they change, so the record's comments — above
the key, beside it and below it — are kept byte for byte; a comment beside or inside a value the
change removes stays as a comment line where it was. A key a line-by-line change cannot reach
makes the command rewrite the record whole, which does not keep its comments; the command says so
on stderr (`comments_kept: false` in `--json`). `edit` edits the text and keeps the comments it
leaves.
A record the registry holds is written there (`edited_by: config <verb>`);
on the legacy `file` source the team file is written instead.

Writes are the owner's, from a terminal outside a pane, as editing the file was; `get` is any
caller's. One unset is the exception: a team's `leads` seat clears its own team's stopped mark —
`team config unset seats.<seat>.stopped` — with no card, dev mode on or off, the same seat that
may revive it with `team restart <seat>`. Every other key keeps the owner's door. The change is
validated by the team-file validator before it is stored; the record it stores is the record the
team runs.

| Outcome | Exit |
| --- | --- |
| a value printed, a change written, or nothing to change | 0 |
| the path holds nothing (`get`), cannot be set, the caller is not the owner, or the change does not validate | 1 |
| a bad invocation, no team found, a record that cannot be read, or the editor failed | 2 |

## The entity's record: names.unique and reminders

    team config get <entity>.names.unique [--json]
    team config set <entity>.names.unique <word>
    team config set <entity>.names.unique <word> --general <grant.json> --key <client.key> [--json]
    team config get <entity>.reminders [--json]
    team config set <entity>.reminders <yaml list>
    team config set <entity>.reminders <yaml list> --general <grant.json> --key <client.key> [--json]

A path whose last segment is `names.unique` or `reminders` names one key of an entity's own
entry, not the team's record. Both live with the rest of the entry in the owner's entities file
(`~/.config/team/entities.yaml`), and the form reads no team, so it runs outside a checkout and
the entity name may itself carry dots (the last segment is the key).

`<entity>.names.unique` says how far apart seat nicknames stay — `entity` (the default, across
every team of the entity), `project` (within one project), `team` (within one team) or `off`.
[`team init`](init.md) and the nicknames `team config set` places on a seat's label read it.

`<entity>.reminders` is the list [`team daemon`](daemon.md) fires: one YAML list of reminders,
each a `name`, at least one `at` time and the seats it addresses `to`, with an optional `zone`,
`catchUp` and `text`. The value is one-line YAML and must be a list; `[]` clears the entity's
reminders, and there is no unset. The list is held to the daemon's own parser on the exact text
that would be written: a bad field, a missing text, an address that is not `<seat>@<team>`, or a
name another entity already holds refuses the write with the parser's own sentence, and nothing
is written. A problem the file already carried on another entity never blocks the write; one on
the entity being written does, whatever the file carried before, because the stored text must be
one the daemon reads whole.

The form edits that one key of an entry the file already declares: it creates no entry, keeps
every other line (comments included) and writes nothing else; a word outside the four is refused
with the four named before any file is opened. `get` is any caller's and prints what the entry
spells — a word the check does not spell is printed as the file has it, with a note on stderr that
the default is in force.

A set is the owner's, at a terminal, or a seat's under the owner's general grant: 0.5.10 admits a
wildcard grant only, so one that lists entities is refused until 0.5.11, and the grant's
operations must admit `config`. The charter is the owner's word for one folder and does not reach
it. There is no owner-seat request for this word: the grant is the standing answer, and the owner
sets it directly when no grant admits it.

| Outcome | Exit |
| --- | --- |
| the key printed, set, or already written | 0 |
| the caller is neither the owner nor admitted by the grant, the word is not one of the four, a reminder list the parser refuses, or the file declares no such entry or key | 1 |
| the invocation is not one of the forms, or the entities file cannot be read | 2 |

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
| `delivery_order` | seat | delivery legs, tighten only | the team's order, else `typed, drop` | `delivery-order` | at once |
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
  KEY             LEVELS  ALLOWED                                                          DEFAULT      GOVERNED BY     APPLIES
  model           seat    a model the seat's profile and the allowed-models policy accept  -            allowed-models  restart that resumes
  effort          seat    one of the CLI profile's effort levels                           -            -               restart that resumes
  nickname        seat    unique in the team, never lead                                   -            -               at once
  delivery_order  seat    delivery legs, tighten only                                      typed, drop  delivery-order  at once
  human           seat    true or false                                                    false        -               at once
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
