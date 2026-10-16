# team check

One answer to one question: **is anything wrong with this team that someone should act on?**
It reads the team file, the approval, the state, herdr and the registries, and changes nothing —
no git is needed, so it answers as well in a plain folder as in a repository. Where
[`team status`](status.md) says what the team is, the check says what to act on: the differences
alone, each with its repair.
It is also the old name of [`team commits check`](commits.md) and [`team pr check`](pr.md), still
read through 0.3.3. A `<ref>` (a range when it holds `..`, passed to git as given, otherwise that
one commit) runs that older reading, as do `--pr <file>` (check a pull request's body as well;
`-` reads standard input) and `--since <ref>` (skip that commit and everything reachable from
it). `--file` is read by both readings; `--session` is this one's alone, and the older one meets
it with `team check: unknown option --session` and exit 2. A run of the older reading says once
on stderr which command now holds it, and `--pr` adds its own line.

The registries answer for the team's place: a team the project registry names in two projects is a
difference naming both, repaired by fixing the registry file, and so is a registry that cannot be
read. A team whose file sets `project_lead: true` while another team of the same project sets it
too is one as well — `the project <name> has <n> lead teams: <names>`, repaired with
`take "project_lead: true" off all but one of them`. The two herdr sidebar lines each file seat
carries are compared on the same pass: a workspace label or display line that reads as neither the
file's own text nor a line the watch may paint is a difference repaired with
`team register <seat>`, which re-applies both lines from the file without a relaunch.

## Synopsis

    team check [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | check the team; an owner without a terminal is not this caller |
| a seat of the team being checked | the same answer, placed in the file's session, on the pane the state records for it |
| a pane outside the team that the live file names in its `delegates` entries | the same gate the changing commands use, minus the command list and the audit line: the check is a read, not an act |
| anyone else | nothing: the fixed sentence `team check: this team is not yours to check`, whatever failed underneath |

Aimed by a caller that passes the gate but is not the owner, `--file` and `--session` meet the
refusal every command gives them and exit 1.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| nothing needs acting on | `team check: nothing wrong`, over the line naming what the check cannot see: `not known: work sent and unread, a lead waiting on a seat, a landing not recorded` | 0 |
| something needs acting on | one `difference:` line per finding with its `  repair:` line under it, then `team check: <n> difference(s)`, and `, <n> for the owner` when any finding is the owner's | 1 |
| a flag the caller may not aim | the refusal every command gives it | 1 |
| the check can't run (the loader's, the state's or herdr's own text), the invocation can't be read, or the caller may not check this team | `team check: <problem>`, or the one fixed sentence | 2 |

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

The team runs as the file and the state say, so there is nothing to act on:

```console
$ team check ; echo "exit $?"
team check: nothing wrong
not known: work sent and unread, a lead waiting on a seat, a landing not recorded
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/check.md](../internal/check.md).
