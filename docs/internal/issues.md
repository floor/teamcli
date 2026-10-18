# `team issues`: rationale and known limits

What moved off [the `team issues` page](../commands/issues.md): what the run reads and
writes, the records and the fields, the behaviour behind the lines it prints, the refusals in
their own words, and the known limits. The synopsis, the caller line and the exit codes stay on
the page.

## What the run does: the records, the fields, the order

Lists the typed records in the one file the team file names. Anyone in the checkout may run it.
It reads. It writes nothing, and it creates no key.

The source is a file the owner committed. A broker source is read by `team next`, never from
here: this command connects to no broker, holds no tracker credential, and has no seat gate.
The broker runs as the same OS principal as the seat: that is integrity, not authenticity, and
this command does not isolate anything.
`title` and `description` are the owner's text. They are not scrubbed.
The list is file order. A priority is shown in `--json` and does not reorder.
A listing is not a claim and not the intake rule. `team plan` prints the takeable queue and claims nothing.
`repos` and `needs` mark a record `blocked` in the STATE column when the file has them. They are
not a grant, and they are not checked.
The watch's ring is unchanged: `Team: run team messages`.

## What it reads and writes

Reads the team root (`loadTeamFile`: the checkout, or the folder holding `.agents/team.yaml`),
the team file, and the YAML list at `tasks.path`. The path is relative to that root. A record's
`id` and `title` are required. The plain listing prints
the contract's four columns; every other field the file carries is in the `--json` record.
`blocked-by`, `repos` and `needs` make the STATE cell `blocked`; none of them is judged or
resolved here.

On a broker source nothing is listed and no socket connection is attempted: the refusal below
names where the read lives.

Writes nothing.

## Who may run it

Anyone in the checkout.

## Refusals

```text
team issues: the team file declares no task source
team issues: tasks.source must be file
team issues: team issues lists the file the owner committed; a broker source is read by team next
team issues: tasks.linear.project is required
team issues: the task file is not there
team issues: the task file is not a list
team issues: m1 is not a task: title is required
team issues: record 1 is not a task: id is required
```

An empty list is not a refusal: it prints the context line and `0 issues`, and the exit is 0.

`tasks.source must be file` is the local-adapter miss: it stands for a source this build does not
carry. The broker-source sentence is the other side of the same rule — a tracker's records are
read behind the broker's socket, where the seat gate and the policy live, and this command has
neither.

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console, and the two file
fences it reads, are also on [the `team issues` page](../commands/issues.md).

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

```console
$ team issues ; echo "exit $?"
team beacon, session "beacon"
  ID  STATE  ASSIGNEE  TITLE
  m1  open   -         the task title
1 issue
exit 0
```
