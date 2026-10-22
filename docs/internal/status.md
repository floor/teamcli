# `team status`: rationale and known limits

What moved off [the `team status` page](../commands/status.md): what the run reads and
writes, who may read the team and what every other caller gets, the rows and what each state
says, the budgets table, the differences and their repairs, the JSON behind `--json`, the
refusals in their own words, and the known limits. The synopsis, the flags, the caller table and
the exit codes stay on the page.

## What the run does: one seat per line, one difference per disagreement

Shows the team as it stands: one line per seat with what the session's herdr shows of it, and one
`difference` for each way the file, the state and the live session disagree. For a seat it changes
nothing. For the owner it records the last file that validated, so a later read can fall back to
that copy when the file breaks. It names the command that repairs each difference.

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store, the session's state
(`.agents/team.state.json`), and herdr: the agents, their panes, their workspaces, and each pane's
visible text, from which the running model is read. It also reads the machine's own swap, for the
one check a reading can show this machine cannot pass. It writes nothing but the `last_valid` copy of
the file it read — and a run that is not the owner's writes nothing at all.

`--project <name>` is the one reading that touches none of that: it reads the project registry
(`~/.config/team/projects.yaml`) and the team records, no team file and no herdr, and writes
nothing.

## Who may run it

The caller decides, not the flags. Three callers get the reading:

- **the owner**, from a terminal outside herdr. An owner **without a terminal** is not this
  caller: a script meets the fixed sentence below;
- **a seat of the team** — placed in the file's session, on the pane the state records for it.
  A seat the state records no pane for, or records on another pane, fails closed;
- **a pane outside the team that the approved file names** in its `delegates` entries. A pane
  only the live file names does not pass.

Anyone else gets one fixed sentence and nothing else, whatever failed underneath — no file, an
invalid one, a file that was never approved, a refused approval:

    team status: this team is not yours to read

The sentence is the whole answer, with or without `--json`: stderr only, stdout empty, exit 2.
It does need herdr to answer once the caller has passed: without it, `status` can't say anything
and exits 2. `--project` is the exception to this gate — anyone may aim it, from any folder, with
no caller check and no herdr.

`--file` and `--session` are the owner's. Aimed by anyone else, each is refused before any file
or session is read — `--file is the owner's, from a terminal outside herdr; this call is …`, or
`only the owner runs this, from a terminal outside herdr` for a run with no terminal — and exits 1.

A plain folder's seat runs `team status` from the folder that holds `.agents`. The lookup does
not walk up, and `--file` is the owner's, so a seat in a child folder cannot aim the parent's file.

## Rows

    team beacon, session "beacon"
      SEAT           STATE    MODEL            PANE   REACH
      claude-keeper  missing  Claude Opus 5.5  -      typed
      claude-beacon  working  Claude Opus 5.5  w1:p1  socket

The columns are the seat, its state, the model, the pane, and the word for the channel a send would
take to reach the seat: `socket` when the file declares it `cli: claude-code` and the pane's own
processes carry a live session socket, `typed` otherwise — another CLI, a pane that is gone, one
herdr could not read. No path opens a cross-session socket directly; `--wait` writes the signed
record through the receiving seat's delivery walk and awaits a reply record on the thread. The word is
read from the processes the comparison already holds, so no extra herdr call is
made. The state is what herdr says (`idle`, `working`, `blocked`…), with `, parked` added for a seat
the file parks and `, temporary`
for a temporary one; or `<state> (unsent text)` when an idle or done seat — the two states `team`
types into — holds text in its input box that was never sent; or `<state> (screen not recognised)`
when an idle or done seat's screen is not one its profile reads: herdr's word alone would read a
stall as settled, so the row says what could not be read; or `missing` when the seat is in the
file and nothing is running for it, or when the pane the state recorded for it runs no CLI — the
CLI ended, or the session was restored, and the pane is back at its shell; or `restored, not
launched by team` when its pane runs a process `team` did not launch — another session's restore,
or a CLI started by hand; or `stopped` when the file marks it stopped; or `wrong name`
when an agent sits in the seat's workspace under another name. A `wrong name` row's model is
the one that pane's screen names, or the seat's declared display marked `(declared, unread)`
when the screen names none.

