# team add

Starts one seat of a running team: one the file declares but nothing runs for — `team up` started the others — or, with
`--temporary`, one beside the team the file does not declare. A stopped or removed seat is put back from the approved
copy first; running seats are untouched. Exit codes: `0` ready (or a plan), `1` refused or left behind, `2` unreadable.

## Synopsis

    team add <name> [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>]
             [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>]

## Flags

| Flag | Meaning |
| --- | --- |
| `--model <model>`, `--effort <effort>` | override the seat's model (a CLI model id, or `<model> <version>`) or reasoning effort for this launch; on a declared seat the owner's alone |
| `--temporary`, `--like <seat>`, `--worktree <task>`, `--until <end>` | start a seat the file does not declare, beside the team, copying the approved seat `--like` names — its CLI, model and launch — starting in `--worktree` instead of the seat's own `cwd`, and working for `--until`: `result:<path>`, a file the seat writes, relative to the project root and read as written (an absolute form, a `~`, and any `..` are refused), or `merged:<branch>`, a branch merged into the base, its name one `git check-ref-format --branch` accepts and prints back unchanged; the name is the `--like` seat's with `-tmp-<n>`, the first `n` that is free |
| `--session <name>`, `--file <path>` | the herdr session or team file to use, instead of `team.session` and `.agents/team.yaml`; the owner's alone |
| `--dry-run` | print whether the seat would launch or be refused, and change nothing; a plan exits 0 |
| `--help`, `-h` | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, the orchestrator's seat, the operator's seat | run it, from a terminal outside herdr — a run with no terminal is refused before the file is read: `team add: only the owner runs this, from a terminal outside herdr`. A seat is that name's, in a session this project's state records, on the pane the state records for it: a seat of another session, a pane merely renamed to the name, and a seat the state records no pane for are refused, and each refusal names the seat and its repair |
| the approved delegate | the file's `delegates` section names it as an external pane, and the ordinary rule above refused: it runs this command as that delegate, for a declared seat. The flags that are the owner's, and any add that would write the file or re-sign the approval, are refused |

## What it reads and writes

| Phase | What it touches |
| --- | --- |
| reads, then writes | the team file (or the one `--file` names), this machine's approval store (the record, and the approved copy the seat is put back from), the session's state (`.agents/team.state.json`, the project's stored budget readings among them), herdr's session, agents and workspaces, the seat's CLI's own config under the seat's home when the seat is about to start in the lobby, and, like `up`, the doctor's findings and the machine's load, free memory, free disk and free swap. Also the team file when the seat has to be put back into it, the state, `.agents/team.log`, the store's ledger of seats the team has had, the CLI's own trust record for the lobby when the seat is about to start there — the file that CLI already reads for a folder it was told to trust, written under the seat's home before the workspace is made, and left untouched when it or a folder above it is a link — and, through herdr, the workspace, the launch and the name |
| prints | `<seat>: ready` when the seat reaches its idle prompt with its rules delivered (a temporary seat prints the name it was given); a launch that stops before that prints `<name>: left out: <what stopped it>`, with the detail that explains it under the record on stderr, exactly as [`team up`](up.md)'s table reads. A dialog is never answered and never asked about: the seat keeps its workspace, `waiting-owner` is recorded, and the seat is the owner's to finish |
| no approval record | A machine with no approval record at all is the one case without an approved copy: the live file stands in for it, ceilings included. The ceilings a run is held to are read from the approval's record, never from the file: a seat that would put the session past `limits.seats`, past `limits.temporary` for a temporary seat, or past a `limits.vendors` entry for its vendor, is refused |

## Refusals

| Message | Exit |
| --- | --- |
| `team add: unknown option --x` / `team add: a seat name is required` / `team add: --like needs a value` (each with the usage) / `team add: line <n>: <message>` / `team add: <message>` | 2 |
| `team add: only the owner, the orchestrator or the operator runs it; this call is <caller>` — or, with the file's `delegates` naming an external pane and this call not it, `team add: only the owner, the orchestrator, the operator or the approved delegate runs it; this call is <caller>`; `team add: --file is the owner's, from a terminal outside herdr; this call is <caller>` / `team add: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team add: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` `` / ``team add: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team add: <name>: its pane holds a process this record cannot tie to the launch` — the record holds the pane's own shell pid and the CLI's pids, read when the seat was launched; the pane is running neither, and the agent session herdr shows there is not the stored one. Nothing is closed and no second CLI is started in it | 1 |
| ``team add: approved before records were signed`` — the record was written by an earlier `team`; the same line, with the case, for a record that does not verify. A missing record is not a refusal, and neither is a file that differs from a stored copy / `team add: the file has no seat "<name>"` | 1 |
| `team add: <name> is already running` — and, for a screen the profile does not recognise, `team remove <name> --abandon closes its workspace without typing`; `team add: the approval allows <n> seats; <m> would be running` / `… <n> temporary seats; …` / `… <n> <vendor> seats; …` | 1 |
| ``team add: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder`` — the CLI's own record for the lobby can't be written; `grok` and `cursor` seats are told their own flag instead (`run grok --trust in <lobby>`, `run cursor-agent --trust in <lobby>`). A `--dry-run` reports it as `<name>: would refuse: <line>` and writes nothing. | 1 |

## Example

A seat already running is never touched, and a seat that starts in the lobby is refused when its CLI's trust record can't be written:

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

```file file=../../.claude.json
not json
```

```console
$ team add claude-beacon ; echo "exit $?"
team add: claude-beacon is already running
exit 1
$ team remove claude-beacon --keep ; echo "exit $?"
claude-beacon: stopped
stopped claude-beacon
exit 0
$ team add claude-beacon ; echo "exit $?"
team add: refused: the lobby is not trusted for claude: run claude in ~/.config/team/lobby and accept the folder
exit 1
```

Rationale, the full delegate and placement rules, what it prints line by line, and every other refusal with its exit:
[docs/internal/add.md](../internal/add.md).
