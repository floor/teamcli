# team watch

Watches a running team. Every `watch.interval` seconds it reads the session — the seats, their
screens, the file, the record, the machine — prints what is wrong, and removes a merged worktree
whose end holds. A temporary seat is left as it is: the owner removes it.

A report is never typed into a seat. It goes to `.agents/team.log` and to the desktop
notification; the operator reads the log. The watch's fixed typed lines are the ring, a pause
notice, a held send's retry and the wake of a seat whose message has gone unread; none carries a
report's text, and the retry and the wake name the drop rather than the body. An automatic work
request is not typed at all. Every pass reads one shared idle snapshot and asks the direct send
route to deliver the work prompt; `watch.nudge`, when the file sets it, is the body, and when the
file omits it the body is the fixed line `Team watch: reports are waiting in .agents/team.log`.
The snapshot counts a seat idle only when it is declared, exactly one herdr agent carries its
name, herdr reports that agent idle or done, its screen is an empty prompt, the seat is not the
lead, the operator, a human's pane, parked, stopped or waiting on a swap, and its persisted
activity clock parses and is older than the `idle-threshold` policy's window (300s when nothing
declares one). A seat with no readable clock, an unknown window or an unreadable source
is asked nothing and typed at by nobody: absence of truthful idle evidence is suppression, never
a guess. Each idle seat spends one attempt per idle episode, a refusal included; a route that is
absent or refuses leaves one signed Runtime mailbox record for the team lead and the main
orchestrator, and nothing is typed for the seat. An actionable reading with no takeable record
leaves one signed record per idle stretch that it found nothing queued, and none under a pause;
a seat still idle a minute after an accepted wake, with no live lease and no activity clock past
the wake, is recorded once and not woken again in that episode.

A message waiting for a seat in its own drop folder — `.agents/send-drops/<session>/<seat>/`,
the folder `team drops --read` serves — is the ring: when that seat's box is an empty idle
prompt, the watch types the message-display wake line — the rendered header and the fixed
`Read it with: team drops --read.` hint — and not the body. A record waiting in the older
mailbox store `.agents/messages/<seat>/` is never rung: the read the line names does not serve
it, so the line would print nothing and fire every pass; that record still raises the owner's
waiting line when its box is not free. A seat whose idle episode the dispatcher owns this pass is
not rung: that episode
is delivered, or reported undelivered, by the dispatcher. Both texts are taken from the live
file, so they do not wait for a record; a missing record does not stop the ring either. The
watch types nothing into a screen it can't read as an empty idle prompt, so a
permission dialog and a half-typed sentence are left alone. The operator and the orchestrator are
never the target of the dispatcher's push, and a pane that is in a dialog or already holds unsent
text is not either. The ring goes only to the
message's recipient, and only when that box is free. A box that already holds the ring this watch typed is
sent, not typed into twice — and only by the watch process that typed it: the same text from
anyone else, or found after a restart, is its owner's, and is never sent or cleared. An attention
report — a permission prompt, a question, a vendor notice, an unknown screen, unsent text — is
said once, and again only after it has cleared for two passes in a row: one pass that does not
show it is the flicker grace, so a flickering screen reports once, not every other pass. Every
other report keeps the drop-on-first-clear rule: it is said once and again as soon as it clears. A
screen hatch is an escape hatch for a CLI whose
screens the data primitives cannot express. The guarantees cover what a hatch returns and what load
accepts; a hatch is trusted package code, not a sandbox.

## Synopsis

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

## What it reads and writes

Reads the team file — again on every pass, so a seat parked or stopped since is seen — this
machine's record store, the session's state (`.agents/team.state.json`) and herdr: the session's
agents, each pane's screen and status. With no `--file`, that file is `.agents/team.yaml` of the
repository's main checkout, found through git's common directory; a folder that is not a git
repository is read from `.agents/team.yaml` in that folder only, not from a parent, and a link at
`.agents` or at the file is not followed. A file at another path is what this command reads when `up` recorded it for the watch
this session's state names: the command `up` runs carries no `--file`, and any other non-owner
is refused. It also reads the machine's load, free memory, free disk, swap and
the OS's memory-pressure level, and, when a temporary seat's end is judged, git.

