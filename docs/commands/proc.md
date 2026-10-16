# team proc

The processes a team's seats started, kept as a register in the team's state: one record per name,
each naming the seat that recorded it, when, the process id to watch and one line about what it is.
It never launches, stops or signals a process, and it names no lock.

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
| `add`, `done` | the owner, or a seat the team file declares: a seat clears its own record, a lead seat (the orchestrator's and the operator's) or the owner clears what another seat left, and the owner's own record is the owner's alone. A pane with no seat, a seat of another team, and a run with no terminal are refused |
| `list` | what `team status` reads, through the same gate: the owner, a seat the state places on its own pane, and an approved delegate |

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| the process was recorded | `proc <name>: added` | 0 |
| the record was cleared | `proc <name>: done` | 0 |
| the records were listed | one row per live record — `<name>  <by>  since <at>`, then `pid <n>` and the note when the record carries them — or `no processes recorded`; `--json` prints a document (`format: 1`, `procs`) | 0 |
| a refusal: the caller, a pid that is not running, a name another seat holds, a name no record holds, or a record another seat holds | `team proc: <problem>` | 1 |
| the invocation can't be read, or the team file can't | `team proc: <problem>`, with the usage | 2 |

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

```fixture
caller: owner
state:
  procs:
    release-watch:
      by: owner
      at: "2026-10-04T09:00:00.000Z"
      note: "the release CI run"
```

The register, read back — this record carries no pid, so it stands until `done` clears it:

```console
$ team proc list
release-watch  owner  since 2026-10-04T09:00:00.000Z  the release CI run
```

Rationale, behaviour, refusals and known limits: [docs/internal/proc.md](../internal/proc.md).
