# team queue

Adds one record to the team's local task queue, or lists it. The local queue is the task source
only when the team file declares none: then `.agents/queue.yaml` under the team root. A team that
declares a file source is written at its own path, and a team that declares a broker source
(`linear`) has no local queue at all — this command never writes the tracker.

An id already queued is present and is not rewritten; the same id with another record is refused.
The add is atomic: the whole candidate file is read back through the file adapter before it
replaces the queue, so a file the reader would refuse is never installed. A listing claims
nothing, writes nothing, and asks no caller.

## Synopsis

    team queue add <title> --id <id> [--assignee <name>] [--priority <value>] [--json]
    team queue list [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--id` | a task id | required by `add`; letters, digits, dot, dash or underscore, starting with a letter or digit |
| `--assignee` | a seat name | required to name a declared seat of this team |
| `--priority` | text or a number | a plain number is written as a number, so `team next` orders it numerically; any other one-line text stays text |
| `--json` | — | one `team.queue` document on stdout instead of the context line and block |
| `--help`, `-h` | — | the usage, and exit 0 |

`list` takes no valued option and no second word. `add` takes exactly one title after the verb.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | add |
| a declared seat of this team, on the pane the state records for that seat | add |
| any caller | list |
| a seat of another team, a seat the state cannot place, or a name that is not a seat | nothing on `add`: `team queue: only the owner or a seat of this team adds to the queue; this call is <caller>` |

A team that has never been started has no recorded pane, so a seat cannot add until `team up` has
recorded one.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the record was added, or was already queued as written | the context line and `queued <id> in <path>`, or `<id> is already queued in <path>` | 0 |
| the queue was listed | the context line and the queue's block, then `<n> task` or `<n> tasks`; an empty queue prints `0 tasks` | 0 |
| refused: the caller may not add, the team file declares a linear source, the team file can't be read, the declared task file is missing, a record beside the queue is not a task, or the queue file is not a list | `team queue: <reason>`; under `--json`, a `team.error` document on stdout with the contract row as `id` | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team queue: <problem>`, with the usage for the invocation; under `--json`, a `team.error` document | 2 |

Under `--json` both verbs print one `team.queue` document: `format: 1`, `project`, `session`,
`source` (`local` or `file`), `path`, `tasks` (the whole queue in file order), and, for `add`,
`status` (`added` or `present`) and `task`, the record the call touched. A refusal beside a
listed or added record is a note on stderr in the plain run; under `--json`, the document on
stdout is the whole answer and stderr stays empty.

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

Rationale, behaviour, refusals and known limits: [docs/internal/queue.md](../internal/queue.md).
