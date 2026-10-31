# team agents

This machine keeps one agent record for every agent TeamCLI launched or registered: the agent's
signed settings, the seat and team it reaches, and its lifecycle. The records are append-only. A
record no seat uses is retired — a recorded lifecycle state — and never deleted, so its signed
settings stay readable.

`team agents prune` lists every record no team roster names and says what it would do with it.
With `--apply` it retires the ones whose seat is gone. `team remove` retires a removed seat's
record the same way, in that command's own run.

## Synopsis

    team agents prune [--apply] [--json]

`prune` is the only verb. A dry run changes nothing; `--apply` retires every listed record it
would retire.

## What a listed record is

| State | Meaning | What `--apply` does |
| --- | --- | --- |
| `orphaned` | no roster line names it, and the team file declares no seat by that name | retires it, marking the time it was found orphaned |
| `superseded` | another agent holds the seat in the team roster | retires it |
| `declared` | the team file declares the seat and it has not launched yet | leaves it — retiring it would break the identity its grants name |
| `unverified` | the team's configuration could not be read, so its seats were not judged | leaves it |
| `unregistered` | the team registry holds no record of this team | leaves it — `team forget` leaves records behind, and a later registration reuses one |

A record a roster names is not listed at all: it holds a seat. A record already retired is
listed with the action `none`, so a team cleaned up once does not keep the dry run failing. Each
listed record is one row: the agent, the seat, the team's project, its lifecycle, its state, and
the action `--apply` would take.

Retiring keeps every field of the record — its signing among them — and clears the pane the
record reaches. The record stays in the agents folder and stays readable.

## Who may run it

Any caller may read the dry run. `--apply` is the owner's, from a terminal rather than a seat's
pane; a caller that is not the owner is refused, and nothing is written.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the dry run finds nothing to retire | `no agent record stands without a roster line`, or the summary ending `none to retire` | 0 |
| `--apply` retires every listed record it would retire | the summary ending `N records retired` | 0 |
| the dry run finds records to retire | the summary ending `N records to retire` | 1 |
| `--apply` leaves a record unretired | the summary ending `N records could not be retired` | 1 |
| `--apply` is refused | `team agents: <reason>` — the caller is not the owner | 1 |
| the team registry can't be read | `team agents: <reason>` | 1 |
| the invocation can't be read | `team agents: <problem>` and the usage | 2 |

## Examples

```console
$ team agents prune ; echo "exit $?"
no agent record stands without a roster line
exit 0
$ team agents ; echo "exit $?"
team agents: a subcommand is required (prune)
Usage: team agents prune [--apply] [--json]

Lists one line per agent record this machine holds that no team roster names: the agent, the
seat and team it reaches, its lifecycle, why no roster names it, and what `prune` would do with
it. A record a roster names is not listed.

Retiring is a recorded state, never a delete: the record keeps every field, its signed settings
among them, and stays readable. A record whose seat is gone from a team whose configuration can be
read is marked with the time it was found orphaned. Three kinds are listed and left alone: a seat
the team's configuration still declares (it has not launched yet), a record whose team the registry
no longer holds (`team forget` leaves records behind), and a record whose team's configuration
cannot be read.

`--apply` retires every listed record it would retire; without it nothing is written. It is the
owner's, from a terminal rather than a seat's pane.

Exits 0 when the dry run finds nothing to retire or `--apply` retires every record it listed, 1
when the dry run finds records to retire, `--apply` is aimed by a caller who is not the owner, a
record cannot be written, or the team registry can't be read, 2 when the invocation can't be read.
exit 2
$ team agents prune --json ; echo "exit $?"
{
  "schema": {
    "name": "team.agents",
    "version": 1
  },
  "format": 1,
  "apply": false,
  "records": [],
  "counts": {
    "listed": 0,
    "orphaned": 0,
    "superseded": 0,
    "declared": 0,
    "unverified": 0,
    "unregistered": 0,
    "to_retire": 0,
    "retired": 0,
    "unchanged": 0,
    "failed": 0
  }
}
exit 0
```
