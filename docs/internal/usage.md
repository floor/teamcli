# Usage readings and account ownership

`team usage` reads subscriptions and their latest recorded figures. Its default output starts
with the machine account rows, then shows the caller's team and the account each seat draws on;
the quota view below is the same report under `--tree`, and `--json` always carries it.
`--all` includes every team's rows and seat breakdown for the owner. The existing restricted view
still hides other teams' names, paths and seat rows from agents.

## Machine subscriptions

`~/.config/team/accounts.yaml` is optional: a lab no entry declares is one account named after
the lab (below). When present it lists subscriptions once:

```yaml
accounts:
  - openai
  - anthropic
  - xai
  - google-antigravity
  - google-gemini
  - zai
  - deepseek
  - cursor
```

or keys each account by the entity whose subscription it is:

```yaml
accounts:
  northwind: [anthropic, openai]
  garden: [xai]
```

Both forms read the same list of machine accounts; a flat list is one unnamed entity. A map entry
whose value is no list of names keeps the older reading — its key is an account name of the unnamed
entity. Two entities listing one name: the first entry in the file owns it, and a name only the
unnamed entry carries is owned by nobody, so it is never borrowed. The borrowing rule is one
line: a team's seat spends an account, the map gives that account to an entity other than the
team's own `entity:` (a file naming none borrows every keyed account its seats spend), and the
team's row for that account ends `  (borrowed from <entity>)`. The same clause rides the
seat's spend-account row. It is display only, in both views: the account is counted once, under
the team that spends it, and the closing summary count is unchanged. Nothing else moves — a borrowed
name prints a fact both the owner and a restricted caller already read, the account from the
machine's own file and the entity from the owner's own config.

These accounts count even if no team has a budgets section, and even if there are no team stores.
A team's approved `budgets.accounts` declaration of the same name supplies that team's account
kind, sources and reserve. Listing a machine account does not authorize a launch or approve a
check. Machine subscription figures are available outside a project; team-only accounts retain
the existing restricted-view boundary.

A seat's explicit `account:` takes precedence. Otherwise the paying account comes from its CLI
and launcher:

| Seat | Account |
| --- | --- |
| Grok | `xai` |
| Antigravity | `google-antigravity` |
| Gemini CLI | `google-gemini` |
| Codex | `openai` |
| Claude Code | `anthropic` |
| Claude Code through `claude-glm.sh` | `zai` |
| Claude Code through `claude-deepseek.sh` | `deepseek` |
| Cursor | `cursor` |

Antigravity seats also carry a model pool: `gemini` or `claude-gpt`. The store keeps pool readings
separate; unknown models have no inferred pool. The pool is the tool's own word and never prints:
a label names the bucket as the CLI's usage print does (`Gemini models`, `Claude and GPT models`,
from `quota-observe.ts`), and leads with the account's plan when the owner wrote one down
(`machinePlansOf`, below).

The machine file `~/.config/team/accounts.yaml` may also carry a top-level `plans:` map from
account name to the plan's words (`plans: { google-antigravity: Google AI Ultra }`). No CLI prints
the plan a subscription runs on, so this owner-written entry is the only source, read once per run
by `machinePlansOf` and carried as `MachineUsage.plans` into every label (`accountLabel`): the plan
and the bucket (`Google AI Ultra, Claude and GPT models`), the account and the bucket when no plan
is set (`google-antigravity (Claude and GPT models)`), the account alone for a subscription that
splits into no bucket. JSON keeps `account` and `pool` and adds `plan` where one is set.

