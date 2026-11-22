# team names

Names the seats that have no name. `team names fill` gives every seat of the team that writes no
`nickname` and whose label is not of the form `<Name> · <role>` the first free name of its entity's
`names.pool`, in file order — the step [`team add`](add.md) and [`team up`](up.md) take for a seat
at its launch while the entity's `names.auto` is on. It runs whatever `names.auto` says: asking for
a fill is asking for names. See [Names handed out](../team-file.md#names-handed-out) for the pool,
the order and the uniqueness rule.

## Synopsis

    team names fill [--dry-run] [--json]
    team names fill --entity <name> [--dry-run] [--json]

| Flag | Value | What it does |
| --- | --- | --- |
| `--dry-run` | — | prints the plan and writes nothing |
| `--entity` | an entity name | fills every registered team of that entity, one after the other, so no two take one name |
| `--json` | — | prints the `team.names-fill` document below instead of the plain lines |

## What it reads and writes

It reads the team's record (the team the current folder is a registered place of) and the
registry's other teams, whose nicknames a new name passes over, and the entity's `names` words in
the owner's `entities.yaml`. A real run writes each named seat's `nickname:` and its
`label: "<Name> · <role>"` (keeping the part after a written label's middle dot, or a label with
no dot whole: `Gemini tester` becomes `<Name> · Gemini tester`) through
[`team config edit`](config.md)'s own write: validated whole, held to the entity's `names.unique`
word, and the roster's names refreshed at once, so the next message header carries the name. A seat
with a nickname, or a label `<Name> · <role>` whose name part is not the seat's own name, is never
renamed; a label with no middle dot is a description, not a name. A `human` seat and a counted
entry are not named. A registered team whose folder is gone prints
`<team>: its record is gone; skipped` (`"skipped": true` in the JSON) and changes no exit.

## Who may run it

The real run is `team config edit`'s: the owner from a terminal outside herdr, a charter that
covers the folder, or dev mode's admission, with the same refusal for every other caller, and
nothing written. A dry run reads and is any caller's.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| names written, or every seat already has one | one line per named seat, `<team>: <seat> → <Name>`, or `<team>: every seat has a name` | 0 |
| a dry run | `dry run: nothing was written`, then the same lines | 0 |
| a team's write is refused, or its pool has no free name | `team names: <team>: <reason>` on stderr; the other teams of an `--entity` run are still filled | 1 |
| `--entity` names an entity with no registered team | `team names: entity "<name>" has no registered team` | 1 |
| a bad invocation, or the registry or the team's place can't be read | `team names: <problem>`, with the usage for a bad invocation | 2 |

Under `--json`, the document is:

    {
      "schema": { "name": "team.names-fill", "version": 1 },
      "format": 1,
      "dry_run": false,
      "teams": [
        {
          "team": "<team>",
          "written": true,
          "assignments": [{ "seat": "<seat>", "nickname": "<Name>", "label": "<Name> · <role>" }],
          "problem": null
        }
      ]
    }
