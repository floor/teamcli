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
- `team.state.json`: the seats' stages, waits, rules and launch identities, the worktrees, and
  the session's watch;
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
      repair: the team's lead runs team up
      who: the team's lead
    1 difference

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
legacy `coordinator:` deprecation warning):

```console
$ team check ; echo "exit $?"
team beacon, session "beacon"
warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
no differences
exit 0
```

A seat of the team runs it too, and reads the same answer:

```console caller=claude-beacon
$ team check ; echo "exit $?"
team beacon, session "beacon"
warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
no differences
exit 0
```

With the herdr session down, both seats are in the file and not running — the summary counts
them, and the lead runs the one repair both name:

```console herdr=absent
$ team check ; echo "exit $?"
team beacon, session "beacon"
warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
difference: claude-keeper is in the file and is not running
  repair: the team's lead runs team up
  who: the team's lead
difference: claude-beacon is in the file and is not running
  repair: the team's lead runs team up
  who: the team's lead
2 differences
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
