# team forget

Removes one or more teams from this machine's registry, in one command. The record is the
machine's note that the team exists. Forgetting it does not stop panes, close workspaces, or
delete the team file. Each team's place in any project record is dropped with it. A word that
names more than one team is refused, and so is a repeated team, so a shared project name never
deletes two teams. A bad word removes nothing. Every id in one command is one request, one card,
and one Touch ID.

## Synopsis

    team forget <id...> [--json]
    team forget <id...> --request [--json]
    team forget <id...> --approval <request-id> [--json]

Each word is a team id, a project name, or a session name.

## Who may run it

The owner, from a terminal outside herdr. `--request` records every id as one request and
removes nothing; the owner answers on the owner page. `--approval` runs that answer once. A
signed always rule for `team-forget` covering this folder admits the run with no request. A run
with no terminal and no such answer is refused:
`team forget: only the owner runs this, from a terminal outside herdr`.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the records are removed | one line per team: `team forget: forgot <id> (<project>); panes were not stopped and the team file was not deleted` | 0 |
| a request is recorded | the owner-seat request line | 0 |
| no record matches | `team forget: no team record for "<id>"` | 1 |
| the forget is refused | `team forget: <reason>` — the caller is not the owner, or the word names more than one team | 1 |
| the invocation can't be read | `team forget: <problem>` and the usage | 2 |

## Examples

```console
$ team forget ; echo "exit $?"
team forget: a team id is required
Usage: team forget <id...> [--json]
       team forget <id...> --request [--json]
       team forget <id...> --approval <request-id> [--json]

Removes every named team from this machine's registry, in one command. Each word is a team id,
a project name, or a session name; a word that names more than one team is refused, and so is a
repeated team. Each team's place in any project record is dropped with it. Panes are not stopped
and the team file is not deleted. A bad word removes nothing.

The owner runs it from a terminal outside herdr. --request records every id as one request and
removes nothing; --approval <request-id> runs it once the owner has answered on the owner page.
One card and one Touch ID cover the whole list. A signed always rule for team-forget covering
this folder admits the run with no request.

Exits 0 when the records are removed or a request is recorded, 1 when it is refused or a record
is not there, 2 when the invocation can't be read.
exit 2
$ team forget missing ; echo "exit $?"
team forget: no team record for "missing"
exit 1
$ team forget missing --json ; echo "exit $?"
{"format":1,"status":"missing","message":"no team record for \"missing\""}
exit 1
```
