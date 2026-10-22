---
created: 2026-10-18
updated: 2026-10-20
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Runtime, chapters C and F (commitments 8, 9, 20 and 21)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: seat state and watch

## 1. Scope

This spec covers the word a seat's state is read as, the sources it is read from and their
ranking, the thresholds that bound the reading, the sixteen checks the watch runs, the reports it
makes, and the fixed lines it may type. It leaves the launch steps that record a seat's pane
to the launch spec, the records that hold the state to the registry spec, and the admission rules
that let a seat act to the Kernel. It says what the code at the tag does, in the code's words;
one section and one rule (§3.10, rule 15) record a change made after the tag and not released,
and both are marked as such.

## 2. Terms

- **state word**: one of `working`, `idle`, `done`, `blocked`, `held`, `unreachable`, `unknown`.
- **source**: where the word was read — `cli`, `cli-hook`, `herdr`, `trace`, `process`, `hold`,
  `none` — printed beside the word.
- **hold**: the team's own `team hold` note; while one stands the seat reads `held`.
- **trace**: a seat's last commit, ack or message, each with its own instant.
- **blind**: an `unknown` seat past the blind threshold; `team status` prints `unknown (blind)`.
- **liveness windows**: idle-to-lead, idle-to-owner and unknown-to-blind, in whole seconds.
- **check**: one named module in the watch's pass; sixteen run.
- **report**: `{ key, text, to }`; `to` is `operator` or `owner`.
- **nudge**: the one fixed work line the watch types into an idle worker. Post-tag (§3.10) it is
  the body the dispatcher's direct route carries, and the watch types nothing of it.
- **dispatcher**: the watch's one path from an idle seat with takeable work to a direct push
  (post-tag, §3.10).
- **episode**: one seat's continuous idle stretch in a watch process; one attempt is spent per
  episode, a refusal included (§3.10).
- **ring**: the one fixed line the watch types when a message waits for a seat.
- **held send**: a send held as a drop while a pane was busy, whose trigger the watch may type.
- **pass**: one interval's reading of the seats, the file, the state and the machine.

## 3. Formats

### 3.1 The state reading

`src/labels/state.ts` defines the words and the sources:

| State word | Meaning |
|---|---|
| `working` | the seat is in a turn |
| `idle` | the seat is at a prompt with nothing behind it |
| `done` | the process the launch recorded is no longer in its pane |
| `blocked` | the screen is neither mid-turn nor at a prompt: a dialog, a question, an error, a composer holding unsent text, or the CLI's usage wall |
| `held` | a hold stands over the team |
| `unreachable` | herdr cannot reach the seat |
| `unknown` | no source was certain |

| Source | Meaning |
|---|---|
| `cli` | the pane's screen, read against the seat's CLI profile |
| `cli-hook` | the CLI's own turn-start and turn-end hook |
| `herdr` | herdr's own status word |
| `trace` | TeamCLI's traces inside the trace window |
| `process` | the recorded process identity |
| `hold` | the team's hold |
| `none` | nothing was certain; the word is `unknown` |

The reading answers the first source that is certain, in this order:

1. a hold over the team — `held`;
2. herdr unable to reach the seat — `unreachable`;
3. the launched process no longer in its pane — `done` (`process`);
4. a screen that is a dialog, a question, an error, or a composer holding unsent text —
   `blocked`, whatever any clock says; the CLI's usage wall is `blocked` too, with reason
   `quota`: `status` names the reset the screen words beside the word, and never falls back to
   a bare `done` or `idle`;
5. the CLI's own signal through the hooks the launch installed — `working` at turn start,
   `idle` at turn end, with the instant it wrote; a `working` hook older than the working window
   keeps its word only where the screen is absent or unknown;
6. the pane's screen read against the seat's CLI — `working` or `idle`;
7. herdr's own status word — `working`, `idle` or `done`;
8. TeamCLI's traces within the window — `working`;
9. otherwise `unknown`; past the blind threshold it counts as not working and is flagged
   `blind`.

Two exceptions to that order. A trace inside the window outranks an idle word from the hook, the
screen or herdr, because a seat that just committed, acked or was messaged is working even while
its prompt shows. A `working` hook older than the hook working window of §3.2 (120 s at the tag)
outranks neither a recognised working screen nor a recognised idle one: the screen answers,
because an interrupted turn leaves the hook behind and the prompt shows again. Past its window
the hook still answers `working` for the rest of its day only when the screen is absent or
unknown. A tool row on a screen carries no clock and is kept for display, never weighed as
recency.

