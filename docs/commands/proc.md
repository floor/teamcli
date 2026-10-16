# team proc

The processes a team's seats started, kept as a register in the team's state: one record per
name, each naming the seat that recorded it, when, the process id to watch and one line about
what it is. A seat records its own work when it hands a long run to something that outlives the
call — a build, a watch, a script — so the owner and the other seats can see what is running
without asking.

This command never launches, stops or signals a process. It writes a record; the process itself
is yours. Liveness is a reading, never a timer: a record whose `pid` is gone is skipped where it
is read, and taken out of the file by the next write to the register. A record with no `pid`
stands until `done` clears it.

`team lock` is a different thing: a machine-wide named lock, taken with a directory, for one
heavy run at a time. `team proc` names no lock and takes nothing.

## Synopsis

    team proc add <name> [--pid <pid>] [--note <text>]
    team proc list [--json]
    team proc done <name>

## What it reads and writes

Reads the team file in the current folder, and the team's state beside it. Writes one record
under `sessions[<session>].procs` in `.agents/team.state.json`:

    "procs": {
      "release-watch": {
        "by": "claude-keeper",
        "at": "2026-10-04T09:00:00.000Z",
        "pid": 4243,
        "note": "the release CI run"
      }
    }

`by` is the recording seat's name, or `owner` for the owner at a terminal. `list` and `done`
write nothing of their own, except that `add` and `done` clear the dead records they find before
they write — the one moment the file is tidied.

## Who may run it

`add` and `done` are for the owner and for a seat the team file declares. A pane with no seat,
a seat of another team, and a run with no terminal are refused. A seat may clear its own record;
a lead seat (the orchestrator's and the operator's) may clear what another seat left behind, and
the owner may clear any record — the owner's own is the owner's alone.

`list` reads what `team status` reads, through the same gate: the owner, a seat the state places
on its own pane, and an approved delegate. Anyone else gets the team's one sentence — this team
is not yours to read.

## Flags

| Flag | Meaning |
| --- | --- |
| `<name>` | the record's name: lowercase letters, digits and hyphens, at most 64 characters |
| `--pid <pid>` | the process to watch: a whole number above zero, naming a process that is running |
| `--note <text>` | one line about what the process is; a line break in it is folded to a space |
| `--json` | `list` prints the records as a document instead of rows; `add` and `done` refuse it |
| `--help`, `-h` | the usage, and exit 0 |

## Refusals

| Message | Exit |
| --- | --- |
| `team proc: a subcommand is required` (with the usage) | 2 |
| `team proc: unexpected "<word>"` (with the usage) | 2 |
| `team proc: a <name> is required` (with the usage) | 2 |
| `team proc: "<name>" is a name, not a path: lowercase letters, digits and hyphens` (with the usage) | 2 |
| `team proc: --pid is a whole number above zero, the process to watch` (with the usage) | 2 |
| `team proc: --pid needs a value` (with the usage) | 2 |
| `team proc: unknown option --<name>` (with the usage) | 2 |
| `team proc: add takes no --json`, and the same for `done` (with the usage) | 2 |
| `team proc: list takes no --pid or --note` (with the usage) | 2 |
| `team proc: only the owner runs this, from a terminal outside herdr` | 1 |
| `team proc: only a seat of this team or the owner records a process; this call is <caller>` | 1 |
| `team proc: pid <n> is not running` | 1 |
| `team proc: "<name>" is <seat>'s, live since <at>` | 1 |
| `team proc: no process named "<name>"` | 1 |
| `team proc: "<name>" is <seat>'s; only <seat>, a lead or the owner clears it` | 1 |
| `team proc: "<name>" is the owner's; only the owner clears it` | 1 |
| `team proc: this team is not yours to read` | 2 |
| `team proc: <why the team file did not load>` | 2 |

A name is refused as an invocation error, and the record is not touched. A pid that is not
running is refused before anything is written: nothing is watched on your behalf, so the record
would be a note about nothing.

## Naming, and the name a seat holds

`add` takes a name an earlier record holds in one case: the caller's own record, which it
replaces, and any record whose process is gone, which anyone may take. A name another seat holds
and whose process is still alive is refused — the two `add`s would otherwise take turns
overwriting each other, and `list` would name one process where two run.

Two seats that each want a record for the same kind of work spell the names apart:
`release-watch` and `release-build`, or the seat's own name in it.

## Exit codes

- `0` — the process was recorded, the record was cleared, or the records were listed.
- `1` — a refusal: the caller, the pid, a name another seat holds, a name no record holds, or a
  record another seat holds.
- `2` — the invocation can't be read, or the team file can't.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
operator: claude-keeper
trust:
  - ~/.config/team/lobby
  - ~/Code/beacon
workspace:
  mode: shared
seats:
  - role: coordinator
    name: claude-keeper
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: claude-desk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

The owner records a run with no pid to watch, and a seat records the build it started — `4243`
stands for a process of your own here, and it must be running (`--pid 4244` would be refused):

```console
$ team proc add release-watch --note "the release CI run"
proc release-watch: added
```

```console caller=claude-desk
$ team proc add release-build --pid 4243 --note "the release build"
proc release-build: added
```

```console
$ team proc list
release-build  claude-desk  since 2026-10-04T09:00:00.000Z  pid 4243  the release build
release-watch  owner  since 2026-10-04T09:00:00.000Z  the release CI run
```

`--json` is the same records as a document, in the order the rows are printed:

```console
$ team proc list --json
{
  "format": 1,
  "procs": [
    {
      "name": "release-build",
      "by": "claude-desk",
      "at": "2026-10-04T09:00:00.000Z",
      "pid": 4243,
      "note": "the release build"
    },
    {
      "name": "release-watch",
      "by": "owner",
      "at": "2026-10-04T09:00:00.000Z",
      "note": "the release CI run"
    }
  ]
}
```

`team status` carries the same records as notes, after the notes the reading already had:

```console
$ team status
team beacon, session "beacon"
  claude-keeper  idle  Claude Opus 5.5  w1:p1
  claude-desk    idle  Claude Opus 5.5  w2:p1
note: proc release-watch: owner since 2026-10-04T09:00:00.000Z
0 difference(s)
```

A second seat may not take a live name. The record stays where it is:

```console caller=claude-keeper
$ team proc add release-build ; echo "exit $?"
team proc: "release-build" is claude-desk's, live since 2026-10-04T09:00:00.000Z
exit 1
```

The seat that recorded it clears it. A name no record holds is refused, and another seat's live
record is not the caller's to clear:

```console caller=claude-desk
$ team proc done release-build
proc release-build: done
$ team proc done release-build ; echo "exit $?"
team proc: no process named "release-build"
exit 1
$ team proc done release-watch ; echo "exit $?"
team proc: "release-watch" is the owner's; only the owner clears it
exit 1
```

The owner clears what is left, and a name that steps outside the rule is refused before the
state is read:

```console
$ team proc done release-watch
proc release-watch: done
$ team proc list
no processes recorded
$ team proc add build/step ; echo "exit $?"
team proc: "build/step" is a name, not a path: lowercase letters, digits and hyphens
Usage: team proc add <name> [--pid <pid>] [--note <text>]
       team proc list [--json]
       team proc done <name>
exit 2
```
