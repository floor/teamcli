# team init

Creates a new team for this project.

## Usage

    team init
    team init --restore
    team init --from-archive <folder>

## What it does

`team init` writes a starter team, with one seat, into this machine's registry. Nothing is added
to the project, so there is nothing to commit. Edit the team afterwards with `team config edit`,
then start it with `team up`. An existing team is never overwritten.

## Examples

Create the team, then edit it:

```sh
team init
team config edit
```

Bring back a team from an archive `team archive` took:

```sh
team init --from-archive backups/beacon-2026-10-04
```

An agent can't create a team on its own:

```console caller=agent
$ team init ; echo "exit $?"
team init: only the owner runs this, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

## Options

| Option | Meaning |
| --- | --- |
| `--restore` | bring back the copy of the team this machine stored |
| `--from-archive <folder>` | bring back the team an archive holds |
| `--json` | print the result as JSON |

## Who can run it

The owner, from a terminal outside herdr.

## See also

[team config](config.md) · [team up](up.md) · [team migrate](migrate.md) ·
[team archive](archive.md)
