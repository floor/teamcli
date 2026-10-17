# team check

One answer to one question: **is anything wrong with this team that someone should act on?**
It reads the team file, the approval, the state, herdr and the registries, and changes nothing
but the state's two leftovers the owner's `--repair` drops — no git is needed, so it answers as
well in a plain folder as in a repository. Where
[`team status`](status.md) says what the team is, the check says what to act on: the differences
alone, each with its repair.
It is also the old name of [`team commits check`](commits.md) and [`team pr check`](pr.md), still
read through 0.3.3. A `<ref>` (a range when it holds `..`, passed to git as given, otherwise that
one commit) runs that older reading, as do `--pr <file>` (check a pull request's body as well;
`-` reads standard input) and `--since <ref>` (skip that commit and everything reachable from
it). `--file` is read by both readings; `--session` is this one's alone, and the older one meets
it with `team check: unknown option --session` and exit 2. `--repair` is this one's alone too, and
the older one meets it with `team check: unknown option --repair` and exit 2. A run of the older reading says once
on stderr which command now holds it, and `--pr` adds its own line.

The registries answer for the team's place: a team the project registry names in two projects is a
difference naming both, repaired by fixing the registry file, and so is a registry that cannot be
read. A team whose file sets `project_lead: true` while another team of the same project sets it
too is one as well — `the project <name> has <n> lead teams: <names>`, repaired with
`take "project_lead: true" off all but one of them`. The two herdr sidebar lines each file seat
carries are compared on the same pass: a workspace label or display line that reads as neither the
file's own text nor a line the watch may paint is a difference repaired with
`team register <seat>`, which re-applies both lines from the file without a relaunch. A live seat
the state holds ready that the team registry's record does not list in its roster is a difference
too, repaired with the same `team register <seat>`: where the registry holds a record of the team,
its roster is the record of who its seats are for the permission bridge, and a seat the roster does
not list has none. A team the registry holds no record of is not this difference — the bridge reads
the file's own declaration then. A seat no source has heard from past the blind threshold reads
`unknown (blind)` in
[`team seats`](seats.md) and counts as not working: `<seat>: unknown for over <threshold> — blind,
and it counts as not working`, repaired with the owner's look at the pane.

The state's leftovers are differences too. A record for a seat the file no longer declares — one
an older file named and this one dropped — and a record for a session herdr no longer runs are
both named: `<seat>: a state seat not in the file claims pane <pane>` (its pane named when the
record expects one) and `the state records the session "<name>", and herdr does not run it`. The
file is the truth: neither record is ever guessed back into the file, and the one repair is
`team check --repair`, the owner's own write, which drops exactly those records from the state. A
record for a temporary seat is never one of these — [`team add`](add.md) `--temporary` never
writes a temporary seat into the file, and its record is the only place it exists.

## Synopsis

    team check [--session <name>] [--file <path>] [--repair]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--repair` | — | drop the state's leftovers: a record for a seat the file no longer declares, and one for a session herdr no longer runs; the owner's alone |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | check the team; an owner without a terminal is not this caller |
| a seat of the team being checked | the same answer, placed in the file's session, on the pane the state records for it |
| a pane outside the team that the live file names in its `delegates` entries | the same gate the changing commands use, minus the command list and the audit line: the check is a read, not an act |
| anyone else | nothing: the fixed sentence `team check: this team is not yours to check`, whatever failed underneath |

Aimed by a caller that passes the gate but is not the owner, `--file`, `--session` and `--repair`
meet the refusal every command gives them and exit 1.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| nothing needs acting on | `team check: nothing wrong`, over the line naming what the check cannot see (`not known: work sent and unread, a lead waiting on a seat, a landing not recorded`) and the block naming what 0.5.0 must not pretend | 0 |
| the owner's `--repair` dropped the state's leftovers, and nothing else needs acting on | one `repaired: <what was dropped>` line per record, then `team check: nothing wrong`, over the same not-known line and block | 0 |
| something needs acting on | one `difference:` line per finding with its `  repair:` line under it, then `team check: <n> difference(s)`, and `, <n> for the owner` when any finding is the owner's; the not-known line and the same block stand under this answer too | 1 |
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
what 0.5.0 must not pretend:
  Integrity, not authority: every gate 0.5.0 ships holds against a mistake, not against an attempt
  Standing grants with an expiry, not leases
  No two-granter agreement, no `agree`, no `create` bounds
  No read scoping (§3, every disclosure is a `read`), no `act-as`, no `use-broker`, no `deploy` gating
  No constraint program beyond the one-`leads` cardinality and launch-time mutual exclusion (§5)
  No policy object yet (amendment 02)
exit 0
```

The block under the answers is the grants decision record's own list, in its words
(`decided-grants-minimum-2026-10-17`, "What 0.5.0 must not pretend, said plainly"): the limits
this release does not close, said where the check runs rather than left to be discovered.

Rationale, behaviour, refusals and known limits: [docs/internal/check.md](../internal/check.md).
