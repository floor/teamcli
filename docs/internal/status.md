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
and exits 2.

`--file` and `--session` are the owner's. Aimed by anyone else, each is refused before any file
or session is read — `--file is the owner's, from a terminal outside herdr; this call is …`, or
`only the owner runs this, from a terminal outside herdr` for a run with no terminal — and exits 1.

A plain folder's seat runs `team status` from the folder that holds `.agents`. The lookup does
not walk up, and `--file` is the owner's, so a seat in a child folder cannot aim the parent's file.

## Rows

    team beacon, session "beacon"
      claude-keeper  missing  Claude Opus 5.5  -
      claude-beacon  working  Claude Opus 5.5  w1:p1

The columns are the seat, its state, the model, and the pane. The state is what herdr says
(`idle`, `working`, `blocked`…), with `, parked` added for a seat the file parks and `, temporary`
for a temporary one; or `<state> (unsent text)` when an idle or done seat — the two states `team`
types into — holds text in its input box that was never sent; or `<state> (screen not recognised)`
when an idle or done seat's screen is not one its profile reads: herdr's word alone would read a
stall as settled, so the row says what could not be read; or `missing` when the seat is in the
file and nothing is running for it, or when the pane the state recorded for it runs no CLI — the
CLI ended, or the session was restored, and the pane is back at its shell; or `restored, not
launched by team` when its pane runs a process `team` did not launch — another session's restore,
or a CLI started by hand; or `stopped` when the file marks it stopped; or `wrong name`
when an agent sits in the seat's workspace under another name. A `wrong name` row's model is
the one that pane's screen names, or `(unread)` when the screen names none — never the file's.

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
`team doctor` says which seats those are.

The comparison is wrong in the safe direction, but it is wrong: a CLI that replaces its own process
— an updater that re-executes, a wrapper that hands over — changes the foreground pids, and the
seat then reads `restored, not launched by team` although nothing was restored and its conversation
is intact. `up` acts on that reading: it closes the pane without input and launches the seat fresh,
and the conversation in it is lost. No reading of a CLI after its first message was taken when this
record was made; a review's runs of a CLI that starts a helper beside itself and of one behind a
pipeline kept every pid in front, so all of them were recorded. Before running `up` over such a
row — `status` names the seat — the owner looks at the pane: it says whether the CLI there is the
one `team` launched, and `up`'s own guards are in `docs/commands/up.md`.

The model is the seat's `display` when the running model matches the file, and
`<model> <version> (file: <display>)` when it doesn't. A screen that doesn't show the model is a
`note` rather than a difference: `unread` is never wrong.

