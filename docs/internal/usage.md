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
separate; unknown models have no inferred pool.

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

Antigravity's screen fixtures do not provide a quota percentage. Accounts without a supported
screen grammar or a recorded figure print `unknown  not readable from a CLI screen`. Readable
accounts without an observation print `unknown`. A lab no screen reads and no reading reached is
not an account row at all in the text face: it is one line `deepseek  not readable from a screen
(11 seats)`, its seat count in place of an `unknown` row that would read as a figure not yet seen
(Atlas, 2026-10-17). A lab whose own name is readable keeps its `unknown` row — that is a figure
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
table and that line, never the table alone (Atlas, 2026-10-17); the flag changes no JSON key. The model lives in
`information/quota.ts`; the live readers in `information/quota-observe.ts`; `reportOf` builds the
block from the labs it already shows, so a lab or account this view hides can never reach it.

A window line prints the used and left percentages, the reset (a countdown, or the words a wall
screen showed), the margin, and the source with the reading's age. Observations are stamped when
read, and the newest observation per account, pool and window wins. Two sources print no
percentage: the watch's machine cache (`source: machine reading`) and the live readers.

The margin is `expected minus used`, in percentage points: the share of the window that has
already elapsed minus the share spent. The session window is five hours (the length the
Antigravity usage print names as `Five Hour Limit`); the weekly window is seven days. A status row
that prints its own margin — Claude Code's `W: 12% (+13.3%)` — is believed as printed; otherwise
the figure is computed from the reset when it is known and still ahead. A reading older than five
minutes, or one whose reset has passed, prints marked `stale`, carries no margin, and its state
is `unknown`. States are `walled` (a live wall screen, or 100% used), `near cap` (90% used or
above, or a fresh margin at or below −50%), `ok` below both, and `unknown` when nothing fresh is
observed. The account table's `STATE` column prints the same words — the quota view is where the
figures come from, not where the state first appears — and marks a stale reading `stale`. The
margin test matters as much as the used figure: an account 89% used with a −71.6% margin is
spending far ahead of its window and prints `near cap`, not `ok`.

The advice line is built only from what the block already shows. With walls, it names the seats
on each walled account (up to two) and the account with the best fresh margin at or above +10% as
the destination, or says that no other account has headroom. With no walls, it names the
near-cap accounts, worst margin first (up to two), with a headroom account as the destination when
one exists; failing a near cap, it names the accounts with that headroom. When figures exist but
none has headroom and none is near cap, it says so; when nothing has answered, it says that. A restricted caller's advice can only name accounts and seats the restricted view
already shows: another team's seats are counted (`+N on another team`), never named.

The live readers are observable only, and none opens a credential, key or CLI session file:

- the status row of each recorded seat pane, read once through herdr (`paneRead`, the
  classifier's `statusRow`, and the profile quota grammars); a claude-family row's `L`/`W` labels
  are read with their printed margin, which the profile grammar's single parenthesised field
  cannot carry;
- the CLI's own usage command where one exists — `agy --print /usage`, with a 15-second timeout
  and stderr discarded — parsed only in the tab-separated shape a real run produced
  ("Remaining" is the left percentage);
- quota screens: the profile's own rate-limit classifier first, then the phrases `quota reached`,
  `out of usage`, `usage limit reached`, and the CLI's 429/403 rejection. A wall is never given an
  invented percentage; the reset words it printed ride the account's table row.

An unreadable pane or an unanswered usage command is one counted note (`1 seat pane could not be
read`, `a CLI usage command did not answer`) however many seats hit it. The restricted view reads
only the caller's own team's panes; the full view reads every team's. The machine reading cache is
machine-wide, as the report's own machine lines already are.

## Output and privacy

Text and JSON use the same report. `--json` has format 1, a read timestamp, view, caller project,
counts, account rows grouped by lab, the `quota` block, unknown reasons, notes, and `teams` with
seat mappings. A lab no screen reads and no reading reached also carries its seat count (`seats`),
which the text face prints as one line in place of its rows. Subscription rows carry the window,
left/used percentages, reset countdown and reading age; Antigravity pool rows add `pool`. A
machine account counts once even with multiple windows or pools. The `quota` block carries
`format: 1`, the accounts file the declaration line points at, one lab per entry with its
accounts, seats, states and windows (each with its source, age, staleness, wall flag and margin),
and the one advice sentence. A team whose file cannot be read is one note: the owner's names the
team and its `~` root, every other caller's names the team only.

The full view belongs to the owner at a terminal. Every other caller receives the restricted
view: its approved team names and rows, shared machine subscriptions, and anonymized counts or
fixed notes for other teams. Raw state errors and unbound state strings do not cross that
boundary. `--all` does not elevate an agent's permissions.

Seat records are filtered by what is running. A team whose recorded session herdr reports as not
running contributes no seats and no accounts — not even a synthesized one — while a session whose
state cannot be asked leaves the record as it stands; a stopped seat never prints, in either
case. The closing summary counts a synthesized account exactly as a declared one, so a machine
with no `accounts.yaml` counts one account per lab its seats draw on.

`usage` itself is read-only: it runs no check, writes no state, and opens no credential, key or
CLI session file. It reads the seat panes herdr records, and it starts the CLI's own usage print
only for a seat that already runs that CLI, bounded by a timeout. Missing project data is a note
and exit 0. A team whose own file cannot be read is named in its note by the team's name, never
by its path; a team folder that is gone reads as moved, a single sentence. Invalid arguments or an
unreadable store directory return exit 2. A missing or malformed machine reading cache supplies no
figures.
