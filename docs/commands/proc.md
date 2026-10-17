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

## Flags

| Flag | Meaning |
| --- | --- |
| `<name>` | the record's name: lowercase letters, digits and hyphens, at most 64 characters |
| `--pid <pid>` | the process to watch: a whole number above zero, naming a process that is running |
| `--note <text>` | one line about what the process is; a line break in it is folded to a space |
| `--json` | `list` prints the records as a document instead of rows; `add` and `done` refuse it |
| `--help`, `-h` | the usage, and exit 0 |

## Who may run it

| Subcommand | Caller |
| --- | --- |
| `add` | the owner at a terminal outside herdr, or a seat the team file declares; a seat replaces its own record, and any caller may take a name whose process is gone |
| `done` | the recording seat, a lead seat (orchestrator or operator) for another seat's record, or the owner for any record; the owner's own record is the owner's alone |
| `list` | the owner, a seat the state places on its own pane, or an approved delegate — the same gate as `team status` |

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

## Exit codes

- `0` — the process was recorded, the record was cleared, or the records were listed.
- `1` — a refusal: the caller, the pid, a name another seat holds, a name no record holds, or a
  record another seat holds.
- `2` — the invocation can't be read, or the team file can't.

## Example

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

```console caller=claude-desk
$ team proc done release-build
proc release-build: done
$ team proc list
release-watch  owner  since 2026-10-04T09:00:00.000Z  the release CI run
```

What it reads and writes, how a seat holds a name, the JSON document, and the refusal examples: [docs/internal/proc.md](../internal/proc.md).
