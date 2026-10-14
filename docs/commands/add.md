# team add

Starts one seat of a running team: a seat the file declares but nothing runs for — `team up` started
the others — or a temporary seat beside the team, which the file does not declare at all. A declared
seat the file marks `stopped: true`, or that `team remove` took out, is put back from the approved
copy first. It never touches the seats that are already running.

The one seat starts where `up` would start it: every seat starts in the machine lobby
`~/.config/team/lobby` outside repositories, verified by the lobby gate, unless `--worktree`
names the worktree it works in. `add` makes the lobby when it needs it, and refuses
the same folders `up` refuses, before it writes anything.

## Synopsis

    team add <name> [--dry-run] [--session <name>] [--file <path>]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>]
             [--dry-run] [--session <name>] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store (the record, and the
approved copy the seat is put back from), the session's state (`.agents/team.state.json`, including
the project's stored budget readings), herdr (the session's state, its agents and their workspaces),
and, like `up`: the doctor's findings and the machine's load, free memory, free disk and free swap.

Writes the team file when the seat has to be put back into it, `.agents/team.state.json` (the seat's
stage, pane and workspace; a seat stopped at a dialog's `waiting-owner` record, with the process
identity read at that moment; a temporary seat's entry), `.agents/team.log`, the store's ledger of
seats the team has had, and, through herdr: the workspace, the launch, and the name.

## Who may run it

The owner, the orchestrator's seat and the operator's seat. A run with no terminal is refused before the file is read: `team add: only the owner runs this, from a terminal outside herdr`. The seat is that name's, in a session
this project's state records — the file's session, or one the state records the caller's pane in —
on the pane the state records for that name in that session: a seat of another session, or a pane
merely renamed to the orchestrator's or the operator's name, is refused — and so is a seat the state
records no pane for, or records on another pane than this call is on; those two refusals name the
seat and the repair. What that proves is placement, and no more: the state file is in the project,
and a process of the same user that writes its own pane there under the orchestrator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the
same user. `--file` and `--session` are the owner's alone, from a terminal outside herdr: a
non-owner aiming either is refused before the flagged file or session is read at all. Everything `up`
refuses on — a file that is not the approved one, a `MISS`
finding from [team doctor](doctor.md), the machine past its limits, the approval's ceilings — refuses
here too, for the one seat being started.

A file with a `delegates` section also admits one more caller: the approved delegate, a pane the
owner named in that section as `<session>/<pane id>`, outside the team. When the ordinary rule
above refuses and the file names a delegate, the delegate gate decides — it re-reads the live file
and the approval in force, never a remembered copy — and a caller it passes runs this command as
that delegate. The delegated `add` is the ordinary one for a declared seat: `--temporary`, `--like`,
`--until`, `--worktree`, `--session` and `--file` stay the owner's, and so does any add that would
edit the file or the approval — restoring a seat the file no longer holds, or clearing
`stopped: true`, both of which write the file and re-sign the approval. A `--file` or `--session`
a non-owner aims is the gate's too, once the file names a delegate: the gate refuses it before the
flagged file or the flag's session is read, on the eligibility of the default live file alone —
the flagged file is never opened. With no `delegates` section nothing changes: the same refusals,
the same words, the same exit codes, those two flags' included. A delegated run
that proceeds is attributed in the log before its effects, as
`<time> delegate [delegate] <session>/<pane id> add`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--temporary` | start a seat the file does not declare, beside the team |
| `--like <seat>` | the approved seat a temporary seat is a copy of: its CLI, model and launch |
| `--until <end>` | what the temporary seat works for: `result:<path>` or `merged:<branch>`, as below |
| `--worktree <task>` | the worktree the temporary seat is started in, instead of the seat's own `cwd` |
| `--session <name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--dry-run` | print whether this seat would launch or be refused. A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | the usage, and exit 0 |

The temporary seat's name is the `--like` seat's, with `-tmp-<n>`: the first `n` that is free.

`--until` accepts one of two ends, and nothing else.

`result:<path>` is a file the seat writes. The path is relative to the project root, read as
written: an absolute form (`/…`, a drive path, or `~`) is refused, and so is any `..` segment,
including one that would still land inside the project. That check does not follow a symlink.
Whether the file exists is asked only after the path has been accepted, and that question does
follow a link, so a link that already sits inside the project can name a file outside it.

`merged:<branch>` is a branch merged into the base. The branch is a name `git check-ref-format --branch`
accepts and prints back unchanged, and it cannot start with `-`.

## What it prints

    claude-keeper: ready

A seat that reaches its idle prompt with its rules delivered prints `<seat>: ready`; the temporary
seat prints `<name>: ready` under the name it was given. A seat the state records whose pane no
longer holds the process `team` launched is not `already running`: its workspace is closed without
input and the seat is launched fresh, with the line `up` prints for it. Everything else a launch
can print is the same as `up`'s, with the seat's name in front: one record per seat —
`<name>: ready`, or `<name>: left out: <what stopped it>` — and the detail that explains it
written to stderr under the record, exactly as `up`'s table reads: `left out: its workspace was
not created; left at launched`, `left out: timeout`,
`left out: its pane has been back at its shell for <n> s and shows no CLI prompt; left at launched`, `left out: permission`,
`left out: vendor notice`, and the rest of the table on the
[team up](up.md) page. A dialog is never answered and never asked about: `add` keeps the seat's
workspace, records `waiting-owner` with the classification and the process identity read at that
moment, sends no input, and reports `<name>: left out: <classification>` — `trust` under either
policy, `permission`, `question` or `vendor notice`. The seat is the owner's to finish then: a later
`team up` reuses the recorded pane and enters the pause on the [team up](up.md) page. A seat whose
idle wait runs out keeps the ordinary `timeout` record and the detail under it.
A wait that ended without a prompt writes the pane's last lines under the
record, on stderr, as `up` does. The log file gets each record's line alone, once per final record:
its reason in words, never a folder the run resolved, a pane's text or a file's content — the
detail under the record is stderr's alone. First-message rules go to the seat's file in the project state folder and arrive as
the one line `up` types, read back and entered, exactly as that page describes. A seat
`add` leaves out takes its rules file with it; a temporary seat removed with `team
remove` or stopped by `team down` loses its file with the seat, while a declared seat's
file stays for the next `up`.

The seat's own launch line is checked where it will start, before the file is edited and before any
workspace is made. A note — a word of the line quotes or substitutes text, or a relative argument is
not there yet — is said once as `  note <name>: <why>`, as `up` says it. A line that can't run is
refused in the same paragraph as any other `MISS` finding: `team add: <name>: its launch line starts
\`<word>\`, which is not on the PATH`, or `team add: <name>: its launch line runs \`<path>\`, not
found from its start folder <folder>; the same file is at \`<absolute>\` from the project root —
write that path` — and the file is left alone. A seat this `add` adopts into a pane that is already
there — its state names the workspace, and an unnamed pane is in it — runs nothing now: its line is
checked where that pane runs when the state records the folder it was started in, and otherwise is
not checked at all, the note saying so, and a miss found there is never refused. A `--dry-run`
prints a refusal in the plan instead — `  skip <name>: would refuse: …` above `dry run: nothing was
run` — and makes nothing. A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch). It returns before these real-run failures, and never takes their status:

