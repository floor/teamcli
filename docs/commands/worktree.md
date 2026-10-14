# team worktree

Creates and removes a task worktree: a second checkout of the project on a branch of its own, where
one seat does one task. `new` cuts the branch from `workspace.base`, records the worktree in the
session's state and prints its folder; `remove` deletes a worktree that holds nothing that would be
lost, and keeps its branch. `list` prints every record that counts toward `workspace.limit` and
writes nothing.

## Synopsis

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]
    team worktree list [--session <name>] [--file <path>]
    team worktree remove <task> [--session <name>] [--file <path>]

    Ignored files in the worktree are deleted with it.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<task>` | — | one path segment: letters, digits, `.`, `_`, `-`, starting with a letter or a digit |
| `--kind` | `<kind>` | fills `{kind}` in `workspace.branch`; required when the pattern holds it, refused when it doesn't |
| `--seat` | `<name>` | records a declared seat in the worktree's record |
| `--session` | `<name>` | the session the caller is judged in, instead of the team's own; `new` and `remove` read and write that session; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

`remove` takes no `--kind` and no `--seat`. `list` takes no task, no `--kind` and no `--seat`.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--session` and `--file` are the owner's own |
| a run with no terminal | nothing: `team worktree: only the owner runs this, from a terminal outside herdr` |
| the orchestrator's seat, the operator's seat | run it, on the pane the state records for that seat |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the worktree was created | its folder, on stdout | 0 |
| the recorded worktrees were listed | `<n> open, limit <limit> (workspace.limit)`, then one line per record: `<task> session <session> seat <seat> <path> folder exists`. No seat when the record has none. A missing folder ends the line `folder gone; team worktree remove <task>` | 0 |
| the worktree was removed | `removed <task>; the branch <branch> is kept` | 0 |
| `new` created the worktree and `workspace.setup` failed | its folder, then `team worktree: setup failed on command <n> of <m>; the worktree is kept and recorded as setup: failed` | 1 |
| the run was refused | `team worktree: <reason>` | 1 |
| the invocation or the team file can't be read | `team worktree: <problem>` and the usage | 2 |

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
0 open, limit 8 (workspace.limit)
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/worktree.md](../internal/worktree.md).
