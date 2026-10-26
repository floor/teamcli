# team import

Makes a team file this team's registry record: `.agents/team.yaml` when no file is named. It is
the repair `team check` and `team status` name when a leftover team file says something the
registry does not, and the first import when `team migrate` was not run. The owner runs it from
a terminal outside herdr.

## Synopsis

    team import [<file>] [--dry-run] [--json]
    team import [<file>] --request [--json]
    team import [<file>] --approval <request-id> [--dry-run] [--json]

`<file>` is the team file to import for this checkout's team. `--dry-run` says what would be
imported and writes nothing. `--json` prints the `team.import` document instead of the plain lines.
`--request` records this import for the owner seat and `--approval <request-id>` runs it once the
owner seat signed for it, with no owner terminal: see
[team up: Owner-seat approval](up.md#owner-seat-approval-no-owner-terminal).

## What it reads and writes

Reads the named team file, or `.agents/team.yaml`. Writes, or replaces, the team's record at
`~/.config/team/team-config/<team id>.json`, then reads the team back through the registry and
compares the canonical records. It never deletes the team file. A record that already holds the
same definition is left as it is.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | import the file |
| a run with no terminal | nothing |
| a seat, or an agent-run CLI | nothing: `team import: only the owner runs import, from a terminal outside herdr; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the registry holds the file, or would with `--dry-run` | `<project>: imported <file> (team <id>); read back and verified`, or `the registry already holds <file>` | 0 |
| refused: not the owner, or no terminal | `team import: <reason>` | 1 |
| it can't run: a bad invocation, a team file that is missing or does not validate, or a read back that differs | `team import: <problem>` | 2 |

Under `--json`, a refusal writes the `team.error` document with its `contract/exit-codes.json`
id (`import.invocation`, `import.detached`, `import.not-owner`, `import.invalid`,
`import.round-trip`) to stdout, leaving stderr empty.
