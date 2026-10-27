# `team down`: rationale and known limits

What moved off [the `team down` page](../commands/down.md): what the run reads and writes,
who is asked to leave and who is left, the behaviour behind the lines it prints, the
refusals in their own words, the delegated run, and the known limits. The synopsis, the
flags, the caller table and the exit codes stay on the page.

## What the run does: who is asked, who is left running

Stops the team: asks every running seat the approved copy names to exit, closes its workspace, and
stops the herdr session. A pane herdr names with something that copy does not carry is closed when
the state records that pane and that workspace for one seat, and left running when no seat record
accounts for it. A pane with no name is closed on that same record. This run does not stop the
watch: its pid is only in the state. A seat is only asked when it is
free — idle, with an empty input box — so a working, blocked or half-typed seat is left running
and named. A pane whose CLI has exited — its own shell back in front of it, and no CLI process in
its foreground list — is not asked: it is closed, and its line says the CLI had exited. A seat
already showing its own framed exit question is blocked the same way: this run
sends no key to it. A box that holds exactly this CLI's exit text — an earlier run typed it and
never confirmed it — is not half-typed text: when the profile carries the one key that empties a
box, the text is cleared with it and the exit typed fresh, and when it does not, the seat is left
running with the text named. `--dry-run` prints the plan and runs nothing.

An edit of the live file that has not been approved does not change who is stopped: the copy in
force still names the seats it named when it was approved, with those seats' CLIs.

## What it reads and writes

Reads the team file, this machine's approval store (the copy in force is the stop list), the
session's state (`.agents/team.state.json`, for the seats it drops after they stop), and herdr:
whether the session is running, its agents, each pane's screen and status, and each pane's
foreground processes. Writes `.agents/team.state.json` (the seats it stopped are dropped),
`.agents/team.log`, and, through herdr: the exit in each pane, the workspaces it closes, the
session it stops and the stopped session it clears — its own, just stopped. A name the copy does
not carry, whose pane and workspace match no seat record, is left running, rules file included;
the owner removes it with `team remove <name> --abandon`. A pane those ids do match is closed and
the seat is dropped, whatever name herdr gave it. A team file that no longer validates is replaced
by the last copy that did, with a notice printed first, and an idle session still says there is
nothing to stop.

## Who may run it

The owner, the orchestrator's seat — and any seat the record marks a lead: the map's `leads` —
and the
approved delegate (below). The
seat is that name's, in a session
this project's state records — the file's session, or one the state records the caller's pane in —
on the pane the state records for that name in that session: a seat of another session, or a pane
merely renamed to the orchestrator's name, is refused — and so is a seat the state
records no pane for, or records on another pane than this call is on; those two refusals name the
seat and the repair. What that proves is placement, and no more: the state file is in the project,
and a process of the same user that writes its own pane there under the orchestrator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the
same user. `--file` and `--session` are the owner's alone, from a terminal outside herdr: a
non-owner aiming either is refused before the flagged file or session is read at all.
A seat's
own call is refused by the `--abandon` flag, which only the owner may use. A seat that may stop the
team never stops the orchestrator's or the operator's seat — only the owner does.

## The approved delegate

A pane the team file's `delegates` section lists for `down` — a pane outside the team's session —
may stop the team too. The section judges no other caller, and it never judges first: the ordinary
rule above is applied exactly as it is without a `delegates` section, and only where it has refused
does the delegate gate read the live team file directly — never the remembered copy and never the
last copy that validated, so a file that does not load carries no delegate and the rules above
stand. A caller that rule accepts keeps its own authority whatever the section says: the owner's
call never reaches the gate, and neither does the orchestrator's. A gate refusal
takes the place of the rule above, in the gate's own words, wherever that rule would have refused:
a real run exits 1, and a dry run prints `! down would refuse: <the gate's text>` and then the
plan. A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch). It returns before these real-run failures, and never takes their status:

- `down.no-launch`, this call has no way to reach herdr (`src/commands/down.ts:673`)
- `down.run-lock`, another run holds the session (`src/commands/down.ts:684`)
- `down.held`, a step of the stop was held (`src/commands/down.ts:776`)

A delegated run stops the whole team — the orchestrator's and the operator's seats included — and
never abandons. `--abandon`, `--session` and `--file` are the owner's: a delegate that passes one
is refused with the gate's text, and the flagged path or session is never read. The run judges the
file's own session, never one the caller's placement records, and it remembers nothing of the file
it read.

A run that passes its gate and proceeds to its effects appends one line to `.agents/team.log`
naming the delegate's pane. A dry run leaves no such line, and neither does a session that was
already idle: both return before any effect. An already-idle `down` says `session <session> is
not running: nothing to stop` and exits 0 before the caller-role and gate refusals a running
session would stop it on, for every caller — a placed delegate that passed `--file` or
`--session` included: the gate is asked, its refusal is held, and the idle return comes first,
so its words are not printed at all and idle `down` is unchanged by any of this. One refusal
does come first: a caller that is not the owner and passes `--file` or `--session` is refused
unplaced — `--file is the owner's, from a terminal outside herdr`, or the same for `--session`,
exit 1 — with the session never read. That refusal is the command's own, not the gate's: a file
with no delegate section has it with the gate never asked, and a file with one has it with the
gate asked and answered, the refusal standing unless the gate placed the caller.