- `add.run-lock`, another run holds the session (`src/commands/add.ts:555`)
- `add.lobby`, the lobby could not be created (`src/commands/add.ts:563`)
- `add.changed`, the file changed while add was checking (`src/commands/add.ts:584`)
- `add.locked`, the locked edit does not validate (`src/commands/add.ts:589`)
- `add.not-ready`, the launch finished without a ready seat; `add.server`, the server did not start (`src/commands/add.ts:620-622`)

## Refusals

| Message | Exit |
| --- | --- |
| `team add: unknown option --x` / `team add: a seat name is required` / `team add: --like needs a value` (each with the usage) | 2 |
| `team add: --like, --until and --worktree are for --temporary` | 2 |
| `team add: line <n>: <message>` / `team add: <message>` | 2 |
| `team add: only the owner, the orchestrator or the operator runs it; this call is <caller>` | 1 |
| `team add: only the owner, the orchestrator, the operator or the approved delegate runs it; this call is <caller>` — the file names a delegate, and this call is not it | 1 |
| ``team add: delegation needs a verified approval: <reason>`` / ``team add: delegation needs a readable approved copy: run `team approve` `` / ``team add: delegation needs the approved file: the file is not the approved one (<differences>): run `team approve` `` — the delegate gate, reading the same approval every other check reads | 1 |
| ``team add: delegation cannot verify its placement or seats: <reason>`` | 1 |
| `team add: the approved delegate must be an external non-seat pane` | 1 |
| ``team add: the approved delegate <session>/<pane id> may not run `add`; its approved commands are <list>`` | 1 |
| `team add: --<flag> is the owner's; the approved delegate cannot use it` — `--temporary`, `--like`, `--until`, `--worktree`, `--session` or `--file` | 1 |
| `team add: the approved delegate cannot change the file or the approval; the owner adds a missing or stopped seat` — an add that would restore a missing seat or clear `stopped`, also on `--dry-run` | 1 |
| `team add: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team add: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team add: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` `` | 1 |
| ``team add: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| ``team add: the file was never approved on this machine: run `team approve` `` | 1 |
| ``team add: approved before records were signed: run `team approve` once`` — the record was written by an earlier `team`; the same line, with the case, for a record that does not verify | 1 |
| ``team add: the file is not the approved one (<differences>): run `team approve` `` | 1 |
| ``team add: the approved copy can't be read: run `team approve` `` | 1 |
| `team add: the approved file has no seat "<name>"` | 1 |
| `team add: <name> is already running`. When that seat's screen is one the profile does not recognise, the owner is also told `team remove <name> --abandon closes its workspace without typing`; anyone else is told `the owner runs team remove <name> --abandon, which closes its workspace without typing` | 1 |
| `team add: no launch profile for \`<cli>\` in this version` | 1 |
| `team add: the approval allows <n> seats; <m> would be running` / `… <n> temporary seats; …` / `… <n> <vendor> seats; …` | 1 |
| `team add: refused: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | 1 |
| `team add: refused: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | 1 |
| `team add: session can't be "default", herdr's own session` | 1 |
| `team add: herdr doesn't answer` | 1 |
| ``team add: session <session> is stopped; clear it with `herdr session delete <session>` `` | 1 |
| `team add: session <session> runs, and its agents can't be read` | 1 |
| `team add: --until is result:<path> or merged:<branch>` | 1 |
| `team add: a result path is relative to the project` / `team add: <path> already exists` — the first is an absolute path, a `~` path, or any path with `..` | 1 |
| `team add: workspace.base is required to read a merged end` / `team add: "<branch>" is not a branch name` / `team add: branch <branch> doesn't exist` | 1 |
| `team add: no worktree named "<task>" is recorded` | 1 |
| `team add: worktree <task> has a failed setup; team worktree remove <task>` | 1 |
| ``team add: the file is legacy: migrate trust to absolute paths including the lobby ~/.config/team/lobby: ...`` | 1 |
| ``team add: trust: must list the lobby ~/.config/team/lobby`` | 1 |
| ``team add: the lobby ~/.config/team/lobby: <check>`` | 1 |
| ``team add: seat beacon-qa would start in live, inside the protected checkout live; a seat that isn't `mode: shared` never starts in one`` | 1 |
| `team add: the file changed while add was checking; nothing was written` | 1 |
| `team add: the load is <n> per core, above <n>` / `team add: free memory is <n>%, below <n>%` | 1 |
| a `MISS` finding from [team doctor](doctor.md), the seat's own launch line among them | 1 |
| ``team add: another session-mutating run is holding session <session> (pid <pid>); try again when it is done`` — another run holds the session's mutator lock, the one lock `up`, `add`, `down` and `remove` share; the line names no command, because the lock is shared. The lock is taken before this run's first effect and released at its end; `--dry-run` takes no lock and never shows it | 1 |
| ``team add: another session-mutating run may be holding session <session>, and its lock cannot be read; if no run is using it, delete <state dir>/seat-locks/<session>/.run`` — the lock file does not read as a token, so its holder is unknown and only the owner clears it; the line names the file | 1 |