The hook reading stands for a day (`CLI_HOOK_FRESH_SECONDS` = 86400); a hook timestamp more than
sixty seconds in the future (`CLI_HOOK_FUTURE_SKEW_SECONDS`) is not a reading. The working window
is the shorter bound above: past it a readable screen wins, and the hook stands only where no
screen can be read.

### 3.2 Thresholds

The shipped values, and the policy names that carry them:

| Threshold | Shipped | Policy name | May be loosened by |
|---|---|---|---|
| idle to the lead | 300 s | `liveness-idle-lead-seconds` | no level |
| idle to the owner | 900 s | `liveness-idle-owner-seconds` | no level |
| unknown to blind | 300 s | `state-blind-after-seconds` | the project |
| trace window | 120 s | `state-trace-window-seconds` | the project |
| hook working window | 120 s | `state-hook-working-seconds` | the project |

The chain is machine → entity → project → team → seat, read outermost first. `liveness` maps at
the machine's settings file, an entity's entry, a project's record and a seat's own team-file
entry carry `idle_lead_seconds`, `idle_owner_seconds` and `blind_after_seconds`. The team file's
`watch` section carries `idle_first`, `idle_owner` and `blind_after`; its `liveness` words are
read the same way. Only a `watch` value that differs from the shipped default is handed on as the
team's declaration; the idle reports read the effective per-seat `idle_lead_seconds` and
`idle_owner_seconds` (`src/settings/declared.ts`, `src/watch/checks/idle.ts`). A liveness word MUST
be whole seconds of at least one; a fraction or a zero
is set aside as invalid, never called a loosening, and the value in force stands:

    state_blind_after_seconds: the team declared 1.5s, which is not a whole number of seconds; it is set aside

The one rule, in the code's words:

    a liveness threshold may be tightened, never loosened, unless the level above allows it

The blind window is the one the project may open again once something closed it; every level
inside may close it again. A word that would loosen one is set aside, the value in force stands, and the watch says the rule
once per setting as a line of its own — never a report, never a typed line:

    liveness_idle_lead_seconds: the team declared 10m, longer than the 5m in force — a liveness threshold may be tightened, never loosened, unless the level above allows it

`tempo` scales `idle_repeat`, `team_idle`, `nudge_wait`, `unsent_after` and `unread_after`, and
the idle window after the tighten-only check; it never scales `idle_owner` or `blind_after`.

### 3.3 The sixteen checks

`src/watch/check.ts` holds the order and the names; `ALWAYS_ON` names the four a file cannot
switch off.

| # | Check | Runs on | Always on | Reads |
|---|---|---|---|---|
| 1 | `missing` | seat | yes | the file has a seat herdr does not list |
| 2 | `restored` | seat | no | the recorded process changed but the stored agent session came back |
| 3 | `model-drift` | seat | yes | the running model or version differs from the file's |
| 4 | `attention` | seat | yes | a permission prompt, question, vendor notice, or a blocked or unknown status |
| 5 | `provider-error` | seat | no | a provider error or rate limit while the seat runs and is not working |
| 6 | `unsent` | seat | no | text in the input box that was never sent |
| 7 | `idle` | seat | no | quiet past the lead's window, then the owner's |
| 8 | `extra` | team | no | an agent in the session no seat claims |
| 9 | `team-idle` | team | no | every non-lead, non-parked seat quiet past `team_idle` |
| 10 | `approval` | team | yes | the file differs from its last verified approval |
| 11 | `load` | team | no | load per core past `machine.load_max` |
| 12 | `memory` | team | no | free memory under `machine.memory_min` |
| 13 | `disk` | team | no | free disk under `machine.disk_min` |
| 14 | `swap-free` | team | no | free swap under `machine.swap_free_min` |
| 15 | `swap-growth` | team | no | swap growth past `machine.swap_growth_max` inside its window |
| 16 | `budget` | team | no | an account past a mark, inside its reserve, at its floor, or unknown while a seat runs on it |

A file switches a check off under `watch.checks`; the four always-on checks ignore that switch.

The shipped watch defaults, as `defaultWatch()` carries them: a pass every 120 s, `team_idle`
600 s, `unsent_after` 60 s, `nudge_wait` 600 s and `unread_after` 600 s
(`src/file/sections/watch.ts`). The machine's
readings, checks 11 to 15, are logged every ten minutes: `READINGS_EVERY` is 600 s
(`src/commands/watch.ts`).

