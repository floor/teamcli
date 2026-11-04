# team check

One answer to one question: **is anything wrong with this team that someone should act on?**
It reads the team file, the record this machine holds of it, the state, herdr and the registries,
and changes nothing except the repairs the owner's `--repair` makes — the state's two leftovers
dropped, the dev-mode mark an agent's registration left cleared, and herdr's drifted sidebar
lines set back from the
file — and the one close the team's lead's or the owner's `--close-orphans` makes: the live agent
processes no pane holds, ended after one question at a terminal. No git is needed, so it answers
as well in a plain folder as in a repository. Where
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
unread wake reads it: a message with no signed read receipt past the seat's unread window —
`watch.unread_after` when the file moved the section, else 30 s for a seat a message can wake
while it is idle and 60 s for a typed or pull-only seat (ADR `zeus-message-path`, D2) — is one
difference for the seat,
`<seat>: a message from <from> has been unread for <n> min (id <id>)`, with
`; <m> more unread` when other messages are due and the oldest named. The sender is the verified
record's own `from`; a record that does not verify is named `an unverified message` and keeps
its age, its id and its count, never the word beside it — that marker is unsigned and lends no
sender, owner or seat. The repair is the seat's delivery class, read on the check's own pass: for
a seat whose record names a turn-start reader, `a wake route stands for <seat> and the message is
still unread; team drops --read --seat <seat> reads it now` when something can wake the seat while
it is idle, and otherwise `nothing gives <seat> a turn while it is idle; team drops --read --seat
<seat> reads it now, or a person or a restart must give it a turn` — with `nothing wakes <seat>
while it is idle except a send-time typed wake into an empty composer` in place of the first
clause when the seat's profile declares the typed wake, and `nothing wakes <seat> while it is
idle except a send-time typed wake, and the watch's typed retry has not delivered this message`
when that profile's watch retry is on for the seat. A seat whose record says no turn-start
reader is installed earns `team drops --read --seat <seat> reads it now; no turn-start reader is
installed, so team reload <seat> installs the launch's hooks` instead. The watch's
unread wake attempts the delivery and reaches no pane in this build, and an attempt that wrote
nothing gives its reservation back, so the message keeps its one wake; a still-reserved marker at
twice the window is reported as a wake that was attempted and whose outcome is unconfirmed, to its
sender's mailbox and the team's lead. The general seat brief keeps its
own read difference and is not counted twice. A person's drop is read by a person and is never asked for a receipt. The
check writes nothing here either.

