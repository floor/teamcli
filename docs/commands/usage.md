# team usage

Shows what this machine holds: every team it keeps a store for, read as one report — each
team's accounts and windows, with what is left and used, when each figure was last read and from
which source — then one `SEAT  CLI  ACCOUNT` table per team. `--tree` adds a quota view per lab
and per account with each window’s pace in plain words and the seats drawing on it, and under each team table the
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
| `--all` | — | include every team’s seat-to-account breakdown for the owner, a team that is not running among them; other callers see only their own team |
| `--json` | — | the same report as one document, format 1, for a script to read; every key is printed in both views |
| `--tree` | — | add the quota view — one block per lab and per account, with each window’s pace in words — between the account lines and the team tables, its own `advice:` line inside it, and under each team table each seat’s own window and spend lines; without the flag the same advice line follows the account lines |

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
parenthesised tail the watch clause sits in. The account still counts once,
under the team that spends it, so the closing summary count does not change. A team file's
`entity:` names the team's own
entity; a file that names none borrows every keyed account its seats spend.

The same file can name the plan each account runs on, in the owner's own words:

```text
accounts:
  - google-antigravity
  - anthropic

plans:
  google-antigravity: Google AI Ultra
  anthropic: Claude Max 20x
```

No CLI prints the plan a subscription is on, so this is the one place it comes from — an entry the
owner writes once. A row then leads with it, followed by the bucket the CLI itself names when the
account splits into buckets: `Google AI Ultra, Gemini models` and `Google AI Ultra, Claude and
GPT models` are Antigravity's two buckets on one plan, and `Claude Max 20x` is a subscription that
splits into none. An account with no entry keeps its own name, with its bucket in the CLI's words —
`google-antigravity (Claude and GPT models)` — and never the tool's own word for the pool.

The file can also carry the credit figures the owner wrote down — the money that pays usage past
the plan's limit, from the billing page the owner reads and no CLI prints:

```text
accounts:
  - anthropic

credits:
  anthropic:
    available: 260.50
    currency: EUR
    cap: 300
    autoReload: false
```

`available` and `currency` (three letters) are required; `cap` and `autoReload` are optional. The
account's rows are followed by one line stating the figures and the one answer they allow about
the overage:

```text
  anthropic  credits  €260.50 available  €300.00 monthly cap  auto-reload off  overage is expected before the reset; the credits cover it until they are spent, €39.50 short of the cap
```

Overage is expected when the account's own state is `walled` or `near cap` — the window has hit
its limit or is on course to empty before it resets — and the line answers with the limit the
credit is spent to: the whole cap when the credit reaches it, else how far short of the cap the
credit stops. A window on pace prints `no overage is expected before the reset`, and an account
with no fresh reading prints `no fresh reading, so overage cannot be expected or ruled out`,
rather than claiming either. The expected overage in money is a figure no CLI prints and no plan
price gives, so the line never invents one. A currency this tool has no sign for keeps its code
(`260.50 CHF`).

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
An account no seat's CLI here can read — none of the seats' screen patterns names it and no seat
runs a CLI whose own usage print measures it — and that has no recorded figure prints
`unknown  not readable from a CLI screen`; a shipped profile says the tool knows that CLI, not
that a screen for it runs on this machine. A lab its seats draw on that no screen reads is one
line instead of an account row — `deepseek  not readable from a screen  (11 seats)` — so the seat
count is the fact, not an `unknown` row that reads as a figure not yet seen.

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
accounts print their windows, pace and state there.

## The quota view

With `--tree`, after the account table and its per-account lines, `team usage` prints `quota`: one
block per lab and per account, and one advice line.

    quota
      anthropic  ok
        anthropic  ok  seats: lead, coda
          session  used 20%  left 80%  resets in 2h6m  ahead of pace by 38%  (status line, read 1m ago)
          weekly  used 12%  left 88%  resets in 125h26m  ahead of pace by 13.3%  (status line, read 1m ago)
      xai  walled
        xai  walled  resets at 3pm  seats: scout
          weekly  used 100%  left 0%  resets not printed  pace not known  (machine reading, read 1m ago)
    advice: swap scout off xai (walled) to anthropic (weekly used 12%, ahead of pace by 13.3%)