A pane is its seat only while the process `team` launched is still in it. The state records, for
each seat `up` or `add` launched, the pane's own shell process and the processes the launch left in
front of it — pids only, never a command line. The reading is one `herdr pane process-info` of the
pane, taken once, after the idle prompt appears and after the launch model check: nothing is read
again after a first message. Wherever `status` reads the seat as running, the two are compared:
`same` is the pane team launched, `missing` a pane back at its shell, `restored, not launched by
team` a pane held by another process. The comparison is pids only, and it accepts the seat while
**any** recorded CLI pid is still in front: an extra pid beside them, or another order, changes
nothing. A restored row's model is `-`, never the file's: nothing checks what that process runs.
When that pane's screen names a model, a note names it — `<seat>: its pane runs <model> <version>; that process is not the one team launched` — and the note does not change the exit. A
seat with no `launched` record — a seat launched before this record existed, or one whose process
herdr could not read (the reading is taken once, after the seat's idle prompt; a seat stopped at a
dialog records it in the same write as its waiting record) — is shown as it always was;
`team doctor` says which seats those are. The same gate decides whether a pane's screen is read
as a prompt at all: a dialog left in a shell's scrollback is not a seat waiting at one, for a
declared seat and a temporary seat alike (`paneShowsSeat`).

A replaced pid is not the last word on a pane: an agent session ties a process `team` did not
launch back to the seat, and every reading that asks whether a pane is the seat's asks the same
question the same way (`continuityIdsOf` in `src/registry/resume.ts`). The session is the one the
seat's registry record binds — `reach.agent_session`, taken only when the record names this team,
seat and herdr session and the CLI the file now declares, and when the state names no other
session — and, for a seat no record covers, the copy the state stored with the launch. Where the
record exists and is refused for any reason, no state copy stands in for it. When that session is
the one the pane reports, the row is the ordinary running seat: the conversation came back, the
process did not, and nothing in the reading starts anything. The classification only recognizes;
a resume id is still read from the two records' agreement alone, and a state naming no session
offers none.

The comparison is wrong in the safe direction, but it is wrong: a CLI that replaces its own process
— an updater that re-executes, a wrapper that hands over — changes the foreground pids, and where
nothing ties the pane to the seat's session the seat reads `restored, not launched by team`
although nothing was restored and its conversation is intact. `up` acts on that reading: it closes
the pane without input and launches the seat fresh, and the conversation in it is lost. The
session proof above keeps every CLI that reports its session through such a replacement out of
this case; what is left is a seat whose session no record binds or whose pane reports none. No
reading of a CLI after its first message was taken when this record was made; a review's runs of a
CLI that starts a helper beside itself and of one behind a pipeline kept every pid in front, so
all of them were recorded. Before running `up` over such a row — `status` names the seat — the
owner looks at the pane: it says whether the CLI there is the one `team` launched, and `up`'s own
guards are in `docs/commands/up.md`.

The model is the seat's `display` when the running model matches the file, and
`<model> <version> (file: <display>)` when it doesn't. An effort word alone does not move the
column: the model on the pane is still the file's. A screen that doesn't show the model is a
`note` rather than a difference: `unread` is never wrong. The column shows the seat's declared
display marked `(declared, unread)`: the registry record's declaration when one exists, the file's
or the state's retained one otherwise — with a note naming where the declaration comes from and
that the screen reading is unread. The value is always a declaration, never a reading the screen
confirmed.

A record in force is not a note of its own: the live file is what the commands read, so nothing is
compared against the record and the reading says nothing about it. A file with no record on this
machine is the ordinary file — a machine that never approved it is no difference, and the reading
exits 0 for it. A legacy record, or one the verification refused, is the file's case, in the table
below — the commands a repair may name refuse until the file is in force again.

## Budgets

