# team worktree

Creates and removes a task worktree: a second checkout of the project on a branch of its own, where
one seat does one task. `new` cuts the branch from `workspace.base`, records the worktree in the
session's state and prints its folder; `remove` deletes a worktree that holds nothing that would be
lost, and keeps its branch. `list` prints every record that counts toward `workspace.limit` and
writes nothing. `pull` runs the seat CLI's own pull call in the worktree — the call its profile
declares, with the session id and `--apply` — so a remote session's result lands as a local patch;
it commits, pushes and creates no branch.

## Synopsis

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>] [--json]
    team worktree list [--session <name>] [--file <path>] [--json]
    team worktree pull <task> --remote-session <id> [--seat <name>] [--session <name>] [--file <path>] [--json]
    team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>] [--json]

    Ignored files in the worktree are deleted with it.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<task>` | — | one path segment: letters, digits, `.`, `_`, `-`, starting with a letter or a digit |
| `--kind` | `<kind>` | fills `{kind}` in `workspace.branch`; required when the pattern holds it, refused when it doesn't |
| `--seat` | `<name>` | records a declared seat in the worktree's record; on `pull`, names the seat whose CLI pulls when the record holds none, and must agree with a seat the record does hold |
| `--branch` | `<name>` | `remove` only: the branch the worktree must be on; any other is refused |
| `--remote-session` | `<id>` | `pull` only: the session id the seat CLI created and recorded as the delivery |
| `--session` | `<name>` | the session the caller is judged in, instead of the team's own; every subcommand reads that session, and `new`, `pull` and `remove` act on its records; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--json` | — | `list` prints its reading document; `new`, `pull` and `remove` print their action envelope |
| `--help`, `-h` | — | the usage, and exit 0 |

`remove` takes no `--kind` and no `--seat`. `new`, `list` and `pull` take no `--branch`. `pull` takes no `--kind` and needs `--remote-session`. `list` takes no task, no `--kind` and no `--seat`.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--session` and `--file` are the owner's own |
| a run with no terminal | nothing: `team worktree: only the owner, the orchestrator or the operator runs this, from a terminal outside herdr or its own seat` |
| the orchestrator's seat, the operator's seat | run it, on the pane the state records for that seat |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the worktree was created | the context line, then `worktree <task>: created at <path>` | 0 |
| the recorded worktrees were listed | the context line, a `TASK  BRANCH  PATH` table (a missing folder's path ends ` (gone)`), `note: limit <n> (workspace.limit)`, then `<n> worktree` / `<n> worktrees` | 0 |
| the worktree was removed | the context line, then `removed <task>; the branch <branch> is kept` — the branch the worktree is on, read from git, not from the state record | 0 |
| the folder was already gone | the context line, then `removed the record of <task>; its folder was already gone. No branch was deleted.` | 0 |
| the session's patch was pulled | the CLI's own output, then the context line and `remote session <id>: pulled into <path>` | 0 |
| `new` created the worktree and `workspace.setup` failed | the created line, then `team worktree: setup failed on command <n> of <m>; the worktree is kept and recorded as setup: failed` on stderr | 1 |
| the run was refused | `team worktree: <reason>` | 1 |
| the invocation can't be read | `team worktree: <problem>` and the usage | 2 |
| the team file can't be read | `team worktree: line <n>: <message>` (`team worktree: <message>` when the problem names no line) | 2 |

A `pull` refusal names what stopped it — no record for the task, a record in another session, a
folder that is gone, no seat whose CLI declares a pull, or the CLI's own non-zero exit with its
last error line — and no patch is applied.

Under `--json` the same run is a `team.worktree` document: the reading document on `list`, the
action envelope on `new`, `pull` and `remove`, and the `team.error` document for a refusal — see
[the output contract](../reference/output.md).

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon
  - ~/Code/worktrees/beacon

workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main

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
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

A seat that isn't the orchestrator or the operator can't create one:

```console caller=claude-beacon
$ team worktree new select-width --kind fix ; echo "exit $?"
team worktree: only the owner, the orchestrator or the operator runs it; this call is claude-beacon
exit 1
```

The owner lists the records. This file sets no `workspace.limit`, so the limit is the default:

```console
$ team worktree list ; echo "exit $?"
team beacon, session "beacon"
  TASK  BRANCH  PATH
note: limit 8 (workspace.limit)
0 worktrees
exit 0
```

`--json` is the same reading as a document, in the order the rows are printed:

```console
$ team worktree list --json
{
  "schema": {
    "name": "team.worktree",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "notice": null,
  "worktrees": [],
  "notes": [
    "limit 8 (workspace.limit)"
  ],
  "summary": {
    "worktrees": 0
  }
}
```

Rationale, behaviour, refusals and known limits: [docs/internal/worktree.md](../internal/worktree.md).
