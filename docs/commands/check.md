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

The entity's model rule ([team swap](swap.md)) is read on the same pass: every seat of the team
this check runs in whose declared vendor the rule forbids is one difference, naming the rule, the
seat's vendor and the swap proposed — or why none is — and repaired with `team swap queue <seat>`,
which the team's lead runs. Breaches in the entity's other teams are not this team's differences:
the check answers for the team it runs in. A rule that cannot be read is a note, never an empty
rule that would read every seat as in rule.

The general seat brief every launch delivers first is checked on the same pass. A delivery is a
claim and a drop: the claim in the state names the delivery's incarnation, runtime epoch, the
brief's sha256 and the id the record must have. A seat the session launched — a human's pane too,
once the session has launched anything — with no claim, or with one an older build wrote before
claims existed, is the difference `<seat>: the general seat brief has not been delivered`, repaired
with `team reload <seat> or team up`, or with `team up` alone for a human's pane. A recorded
delivery is not taken on trust: the check opens the record at the claim's id and verifies it
against this checkout's message key, the claim's incarnation and this build's brief. A record that
is missing, unsigned, signed by another key, bound to another lifetime or epoch, or holding
another body is `<seat>: the general seat brief's delivery record does not verify`, with the same
repair. When this build's brief is ahead of any seat's claim, the run prints the one rollout hint
`run team brief rollout --apply to deliver the general seat brief to every live seat`, after the
per-seat lines and before the summary. The `--json` document carries the same line as `hint`.

A CLI seat is then asked for its read. `<seat>: the general seat brief has been delivered and not
read` is repaired by the seat's own next turn; a seat whose record says it has no turn-start
reader (`watcher` absent or `none`) is told how to read by hand, with
`team drops --read --seat <seat>`, and how to install the launch's hooks, with
`team reload <seat>`. The read receipt must bind the current claim — its id, incarnation, text hash
and the epoch it was written under — so a receipt an earlier agent, an earlier text or an earlier
runtime left is `<seat>: the general seat brief's read receipt is stale (an earlier agent or an
earlier text)`, and a receipt file that does not verify for the claim is
`<seat>: the general seat brief's read receipt does not verify`, whose repair is
`team brief rollout --apply` recovering the delivery at a new id (the file that does not verify is
left in place). A delivery whose launch did not reach ready keeps its launch difference and its
read is not demanded: the seat reads `<seat>: the general seat brief has been delivered; launch not
ready`, and a read that arrived before readiness is
`<seat>: a read happened before readiness; the runtime is not confirmed`. A human seat is
delivery-only and is never asked to read. `team check` writes none of this: it has no writer mode
and no `--rollout`, and the only act it names is the seat's own read or a delivering command's.

Unread work is named on the same pass. Each seat's drop folder is read the way the watch's
unread wake reads it: a message with no signed read receipt past `watch.unread_after` — ten
minutes when the file omits it — is one difference for the seat,
`<seat>: a message from <from> has been unread for <n> min (id <id>)`, with
`; <m> more unread` when other messages are due and the oldest named. The sender is the verified
record's own `from`; a record that does not verify is named `an unverified message` and keeps
its age, its id and its count, never the word beside it — that marker is unsigned and lends no
sender, owner or seat. The repair is the seat's next turn, or `team drops --read --seat <seat>`
when the seat's record says no turn-start reader is installed; the watch's unread wake types
that same read into an idle seat. The general seat brief keeps its own read difference and is
not counted twice. A person's drop is read by a person and is never asked for a receipt. The
check writes nothing here either.

