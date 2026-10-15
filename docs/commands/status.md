# team status

Shows the team as it stands: one line per seat with what the session's herdr shows of it, and one
`difference` for each way the file, the state and the live session disagree, each naming the command
that repairs it. It changes nothing but the owner's `last_valid` copy of the file it read; a run that
is not the owner's writes nothing at all.

## Synopsis

    team status [--session <name>] [--file <path>] [--all] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's |
| `--all` | — | render the expanded seat registry columns (`SEAT`, `ID`, `ROLE`, `CLI`, `MODEL`, `EFFORT`, `STATUS`, `LAST ACTIVE`, `PANE`) and include those fields in `--json` rows |
| `--json` | — | the same reading as one JSON document instead of the table, the notes and the repairs |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | read the team, and aim the read with `--file` and `--session` |
| a seat of the team, placed in the file's session, on the pane the state records for it | read the team; a seat the state records no pane for, or records on another pane, fails closed |
| a pane outside the team that the approved file names in its `delegates` entries | read the team; a pane only the live file names does not pass |
| anyone else, an owner's run without a terminal included | nothing: the fixed sentence `team status: this team is not yours to read` on stderr, stdout empty, exit 2 |

`--file` and `--session` aimed by anyone else are refused before any file or session is read —
`--file is the owner's, from a terminal outside herdr; this call is …`, or `only the owner runs
this, from a terminal outside herdr` for a run with no terminal — and exit 1. And herdr has to
answer once the caller has passed the gate: without it, `status` can't say anything and exits 2.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| no difference | the seats table, the `budgets:` table when the file names an account or a reading is stored, one `note:` line per note, then `0 difference(s)` | 0 |
| at least one difference | the same, then one `difference:` line with its `  repair:` line under it per difference, and the count: `1 difference(s)`, or `2 difference(s), 1 for the owner` when a repair is the owner's | 1 |
| a flag the caller may not aim | the refusal every command gives it | 1 |
| the invocation or the team file can't be read, herdr doesn't answer, or the caller may not read this team | `team status: <problem>`, `team status: herdr doesn't answer; is it installed and running?`, or the one fixed sentence | 2 |

`--json` prints the same reading as one document and nothing else, with the same exit code; a caller
who may not read the team gets the fixed sentence and no document.

## Example

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

budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [check, status_line]
      check: examples/checks/codex-quota
```

```fixture
checks: [examples/checks/codex-quota]
agents: [claude-beacon]
screens:
  claude-beacon: working
state:
  budgets:
    openai/session:
      account: openai
      window: session
      left: 40
      used: 60
      changedAt: "2026-10-04T08:58:00Z"
      resetsAt: "2026-10-04T09:44:00Z"
      seat: null
      source: check
      confirmed: true
    openai/daily/claude-beacon:
      account: openai
      window: daily
      left: 70
      used: 30
      changedAt: "2026-10-04T08:20:00Z"
      resetsAt: null
      seat: claude-beacon
      source: status_line
      confirmed: true
    openai/weekly/claude-beacon:
      account: openai
      window: weekly
      left: 5
      used: 95
      changedAt: "2026-10-04T08:58:00Z"
      resetsAt: "2026-10-04T09:44:00Z"
      seat: claude-beacon
      source: status_line
      confirmed: true
```

Only the implementer is up, so the orchestrator's seat is a difference with its repair. The state
also holds the watch's last readings for the `openai` account the file names: a check's `session`
window, a `daily` one from the status line last seen 40 minutes ago, and a `weekly` one the check
never reported — that one too comes from the status line, so its row marks it a fallback:

```console
$ team status ; echo "exit $?"
team status: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
team beacon, session "beacon"
  claude-keeper  missing  Claude Opus 5.5  -
  claude-beacon  working  Claude Opus 5.5  w1:p1
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: approval #1 (2026-10-04), key fe21ef6293de
difference: claude-keeper is in the file and is not running
  repair: team add claude-keeper
1 difference(s)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/status.md](../internal/status.md).
