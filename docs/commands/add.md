# team add

Starts one seat of a running team: a seat the file declares but nothing runs for — `team up` started
the others — or a temporary seat beside the team, which the file does not declare at all. A declared
seat the file marks `stopped: true` starts again, its mark cleared first. It never touches the seats
that are already running. A seat the file marks `human: true` is refused before anything is
launched or typed: nothing is typed into it or launched over it; left as it is.

A declared seat can be copied too: `team add <name> --like <seat>` writes a new entry under the
source in the file, with the source's fields and titled `<name>`, and starts it now. The source's
own entry is left as it is. A source marked `human: true` is refused the same way. The new entry is
not added to the approval record: the roster change is the owner's to approve, like any other.

The one seat starts where `up` would start it: the orchestrator's and the operator's seat starts in
the project folder, every other seat in the team's lobby outside repositories, verified by the
lobby gate. `--worktree` names the worktree a temporary seat works in. `add` makes the lobby when it
needs it, and refuses the same folders `up` refuses, before it writes anything.

## Synopsis

    team add <name> [--like <seat>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>]
             [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
    team add <name> [--like <seat>] --client <grant-file> --key <client-key> --team <team> [--dry-run] [--json]
    team add --temporary --like <seat> --until <result:path|merged:branch> --client <grant-file> --key <client-key> --team <team> [--dry-run] [--json]

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's record store (the record it holds,
if any), the session's state (`.agents/team.state.json`, including
the project's stored budget readings), herdr (the session's state, its agents and their workspaces),
the seat's CLI's own config under the seat's home when the seat is about to start in the lobby,
and, like `up`: the doctor's findings and the machine's load, free memory, free disk, free swap
and the OS's memory-pressure level.