A seat held at a prompt is named on the same pass: one line per held seat, read from the pane the
state records for it through the watch's own screen reader. A pane that no longer holds the
process team launched — back at its shell, or replaced by one the state's stored session does not
vouch for — is not read for a prompt: the check's own process line already says what the pane is,
and a dialog left in its scrollback is not a seat held at one. The line names the seat, the prompt's
kind — a permission prompt, a trust prompt, a quota prompt (a usage limit, with the reset the
screen words — `resets at 11:00`, `resets in 47h31m` — or `the screen names no reset time`), a
confirm prompt (the CLI's own exit question), or an unrecognised prompt — the
command the screen shows when the profile's trace reader finds one, and the age the state's clock
gives it: `<seat>: stuck at a permission prompt (last active 4m ago): Write(note.txt)`. The age is
the seat's last active moment, the only instant its record carries: the prompt stood up after it,
and the line never claims the prompt itself has waited that long. An unrecognised prompt is a
screen no profile reads whose safety floor carries a prompt row; the line quotes that row —
`matched "Do you want to continue?"` — and a screen the floor did not catch keeps the watch's
`blocked` line instead. A permission prompt is its lead's to answer; a trust prompt, a quota
screen, a confirm prompt or an unrecognised one is the owner's, and a confirm prompt also closes
with `team down --abandon`, a quota screen with the reset it names. The check never answers, types
or nudges: the line names the act, and the pane's own reader takes it. Where `compare()` already
printed its plain permission or trust row for the seat (`status`'s wording), the check replaces it
with this one line, so a held seat is named once. A temporary seat — one `team add --temporary`
recorded and the file never names — is read the same way, from its record, with its like-seat's
CLI.

A watch the machine daemon hosts is read on the same pass, as notes only. The check names the ones
a reader would act on: a watch whose last pass failed reads `watch: the last cycle failed`, with
the age the record gives that pass when it holds one (`watch: the last cycle failed <age>`); a
watch standing down for a live pane watch reads `watch: standing by; a live pane watch owns this
session (<reason>)`, and it touches nothing in that session; a required watch that stopped or
failed reads `watch: stopped in the daemon (<reason>)` or `watch: failed in the daemon (<reason>)`;
and a watch whose outbound effects are closed adds `watch: outbound effects blocked (no verified
admitted sender is injected); it is not enforcing anything`, whatever its phase — it can cycle
while those effects are closed, and the check never prints it as enforcing. The rest of the watch
is quiet: a watch that is simply cycling, one still starting or stopping, one that has not
completed its first pass, and a stopped or failed watch the record does not call required add no
phase line, and a route the daemon records no watch for prints nothing at all — a watch exists
only where one was started on purpose. A stopped or failed watch is terminal in the record: nothing
here restarts it, and the daemon does not bring it back by itself, so it runs again only when it is
started again. With more than one watched route, each line ends with its route, `… (<root>)`.

A pane watch the session's state records is read through the same liveness predicate [`team up`](up.md)
plans from, and the same rules keep it quiet: a live process with a fresh heartbeat adds no line. A
recorded process that is gone reads `watch: the recorded process <pid> is gone; the next team up
starts one`; a live process behind an old or unreadable heartbeat reads `watch: process <pid> is
alive but its heartbeat is old; the next team up replaces it`; a record with no process or pane
reads `watch: recorded with no process or pane; the next team up starts one`; and, when the daemon
reading proves no hosted watch owns the route, no watch at all reads `watch: none running; the next
team up starts one`. A hosted watch that owns the route suppresses the pane reading, and a session
that is not running has no watch to expect. When the daemon's health cannot be read, the pane line
names that limit instead of a repair `up` will not make, and a standing-by hosted watch does not
claim a live pane watch that its record no longer shows. These notes never enter the total and
never change the exit.

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

Every run prints the declared limitation of a client app key, on stdout in text mode and as
the `key_isolation` field in JSON: `key isolation: enforced against team panes (key file still readable by same-user processes)`.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| nothing needs acting on | `team <project>, session "<session>"`, any deprecation `warning:` or `note:` lines, and `no differences` | 0 |
| the owner's `--repair` repaired what it can (the state's leftovers dropped, dev-mode marks cleared, drifted sidebar lines set back), and nothing else needs acting on | `team <project>, session "<session>"`, one `repaired: <what was repaired>` line per repair, and `no differences` | 0 |
| something needs acting on | `team <project>, session "<session>"`, one `difference:` block per finding with its `  repair:` and `  who:` lines under it, then `<n> difference` / `<n> differences` (and `, <m> for the owner` when any finding is the owner's) | 1 |
| a flag the caller may not aim | the refusal every command gives it | 1 |
| the check can't run (the loader's, the state's or herdr's own text), the invocation can't be read, or the caller may not check this team | `team check: <problem>`, or the one fixed sentence | 2 |

## Example

```fixture
briefs: delivered-and-read
watch: none
state:
  watch:
    pid: 4242
    heartbeat: "2026-10-04T09:00:00.000Z"
    pane: w9:p1
    workspace: w9
```

```yaml file=.agents/team.yaml
format: 1
project: beacon
entity: lab
operator: claude-keeper

identity:
  humans: [jane@acme.example]

trust:
  - ~/.config/team/lobbies/lab
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

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
```

The team runs as the file and the state say, so there is nothing to act on (the note is the
housekeeping of a role word written the 0.3.5/0.4 way):

```console
$ team check ; echo "exit $?"
team beacon, session "lab-beacon"
key isolation: enforced against team panes (key file still readable by same-user processes)
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
note: watch: the recorded process 4242 is gone; the daemon health cannot say whether a hosted watch owns the route
no differences
exit 0
```

The entity's rule refuses this lab, and the check names each seat of the team it runs in with the
swap the queue would take — the same breach list `team swap --rule` prints for the entity:

```console
$ team policy set entity model-rule '*=!anthropic' ; echo "exit $?"
policy: set model-rule=*=!anthropic at entity (lab)
exit 0
$ team check ; echo "exit $?"
team beacon, session "lab-beacon"
key isolation: enforced against team panes (key file still readable by same-user processes)
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
note: watch: the recorded process 4242 is gone; the daemon health cannot say whether a hosted watch owns the route
difference: claude-keeper: declares vendor anthropic, which the entity model rule *=!anthropic refuses; a swap to claude-code DeepSeek Flash 4.0 from beacon/worker is proposed
  repair: team swap queue claude-keeper
  who: the team's lead
difference: claude-beacon: declares vendor anthropic, which the entity model rule *=!anthropic refuses; a swap to claude-code DeepSeek Flash 4.0 from beacon/worker is proposed
  repair: team swap queue claude-beacon
  who: the team's lead
2 differences
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/check.md](../internal/check.md).
