# `team check`: rationale and known limits

What moved off [the `team check` page](../commands/check.md): who the check answers, what
it reads, the behaviour behind the lines it prints, the old spellings it still reads, the
refusals in their own words, and the known limits. The synopsis, the flags, the caller table and
the exit codes stay on the page.

## What the run does: the differences, each with its repair

One answer to one question: **is anything wrong with this team that someone should act on?**
It reads the team file, the approval, the state, herdr and the registries, and changes nothing
except what the owner's `--repair` settles — the state's two leftovers, the dev-mode mark an
agent's registration left, and the two herdr sidebar lines — no git is needed, so it answers as
well in a plain folder as in a repository. It is not
[`team status`](status.md) with fewer lines: status answers *what the team is* — the rows, the
budgets, every difference and note — and the check answers *what to act on*: the differences
alone, each with its repair, and the one note a file can earn.

`team check` is also the old name of the two commands that took its halves —
[`team commits check`](commits.md) and [`team pr check`](pr.md). A line that spells one of
those — a `<ref>`, `--pr`, `--since`, any other word or option — is still read as that command
through 0.3.3; the last section keeps those spellings and their bytes.

## The state's leftovers, and the owner's `--repair`

The file is the truth about who the seats are. The state can keep a record the file no longer
speaks for — a seat an older file named and this one dropped — and a session the file does not
name with no seat of the team in it. Both are leftovers, and both are named:

    difference: <seat>: left the team file but its record still claims pane <pane>
      repair: drop its record from the state (team check --repair)
      who: the owner
    difference: the state records the session "<name>", and no seat of the team is in it
      repair: drop its record from the state (team check --repair)
      who: the owner

A record with no pane reads `<seat>: left the team file but its record is still in the state`. The
repair is never an edit of the file and never a guess at which record is right: the commands that
resolve who holds a pane read past a record the file does not declare (`seatOfFile`,
`src/state.ts`), so a departed seat's old record no longer refuses the real seat's registration,
and the record itself waits for the owner's `--repair`. That flag is the check's one act, and it
settles three findings from what the run already holds. The state's leftovers are dropped exactly
as named, in one locked state write, re-checking each record against the state now on disk; it
prints one `repaired:` line per record, logs each line under `check` and the owner, and leaves the
file, the approval store and every other record as they stood. A temporary
seat is never a leftover: `team add --temporary` never writes one into the file, so its record is
the only place it exists, and neither the check nor the repair touches it. A session with a seat
of the team in it — a name the file declares, or a temporary seat — is the team's too, whatever
the file's own `session` key says, and is left where it is. The file's own session and the session
this run addresses — `--session`, or `team.session` when it aims nothing — are never leftovers
themselves either: one is where the team runs, and the other is what the run is about, so
`--repair` never drops the record the check is reading. The records inside the addressed session
are compared with the file all the same. Herdr is not consulted about which records are leftovers:
the state's own claims are the subject, a pane herdr no longer lists is still a pane the state
claims, and a session it runs is still a leftover with no seat of the team in it. The repair still
waits for the live read: a check whose herdr cannot answer exits `check.herdr` before it drops
anything, so a refused run has changed nothing.

The repair is the owner's alone. A caller that passes the gate but is not the owner meets
`team check: --repair is the owner's` and exit 1, as it does for the two aimed flags; nothing is
written. A `--repair` run whose repairs leave nothing else to act on is a clean check — the `repaired:`
lines, then `no differences`, exit 0. A state write that fails throws, as every
command's state write does, and the run is `team.command-threw`'s.

## The other two repairs

The same `--repair` settles the two findings whose repair is a write the file already settles, and
nothing else. A file seat whose newest registry record carries the dev-mode mark — the record a
run with a folded caller gate wrote (`devModeDifferences`, `src/check/team.ts`) — is recorded
again with the caller gate in force: the same record `team register <seat>` writes as the owner,
through `updateAgent`'s `provenance.dev_mode: false` patch, which clears the mark and the caller
and time it named. The `repaired:` line reads `<seat>: re-recorded with the caller gate in force;
the dev-mode mark is cleared`. Under a governing `dev-mode` policy the finding is the quiet count
note rather than a row per seat, and the repair takes the mark off all the same — the note then
counts none. A team with no `home` has no registry to read or write, and the mark is invisible to
it, exactly as the finding is.

