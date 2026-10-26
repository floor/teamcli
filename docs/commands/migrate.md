# team migrate

Moves this team's definition from `.agents/team.yaml` into the registry, once. Every command
then reads the team from the registry (`team-config.source`, default `registry`). The file is
left in place and is no longer read; `team check` and `team status` name it if it ever says
something the registry does not. The owner runs it from a terminal outside herdr.

## Synopsis

    team migrate [--dry-run] [--json]

`--dry-run` says what would be imported and writes nothing. `--json` prints the `team.migrate`
document instead of the plain lines.

## What it reads and writes

Reads `.agents/team.yaml` in the current checkout. Writes one record,
`~/.config/team/team-config/<team id>.json`: the imported text, its digest and its canonical
record's digest. It then reads the team back through the registry and compares the canonical
records. It never deletes the team file.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | move the team |
| a run with no terminal | nothing |
| a seat, or an agent-run CLI | nothing: `team migrate: only the owner runs migrate, from a terminal outside herdr; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the team is in the registry, or would be with `--dry-run` | `<project>: imported <file> (team <id>); read back and verified` | 0 |
| refused: not the owner, no terminal, or already moved | `team migrate: <reason>`; an earlier move names `team import` | 1 |
| it can't run: a bad invocation, a team file or registry record that can't be read, or a read back that differs | `team migrate: <problem>` | 2 |

Under `--json`, a refusal writes the `team.error` document with its `contract/exit-codes.json`
id (`migrate.invocation`, `migrate.detached`, `migrate.not-owner`, `migrate.already-migrated`,
`migrate.invalid`, `migrate.registry`, `migrate.round-trip`) to stdout, leaving stderr empty.
