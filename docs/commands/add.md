# team add

Starts one seat of a running team: a seat the file declares but nothing runs for — `team up` started
the others — or, with `--temporary`, a seat beside the team the file does not declare at all. A
declared seat the file marks `stopped: true`, or that `team remove` took out, is put back from the
approved copy first. It starts the seat where `up` would start it, makes the lobby when it needs
it, and never touches the seats that are already running.

## Synopsis

    team add <name> [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>]
             [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>]

## Flags

| Flag | Meaning |
| --- | --- |
| `--model <model>` | override the seat's model for this launch (a CLI model id, or `<model> <version>`); on a declared seat the owner's alone |
| `--effort <effort>` | override the seat's reasoning effort for this launch; on a declared seat the owner's alone |
| `--temporary` | start a seat the file does not declare, beside the team |
| `--like <seat>` | the approved seat a temporary seat copies: its CLI, model and launch |
| `--until <end>` | what the temporary seat works for: `result:<path>` or `merged:<branch>` |
| `--worktree <task>` | the worktree the temporary seat starts in, instead of the seat's own `cwd` |
| `--session <name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--dry-run` | print whether the seat would launch or be refused, and change nothing; a plan exits 0 |
| `--help`, `-h` | the usage, and exit 0 |

The temporary seat's name is the `--like` seat's, with `-tmp-<n>`: the first `n` that is free.
`result:<path>` is a file the seat writes, relative to the project root and read as written: an
absolute form, a `~`, and any `..` are refused. `merged:<branch>` is a branch merged into the base,
its name one `git check-ref-format --branch` accepts and prints back unchanged.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, the orchestrator's seat, the operator's seat | run it, from a terminal outside herdr. A seat is that name's, in a session this project's state records, on the pane the state records for it: a seat of another session, a pane merely renamed to the name, and a seat the state records no pane for are refused, and each refusal names the seat and its repair |
| the approved delegate | the file's `delegates` section names it as an external pane, and the ordinary rule above refused: it runs this command as that delegate, for a declared seat. The flags that are the owner's, and any add that would write the file or re-sign the approval, are refused |
| a run with no terminal | refused before the file is read: `team add: only the owner runs this, from a terminal outside herdr` |

What the check proves is placement, and no more: the state file is in the project, and a process of
the same user that writes its own pane there under the orchestrator's name, and renames its pane,
passes. It guards a mistaken agent, not a hostile process running as the same user. Everything `up`
refuses on refuses here too, for the one seat being started.

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store (the record, and the
approved copy the seat is put back from), the session's state (`.agents/team.state.json`, the
project's stored budget readings among them), herdr's session, agents and workspaces, the seat's
CLI's own config under the seat's home when the seat is about to start in the lobby, and, like
`up`, the doctor's findings and the machine's load, free memory, free disk and free swap.

Writes the team file when the seat has to be put back into it, the state, `.agents/team.log`, the
store's ledger of seats the team has had, the CLI's own trust record for the lobby when the seat is
about to start there — the file that CLI already reads for a folder it was told to trust, written
under the seat's home before the workspace is made, and left untouched when it or a folder above it
is a link — and, through herdr, the workspace, the launch and the name.

A machine with no approval record at all is the one case without an approved copy: the live file
stands in for it, ceilings included. The ceilings a run is held to are read from the approval's
record, never from the file: a seat that would put the session past `limits.seats`, past
`limits.temporary` for a temporary seat, or past a `limits.vendors` entry for its vendor, is
refused.

## What it prints

    claude-keeper: ready

`<seat>: ready` when the seat reaches its idle prompt with its rules delivered; a temporary seat
prints the name it was given. A launch that stops before that prints `<name>: left out: <what
stopped it>`, with the detail that explains it under the record on stderr, exactly as
[`team up`](up.md)'s table reads. A dialog is never answered and never asked about: the seat keeps
its workspace, `waiting-owner` is recorded, and the seat is the owner's to finish. The rest — the
pane `add` adopts, the notes, the launch line's own check, and the log's lines — is on
[the internal page](../internal/add.md).