When the file names an account, or a reading is stored in the state, a `budgets:` table follows
the seats. One row per account and window: what is left and used, when it resets, which seat the
figure came from, how long since it changed, the source it was counted from, and whether it is
fresh, unconfirmed, stale, refusing, or unknown. A row's account is the seat's own: its `account:`
when the file names one, its `vendor` when it doesn't, so one vendor's two accounts are two rows.
A figure inside its reserve says so on that row, including when it is still fresh.
When the counted figure did not come from the first source the account names, the row names the
source it did come from and marks it: `status line (fallback)`.
An old figure with no known reset reads unknown while it could still matter — inside its reserve,
or within the reserve again outside it. Further out — more than the reserve again — it is still
shown, its when column saying `last seen 40m ago`: the room the figure last held.
A named account with no reading is unknown. The table is left out when there is nothing
to show. `status` records no reading; the watch is what records one.

An openai account can take its figure from a check instead of the status line. Copy
`examples/checks/codex-quota` onto `PATH` and name it as that account's `check`, with
`check` listed before `status_line` in `sources`. The script prints the primary
window from the newest local rollout that has a quota figure, opening ten files
at most, and a second line when that event's secondary window is a different
length. For example `weekly 39% used resets 114h4m at 1791091200`. `team`
passes only `PATH` and `HOME`, so `CODEX_HOME` never reaches the script. With a
custom Codex home, install a two-line wrapper that sets it and execs this script,
and name the wrapper as the check:

```sh
#!/bin/sh
CODEX_HOME=/path/to/codex exec /path/to/codex-quota
```

## Differences

A seat the state records waiting shows `waiting for owner (<classification>)` — or
`trust sent; recovery required` — as its row, with its pane, and its one difference stands before
the unnamed and launch-stopped ones. The classification is validated when the state is read,
against the closed list (`trust`, `permission`, `question`, `vendor notice`, `login`, `unknown`,
`unsent`, `timeout`): anything else the file holds reads `unknown` in the row, in the difference
and in the log line the record writes, so a hand-edited or corrupted file can never print its bytes
here.

