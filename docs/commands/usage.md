# team usage

Shows what this machine holds: every team with an approval store here, read as one report — each
team's accounts and windows, with what is left and used, when each figure was last read and from
which source. The caller's own project is one of those teams, whether or not it holds a store.
Anyone may run it, from anywhere, and it only reads: no check runs, no CLI is launched, no pane is
read, and nothing is written anywhere.

## Synopsis

    team usage [--json] [--all]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--all` | — | include every team’s seat-to-account breakdown for the owner; other callers see only their own team |
| `--json` | — | the same report as one document, format 1, for a script to read; every key is printed in both views |

The owner can list shared subscriptions in `~/.config/team/accounts.yaml`:

```text
accounts:
  - openai
  - xai
```

These accounts appear even outside a project, with no teams or budgets configured. A team's `budgets.accounts` entry of the same name supplies
its sources and reserve. The watch stores observations in `~/.config/team/usage/readings.json`,
including their observation time and reset when known. It records screen figures even
without a team budget; listing an account does not grant permission to launch seats. A seat's
explicit `account:` wins, otherwise its CLI and launcher select the paying account. Quota figures
come from recorded screen readings or configured checks, never from seat counts. Accounts with
no screen parser and no recorded figure say `not readable from a CLI screen`.

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an unplaced agent, or the owner, from any folder | run it; it needs no approval of its own, and changes nothing about the one in force |
| the owner at a terminal | read machine subscriptions and the caller’s team; `--all` includes every team’s rows and seats |
| every other caller | read the restricted view, whose shape is a closed list, built once before anything prints |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the report printed, whatever its figures, and whether or not this folder holds a project | the header (`usage on this machine, 1 team, 2 labs, 1 account`), then one block per lab and its team rows; in the restricted view — every caller but the owner at a terminal — a caller outside every project also reads shared machine subscriptions | 0 |
| the invocation can't be read, or the stores folder can't be read | `team usage: <problem>`, with the usage for the invocation; the stores folder alone gets `team usage: the store folder cannot be read: the owner reads the reason` for every caller but the owner, who reads the read's own message, the folder among it | 2 |

## Example

The file below names one account, read by a check and by the shipped status line — so a window the
check reports is read from the check; the account is spent by no seat's vendor, so its lab is its
own name:

```yaml file=.agents/team.yaml
format: 1
project: beacon
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: orchestrator
    name: claude-keeper
    label: orchestrator
    leads: true
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
caller: claude-keeper
checks: [examples/checks/codex-quota]
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
```

The state holds one reading for the `session` window, taken from the check two minutes before the
read, and the watch for this session is alive, so no watch clause follows the line. The seat
`claude-keeper` draws on `anthropic`, shown in the seat breakdown. Run from the seat's own pane, the report is the restricted view:

```console
$ team usage ; echo "exit $?"
usage on this machine, 1 team, 2 labs, 1 account

openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known
  beacon    session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known

beacon
  claude-keeper  claude-code  anthropic
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/usage.md](../internal/usage.md).
