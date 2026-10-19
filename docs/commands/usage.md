# team usage

Shows what this machine holds: every team it keeps a store for, read as one report — each
team's accounts and windows, with what is left and used, when each figure was last read and from
which source — then one `SEAT  CLI  ACCOUNT` table per team. `--tree` adds a quota view per lab
and per account with the pace margin and the seats drawing on it, and under each team table the
seats' own figures, each marked `measured` when this run read the seat's screen and `estimated`
when it comes from the watch's per-seat record, with one spend line per seat: the amount the
seat's own status row printed, or `unknown` with its reason. The one advice line prints either
way. The caller's
own project is one of those teams, whether or not it holds a store. Anyone may run it, from
anywhere, and it only reads: no check runs and nothing is written. It reads the seat panes herdr
records and may run the CLI's own usage command where a seat runs a CLI that has one, bounded by a
timeout; it opens no credential, key or CLI session file.

## Synopsis

    team usage [--json] [--all] [--tree]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--all` | — | include every team’s seat-to-account breakdown for the owner; other callers see only their own team |
| `--json` | — | the same report as one document, format 1, for a script to read; every key is printed in both views |
| `--tree` | — | add the quota view — one block per lab and per account, with each window’s margin — between the account lines and the team tables, its own `advice:` line inside it, and under each team table each seat’s own window and spend lines; without the flag the same advice line follows the account lines |

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

These accounts appear even outside a project, with no teams or budgets configured. The file is
optional: a lab no entry here declares is one account named after the lab, read from the status
rows and usage prints of the seats that draw on it, so a machine with no `accounts.yaml` still
shows what every lab has left. Listing an account names it, and listing some of a lab's accounts
splits the lab into those accounts. A team's `budgets.accounts` entry of the same name supplies
its sources and reserve. The watch stores observations in `~/.config/team/usage/readings.json`,
including their observation time and reset when known. It records screen figures even
without a team budget; listing an account does not grant permission to launch seats. A seat's
explicit `account:` wins; otherwise its CLI and launcher select the paying account, while its lab
is the model its pane says it runs — herdr's own line for that seat — and only a seat with no
readable pane falls back to the file's vendor. A file's stale `vendor:` never overrides a running
model. Quota figures come from recorded screen readings or configured checks, never from seat
counts, and a machine reading is shown only under an account a shipped screen or usage print
measures: a figure the watch stored under any other account is not printed as that account's.
An account with no screen parser and no recorded figure reads `unknown  not readable from a CLI
screen`; a lab its seats draw on that no screen reads is one line instead of an account row —
`deepseek  not readable from a screen  (11 seats)` — so the seat count is the fact, not an
`unknown` row that reads as a figure not yet seen.

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an unplaced agent, or the owner, from any folder | run it; it changes nothing |
| the owner at a terminal | read machine subscriptions and the caller’s team; `--all` includes every team’s rows and seats |
| every other caller | read the restricted view, whose shape is a closed list, built once before anything prints |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the report printed, whatever its figures, and whether or not this folder holds a project | the account table headed `ACCOUNT  WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE`, with `RESERVE` between `RESETS` and `READ` only when some row has a reserve to show, then one line per account with no screen reading and one line per lab no file declares — that lab's seats as one account named after the lab, or, when no screen reads that lab, its seat count in one line — the one `advice:` line, the caller's own team rows, one `SEAT  CLI  ACCOUNT` table per team, the collapsed notes, and the closing summary line (`usage on this machine, 1 team, 2 labs, 2 accounts`); `--tree` adds the quota view between the account lines and the team tables, with its own `advice:` line, and under each team table one line per seat window and one spend line per seat; in the restricted view — every caller but the owner at a terminal — a caller outside every project also reads shared machine subscriptions | 0 |
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
`claude-keeper` spends `anthropic`, which no budget here declares: the zero-config rule makes that
lab one account named after the lab, unknown until its first reading, and the seat breakdown names
it all the same. Run from the seat's own pane, the report is the restricted view:

```console
$ team usage ; echo "exit $?"
ACCOUNT    WINDOW   LEFT  USED  RESETS  READ            SOURCE  STATE
anthropic  -        -     -     -       -               -       unknown
openai     session  40%   60%   in 44m  -  read 2m ago  check   ok  pace not known
  openai  beacon  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known
advice: no readings yet: no seat status line and no CLI usage command has answered

beacon
  SEAT           CLI          ACCOUNT
  claude-keeper  claude-code  anthropic