## What it prints

    watch: its pid is only in the state; left running
    claude-keeper: stopped
    session beacon: stopped and cleared

A seat it stops prints `<seat>: stopped`. A seat whose CLI has already exited prints `<seat>: its
CLI had exited; its workspace was closed` — closed with nothing typed, and the session stop
follows as for any stopped seat; a dry run shows the close under the note `its CLI had exited;
closed without typing`. A pane with no name that one seat records is closed the same way, and the
line says it was created for that seat and never named. A pane herdr named with something other
than the seat's name is closed the same way when one seat records that pane and that workspace,
and the line names the title. Neither close happens for the orchestrator's or the operator's
seat when a seat calls: that seat is left running, whatever herdr calls its pane, and the skip
line is the one in the table below. A name no seat record accounts for is left running. A watch the
state records, and whose pid is alive, prints
`watch: its pid is only in the state; left running` — this run does not kill it. The session prints
`session <session>: stopped and cleared` — herdr keeps a stopped session listed until it is
deleted, so `down` clears the one it has itself just stopped, retrying while herdr still reports
it running, and the next `up` starts from the beginning. A clear that does not happen prints
`session <session>: stopped; it did not clear`, and `down` still exits 0: the stop itself
succeeded. A later `up` clears a stopped session this team's state records and goes on. A seat
this run asked whose exit could not be typed or confirmed, or whose exit was sent and which
did not leave within the wait, prints that, and that `team down --abandon` closes it; with
`--abandon` the same run closes its workspace and the line says so. A seat already sitting at
its own exit question is not that case: it is left, and the line says so and that `--abandon`
closes it; with the owner's `--abandon` it is closed as every seat that cannot be asked is
closed, and nothing is typed. A seat it does not stop prints one
`  skip` line and is named in the last line instead of the session being stopped. A seat whose box
already holds its exit text, on a CLI with a clearing key, is stopped as a free seat is — the
clearing key runs first — and a dry run says so in a note under its typing step:
`its box already holds this exit text; it is cleared first (<key>)`.

    claude-beacon: is working (`--wait` waits for it); left running
    session beacon: not stopped, 1 agent left in it

| Skip line | Meaning |
| --- | --- |
| `<seat>: is working (\`--wait\` waits for it); left running` | a turn is running |
| `<seat>: is blocked at a prompt, which \`team never answers\`; left running` | a permission dialog, a trust question or a question: only its owner answers it |
| `<seat>: sits at its own exit question; left running (team down --abandon closes it)` | the pane already shows this CLI's framed exit question, left by an earlier stop: this run sends no key |
| `<seat>: holds unsent text in its input box; left running` | half-typed text would be lost |
| `<seat>: holds this CLI's exit text (<exit>) unsent in its input box; left running (the owner sends it or clears it in its pane)` | the box holds an earlier run's unconfirmed exit text, and the CLI has no key that empties a box |
| `<seat>: shows a screen the profile does not recognise; left running` | nothing is typed into a screen it can't read; this line stands while the CLI is still the pane's foreground — a pane whose CLI has exited is closed instead (above) |
| `<seat>: the state doesn't say which CLI it runs, so it can't be asked to exit; left running (`team down --abandon` closes it without typing)` | the state predates the CLI record and the file no longer names the seat: nothing links its pane to a profile, so its owner closes it |
| `<seat>: left running; only the owner stops the orchestrator's or the operator's seat` | a seat's own call, and this is the orchestrator or the operator, whatever herdr calls its pane |
| `session default: herdr's default session is never stopped` | the default session is herdr's own |
| `<name>: its record is not an approved seat; left running (the owner cleans it: team remove <name> --abandon)` | herdr lists a name the approved copy does not carry, and that pane and workspace match no seat record |
| `<name>: herdr lists more than one agent of this name; left as it is` | more than one live agent of an approved name |
| `pane <pane>: not recorded for a seat of this team; left as it is` | an unnamed pane whose pane and workspace match no seat record |
| `<seat>: pane <pane> is not the process this team launched; left as it is` | the state records that pane and workspace, and a launched process that is no longer in the pane |
| `watch: its pid is only in the state; left running` | the state records a watch pid that is alive; this run does not kill it |

It prints `session <session> is not running: nothing to stop` and exits 0 when there is nothing to
stop at all.

