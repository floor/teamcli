# team migrate

Moves a team from `.agents/team.yaml` into the registry.

## Usage

    team migrate
    team migrate --dry-run
    team migrate --keep-file

## What it does

Teams made before 0.5.5 lived in `.agents/team.yaml`. `team migrate` copies that file into this
machine's registry, reads it back to check nothing changed, and then moves the file to the
Trash. It never deletes the file. Your approval stays valid. Run it once in each project;
running it again is safe.

## Examples

See what it would do, then move the team:

```sh
team migrate --dry-run
team migrate
# beacon: imported .agents/team.yaml (team <id>); read back and verified
# .agents/team.yaml was moved to the Trash; edit the team with team config
```

Keep the old file where it is:

```sh
team migrate --keep-file
```

## Options

| Option | Meaning |
| --- | --- |
| `--dry-run` | show what would be imported and moved, and change nothing |
| `--keep-file` | import the team, but leave `.agents/team.yaml` in place |
| `--json` | print the result as JSON |

## Who can run it

The owner, from a terminal outside herdr.

## See also

[team import](import.md) · [team config](config.md) ·
[Moving to 0.5.5](../../UPGRADE-0.5.5.md)