Each herdr sidebar line that drifted — line 1 off `workspaceLabel(seat)`, line 2 one neither the
file's display nor the watch's observation explains (`labelDrifts`) — is set back from the file
through the same two writes `team register <seat>` makes: `workspaceRename` for the workspace
label, `reportDisplayAgent` for the display line. Each successful write is one `repaired:` line —
`<seat>: its herdr workspace label is set back to "<label>"` or `<seat>: its herdr display is set
back to "<line>"` — and the live session is read again after the writes, so the comparison reports
the sidebar the repair left. A herdr that will not take a line says `<seat>: its title was not
reported` (or `its display was not reported`), as `team register` does, and that difference
stands. Only the line that drifted is written: a correct display line is not re-reported because
its workspace label moved.

Nothing else is repaired. A model drift keeps its relaunch, a blind seat its look at the pane, a
roster gap its `team register` — those are decisions the run names, and `--repair` never starts,
stops or relaunches a seat.

The general seat brief is checked against the state's `briefs` too (`generalBriefDifferences`,
`src/check/team.ts`). A session that launched a seat — its `seats` hold one — or recorded a
delivery — `briefs` is defined — is a session whose seats were due the brief; a session with
neither is due nothing. The claim is read first (`currentBriefClaim`, `src/launch/general-brief.ts`):
an entry that is absent, or one an older build wrote without the delivery lifetime, is
`<seat>: the general seat brief has not been delivered`, repaired with `team reload <seat> or team
up`, or with `team up` alone when the seat is a human's, since `team reload` refuses that pane. A
CLI seat this session never launched and never recorded is skipped: its launch is its repair, and
the comparison already names it when one was due. A claim whose `sha256` is behind this build's
`GENERAL_BRIEF_SHA256` raises the run's `stale` flag, and the caller prints the one `ROLLOUT_HINT`
line after the per-seat differences. With no `home` there is no message key to verify a signature,
so a behind claim is still not delivered and a current one stands as recorded.

A current claim is a claim about a file, so the check verifies the file rather than the claim: the
record the claim names, at `<root>/.agents/send-drops/<session>/<seat>/<claim.id>`, is rebuilt from
the claim through `generalBriefRecord` (its `id` and `thread` are the claim's id; `body` and
`to_id` are not compared) and held against `recordHolds` (`src/send/record.ts`). A missing file is
a delivery that never landed and keeps the `has not been delivered` line; a file there that does
not verify — unsigned, foreign, another text, another lifetime or epoch, a planted regular file or
a link — is `<seat>: the general seat brief's delivery record does not verify`, with the same
repair. A human seat is delivery-only and the check stops there.

A CLI seat then needs read evidence binding the claim: a signed `read` or `replied` receipt at
`receiptFile(dropDir, claim.id, status)` verifying through `receiptHolds` against
`briefBindingOf(claim)` — the claim's id, incarnation, text hash and epoch. A seat whose launch
did not reach ready keeps its launch difference and its read is not demanded:
`<seat>: the general seat brief has been delivered; launch not ready`, and a verified read that
arrived before readiness is `<seat>: a read happened before readiness; the runtime is not
confirmed`. With no message key the read is not demanded either. Otherwise no verified receipt
leaves one of three lines: a `read` or `replied` file that exists and does not verify is
`<seat>: the general seat brief's read receipt does not verify`, repaired by
`team brief rollout --apply` recovering the delivery at a new id, the file that does not verify
left in place; a signed receipt for another message (`olderReadReceipt`) is
`<seat>: the general seat brief's read receipt is stale (an earlier agent or an earlier text)`;
and nothing at all is `<seat>: the general seat brief has been delivered and not read`. Both of
the last are repaired by the seat's next turn; a record with `watcher` absent or `none` says how to
read by hand — `team drops --read --seat <seat>` — and that `team reload <seat>` installs the
launch's hooks. Every repair is a reload, an up, a read or the rollout's own recovery, never
`--repair`: the difference is advice, and the delivery is the launch's own act. The check writes
none of it and has no writer mode and no `--rollout` of its own.