Writes the team file when the seat has to be put back into it, `.agents/team.state.json` (the seat's
stage, pane and workspace; a seat stopped at a dialog's `waiting-owner` record, with the process
identity read at that moment; a temporary seat's entry), `.agents/team.log`, the store's ledger of
seats the team has had, the CLI's own trust record for the lobby when the seat is about to start
there — the file that CLI already reads for a folder it was told to trust, written under the seat's
home before the workspace is made, and left untouched when it or a folder above it is a link — and,
through herdr: the workspace, the launch, and the name.

For a seat this run starts, the general seat brief goes first, as a claim and a drop: the
session's `briefs` records a fresh incarnation and runtime epoch, the brief's sha256 and the
record's expected id before its signed record is posted at that id, and the launch line hands the
seat's reader that epoch. A temporary seat is delivered like a declared one, and every other live
or human declared seat is delivered to as well, without touching its pane. A name held at the
expected id by another file, a link or a folder is refused, never replaced or followed —
[`team brief rollout --apply`](brief.md) recovers that delivery at the claim's next attempt. A
delivery that cannot be written is said and logged, and the launch goes on;
[`team check`](check.md) names the seat.

## A client's add

A client with no terminal that the owner signed a **manager** bundle grant for (`team grant --client <id>
--entity <entity> --public-key <file> --team <team> --bundle manager --request`, see
[Client grant bundles](../concepts/client-grant-bundles.md#the-manager-bundle)) adds a seat to that one team with

    team add Desk --like operator-1 --client ~/.config/team/grants/cg_<24 hex>.json --key ~/.config/team-client/<id>/client.key --team teamcli

`--team` is required. The client form is dispatched **before** the terminal check below, which no client has
a record for: the grant is verified whole first (the owner's signature, the client's key, `add` in the signed
`allowed_ops`, unexpired, unrevoked, and the exact team, root and registry id signed), then re-read under the
grant lock immediately before the first effect, and the run is the grant's folder alone. Without `--client`
the refusal above is unchanged. The run is never the owner's: `--file`, `--session`, `--model` and `--effort`
are refused with `--client` (exit 2), a seat marked `human: true` is never a source or a target, and a lead
seat (the orchestrator or the operator) is never started by a client, because that is the second half of the
owner's swap. The new entry is **not** added to the approval record: the roster change is for the owner to
approve with the owner seat, and the run says so. Because the new seat is not in the fingerprints the owner
signed, `team up --client` for this team stops until the owner signs a fresh manager grant. Each run writes
`client-add-authorized: grant <cg_id> client <client-id> team <project> root <root> request <rid> seat <name>`
to `<root>/.agents/team.log`, or `client-add-refused: …` after the key proved who the client is. A refusal is
`add.client-refused` (exit 1).

## Who may run it

The owner. A seat of the team is refused before anything else is read: adding a seat is the
owner's in 0.5.0, where no `agree` or `grant` holders stand, so every seat meets the map's own
line — `team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is <caller>` —
whatever pane it sits on and whatever the state records. The one standing that opens a seat's run
is the file's own `delegates` section, below. A run with no terminal is refused before the file is
read: `team add: only the owner or an approved delegate runs this, from a terminal outside herdr or
its own pane` — a caller outside herdr has no registry record, so no record admits it. A seat an
active create-grant names by its own registry id — the record [`team init`](init.md) describes — is
admitted on a file whose root and this call's folder both sit under the paths that record covers,
before it expires. A seat
that leads is not granted: the second half of a swap, `add <lead>`, stays the owner's. `--file`
and `--session` are the owner's alone, from a terminal outside herdr: a non-owner aiming either is
refused before the flagged file or session is read at all. Everything `up` refuses on — a `MISS`
finding from [team doctor](doctor.md), the machine past its limits, the ceilings — refuses here
too, for the one seat being started. A file that differs from a stored copy is not a refusal: the
live file is the record.

A file with a `delegates` section also admits one more caller: the approved delegate, a pane the
owner named in that section as `<session>/<pane id>`, outside the team. When the map refuses — for
every seat it does — and the file names a delegate, the delegate gate decides — it re-reads the
live file and the record in force, never a remembered copy, and proves the caller stands on the
delegate pane, and only that pane — and a caller it passes runs this command as that delegate. The
delegated `add` starts one seat and nothing else. A restart of a seat the record already holds is
admitted when its stanza is hash for hash the live file's: that add writes neither the file nor the
record. A declared copy, `<name> --like <seat>`, is admitted when the record holds the source seat
just as the live file writes it, and the run writes that one entry — never the record. `--temporary`,
`--until`, `--worktree`, `--session` and `--file` stay the owner's, and so does a copy of a source
the record does not hold or holds differently; clearing `stopped: true` and restoring a missing
seat are the owner's too. A `--file` or `--session`
a non-owner aims is the gate's too, once the file names a delegate: the gate refuses it before the
flagged file or the flag's session is read, on the eligibility of the default live file alone —
the flagged file is never opened. With no `delegates` section the run is refused by the rule
alone: the same words, the same exit codes, those two flags' included. A delegated run
that proceeds is attributed in the log before its effects, as
`<time> delegate [delegate] <session>/<pane id> add`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--model <model>` | override the seat's model for this launch (CLI model id or `<model> <version>`); on a declared seat the owner's alone |
| `--effort <effort>` | override the seat's reasoning effort for this launch; on a declared seat the owner's alone |
| `--temporary` | start a seat the file does not declare, beside the team |
| `--like <seat>` | the seat to copy: with `--temporary`, the source of a temporary seat (its CLI, model and launch); alone, the source of a new declared seat named `<name>`, whose entry is written to the file before it starts |
| `--until <end>` | what the temporary seat works for: `result:<path>` or `merged:<branch>`, as below |
| `--worktree <task>` | the worktree the temporary seat is started in, instead of the seat's own `cwd` |
| `--session <name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--client <grant-file>` | the client form: an owner-signed manager bundle grant that carries `add`, see [A client's add](#a-clients-add) |
| `--key <client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team <team>` | with `--client`, the team the grant is for; required |
| `--dry-run` | print whether this seat would launch or be refused. A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--json` | one `team.add` document instead of the closing line; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | the usage, and exit 0 |

The temporary seat's name is the `--like` seat's, with `-tmp-` and the next free seat number. The
number is written in the width and separator the advised `seat-numbering` setting resolves for the
team — two digits and `-` by default (`worker-tmp-01`), or a width of 1 to 4 digits, or `auto` for
the number's own digits, with the separator the setting names. Numbers are compared as numbers, so
a name from an older width still holds its place: 9 is followed by 10, and 99 by 100.

With no `--temporary`, `--like` writes a declared seat instead: the new entry sits directly under the
source's last field, takes the source's fields and the title `<name>`, drops its `stopped` mark and
`count:` (a counted source is split first), and leaves the source's comments and blank lines where
they are. The name must be one the file does not declare, and the source one it does. A copy the
file's own validation refuses — one that repeats the source's `leads`, `assistant` or nickname —
stops before anything is written or launched. The record keeps its own bytes: the new entry is the
owner's to approve.

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
there — its state names the workspace, no other seat's record is on that workspace or on the seat's
recorded pane, the pane still holds the process the record launched where the record carries one,
and an unnamed pane is in it — runs nothing now: its line is checked where that pane runs when the
state records the folder it was started in, and otherwise is not checked at all, the note saying
so, and a miss found there is never refused. A `--dry-run`
prints a refusal in the plan instead — `  skip <name>: would refuse: …` above `dry run: nothing was
run` — and makes nothing. A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch). It returns before these real-run failures, and never takes their status:

- `add.run-lock`, another run holds the session (`src/commands/add.ts:666`)
- `add.lobby`, the lobby could not be created (`src/commands/add.ts:1130`)
- `add.changed`, the file changed while add was checking (`src/commands/add.ts:701`)
- `add.locked`, the locked edit does not validate (`src/commands/add.ts:706`)
- `add.not-ready`, the launch finished without a ready seat; `add.server`, the server did not start (`src/commands/add.ts:743-744`)

`--json` prints one `team.add` document instead: `project`, `session`, the seat name as `seat`,
the pane the launch made as `pane`, the working lines the run printed as `notes`, and the final
record as `action_summary`; `dry_run` is `false` and `status` is `ready`. On `--dry-run` the
document carries `dry_run: true`, `status: "dry-run"`, `action_summary: "dry run: nothing was
run"`, and a `plan` of the steps the real run would take, each the line it would print with its
`+`, `!` or `skip` prefix. A refusal under `--json` prints the `team.error` document on stdout —
its `id` is the contract row for that refusal (`add.caller`, `add.seat-name`, `add.budget`, …) —
and nothing on stderr: the run's own lines ride in the document's `notes`.

## Refusals

| Message | Exit |
| --- | --- |
| `team add: unknown option --x` / `team add: a seat name is required` / `team add: --like needs a value` (each with the usage) | 2 |
| `team add: --until and --worktree are for --temporary` | 2 |
| `team add: "lead" is reserved: lead@<team> addresses the team's lead, so no new seat takes it as a name` — the file declares no seat of the name; a file written before 0.5.0 that already declares one still starts it | 2 |
| `team add: line <n>: <message>` / `team add: <message>` | 2 |
| `team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team add: delegation needs a verified approval: <reason>`` — the delegate gate. A fingerprint difference is not a refusal; the live file names the delegate | 1 |
| ``team add: delegation cannot verify its placement or seats: <reason>`` | 1 |
| `team add: the approved delegate must be an external non-seat pane` | 1 |
| ``team add: the approved delegate <session>/<pane id> may not run `add`; its approved commands are <list>`` | 1 |
| `team add: --<flag> is the owner's; the approved delegate cannot use it` — `--temporary`, `--until`, `--worktree`, `--session` or `--file` | 1 |
| `team add: the approved delegate adds only a same-copy seat: the live file's own stanza, hash for hash; a missing, stopped or changed seat is the owner's` — clearing `stopped: true`, restoring a missing seat, or copying a source the record does not hold or holds differently; also on `--dry-run` | 1 |
| `team add: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team add: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team add: --model and --effort on a declared seat are the owner's; use --temporary --like <seat> for a temporary seat` — any caller but the owner; a temporary seat takes them from any caller | 1 |
| `team add: <name>: its pane holds a process this record cannot tie to the launch` — the record holds the pane's own shell pid and the CLI's pids, read when the seat was launched; the pane is running neither, and the agent session herdr shows there is not the stored one. Nothing is closed and no second CLI is started in it | 1 |
| ``team add: approved before records were signed`` — the record was written by an earlier `team`; the same line, with the case, for a record that does not verify. A missing record is not a refusal, and neither is a file that differs from a stored copy | 1 |
| `team add: the file has no seat "<name>"` | 1 |
| `team add: the file already declares "<name>"; --like adds a copy under a new name` — the source of a `--like` copy is a seat the file holds; the new name must not be one it declares | 1 |
| `team add: <name> is already running`. When that seat's screen is one the profile does not recognise, the owner is also told `team remove <name> --abandon closes its workspace without typing`; anyone else is told `the owner runs team remove <name> --abandon, which closes its workspace without typing` | 1 |
| `team add: no launch profile for \`<cli>\` in this version` | 1 |
| `team add: the file allows <n> seats; <m> would be running` / `… <n> temporary seats; …` / `… <n> <vendor> seats; …` | 1 |
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
| ``team add: the file is legacy: migrate trust to absolute paths including the lobby <lobby>: ...`` | 1 |
| ``team add: trust: must list the lobby <lobby>`` | 1 |
| ``team add: the lobby <lobby>: <check>`` | 1 |
| `team add: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder` — the CLI's own record for the lobby can't be written, so the seat would open that folder untrusted; `grok` and `cursor` seats are told their own flag instead (`run grok --trust in <lobby>`, `run cursor-agent --trust in <lobby>`) | 1 |
| ``team add: seat beacon-qa would start in live, inside the protected checkout live; a seat that isn't `mode: shared` never starts in one`` | 1 |
| `team add: the file changed while add was checking; nothing was written` | 1 |
| `team add: the load is <n> per core, above <n>` / `team add: free memory is <n>%, below <n>%` / `team add: memory pressure is critical` | 1 |
| a `MISS` finding from [team doctor](doctor.md), the seat's own launch line among them | 1 |
| ``team add: another session-mutating run is holding session <session> (pid <pid>); try again when it is done`` — another run holds the session's mutator lock, the one lock `up`, `add`, `down` and `remove` share; the line names no command, because the lock is shared. The lock is taken before this run's first effect and released at its end; `--dry-run` takes no lock and never shows it | 1 |
| ``team add: another session-mutating run may be holding session <session>, and its lock cannot be read; if no run is using it, delete <state dir>/seat-locks/<session>/.run`` — the lock file does not read as a token, so its holder is unknown and only the owner clears it; the line names the file | 1 |

`<lobby>` in the rows above is the team's lobby: the file's `lobby:` when it sets one, else the
lobby the registry recorded for the session, else `<home>/.config/team/lobbies/<entity>` when the
file names `entity:`, else the default `~/.config/team/lobby`.

The ceilings are read from the live file, never from the record: a seat that would put the
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
  - ~/.config/team/lobby      # the team's lobby; the default when the file sets none
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

Only the implementer is up. Adding a seat is the owner's: the orchestrator's own seat is refused
like every other, whatever pane it is placed on and whatever the state records, and the file's
`delegates` section is the one standing that opens a seat's run:

```console caller=claude-keeper
$ team add claude-beacon ; echo "exit $?"
team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is claude-keeper
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

An implementer's seat adds nothing either — not even itself:

```console caller=claude-beacon
$ team add claude-keeper ; echo "exit $?"
team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is claude-beacon
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

A temporary seat is not in the file at all. It is a copy of a declared seat — here the implementer's
— and it works until a result exists or a branch is merged:

```console
$ team add --temporary --like claude-beacon --until result:notes/result.md ; echo "exit $?"
claude-beacon-tmp-01: ready
exit 0
```

The seat's name must be one the live file has, so a name that is not is refused before herdr is
asked anything:

```console
$ team add scratch ; echo "exit $?"
team add: the file has no seat "scratch"
exit 1
$ team add --temporary --like claude-beacon --until later ; echo "exit $?"
team add: --until is result:<path> or merged:<branch>
exit 1
```

The flags that describe a temporary seat are refused without `--temporary`, and a name is required
outside it. Both stop at the usage line, before the file is read:

```console
$ team add claude-keeper --until result:notes/result.md ; echo "exit $?"
team add: --until and --worktree are for --temporary
exit 2
$ team add ; echo "exit $?"
team add: a seat name is required
Usage: team add <name> [--like <seat>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
       team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
       team add <name> [--like <seat>] --client <grant-file> --key <client-key> --team <team> [--dry-run] [--json]
       team add --temporary --like <seat> --until <result:path|merged:branch> --client <grant-file> --key <client-key> --team <team> [--dry-run] [--json]

The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying add for one team (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle manager --request): it adds a seat to that one team, as signed, and nothing else. It never prompts, is never the owner, and takes no --file, --session, --model or --effort. It never adds a human's pane, never starts the orchestrator or the operator, and does not touch the approval record: the roster change is for the owner to approve with the owner seat, and the run says so.

Exits 0 when the seat is ready or the dry-run plan is printed, 1 when add is refused or launch fails, 2 when the invocation or team file can't be read.
exit 2
```

A seat that starts in the lobby is about to open a folder its CLI has never been asked to trust, so
the record that CLI reads for a trusted folder is written under the seat's home first, for that
lobby, before any workspace is made; a CLI whose record this build does not know starts with
nothing written. A record that cannot be written refuses the seat before the file is edited — a
config file, or a folder above it, that is a link is never read or written, and neither is a config
the command cannot read. The seat the page stopped above, started again against such a config:

```file file=../../.claude.json
not json
```

```console
$ team remove claude-beacon --keep ; echo "exit $?"
claude-beacon: stopped
stopped claude-beacon
exit 0
$ team add claude-beacon ; echo "exit $?"
team add: refused: the lobby is not trusted for claude: run claude in ~/.config/team/lobby and accept the folder
exit 1
```

The path above is the default lobby; a team that sets `lobby:`, or whose session already recorded
another lobby, sees that lobby's path in the same place.

The line names the repair the seat's own CLI needs: a `grok` or `cursor` seat is told `run grok
--trust in <lobby>`, or `run cursor-agent --trust in <lobby>`. A `--dry-run` reports it as
`<name>: would refuse: <line>` and writes nothing.
