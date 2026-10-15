# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watchdog pane. A fresh launch of the orchestrator or the
operator starts in the project folder; every other seat starts in the team's lobby. A seat already
running or ready is left as it is — its pane is not closed, moved or typed into — and its sidebar is
rewritten from the file either way.

## Synopsis

    team up [--dry-run] [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | prints the plan and runs nothing; prints the refusals the real run would stop on as `! up would refuse: …` above it |
| `--session` | `<name>` | the herdr session to start, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr |
| a run with no terminal | a real run is refused: `team up: only the owner runs this, from a terminal outside herdr`; `--dry-run` prints the plan and `! up would refuse:` with that sentence, and launches nothing |
| anyone | run `--dry-run`, which reaches nothing and changes nothing |
| the orchestrator's seat, when the approved `grant` lists `up` | run it on this folder's own team file. The run does not relaunch or close that seat. `--session` and `--file` are refused before either is read |
| a seat, or a pane of another session | run `--dry-run` only; a real run is refused, unless the approved `grant` admits the orchestrator's seat or the approved file's `delegates` section names that pane with `up` in its entry's `commands`, and a `--session` or `--file` it passes is refused before either is read |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every seat ready, watch running | one `<seat>: ready` record per seat in file order, on stdout; `watch: started`, on stderr | 0 |
| `--dry-run` | the plan; `! up would refuse: …` per refusal above it | the refusal's own exit, else 0 |
| the run is refused | one `team up: <reason>` per reason, on stderr, before the first step | 1 |
| a seat was left out, the server did not start, the watch did not start | the seats' records and the run's own lines | 1 |
| the invocation can't be read | `team up: <problem>` and the usage | 2 |
| the team file can't be read | `team up: line <n>: <message>` (`team up: <message>` when the problem names no line) | 2 |

## Example

```console caller=agent
$ team up --file other.yaml ; echo "exit $?"
team up: only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/up.md](../internal/up.md).