Unread work is named on the same pass (`unreadDifferences`, `src/check/team.ts`): every non-human
seat's drop folder is read through `listUnread` (`src/mcp/inbox.ts`), the watch's own reading of
what waits — a UUID-named regular file with no verified read receipt beside it, the general seat
brief's current and superseded ids aside. A message older than `watch.unread_after` — the value in
force, 600 s when the file omits it — is one difference for the seat,
`<seat>: a message from <from> has been unread for <n> min (id <id>)`, with `; <m> more unread`
when others are due and the oldest named. The repair is the seat's next turn, or
`team drops --read --seat <seat>` when the seat's record says no turn-start reader is installed.
The sender is the verified record's `from`; a record that does not verify is named `an
unverified message`, and the `.pending` marker beside it is never read as a sender — it is
unsigned, so it may not lend a message the owner's name or a seat's standing. A person's drop is
read by a person and is never asked for a receipt, and with no message key no receipt can be
judged: neither is named.
The line is advice like the rest, and the watch's unread wake is the path that types the read.

## Seats held at a prompt

The same pass names a seat held at a prompt it can read (`attentionDifferences`,
`src/check/team.ts`). The pane is the one this project's state records for the seat, and only
where herdr lists that seat on it — the same gate the watch's report lines use — read through the
watch's own reader (`readScreen`, `src/watch/screen.ts`). The pane must still hold the process
team launched, read as `compare()` reads it (`paneShowsSeat`, `src/status/compare.ts`, over
`seatProcessVerdict` and `replacedSeat` in `src/launch/identity.ts`): a pane back at its shell,
one running a process the record does not name with no stored session showing continuity, or a
record with no identity whose pane holds a bare shell, is not read for a prompt at all.
`compare()`'s process row already says what that pane is, and a dialog left in the scrollback of a
dead or replaced pane is not a seat held at one. `compare()`'s temporary branch answers to the
same gate before it prints a plain prompt row, so the check has no stale row to replace either.
One line per held seat, by the screen's kind:

- a **permission** prompt: `<seat>: stuck at a permission prompt (last active 4m ago):
  Write(note.txt)`, its lead's to answer in the pane;
- a **trust** prompt: `stuck at a trust prompt`, the owner's to answer in the pane;
- a **quota** prompt, the watch's rate limit: `stuck at a quota prompt`, with `resets at 11:00`
  or `resets in 47h31m` when the screen names a reset (the screen's own phrase), `the screen names
  no reset time` when it names none, the owner's — `team` never types into that screen;
- a **confirm** prompt, the CLI's own exit question: `stuck at a confirm prompt`, the owner's to
  answer in the pane, or `team down --abandon` closes it;
- an **unrecognised** prompt: a screen no profile reads whose safety floor carries a prompt row.
  The line says `stuck at an unrecognised prompt` and quotes that row — `matched "Do you want to
  continue?"` — and the owner looks at the pane. It is the only line that quotes screen text. An
  unknown screen the floor did not catch keeps the watch's `blocked` line instead, as before.

The command after the kind is the last tool row the screen shows (`toolTrace`,
`src/labels/traces.ts`) — `Write(note.txt)` on a Claude Code pane, `Bash(...)` on Antigravity's —
and no command on a CLI whose captures hold no such row. No new grammar is read: the kinds are the
watch's own screen kinds, and the unrecognised row is its safety floor's (`floorLine`,
`src/watch/screen-core.ts`); the floor's line is asked for even when the composer read failed, but
only to quote it — the screen was unknown already, and nothing is typed from it either way. The
failed read asks the floor for the row nearest the foot of the live screen only: what lies below
the composer's last rule line. A row above that rule is transcript the pane has scrolled past —
whatever words it holds, it is never the dialog and is never quoted; a window with no rule line is
a dialog that fills the pane, and all of it is live. Every detail read from the screen — the
quoted row, the command, the reset time — is cleaned with the report's own `plainLine` when the
line is built, so the same string is safe in `--json`, which renders `what` as it stands.

