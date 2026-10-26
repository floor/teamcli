# team migrate: full reference

The complete behaviour of `team migrate`: every flag, refusal, outcome and exit code. The
short page is [docs/commands/migrate.md](../../commands/migrate.md). Every example here runs in `bun test`.

Moves this team's definition from `.agents/team.yaml` into the registry, and retires the file.
The team is imported, read back through the registry and compared with the file by canonical
record (`team-record-c14n-v1`); only once that round trip verifies is `.agents/team.yaml` moved to
the system Trash. When no Trash can be reached (no `/usr/bin/trash` on macOS, no `gio` on
Linux), the file is renamed beside itself to `.agents/team.yaml.migrated` instead. It is never
deleted. Every command then reads the team from the registry (`team-config.source`, default
`registry`), and [`team config`](../../commands/config.md) edits it. The owner runs it from a terminal outside
herdr.

The approval stays in force across the move: it is signed over the team's canonical record, not
over the file's text (0.5.5), and the registry holds the same record. When a verified approval was
in force before the run, the run says it still is.

## Synopsis

    team migrate [--keep-file] [--dry-run] [--json]

`--keep-file` imports and verifies, and leaves `.agents/team.yaml` where it is; it is no longer
read, `team up`, `team check` and `team status` name it in one line, and a later `team migrate`
retires it. `--dry-run` says what would be imported and moved, and writes nothing. `--json`
prints the `team.migrate` document instead of the plain lines; it carries `file` (`trash`,
`renamed`, `kept` or `absent`), `file_moved_to` and `approval` (the standing after the run).

## Run again

A run on a team the registry already holds is safe:

- no file is left: it says the registry already holds the team, and exits 0;
- a file is left that says what the registry says: the file is retired as a first run would
  retire it, and it exits 0;
- a file is left that says something else: it is refused (`migrate.already-migrated`), and
  [`team import`](../../commands/import.md) replaces the registry's record with that file when that is what you
  want.

## What it reads and writes

Reads `.agents/team.yaml` in the current checkout. Writes one record,
`~/.config/team/team-config/<team id>.json`: the imported text, its digest and its canonical
record's digest. It then reads the team back through the registry and compares the canonical
records, and only then moves the file to the Trash (or renames it).

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | move the team |
| a run with no terminal | nothing |
| a seat, or an agent-run CLI | nothing: `team migrate: only the owner runs migrate, from a terminal outside herdr; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the team is in the registry, or would be with `--dry-run` | `<project>: imported <file> (team <id>); read back and verified`, then `.agents/team.yaml was moved to the Trash; edit the team with team config` (or `was renamed to …`, or `was kept (--keep-file)`) | 0 |
| refused: not the owner, no terminal, or a leftover file that differs from the registry | `team migrate: <reason>`; a differing file names `team import` | 1 |
| it can't run: a bad invocation, a team file or registry record that can't be read, or a read back that differs | `team migrate: <problem>` | 2 |

Under `--json`, a refusal writes the `team.error` document with its `contract/exit-codes.json`
id (`migrate.invocation`, `migrate.detached`, `migrate.not-owner`, `migrate.already-migrated`,
`migrate.invalid`, `migrate.registry`, `migrate.round-trip`) to stdout, leaving stderr empty.