The same figures are the machine's limit contract, and this section is its home:
`machine.load_max`, `machine.memory_min`, `machine.disk_min`, `machine.swap_free_min` and
`machine.swap_growth_max` are read by the launch gate of `up` and `add`, which refuses a launch
past a limit and writes the figures it decided on into the log, and by checks 11 to 15 against the
readings they log. A change to a figure changes both.

### 3.4 The report rule

A report says what is; the model and launcher reports also name the restart, and a report never
starts a seat. A report is said when it starts and again only after it has cleared, with one
exception: the idle report to the operator repeats after `watch.idle_repeat` while the same idle
period continues, and the owner's escalation is said once per idle period. The core owns that
rule and the check's memory slot: `once`, `keep`, or `memory(kind,start)`, which remembers a kind
against the instant its period began. The watch's own notices — the file cannot be read,
herdr does not answer, a typed line was not sent, the watch stopped — follow the same rule.

### 3.5 The report catalogue

The texts, as `docs/commands/watch.md` prints them at the tag. `<repair>` and `<n>` are filled by
the pass.

| Report | Made when |
|---|---|
| `<seat> is in the file and is not running` | herdr lists no agent for a seat the file has, does not stop, and the watch has not seen running |
| `<seat> was running and is gone (its pane closed, or its CLI ended)` | herdr lists no agent for a seat the watch had seen running; said at each disappearance |
| `<seat> is no longer the process team launched (its session was restored, or its CLI was restarted)` | the pane runs no CLI, or a program the tool did not launch runs in it and the agent session is not the one stored at launch |
| `<seat>: its launch line starts a launcher, and the process in its pane is not the one team launched — <repair>` | a launcher-started seat's pane holds a process the tool did not launch; a lead's own seat is never restarted alone, so its report is `<seat>: started by a launcher; team cannot tell its process from the one it launched`, with no repair |
| `<seat> waits at a permission prompt: its owner's to answer` | a permission dialog or a trust question |
| `<seat> asked a question: the operator's to act on` | a question the seat is waiting on |
| `<seat> shows a vendor notice: its owner's to act on` | a captured vendor notice, such as an update screen |
| `<seat> shows a provider error: connection lost, and no capture names a retry` | a provider's connection error; told to the operator and the owner, once, while the seat is not working |
| `<seat> is out of quota on <account>: usage limit, resets at <time>` | a usage-limit screen that names its reset, as the screen words it — a clock after `at`, a span after `in` |
| `<seat> is out of quota on <account>: usage limit, and the screen names no reset time` | the same, without a reset |
| `<seat> is blocked, and its screen is not one the watch recognises` | herdr says blocked and the screen says nothing the watch knows |
| `<seat>: herdr reports the status "<status>"` | a status that is none of idle, done, working, blocked, and the screen cannot be read |
| `<seat> holds text in its input box that was never sent` | unsent text past `watch.unsent_after` |
| `<seat> has been idle since the watch started` | quiet past the seat's `idle_lead_seconds`, never seen working |
| `<seat> has been idle for <n> minutes` | quiet past the seat's `idle_lead_seconds` since its last turn |
| `<seat> has been idle for <n> minutes — reported to the owner` (or `… since the watch started — reported to the owner`) | the same period past the seat's `idle_owner_seconds`, said once and to the owner |
| `every agent is idle` | every non-lead, non-parked seat quiet past `watch.team_idle` |
| `message <id> for <seat> has been waiting <n> minutes` | a message older than `nudge_wait` whose seat's box was not free; the owner's, said once, and nothing is typed |
| `<seat> runs <model> <version>; the file says <declared>: it signs with the wrong model — <repair>` | the running model or version is not the file's; the repair is the seat's remove-and-add, or a whole-team down and up for a lead |
| `<name> (<pane>) is running and is not in the file` | an agent in the session no seat claims; a workspace labelled `Watch · <project>` is set aside |
| `approved before records were signed` | the record was written by an earlier tool: not trusted, said once |
| `<why the record was refused>` | a signed record that does not verify; said once |
| `the load is <n> per core, above <n>` | over `machine.load_max` |
| `free memory is <n>%, below <n>%` | under `machine.memory_min` |
| `free disk is <n> GB, below <n> GB` | under `machine.disk_min` |
| `free swap is <n> GB, below <n> GB` | under `machine.swap_free_min` |
| `swap grew by <n> GB in <n> minutes, above <n> GB` | over `machine.swap_growth_max` inside its window |
| `<account> <window> is <n>% used, past the <n>% mark` | an account at or past a mark, once per window |
| `<account> <window> left <n>%, inside its <n>% reserve` | a subscription account inside its reserve |
| `<account> <n> <currency> left, at its <n> <currency> floor` | a spend account at or below its floor |
| `<account> is unknown while <seat> runs on it` | nothing counts for an account whose seats are running |