A live seat whose profile promises a push delivery but whose socket a send would skip is named
on the same pass, in the send's own words. The reading is the send's own: its gate and its
address choice, the same reading `team status` prints, over the same store. A seat is judged
only while its delivery order leaves the socket room — an order that names it, the default that
puts it first for an accepting receiver, or the `typed` wake word whose event adapters stand in
for it; a declared order that names neither chose its routes, and the check never calls a
choice a skip. Only a pane that still holds the seat is read: the same process-identity and
continuity gate the status comparison applies, so a CLI that ended in a retained pane keeps its
one existing line and gains none here. A team file that opts out (`inbound` hold or refuse), a
person's pane, a seat its launch already wakes through the push channel, and a seat whose
delivery class is between-turns are no finding. The line is
`<seat>: sends go to its drop folder, not its socket: <why>`, one per seat, and it is a
difference like an unread drop: exit 1. Four reasons are the team's to fix, each with the act
that fixes it: the launch's own settings declare accept while the team file's word is what is
missing, repaired by `team config set seats.<seat>.inbound accept`; a team file that accepts
while the launch's effective settings do not, repaired by `team restart <seat>` when this
build's generated file is what declares nothing, by declaring `crossSessionInbound: accept` in
the settings the launch names (or dropping the launch's own `--settings` so the generated
settings carry the team's word) and then restarting, and by `team restart <seat>` for a wrapper
launch that carries no settings at all — this reason is read before the address, because a
session whose settings never declared accept is why no socket serves it; a frame the seat's box
held, repaired by `team restart <seat>`, which re-confirms the declaration; and a socket older
than the settings that declare it accepts, repaired by the same restart, which writes one that
does not predate them. Otherwise a socket that is nowhere is the ordinary state of its delivery
class, whatever the gate would say — absence wins — and is not a broken promise: it is a note
naming the class and what happens to its sends next, and it does not change the exit.

The seat's last webhook delivery is one more note of that kind: when its recorded outcome is not
delivered, one line says how the delivery ended — `<seat>: its last webhook delivery did not
arrive: it failed after <n> attempts at <instant>: <reason>; the delivery left the drop record
for the seat's own pull`, or the same sentence with the sent-unknown or refused words — and it
never enters the total or the exit. A delivered record draws no line.

A webhook post a send left in flight is the same kind of note. When a record's claim beside it
is still `sent` — the request may have reached the routine and its answer was never read — and no
bus is serving the root to finish it, one line says how many wait:
`<n> webhook posts await a bus that isn't serving (<root>)` (`1 webhook post awaits` for one).
A bus that serves the root draws no line: its own pass records the outcome. The line never
reports a post as delivered, and it never enters the total or the exit.

A seat whose chain declares `messaging.store: none` is named on the same pass, one line per seat:
the line says its sends keep no copy, that a socket frame still carries the signed record's bytes
a receiver verifies, and what the copy would have carried — the retry, the unread re-wake, the
read receipt and the `queued, not woken` flag. For a seat the file marks `human` the line says a
send to it is refused instead, because a person's pane is reached by the stored copy alone. The
word is a choice, never a fault, so like every note here it does not enter the total or the exit
([the team file](../team-file.md#messagingstore)).

The nightly harness's latest per-leg result is read on the same pass: `pingpong-legs.json` in the
team's state folder, `.agents` in the project, and nothing else — the check never starts a run,
and a team that has not run the nightly draws no finding for a missing file. A class is over when
its staged-to-read p50 or p95 is past its send-to-read target — channel 3 s and 6 s, webhook 2 s
and 5 s, typed 12 s and 20 s; mailbox has no target — and each measure past one is a difference
naming the run's date: `nightly run <date>: channel p50 4s is over 3s and p95 7s is over 6s`. A
class the result recorded no samples for draws nothing. A message the run recorded as lost is its
own finding — `nightly run <date>: 1 message was lost`, `<n> messages were lost` for more — and a
result older than 36 hours is still read: its misses keep the run's own date, and one more finding
says `nightly run <date> is older than a day`, repaired with `run the nightly again`. A missed
class's repair names that nightly run's per-leg table, a lost message's its lost table, and every
finding here is the team's lead's. A file that is not the nightly result, or cannot be read, is
one finding in the check's own words — `the nightly run result cannot be read`, repaired when the
next nightly rewrites it — never a reading of its contents; a lost count that is not a whole
number is that same finding.

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

Live agent processes no pane holds are named on the same pass, and one flag closes them. The
reading proves a process two ways: the state's own launch records name the shell and the pids a
seat's CLI ran as, and a process no record accounts for is found by the working folder it runs
in, named only when that folder is inside this team's root. Every row says the pid, the CLI, the
age and the team record it answers to — `pid <pid>: a live <cli> process with no pane in session
"<session>" (started <age>; last team <project>, seat <seat>)`, or `no seat record` in place of
the seat — and it is a difference: exit 1. The repair is `close it through the team (team check
--close-orphans)` for a process the close may end, and `inspect it, then stop it by hand if it is
not a seat's` for one it may not (the first repair is the team's lead's, the second the owner's):
a process the state does not name is closeable only when it started at or after the daemon's own
start — a run that cannot read that start names such a process and does not close it — and one
the state names is closeable whatever its start. The reading never guesses. A pane list that cannot be read, or that
reads no agents while the state records seats, names nothing and closes nothing — a failed read
must never make a live seat's CLI look orphaned — and a pane the session could not say what runs
in is named as a note, with processes found by their folder left unnamed under it. A recorded CLI
whose pane went unanswered is proved by the launch's own shell instead: a chain without that
shell proves the CLI left the pane, and a chain that cannot be read names nothing.

`--close-orphans` is the team's lead's or the owner's: a plain seat sees every row and is refused
the close. It asks one question at a terminal — `team check: close <n> orphan processes? [y/N] `
— and a no signals nothing (`left: <n> orphan processes: you answered no`). Before each stop it
re-proves the candidate: the pid still runs the same CLI, its start instant has not moved, no
other session's pane holds it, no pane of this session holds it — read again right before the
signal, because the reading that named the candidate was taken before the question — and a
recorded CLI's launch shell is no longer above it. A stop is the terminate signal, then the
process's identity and this session's panes are read again, then the kill signal for a process
that has not gone in two seconds, and one more second's wait; every outcome is its own line —
`closed: pid <pid>: <cli> (seat <seat>)`,
`forced: pid <pid>: <cli> (seat <seat>)` for one that needed the kill, and `left: pid <pid>:
<why>` for one whose proof no longer held, one it could not end, or one the system refused to
stop. The reading runs again after any close, so the report describes the world the close left,
and the exit is 1 while any difference remains. The close never shares a run with `--repair` (two
acts, and one run could not say which left what) and never runs with `--json` (there is no
terminal to ask at); both are refused at the invocation. The reading costs one process-table read
and one working-folder read for all the pids it needs — never a folder read per process on every
run — and reads nothing at all until a seat record or a listed agent exists.

A watch the machine daemon hosts is read on the same pass. Three states are differences with one
repair: a required watch that stopped or failed reads `watch: stopped in the daemon (<reason>)` or
`watch: failed in the daemon (<reason>)`, and a running watch whose outbound effects are closed
reads `watch: outbound effects blocked; it is not enforcing anything` — it can cycle while those
effects are closed, and the check never prints it as enforcing. Each carries the repair `team
daemon install with the same roots and --watch`, which the owner runs. The rest is a note: a watch
whose last pass failed reads `watch: the last cycle failed`, with the age the record gives that
pass when it holds one (`watch: the last cycle failed <age>`); a watch standing down for a live
pane watch reads `watch: standing by; a live pane watch owns this session (<reason>)`, and it
touches nothing in that session. The lines a difference already carries are not said again as
notes. A watch that is simply cycling, one still starting or stopping, one that has not completed
its first pass, and a stopped or failed watch the record does not call required add no phase line,
and a route the daemon records no watch for prints nothing at all — a watch exists only where one
was started on purpose. A hosted root needs no prior `up`: when the session records no watchdog
file binding, the daemon records the route's own team file, and it never overwrites a record that
names another file. A stopped or failed watch is terminal in the record: nothing here restarts
it, and the daemon does not bring it back by itself, so it runs again only when it is started
again. With more than one watched route, each line ends with its route, `… (<root>)`.

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

A general grant whose op list is the wildcard (`*`) reaches every op, including ops that shipped
after the grant was signed. When such a grant reaches ops that first shipped after its signing, the
check prints one note per grant — `wildcard general grant <id> signed <date> now reaches <ops>,
which shipped in later releases; re-sign the grant to stop this note` — naming only the ops whose
first release is later than that date, each dated from the release tags. Re-signing the grant on or
after that release stops the note. A grant whose signing time cannot be read says `unknown` instead
of claiming an op is new. Like every note here, it is information, never a difference.

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

While dev mode is on for the team, a pending owner card is a difference of its own when it asks
for anything but the two acts still carded there — a general grant change, or loosening the
development-mode record itself: `owner card <id> asks for <actions> under dev mode: policy drift`,
repaired by answering the card or letting it expire. Under the lift a seat, CLI or label change
needs no card, so one still waiting means the card and the policy in force disagree.

## Seats the terminal host restored

A session the terminal host restored comes back with its panes and conversations but without the
names the launch gave them. Each seat is read against its own recorded pane with the same proof
[`team up`](up.md#a-seat-the-terminal-host-restored) adopts with, so the check and the repair
cannot disagree about what "restored" means. A pane that holds a process team did not launch
reads `restored, not launched by team` with `-` in the model column; a pane back at its shell
reads `missing`. Each finding is a difference like any other, repair and who included:

| What the pane holds | The difference | `repair:` |
| --- | --- | --- |
| the seat's own conversation | `<seat> was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it` | `team up` (`who:` the team's lead) |
| no conversation on either side: the declared CLI alone in its workspace, at an idle prompt | the same line with `declared CLI` in place of `conversation` | `team up` (`who:` the team's lead) |
| another conversation, another CLI, another seat's name on the pane, a working pane, unsent text, or a workspace holding another pane | `<seat>: <the proof's reason>` (for example `its pane is named <name>; team never adopts a pane another seat owns`) | `look at the pane` |
| no CLI — the CLI ended, or the host restored the pane without it | `<seat>: its pane runs no CLI (the CLI ended or the session was restored)` | `team up` (`who:` the team's lead) |
| a process the record cannot tie to the launch | `<seat>: its pane holds a process this record cannot tie to the launch` | `look at the pane` |
| the session came back without the seat at all | `<seat> was running and its CLI did not come back (the terminal host restored the session without it)` | `team up` (`who:` the team's lead) |

A lead seat whose process a launcher started draws a note instead — `started by a launcher; team
cannot tell its process from the one it launched` — and no repair: a lead's seat is never restarted
or closed alone.

## A leftover team file

When the team is in the registry and a `.agents/team.yaml` is still in the project, the run
prints one note — `.agents/team.yaml is still in this project, and is no longer read (the team is
in the registry): run team migrate to move it to the Trash` — and neither refuses nor counts it.
A leftover that says something else than the registry is a difference, with `team import` as the
repair.

## Synopsis

    team check [--session <name>] [--file <path>] [--repair] [--close-orphans] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--repair` | — | the owner's repair, one write: drop the state's leftovers (a record for a seat the file no longer declares, a session with no seat of the team in it), re-record a seat an agent registered under dev mode with the caller gate in force, and set herdr's drifted sidebar lines back from the file; the owner's alone |
| `--close-orphans` | — | close the live agent processes the run proves no pane holds, after one question at a terminal: every candidate is re-proven just before it is signalled, a process that will not stop is left and named, and the reading is taken again after the close; the team's lead's or the owner's; never with `--repair` or `--json` |
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

`--close-orphans` is narrower than the check's own gate: the team's lead's or the owner's, never a
plain seat's. Every caller that passes the check still sees every row the reading names, but a
seat that is neither the orchestrator nor the operator, and a delegate pane the file names, is
refused the close with `team check: --close-orphans is the team's lead's or the owner's`, exit 1.

## Output and exit codes

Every run prints the declared limitation of a client app key, on stdout in text mode and as
the `key_isolation` field in JSON: `key isolation: enforced against team panes (key file still readable by same-user processes)`.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| nothing needs acting on | `team <project>, session "<session>"`, any deprecation `warning:` or `note:` lines, and `no differences` | 0 |
| the owner's `--repair` repaired what it can (the state's leftovers dropped, dev-mode marks cleared, drifted sidebar lines set back), and nothing else needs acting on | `team <project>, session "<session>"`, one `repaired: <what was repaired>` line per repair, and `no differences` | 0 |
| the team's lead's or the owner's `--close-orphans` settled every orphan the reading named, and nothing else needs acting on | `team <project>, session "<session>"`, one `closed: pid <pid>: <cli> (<seat>)` line per process stopped, one `forced: …` line for a process that needed the kill, a `left: pid <pid>: <why>` line for a candidate that left on its own first, and `no differences` | 0 |
| the close ran, and something still needs acting on: a process it left, or any other finding | the same `closed:`/`forced:`/`left:` lines, then each remaining `difference:` block and the summary | 1 |
| the close question is answered no | `left: <n> orphan processes: you answered no`, nothing signalled, then the rows as they stood | 1 |
| a plain seat or a delegate pane aims `--close-orphans` | `team check: --close-orphans is the team's lead's or the owner's`, before any question | 1 |
| something needs acting on | `team <project>, session "<session>"`, one `difference:` block per finding with its `  repair:` and `  who:` lines under it, then `<n> difference` / `<n> differences` (and `, <m> for the owner` when any finding is the owner's) | 1 |
| a flag the caller may not aim | the refusal every command gives it | 1 |
| the check can't run (the loader's, the state's or herdr's own text), the invocation can't be read, or the caller may not check this team | `team check: <problem>`, or the one fixed sentence | 2 |
| `--close-orphans` with no terminal, or where no process reading is wired | `team check: --close-orphans asks before it closes anything; it needs a terminal`, or `team check: --close-orphans has no process reading here`; nothing is signalled | 2 |

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

The team runs as the file and the state say, so there is nothing to act on (the notes are the
housekeeping of a role word written the 0.3.5/0.4 way, and each seat's delivery class where no
socket is live):

```console
$ team check ; echo "exit $?"
team beacon, session "lab-beacon"
key isolation: enforced against team panes (key file still readable by same-user processes)
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
note: claude-keeper: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn — claude-keeper reads it at its next turn, and nothing here gives it one (pull-only)
note: claude-beacon: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn — claude-beacon reads it at its next turn, and nothing here gives it one (pull-only)
note: worker: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn — worker reads it at its next turn, and nothing here gives it one (pull-only)
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
note: claude-keeper: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn — claude-keeper reads it at its next turn, and nothing here gives it one (pull-only)
note: claude-beacon: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn — claude-beacon reads it at its next turn, and nothing here gives it one (pull-only)
note: worker: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn — worker reads it at its next turn, and nothing here gives it one (pull-only)
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