Under `--json` the run writes one `team.down` v1 document on stdout, its `schema` tag first:
`format`, `dry_run`, `status` (`dry-run`, `idle` for a session with nothing to stop, `stopped`
otherwise), `action_summary`, `project`, `session`, `seats` and `notes`. A dry run's document has
`dry run: nothing was run` as its `action_summary` and the plan in `plan` — one
`{ step, seat?, detail, prefix? }` per plan line, a run step prefixed `+`, a skip `skip`, a wait
with none, and a warning leading as `{ step: "warning", prefix: "!" }` when there is one; a
session that is not running prints the idle line as its first note. A real run's `action_summary`
is its closing line — `session <session>: stopped and cleared`, or `stopped; it did not clear`
when the clear did not happen — or `session <session>: stopped` when nothing was said, and the
lines before it travel in `notes`. A refusal under `--json` writes
a `team.error` v1 document on stdout instead — the refusal's own `id`, its `message` and `repair`
— and stderr stays empty. The exit code is the same as without `--json`.

## Refusals

| Message | Exit |
| --- | --- |
| `team down: unknown option --x` / `team down: unexpected "x"` (each with the usage) | 2 |
| `team down: line <n>: <message>` | 2 |
| `team down: herdr doesn't answer; is it installed and running?` | 2 |
| `team down: the agents of session <session> can't be read` | 2 |
| ``team down: only the owner or `leads` stops the team; this call is <caller>`` | 1 |
| `team down: only the owner abandons a team, from a terminal outside herdr` | 1 |
| `team down: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team down: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team down: no pane is recorded for seat <name> in this session: a lead stops that seat and runs `team up` `` | 1 |
| ``team down: the state records pane <pane> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team down: <the delegate gate's text>` — the file has a `delegates` section and a delegate's call was refused: one of `down.delegate`, `down.delegate-approval`, `down.delegate-approved-copy`, `down.delegate-drift`, `down.delegate-evidence`, `down.delegate-placement`, `down.delegate-command`, `down.delegate-flag` | 1 |
| ``team down: another session-mutating run is holding session <session> (pid <pid>); try again when it is done`` — another run holds the session's mutator lock, the one lock `up`, `add`, `down` and `remove` share; the line names no command, because the lock is shared. The lock is taken before this run's first effect and released at its end; `--dry-run` and a session with nothing left to stop take no lock and never show it | 1 |
| ``team down: another session-mutating run may be holding session <session>, and its lock cannot be read; if no run is using it, delete <state dir>/seat-locks/<session>/.run`` — the lock file does not read as a token, so its holder is unknown and only the owner clears it; the line names the file | 1 |
| ``team down: the file was never approved on this machine `` | 1 |
| `team down: <the legacy record's one-line repair>` | 1 |
| `team down: <why the record was refused>` | 1 |
| `team down: the approved copy of the team file cannot be read` | 1 |

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first is also on [the `team down` page](../commands/down.md); the rest stand only in this note and
are not executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.

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
agents: all
watch: alive
state:
  seats:
    claude-beacon: {stage: ready, cli: claude-code}
```

Two seats idle, a watch running: this is the whole plan. The watch is named and left running.

```console
$ team down --dry-run ; echo "exit $?"
watch: its pid is only in the state; left running
+ herdr --session beacon pane run w1:p1 /exit
  wait until claude-keeper's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w1
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ herdr session stop beacon
    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)
dry run: nothing was run
exit 0
```

An implementer's seat is not the orchestrator's: it cannot stop the team.

```console caller=claude-beacon
$ team down ; echo "exit $?"
team down: only the owner or `leads` stops the team; this call is claude-beacon
exit 1
```

The orchestrator's own call stops the team but never its own seat, so the session stays up:

```console caller=claude-keeper
$ team down --dry-run ; echo "exit $?"
watch: its pid is only in the state; left running
  skip claude-keeper: left running; only the owner stops the orchestrator's or the operator's seat
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
  skip session beacon: not stopped, 1 agent left in it
dry run: nothing was run
exit 0
```

The live file renamed claude-beacon after the copy was stored. The stop list is the live file:

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
    name: claude-relay
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```console
$ team down --dry-run ; echo "exit $?"
watch: its pid is only in the state; left running
+ herdr --session beacon pane run w1:p1 /exit
  wait until claude-keeper's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w1
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ herdr session stop beacon
    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)
dry run: nothing was run
exit 0
```

For the owner, running that plan stops everything, and clears the session it stopped — the next
`team up` starts a fresh one, with no step in between:

```console
$ team down ; echo "exit $?"
watch: its pid is only in the state; left running
claude-keeper: stopped
claude-beacon: stopped
session beacon: stopped and cleared
exit 0
```

Once the session is down there is nothing to stop, and saying so is not an error:

```console
$ team down ; echo "exit $?"
session beacon is not running: nothing to stop
exit 0
```

Even with the team file broken, `down` still reads the last copy that validated and stops the team:

```yaml file=.agents/team.yaml
format: 1
project: beacon
seats: [
```

```console
$ team down ; echo "exit $?"
team config is invalid (line 3: "[" is not closed on its line); using the copy of 2026-10-04T09:00:00.000Z
session beacon is not running: nothing to stop
exit 0
```