The ceilings are read from the approval's record, never from the file: a seat that would put the
session past `limits.seats`, past `limits.temporary` for a temporary seat, or past a
`limits.vendors` entry for its vendor, is refused.

## Exit codes

- `0` — the seat reached its idle prompt and is ready; or the temporary seat is; or `--dry-run` reached its plan. A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch).
- `1` — the run was refused, or the seat was left behind at some stage of its launch.
- `2` — the invocation or the team file can't be read.

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
agents: [claude-beacon]
```

Only the implementer is up. A pane made by hand and renamed `claude-keeper` is not the orchestrator:
the state records no pane for the seat, so nothing tells that shell apart from the seat, and every
command that changes the team refuses it, naming the seat and the repair only the owner can make —
the hand-started pane is closed, and `team up` starts the seat with a pane of its own:

```console caller=claude-keeper
$ team add claude-beacon ; echo "exit $?"
team add: no pane is recorded for seat claude-keeper in this session: the owner stops that seat and runs `team up`
exit 1
```

The orchestrator's seat is in the file and nothing runs for it, which is
`team status`'s `missing` and the repair it names:

```console
$ team add claude-keeper ; echo "exit $?"
claude-keeper: ready
exit 0
```

The seat that is already running is never touched, and adding it is refused:

```console
$ team add claude-beacon ; echo "exit $?"
team add: claude-beacon is already running
exit 1
```

A seat whose screen the profile does not recognise gets that same refusal with the way out named.
The owner is told `team remove <name> --abandon closes its workspace without typing`. Anyone else
is told `the owner runs team remove <name> --abandon, which closes its workspace without typing`.
A screen the profile recognises keeps the sentence above.

An implementer's seat is neither the orchestrator's nor the operator's, so it adds nothing — not even
itself:

```console caller=claude-beacon
$ team add claude-keeper ; echo "exit $?"
team add: only the owner, the orchestrator or the operator runs it; this call is claude-beacon
exit 1
```

`team remove --keep` leaves a seat in the file marked stopped, and `add` is what clears the mark and
starts it again:

```console
$ team remove claude-beacon --keep ; echo "exit $?"
claude-beacon: stopped
stopped claude-beacon
exit 0
$ team add claude-beacon ; echo "exit $?"
claude-beacon: ready
exit 0
```

A temporary seat is not in the file at all. It is a copy of an approved seat — here the implementer's
— and it works until a result exists or a branch is merged:

```console
$ team add --temporary --like claude-beacon --until result:notes/result.md ; echo "exit $?"
claude-beacon-tmp-1: ready
exit 0
```

The seat's name must be one the approved file has, so a name that is not is refused before herdr is
asked anything:

```console
$ team add scratch ; echo "exit $?"
team add: the approved file has no seat "scratch"
exit 1
$ team add --temporary --like claude-beacon --until later ; echo "exit $?"
team add: --until is result:<path> or merged:<branch>
exit 1
```

The flags that describe a temporary seat are refused without `--temporary`, and a name is required
outside it. Both stop at the usage line, before the file is read:

```console
$ team add claude-keeper --like claude-beacon ; echo "exit $?"
team add: --like, --until and --worktree are for --temporary
exit 2
$ team add ; echo "exit $?"
team add: a seat name is required
Usage: team add <name> [--dry-run] [--session <name>] [--file <path>]
       team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--dry-run] [--session <name>] [--file <path>]
exit 2
```