The age is the seat record's `last_active` (`last active 4m ago`), the only instant a seat record
carries. A record without one gives the line no age clause. The line dates the record, not the
prompt: the prompt appeared after that moment, so it says when the seat was last active, never how
long the prompt itself has stood.

A seat whose state carries the launch's own `waiting` record is not named again: that record's
difference (`waitingView`) already names the seat and the dialog it stopped at, with the repair
that resumes the launch.

The reading is read-only: nothing answers the prompt or types into the pane, the state is not
written, and the `waiting` record is neither consulted nor moved. `compare()` emits the plain
permission and trust rows for `status` and marks them with the seat's name (`promptSeat`); the
check drops that row for every seat it names itself, so the seat appears once, in the check's
line. A temporary seat is read with its like-seat's CLI, as its row reads the like-seat's model,
and its plain prompt row is replaced the same way. A temporary seat is a seat of the team by its
record alone (`team add --temporary` never writes one into the file), so the real live read
collects its recorded pane on the same terms as a declared seat's: a held temporary seat is named
in a real run, not only where a scene hands the check its screen.

## Who the check answers

The caller decides, not the flags. Three callers get the answer:

- **the owner**, from a terminal outside herdr — the same walk `status` and the changing
  commands make, and the only caller who may aim `--file`, `--session` or `--repair`. An owner
  **without a terminal** is not this caller: a script meets the fixed
  sentence below;
- **a seat of the team being checked** — placed in the file's session, on the pane the state
  records for it. A seat the state records no pane for, or records on another pane, fails
  closed;
- **a pane outside the team that the approved file names** in its `delegates` entries — through
  the same gate the changing commands use, minus the command list and the audit line: the check
  is a read, not an act.

Anyone else gets one fixed sentence and nothing else, whatever failed underneath — no file, an
invalid one, a refused approval, a state that can't be read, herdr not answering, an aimed
flag, any caller detail:

    team check: this team is not yours to check

`--file` and `--session` are the owner's. Aimed by a caller that passes the gate but is not the
owner, each meets the refusal every command gives it (`--file is the owner's, from a terminal
outside herdr; this call is …`) and exits 1. For every other caller the two flags aim nothing
and open nothing: the target is the file the caller's own place finds.

## What it reads

- the team file, as [`team status`](status.md) loads it — a plain folder's own
  `.agents/team.yaml` through the fallback, no git step;
- the approval store: the record, its copy, and the file against it;
- `team.state.json`: the seats' stages, waits, rules and launch identities, the worktrees, the
  general-brief deliveries (`briefs`), and the session's watch;
- herdr, read-only, through the same reads status makes — narrowed to one pass over the panes
  **this project's state records for this team's seats**. A pane the state records for another
  session, another project or nobody at all is not read, and the pass uses the watch's own
  screen reader, so the words a seat's screen yields are the watch's own words. Nothing of the
  watch's pass, report or nudge path runs: no key is sent, no pane is typed into, no memory is
  written. The same pass reads the two sidebar lines each file seat's pane carries — its herdr
  workspace label and the display line under it — and a line that reads as neither the file's own
  text nor one the watch may paint is a difference whose repair is `team register <seat>`,
  re-applying both lines from the file without a relaunch;
