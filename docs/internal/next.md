# `team next`: rationale and known limits

What moved off [the `team next` page](../commands/next.md): what the run reads and writes,
the lease and the source it reads, the behaviour behind the lines it prints, the refusals in
their own words, and the known limits. The synopsis, the flags, the caller table and the exit
codes stay on the page.

## What the run does: the intake, the lease, the take

Claims one record from the file the team file names, and holds it with a lease in this clone.
A seat cannot pull until `team up` has recorded its pane.

The source is a file the owner committed, or a tracker the owner's broker reads. On a broker
source, `team next` asks the broker; with no broker running it refuses and claims nothing. The
broker holds the tracker credential; this command never reads it.
The broker runs as the same OS principal as the seat: that is integrity, not authenticity, and
this command does not isolate anything.
A lease is a file in this clone. Two live leases in this clone do not cover one id. Another
clone, and another machine, are outside that promise.
An expired lease returns the record to the queue. Another seat may take it, and the work may
be done twice.
The file is the intake for a file source. A record is takeable because the owner wrote it there.
For a broker source the intake is the tracker's read, with the team's policy deciding which
fields cross. That is not the owner-set intake rule. `team plan` prints the takeable queue and claims nothing.
`title` and `description` are the owner's text. They are not scrubbed. A broker source's policy
may keep a field from crossing, and a field left out is absent from the record, never blank.
A record with `blocked-by`, `repos`, or `needs` is listed by `team issues` and is not taken.
A deadline is printed and not read as a time. A missed deadline is not decided here.
Releasing a lease records no progress.
The watch's ring is unchanged: `Team: run team messages`.

## What it reads and writes

Reads the git checkout (`findRoot`), the team file, the YAML list at `tasks.path`, and the
lease files under `.agents/leases/` in this clone. The path is relative to the checkout. A
record's `id` and `title` are required. The printed block is the `team issues` block, one
record. No lease field is printed.

On a broker source it reads the same git checkout and team file, then asks the broker over
`.agents/broker.sock`: one request line carrying the caller's seat and pane, one answer line back,
with a five-second deadline. Nothing is read from the tracker directly, and the credential is
never read here. The seat gate runs first; the broker checks the same claim again on the request,
and its refusal — the same sentences — is what this command prints.

Writes one lease file, `.agents/leases/<id>.json`, or rewrites the caller's own live file.
The lease lasts 30 minutes. A re-run while it is live renews it and prints that record again.
It does not take a second id. `--release` unlinks the caller's file and records no progress.
An expired lease returns the record to the queue. On a broker source the lease is still the local
one: the tracker holds no claim, and `--release` unlinks the caller's file without reaching the
broker. `team next` does not edit `.git/info/exclude` and does not write the task file.

## Who may run it

A declared seat of this team, on the pane the state records for that seat. Any declared seat
may pull, not only the orchestrator. The owner is refused. A name that is not a seat is
refused the same way.

A team that has never been started has no recorded pane, so a seat cannot pull until `team up`
has recorded one:

```text
team next: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up`
```

The wrong pane is refused with the pane the state records:

```text
team next: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`)
```

## What it prints

One record, the issues block. Nothing else on stdout when a record was claimed.

`team next: nothing is takeable` when the takeable set is empty. That is one answer, not a
poll and not a stand-down.

`team next: nothing is assigned to you` when `--mine` has nothing to take.

`team next: nothing is held` when `--release` finds no file of the caller's.

`team next: released <id>` when the caller's file was unlinked.

`--wait` re-reads the source every `tasks.cadence` while a pass finds nothing takeable; without
`tasks.cadence` it refuses. Without `--wait` the command stands down with one answer, as before.
The wait polls at a constant pace; a refused read ends it — back-off is not implemented.

With `--wait` and an empty takeable set, the one answer above prints once, then
`team next: waiting every <n>s` with `<n>` the cadence in seconds, and the wait begins. A re-read
that finds a record prints that record's block; an empty re-read prints nothing;
`team next: stopped waiting` when a stop signal, or a clock that did not advance, ends the wait.

`team next: the tracker holds more tasks than this read; the take still proceeds` on stderr when
the broker's answer says the tracker holds another page. The read is bounded, and it says so: the
take proceeds with the notice, never with a silent truncation.

## Refusals

```text
team next: only a seat of this team pulls a task; this call is owner
team next: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up`
team next: the team file declares no task source
team next: tasks.source must be file
team next: tasks.path must stay inside the checkout
team next: the task file is not there
team next: the task file is not a list
team next: m1 is not a task: title is required
team next: --mine and --release are not used together
team next: --wait and --release are not used together
team next: --wait needs tasks.cadence in the team file
team next: the broker is not running; the owner starts it with `team broker`
team next: the broker's answer is not one this build knows; the owner restarts it
team next: the broker accepted the request and did not answer; nothing is claimed
team next: the broker failed this read
team next: tasks.policy.omit must not name id or title, the record itself
```

`tasks.source must be file` is the local-adapter miss: it stands for a file source whose adapter
this build does not carry. A broker source never prints it — it goes to the broker path.

The refusals between `the broker is not running` and `the broker failed this read` are the broker
path's, in order: no broker answered (or the answer was not one this build knows, or arrived past
the deadline), then the broker refused the read itself. The last is the validator on a broker
source's policy, the same sentence the broker prints at its own start.

A record that is not a task is named on stderr and is not a candidate. If another record is
claimed, the exit is still 0. If nothing is claimed and any record was refused, stdout has no
block and the exit is 1.

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console, and the two file
fences it reads, are also on [the `team next` page](../commands/next.md).

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
```

```console caller=claude-keeper
$ team next ; echo "exit $?"
m1  the task title
exit 0
```
