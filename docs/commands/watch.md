# team watch

Watches a running team. Every `watch.interval` seconds it reads the session — the seats, their
screens, the file, the approval, the machine — prints what is wrong, and removes a merged worktree
whose end holds. A temporary seat is left as it is: the owner removes it. When a report is
waiting, it types one fixed line into an idle seat — the nudge —
so that seat reads the log. The operator is not that seat. A missing approval does not
stop that line. It types nothing into a
screen it can't read as an empty idle prompt, so a permission dialog and a half-typed sentence are
left alone. `watch.nudge`, when the file sets it, is sent to each idle worker once
`idle_first` has passed and again every `idle_repeat` when that is set. The body goes to the
same drop file `team send` uses, and the pane receives one short line naming that file.
When `watch.nudge` is omitted, that body is the report line. The text is taken from the
live file, so it does not wait for an approval. The operator, the orchestrator, and the
pane the watch itself is running in are never the target, and neither is a pane that is in
a dialog or already holds unsent text. A box that already holds the nudge's own line is sent, not typed into twice — and only
by the watch process that typed it: the same text from anyone else, or found after a restart, is
its owner's, and is never sent or cleared. A screen hatch is an escape hatch for a CLI whose
screens the data primitives cannot express. The guarantees cover what a hatch returns and what load
accepts; a hatch is trusted package code, not a sandbox.

## Synopsis

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

## What it reads and writes

Reads the team file — again on every pass, so a seat parked or stopped since is seen — this
machine's approval store, the session's state (`.agents/team.state.json`) and herdr: the session's
agents, each pane's screen and status. With no `--file`, that file is `.agents/team.yaml` of the
repository's main checkout, found through git's common directory; a folder that is not a git
repository is read from `.agents/team.yaml` in that folder only, not from a parent, and a link at
`.agents` or at the file is not followed. A file at another path is what this command reads when `up` recorded it for the watch
this session's state names: the command `up` runs carries no `--file`, and any other non-owner
is refused. It also reads the machine's load, free memory, free disk and
swap, and, when a temporary seat's end is judged, git.

Writes `.agents/team.state.json` (the pane it runs in, the workspace, its pid and a heartbeat, once
a pass; a temporary seat's `worked` and `own_commits` when it sees them; the accounts' latest screen
readings and the money the spend checks read), `.agents/team.log` (every line it prints), and,
through herdr: the nudge's text and Enter, and the seats' sidebar lines — the workspace title from
the file, and the display line from the file and the pane's screen; it paints them on its first
cycle and again when the title, the model or the effort changes.

The readings are only written when the watch's session is the file's own `session`: `up` and `add`
count the state as the project's, so a watch on another session — `--session <other>`, which anyone
may run — reads and reports, says so once, and saves no reading, budget or spend.

## How a screen is read

A pane's screen is read by the profile's own expressions — the words a CLI paints for its idle
prompt, its working frame, its dialogs, its questions and the vendor notices it was captured on —
and the reading and the live-agent check
are separate layers. A screen that reproduces a CLI's complete idle frame (input row, status row
and workspace line, in place) reads idle; the live-agent check is the second layer. Old dialog
text standing in the scrollback above a complete idle frame does not change that reading, for the
bordered frame as for the empty-framed one: the dialog was answered and the box redrawn below
it, and a live dialog replaces the box — over every dialog capture of the corpus no window of
the screen holds both. For Cursor the
profile pins the status row's place: a line the row's grammar matches is the row only when the
workspace line sits directly below it, that line is the pane's last non-blank one, and the input
row sits above it within the captured distance — a grammar-looking line anywhere else is ordinary
text that names no row and no model. Grok rows are the profile's exception — selected by their
grammar wherever they sit — and every Grok row in the captures carries exactly the two spaces that
grammar spells.

The box's own border requires the complete frame or nothing: the 2026-10-05 captures draw the input
rows between a ` ▄▄…` row directly above them and a ` ▀▀…` row directly below them — each one space
and then only the block character, running exactly one character longer than the status row at equal width —
with the whole status row directly under the bottom border, the workspace line directly below it, and
nothing following the workspace line but empty rows (the 2026-10-01 captures draw empty frame rows
instead; both frames read). In the bordered frame, the status row must match its closed grammar whole
(a known model family, version, and tokens ending in `Run Everything`, with no Grok exemption), and
the workspace line is required. A border row missing, unequal or not exactly one character longer than
the status row, a border row one row away from the input, a border row carrying anything else, or a border pair
in the transcript above an ordinary box leaves the screen unknown.