- the project and team registries (`~/.config/team/projects.yaml`, `~/.config/team/teams.yaml`),
  for the team's place ([the registries](../concepts/registry.md)). A team two projects name is a
  difference that repeats the registry's own refusal, naming both, with fixing the registry file
  as its repair, and a registry that cannot be read is a difference in the same shape; a team no
  project names is its own project, never a difference. When this team's file declares
  `project_lead: true`, the project's other teams are read through the team registry — their
  `root`, then their file, text only — and a second declaring team is a difference:
  `the project <name> has <n> lead teams: <names>`, repaired with `take "project_lead: true" off
  all but one of them`. A sibling the registries cannot answer for — no record, no readable file,
  or one naming another project — is not counted, and a team that declares no lead reads no
  sibling at all. A check with no home reads no registry;
- the entity policy source (`~/.config/team/entities.yaml`), for the entity's model rule
  (Policies rule 10): every seat of this team whose declared vendor the rule refuses is one
  difference, `<seat>: declares vendor <vendor>, which the entity model rule <rule> refuses; a
  swap to <cli> <model> <version> from <team>/<donor> is proposed` — or, where no recipe is
  available, the reason in place of the proposal — repaired with `team swap queue <seat>`. It is
  the breach list [`team swap`](../commands/swap.md) `--rule` prints for the entity, narrowed to
  the team this check runs in: another team's breaching seat is not this team's difference. The
  repair's actor is the team's lead, set on the difference itself. A rule that cannot be read is a
  note — `the entity model rule cannot be read, so no breach is judged: <why>` — never an empty
  rule, which would read every seat as in rule; a check with no home reads no rule. The wait
  `team swap` applies is not read here: the difference is the breach, and the queue command reads
  the wait when a swap is queued;
- the seat's own reading, the pair [`team seats`](../commands/seats.md) prints as STATE and SOURCE
  (`src/labels/state.ts`): the word and where it came from, best source first — a screen waiting on
  someone (a dialog, a question, an error, a composer holding unsent text), the CLI's own state hook
  where its launch installed one, the pane's screen, herdr's word, the seat's newest trace, its
  process — save one exception: a trace inside the window (`state_trace_window_seconds`, 2m
  shipped) beats an idle word, from the hook, the screen or herdr, and only a trace with its own
  clock counts as fresh — a commit, an ack, a message that reached the seat (a send the seat did not
  take — `unreachable`, `not-submitted`, `held`, `timeout` — is no trace: it would read a seat as
  working because someone failed to reach it, and clear a blind seat's flag without a sign the seat
  moved). A tool row read off a screen carries no clock of its own and is never weighed as recency
  (it is kept for display), so a seat whose last commit, ack or message is that fresh reads
  `working` while its prompt shows; a working screen, a blocked screen — a composer holding unsent
  text included — and the certainties (`held`, `unreachable`, `done`) never yield to it. The hook
  (`cli-hook`) is a per-launch settings file, written under the team file's own folder — `.agents/`
  by default — that the CLI loads for two command hooks — a turn start and a turn end — and the
  state file it keeps there is read for a day: a fresh `working` reads working while its turn is
  young (`state_hook_working_seconds`, 2m shipped, the project free to loosen it), past which a screen
  that still reads answers instead — an interrupted turn leaves the file's `working` behind while
  the prompt shows again — and a screen it cannot read leaves the hook to answer; a fresh `idle`
  idle; an older reading, one dated ahead of this machine's clock, or one this version cannot
  parse is no reading, so the screen answers again. `team down`, `team remove` and `team register`
  take the seat's state file with the record
  they change, so a stopped seat starts from no reading. A blocked screen outranks
  the hook, which cannot see a dialog the CLI stopped at after its last turn ended. `done` from the file's
  `stopped` or from a retained record stands only while herdr names no agent for the seat: a live
  agent is the observation, and a file's `stopped` beside a running seat is a difference of its
  own, never the state. A process the comparison calls `restored, not launched by team` is
  untrusted: neither its screen nor herdr's word for it is read, and the reading is TeamCLI's own
  records or nothing — `unknown`, blind by its trace's age. A seat blind — `unknown` past the
  blind threshold, 5m shipped, tightened by every level and opened again only by a project —
  counts as not working:
  one difference, the owner's, `<seat>: unknown for over 5m — blind, and it counts as not working`,
  repaired with the owner's look at the pane;
