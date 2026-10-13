# team worktree

Creates and removes a task worktree: a second checkout of the project on a branch of its own, where
one seat does one task. `new` cuts the branch from `workspace.base`, records the worktree in the
session's state and prints its folder; `remove` deletes a worktree that holds nothing that would be
lost, and keeps its branch.

## Synopsis

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]
    team worktree remove <task> [--session <name>] [--file <path>]

    Ignored files in the worktree are deleted with it.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<task>` | — | one path segment: letters, digits, `.`, `_`, `-`, starting with a letter or a digit |
| `--kind` | `<kind>` | fills `{kind}` in `workspace.branch`; required when the pattern holds it, refused when it doesn't |
| `--seat` | `<name>` | records a declared seat in the worktree's record |
| `--session` | `<name>` | the session whose state is read and written, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

`remove` takes no `--kind` and no `--seat`.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--session` and `--file` are the owner's own |
| the orchestrator's seat, the operator's seat | run it, on the pane the state records for that seat |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the worktree was created | its folder, on stdout | 0 |
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

Rationale, behaviour, refusals and known limits: [docs/internal/worktree.md](../internal/worktree.md).