## Who may run it

Anyone, in any terminal. A run with no terminal is refused before the watch starts:
`team watch: only the owner runs this, from a terminal outside herdr`. `up` starts one for the
session in a workspace of its own, labelled `Watch · <project>`, and records that pane — and its own
passes record the pid. This is the one `team status` and `team doctor` look for. The owner who runs
`team watch` alone, from a terminal outside herdr, gets the same: the watch hands itself to a
workspace of the team's session, exactly as `up` would start it, and the terminal is free again.
Started inside its own pane, it just runs — the pane the pass finds itself in is the one recorded.
`--no-nudge` and `--no-notify` keep the watch in the terminal that passed them: they are the
owner's, and the pane's own `team watch` could not carry them, so neither flag hands over. A watch
that stays in its caller runs by hand: it prints the same lines, and Ctrl-C stops it and exits 0. Two watches
must not fight over the same session, so a second one refuses: while the recorded watch's pane is
there and its heartbeat is no older than two in-force intervals — or its pid lives — the run says
`team watch: a watch already runs for the session "<session>"` and names the record beside it:
`(pid <pid>)` once a pass has written the pid, `(pane <pane>)` before that, `(pane not recorded)`
when the record has neither. `--file` is the owner's alone too: the watch `up` starts reads the
project's own file from the project root and carries no flag, so a non-owner aiming `--file` at
another project is refused before that file is read.

## When it stops