- the agent registry (`<home>/.config/team/agents/`), one read of each seat's record for the
  signing triple the commit gate checks ([the registries](../concepts/registry.md)). A seat
  whose record signs as another model than its pane runs is a difference — `signs as X, runs Y`,
  X in the record's own words unless the file still declares exactly what the record signs (then
  the seat's `display` spelling stands) — with `team register <seat>` (once the drift is
  accepted) or the relaunch beside it. The record is the launch's own declaration: a read cannot
  change it and the check writes nothing here; the drift is re-recorded by `team register`, a
  reload or the next launch. A team the registry holds no record for reads as before, and a
  screen the reader cannot name a model from is never wrong;
- the team registry's record of this team (`~/.config/team/teams.yaml`), for its roster
  ([the registries](../concepts/registry.md)): a seat the state records ready, running on the pane
  it recorded, that the roster does not list is a difference — `<seat>: ready and running, and the
  team registry's roster does not list it`, repaired with `team register <seat>`. The roster line
  is the seat's identity for the permission bridge (`src/permissions/who.ts`): where the registry
  holds a record of the team, the roster it holds is the record of who its seats are, and a seat
  the roster does not list has no record there whatever the file declares. A team the registry
  holds no record of is not this difference — the bridge falls back to the file's own declaration
  then — and neither is a seat still launching: the line is written when the seat reaches ready.
  The roster is read the way the bridge reads it, so a registry that cannot be read reads as no
  record of the team here and the difference is not raised on it.

It writes nothing at all — not the state, not the store, not the `last_valid` copy `status`
keeps beside the file it read — for every caller, the owner included, save the one act: the
owner's `--repair`, which drops the leftovers named above, clears a dev-mode mark and sets a
drifted sidebar line back from the file.

## Output

The report opens with the context line (`team <project>, session "<session>"`), followed by any
deprecation warnings from the file (`warning: the file, line <n>: <message>; repair: <repair>`),
any `repaired:` lines, any `note:` lines (collapsed with `(x<n>)` when repeated), each finding's
three-line `difference:` / `  repair:` / `  who:` block, and the closing summary line. The check
prints no seat table and no budget block:

    team beacon, session "beacon"
    note: main/w9:p3's delegate entry names approve, which no command acts on since team approve was removed; drop it from the file
    difference: claude-beacon is in the file and is not running
      repair: team up
      who: the owner
    1 difference, 1 for the owner

The note is earned by a `delegates` entry still naming `approve`: `team approve` was removed,
and the word stays accepted only so a file that already names it loads unchanged. It is a note
and not a finding — in neither the closing count nor the exit code, so a file whose only note is
this one still answers `no differences`, and the repair it asks for is the file:
one word shorter.

