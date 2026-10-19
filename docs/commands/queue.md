# team queue

Adds one record to the team's local task queue, or lists it. The local queue is the task source
only when the team file declares none: then `.agents/queue.yaml` under the team root. A team that
declares a file source is written at its own path, and a team that declares a broker source
(`linear`) has no local queue at all — this command never writes the tracker.

The same verb records the two green-slice events in `.agents/green-slices.json`: a seat marks a
finished, green commit `ready` for the task whose live lease it holds, and the owner — or the one
seat the approved team file designates with `installer:` — acknowledges that commit `install`ed.
A ready slice is covered only by an install record: no merge, clock or version comparison is
evidence of one, and recording an install installs nothing itself.

An id already queued is present and is not rewritten; the same id with another record is refused.
The add is atomic: the whole candidate file is read back through the file adapter before it
replaces the queue, so a file the reader would refuse is never installed. A listing claims
nothing, writes nothing, and asks no caller.

## Synopsis

    team queue add <title> --id <id> [--assignee <name>] [--priority <value>] [--json]
    team queue list [--json]
    team queue ready <task> --commit <sha> [--version <version>] [--json]
    team queue install <task> --commit <sha> [--version <version>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--id` | a task id | required by `add`; letters, digits, dot, dash or underscore, starting with a letter or digit |
| `--assignee` | a seat name | required to name a declared seat of this team |
| `--priority` | text or a number | a plain number is written as a number, so `team next` orders it numerically; any other one-line text stays text |
| `--commit` | a git commit | required by `ready` and `install`; 7 to 40 lowercase hex digits |
| `--version` | a version token | the build the slice belongs to; the running version when omitted |
| `--json` | — | one `team.queue` or `team.green-slice` document on stdout instead of the context line and block |
| `--help`, `-h` | — | the usage, and exit 0 |

`list` takes no valued option and no second word. `add` takes exactly one title after the verb;
`ready` and `install` take exactly one task.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | add, install |
| a declared seat of this team, on the pane the state records for that seat | add; `ready`, for a task it holds the live lease of |
| the seat the approved team file names in `installer:`, on its recorded pane | install |
| any caller | list |
| a seat of another team, a seat the state cannot place, or a name that is not a seat | nothing on `add`: `team queue: only the owner or a seat of this team adds to the queue; this call is <caller>` |
| the owner, or a caller that is not a declared seat of this team | nothing on `ready`: `team queue: only a seat of this team records a green slice ready; this call is <caller>` |
| a seat that is not the approved designated installer | nothing on `install`: `team queue: the team file designates no installer: only the owner records an install`, or the sentence naming the designated seat |

A team that has never been started has no recorded pane, so a seat cannot add or record until
`team up` has recorded one. The installer designation counts only while it is part of the
approval in force: a hand edit after the last approval admits nobody but the owner until the
owner approves the file again.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the record was added, or was already queued as written | the context line and `queued <id> in <path>`, or `<id> is already queued in <path>` | 0 |
| the queue was listed | the context line and the queue's block, then `<n> task` or `<n> tasks`; an empty queue prints `0 tasks` | 0 |
| the slice was recorded, or was already recorded the same way | the context line and `ready <task> at <commit> (<version>) for <seat>`, or `installed <task> at <commit> (<version>) by <installer>`; a repeat prints `is already recorded ready for <seat>` or `is already recorded installed by <installer>` | 0 |
| refused: no live lease of the named task, or the live lease is another task | `team queue: <reason>`; under `--json`, a `team.error` document with `queue.lease` as `id` | 1 |
| refused: the caller may not record this event, or the installer designation is not approved | `team queue: <reason>`; under `--json`, a `team.error` document with `queue.caller` or `queue.installer` as `id` | 1 |
| refused: the green-slice journal is malformed or full | `team queue: <reason>`; under `--json`, a `team.error` document with `queue.record` as `id` | 1 |
| refused: the caller may not add, the team file declares a linear source, the team file can't be read, the declared task file is missing, a record beside the queue is not a task, the task is not in the queue, or the queue file is not a list | `team queue: <reason>`; under `--json`, a `team.error` document on stdout with the contract row as `id` | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team queue: <problem>`, with the usage for the invocation; under `--json`, a `team.error` document | 2 |

Under `--json` `add` and `list` print one `team.queue` document: `format: 1`, `project`,
`session`, `source` (`local` or `file`), `path`, `tasks` (the whole queue in file order), and,
for `add`, `status` (`added` or `present`) and `task`, the record the call touched. `ready` and
`install` print one `team.green-slice` document instead: `format: 1`, `project`, `session`,
`action` (`ready` or `install`), `status` (`recorded` or `held` when the same event was already
there), and `event`, the journal record with its `kind`, `task`, `commit`, `version`, `at` and the
`seat` or `installedBy` the run verified. A refusal beside a listed or added record is a note on
stderr in the plain run; under `--json`, the document on stdout is the whole answer and stderr
stays empty.

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

The team file declares no `tasks` section, so the queue is the local fallback. A seat adds a
record; the same record again is present and is not rewritten.

```console caller=claude-keeper
$ team queue add "a queued task" --id q1 --assignee worker ; echo "exit $?"
team beacon, session "beacon"
queued q1 in .agents/queue.yaml
exit 0
```

```console caller=claude-keeper
$ team queue add "a queued task" --id q1 --assignee worker ; echo "exit $?"
team beacon, session "beacon"
q1 is already queued in .agents/queue.yaml
exit 0
```

The listing is the queue in file order, and asks no caller.

```console
$ team queue list ; echo "exit $?"
team beacon, session "beacon"
q1  a queued task
  assignee: worker
1 task
exit 0
```

The same id with another record is refused, and the queue is left alone:

```console caller=claude-keeper
$ team queue add "another queued task" --id q1 ; echo "exit $?"
team queue: q1 is already queued with a different record; edit .agents/queue.yaml or choose another id
exit 1
```

A seat records a finished, green commit ready for the task whose live lease it holds. The lease
is a file in the clone the seat works in:

```file file=.agents/leases/q1.json
{"format":1,"id":"q1","seat":"worker","pane":"w2:p1","acquiredAt":"2026-10-20T09:40:00.000Z","renewedAt":"2026-10-20T09:40:00.000Z","until":"2099-01-01T00:00:00.000Z"}
```

```console caller=worker
$ team queue ready q1 --commit 4a1f0c2 --version 0.5.3 ; echo "exit $?"
team beacon, session "beacon"
ready q1 at 4a1f0c2 (0.5.3) for worker
exit 0
```

The same record again is held, and the journal keeps one event for the slice:

```console caller=worker
$ team queue ready q1 --commit 4a1f0c2 --version 0.5.3 ; echo "exit $?"
team beacon, session "beacon"
q1 at 4a1f0c2 (0.5.3) is already recorded ready for worker
exit 0
```

The install is the owner's here, because the team file designates no installer. Recording it is
the acknowledgment; nothing is installed by the command itself:

```console caller=owner
$ team queue install q1 --commit 4a1f0c2 --version 0.5.3 ; echo "exit $?"
team beacon, session "beacon"
installed q1 at 4a1f0c2 (0.5.3) by owner
exit 0
```

A seat cannot record an install by running the verb: the installer is the verified caller, and
until the owner records and approves an `installer:` designation, that is the owner alone.

```console caller=worker
$ team queue install q1 --commit 4a1f0c2 --version 0.5.3 ; echo "exit $?"
team queue: the team file designates no installer: only the owner records an install
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/queue.md](../internal/queue.md).