`up` starts the watch in a workspace of its own, and the state records that pane, the workspace and
the heartbeat of the pass that started it. Ctrl-C stops a watch the same way a stop signal does, and
the record is cleared. A watch started inside a pane ends when the next pass finds that pane gone
again; while it runs, each pass writes its pid and its heartbeat beside the pane. A watch that never
saw itself in a pane — herdr could not tell it, or the process was started from a terminal that is
not one — keeps going, and `team status` shows it with `pane not recorded`. While the pane is gone
and the process is still running, `team doctor` names the process by its name and its pid and the
repair is to stop it and run `team up`.
`remove --keep` and `add` close the seat's workspace. They do not stop the watch.

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session to watch, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--no-nudge` | the owner's. Type nothing into any pane: no report nudge, no work prompt and no message ring. The reports still go to the log, and a report for the owner is still a desktop notification |
| `--no-notify` | the owner's. No desktop notification for a report addressed to the operator. A report addressed to the owner is still notified, still written to the log, and still visible in `team status` |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

Every line carries its time, and every line goes to `.agents/team.log` as well:

    2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
    2026-10-04T09:00:00.000Z claude-keeper asked a question: the operator's to act on
    2026-10-04T09:00:00.000Z nudged claude-beacon: Team watch: reports are waiting in .agents/team.log
    2026-10-04T09:00:00.000Z the watch of "beacon" stopped

A report is printed when it starts, and again only after it has cleared: a seat that stays blocked,
or a machine that stays full, is said once, not every pass.

Two things go to `.agents/team.log` without being printed: the watch writes the machine's own
readings once every ten minutes per watch — `readings: load 1.0/core, memory 69%, disk
227700000000 B free, swap used 7300000000 B of 8600000000 B (free 1300000000 B)`, `unread` where
a figure couldn't be read — and `up` and `add` write one line per machine refusal, carrying the
refusal and the readings it was decided on. The readings are the byte figures the gate compared,
in this fixed order — load, memory, disk, swap — so a later launch reads the figure that was
compared, not prose about it; the rounded-GB sentence stays the refusal the owner reads. At the
watch's worst rate that is 144 readings lines a day plus refusals, ≈170 bytes a line and ≈25 KB
a day: a 1 MB log holds ≈40 days of that, and three are kept, ≈5 months.

| Report | Made when |
| --- | --- |
| `<seat> is in the file and is not running` | herdr lists no agent for a seat the file has, does not stop, and the watch has not seen running |
| `<seat> was running and is gone (its pane closed, or its CLI ended)` | herdr lists no agent for a seat the watch had seen running; said at each disappearance |
| `<seat> is no longer the process team launched (its session was restored, or its CLI was restarted)` | the process in the seat's pane is not the one recorded when `team` launched it: the pane runs no CLI, or a program `team` did not launch runs in it and the agent session herdr shows there is not the one stored at launch. A pane the stored session came back on is the seat again and is not reported; a seat with no record of its launch, or a pane herdr can't read, is not reported either |
| `<seat>: its launch line starts a launcher, and the process in its pane is not the one team launched — <repair>` | that pane holds a process `team` did not launch, and the launch line starts a program other than the CLI's own binary, or the file says the launcher chooses the model. A pane back at its shell is not this report. `<repair>` is `team remove <seat> --keep, then team add <seat>`; a lead is not removed, so it is `team down, then team up` (to restart the whole team). The watch does not start the seat |
| `<seat> waits at a permission prompt: its owner's to answer` | a permission dialog or a trust question; only its owner answers those |
| `<seat> asked a question: the operator's to act on` | a question the seat is waiting on |
| `<seat> shows a vendor notice: its owner's to act on` | a screen the seat's profile captures as a vendor notice — today, Codex 0.157.0's update screen; `team` never answers one |
| `<seat> shows a provider error: connection lost, and no capture names a retry` | a Claude Code seat stopped on its provider's connection error; told to the operator and the owner, once, while the seat is not working; `team` never types into that screen |
| `<seat> is at a rate limit on <account>: usage limit, resets at <time>` | a seat stopped on its provider's usage limit, and the screen names when it resets — today Claude Code's rejected 429 or 403 and Gemini's exhausted-quota dialog; `<account>` is the pool the seat spends, its own `account:` or its vendor when it names none; told to the operator and the owner, once, while the seat is not working; `team` never types into that screen |
| `<seat> is at a rate limit on <account>: usage limit, and the screen names no reset time` | the same usage-limit screen when it names no reset time |
| `<seat> is blocked, and its screen is not one the watch recognises` | herdr says blocked and the screen says nothing the watch knows |
| `<seat>: herdr reports the status "<status>"` | a status that is neither idle, done, working nor blocked |
| `<seat> holds text in its input box that was never sent` | unsent text for `watch.unsent_after`; the watch never sends or clears text it cannot show it typed itself |
| `<seat> has been idle since the watch started` | quiet for `watch.idle_first`, and never seen working (reported to its lead once; repeated every `watch.idle_repeat` when set) |
| `<seat> has been idle for <n> minutes` | quiet for `watch.idle_first` since its last turn (reported to its lead once per idle period; repeated every `watch.idle_repeat` when set) |
| `<seat> has been idle for <n> minutes — reported to the owner` (or `… since the watch started — reported to the owner`) | the same idle period, quiet for `watch.idle_owner`: said once per idle period, and it is the owner's |
| `every agent is idle` | every seat that is not the orchestrator, the operator or parked, quiet for `watch.team_idle` |
| `<seat> runs <model> <version>; the file says <declared>: it signs with the wrong model — <repair>` (`<declared>` is the seat's `display` spelling) | the running model or version is not the file's. `<repair>` is `team remove <seat> --keep, then team add <seat>`; a lead is not removed, so it is `team down, then team up` (to restart the whole team). The watch does not start the seat |
| `<name> (<pane>) is running and is not in the file` | an agent in the session no seat claims, a workspace labelled `Watch · <project>` aside |
| `approved before records were signed` | the record was written by an earlier `team`: not trusted, said once, and the watch keeps watching |
| `<why the record was refused>` | a signed record that does not verify (changed after approval, another root, a replayed or rolled-back generation): said once, and the watch keeps watching |
| `the load is <n> per core, above <n>` | over `machine.load_max` |
| `free memory is <n>%, below <n>%` | under `machine.memory_min` |
| `free disk is <n> GB, below <n> GB` | under `machine.disk_min` |
| `free swap is <n> GB, below <n> GB` | under `machine.swap_free_min` |
| `swap grew by <n> GB in <n> minutes, above <n> GB` | over `machine.swap_growth_max` inside `machine.swap_growth_window` |
| `<account> <window> is <n>% used, past the <n>% mark` | the account's figure is at or past a mark of `budgets.marks`, once per window |
| `<account> <window> left <n>%, inside its <n>% reserve` | a subscription account at or inside its `reserve` |
| `<account> <n> <currency> left, at its <n> <currency> floor` | a spend account at or below its `floor` |
| `<account> is unknown while <seat> runs on it` | nothing counts for an account whose seats are running |

The idle and blind windows are liveness defaults, and they are settings in the inheritance —
machine, then entity, project, team, seat:

| Threshold | Team file | Shipped |
| --- | --- | --- |
| idle to the lead | `watch.idle_first` | 5m |
| idle to the owner | `watch.idle_owner` | 15m |
| unknown to blind | `watch.blind_after` | 5m |

A project record declares them under `liveness`, and the levels above it in their own settings. A
lower level may tighten one — a shorter window — and never loosen it — a longer one — unless the
level above allows it, which no level does today. A word that would loosen one is set aside, the
value in force stands, and the watch says the rule once per setting, as a line of its own (never a
report and never a nudge):

    liveness_idle_lead_seconds: the team declared 10m, longer than the 5m in force — a liveness threshold may be tightened, never loosened, unless the level above allows it

The blind window is the one `team status` and `team check` read as `unknown (blind)`.
`watch.idle_repeat` repeats the lead's line only: the owner is told once per idle period. `tempo`
does not scale `idle_owner` or `blind_after`.

Each report is addressed to the owner or to the operator. The operator's is what the nudge stands
for, and `--no-notify` can drop its desktop notification. The owner's — a permission prompt, a
vendor notice, an approval difference, a
machine figure, an account inside its reserve or at its floor, an idle seat past `idle_owner` — is notified anyway, and so are the
watch's own notices: the file can't be read, herdr doesn't answer, no idle seat could be nudged,
a typed nudge was not sent, and the watch stopped. Neither flag
removes the log line, and neither reaches `team status`: a reserve still shows on the budgets
table, and an approval difference is still a difference.

A report that is the operator's to act on is also what the nudge stands for. The lines around it:

| Line | Made when |
| --- | --- |
| `watching the session "<session>" every <n>s` | at the start; `, without nudges` is added by `--no-nudge` |
| `nudged <seat>: Team watch: reports are waiting in .agents/team.log` | the nudge was typed into an idle seat and sent |
| `nudged <seat> (its own unsent line was already in its box): <nudge>` | the box still held the line this same watch process had typed, its Enter never sent; that line is sent instead of typed again |
| `nudge not typed (--no-nudge): <nudge>` | `--no-nudge`, with reports waiting |
| `ring not typed (--no-nudge): Team: run team messages` | `--no-nudge`, with a message waiting and no report nudge to type; nothing is typed and the record stays |
| `a nudge was typed and not sent: <seat>'s box does not hold it` | the pane had not drawn the typed line, or held something else, when the bounded wait for it ended; nothing is sent, and the reports wait for the next pass |
| `no idle seat could be nudged for <n> minutes; <k> report(s) wait: <reports>` | no idle seat was free for `watch.nudge_wait`; this one is a desktop notification too |
| `rang <seat>: Team: run team messages` | a message was already waiting and that seat's box was an empty idle prompt; the line was typed and sent, and the body was not |
| `message <id> for <seat> has been waiting <n> minutes` | that message is older than `nudge_wait` and the seat's box was not free; said once, to the owner, and nothing is typed |
| `herdr doesn't answer; the watch keeps trying` | the pass is skipped and the watch goes on |
| `<account>: its check is unreadable` | the check command failed, timed out, or printed something other than one to three lines for a subscription or one line for a spend account; its output is never logged |
| `the check for <account> is unapproved; that account reads unknown` | the check's file changed since the approval, or was never approved: it is not run |
| `the session "<session>" is not this file's "<session>": its readings are not saved` | `--session` names a session other than the file's own; said once, on the first pass that sees it |
| `team.yaml can't be read (<problem>); watching with the team as it was` | the file broke and no copy of it validated |
| `liveness_<setting>: the <level> declared <n>, longer than the <n> in force — a liveness threshold may be tightened, never loosened, unless the level above allows it` | a liveness word in the chain would loosen a threshold: it is set aside, the value in force stands, and the line is said once per setting |
| `<name>: its record is not an approved seat; left as it is (the owner cleans it: team remove <name> --abandon)` | a temporary seat whose end is proved and whose pane is free is left running |
| `worktree <task> was not removed` | its removal failed; it is tried again on the next pass |
| `the watch's pane is gone; the watch ends with it` | the pane this watch recorded is no longer in the session; the watch stops, and the stopped line follows |
| `the watch of "<session>" stopped` | the last line, on Ctrl-C or a stop signal |

A message already waiting under `.agents/messages/<seat>/` is not a report. When that seat's box is an empty idle prompt, and this pass is not already typing the report nudge, the watch types `Team: run team messages` and not the body. `--no-nudge` types neither line. A watch of another session types nothing for a message and raises no owner line; the file's own watch still does both. The record stays. The report nudge wins the pane: a pass that types it does not also type the ring. A message older than `nudge_wait` whose box is not free raises one owner line naming the id and the recipient, types nothing, and leaves the record where it is. Nothing in this build writes that record. A report still leaves as the nudge.

## Budgets

The budget reports read the figures the pass saw on the seats' status lines — Codex prints
`weekly N% left` when the pane is wide enough to show the number — and the ones each account's
`check` command reads when its `sources` name `check`. A figure is read off a seat's pane only
while herdr reports the seat's CLI still running in it: a pane listed back at its shell has no
status row to read, and a pane herdr could not read gives no figure. A mark crossing is
the operator's to act on; an account inside its reserve or floor is the owner's. Marks come once
per window and are armed again at the window's known reset — or when the figure drops ten points
with no reset known, which is a new window's.

The check commands run outside the pass, at most every `budgets.check_every`, in an empty
environment with only `PATH` and `HOME`, with a ten-second timeout: one to three lines for a
subscription (`session 21% used resets 3h`, `weekly 39% used resets 114h4m at 1791091200`), one
line for a spend account (`12.40 USD`, in its `floor`'s currency). `check_every` is a pause above
zero: a value that measures to zero is refused, `budgets.check_every must be greater than zero`.
Only their state is ever logged, never a line of what they printed — a failure is `<account>: its
check is unreadable`, a timeout and a contract break alike. A check whose file changed since the
approval, or that was never approved, is not run at all. The money a spend check reads is kept in
the state with the pass's screen figures, so `up` and `add` measure the account's floor against
it; a reading that is stale by then reads unknown there.

The live file supplies the reserves, floors, marks, cadence, accounts and seat assignments.
Edits take effect without another approval once an approval is in force; otherwise the
budget defaults contain no accounts. The same values drive the status table and launch gates.

`budget` is a check like the others: `watch.checks` turns it off. It reports, and never refuses a
seat: the launch gate of `up` and `add` is what refuses. An account whose figure nothing counts —
a check that stopped reading, a stale status line — is reported while seats on it are running;
a first sight, which the launch gate calls `first sight only, not yet counted`, is not.

## Refusals

| Message | Exit |
| --- | --- |
| `team watch: a watch already runs for the session "<session>" (pane <pane>)` / `(pid <pid>)` | 1 |
| `team watch: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team watch: only the watch this session records may read the file up recorded; this call is <caller>` | 1 |
| `team watch: the watch did not start in its workspace` | 1 |
| `team watch: --no-nudge and --no-notify are the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team watch: only the owner runs this, from a terminal outside herdr` | 1 |
| `team watch: unknown option --x` / `team watch: unexpected "x"` (each with the usage) | 2 |
| `team watch: team.yaml line <n>: <message>` / `team watch: <message>` | 2 |

## Exit codes

- `0` — the watch ran, and stopped on Ctrl-C, a stop signal, or the end of its work. Or it handed
  itself to its own workspace and the pane's command started. A seat that
  misbehaves is a report, not a failure; neither is herdr not answering.
- `1` — a watch already runs for the session. Or `--file` was aimed by a caller that is not the
  owner, `--no-nudge`/`--no-notify` by a caller that is not the owner, the file `up` recorded was
  aimed at by a process that is not the watch's pane, or the watch did not start in its workspace.
- `2` — the invocation, the team file or the state can't be read.

## Examples

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

```fixture
watch: none
```

Every `team watch` console below shows a pass as the watch itself prints it — the lines its pane
shows while it runs, and the same lines in `.agents/team.log`. Run bare from the owner's terminal
outside herdr, `team watch` hands itself to its workspace and prints one line about that instead;
a `--no-nudge` or `--no-notify` run, the owner's, stays in the caller's terminal and prints these
lines directly.

The seats are at their prompts, nothing to report: a pass is the two lines that frame it.

```console
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

A question is the operator's to act on, so the watch nudges an idle seat — one fixed line, which is
not the report itself: the report is in the log, and the line says where. The operator is a lead
and is not that seat.

```console screens="claude-keeper=question"
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z claude-keeper asked a question: the operator's to act on
2026-10-04T09:00:00.000Z nudged claude-beacon: Team watch: reports are waiting in .agents/team.log
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

A permission prompt is the owner's, and the watch says so rather than nudging anyone:

```console screens="claude-beacon=permission"
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z claude-beacon waits at a permission prompt: its owner's to answer
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

`--no-nudge` keeps the reports and skips the typing — for a watch that must not type into a seat:

```console screens="claude-keeper=question"
$ team watch --no-nudge ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s, without nudges
2026-10-04T09:00:00.000Z claude-keeper asked a question: the operator's to act on
2026-10-04T09:00:00.000Z nudge not typed (--no-nudge): Team watch: reports are waiting in .agents/team.log
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The machine is watched the same way. Free memory under `machine.memory_min` is the owner's to
answer, and a watch does not stop the team over it:

```console machine=tight
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z free memory is 8%, below 15%
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

A file that no longer validates is not a reason to stop watching: the last copy that did is used,
with a notice, and the watch goes on.

```yaml file=.agents/team.yaml
format: 1
project: beacon
seats: [
```

```console
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z team.yaml is invalid (line 3: "[" is not closed on its line); using the copy of 2026-10-04T09:00:00.000Z
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The file is part of the same pass. The live file is the record, so a `trust` line changed since the
owner approved it logs no difference, and the team keeps running:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon
  - ~/Code/other

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

```console
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The watch reads its timings and nudge settings from the live file on each pass once an
approval is in force. Edits take effect without another approval. A file with no verified
approval uses the default timings.
By default an idle seat is reported to its lead once per idle period (`idle_repeat` is off).
A team that wants repeated idle reports turns them on by setting `watch.idle_repeat` to the
repeat interval (such as `idle_repeat: 20m`), repeating every 20 minutes while the seat stays
quiet. The defaults themselves are the liveness windows: five minutes to the lead
(`watch.idle_first`), fifteen to the owner (`watch.idle_owner`), five to blind
(`watch.blind_after`). A team may tighten each one; a longer word is set aside with the rule
named once, and a project may tighten them in its own record.

A check the team doesn't want is turned off in `watch.checks`. Edits to that list take effect
on the next pass. The machine below sits at 8% free memory, and the live file turns that
report off even though the last approval left the check on.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

watch:
  interval: 120s
  checks:
    memory: off

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

```console machine=tight
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

`up` leaves a watch running in a workspace of its own, so a second one refuses rather than reading
the same session twice:

```console
$ team up ; echo "exit $?"
claude-keeper: ready
  already ready; left as it is
claude-beacon: ready
  already ready; left as it is
watch: started
exit 0
$ team watch ; echo "exit $?"
team watch: a watch already runs for the session "beacon" (pid 4242)
exit 1
```

The four that can't be turned off — `attention`, `missing`, `model-drift` and `approval` — are
refused by the schema itself, with the line, and so is a name that is no check. A command that
reads such a file refuses it the same way, and the watch keeps the last copy that validated, with
the checks as the owner approved them.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

watch:
  interval: 120s
  checks:
    attention: off
    disks: off

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

```console
$ team up ; echo "exit $?"
team up: line 9: watch.checks can't turn off attention: attention, missing, model-drift, approval always run
team up: line 10: unknown check "disks" in watch.checks: the checks are missing, restored, model-drift, attention, provider-error, unsent, idle, extra, team-idle, approval, load, memory, disk, swap-free, swap-growth, budget
exit 2
```