The same file may carry a top-level `credits:` map, one entry per account: `available` (a
non-negative number) and `currency` (three letters) are required, `cap` (a positive number) and
`autoReload` (a boolean) are optional. `machineCreditsOf` reads it once per run into
`MachineUsage.credits`; `reportOf` copies the entries for the accounts this view prints a row
for into `UsageReport.credits`, keyed by account and copied field by field, so the owner's map
never rides the JSON by reference. `reportText` prints one `credits` line under the account's
rows: the money available, the monthly cap and the reload state, then the overage answer for the
account's quota state — `walled` or `near cap` prints `overage is expected before the reset`
with the limit the credit is spent to (the whole cap when the credit reaches it, else how far
short of the cap it stops), `ok` prints `no overage is expected before the reset`, and `unknown`
prints that no fresh reading can say either way. The expected overage in money is nowhere in
these figures — no CLI prints it and no plan price turns the window's overshoot into money — so
the line never invents one. An entry that names no available amount or no currency is skipped,
never guessed, and an optional field that is no figure is left out while the rest of the entry
still reads.

The paying account is not the lab. A seat's lab is the model its pane says it runs: herdr's
`display_agent` line for the agent of that name, which the watch keeps from the pane itself. A
Claude Code seat whose line names another lab (`DeepSeek V4.1 Flash default`, `GLM 5.3`) belongs
to that lab, whatever its file's `vendor:` still says; a stale file entry cannot put a DeepSeek
builder under `anthropic`, and it cannot name a lab no seat runs in. Only a seat whose pane gives
no model line falls back to the file's vendor-and-launcher rule, which is also the whole rule for
CLI kinds with no model line of their own. An explicit `account:` still wins the account.

## Screen observations

The watch reads only a running CLI's recognized composer status row. Quota-looking text in the
transcript or input box is not a reading. The supported screen grammars are:

- Codex: the existing `weekly N% left` status cell.
- Grok: `Weekly limit left: N%`, including zero.
- Claude Code: an opt-in status line formatted `L: N% (44m) · W: N% (114h4m)`, where L and W
  are subscription percentages used for the session and weekly windows. This is a constructed,
  tested formatter contract, not a claim about the CLI's default status-line configuration.

Antigravity's screen fixtures do not provide a quota percentage, but its own usage print
(`agy --print /usage`) does, so a team seat on the Antigravity CLI keeps that account readable.
Readable is decided by the CLI kinds the machine's teams declare: a seat's CLI either has a
pattern that names the account, or is a CLI whose own usage print measures it. A shipped quota
profile is the tool's knowledge of a CLI, not a screen — with no seat on that CLI here, nothing
answers for it. An account outside that set and with no recorded figure prints
`unknown  not readable from a CLI screen`, the truth about where its figure could come from,
never a bare `unknown` that reads as a figure not yet seen; the same account with a recorded
machine reading still shows it, because the store is machine-wide and outlives a seat. Readable
accounts without an observation print `unknown`. A lab no screen reads and no reading reached is
not an account row at all in the text face: it is one line `deepseek  not readable from a screen
(11 seats)`, its seat count in place of an `unknown` row that would read as a figure not yet seen.
A lab whose own name is readable keeps its `unknown` row — that is a figure
not yet seen, not one no screen reads.

An undeclared lab is never a hole in the report: its paying seats synthesize one account named
after the lab, printed `unknown` with no window until its first reading, and the quota block
carries that account with the seats behind it. The account's line is readable by the same rule a
declared account's is — it has a seat whose CLI this machine can print a figure for. The file is
therefore only for naming accounts, or for splitting one lab into several. A live reading of an
account no file declares lands the same way: the account takes the lab of that name, else the lab
whose name it starts with when several vendors pay it (`google-antigravity` → `google`), else the
single lab whose paying seats' vendor names it, else its own name. A machine-wide reading (no
seat behind it) lands only on a lab the caller's own seats pay; the owner's view lands it
everywhere. A lab with seats and no declared account and no reading prints its synthesized
account in the quota block with `not known: no reading yet`, while the account table prints the
one seats line: the two faces describe the same lab, and only the table says outright that no
screen reads it.

