# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watch, in a workspace of its own labelled
`Watch · <project>`. A fresh launch of
the orchestrator or the operator starts in the project folder; every other seat starts in the team's
lobby. A seat already running or ready is left as it is — its pane is not closed, moved or typed
into — and its sidebar is rewritten from the file either way. A seat the file marks `human: true`
is a human's own pane: the plan skips it — nothing is launched into it or typed into it; left as
it is — and it does not count as short of ready.

Before the plan types anything, the run delivers the general seat brief: TeamCLI's built-in
default, the first text every seat gets, written into each declared seat's drop folder as a signed
message record — human seats included — and recorded in the session's state. It travels the drop
leg and is never typed; a seat that already holds this brief's verified record is left as it is,
a file planted at the brief's id is replaced by the signed record, and a link, a folder or a FIFO
there is refused, never followed. [`team check`](check.md) names a seat the session launched
without a verified delivery record.

## Synopsis

    team up [--dry-run] [--serial] [--session <name>] [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | prints the plan and runs nothing; prints the refusals the real run would stop on as `! up would refuse: …` above it, and, for a caller the run does not admit, `! to unblock: …` with the command that admits it |
| `--serial` | — | launches and waits on one seat at a time instead of concurrently |
| `--session` | `<name>` | the herdr session to start, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--json` | — | one `team.up` document instead of the working lines; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr |
| a seat an active create-grant names by its own registry id | run it, on the paths that record covers and before it expires |
| a run with no terminal | a real run is refused: ``team up: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane``; `--dry-run` prints the plan and `! up would refuse:` with that sentence, and launches nothing |
| a seat this team's record marks `leads` — its orchestrator, or a registry roster line that says `leads` | run it on this folder's own team file, and the run does not relaunch or close that seat. `--session` and `--file` are refused before either is read |
| a caller the run admits | run `--dry-run`, which reaches nothing and changes nothing |
| a caller the run does not admit | a real run is answered with the one word `deny` on stderr and nothing on stdout — no reason, and no plan — and exit 1. A `--dry-run` is never denied: it prints `! up would refuse:` with that reason, `! to unblock:` with a `leads` seat's own run of this folder from its pane (or the owner's, from a terminal outside herdr), and — when no flag kept the file unread — the plan, and exits 1 |
| the orchestrator's seat, where the row above does not admit it and the file's `grant` lists `up` | run it on this folder's own team file, and the run is audited as the grant's. A lead the map admits is not constrained by a grant, and the grant or delegate path applies only to seats the map does not admit: a grant that names another seat or pane, or leaves `up` out of its scope, refuses this fallback run, and a run the map admitted asks it nothing and is audited only as the row's. A file with no `grant` section grants nothing. The run does not relaunch or close that seat. `--session` and `--file` are refused before either is read, in the grant's words |
| a seat of this team the record does not mark `leads`, or a pane of another session | run `--dry-run` only; a real run is refused, unless the live `grant` admits the orchestrator's seat or the live file's `delegates` section names that pane with `up` in its entry's `commands`, and a `--session` or `--file` it passes is refused before either is read |

## A create-grant's seat

A create-grant — a record in `~/.config/team/grants/` — admits a seat whose own registry record the
record names, by its registry agent id (`agt_` …) or by its team's registry id, and nothing else.
That seat runs `up` on the paths the record covers — its own `paths:`/`path:`, or the roots its
`entity:` declares in `~/.config/team/entities.yaml` when it names none — before it expires. A
record that spells its holder as a name, a seat, a pane, a session or a runner process grants
nothing and is skipped, an expired record keeps the answer above, and so does a folder outside the
covered paths or one reached through a `..` segment or a symlink. A caller outside herdr has no
registry record and is never admitted; where the team file's `grant` decides, that record
decides instead. The record's shape, with one example: [team init](init.md).

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every seat ready, watch running | one `<seat>: ready` record per seat in file order, on stdout; `watch: started`, on stderr | 0 |
| `--dry-run` | the plan; `! up would refuse: …` per refusal above it | the refusal's own exit, else 0 |
| a caller the run does not admit | a real run: `deny`, and nothing else: no `team up:` prefix, no reason, no plan. A `--dry-run`: `! up would refuse: <the reason>`, `! to unblock: <a leads seat's own run, or the owner's>`, then the plan where the run reached one | 1 |
| the run is refused | one `team up: <reason>` per reason, on stderr, before the first step | 1 |
| a seat was left out, the server did not start, the watch did not start | the seats' records and the run's own lines | 1 |
| the invocation can't be read | `team up: <problem>` and the usage | 2 |
| the team file can't be read | `team up: line <n>: <message>` (`team up: <message>` when the problem names no line) | 2 |

`--json` prints one `team.up` document instead: `project`, `session`, the seat names the file
declares as `seats`, and `notes` — the run's other lines in order, its closing `<seat>: ready`
record as `action_summary` — with `dry_run` `false` and `status` `ready`. A run that ends short of
ready is the `team.error` document instead, named by what fell short: `up.pending` (the seats it
names), `up.server` or `up.watch`. With `--dry-run` the document is `status` `dry-run`, `dry_run`
`true`, `action_summary` `dry run: nothing was run`, and the plan as `plan` — the warning first
when there is one, then one step per plan line, `prefix` `+`, `!` or `skip`. A refusal under
`--json` is the `team.error` document on stdout — its `id` is the contract row for that refusal
(`up.deny`, `up.invocation`, …), and a caller the run does not admit gets `message` `deny` — with
nothing on stderr; a dry run that would be refused is answered so too, and prints no plan.

## Example

```console caller=agent
$ team up --file other.yaml ; echo "exit $?"
deny
exit 1
$ team up --dry-run --file other.yaml ; echo "exit $?"
! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it is run by an agent (claude) outside herdr)
! to unblock: a `leads` seat runs `team up --file other.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/up.md](../internal/up.md).