| Difference | Repair |
| --- | --- |
| `<seat> is in the file and is not running` | `team restart <seat>` when something else runs — the map admits the owner and the team's leads — and `team up` when nothing does (the session is down, so a lead cannot prove its pane; the difference stays the owner's, and its `who:` line says so) |
| `<seat>: its pane runs no CLI (the CLI ended or the session was restored)` | `team up` (it closes the pane without input and launches the seat fresh; the map admits the owner and the team's leads, so `who:` names the team's lead) |
| `<seat>: the process in its pane is not the one team launched; nothing checks its model, account or rules` | `team up` (it closes the pane without input and launches the seat fresh; the map admits the owner and the team's leads, so `who:` names the team's lead) |
| `<seat>: its pane holds a process this record cannot tie to the launch` | `look at the pane`. The row is `restored, not launched by team` and its model is `-`. A screen that names a model adds a note; it is not shown as the model running |
| `<seat> runs <model> <version>; the file says <declared>; the process in its pane is not the one team launched` | `team restart <seat> --abandon` for a seat that is not a lead while herdr still names that seat on the pane the state recorded (its `who:` line names the team's lead), and `look at the pane` where it does not — the flag is what takes a process a plain restart leaves in place. A lead's own seat draws a note with no difference, in the same words — a lead is never restarted alone, and the whole-team restart is not this repair. The row stays `-`. `status` does not start the seat |
| `<seat>: its launch line starts a launcher, and the process in its pane is not the one team launched` | `team restart <seat>` for a seat that is not a lead (its `who:` line names the team's lead) while the stored agent session still ties the pane to the seat; where nothing ties it, `team restart <seat> --abandon` while herdr still names the seat on the recorded pane, and `look at the pane` where it does not. A lead's own seat draws a note with no difference: `<seat>: started by a launcher; team cannot tell its process from the one it launched` — a lead is never restarted alone, and the whole-team restart is not this repair. Said when the launch line starts a program other than the CLI's own binary, or the file says the launcher chooses the model, and the process is not the one `team` launched — including when the stored agent session is still the live one, in which case the row stays the running seat |
| `<seat> runs <model> <version>; the file says <declared>; its launch line starts a launcher; the process in its pane is not the one team launched` | `team restart <seat> --abandon` for a seat that is not a lead while herdr still names that seat on the pane the state recorded (its `who:` line names the team's lead), `look at the pane` where it does not. A lead's own seat draws a note with no difference, in the same words as the difference — a lead is never restarted alone, and the whole-team restart is not this repair. Said when the screen's model is not the file's and the launch line names a launcher |
| `<seat>: the agent in <pane> is named "x"` | `herdr --session <s> agent rename <pane> <seat>` |
| `<seat>: running <model> <version> <effort>, file says <declared> <effort>` — the model not matching the file (each side printing its effort word only when it has one; `<declared>` is the seat's `display` spelling); or `<seat>: effort <seen>, file says <effort>` when the model matches and an effort word the pane printed differs from the seat's declared `effort` (when the file declares no effort, a seen word is not a drift, and a pane that printed none leaves the file's word standing) | `restart the seat on the file's model (<command>), or correct the file`. `<command>` is `team remove <seat> --keep, then team add <seat>`, or, for a lead, `team down, then team up` (to restart the whole team) |
| `<seat> is marked stopped in the file and is running` | `team remove <seat> --keep`, or take `stopped: true` off the seat |
| `<seat>: unknown for over <threshold> — blind, and it counts as not working` | `the owner looks at the pane`. One per seat no source has heard from past the blind threshold — 5m shipped, declared as `state_blind_after_seconds`, tightened by every level and opened again only by a project — and the same reading [`team seats`](../commands/seats.md) prints as `unknown (blind)` beside its source |
| `<seat>: waiting for owner (<classification>)` | `team up` (it offers to open the pane, skip the seat or stop cleanly; `who:` names the team's lead), or `team answer <seat> trust` when the classification is `trust` and a `dialogs.trust` grant is in force for this project's team id (read fresh on every run) |
| `<seat>: trust sent; recovery required` | `team up` (the map admits the owner and the team's leads, so `who:` names the team's lead) |
| `<seat>: its launch stopped at "<stage>"` | `team up (it resumes the launch)` — the map admits the owner and the team's leads, so `who:` names the team's lead, and a lead repairs a relaunch that did not reach ready |
| `<seat>: its rules were not delivered` | `team remove <seat> --keep`, then `team add <seat>` |
| `<seat>: its rules file is missing` / `… is a symbolic link` / `… is not a regular file` / `… has mode 0644, not 0600` / `… is not owned by this user` / `… cannot be read` / `… differs from the team file's rules` | `team reload <seat>` — the seat's rules travel in a file in the project state folder, and it no longer holds the rules text the live file gives it; `status` never rewrites it |
| `<seat> holds text in its input box that was never sent` | `the owner clears or sends it in the pane; team does not type into a box it can't verify` |
| `<seat> waits at a permission prompt: its lead's to answer, or its owner's` | `its lead answers it in the pane` |
| `<seat> waits at a trust prompt: the owner's to answer` | `the owner answers it in the pane` |
| `<seat>: its launch stopped at "named", and it holds text in its input box that was never sent` | `clear or send it in the pane, then team up (it resumes the launch)` (the map admits the owner and the team's leads, so `who:` names the team's lead) |
| `<name>: a temporary seat is recorded and is not running` | `team remove <name>` |
| `no watch has run for this session` | `team watch --session <s>` |
| `the watch's last pass was <n> minutes ago` | `team watch --session <s>` |
| `an unnamed <cli> (w1:p2) is running and is not in the file` | add the seat to the file, or close it |
| `worktree <task>: its setup failed` | `team worktree remove <task>` |
| `the protected checkout "." is on "x", not on "main"` | `the owner switches it back: git -C . switch main` |
| `approved before records were signed`, or the case a refused record names | `the live file is what the commands read` |

The one precondition `status` knows and orders is the real one: the record is legacy, or the
verification refused it. That difference is printed first, and a repair that names a command that
refuses while the record is not in force — `team up`, `team add`, `team restart`, `team worktree`
— is marked
`(after: …)`. Nothing else is reordered or marked: a missing or stale watch blocks no repair, and
what blocks a launch is `team doctor`'s
to report. When at least one repair is the owner's, the summary line reports
`N difference` / `N differences, M for the owner` (and `no differences` when `N === 0`).

The reading stops at its count: the `what 0.5.0 must not pretend:` block and its first line live on
`team --about` and `team doctor`, not on every status read; `team doctor` prints the whole block
under its summary, and `team check` no longer quotes it at the end of a run.

## The JSON

`--json` prints the same reading as one `team.status` v1 document, its `schema` tag first:

    {
      "schema": { "name": "team.status", "version": 1 },
      "format": 1,
      "project": "beacon",
      "session": "beacon",
      "rows": [{ "name": "claude-keeper", "state": "missing", "model": "Claude Opus 5.5", "pane": "-", "seat_state": "done", "seat_state_source": "process" }],
      "notes": [],
      "differences": [{ "what": "claude-keeper is in the file and is not running", "repair": "team restart claude-keeper", "who": "the team's lead" }],
      "summary": { "differences": 1, "owner_differences": 0 },
      "notice": null
    }

`rows`, `notes` and `differences` hold what the table, the notes and the repairs hold; each seat in
`rows` has `name`, `state` — the comparison's phrase about the record, the meaning it always
published — `seat_state` and `seat_state_source` (the seat's own reading, the table's STATE and
SOURCE columns, on every row whether `--all` is given or not, with `blind: true` only where it
applies), `model`, `pane`, and, when recorded at workspace creation by a migrated launch,
`start_cwd`. With `--all` a row also carries the registry's own fields — the seat's `id`, `role`,
`cli`, `effort`, `last_active` and `launch_line`. `notice` is the line a normal run prints above the table, or null when there is none. `budgets` is present only
when the budgets table would be printed, one object per row (`account`, `window`, `left`, `used`,
`resetsIn`, `seat`, `age`, `source`, `fallback`, `state`, `inside`, `reserve`). `inside` is true
when a subscription's left figure is at or inside its reserve, `fallback` when the figure did not
come from the first source the account names, and `reserve` the reserve that row was read against —
the same figure the table's line names, null when the account has none. `swaps` is present only
when the project waits on a queued model swap ([team swap](../commands/swap.md)): one `{ seat, swap }`
entry per queue record, in seat order, the record exactly as the state holds it. `summary` counts the
differences (`differences`, `owner_differences`), the plain closing line's own
figures. The exit code is the same as without `--json`; the file's own warnings are `team
doctor`'s to print, never this document's. A caller who
may not read the team gets the fixed sentence on stderr and nothing on stdout, with or without
`--json`: not a JSON document.

## Refusals

| Message | Exit |
| --- | --- |
| `team status: unexpected "x"` (with the usage) | 2 |
| `team status: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team status: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team status: only the owner runs this, from a terminal outside herdr` — a run with no terminal aiming either flag; judged before the caller gate, so it is this line and not the fixed sentence below | 1 |
| `team status: this team is not yours to read` | 2 |
| `team status: team.yaml line <n>: <message>` | 2 |
| `team status: herdr doesn't answer; is it installed and running?` | 2 |

`status` prints no warning the team file loads with — the `coordinator:` notice included: a
file's own warnings are `team doctor`'s to report, as `warn` findings. One of them reads the
disk rather than the file's history: the credential scan exempts an absolute path only while it
is a real directory, so a `trust` path whose directory is later removed starts warning on an
unchanged file. That is a true advisory about this machine, not drift, and it is said in
`doctor`, not here.

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
team file, the fixture and the first console are also on [the `team status` page](../commands/status.md);
the rest stand only in this note and are not executed by any test — `test/docs.test.ts` reads
`docs/commands/` alone.

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
team beacon, session "beacon"
  SEAT           STATE    MODEL            PANE   REACH
  claude-keeper  missing  Claude Opus 5.5  -      typed
  claude-beacon  working  Claude Opus 5.5  w1:p1  socket
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
difference: claude-keeper is in the file and is not running
  repair: team restart claude-keeper
  who: the team's lead
1 difference
exit 1
```

`--json` prints that reading as one `team.status` v1 document, for a script to read instead of
the table:

```console
$ team status --json ; echo "exit $?"
{
  "schema": {
    "name": "team.status",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "rows": [
    {
      "name": "claude-keeper",
      "state": "missing",
      "model": "Claude Opus 5.5",
      "pane": "-",
      "seat_state": "done",
      "seat_state_source": "process"
    },
    {
      "name": "claude-beacon",
      "state": "working",
      "model": "Claude Opus 5.5",
      "pane": "w1:p1",
      "seat_state": "working",
      "seat_state_source": "cli"
    }
  ],
  "notes": [],
  "differences": [
    {
      "what": "claude-keeper is in the file and is not running",
      "repair": "team restart claude-keeper"
    }
  ],
  "summary": {
    "differences": 1,
    "owner_differences": 0
  },
  "notice": null,
  "budgets": [
    {
      "account": "openai",
      "window": "session",
      "left": 40,
      "used": 60,
      "resetsIn": "44m",
      "seat": null,
      "age": "2m",
      "source": "check",
      "fallback": false,
      "state": "fresh",
      "inside": false,
      "reserve": 20
    },
    {
      "account": "openai",
      "window": "daily",
      "left": 70,
      "used": 30,
      "resetsIn": null,
      "seat": "claude-beacon",
      "age": "40m",
      "source": "status_line",
      "fallback": true,
      "state": "stale",
      "inside": false,
      "reserve": 20
    },
    {
      "account": "openai",
      "window": "weekly",
      "left": 5,
      "used": 95,
      "resetsIn": "44m",
      "seat": "claude-beacon",
      "age": "2m",
      "source": "status_line",
      "fallback": true,
      "state": "fresh",
      "inside": true,
      "reserve": 20
    }
  ]
}
exit 1
```

The repair names `restart`, the command that starts a seat the file lists and no pane holds:

```console
$ team restart claude-keeper
team restart: restarted claude-keeper; pane none -> w2:p1
```

Now nothing disagrees:

```console
$ team status ; echo "exit $?"
team beacon, session "beacon"
  SEAT           STATE    MODEL            PANE   REACH
  claude-keeper  idle     Claude Opus 5.5  w2:p1  typed
  claude-beacon  working  Claude Opus 5.5  w1:p1  socket
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
no differences
exit 0
```

The machine's own swap is read for one case only: the check in force — the 2GB default, or the
file's own `swap_free_min` — asks for more free swap than this reading says the machine has in
total. The same fact `doctor` warns about is one note, with both figures and the repair, in the
reading's own words — `cannot meet it`, never a promise about a later run; `--json` carries it
in `notes` in the same place:

```console machine="small-swap"
$ team status ; echo "exit $?"
team beacon, session "beacon"
  SEAT           STATE    MODEL            PANE   REACH
  claude-keeper  idle     Claude Opus 5.5  w2:p1  typed
  claude-beacon  working  Claude Opus 5.5  w1:p1  socket
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: the machine check asks for 2.0 GB free swap; at this reading the machine has 1.0 GB in total, so this reading cannot meet it; set `machine.swap_free_min` to a figure this machine can keep
no differences
exit 0
```

A check that merely fails right now — the machine has the swap in total, and not enough of it
free at this moment — prints no note here: the watch reports what it reads. The note above
describes the reading it came from: on macOS the total moves with pressure, so it promises
nothing about a later reading. The total is read on macOS from `sysctl -n vm.swapusage`, and on
Linux from `/proc/meminfo`'s `SwapTotal`; a machine with no swap at all is not this case, and
nothing is said when the total can't be read.