An approval in force is a note of its own, `approval #1 (2026-10-04), key fe21ef6293de`: the
signing's number, its date and the key's fingerprint — the first twelve hex digits of the key's
public half. An owner who noted the fingerprint sees a *replaced* key; a process that only reads
it changes nothing `team` shows, and `team` computes what it shows.

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
| `<seat> is in the file and is not running` | `team add <seat>` when something else runs, `the owner runs team up` when nothing does |
| `<seat>: its pane runs no CLI (the CLI ended or the session was restored)` | `the owner runs team up` (it closes the pane without input and launches the seat fresh) |
| `<seat>: the process in its pane is not the one team launched; nothing checks its model, account or rules` | `the owner runs team up` (it closes the pane without input and launches the seat fresh) |
| `<seat>: its pane holds a process this record cannot tie to the launch` | `look at the pane`. The row is `restored, not launched by team` and its model is `-`. A screen that names a model adds a note; it is not shown as the model running |
| `<seat> runs <model> <version>; the file says <declared>; the process in its pane is not the one team launched` | `team remove <seat> --keep, then team add <seat>`. A lead is not removed: `team down, then team up` (to restart the whole team). The row stays `-`. `status` does not start the seat |
| `<seat>: its launch line starts a launcher, and the process in its pane is not the one team launched` | the same restart. Said when the launch line starts a program other than the CLI's own binary, or the file says the launcher chooses the model, and the process is not the one `team` launched — including when the stored agent session is still the live one, in which case the row stays the running seat |
| `<seat> runs <model> <version>; the file says <declared>; its launch line starts a launcher; the process in its pane is not the one team launched` | the same restart, when the screen's model is not the file's and the launch line names a launcher |
| `<seat>: the agent in <pane> is named "x"` | `herdr --session <s> agent rename <pane> <seat>` |
| `<seat> runs <model> <version>; the file says <declared>` (`<declared>` is the seat's `display` spelling) | restart it (`team remove <seat> --keep`, then `team add <seat>`), or correct the file and `team approve`. A lead (the orchestrator or the operator) is not removed: `team down`, then `team up` (to restart the whole team), or correct the file and `team approve` |
| `<seat> is marked stopped in the file and is running` | `team remove <seat> --keep`, or take `stopped: true` off the seat |
| `<seat>: waiting for owner (<classification>)` | `the owner runs team up` (it offers to open the pane, skip the seat or stop cleanly), or `team answer <seat> trust` when the classification is `trust` and the policy is `dialogs.trust: orchestrator` |
| `<seat>: trust sent; recovery required` | `the owner runs team up` |
| `<seat>: its launch stopped at "<stage>"` | `the owner runs team up (it resumes the launch)` |
| `<seat>: its rules were not delivered` | `team remove <seat> --keep`, then `team add <seat>` |
| `<seat>: its rules file is missing` / `… is a symbolic link` / `… is not a regular file` / `… has mode 0644, not 0600` / `… is not owned by this user` / `… cannot be read` / `… differs from the approved rules` | `the owner runs team up` — the seat's rules travel in a file in the project state folder, and it no longer holds the approved rules text; `status` never rewrites it |
| `<seat> holds text in its input box that was never sent` | `the owner clears or sends it in the pane; team does not type into a box it can't verify` |
| `<seat> waits at a permission prompt: its owner's to answer` | `the owner answers it in the pane` |
| `<seat>: its launch stopped at "named", and it holds text in its input box that was never sent` | `the owner clears or sends it in the pane, then runs team up (it resumes the launch)` |
| `<name>: a temporary seat is recorded and is not running` | `team remove <name>` |
| `no watch has run for this session` | `team watch --session <s>` |
| `the watch's last pass was <n> minute(s) ago` | `team watch --session <s>` |
| `an unnamed <cli> (w1:p2) is running and is not in the file` | add the seat to the file and `team approve`, or close it |
| `worktree <task>: its setup failed` | `team worktree remove <task>` |
| `the protected checkout "." is on "x", not on "main"` | `the owner switches it back: git -C . switch main` |
| `the file was never approved on this machine` | the owner runs `team approve` |
| `approved before records were signed: run `team approve` once`, or the case a refused record names | the owner runs `team approve` |
| `the file differs from the approved one: <line>` | the owner runs `team approve` |

The one precondition `status` knows and orders is the real one: the file is not the approved one.
That difference is printed first, and a repair that names a command that refuses on an unapproved
file — `team up`, `team add`, `team worktree` — is marked `(after: …)`. Nothing else is reordered
or marked: a missing or stale watch blocks no repair, and what blocks a launch is `team doctor`'s
to report. When at least one repair is the owner's, the summary line reports
`N difference(s), M for the owner`.

## The JSON

`--json` prints the same reading as one document, format 1:

    {
      "format": 1,
      "project": "beacon",
      "session": "beacon",
      "rows": [{ "name": "claude-keeper", "state": "missing", "model": "Claude Opus 5.5", "pane": "-" }],
      "notes": [],
      "differences": [{ "what": "claude-keeper is in the file and is not running", "repair": "team add claude-keeper" }],
      "notice": null
    }

`rows`, `notes` and `differences` hold what the table, the notes and the repairs hold; each seat in
`rows` has `name`, `state`, `model`, `pane`, and, when recorded at workspace creation by a migrated launch,
`start_cwd`. `notice` is the line a normal run prints above the table, or null when there is none. `budgets` is present only
when the budgets table would be printed, one object per row (`account`, `window`, `left`, `used`,
`resetsIn`, `seat`, `age`, `source`, `fallback`, `state`, `inside`, `reserve`). `inside` is true
when a subscription's left figure is at or inside its reserve, `fallback` when the figure did not
come from the first source the account names, and `reserve` the reserve that row was read against —
the same figure the table's line names, null when the account has none. The exit
code is the same as without `--json`, and the file's warnings still go to stderr. A caller who
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

A team file that loads with warnings prints them on stderr as
`team status: warning, line <n>: <message>` and goes on. One warning reads the disk at load
time, not the file's history: the credential scan exempts an absolute path only while it is a
real directory, so a `trust` path whose directory is later removed starts warning on an
unchanged file. That is a true advisory about this machine, not drift.

## Examples, moved here whole

The examples below stood on [the `team status` page](../commands/status.md) before its one-glance
cut, in the order they stood in, and they stand there no longer: the page carries one shorter
example now — the same team file without the `budgets:` account, the implementer up, and the one
difference. None of the examples here is executed by any test — `test/docs.test.ts` reads
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

`--json` prints that reading as one document, for a script to read instead of the table:

```console
$ team status --json ; echo "exit $?"
team status: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
{
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "rows": [
    {
      "name": "claude-keeper",
      "state": "missing",
      "model": "Claude Opus 5.5",
      "pane": "-"
    },
    {
      "name": "claude-beacon",
      "state": "working",
      "model": "Claude Opus 5.5",
      "pane": "w1:p1"
    }
  ],
  "notes": [
    "approval #1 (2026-10-04), key fe21ef6293de"
  ],
  "differences": [
    {
      "what": "claude-keeper is in the file and is not running",
      "repair": "team add claude-keeper"
    }
  ],
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

The repair is the command `add` starts a stopped or missing seat with:

```console
$ team add claude-keeper
claude-keeper: ready
```

Now nothing disagrees:

```console
$ team status ; echo "exit $?"
team status: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
team beacon, session "beacon"
  claude-keeper  idle     Claude Opus 5.5  w2:p1
  claude-beacon  working  Claude Opus 5.5  w1:p1
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: approval #1 (2026-10-04), key fe21ef6293de
0 difference(s)
exit 0
```

The machine's own swap is read for one case only: the check in force — the 2GB default, or the
file's own `swap_free_min` — asks for more free swap than this reading says the machine has in
total. The same fact `doctor` warns about is one note, above the approval note, with both figures
and the repair, in the reading's own words — `would refuse now`, never a promise about a later run;
`--json` carries it in `notes` in the same place:

```console machine="small-swap"
$ team status ; echo "exit $?"
team status: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
team beacon, session "beacon"
  claude-keeper  idle     Claude Opus 5.5  w2:p1
  claude-beacon  working  Claude Opus 5.5  w1:p1
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: the machine check asks for 2.0 GB free swap; at this reading the machine has 1.0 GB in total, so `team up` would refuse now; set `machine.swap_free_min` to a figure this machine can keep, then run `team approve`
note: approval #1 (2026-10-04), key fe21ef6293de
0 difference(s)
exit 0
```

A check that merely fails right now — the machine has the swap in total, and not enough of it
free at this moment — prints no note here: `up`'s refusal names it when the owner runs it, and
the watch reports what it reads. The note above describes the reading it came from: on macOS the
total moves with pressure, so it promises nothing about a later `up`. The total is read on macOS
from `sysctl -n vm.swapusage`, and on Linux from `/proc/meminfo`'s `SwapTotal`; a machine with no
swap at all is not this case, and nothing is said when the total can't be read.