### 3.6 The typed lines

The watch types fixed lines and never a report.

Post-tag (§3.10), the nudge arm below is no longer typed: the idle-work dispatcher carries its
body over the direct route, and the typed lines that remain are the ring, the pause notice, the
held-send retry and the unread wake.

- **The nudge**: the work drop's line, typed into an idle worker. Its body is the file's
  `watch.nudge`, or the fixed line `Team watch: reports are waiting in .agents/team.log` when
  the file omits it.
- **The ring**: `Team: run team drops --read --seat <seat> --session <session>`, named for the
  waiting seat and its own session, typed when a message already waits for that seat in the
  seat's own drop folder — the folder that read serves — and the seat's box is an empty idle
  prompt. A record waiting in the older mailbox store `.agents/messages/<seat>/` is not rung: the
  read the line names would serve nothing, and the line would fire every pass. A signed read
  receipt that lands after the pass read the mailbox keeps the line untyped: the mailbox is read
  again before the ring is delivered.
- **The held-send retry**: `Run team drops --read --seat <seat> --session <session> and do
  that.`, the seat's own drop read for the drop of a send held while a pane was busy, typed on a
  local pass unless `--no-nudge` is set. It is the same line a typed send types, so a seat that
  runs it writes the signed read receipt beside the drop; a receipt inside the retry's window is
  `delivered (read)`, and a line taken with no receipt is `sent (unconfirmed)`. It requires the
  seat's status to be `idle` or `done` and a readable screen that is either an idle prompt or
  holds exactly that trigger unsent, and it takes the seat lock before delivering. The pending
  marker beside the drop is its ownership evidence: a trigger another sender process left may be
  submitted, and another person's draft is never typed. A receipt that has already landed when
  the retry would type settles the marker as `delivered (read)` and types nothing. The retry is
  bounded, and giving up says the drop's path. The default nudge body `NUDGE_TEXT` is never
  typed.
- **The unread wake**: the same line, `Run team drops --read --seat <seat> --session
  <session> and do that.`, typed once for a seat whose message has had no signed receipt for
  `watch.unread_after` seconds (600 when the file omits it) and whose box is free. It is the
  same delivery the retry makes, with the same status, screen, seat-lock and human-pane rules,
  and it skips a message a held send's retry owns (a `.pending` marker). A receipt that lands
  after the listing is read again under the seat's lock, and an already-read message is not
  woken. One line serves every message due for that seat at that instant; the history records
  `sent (unconfirmed)` until a signed receipt verifies, then `delivered (read)`. The wake
  writes its `<id>.wake` reservation before the line is typed and holds it through the
  attempt: a crash after the reservation never types a second line, a definite not-delivered
  outcome (`held`, `not-submitted`) gives the reservation back so a later pass may wake, and an
  uncertain one (`unreachable`) keeps it, spent. At twice the window a message still unread is
  reported once to its sender as a signed Runtime mailbox record and to the team's lead as one
  signed drop for the pass, listing every message due in it — never by typing into a pane —
  after a `<id>.reported` reservation for each message; the sender's record is published
  write-once, so a mailbox already holding it keeps those bytes. The lead drop's UUID is fixed
  by the sorted set of messages it lists, so a repeat pass — even one whose markers were lost —
  finds the standing record instead of writing a second; a lead write that fails releases every
  reservation the pass took, and the sender records being write-once, the retry duplicates none
  of them. The sender's mailbox is resolved from the signed
  `from_id` through this home's registries, never from the `from` name: one agent record naming
  that seat, and for another team its team record listing that agent at that seat and recording
  the session the record is bound to. A sender those records cannot pin to one team, seat and
  session is reported to the lead only, and the missing metadata is named in the record and the
  line. The report's words say whether a wake line was sent, was reserved with an unconfirmed
  outcome, or was never typed, and `--no-nudge` skips the wake but still writes the report.

A nudge goes only to a seat whose box is an empty idle prompt; never to the operator, the
orchestrator, the pane the watch runs in, a dialog, or a box holding unsent text. A box that
holds the watch's own typed line is sent, not typed into twice, and only by the process that
typed it; the held-send retry and the unread wake are the exceptions, proved by their markers
above. `--no-nudge` types nothing, the retry and the unread wake included, and writes no drop;
`--no-notify` drops the operator's desktop
notification alone. Neither flag removes a log line or a report from `team status`.

### 3.7 The watch's record