Each window line carries the percentage used and left, when it resets, the pace in plain words, and
where the figure came from. The reset is a countdown, `resets not printed` when the source gave no
reset moment, or the words a wall screen printed. The pace compares the spend with the window's own
clock — the share of the window already gone minus the share used: 125h26m to reset leaves 42h34m
of a seven-day window gone, 25.3%, so 12% used leaves 13.3 points of room ahead of the clock and
reads `ahead of pace by 13.3%`. Within a band of ten points either way the line says `on pace`; a band or more
ahead prints the figure; a band or more behind prints `runs out in about Xh, before the reset in
Yh` in place of the countdown and the pace, both hours read from the window's own clock — or,
when the source printed the pace but no reset, `runs out before the reset`. A status row that
prints its own pace (`W: 12% (+13.3%)`) is believed as printed; a row that prints none is read
against the window's length (five hours for the session window, seven days for the weekly one). A
figure older than five minutes, or one whose reset has passed, prints marked `stale`, carries no
pace word and reads `unknown` as its state; a source that gave no reset at all prints `pace not
known`, because there is no clock to compare with. A reading older than its own window (five hours
for the session window, a day for daily, seven days for weekly) describes a window instance that
has passed: the line prints `no fresh reading` with the reading's age and source, the window
carries no figure, reset or pace, and the state is `unknown`; the one advice line names each such
window and says that a running seat's status line or the CLI's own usage command reads a fresh one
on the next run. The account table prints the same words in its `STATE` cell, and `--json` carries
`expired: true` with the figures nulled. A wall screen — `quota reached`, `out of usage`, `usage
limit reached`, a limit sentence that names its own window (`Weekly limit reached until …`), or
the CLI's own rate-limit rejection — prints the account as `walled` with the reset words the
screen showed. A wall an account has no figure to carry — the screen that printed the limit is
the account's only reading — keeps its row instead of the one-line seat summary a lab nothing
answers on prints, and the `STATE` cell says `walled  limit reached, resets <time>  read <age>
ago`: the screen's own reset words and when this run read them.

An account's state is `walled` at 100% used or on a live wall, `near cap` when its fresh pace is a
band of ten points or more behind its clock — the window is on course to empty before it resets —
`ok` otherwise, whatever the used percentage: a window at 96% used and on pace is ok. A window
with no reset moment to read — its source printed none — has no pace word, so it falls back to the
used figure, 90% or above reading `near cap`. Nothing fresh reads `unknown`. The same words print in the default account table's
`STATE` column, so `near cap` is never hidden behind `--tree`; the table marks a stale reading
`stale` beside its state, and `fresh`/`stale` stay the team rows' own pace words. The one `advice:`
line — printed with or without `--tree` — names the accounts with headroom (a fresh reading a band
or more ahead of its clock), or the walled seats and the healthiest account to move them to; a
near-cap account is an action, worst first: the window that made it near cap with its used figure
and clock in words (`anthropic weekly 47.1% used, runs out in about 20h12m, before the reset in
150h`), the answer the owner's `credits:` figures give about the overage (`credits €260.50 cover
the overage`), and the seats on it by name, moved to an account that still has headroom — never a
seat or a destination the view does not show (`or move lead, coda off anthropic: no other account
has headroom`). With no figures at all the line says no readings have answered. A fresh figure
whose source printed no reset has no pace word: the
line also names that window and says the reset is in the CLI's own status view, so `not printed`
in a cell always comes with the route to the clock it says is off-screen.

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
it, and the pane note names the seats it is about (`2 seat panes could not be read: coda, lead`);
a team whose own file cannot be read is one note too, naming the team, its `~` root and the file
the read tried, in every view (`the team "team" (~/Code/floor/team): its file could not be read
(~/Code/floor/team/.agents/team.yaml).`) — the registry's record when the definition lives there,
the team file otherwise. A team the machine reports as not running is a record, not a team: its
problems are history, it is not named by a note, and one counted line says how many such teams
there are (`note: 7 teams on this machine are not running`) — `--all` is the flag that prints
their blocks, each by the name its store recorded. A file that cannot be read is asked about
under the session its approved record names, so a broken file on a stopped team makes that same
counted line, never a sentence of its own. In `--json` the
block is the `quota` key:
`format`, `accountsFile`, one entry per lab with its accounts, seats, states and windows, and
`advice`; each window carries its `margin` — the same pace as points, positive ahead of its
clock — its `expired` mark and, when it names one, the `runsOutIn` figure. The text prints the
pace in words; the JSON key keeps its model name for scripts. An account whose plan the machine
file names also carries `plan` — the owner’s words, never a guess — beside its `account` and
`pool`, so a script reads the account itself and its label’s plan apart.

## Each seat’s own figures

Under each team’s `SEAT  CLI  ACCOUNT` table, `--tree` prints that team’s seats’ own figures:

    beacon
      SEAT           CLI          ACCOUNT
      claude-keeper  claude-code  anthropic
      claude-keeper  claude-code  anthropic  session  left 80%  used 20%  resets in 2h6m  ahead of pace by 38%  measured  status line  read 1m ago
      claude-keeper  claude-code  anthropic  weekly  left 88%  used 12%  resets in 125h26m  ahead of pace by 13.3%  measured  status line  read 1m ago
      claude-keeper  claude-code  anthropic  cost  $5.8  measured  status line  read 1m ago

A window line carries the account the figure measures, the window, the same percentages, reset
and pace words the quota block prints, and the source with the reading’s age and its mark. `measured`
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
`readAt`, `age`; `why` when unknown), with `plan` on the seat and on each window whose account
the machine file gives a plan. The cost’s `source` carries the session registry’s own word
for how the amount was obtained — `measured`, `estimated`, or `unknown` for a seat whose screen
printed no amount — so `team sessions` and `team usage` print the same mark for the same figure;
`readFrom` names the screen it was read from (`status line`).

Rationale, behaviour, refusals and known limits: [docs/internal/usage.md](../internal/usage.md).
