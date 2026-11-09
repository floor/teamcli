# team launchers migrate

Moves a team's repository or temporary launch scripts onto launcher declarations. The owner,
or a lead of this team, runs it from a terminal in the team's folder.

## Synopsis

    team launchers migrate [--dry-run] [--json]

`--dry-run` lists changes, missing scripts and scripts needing a mapping, and writes nothing.
Without it, migration applies the listed changes. `--json` reports the same rows in a
`launchers.migrate` document.

## Local script choices

The package recognizes generic provider launch scripts. Every other script needs an explicit
choice in the owner's local `~/.config/team/launcher-migrations.json`. Migration reads this map;
it never creates or edits it. The map must be a regular file owned by the current user, with no
group or other write permission. A symbolic link, an unreadable file or invalid content refuses
the migration before any writes. An absent map means no local choices.

First place a declaration in the launcher home, such as
`~/.config/team/launchers/local-review.json`:

```json
{
  "name": "local-review",
  "harness": "grok",
  "argv": ["grok"]
}
```

Then write the local map with the exact absolute script path:

```json
{
  "format": 1,
  "scripts": {
    "/work/fixture-tools/launch-review.sh": "local-review"
  }
}
```

Keys are absolute paths, normalized without following links. Values name declarations already
validated in the launcher home. A similarly named script at another path is not mapped. The
map can also name an extensionless script. A missing declaration leaves the row unmapped;
migration never infers a CLI, account or identity from the script's name or contents.

An unmapped row names the map path and its format so the owner can make the choice. It remains
unchanged. A script that is gone is reported as stale, and its records are kept.

## What it reads and writes

Reads this team's launch lines, its active agent records, the launcher declarations and the
local migration map. It checks script paths and metadata, and never reads their contents,
secrets or environment values to classify them.

Apply writes new generic declarations, rewrites each selected seat's launch scalar through the
record editor, updates matching agent launch records and leaves a forwarding stub at each
selected script. Existing owner declarations and the local map are left unchanged. Unknown
and stale rows are not rewritten or deleted.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | the dry-run rows were listed or the selected changes applied; unmapped and stale rows may remain |
| 1 | admission, the map, the launcher home or a write was refused |
| 2 | the invocation or team could not be read |
