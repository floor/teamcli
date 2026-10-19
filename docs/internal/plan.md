# `team plan`: rationale and known limits

What moved off [the `team plan` page](../commands/plan.md): what the run reads and writes,
the queue and the source, the behaviour behind the lines it prints, the refusals in their own
words, and the known limits. The synopsis, the caller table and the exit codes stay on the page.

## What the run does: the queue, the source, the mark

Prints the queue a claim would consider, in the order `team next` would consider it. A seat
cannot pull until `team up` has recorded its pane, and this command is read only.

A plan is a listing: it claims nothing and writes no lease. It shows the records a claim would
consider, in the order `team next` would consider them — a record another seat holds can still
appear.

The queue is this clone's view of one source read.

A deadline the clock has passed is marked overdue here. The mark decides nothing: an overdue
record is still takeable and is never dropped, blocked, reordered or released by lateness. An
unparseable deadline is printed as written and unmarked.

The source is a file the owner committed, or a tracker the owner's broker reads. A team that
names no source reads its own local queue, `.agents/queue.yaml`; a missing one is an empty
queue. On a broker source, `team plan` asks the broker the same read `team next` asks, and
claims nothing. The broker holds the tracker credential; this command never reads it.

The mark is against this clone's clock. Another machine's clock may disagree.

## What it reads and writes

Reads the team root (`loadTeamFile`: the checkout, or the folder holding `.agents/team.yaml`),
the team file, and the YAML list at `tasks.path` — or, when the team file names no source, the
local queue at `.agents/queue.yaml`. The path is relative to that root. A record's `id` and
`title` are required. The plain plan is the
contract's table: one row per takeable record, in `team next`'s order — priority first (a number
before a text, ascending), then the `tasks.fallback` tie-break — with the queue position, the
STATE mark, the owner or `-`, and the title. Every other field the record carries is in the
`--json` task. A record with `blocked-by`, `repos`, or `needs` is not takeable and is not printed.

On a broker source it reads the same root and team file, then asks the broker over
`.agents/broker.sock`: one request line carrying the caller's seat and pane, one answer line
back, with a five-second deadline. The seat gate runs first; the broker checks the same claim
again on the request.

Writes nothing. No lease file, no renewal, no state write, and no tracker write. No file on
your disk records that you looked.

## Who may run it

A declared seat of this team, on the pane the state records for that seat. Any declared seat
may plan, not only the orchestrator. The owner is refused. A name that is not a seat is
refused the same way. The refusals are `team next`'s, with this command's prefix:

```text
team plan: no pane is recorded for seat <name> in this session: a lead stops that seat and runs `team up`
team plan: the state records pane <pane> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (`team down`, then `team up`)
```

## What it prints

The context line, then the takeable records as the contract's `STEP  STATE  OWNER  TITLE` table,
then `1 task` / `<n> tasks`. A deadline the clock has passed reads `overdue` in the STATE column; the mark
decides nothing.

The context line and `0 tasks` when no record is takeable. That is one answer, exit 0.

With `--json`, the same queue is one document: the context's `project` and `session`, and one
task per record carrying its `step`, its `state` (`open` or `overdue`), the owner or `null`, and
the whole record. A refusal writes one `team.error` document on stdout instead, with the same
sentence as its `message`, and the exit is the same.

`team plan: the tracker holds more tasks than this read; the take still proceeds` on stderr when
the broker's answer says the tracker holds another page — the same notice `team next` prints.
The read is bounded, and it says so.

## Refusals

```text
team plan: only a seat of this team pulls a task; this call is owner
team plan: tasks.source must be file
team plan: tasks.path must stay inside the checkout
team plan: the task file is not there
team plan: the task file is not a list
team plan: m1 is not a task: title is required
team plan: the broker is not running; the owner starts it with `team broker`
team plan: the broker's answer is not one this build knows; the owner restarts it
team plan: the broker accepted the request and did not answer; nothing is claimed
team plan: the broker failed this read
team plan: tasks.policy.omit must not name id or title, the record itself
```

`tasks.source must be file` is the local-adapter miss: it stands for a file source whose adapter
this build does not carry. A broker source never prints it — it goes to the broker path.

A record that is not a task is named on stderr and is not a candidate. If another record is
printed, the exit is still 0. If nothing is printed and any record was refused, stdout has no
block and the exit is 1.

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console, and the two file
fences it reads, are also on [the `team plan` page](../commands/plan.md).

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

tasks:
  source: file
  path: .agents/tasks.yaml

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```yaml file=.agents/tasks.yaml
- id: m1
  title: the task title
  deadline: 2026-01-01T00:00:00Z
```

```console caller=claude-keeper
$ team plan ; echo "exit $?"
team beacon, session "beacon"
  STEP  STATE    OWNER  TITLE
  1     overdue  -      the task title
1 task
exit 0
```