## Refusals

| Message | Exit |
| --- | --- |
| `team add: unknown option --x` / `team add: a seat name is required` / `team add: --like needs a value` (each with the usage) | 2 |
| `team add: line <n>: <message>` / `team add: <message>` | 2 |
| `team add: only the owner, the orchestrator or the operator runs it; this call is <caller>` | 1 |
| `team add: only the owner, the orchestrator, the operator or the approved delegate runs it; this call is <caller>` — the file names a delegate, and this call is not it | 1 |
| `team add: --file is the owner's, from a terminal outside herdr; this call is <caller>` / `team add: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team add: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` `` | 1 |
| ``team add: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team add: <name>: its pane holds a process this record cannot tie to the launch` — the record holds the pane's own shell pid and the CLI's pids, read when the seat was launched; the pane is running neither, and the agent session herdr shows there is not the stored one. Nothing is closed and no second CLI is started in it | 1 |
| ``team add: the file is not the approved one (<differences>): run `team approve` `` / ``team add: the approved copy can't be read: run `team approve` `` | 1 |
| `team add: the approved file has no seat "<name>"` | 1 |
| `team add: <name> is already running` — and, for a screen the profile does not recognise, `team remove <name> --abandon closes its workspace without typing` | 1 |
| `team add: the approval allows <n> seats; <m> would be running` / `… <n> temporary seats; …` / `… <n> <vendor> seats; …` | 1 |
| ``team add: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder`` — the CLI's own record for the lobby can't be written; `grok` and `cursor` seats are told their own flag instead (`run grok --trust in <lobby>`, `run cursor-agent --trust in <lobby>`) | 1 |
| a `MISS` finding from [team doctor](doctor.md), the seat's own launch line among them | 1 |
| ``team add: another session-mutating run is holding session <session> (pid <pid>); try again when it is done`` | 1 |

The rest — the delegate gate's own refusals, the temporary seat's flag and end checks, the two
flags that are the owner's on a declared seat, the lobby's own checks, the file-changed and
locked-edit lines, and the launch's real-run failures — are on
[the internal page](../internal/add.md), each with its exit.

A `--dry-run` prints a refusal in the plan instead — `  skip <name>: would refuse: …` above
`dry run: nothing was run` — and makes nothing. A dry run that reaches a refusal the real run would
give before doing anything returns that refusal's status and exit id; one that reaches its plan
exits 0, and promises nothing about what happens after. The trust refusal is the one line that
reads differently there. A `--dry-run` reports it as `<name>: would refuse: <line>` and writes
nothing.

## Exit codes

- `0` — the seat reached its idle prompt and is ready; or the temporary seat is; or `--dry-run`
  reached its plan.
- `1` — the run was refused, or the seat was left behind at some stage of its launch.
- `2` — the invocation or the team file can't be read.

## Example

The seat that is already running is never touched, and adding it is refused:

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

```console
$ team add claude-beacon ; echo "exit $?"
team add: claude-beacon is already running
exit 1
```

A seat that starts in the lobby is about to open a folder its CLI has never been asked to trust, so
the record that CLI reads for a trusted folder is written under the seat's home first, before any
workspace is made. A record that cannot be written refuses the seat before the file is edited. The
seat above, started again against such a config:

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

The line names the repair the seat's own CLI needs: a `grok` or `cursor` seat is told `run grok
--trust in <lobby>`, or `run cursor-agent --trust in <lobby>`, in the lobby's place.

Every other example this page carried — the temporary seat, the refused flags, the seats the
approved file does not name — is on [the internal page](../internal/add.md).

Rationale, the full delegate and placement rules, what it prints line by line, and every refusal
with its exit: [docs/internal/add.md](../internal/add.md).
