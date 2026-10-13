# team init

Writes the team file: a skeleton for this project, or with `--restore` the copy of
`.agents/team.yaml` you last approved on this machine. It also lists the team file and its runtime
files in `.git/info/exclude`, so git never sees them and a fresh clone never carries them. The owner
alone runs it, from a terminal outside herdr, and a file that already exists is never overwritten.

## Synopsis

    team init [--restore]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--restore` | — | write the copy of the team file this machine last approved, instead of a skeleton |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it |
| a seat, an agent-run CLI, or a command without a terminal | nothing: `team init: only the owner runs init, from a terminal outside herdr; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a skeleton was written, or the approved copy was restored | `Wrote .agents/team.yaml: a skeleton with one seat. Edit it, then run team approve.` | 0 |
| refused: not the owner, the file is tracked or already there, or there is nothing to restore | `team init: <reason>` | 1 |
| it can't run: not inside a git repository, or a bad option | `team init: <problem>`, with the usage for a bad option | 2 |

## Example

A seat can't run it:

```console caller=agent
$ team init ; echo "exit $?"
team init: only the owner runs init, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/init.md](../internal/init.md).
