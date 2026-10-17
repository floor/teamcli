# team usage

Shows what this machine holds: every team it keeps a store for, read as one report — each
team's accounts and windows, with what is left and used, when each figure was last read and from
which source — then a quota view per lab and per account with the pace margin, the seats drawing
on it and one advice line. The caller's own project is one of those teams, whether or not it
holds a store. Anyone may run it, from anywhere, and it only reads: no check runs and nothing is
written. It reads the seat panes herdr records and may run the CLI's own usage command where a
seat runs a CLI that has one, bounded by a timeout; it opens no credential, key or CLI session
file.

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

or key each account by the entity whose subscription it is:

```text
accounts:
  globex: [openai, xai]
```

A flat list is one unnamed entity and reads exactly as before. A keyed account a team's seat spends
that belongs to another entity is borrowed: the team's row for that account names the entity —
`  openai  beacon  weekly  left 70%  …  pace 1.2%/h  (borrowed from globex)` — in the same
parenthesised tail the `(pool)` suffix and the watch clause sit in. The account still counts once,
under the team that spends it, so the closing summary count does not change. A team file's
`entity:` names the team's own
entity; a file that names none borrows every keyed account its seats spend.

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
| anyone — a seat, an unplaced agent, or the owner, from any folder | run it; it changes nothing |
| the owner at a terminal | read machine subscriptions and the caller’s team; `--all` includes every team’s rows and seats |
| every other caller | read the restricted view, whose shape is a closed list, built once before anything prints |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the report printed, whatever its figures, and whether or not this folder holds a project | the account table headed `ACCOUNT  WINDOW  LEFT  USED  RESETS  RESERVE  READ  SOURCE  STATE`, then one line per account with no screen reading and per lab with no account declared, the caller's own team rows, the quota view, one `SEAT  CLI  ACCOUNT` table per team, the collapsed notes, and the closing summary line (`usage on this machine, 1 team, 2 labs, 1 account`); in the restricted view — every caller but the owner at a terminal — a caller outside every project also reads shared machine subscriptions | 0 |
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
`claude-keeper` spends `anthropic`, which no budget here declares: that lab is in use with no
account for it yet, and the seat breakdown names it all the same. Run from the seat's own pane,
the report is the restricted view:

```console
$ team usage ; echo "exit $?"
ACCOUNT  WINDOW   LEFT  USED  RESETS  RESERVE  READ            SOURCE  STATE
openai   session  40%   60%   in 44m  -        -  read 2m ago  check   fresh  pace not known
anthropic  not known: no account declared; declare it in ~/.config/team/accounts.yaml
  openai  beacon  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known

quota
  openai  unknown
    openai  unknown
      not known: no reading yet
advice: no readings yet: no seat status line and no CLI usage command has answered

beacon
  SEAT           CLI          ACCOUNT
  claude-keeper  claude-code  anthropic

usage on this machine, 1 team, 2 labs, 1 account
exit 0
```

The quota block has nothing to show here: this fixture holds a checked session reading in the
team's own state, and the block reads the watch's machine-wide observations and the live sources,
neither of which is present in an example run. On a machine where the watch has recorded a status
row, the same account prints its windows, margin and state there.

## The quota view

After the account table and its per-account lines, `team usage` prints `quota`: one block per lab
and per account, and one advice line.

    quota
      anthropic  ok
        anthropic  ok  seats: lead, coda
          session  used 20%  left 80%  resets in 2h6m  margin +38%  (status line, read 1m ago)
          weekly  used 12%  left 88%  resets in 125h26m  margin +13.3%  (status line, read 1m ago)
      xai  walled
        xai  walled  resets at 3pm  seats: scout
          weekly  used 100%  left 0%  resets unknown  margin not known  (machine reading, read 1m ago)
    advice: swap scout off xai (walled) to anthropic (weekly used 12%, margin +13.3%)

Each window line carries the percentage used and left, when it resets, the margin, and where the
figure came from. The margin is the window's own clock minus the spend: 125h26m to reset leaves
42h34m of a seven-day window gone, 25.3%, so 12% used reads `margin +13.3%`. A status row that
prints its own margin (`W: 12% (+13.3%)`) is believed as printed; a row that prints none is read
against the window's length (five hours for the session window, seven days for the weekly one). A
figure older than five minutes, or one whose reset has passed, prints `stale` and carries no
margin. A wall screen — `quota reached`, `out of usage`, `usage limit reached`, or the CLI's own
rate-limit rejection — prints the account as `walled` with the reset words the screen showed.

An account's state is `walled` at 100% used or on a live wall, `near cap` at 90% or above, `ok`
below that, and `unknown` when nothing fresh has been observed. The one `advice:` line names the
accounts with headroom (a fresh margin of at least +10%), or the walled seats and the healthiest
account to move them to, or says that no readings have answered.

The sources are all observable, and the block reads none of them from a credential, a key or a
CLI session file: the watch's machine-wide readings
(`~/.config/team/usage/readings.json`), the status row of each seat's pane through herdr, the
CLI's own usage command where it has one (`agy --print /usage`, bounded by a 15-second timeout),
and the quota screens above. A lab no account is declared for prints one line — `not known: no
account declared; declare it in ~/.config/team/accounts.yaml` — and the block stays silent for it.
An unreadable seat pane or an unanswered usage command is one counted note, however many seats
hit it. In `--json` the block is the `quota` key: `format`, `accountsFile`, one entry per lab
with its accounts, seats, states and windows, and `advice`.

Rationale, behaviour, refusals and known limits: [docs/internal/usage.md](../internal/usage.md).
