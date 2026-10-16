# `team remove`: rationale and known limits

What moved off [the `team remove` page](../commands/remove.md): what the run reads and writes,
the states it leaves a seat in, the behaviour behind the lines it prints, the refusals in their own
words, and the known limits. The synopsis, the flags, the caller table and the exit codes stay on
the page.

## What the run does: the stop, the leave, the leftover

Takes one seat out of the team: asks it to exit, waits for its pane to come back to its shell,
closes its workspace, and edits the file so the seat is not started again. `--keep` leaves the seat
in the file as `stopped: true` instead of taking it out. A seat that is busy — working, blocked at a
prompt, already showing its own exit question, showing a screen the profile does not recognise,
or holding unsent text — is left as it is, unless its owner abandons it. A pane whose CLI has
already exited — its own shell back in front of it, and no CLI process in its foreground list —
is not such a seat: it is removed like a free seat, nothing typed, and its line says the CLI had
exited. One exception: a caller
other than the owner, when herdr reports such a seat idle or done, takes the seat out of the team
and leaves its pane running, with nothing typed into it (below). The same leave reaches a record
the approved copy does not carry and the live file does not declare, when that record is not
temporary and one live agent of its name is idle or done and the screen, read with the cli the
record carries, is not a running turn: the record drops, the pane is left running, nothing is
typed, and the file is not edited, because the name is not in it. A leftover herdr reports
working, or whose recorded cli's screen shows a running turn, stays out for that caller; a
record that carries no cli reads an unknown screen, so idle or done still leaves it. herdr's status
is the gate there, not the screen — the states no profile can read are where a stuck seat hides —
so a seat herdr reports working, or one whose screen shows a running turn, is never taken out; a
seat the profile reads as free is stopped and taken out as always, and a box holding exactly this
CLI's exit text is cleared inside that stop. Every other seat, and the session, are left alone.

## What it reads and writes

Reads the team file, the session's state (`.agents/team.state.json`, for a temporary seat's record),
herdr: whether the session runs, its agents, each pane's screen and status, and the pane's
foreground processes, which is how it knows the CLI has really exited, and the approval store:
stopping a seat and editing the file are changes the owner approves first. Without an approval in
force — never approved, a record from before records were signed, or one the verification refused —
nothing is stopped and nothing is written, with the one-line repair every command prints.