The watch is recorded in the session state beside the seats:

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `pid` | number | no | absent until a pass records one | 0.5.0 | The watch's process |
| `heartbeat` | ISO 8601 | yes | — | 0.5.0 | The last pass |
| `pane` | string | no | absent on a record an older detached watch left | 0.5.0 | The pane it runs in |
| `workspace` | string | no | absent | 0.5.0 | The workspace of its own |

The watch's workspace is labelled `Watch · <project>`. A heartbeat older than two in-force
intervals is flagged by `team check`.

### 3.8 An example reading

A hook-written `working` inside its window, with no trace in the window:

```text
SEAT          STATE    SOURCE    LAST ACTIVE
worker-alpha  working  cli-hook  2026-10-18T09:14:02.000Z
```

### 3.9 The seat's two sidebar lines

Each seat's pane carries two lines on its sidebar:

| Line | Written from |
|---|---|
| 1, the label | the file's label for the seat, which is its workspace title |
| 2, the display line | the file's `display`, followed by the effort word in force |

While a seat runs, the watch repaints line 2 for each pass. The line is the file's `display`
when the screen shows the file's own model and version, or when the screen cannot be read;
otherwise it is `<model> <version>` from the screen, the observation replacing the display. The
effort word follows the display, separated by one space: the word the screen shows, else the last
word a screen showed, else the file's. A screen this version cannot read keeps the file's display
and **never** the CLI's name in place of a model. The effort word, once seen, stays until a
later screen shows a different one.

The observed line is never written into the team file. `team check` and the watch's `model-drift`
report name the difference, and `team register` re-applies both lines from the file without a
relaunch. The observed model is not stored on the agent record: the commit-signature policy's
model match needs it, and the place it is kept is an open point of the Runtime text (§10,
question 11).

### 3.10 The idle-work dispatcher (post-tag, unreleased)

This section records a change made after the tag and not released. It does not describe
`52db9b75`: §3.6 is the tag's typing contract, and this section supersedes its first arm (the
nudge) when it lands.

The watch reads one shared snapshot per pass (`src/watch/idle-work.ts`, `idleWorkReport`), the
same reading `status` and `check` use, and takes no picker of its own:

- The idle window is the `idle-threshold` policy (a duration with its unit, or whole seconds;
  300 s when nothing declares one), resolved to the team level. A chain that cannot be read
  carries `threshold_unknown`, and the dispatcher acts on nothing.
- A seat is idle only when it is declared and not human, parked, stopped, waiting on a swap, the
  lead or the operator; exactly one agent carries its name; herdr says `idle` or `done`; its
  screen reads the empty prompt; and its persisted `last_active` parses and is older than the
  window. A seat with no parseable stamp is not idle: absence of truthful idle evidence is
  suppression, never a guessed clock.
- `takeable` is the records at least one idle seat could claim under the picker's rules, minus
  ids a live lease holds. A paused team's count is zero. A team whose file names a tracker, or
  whose file source is missing, outside the root or not a list, reads `null` (unknown), and the
  dispatcher acts on nothing rather than calling it empty.