Writes `.agents/team.state.json` (the pane it runs in, the workspace, its pid and a heartbeat, once
a pass; a temporary seat's `worked` and `own_commits` when it sees them; the accounts' latest screen
readings and the money the spend checks read), `.agents/team.log` (every line it prints), the
owner's mailbox `.agents/messages/owner/` when this watch is the owner's delivery path (one signed
record per event delivered to the owner, at once or as the pass's digest), the direct send's
signed record and its transport marker under `.agents/send-drops/<session>/<seat>/` when the
dispatcher pushes an idle seat, the unread report's signed drop under
`.agents/send-drops/<session>/<lead>` when a message stays unread past twice the window, and,
through herdr: the typed line and its Enter — a pause
notice's line naming its drop, a held send's retry, the unread wake, or the ring — and the seats'
sidebar lines — the workspace title from the file, and the
display line from the file and the pane's
screen; it paints them on its first cycle and again when the title, the model or the effort
changes.

The pane watch is the path this build ships by default. A daemon-hosted watch lifecycle — the
same pass driven by the daemon's fixed heartbeat tick, with an existing pane watch asked to hand
over through its own loop and stood by honestly when it does not answer — is in the current
source: it runs when the daemon is started or installed with `--watch`
([daemon](daemon.md)). This build neither installs nor activates it on its own, and its live
activation and installed acceptance are not proven.

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
`team watch: only the owner or a placed seat runs this, from a terminal outside herdr or its own
pane`. `up` starts one for the
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
| `--no-nudge` | the owner's. Type nothing into any pane: no pause notice, no message ring, no held-send retry and no unread wake, and the dispatcher dispatches nothing at all. The reports still go to the log, and a report for the owner is still a desktop notification |
| `--no-notify` | the owner's. No desktop notification for a report addressed to the operator. A report addressed to the owner is still notified, still written to the log, and still visible in `team status` |
| `--json` | not used on the daemon loop: the flag is an invocation refusal, one `team.error` document on stdout with stderr empty, and exit 2 |
| `--help`, `-h` | the usage — the exits below in its last lines — and exit 0 |

## What it prints

Every line carries its time, and every line goes to `.agents/team.log` as well:

    2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
    2026-10-04T09:00:00.000Z claude-keeper asked a question: the operator's to act on
    2026-10-04T09:00:00.000Z the watch of "beacon" stopped

An attention report — a dialog, a question, a vendor notice, an unknown screen, unsent text — is
printed when it starts, and again only after it has cleared for two passes in a row: one pass
that does not show it is the flicker grace, so a screen that comes and goes reports once. Every
other report is printed when it starts and again as soon as it clears: a seat that stays blocked,
or a machine that stays full, is said once, not every pass.

Two things go to `.agents/team.log` without being printed: the watch writes the machine's own
readings once every ten minutes per watch — `readings: load 1.0/core, memory 69%, disk
227700000000 B free, pressure normal, swap used 7300000000 B of 8600000000 B (free 1300000000 B)`,
`unread` where a figure or the platform's pressure level couldn't be read — and `up` and `add`
write one line per machine refusal, carrying the refusal and the readings it was decided on. The
readings are the byte figures and the level the gate compared, in this fixed order — load, memory,
disk, pressure, swap — so a later launch reads the figure that was compared, not prose about it;
the rounded-GB sentence stays the refusal the owner reads. At the
watch's worst rate that is 144 readings lines a day plus refusals, ≈170 bytes a line and ≈25 KB
a day: a 1 MB log holds ≈40 days of that, and three are kept, ≈5 months.

| Report | Made when |
| --- | --- |
| `<seat> is in the file and is not running` | herdr lists no agent for a seat the file has, does not stop, and the watch has not seen running |
| `<seat> was running and is gone (its pane closed, or its CLI ended)` | herdr lists no agent for a seat the watch had seen running; said at each disappearance |
| `<seat> is no longer the process team launched (its session was restored, or its CLI was restarted)` | the process in the seat's pane is not the one recorded when `team` launched it: the pane runs no CLI, or a program `team` did not launch runs in it and the agent session herdr shows there is not the one stored at launch. A pane the stored session came back on is the seat again and is not reported; a seat with no record of its launch, or a pane herdr can't read, is not reported either |
| `<seat>: its launch line starts a launcher, and the process in its pane is not the one team launched — <repair>` | that pane holds a process `team` did not launch, and the launch line starts a program other than the CLI's own binary, or the file says the launcher chooses the model. A pane back at its shell is not this report. `<repair>` is `team restart <seat>`. A lead's own seat is never restarted alone, so the report is `<seat>: started by a launcher; team cannot tell its process from the one it launched`, with no repair and no command that stops the team. The watch does not start the seat |
| `<seat> waits at a permission prompt: its owner's to answer` | a permission dialog or a trust question; only its owner answers those |
| `<seat> asked a question: the operator's to act on` | a question the seat is waiting on |
| `<seat> shows a vendor notice: its owner's to act on` | a screen the seat's profile captures as a vendor notice — today, Codex 0.157.0's update screen; `team` never answers one |
| `<seat> shows a provider error: connection lost, and no capture names a retry` | a Claude Code seat stopped on its provider's connection error; told to the operator and the owner, once, while the seat is not working; `team` never types into that screen. The error is read in the live region, so one the turn has already ended above a ready composer is history and is not reported |
| `<seat> is at a rate limit on <account>: usage limit, resets at <time>` | a seat stopped on its provider's usage limit, and the screen names when it resets — today Claude Code's rejected 429 or 403 and Gemini's exhausted-quota dialog; `<account>` is the pool the seat spends, its own `account:` or its vendor when it names none; told to the operator and the owner, once, while the seat is not working; `team` never types into that screen |
| `<seat> is at a rate limit on <account>: usage limit, and the screen names no reset time` | the same usage-limit screen when it names no reset time |
| `<seat> is still at a <prompt> prompt after <n> minutes: the team's lead has not cleared it, and the entity's lead and the owner are told` | a permission, vendor-notice or rate-limit prompt held for `prompt_escalation_seconds` (5m in this release): once per prompt, the team's lead having cleared none of it |
| `<seat> is blocked, and its screen is not one the watch recognises` | herdr says blocked and the screen says nothing the watch knows |
| `<seat>: herdr reports the status "<status>"` | a status that is neither idle, done, working nor blocked; a seat whose profile says herdr cannot report it is read from its screen, so this is said only when that screen cannot be read either |
| `<seat> holds text in its input box that was never sent` | unsent text for `watch.unsent_after`; the watch's own typed line never sends or clears text it cannot show it typed itself (a held-send retry is a delivery, which copies the owner's text and puts it back) |
| `<seat> has been idle since the watch started` | quiet for `watch.idle_first`, and never seen working (reported to its lead once; repeated every `watch.idle_repeat` when set) |
| `<seat> has been idle for <n> minutes` | quiet for `watch.idle_first` since its last turn (reported to its lead once per idle period; repeated every `watch.idle_repeat` when set) |
| `<seat> has been idle for <n> minutes — reported to the owner` (or `… since the watch started — reported to the owner`) | the same idle period, quiet for `watch.idle_owner`: said once per idle period, and it is the owner's |
| `every agent is idle` | every seat that is not the orchestrator, the operator or parked, quiet for `watch.team_idle` |
| `<seat> runs <model> <version>; the registry says <declared>: it signs with the wrong model — <repair>` (`<declared>` is the model and version the seat's signed registry record keeps) | the running model or version is not the one the seat's signed registry record keeps; the team file is only the roster projection and is not read as a fallback here, so a seat with no signed record has no baseline in this check and is not reported. `<repair>` is `team remove <seat> --keep, then team add <seat>`; a lead is not removed, so it is `team down, then team up` (to restart the whole team). The watch does not start the seat |
| `<seat>: declares vendor <vendor>, which the entity model rule <rule> refuses; <action>` | the entity's model rule (Policies rule 10) refuses the vendor the seat's file declares. `<action>` is `a swap to <cli> <model> <version> from <team>/<seat> is proposed`, or the reason no recipe is proposed; the swap is queued with `team swap queue <seat>`. The same breach is a `team check` difference in this team; a rule that cannot be read is said once to the owner, and no breach is judged |
| `<name> (<pane>) is running and is not in the file` | an agent in the session no seat claims, a workspace labelled `Watch · <project>` aside |
| `<name> (<pane>) runs <model> <version>, of the lab <lab>, which the entity model rule <rule> refuses for an unclaimed seat — reported, never closed` | an agent in the session no seat claims, whose screen names a model of a lab the rule's `*` entry refuses for a pane no seat answers for. Reported to its lead and by `team check`, and never closed: the pane may be doing work someone started by hand. Only a model a shipped profile reads is judged; an unread pane is the plain extra report |
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
machine, then entity, project, team, seat. Every level has a file surface of its own:

| Threshold | Machine `settings.yaml` | Entity and project records | Team file | Shipped |
| --- | --- | --- | --- | --- |
| idle to the lead | `liveness.idle_lead_seconds` | `liveness.idle_lead_seconds` | `watch.idle_first` | 5m |
| idle to the owner | `liveness.idle_owner_seconds` | `liveness.idle_owner_seconds` | `watch.idle_owner` | 15m |
| unknown to blind | `liveness.blind_after_seconds` | `liveness.blind_after_seconds` | `watch.blind_after` | 5m |

The machine's file is `~/.config/team/settings.yaml`; an entity declares its word in its
`entities.yaml` entry, a project in its record in `projects.yaml`, and a seat in its own team-file
entry under `liveness`. A lower level may tighten one — a shorter window — and never loosen it — a
longer one — unless the level above allows it. The blind window is the one the project may open
again once something closed it; every level inside may close it again. A word that would loosen
one is set aside, the value in force stands, and the watch says the rule once per setting, as a
line of its own (never a report and never a typed line):

    liveness_idle_lead_seconds: the team declared 10m, longer than the 5m in force — a liveness threshold may be tightened, never loosened, unless the level above allows it

A reader is silent about a file it cannot read, or a `liveness` map with an unknown key or a value
that is not a number of seconds: that word is no word at all, and the value in force stands. A
liveness word must be whole seconds of at least one. A fraction or a zero is not a window, so it
is set aside as invalid — never called a loosening — and the value in force stands:

    state_blind_after_seconds: the team declared 1.5s, which is not a whole number of seconds; it is set aside

The blind window is the one `team status` and `team check` read as `unknown (blind)`.
`watch.idle_repeat` repeats the lead's line only: the owner is told once per idle period.
`tempo` does not scale `idle_owner` or `blind_after`; it scales the idle window after the
tighten-only check, so `relaxed` lengthens the resolved window and is never read as a loosening.

Each report is addressed to the owner or to the operator. The operator's is never typed into a
seat — it goes to the log — and `--no-notify` can drop its desktop notification. The owner's — a
permission prompt, a
vendor notice, a machine figure, an account inside its reserve or at its floor, an idle seat past
`idle_owner` — is notified anyway, and so are the watch's own notices: the file can't be read,
herdr doesn't answer, a typed line was not sent, and the watch
stopped. Neither flag removes the log line, and neither reaches `team status`: a reserve still
shows on the budgets table, and a record that is not in force still shows there.

A prompt never goes silent. When the seat at the prompt is the team's lead, or when any seat has
held its prompt for the escalation window — `prompt_escalation_seconds`, a fixed five minutes in
this release, with no owner setter yet; the threshold set binds the window to shorten only —
the watch raises
`seat.prompt-escalated` beside its report. The routing sends that event, and a lead's own
`seat.at-prompt`, to the entity's own lead and to the owner at once, and the watch leaves one
signed record in the entity lead's mailbox under the entity team's own root, where that team's
watch rings it as a message. A prompt that clears before the window is the lead acting, and no
climb is raised. Nothing is typed into any pane for a climb: it is an event and a mailbox record,
never a keystroke, so a prompt in a human's pane climbs the same way and is never nudged.

Owner-addressed events take the same path from the Runtime, with no seat in it. The watch is the
owner's delivery path when the owner check that admits owner-only actions admits it, when it runs
in the agentless pane `up` starts it in, or when it is the watch this session recorded; only then
does it subscribe to `.agents/bus.sock` as the owner. A watch a seat starts in its own pane runs
its passes, polls and publishes what it sees, but never subscribes with the owner's identity. On
the owner's path, an event the policy routes to the owner and on the owner's immediacy list — a
seat at a permission, trust, login, vendor or rate-limit prompt, a lead's `seat.unreachable` or
`seat.done`, and every roster, grant and policy event — rings on the pass that reads it and lands
as its own signed record in the owner's mailbox, `.agents/messages/owner/`; every other
owner-routed event waits in the pass and lands at its end as one digest record, its body the pass's
lines. Both are signed, written at mode `0600`, and listed by `team messages`. The immediacy list
is the `owner-at-once` setting, the owner's alone, and `--no-notify` silences neither kind. A
report this watch also publishes as an event is rung once and recorded once: the notification it
already made is not repeated when the event's copy comes back on the bus, and that copy's record is
the one in the mailbox.

The watch types fixed lines, and never a report: the ring, when a message waits for a seat; a
pause notice, when a pause lands; a retry for a drop this watch is delivering; and the unread
wake, for a seat whose message has been unread for `watch.unread_after` (ten minutes by
default). The retry and the unread wake type the same line: the rendered `message-display`
header and the fixed hint `Read it with: team drops --read.` ([team
send](send.md#the-message-display-wake-line)). A sender the watch cannot name falls back to the
shipped nameless ring, `Team: run team drops --read --seat <seat> --session <session>`, rather
than ringing nothing. Automatic work is never typed: the dispatcher's own lines below say what
it did instead. The lines around them:

| Line | Made when |
| --- | --- |
| `watching the session "<session>" every <n>s` | at the start; `, without nudges` is added by `--no-nudge` |
| `nudged <seat>: <the pause notice>` | a pause stands and the notice was typed into a seat that takes work and sent; a paused pass types no work prompt |
| `nudged <seat> (its own unsent line was already in its box): <the pause notice>` | the box still held the line this same watch process had typed, its Enter never sent; that line is sent instead of typed again |
| `nudge not typed (--no-nudge): <the body>` | `--no-nudge`, with the pause notice due; nothing is typed and no drop is written |
| `ring not typed (--no-nudge): <the message-display wake line>` | `--no-nudge`, with a message waiting and the seat's box free; nothing is typed and the record stays |
| `ring not typed: message <id> is already read` | the message's signed read receipt verified between this pass's mailbox read and the ring's delivery; nothing is typed, because the already-read message is not reminded |
| `a nudge was typed and not sent: <seat>'s box does not hold it` | the pane had not drawn the typed line, or held something else, when the bounded wait for it ended; nothing is sent, and the line is tried again on the next pass |
| `rang <seat>: <the message-display wake line>` | a message was already waiting, that seat's box was an empty idle prompt, and the dispatcher did not own an episode for it that pass; the line was typed and sent, and the body was not |
| `message <id> for <seat> has been waiting <n> minutes` | that message is older than `nudge_wait` and the seat's box was not free; said once, to the owner, and nothing is typed |
| `<seat>: its work was not dispatched directly (<why>); nothing was typed for it this episode` | the shared idle reading counted the seat idle with takeable work, and the direct route was absent or refused, once per idle episode |
| `<seat> was not told: <why>` / `<role> <seat> was not told: <why>` | a dispatcher record could not be written to the team lead or the main orchestrator; the target and the reason are named, and no identity is invented in its place |
| `herdr doesn't answer; the watch keeps trying` | the pass is skipped and the watch goes on |
| `<account>: its check is unreadable` | the check command failed, timed out, or printed something other than one to three lines for a subscription or one line for a spend account; its output is never logged |
| `the check for <account> is unapproved; that account reads unknown` | the check's file changed since the record was written, or no record holds it: it is not run |
| `the session "<session>" is not this file's "<session>": its readings are not saved` | `--session` names a session other than the file's own; said once, on the first pass that sees it |
| `team.yaml can't be read (<problem>); watching with the team as it was` | the file broke and no copy of it validated |
| `liveness_<setting>: the <level> declared <n>, longer than the <n> in force — a liveness threshold may be tightened, never loosened, unless the level above allows it` | a liveness word in the chain would loosen a threshold: it is set aside, the value in force stands, and the line is said once per setting |
| `<name>: its record is not an approved seat; left as it is (the owner cleans it: team remove <name> --abandon)` | a temporary seat whose end is proved and whose pane is free is left running |
| `worktree <task> was not removed` | its removal failed; it is tried again on the next pass |
| `<seat>: an inbox send from <from> was read in its inbox` | the seat's client read an `mcp-inbox` message after the sender's own short wait had ended; the history records `delivered (read)` and the record beside the drop is cleared, and nothing is typed |
| `<seat>: a dropped send from <from> was read in its drop folder` | the seat's own turn-start read (`team drops --read`) wrote its signed receipt; the history records `delivered (read)` and the marker beside the record is cleared, and nothing is typed |
| `<seat>: a dropped send from <from> was not read (no receipt within 30m); the drop file is at <path>` | thirty minutes passed with no signed receipt on a `drop`-leg marker: the marker is cleared, the record stays in the folder, and nothing is ever typed for it |
| `<seat>: a held send from <from> was sent on retry (trigger taken, no read receipt yet)` / `<seat>: an inbox send from <from> was sent on retry (trigger taken, no read receipt yet)` | this pass typed the drop's trigger line and sent it: a held send once the box was free, or an inbox message still unread past its ten-minute fallback window; the history records `sent (unconfirmed)`, never a read; when the retry moved an unsent draft, its receipt follows on the same line (`; the unsent text was pasted back`, or `; the unsent text could not be put back; its copy is at <path>`) and in the history note |
| `<seat>: a held send from <from> was read on retry (receipt)` / `<seat>: an inbox send from <from> was read on retry (receipt)` | the retry's line is the message-display wake line, whose hint is `team drops --read`, and its signed receipt landed inside the retry's window: the history records `delivered (read)`, the marker is cleared, and nothing is ever typed again |
| `<seat>: a message from <from> was unread and one wake line was sent (trigger taken, no read receipt yet)` / `<seat>: a message from <from> was unread and was read on the wake (receipt)` | a message still without a signed receipt `watch.unread_after` after it landed (ten minutes by default): the pass typed the message-display wake line — the same line a retry types — into a free box; the history records `sent (unconfirmed)` with `trigger taken, no read receipt yet`, or `delivered (read)` when the signed receipt verifies; a draft the wake moved is pasted back, as a retry's is |
| `<seat>: a message from <from> was still unread after <n> min; reported to <sender> and <lead>` / `<seat>: a message from <from> was still unread after <n> min; reported to <lead> only: the sender's own mailbox could not be resolved (<why>)` | the message is still unread at twice `watch.unread_after`: its sender gets one signed Runtime mailbox record under `.agents/messages/`, resolved through the signed record's agent id and this home's agent and team registries (the owner's own for the owner's messages), which `team messages` lists; the team's lead gets one signed send-drop per pass, listing every message due in it, under `.agents/send-drops/<session>/<lead>`, which `team drops --read` serves; its id is fixed by the set of messages it lists, so a repeat pass writes no second — never a keystroke into a pane. Nothing is typed, so `--no-nudge` writes both too. A sender the registries cannot pin to one team, seat and session is never routed by name: only the lead's drop is written, and the line and the drop carry the reason |
| `<seat>: a channel send from <from> was read (receipt)` | the seat's channel handling turn acknowledged a pushed message: its signed receipt names the id with `read_by: channel`, the history records `delivered (read)` with `via: channel`, the marker that waited for it is cleared, and nothing is typed |
| `<seat>: a channel send from <from> was redelivered on the socket` | the push's confirmation window ended with no signed receipt and the receiving seat's socket took the frame: the socket delivery wrote the signed read receipt and its own `delivered` history line, marked `failed: redelivered: channel unconfirmed`, the marker is cleared, and nothing is typed |
| `<seat>: a channel send from <from> was not confirmed; the socket was not taken (<why>), typing the trigger` | the push's one redelivery could not go over the socket, so this pass typed the trigger line: the history records `sent (unconfirmed)` with `failed: redelivered: channel unconfirmed` |
| `<seat>: a channel send from <from> was sent on retry (trigger taken, no read receipt yet)` | the pass that redelivered a push typed its trigger line and sent it: the history line carries `failed: redelivered: channel unconfirmed`, and no later pass redelivers that push again |
| `<seat>: a held send from <from> was not delivered (<why>); the drop file is at <path>; send it again` (the word is `an inbox send` or `a channel send` for those legs) | the retry's bound ended — three typed tries, thirty minutes, a trigger that would not fit in a pane, or a drop file moved away — and the message waits where the line names it |
| `the watch's pane is gone; the watch ends with it` | the pane this watch recorded is no longer in the session; the watch stops, and the stopped line follows |
| `the watch of "<session>" stopped` | the last line, on Ctrl-C or a stop signal |

The dispatcher also leaves signed records in the team lead's and the main orchestrator's
mailboxes, and their bodies are its words, not console lines: `<project>: <seat> is idle with
takeable work but was not told directly (<why>); nothing was typed for it`; `<project>: <n> idle,
nothing queued (<names>)`, once per continuous idle stretch and not under a pause; and
`<project>: <seat> accepted a work wake a minute ago and is still idle with no observed claim; it
will not be woken again in this idle episode`, once, when a pass at least a minute after an
accepted wake finds no live lease and no activity clock at or past the wake.

A message waiting in a seat's own drop folder is not a report: it is what the ring's own reader,
`team drops --read`, serves. When that seat's box is an empty idle prompt, the watch types the
message-display wake line — the rendered header and the fixed `Read it with: team drops --read.`
hint — and not the body. A record waiting in the older mailbox store `.agents/messages/<seat>/`
is not rung: that reader does not serve it, so the line would print nothing and fire every pass;
the record still raises the owner's waiting line when its box is not free. `--no-nudge` types
neither line. A message whose signed read receipt lands after the pass read the mailbox is not rung: the receipt is read once more before the line is typed, and an already-read message is not reminded. A watch of another session types nothing for a message and raises no owner line; the file's own watch still does both. The record stays. A seat whose idle episode the dispatcher owns this pass is not rung either: that episode is delivered, or reported undelivered, by the dispatcher, and an unread record waiting is not a second typed wake. The episode stays the dispatcher's whether the route delivered or refused, so neither case types the ring. A message older than `nudge_wait` whose box is not free raises one owner line naming the id and the recipient, types nothing, and leaves the record where it is. Nothing in this build writes a seat's record there; the owner's
mailbox is the one the Runtime writes. A report is never typed. A seat the team file marks `human: true` is never typed into: a work drop or ring addressed there is not typed, and the report says whose pane was spared; a held send's retry is given up on with the reason, and its message waits in the drop file.

A held send is not a report either. When `team send` found the box busy — a draft, a dialog, a trigger the seat did not take — it ended `held`, `not-submitted` or `unreachable` and left the drop and a record beside it. Each pass delivers one such drop per seat once that seat's box is free — an empty idle prompt, the same trigger still in it unsent, or text its owner left, which the pass copies beside the drop, clears with the profile's measured keys and pastes back exactly as `team send` does; a box it can neither claim nor copy faithfully is left alone — bounded at three typed tries and thirty minutes from the send, and a drop that runs out is named by its path so the message can be sent again. A message the delivery order's `mcp-inbox` leg left is not typed while the seat's own client may still read it: the watch promotes a receipt once — one `delivered (read)` history line, nothing typed — and a message still unread ten minutes after the send is handed to the same retry, whose history line records `failed: mcp-inbox: no receipt within 10m`. A message the delivery order's `drop` leg left is never typed, on that schedule or any other: its marker waits for the seat's own signed receipt, and thirty minutes after the send it is given up on with the drop file's path. A message the `channel` leg pushed waits for the handling turn's `ack` receipt the same way: a receipt promotes it once — one `delivered (read)` history line with `via: channel`, nothing typed — and a push still without one three minutes after it was written is redelivered exactly once, the socket first and then the typed trigger, with `redelivered: channel unconfirmed` written on the marker before either attempt so no later pass repeats it. A session with no home to verify its sender, or a pane a pass cannot type at, spends that one redelivery all the same: the marker says the try was made and the record waits where a person can send it again. A typed record goes before a channel push, and that push before an inbox message's ten-minute fallback, while a channel marker whose own three-minute window has not ended is left alone. `--no-nudge` types nothing, so it retries nothing; the promotion and the channel's socket redelivery type nothing either way and run in that watch too.

A delivery that found no busy box is watched the same way. A message still without a signed
receipt `watch.unread_after` after it landed — ten minutes by default — gets one wake: the same
`team drops --read` line a retry types, under the retry's rules (a readable idle prompt or that
line itself unsent, status `idle` or `done`, the seat lock taken, never a human's pane, a draft
copied and pasted back). One wake line serves every message due for that seat, and a message a
held send's retry owns is not woken twice: the retry's marker is the claim. A message the same
pass's ring already typed is not woken again, so one pass puts the line in front of a seat once.
A wake is reserved on
disk before the line is typed, and the reservation is the attempt's whole claim: a wake a crash
interrupted is never typed a second time, a wake the box held or did not submit gives its
reservation back so a later pass may type it, and one whose delivery reached the pane but could
not be confirmed keeps it, because the attempt is spent. The wake records `sent (unconfirmed)`
until a signed receipt verifies, never a read before one. At twice `watch.unread_after` a message
still unread is reported once: a signed Runtime mailbox record for its sender under
`.agents/messages/`, and a signed send-drop for the team's lead under
`.agents/send-drops/<session>/<lead>` that `team drops --read` serves — never by typing into a
pane — after a report reservation of its own, so a crash between a report and its marker neither
drops it nor writes it twice, and a record or drop already there is left byte for byte. The
words keep the states apart: a wake that was typed
says when its line was sent, one whose attempt was interrupted says it was reserved at that
instant and its outcome is unconfirmed, and one never attempted says no wake line was typed.
`--no-nudge` skips the wake but still writes the report.

The report's sender mailbox is resolved through the signed record's agent id and the agent and
team registries this home holds, never through the `from` name: one agent record naming the same
seat, and for a teammate in another checkout its team record listing that agent at that seat and
recording the session the record is bound to, so the record lands in that team's own root and
session and its own `team messages` reads it. A sender without an agent id, or whose agent,
team or roster entry does not pin the same team, seat and session, is reported to the team's
lead only — a same-named seat here is not that sender — and both the record and the line name
the metadata that was missing. Everything else about the report is unchanged.

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
record was written, or that no record holds, is not run at all. The money a spend check reads is
kept in the state with the pass's screen figures, so `up` and `add` measure the account's floor
against it; a reading that is stale by then reads unknown there.

The live file supplies the reserves, floors, marks, cadence, accounts and seat assignments.
Edits take effect on the next pass once a verified record is in force; otherwise the
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
| `team watch: only the owner or a placed seat runs this, from a terminal outside herdr or its own pane` | 1 |
| `team watch: unknown option --x` / `team watch: unexpected "x"` (each with the usage) | 2 |
| `team watch: team.yaml line <n>: <message>` / `team watch: <message>` | 2 |

Under `--json` — not a flag the loop takes — that invocation refusal is one `team.error`
document on stdout: `error.id` `watch.invocation`, `error.message` the sentence above without
its `team watch: ` prefix, `error.repair` `null`, and stderr stays empty. Every refusal the
command makes while the flag is present uses the same envelope under its own id; the running
loop prints its lines as plain text either way.

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

A question is the operator's to act on, and it is said in the log and nowhere else — the watch
never types a report into a seat. The operator is a lead and is not nudged either way.

```console screens="claude-keeper=question"
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z claude-keeper asked a question: the operator's to act on
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

`--no-nudge` keeps the reports and skips every typed line — for a watch that must not type into a
seat. The report is the same line either way: it never had one of its own.

```console screens="claude-keeper=question"
$ team watch --no-nudge ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s, without nudges
2026-10-04T09:00:00.000Z claude-keeper asked a question: the operator's to act on
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
2026-10-04T09:00:00.000Z the watch-rhythm policy could not be read: team: policy source cannot be read or verified (./.agents/team.yaml: line 3: "[" is not closed on its line); automated work, nudges and escalations are held until it can be read
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z team.yaml is invalid (line 3: "[" is not closed on its line); using the copy of 2026-10-04T09:00:00.000Z
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The file is part of the same pass. The live file is the record, so a `trust` line changed since the
last pass logs no difference, and the team keeps running:

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

The watch reads its timings and work-drop settings from the live file on each pass once a
verified record is in force. Edits take effect on the next pass. A file with no verified
record uses the default timings.
By default an idle seat is reported to its lead once per idle period (`idle_repeat` is off).
A team that wants repeated idle reports turns them on by setting `watch.idle_repeat` to the
repeat interval (such as `idle_repeat: 20m`), repeating every 20 minutes while the seat stays
quiet. The defaults themselves are the liveness windows: five minutes to the lead
(`watch.idle_first`), fifteen to the owner (`watch.idle_owner`), five to blind
(`watch.blind_after`). A team may tighten each one; a longer word is set aside with the rule
named once. A project may tighten them in its own record — and, for the blind window alone, open
it again — and the machine and the team's entity declare their own words above it.

A check the team doesn't want is turned off in `watch.checks`. Edits to that list take effect
on the next pass. The machine below sits at 8% free memory, and the live file turns that
report off even though the record left the check on.

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
0 seats repaired, 0 skipped (working), 0 refused
exit 0
$ team watch ; echo "exit $?"
team watch: a watch already runs for the session "beacon" (pid 4242)
exit 1
```

The six that can't be turned off — `attention`, `missing`, `model-drift`, `model-rule`,
`prompt-escalation` and `approval` — are
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
team up: line 9: watch.checks can't turn off attention: attention, missing, model-drift, model-rule, prompt-escalation, approval always run
team up: line 10: unknown check "disks" in watch.checks: the checks are missing, restored, model-drift, model-rule, attention, provider-error, unsent, idle, extra, team-idle, prompt-escalation, approval, load, memory, disk, swap-free, swap-growth, budget
exit 2
```
