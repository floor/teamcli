# team pr check

Checks one pull request body against the team file's rules: the body must end with the signature
the file's `pullRequests` rule writes, and no line may match a forbidden pattern. It checks the
body alone, so it needs no repository at all — a project without git can check a request to merge.
The commits are a separate run, [`team commits check`](commits.md).

## Synopsis

    team pr check <file> [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<file>` | a path, or `-` | the pull request's body; `-` reads standard input |
| `--file <path>` | a team file | the team file to read, instead of `.agents/team.yaml` |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an agent-run CLI, or the owner, from any folder | run it: it needs no herdr session, no terminal and no approval of its own |
| CI, on a push | run it, with the body written to a file or piped in with `-` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the body passes | `team pr check: 1 pull request body checked: ok` | 0 |
| the body was refused | the body as one section, `pull request body`, with one line per finding under it, then `team pr check: 1 pull request body checked: the pull request body refused` | 1 |
| the check can't run: a bad invocation, a team file that can't be read, or a body file that can't be read | `team pr check: <reason>`, with the usage for a bad invocation | 2 |

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

identity:
  humans: [jane@acme.example]

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
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

A pull request's body signs on its last line:

```file file=pr.md
The metrics page is ready for review.

**Agent:** Claude Opus 5.5 · implementer
```

```console
$ team pr check pr.md ; echo "exit $?"
team pr check: warning: line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
team pr check: 1 pull request body checked: ok
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/pr.md](../internal/pr.md).
