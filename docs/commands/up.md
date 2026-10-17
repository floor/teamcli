# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and starts the watch as a background process. A fresh launch of
the orchestrator or the operator starts in the project folder; every other seat starts in the team's
lobby. A seat already running or ready is left as it is — its pane is not closed, moved or typed
into — and its sidebar is rewritten from the file either way.

## Synopsis

    team up [--dry-run] [--serial] [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | prints the plan and runs nothing; prints the refusals the real run would stop on as `! up would refuse: …` above it, and, for a caller the run does not admit, `! to unblock: …` with the command that admits it |
| `--serial` | — | launches and waits on one seat at a time instead of concurrently |
| `--session` | `<name>` | the herdr session to start, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr |
| a caller outside herdr whose ancestry names a create-grant's `runner` | run it, on the paths that record covers and before it expires |
| a run with no terminal | a real run is refused: `team up: only the owner runs this, from a terminal outside herdr`; `--dry-run` prints the plan and `! up would refuse:` with that sentence, and launches nothing |
| a seat this team's record marks `leads` — its orchestrator, or a registry roster line that says `leads` | run it on this folder's own team file, and the run does not relaunch or close that seat. `--session` and `--file` are refused before either is read |
| a caller the run admits | run `--dry-run`, which reaches nothing and changes nothing |
| a caller the run does not admit | a real run is answered with the one word `deny` on stderr and nothing on stdout — no reason, and no plan — and exit 1. A `--dry-run` is never denied: it prints `! up would refuse:` with that reason, `! to unblock:` with the owner's own run of this folder, and — when no flag kept the file unread — the plan, and exits 1 |
| the orchestrator's seat, where the row above does not admit it and the approved `grant` lists `up` | run it on this folder's own team file, and the run is audited as the grant's. The grant is the fallback for a caller the row refused, never a constraint on a caller it admitted: a grant that names another seat or pane, or leaves `up` out of its scope, refuses this run, and a run the row admitted asks it nothing and is audited only as the row's. A file no approval covers grants nothing. The run does not relaunch or close that seat. `--session` and `--file` are refused before either is read, in the grant's words |
| a seat of this team the record does not mark `leads`, or a pane of another session | run `--dry-run` only; a real run is refused, unless the live `grant` admits the orchestrator's seat or the live file's `delegates` section names that pane with `up` in its entry's `commands`, and a `--session` or `--file` it passes is refused before either is read |

## A create-grant's runner

A create-grant — a record in `~/.config/team/grants/` — admits a caller outside herdr without the
owner's terminal when its `runner` field (or `runners: [<name>, …]` for several) names one of the
caller's parent processes, the base name of what `ps -o comm=` prints for it. That caller runs
`up` on the paths the record covers, before it expires. A name that is not in the ancestry, an
expired record, a folder outside the covered paths or one reached through a `..` segment or a
symlink, and a record with no `runner` all keep the answer above; a caller under herdr is never
admitted this way, where the approved file's `grant` decides. The record's shape, with one
example: [team init](init.md).

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every seat ready, watch running | one `<seat>: ready` record per seat in file order, on stdout; `watch: started`, on stderr | 0 |
| `--dry-run` | the plan; `! up would refuse: …` per refusal above it | the refusal's own exit, else 0 |
| a caller the run does not admit | a real run: `deny`, and nothing else: no `team up:` prefix, no reason, no plan. A `--dry-run`: `! up would refuse: <the reason>`, `! to unblock: <the owner's own run>`, then the plan where the run reached one | 1 |
| the run is refused | one `team up: <reason>` per reason, on stderr, before the first step | 1 |
| a seat was left out, the server did not start, the watch did not start | the seats' records and the run's own lines | 1 |
| the invocation can't be read | `team up: <problem>` and the usage | 2 |
| the team file can't be read | `team up: line <n>: <message>` (`team up: <message>` when the problem names no line) | 2 |

## Example

```console caller=agent
$ team up --file other.yaml ; echo "exit $?"
deny
exit 1
$ team up --dry-run --file other.yaml ; echo "exit $?"
! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it is run by an agent (claude) outside herdr)
! to unblock: the owner runs `team up --file other.yaml` from this folder, at a terminal outside herdr
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/up.md](../internal/up.md).
