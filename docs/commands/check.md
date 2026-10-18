# team check

One answer to one question: **is anything wrong with this team that someone should act on?**
It reads the team file, the record this machine holds of it, the state, herdr and the registries,
and changes nothing except the repairs the owner's `--repair` makes — the state's two leftovers
dropped, the dev-mode mark an agent's registration left cleared, and herdr's drifted sidebar
lines set back from the
file — no git is needed, so it answers as well in a plain folder as in a repository. Where
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
the file's own declaration then. A seat no source has heard from past the blind threshold — five
minutes shipped, tightened through the inheritance's levels and opened again only by a project —
reads
`unknown (blind)` in
[`team seats`](seats.md) and counts as not working: `<seat>: unknown for over <threshold> — blind,
and it counts as not working`, repaired with the owner's look at the pane.

The state's leftovers are differences too. A record for a seat the file no longer declares — one
an older file named and this one dropped — and a session the file does not name with no seat of
the team in it are both named: `<seat>: left the team file but its record still claims pane <pane>` (its pane
named when the record expects one) and `the state records the session "<name>", and no seat of the
team is in it`. The file is the truth: neither record is ever guessed back into the file, and the
one repair is `team check --repair`, the owner's own write, which drops exactly those records from
the state. A record for a temporary seat is never one of these — [`team add`](add.md) `--temporary`
never writes a temporary seat into the file, and its record is the only place it exists. Nor is the
session this run reads, the file's own or the one `--session` names: one is where the team runs,
the other is what the run is about, and `--repair` never drops the record the check is reading.
Herdr is not consulted about any of this: a pane herdr no longer lists is still a pane the state claims,
and a session herdr runs is still a leftover when no seat of the team is in it. The repair still
waits for the live read: a check whose herdr cannot answer refuses with `check.herdr`, exit 2, and
drops nothing.

The owner's `--repair` is one write over the findings the check can settle from what it already
holds — the file is the truth — and nothing more. The state's leftovers above are dropped. A seat
an agent registered under dev mode, the record the check counts rather than names while dev mode
is on, is recorded again with the caller gate in force: the same write the owner's own
`team register <seat>` makes, with the mark and the caller it named cleared. Each herdr sidebar
line that drifted is set back from the file through the same rename and display report
`team register <seat>` makes. Each repair is named in one `repaired:` line and written to the log;
a herdr that will not take a sidebar line says so as `team register` does, and its difference
stands. Everything else keeps its advice — a model drift's relaunch, a blind seat's look at the
pane — because those are decisions, not writes the file settles, and `--repair` never starts,
stops or relaunches a seat.

## Synopsis

    team check [--session <name>] [--file <path>] [--repair] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--repair` | — | the owner's repair, one write: drop the state's leftovers (a record for a seat the file no longer declares, a session with no seat of the team in it), re-record a seat an agent registered under dev mode with the caller gate in force, and set herdr's drifted sidebar lines back from the file; the owner's alone |
| `--json` | — | emit the structured `team.check` JSON document on stdout (`schema/check.schema.json`) |

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
| nothing needs acting on | `team <project>, session "<session>"`, any deprecation `warning:` or `note:` lines, and `no differences` | 0 |
| the owner's `--repair` repaired what it can (the state's leftovers dropped, dev-mode marks cleared, drifted sidebar lines set back), and nothing else needs acting on | `team <project>, session "<session>"`, one `repaired: <what was repaired>` line per repair, and `no differences` | 0 |
| something needs acting on | `team <project>, session "<session>"`, one `difference:` block per finding with its `  repair:` and `  who:` lines under it, then `<n> difference` / `<n> differences` (and `, <m> for the owner` when any finding is the owner's) | 1 |
| a flag the caller may not aim | the refusal every command gives it | 1 |
| the check can't run (the loader's, the state's or herdr's own text), the invocation can't be read, or the caller may not check this team | `team check: <problem>`, or the one fixed sentence | 2 |

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
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
    leads: true
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

The team runs as the file and the state say, so there is nothing to act on (the note is the
housekeeping of a role word written the 0.3.5/0.4 way):

```console
$ team check ; echo "exit $?"
team beacon, session "beacon"
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
no differences
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/check.md](../internal/check.md).