The closing line counts the differences and, when any are the owner's, how many after a comma
(`1 difference` / `<n> differences, <k> for the owner`, or `<n> differences` when none are the owner's). With
nothing to act on it is `no differences`.

A `--repair` run prints one `repaired: <what was repaired>` line per repair before the notes and
differences — the dropped records (`repaired: <seat>: left the team file and its record claimed
pane <pane>; its record is dropped`, `repaired: the state's session "<name>" holds no seat of the
team; its record is dropped`), the cleared marks (`repaired: <seat>: re-recorded with the caller
gate in force; the dev-mode mark is cleared`) and the set-back sidebar lines — and each line is
written to the project's log under `check` and the owner's label. The repairs run before the
comparison, so a check whose only findings were among them answers `no differences`, exit 0.

Under `--json`, the check writes a single JSON document on `stdout` with `schema: { name: "team.check", version: 1 }`, `format: 1`, `project`, `session`, `warnings`, `repaired`, `notes`, `differences` (`{ what, repair, who }`), and `summary` (`{ differences, owner_differences }`). Any invocation or gate refusal under `--json` writes a `team.error` JSON envelope (`schema/error.schema.json`) on `stdout` with `stderr` empty.

In 0.5.0, the `what 0.5.0 must not pretend:` block moved to `team doctor` and `team --about`
(see [`docs/reference/output.md`](../reference/output.md) §2.3); `team check` no longer prints
`not known:` or `what 0.5.0 must not pretend:` at the end of every run. A finding never quotes a
seat's screen text beyond the profile's fixed words for the kind of screen it is.

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first console is also on [the `team check` page](../commands/check.md); the rest stand only in this
note and are not executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.

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

The team runs as the file and the state say, so there is nothing to act on (beyond the file's
legacy `coordinator:` deprecation warning and the note its lead's 0.3.5/0.4 role word earns):

```console
$ team check ; echo "exit $?"
team beacon, session "beacon"
warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
no differences
exit 0
```

A seat of the team runs it too, and reads the same answer:

```console caller=claude-beacon
$ team check ; echo "exit $?"
team beacon, session "beacon"
warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
no differences
exit 0
```

With the herdr session down, both seats are in the file and not running — the summary counts
them, and both repairs are the owner's:

```console herdr=absent
$ team check ; echo "exit $?"
team beacon, session "beacon"
warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
note: the lead seat "claude-keeper" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient
difference: claude-keeper is in the file and is not running
  repair: team up
  who: the owner
difference: claude-beacon is in the file and is not running
  repair: team up
  who: the owner
2 differences, 2 for the owner
exit 1
```

An agent outside the team — no terminal, no seat, no approved pane — learns nothing but the
one sentence:

```console caller=agent
$ team check ; echo "exit $?"
team check: this team is not yours to check
exit 2
```

When herdr doesn't answer at all, an authorized caller gets herdr's own line and nothing is
guessed:

```console herdr=none
$ team check ; echo "exit $?"
team check: herdr doesn't answer; is it installed and running?
exit 2
```

## The old spelling, still read through 0.3.3

A `<ref>`, `--pr`, `--since`, an unknown option or any other word makes the line the old
spelling: the commits half runs as [`team commits check`](commits.md) has always run, with
`--pr` the pull request body's half as well, and one line goes to standard error first for each
half that runs:

    team check: `team check` is now `team commits check`, and is still read through 0.3.3
    team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3

Every line under the notices names the new command, and the exit codes are the ones
[`commits check`](commits.md) and [`pr check`](pr.md) have. A refused invocation — a missing or
doubled `<ref>`, an unknown option, a missing value — keeps the bytes it always had and takes
no notice: an error already says what to fix.

```commit
Tidy the logs

The reader printed one line too many, so the reports carried noise.

Claude-Session: 8f21c4a9
Agent: Claude Opus 5.5 · implementer
```

```console
$ team check HEAD ; echo "exit $?"
team check: `team check` is now `team commits check`, and is still read through 0.3.3
COMMIT      STATUS   DETAIL
<sha>  refused  Tidy the logs
difference: commit <sha> "Tidy the logs", line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)
  who: any seat
team commits check: 1 commit checked: 1 commit refused
exit 1
```

With `--pr` both halves run, and both notices print — the commits one first:

```file file=pr.md
The metrics page is ready for review.

**Agent:** Claude Opus 5.5 · implementer
```

```console
$ team check HEAD --pr pr.md ; echo "exit $?"
team check: `team check` is now `team commits check`, and is still read through 0.3.3
team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3
COMMIT      STATUS   DETAIL
<sha>  refused  Tidy the logs
difference: commit <sha> "Tidy the logs", line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)
  who: any seat
team commits check: 1 commit checked, 1 pull request body checked: 1 commit refused
exit 1
```

An invocation that belongs to neither spelling refuses in the old bytes and takes no notice:

```console
$ team check --nope ; echo "exit $?"
team check: unknown option --nope

Usage: team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --pr <file>      also check a pull request's body ("-" reads standard input)
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    the team file, instead of .agents/team.yaml

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
exit 2
```