Writes the team file (the seat's entry taken out, or `stopped: true` added to it),
`.agents/team.state.json` (the seat's record is dropped), `.agents/team.log`, and, through herdr:
the exit typed into the pane, the wait for its shell, and the workspace closed — or, on the leave
of a caller other than the owner (below), no typing and no close at all, and the
pane's agent renamed out of the seat's name, best effort. A name the approved copy carries is
a declared seat, even when the state still marks it temporary, and its rules file stays. A name
the copy does not carry is left as it is for the owner, for a temporary record, when the live
file declares it, and when no single live agent of that name is idle or done; a caller other
than the owner leaves an ordinary leftover the live file does not declare, on that idle or done
trigger, and the file is not edited. The owner's `--abandon` removes it, and a temporary
seat's rules file goes with it, out of the project state folder; a seat left in the file as stopped
keeps its file for the next `up`. A file edit that
would not validate is refused before the seat is stopped, so a broken file never costs a live seat.

## Who may run it

The owner, the orchestrator's seat and the operator's seat. The seat is that name's, in a session
this project's state records — the file's session, or one the state records the caller's pane in —
on the pane the state records for that name in that session: a seat of another session, or a pane
merely renamed to the orchestrator's or the operator's name, is refused — and so is a seat the state
records no pane for, or records on another pane than this call is on; those two refusals name the
seat and the repair. What that proves is placement, and no more: the state file is in the project,
and a process of the same user that writes its own pane there under the orchestrator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the
same user.
The
orchestrator's and the operator's own seats are the owner's alone to remove, and so is `--abandon`.
`--file` and `--session` are the owner's alone, from a terminal outside herdr: a non-owner aiming
either is refused before the flagged file or session is read at all.

A file with a `delegates` section also admits one more caller: the approved delegate, a pane the
owner named in that section as `<session>/<pane id>`, outside the team. When the ordinary rule
above refuses and the file names a delegate, the delegate gate decides — it re-reads the live file
and the approval in force, never a remembered copy — and a caller it passes runs this command as
that delegate. The delegated `remove` is the ordinary removal of a named seat: `--keep`, `--abandon`,
`--session` and `--file` stay the owner's, the orchestrator's and the operator's seats stay the
owner's, and a delegated remove never re-signs the approval — the one signing a `--keep` does is
closed to it. A `--file` or `--session` a non-owner aims is the gate's too, once the file names a
delegate: the gate refuses it before the flagged file or the flag's session is read, on the
eligibility of the default live file alone — the flagged file is never opened. With no `delegates`
section nothing changes: the same refusals, the same words, the same exit codes, those two flags'
included. A delegated run that proceeds is attributed in the log before its effects, as
`<time> delegate [delegate] <session>/<pane id> remove`.

## What it prints

    claude-beacon: stopped
    removed claude-beacon

The seat's stop is the plan `down` prints for a seat, with its notes; a seat whose CLI has already
exited prints `<seat>: its CLI had exited; its workspace was closed` instead of `<seat>: stopped`,
with nothing typed into its pane. The last line says what was done with the file:

| Last line | Meaning |
| --- | --- |
| `removed <name>` | the seat's entry was taken out of the file |
| `stopped <name>` | `--keep`: the entry stays, with `stopped: true` |
| `removed temporary <name>` | a temporary seat: it was never in the file |

A caller other than the owner, meeting a seat herdr reports idle or done that is not free, takes
the seat out without asking it to leave: nothing is typed, the workspace is left open, the seat's
state record goes, and the pane's agent is renamed — best effort, one call — to `<name>-left`, or
`-left-2` and so on when that name is held, so it no longer answers the seat's name. The same
line is the leftover's: a record the approved copy does not carry, not temporary, one live agent,
herdr idle or done, the screen not a running turn. The file is left as it is. The last
line names the pane:

    removed <name> (its pane <pane> was left running; nothing was typed; it now reads as <name>-left)

`--keep` marks the entry stopped instead, in the same parenthesised line. When the rename does
not take, the removal stands and the last line ends `it still carries the seat's name`. The
leftover pane is the owner's to close — team never closes it, since that close is `--abandon`
and it is no longer a seat — and the watch reports it as an agent that is running and is not in
the file.

A seat that doesn't leave cleanly is printed once with what stopped it, and `remove` exits 1:
`<seat>: its exit was not typed; left as it is (team remove <seat> --abandon closes it)`,
`<seat>: its exit was not confirmed; <what happened>; left running (team remove <seat> --abandon closes it)`
— the pane never drew the typed text, its box held other text, or the clearing key did not take —
`<seat>: timed out leaving its pane; left as it is (team remove <seat> --abandon closes it)`,
`<seat>: its workspace did not close`. The file is then not edited: the seat is still in the team.
With `--abandon`, that same seat's workspace is closed in the run and the line says so, and the
removal goes on.

A box that holds exactly this CLI's exit text — an earlier run typed it and never confirmed it — is
not the owner's text: when the profile carries the one key that empties a box, the text is cleared
with it inside the stop and the exit typed fresh, and when it does not, the seat is left as it is
with the text named, in the refusal below.

## Refusals

| Message | Exit |
| --- | --- |
| `team remove: unknown option --x` / `team remove: a seat name is required` / `team remove: unexpected "x"` (each with the usage) | 2 |
| `team remove: line <n>: <message>` | 2 |
| `team remove: only the owner, the orchestrator or the operator runs it; this call is <caller>` | 1 |
| `team remove: only the owner, the orchestrator, the operator or the approved delegate runs it; this call is <caller>` — the file names a delegate, and this call is not it | 1 |
| ``team remove: delegation needs a verified approval: <reason>`` — the delegate gate, when the record is legacy or refused | 1 |
| ``team remove: delegation cannot verify its placement or seats: <reason>`` | 1 |
| `team remove: the approved delegate must be an external non-seat pane` | 1 |
| ``team remove: the approved delegate <session>/<pane id> may not run `remove`; its approved commands are <list>`` | 1 |
| `team remove: --<flag> is the owner's; the approved delegate cannot use it` — `--keep`, `--abandon`, `--session` or `--file` | 1 |
| `team remove: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team remove: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team remove: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` `` | 1 |
| ``team remove: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team remove: only the owner abandons a seat, from a terminal outside herdr` | 1 |
| `team remove: only the owner removes the orchestrator's or the operator's seat; this call is <caller>` | 1 |
| `team remove: session can't be "default", herdr's own session` | 1 |
| `team remove: the team has no seat "<name>"` | 1 |
| `team remove: a temporary seat is not in the file; there is nothing to keep` | 1 |
| `team remove: herdr doesn't answer; nothing was changed` | 1 |
| `team remove: session <session> runs, and its agents can't be read; nothing was changed` | 1 |
| `team remove: <name>: its record is not an approved seat; left as it is (the owner cleans it: team remove <name> --abandon)` — the owner, a temporary record, a record with no single live agent, a name the live file declares, or one live agent herdr reports as neither idle, done, nor working, while its screen is not a running turn | 1 |
| `team remove: <name> is working; left as it is (run this again once herdr reports the seat idle or done)` — a caller other than the owner, the live file does not declare the name, and the leftover is working: herdr says so, or the screen, read with the cli the record carries, shows a running turn | 1 |
| `team remove: <name>: herdr lists more than one agent of this name; left as it is` | 1 |
| `team remove: the approved copy of the team file cannot be read` | 1 |
| `team remove: <seat> is working; left as it is` | 1 |
| `team remove: <seat> is blocked at a prompt, which team never answers` | 1 |
| `team remove: <seat> sits at its own exit question; left as it is (team remove <seat> --abandon closes it)` | 1 |
| `team remove: <seat> shows a screen the profile does not recognise; left as it is (team remove <seat> --abandon closes its workspace without typing)` — the owner's; a caller other than the owner meeting a seat herdr reports idle or done takes the seat out instead (above), and meets this line with `(run this again once herdr reports the seat idle or done)` where herdr reports the seat anything but idle or done; a pane whose CLI has already exited is not this case — the seat is removed like a free one, nothing typed | 1 |
| `team remove: <seat> holds unsent text in its input box; left as it is` | 1 |
| `team remove: <seat> holds this CLI's exit text (<exit>) unsent in its input box; left as it is (the owner sends it or clears it in its pane)` | 1 |
| ``team remove: no launch profile for `<cli>`; left as it is`` | 1 |
| ``team remove: the file was never approved on this machine `` | 1 |
| ``team remove: approved before records were signed`` — the record was written by an earlier `team`; the same line, with the case, for a record that does not verify | 1 |
| ``team remove: another session-mutating run is holding session <session> (pid <pid>); try again when it is done`` — another run holds the session's mutator lock, the one lock `up`, `add`, `down` and `remove` share; the line names no command, because the lock is shared. The lock is taken before this run's first effect and released at its end; every refusal above is decided first and never shows it | 1 |
| ``team remove: another session-mutating run may be holding session <session>, and its lock cannot be read; if no run is using it, delete <state dir>/seat-locks/<session>/.run`` — the lock file does not read as a token, so its holder is unknown and only the owner clears it; the line names the file | 1 |

`--abandon` answers the seat-state refusals above — a seat that is working, blocked at a prompt,
sitting at its own exit question, on a screen the profile does not recognise, holding unsent
text, or holding this CLI's exit text unsent: the seat is not asked anything, its workspace is
closed as it is, and its pane's text is lost. A pane whose CLI has already exited is not one of
those states — its own shell is back in front and no CLI process is in its foreground list — so
the seat is closed by the ordinary run, nothing typed, and its line says the CLI had exited. A
caller other than the owner has its own answer to
those states, where herdr reports the seat idle or done: the leave above — the seat out of the
team, the pane left running, nothing typed.

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first is also on [the `team remove` page](../commands/remove.md); the rest stand only in this note
and are not executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.

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

  - role: implementer
    name: claude-reviewer
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: all
```

A seat mid-turn is not interrupted — its work would be lost — and `remove` says which state it was
in:

```console screens="claude-beacon=working"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon is working; left as it is
exit 1
```

A permission prompt is the same: `team` never answers one, so it never closes a seat that waits at
one.

```console screens="claude-beacon=permission"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon is blocked at a prompt, which team never answers
exit 1
```

A screen the profile can't read never frees itself, and only the owner may abandon it, so the
owner's refusal names that way out:

```console screens="claude-beacon=unknown"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon shows a screen the profile does not recognise; left as it is (team remove claude-beacon --abandon closes its workspace without typing)
exit 1
```

Anyone else — the orchestrator, the operator, or the approved delegate — meeting a seat herdr
reports idle or done takes the seat out and leaves the pane as it is instead; the example below
shows that removal, and a seat herdr reports working is refused to them too, with their own way
out named.

An implementer's seat may not remove anything — not even itself:

```console caller=claude-beacon
$ team remove claude-beacon ; echo "exit $?"
team remove: only the owner, the orchestrator or the operator runs it; this call is claude-beacon
exit 1
```

The orchestrator's seat may remove others, never itself, and `--abandon` is the owner's own, from a
terminal outside herdr:

```console caller=claude-keeper
$ team remove claude-keeper ; echo "exit $?"
team remove: only the owner removes the orchestrator's or the operator's seat; this call is claude-keeper
exit 1
$ team remove claude-beacon --abandon ; echo "exit $?"
team remove: only the owner abandons a seat, from a terminal outside herdr
exit 1
```

A temporary seat is recorded in the state, not in the approved copy, so a plain `remove` leaves it.
`--keep` has nothing to keep. The owner's `--abandon` removes it, typing nothing, and its rules
file goes with it. It comes before the seats the file declares change: taking a seat out of the
file moves the `limits` the file defaults to, and `add --temporary` refuses a file that is no
longer the approved one.

```console
$ team add --temporary --like claude-beacon --until result:notes/result.md ; echo "exit $?"
claude-beacon-tmp-1: ready
exit 0
$ team remove claude-beacon-tmp-1 --keep ; echo "exit $?"
team remove: a temporary seat is not in the file; there is nothing to keep
exit 1
$ team remove claude-beacon-tmp-1 ; echo "exit $?"
team remove: claude-beacon-tmp-1: its record is not an approved seat; left as it is (the owner cleans it: team remove claude-beacon-tmp-1 --abandon)
exit 1
$ team remove claude-beacon-tmp-1 --abandon ; echo "exit $?"
claude-beacon-tmp-1: stopped
removed temporary claude-beacon-tmp-1
exit 0
```

`--keep` stops the seat and leaves its place in the file, for a seat that will come back:

```console
$ team remove claude-beacon --keep ; echo "exit $?"
claude-beacon: stopped
stopped claude-beacon
exit 0
$ team add claude-beacon ; echo "exit $?"
claude-beacon: ready
exit 0
```

A caller other than the owner, meeting a seat herdr reports idle or done that is not free, takes
the seat out and leaves the pane as it is: nothing is typed, the workspace stays open, and the
pane's agent is renamed so it no longer answers the seat's name (`--keep` leaves the entry
stopped, with the same parenthesised line):

```console caller=claude-keeper screens="claude-reviewer=unknown"
$ team remove claude-reviewer ; echo "exit $?"
removed claude-reviewer (its pane w3:p1 was left running; nothing was typed; it now reads as claude-reviewer-left)
exit 0
```

Without `--keep` the seat's entry goes with it, and a second `remove` has nothing to find:

```console
$ team remove claude-beacon ; echo "exit $?"
claude-beacon: stopped
removed claude-beacon
exit 0
$ team remove claude-beacon ; echo "exit $?"
team remove: the team has no seat "claude-beacon"
exit 1
```

A name is required, and its absence stops at the usage line before the file is read:

```console
$ team remove ; echo "exit $?"
team remove: a seat name is required
Usage: team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]
exit 2
```