The watch merges observations into `~/.config/team/usage/readings.json` under a machine lock and
replaces the file atomically. Each record contains account, optional pool, window, left/used
percentages, reset time if known, and observation time. It stores no team name, seat, path or
raw screen text. Different accounts and pools survive concurrent updates. A later observation
refreshes its age even when the percentage stays unchanged. A figure is stored under the account
that measures it, never under the account that pays for the seat: a DeepSeek seat on the Claude
Code CLI prints the Claude subscription's own `L:`/`W:` bar, and that bar is stored as an
Anthropic reading. When the report reads the cache, it shows a figure only under an account some
shipped screen or usage print measures; a record under any other account is ignored, and that
account reads `unknown` rather than showing another subscription's figure.

Machine observations are displayed from first sight. They do not replace the budget gate's
separate confirmation, source-order or reserve rules. Existing team check readings still
participate in the report, and an older machine observation does not replace a newer team
reading. Machine observations older than five minutes or past their reset are marked stale.

## The quota view

With `--tree`, after the account blocks the report prints `quota`: one block per visible lab, one
line per account under it, one line per window, and one `advice:` line. The same advice sentence
also follows the account lines in the default text face: without the flag the text face is the
table and that line, never the table alone; the flag changes no JSON key. The model lives in
`information/quota.ts`; the live readers in `information/quota-observe.ts`; `reportOf` builds the
block from the labs it already shows, so a lab or account this view hides can never reach it.

A window line prints the used and left percentages, the reset (a countdown, `resets not printed`
when the source gave no reset moment, or the words a wall screen showed), the pace in plain words,
and the source with the reading's age. Observations are stamped when
read, and the newest observation per account, pool and window wins. Two sources print no
percentage: the watch's machine cache (`source: machine reading`) and the live readers.

The margin is `expected minus used`, in percentage points: the share of the window that has
already elapsed minus the share spent. The session window is five hours (the length the
Antigravity usage print names as `Five Hour Limit`); the weekly window is seven days. The line
never prints the word: within a band of ten points either way — the same band the advice uses for
headroom and `near cap` — it says `on pace`; a band or more ahead of its clock prints `ahead of
pace by 13.3%`; a band or more behind prints the run-out in hours (below), or `runs out before the
reset` when the source printed the pace but no clock; no clock at all prints `pace not known`. A
status row that prints its own margin — Claude Code's `W: 12% (+13.3%)` — is believed as printed;
otherwise the figure is computed from the reset when it is known and still ahead. A reading older
than five minutes, or one whose reset has passed, prints marked `stale`, carries no pace word, and
its state is `unknown`. States are `walled` (a live wall screen, or 100% used), `near cap` (a
fresh margin at or below −10% — the window is on course to empty before it resets — or, when the
source printed no reset moment so no margin can be read, 90% used or above), `ok` below both, and
`unknown` when nothing fresh is observed. A figure whose source printed no reset says `resets not
printed` in place of a countdown: the source answered the percentage and gave no clock — the Codex
status cell is one, and the reset there lives in the CLI's own status view, which this tool does
not press keys to read. A wall keeps `resets unknown` when its rejection named no lift time,
because that word is about a limit whose end nothing on the screen states. The account table's
`STATE` column prints the same words — the quota view is where the figures come from, not where
the state first appears — and marks a stale reading `stale`. The margin test matters as much as
the used figure: an account 89% used with a −71.6% margin is spending far ahead of its window and
prints `near cap`, not `ok`.