For each idle seat the dispatcher makes one attempt per idle episode, a refusal included and
spent before the route is called. The route is the sources' own direct push (`pushWork`), which
carries the seat, its pane, its CLI and the rendered body — `watch.nudge` with `<your seat name>`
replaced by the seat's name, or the fixed line `Team watch: reports are waiting in
.agents/team.log` when the file sets none. The send the watch runs in its own process stages
its signed record in the seat's `send-drops` folder and walks the routes that reach a live
receiver without a keystroke (`socket`, `headless-resume`), plus the typed leg behind a `socket`
leg it actually dialed when the receiver refused the frame: the seat's own drop-read trigger,
under the same admission, seat lock and draft move a typed send uses, with the watch principal's
authority rechecked immediately before that keystroke exactly as before the socket dial. A socket
the walk did not dial — another CLI, no declaration, a held mark, an order without the leg, a
declared order without `typed` — types nothing. A route that is absent, refuses or throws leaves
one signed Runtime mailbox record for the team lead and one for the main orchestrator,
deduplicated when they are the same target; its body says nothing was typed, or that the route's
typed fallback did not take the work when the refusal came from that fallback. A target the
registry cannot map is named as missing, never replaced by an owner or a guessed
seat. A wake the route accepted is checked at the first pass at least a minute later: a live
lease the seat holds, or an activity clock at or past the wake, settles it silently; otherwise
one still-idle record is written and the episode wakes the seat no more.

An actionable reading with zero takeable records writes one aggregate record per continuous idle
stretch — `<project>: <n> idle, nothing queued (<names>)` — and none under a pause, whose own
notices are the word. The stretch's signature is the idle seats and their clocks, so a changed
cast is a new stretch.

The dispatcher never types, and the body of automatic work is never typed: the pass's own
work-entry typing and the status engine's automatic-work nudges are drained without typing. The
one automatic keystroke is the route's own typed fallback described above, and a route that never
dialed the socket is not typed at by a second path. The typed lines that remain are the ring, the
pause notice, the held-send retry and the unread wake (§3.6); the ring is suppressed for a seat
whose idle episode the dispatcher owns that pass. The dispatcher publishes no bus event kind and
invents none.

Hosting: the daemon-hosted watch lifecycle — the same pass driven by the daemon's fixed
heartbeat tick, with an existing pane watch asked to hand over through its own loop and stood by
honestly when it does not answer — is forthcoming. It is not released, and its live activation
is not proven. The transfer is cooperative: the daemon writes a request beside the session
state on its fixed beat, the pane watch reads it at the top of a pass and leaves by deleting
only its own record, and the daemon acquires on a later beat. Nothing is signalled, a holder
whose pid cannot be proven to be the process in its own recorded pane is never asked, and a
pane watch that makes two of its own passes without answering stands the daemon by. When
hosting is on, a daemon restart rebuilds each accepted route's watch from the recorded binding,
with no new command.

## 4. Commands and options

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]
    team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]
    team status [--session <name>] [--file <path>] [--project <name>] [--all] [--json]

`team watch` exit ids: `watch.started` (0), `watch.stopped` (0), `watch.already`,
`watch.caller`, `watch.file-owner`, `watch.no-notify`, `watch.no-nudge`, `watch.watchdog`,
`watch.workspace` (1), `watch.file`, `watch.file-invalid`, `watch.invocation`,
`watch.not-a-repo` (2). `--json` is an invocation refusal on the daemon loop: one `team.error`
document on stdout with stderr empty, exit 2.

`team seats` prints STATE and SOURCE per seat; `--watch` refreshes every two seconds. `team
status` prints `unknown (blind)` for an unknown seat past the blind threshold.

## 5. Rules

1. **One state per seat, read from ranked sources, with the source said beside it.** The reading
   MUST answer the first certain source in the order of §3.1, and MUST print the source word
   beside the state word. A trace inside the window MUST outrank an idle word from the hook, the
   screen or herdr; a `working` hook older than the working window MUST yield to a recognised
   working or idle screen, and MUST answer only where the screen is absent or unknown. *Source:*
   `src/labels/state.ts`, `src/commands/seats.ts`. *Proof:* `test/seat-state.test.ts`,
   `test/cli-hook.test.ts` (the working-window cases).
2. **A trace inside the window outranks an idle word.** A seat that just committed, acked or was
   messaged MUST read `working` while its prompt shows. *Source:* `src/labels/state.ts`.
   *Proof:* `test/labels-traces.test.ts`.
3. **A dialog, a question, an error or unsent text reads `blocked`, whatever any clock says.**
   The CLI's usage wall reads `blocked` the same way, with reason `quota`: it is never a bare
   done, and `status` prints the reset exactly as the screen words it (`blocked: quota, resets
   at 11:00`, `resets in 47h31m`, or an explicit no-reset line), without an account guess. The
   JSON row keeps `seat_state: "blocked"` and carries the same text in `state`. *Source:*
   `src/labels/state.ts`, `src/status/compare.ts`, `src/watch/pass.ts` (`attentionOf`). *Proof:*
   `test/seat-state.test.ts`, `test/status.test.ts`, `test/quota-out-state.test.ts`.
4. **An unknown seat past the blind threshold MUST count as not working and be flagged
   `blind`.** *Source:* `src/labels/state.ts`, `src/settings/inherit.ts`. *Proof:*
   `test/seat-state.test.ts`.
5. **A threshold MAY be tightened and MUST NOT be loosened, unless the level above allows it.**
   A loosening word MUST be set aside and the value in force kept. *Source:*
   `src/settings/inherit.ts` (`LIVENESS_RULE`, `looseningLevels`). *Proof:*
   `test/liveness-defaults.test.ts`.
6. **A liveness word MUST be whole seconds, at least one.** A fraction or zero MUST be set aside
   as invalid, not as a loosening. *Source:* `src/settings/inherit.ts` (`LIVENESS_RULE`),
   `src/settings/declared.ts` (`livenessMap`), `src/registry/projects.ts` (`checkedLiveness`).
   *Proof:* `test/liveness-defaults.test.ts`, `test/registry/projects.test.ts`.
7. **Sixteen checks run, four always.** A file MAY switch off the other twelve under
   `watch.checks`; it MUST NOT switch off `attention`, `missing`, `model-drift` or `approval`.
   *Source:* `src/watch/check.ts` (`CHECK_NAMES`, `ALWAYS_ON`). *Proof:*
   `test/watch-checks.test.ts`.
8. **A report is said when it starts and again only after it has cleared, except the idle
   reminder.** The core's rule MUST hold for every report; the operator's idle report MUST repeat
   after `watch.idle_repeat` while the same idle period continues; the owner's escalation MUST be
   said once per idle period. *Source:* `src/watch/pass.ts`, `src/watch/check.ts`
   (`CheckContext`), `src/watch/checks/idle.ts`. *Proof:* `test/watch.test.ts` (a condition said
   once, and again only after two passes that cleared), `test/watch-idle-once.test.ts` (the
   repeat and the owner once).
9. **The watch MUST type only its fixed lines and the seat's own drop read (a held send's retry
   or the unread wake), and MUST NOT type into a dialog or a box that holds unsent text.** The
   nudge, the ring, the held-send retry and the unread wake are the only delivery paths; the
   retry MUST use the persisted marker as its ownership evidence, and the wake MUST leave a
   message a retry marker owns alone; both MUST require an idle or done status and a readable
   idle or exact-trigger screen, and MUST hold the seat lock; a reminder MUST NOT be typed for
   a message whose signed read receipt already verifies — the ring reads the mailbox again
   before typing, and the wake reads the folder again under the lock; `--no-nudge` MUST
   suppress the wake too. The wake and the unread report MUST reserve their marker before
   their effect and MUST keep a reservation whose attempt is uncertain, so no crash repeats a
   typed line or a published record; a lead report the mailbox definitely refuses MUST give
   back every reservation that pass took, and the lead's drop MUST list every message due in
   that pass under one signed record whose id is fixed by that set. *Source:* `src/watch/pass.ts` (`NUDGE_TEXT`, `ringText`), `src/watch/retry.ts`,
   `src/watch/unread.ts`, `src/send/native.ts` (`triggerLine`), the watch command. *Proof:*
   `test/watch-nudge-boundaries.test.ts`, `test/watch.test.ts`, `test/held-retry.test.ts`,
   `test/unread-wake.test.ts`.
10. **A second watch MUST refuse while the first is alive.** The recorded pane, a heartbeat no
    older than two in-force intervals, or a live pid is what counts. *Source:*
    `src/commands/watch.ts`. *Proof:* `test/watch-nudge-boundaries.test.ts` (the second-watch
    tests), `test/commands/watch-pane.test.ts`.
11. **`--no-nudge` and `--no-notify` are the owner's alone.** *Source:* `src/commands/watch.ts`.
    *Proof:* `test/watch.test.ts` (a seat cannot pass `--no-notify` or `--no-nudge`).
12. **A watch on another session reads and reports and MUST save no reading, budget or spend.**
    *Source:* `src/commands/watch.ts`, `src/state.ts`. *Proof:* `test/commands/watch-close.test.ts`.
13. **A report addressed to the owner MUST be a desktop notification; `--no-notify` MUST NOT drop
    it.** *Source:* `src/commands/watch.ts`. *Proof:* `test/watch.test.ts` (`--no-notify` still
    delivers a floor report, and the log keeps it).
14. **The display line MUST follow the observed screen, and the observation MUST NOT be written
    into the team file.** A screen that cannot be read keeps the file's display; an effort word
    once seen stays until a later screen shows a different one. *Source:* `src/labels/observe.ts`,
    `src/watch/seat-label.ts`, `src/status/statusline.ts`. *Proof:* `test/labels-observe.test.ts`.
15. **(post-tag, unreleased) Automatic work MUST go through the direct route, never a keystroke.**
    The watch MUST read the shared idle snapshot once per pass and act only on a truthful
    reading: no parseable `last_active`, an unknown window or an unreadable source yields no
    attempt, and a paused team yields none. It MUST make one attempt per idle episode, a refusal
    spent before the route is called, and MUST reach the seat only through the sources' direct
    push; a route that is absent or refuses MUST leave a signed mailbox record for the team lead
    and the main orchestrator, and type nothing. The ring MUST NOT be typed for a seat whose
    episode the dispatcher owns that pass. *Source:* `src/watch/dispatch.ts`,
    `src/watch/idle-work.ts`, `src/commands/watch.ts`. *Proof:* `test/watch-dispatch.test.ts`,
    `test/send-no-dial.test.ts`, `test/watch-work-nudge.test.ts`, `test/pause-flow.test.ts`.

## 6. Registries

**`seat-states-and-prompt-kinds`**:

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `working` | in a turn | 0.5.0 | `src/labels/state.ts` | state word |
| `idle` | at a prompt, nothing behind it | 0.5.0 | `src/labels/state.ts` | state word |
| `done` | the launched process is no longer in its pane | 0.5.0 | `src/labels/state.ts` | state word |
| `blocked` | the screen is a dialog, question, error, unsent text or usage wall | 0.5.0 | `src/labels/state.ts` | state word; a usage wall reads blocked with reason quota and its reset in `status` |
| `held` | a hold stands over the team | 0.5.0 | `src/labels/state.ts` | state word |
| `unreachable` | herdr cannot reach the seat | 0.5.0 | `src/labels/state.ts` | state word |
| `unknown` | no source was certain | 0.5.0 | `src/labels/state.ts` | state word; blind past the threshold |
| `cli` | the pane's screen, read against the profile | 0.5.0 | `src/labels/state.ts` | source |
| `cli-hook` | the CLI's own turn hooks | 0.5.0 | `src/labels/state.ts` | source; stands for a day |
| `herdr` | herdr's status word | 0.5.0 | `src/labels/state.ts` | source |
| `trace` | a commit, ack or message inside the window | 0.5.0 | `src/labels/state.ts` | source |
| `process` | the recorded process identity | 0.5.0 | `src/labels/state.ts` | source |
| `hold` | the team's hold | 0.5.0 | `src/labels/state.ts` | source |
| `none` | nothing was certain | 0.5.0 | `src/labels/state.ts` | source |
| `missing` … `budget` | the sixteen check names | 0.5.0 | `src/watch/check.ts` | one entry per name in §3.3 |

**`policy-names`** (also fed by the policies spec):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `liveness-idle-lead-seconds` | idle to the lead | 0.5.0 | `src/policy/types.ts` | enforced |
| `liveness-idle-owner-seconds` | idle to the owner | 0.5.0 | `src/policy/types.ts` | enforced |
| `state-blind-after-seconds` | unknown to blind | 0.5.0 | `src/policy/types.ts` | enforced |
| `state-trace-window-seconds` | the trace window | 0.5.0 | `src/policy/types.ts` | enforced |
| `state-hook-working-seconds` | the hook's working word | 0.5.0 | `src/policy/types.ts` | enforced |

**`exit-codes`**: the `watch.*` rows in §4.

## 7. Open points

- **The trace order.** The code ranks a fresh trace above an idle word; one module's text ranks
  the traces last with no exception. The order in §3.1 is the code's; which text governs is open.
- **Which level may loosen.** The code lets the project lengthen the blind, trace and hook
  windows; the amendment's inheritance says only that a lower level tightens. The spec records
  the code.
- **The entity level is keyed by name, not by a record.** A team's entity is the name its team
  record carries; the entity's `liveness` word is read from its entry in `.config/team/entities.yaml`,
  and a team that names none starts at the machine's level.
- **The receipts of the message phase are not a trace.** No reader consumes a receipt as a trace
  at the tag, so a receipt never makes a seat `working`.
- **The round's liveness thresholds are not read.** The watch's windows are its own; the round's
  table is another text's.
- **`idle_repeat` repeats the operator's line only.** The owner is told once per idle period.

## Revision log

- **Draft** (the Runtime text's writer, 2026-10-18): lifted from the Runtime's chapters C and F;
  read at the tag.
- **Draft, amended** (the Runtime text's writer, 2026-10-18): a second read against the tag
  corrected four points — the working-hook window yields to a readable screen; provider errors
  and rate limits sit under the optional `provider-error` check; the idle report's repeat is the
  one exception to the once-until-cleared rule; and the held-send retry is a third typing path
  with its marker.
- **Post-tag change recorded** (the implementing builder, 2026-10-20): §3.10 and rule 15 record the idle-work
  dispatcher as implemented after `v0.5.0 (52db9b75)` and not released — one shared snapshot per
  pass, a truthful reading or none, one direct-route attempt per idle episode (a refusal
  included), signed mailbox records on absent or refused routes, the still-idle check, the
  empty-source notice, and the retirement of automatic work typing. The tag's §3.6 and rule 9
  stand as read-at-the-tag text; daemon hosting is forthcoming and its live activation is not
  proven.