usage on this machine, 1 team, 2 labs, 2 accounts
exit 0
```

This is the default report: the table, each account's quota state and pace in `STATE`, the one
`advice:` line, then one team table. `team usage --tree` adds the quota view between the account
lines and the team table, its own `advice:` line inside it. Both of its blocks read unknown here, because this fixture holds a checked session reading
in the team's own state while the block reads the watch's machine-wide observations and the live
sources, neither of which is present in an example run. On a machine where the watch has recorded a
status row — or a seat's own screen has an `L:`/`W:` row, or a CLI's usage print answers — the same
accounts print their windows, margin and state there.

## The quota view

With `--tree`, after the account table and its per-account lines, `team usage` prints `quota`: one
block per lab and per account, and one advice line.

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
figure older than five minutes, or one whose reset has passed, prints marked `stale`, carries no
margin, and reads `unknown` as its state. A wall screen — `quota reached`, `out of usage`, `usage
limit reached`, or the CLI's own rate-limit rejection — prints the account as `walled` with the
reset words the screen showed.

An account's state is `walled` at 100% used or on a live wall, `near cap` at 90% used or above — or
with a fresh margin at or below −50%, so an account spending well ahead of its window's clock is
named even under the used figure — `ok` below both, and `unknown` when nothing fresh has been
observed. The same words print in the default account table's `STATE` column, so `near cap` is
never hidden behind `--tree`; the table marks a stale reading `stale` beside its state, and
`fresh`/`stale` stay the team rows' own pace words. The one `advice:` line — printed with or
without `--tree` — names the accounts with headroom (a fresh margin of at least +10%), or the
walled seats and the healthiest account to move them to, or the near-cap accounts, worst margin
first, with the account that still has headroom beside them, or says that no readings have
answered.

The sources are all observable, and the block reads none of them from a credential, a key or a
CLI session file: the watch's machine-wide readings
(`~/.config/team/usage/readings.json`), the status row of each seat's pane through herdr, the
CLI's own usage command where it has one (`agy --print /usage`, bounded by a 15-second timeout),
and the quota screens above. A lab no account is declared for is one account named after the lab,
drawn from the seats that pay into it; when no screen reads that lab and no reading reached it,
the account table gives it one line with its seat count (`deepseek  not readable from a screen
(11 seats)`), and the quota block keeps its account with those seats behind it until a status row
or a usage print answers. A figure an undeclared account's own read names lands under that
account's lab the same way, and only a reading this caller may make can name it: under the
restricted view a machine-wide reading lands only on a lab the caller's own seats pay. An
unreadable seat pane or an unanswered usage command is one counted note, however many seats hit
it; a team whose own file cannot be read is one note too, naming the team and its `~` root in
every view (`the team "team" (~/Code/floor/team): its file could not be read.`). In `--json` the
block is the `quota` key:
`format`, `accountsFile`, one entry per lab with its accounts, seats, states and windows, and
`advice`.

## Each seat’s own figures

Under each team’s `SEAT  CLI  ACCOUNT` table, `--tree` prints that team’s seats’ own figures:

    beacon
      SEAT           CLI          ACCOUNT
      claude-keeper  claude-code  anthropic
      claude-keeper  claude-code  anthropic  session  left 80%  used 20%  resets in 2h6m  margin +38%  measured  status line  read 1m ago
      claude-keeper  claude-code  anthropic  weekly  left 88%  used 12%  resets in 125h26m  margin +13.3%  measured  status line  read 1m ago
      claude-keeper  claude-code  anthropic  cost  $5.8  measured  status line  read 1m ago

A window line carries the account the figure measures, the window, the same percentages, reset
and margin the quota block prints, and the source with the reading’s age and its mark. `measured`
is a figure this run read from the seat’s own screen; `estimated` is the watch’s per-seat record
in the project state (source `state record`), which fills only the windows the live read did not
answer. A seat with neither prints `unknown  no reading for this seat`.

The spend line is the seat’s own money figure: the amount a Claude Code status row prints in its
`S:` field (`S: $5.8` on a real 2.1.299 screen), read only from the row the profile’s status
patterns recognize, and marked `measured` with its source and reading age. A seat whose screen
printed no amount — any other CLI, an unread pane, or a row without the field — prints
`cost  unknown` with one sentence, never `0`. The figure is per seat and per run: a seat’s
figures and spend are attributed to the run (herdr session) its pane was read in, so two teams’
same-named seats never borrow each other’s figures. In `--json` the same facts are `teams[].seats`:
the seat, its CLI and paying account, its `run`, its `windows` (each with `mark`, `source`,
`readAt`, `age` and `stale`), and its `cost` (`amount`, `currency`, `source`, `readFrom`,
`readAt`, `age`; `why` when unknown). The cost’s `source` carries the session registry’s own word
for how the amount was obtained — `measured`, `estimated`, or `unknown` for a seat whose screen
printed no amount — so `team sessions` and `team usage` print the same mark for the same figure;
`readFrom` names the screen it was read from (`status line`).

Rationale, behaviour, refusals and known limits: [docs/internal/usage.md](../internal/usage.md).