The advice line is built only from what the block already shows. With walls, it names the seats
on each walled account (up to two) and the account with the best fresh margin at or above +10% as
the destination, or says that no other account has headroom. With no walls, each near-cap account
is one action, worst margin first (up to two): the window that made it near cap with its used
figure and its clock in the window line's words (`nearFigureOf`, `nearClock`); the credits answer
when `QuotaOptions.credits` carries the account's figures — `credits <amount> cover the overage`,
or `until they are spent, <amount> short of the monthly cap`; and `or move <seats> off <account>`
with a headroom account as the destination, or `no other account has headroom`. The seats are
`ReportQuotaAccount.seats`, the same list the block prints, so a restricted view never names a
seat it hides; an account with no seat gets the headroom sentence instead. Failing a near cap, it
names the accounts with that headroom. When figures exist but none has headroom and none is near
cap, it says so; when nothing has answered, it says that. A
fresh figure whose source printed no reset, so that no margin can be read, is named with where
its clock is printed — the CLI's own status view — appended to whichever sentence the line
carries; a window whose row printed its own margin needs no such route, and a walled account's
advice is the move, not an errand for a clock. A restricted caller's advice can only name accounts
and seats the restricted view already shows: another team's seats are counted
(`+N on another team`), never named.

The live readers are observable only, and none opens a credential, key or CLI session file:

- the status row of each recorded seat pane, read once through herdr (`paneRead`, the
  classifier's `statusRow`, and the profile quota grammars); a claude-family row's `L`/`W` labels
  are read with their printed margin, which the profile grammar's single parenthesised field
  cannot carry;
- the CLI's own usage command where one exists — `agy --print /usage`, with a 15-second timeout
  and stderr discarded — parsed only in the tab-separated shape a real run produced
  ("Remaining" is the left percentage);
- quota screens: the profile's own rate-limit classifier first, then the phrases `quota reached`,
  `out of usage`, `usage limit reached`, a limit sentence naming its own window or spelling out
  reaching the limit (`Weekly limit reached until …`, `you have reached your weekly limit`), and
  the CLI's 429/403 rejection. The reset may follow `until` as well as `resets`/`try again`. A
  wall is never given an invented percentage; the reset words it printed ride the account's table
  row. A live wall keeps the account's rows (`reportOf`), and the row prints
  `walled  limit reached, resets <time>  read <age> ago`; `quotaOf` carries the same reset and
  age as `wall`, so the tree's account line and the table agree.

An unreadable pane or an unanswered usage command is one counted note (`1 seat pane could not be
read`, `a CLI usage command did not answer`) however many seats hit it, and a pane note carries
the seats it is about (`seats` on `QuotaLive.notes` and on `ReportNote`, printed after the
sentence: `2 seat panes could not be read: coda, lead`). The restricted view reads only the
caller's own team's panes; the full view reads every team's. The machine reading cache is
machine-wide, as the report's own machine lines already are.

A team whose definition cannot be read is one note too, and it names the file the read tried, not
just the team: `projectUsage` puts that path on its block as `unreadableFile`, written to the
note's text as a tilde path for the owner, and to the named-team sentence as a parenthetical
(`the team "team" (~/Code/floor/team): its file could not be read (~/…/team-config/<id>.json).`).
A restricted caller reads this project's own file relative to its root (`.agents/team.yaml`) or
a `~/…` path, never another derived location. Which file that is comes from the failed
`LoadResult`'s `source` mark: `registry` when the record was the definition being read (the
record's own path), `team-file` when the team file was.

## Per-seat figures and spend

With `--tree`, each team's seat table is followed by the seats' own figures, built by `reportOf`
into `teams[].seats` (`information/usage.ts`): one line per window per seat, and one spend line
per seat. A window this run read from the seat's own pane is `measured`, with the status row's
source; a window only the watch's per-seat record answers is `estimated`, source `state record`,
with its age and staleness. The record fills only the windows the live read did not answer, and
stored readings pass the same bound-account filter the report's rows use, so a reading for an
account this team's file does not bind never becomes a seat figure. A seat with no figure in
either source prints `unknown  no reading for this seat`; no percentage is invented.

The spend is read from the seat's own status row, never from a credential or a usage API: the
claude-family row a real 2.1.299 screen drew carries `S: $5.8` beside its bar (`status.test.ts`,
`usage-quota.test.ts`), and `statusCost` reads that dollar figure only from the row the profile's
status patterns recognize, and only for the CLI whose row a capture showed printing money. The
amount is marked `measured` with the surface it was read from and its reading age; a seat whose
screen printed no amount — another CLI, an unread pane, or a recognized row without the field —
reads `unknown` with one sentence, never `0`. Nothing is stored: the spend is a report figure,
read again each run.

The report's cost `source` is the session registry's own word for how an amount was obtained
(`measured` or `estimated` on a recorded session's `cost`; the registry omits a cost it did not
measure and prints that as `unknown`, never zero). A figure both commands carry therefore prints
the same mark in `team sessions` and `team usage`; the report keeps the surface it read in
`readFrom` (`status line`), beside `readAt` and `age`. The registry does not write this figure
yet — the spend is read from the screen, not from a record — so the two agree on the vocabulary,
not on storage.

Every live quota observation and spend is stamped with the herdr session its pane was read in.
`reportOf` attributes a figure to a seat only when the stamps agree (or one side has none), so two
teams' same-named seats never borrow each other's figures; the project's own state record needs no
stamp, because within one project a seat name is one seat.

## Output and privacy

Text and JSON use the same report. `--json` has format 1, a read timestamp, view, caller project,
counts, account rows grouped by lab, the `quota` block, unknown reasons, notes, and `teams` with
each seat's run, its windows (mark, source, reading time, age and staleness) and its cost (the
registry's `source` word, `readFrom`, reading time and age; `why` when unknown). Notes carry
their `count` and, for a pane note, the `seats` it is about. A lab no screen reads and no reading reached also carries its seat count (`seats`),
which the text face prints as one line in place of its rows. Subscription rows carry the window,
left/used percentages, reset countdown and reading age; Antigravity pool rows add `pool`, and a
row whose account the machine file gives a plan also carries `plan` (the text leads with it). A
machine account counts once even with multiple windows or pools. The `quota` block carries
`format: 1`, the accounts file the declaration line points at, one lab per entry with its
accounts, seats, states and windows (each with its source, age, staleness, wall flag and margin),
and the one advice sentence. A team whose file cannot be read is one note naming the team, its
`~` root and the file the read tried in every view; a root outside the home is a derived
location, so it stays the owner's sentence and other callers read the team's name only, and the
file is shown to its owner (or, for another caller, only as `.agents/team.yaml` or a `~/…` path). A team the machine reports as not running
is the counted line instead: `n teams on this machine are not running`, one note whatever the
count, naming no team in either view.

The full view belongs to the owner at a terminal. Every other caller receives the restricted
view: its approved team names and rows, shared machine subscriptions, and anonymized counts or
fixed notes for other teams. Raw state errors and unbound state strings do not cross that
boundary. `--all` does not elevate an agent's permissions.

Seat records are filtered by what is running. A team whose recorded session herdr reports as not
running contributes no seats and no accounts — not even a synthesized one — while a session whose
state cannot be asked leaves the record as it stands; a stopped seat never prints, in either
case. Another team with no live session is a record the report does not list: its problems and
why-lines are history and are not printed, the watch clause never names it, and one counted note
says how many such teams the machine holds; `--all` prints their blocks, each by the name its
store recorded. The caller's own team keeps its own problems and why-lines and is not in that
count, because its block always prints. A live file that cannot be read names no session, so
liveness is asked under the session the store's approved text names — the machine's own copy of
the team as approved — and a recorded text that names none leaves the team alone. The closing
summary counts a synthesized account exactly as a declared one, so a machine
with no `accounts.yaml` counts one account per lab its seats draw on.

`usage` itself is read-only: it runs no check, writes no state, and opens no credential, key or
CLI session file. It reads the seat panes herdr records, and it starts the CLI's own usage print
only for a seat that already runs that CLI, bounded by a timeout. Missing project data is a note
and exit 0. A team whose own file cannot be read is named in its note by the team's name, never
by its path; a team folder that is gone reads as moved, a single sentence. Invalid arguments or an
unreadable store directory return exit 2. A missing or malformed machine reading cache supplies no
figures.
