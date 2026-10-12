# `team usage`: rationale and known limits

What moved off [the `team usage` page](../commands/usage.md): what the run reads and
writes, the two views and how the caller is placed, the report's lines, what the restricted view
carries, the JSON behind `--json`, the refusals in their own words, and the known limits. The
synopsis, the flag, the caller table and the exit codes stay on the page.

## What the run does: the machine's teams, read as one report

Shows what this machine holds: every team with an approval store here, read as one report — each
team's accounts and windows, with what is left and used, when each figure was last read and from
which source. The caller's own project is one of those teams, whether or not it holds a store, and
it is resolved from the current folder the way every command resolves it. Anyone may run it, from
anywhere. It only reads: it writes nothing anywhere — no `last_valid` copy, no log line, no lock,
no state — it runs no check and launches no CLI, and it reads no pane; it never opens a CLI's
session file or a lab's credential; it reads TeamCLI's own key only to verify the agreement, as
`status` does.

Two views are printed from the one placement of the caller: the owner **at a terminal** reads the
full view — every team named, every root carried, every team's rows — and every other caller reads
the restricted one. The restricted view is the default, and what it carries is a closed list, built
once before anything prints; this page documents its shape.

## What it reads and writes

Reads this machine's approval store folder — one team per store, each store's own record naming the
folder its project lives in — and then, for each of those teams and for the caller's own project,
the team file at that root (`.agents/team.yaml`), the state beside it (`.agents/team.state.json`)
and the record that verifies the agreement, with the signing key. One store whose own record cannot
be read counts in the machine's teams and reads the fixed sentence `a store on this machine cannot
be read: the owner reads the reason`, never a refusal for the rest; the stores folder itself
unreadable is the one refusal (below). A root two stores record — a rename keeps the old folder —
is one team, and the first store in name order stands for it.

It writes **nothing at all**: unlike `status`, it keeps no `last_valid` copy of the files it read,
and unlike `up`, `add` and `watch` it opens no lock, writes no state and logs no line.

Which file's figures are in force is the approval's rule, the one `status` states: a file the owner
approved whose `budgets` section is the approved one is read as it stands; a file whose `budgets`
section differs is answered from the copy the approval stored, and one why-line says the file
differs; a file never approved on this machine has no budgets in force at all, and says so:

    the file was never approved on this machine: run `team approve`
    the file differs from the approved one: `budgets` changed

A file that does not load, or cannot be read, cannot be resolved as the caller's own project — a
caller who is not the owner reads no block of their own for it, the machine's counts and one fixed
sentence per distinct line (`note: .agents/team.yaml does not load (line 4): run team status for the
reason`) in their place — while the owner reads the loader's own messages and the figures the
approval stored. When the caller's own project is resolved but no copy in force can be read, the
block carries no name and no row: `note: no figures (the file could not be read)` and
`note: the approved copy of the team file cannot be read: nothing is shown by name` stand for them.

## Who may run it, and which view they read

Anyone: a seat, an unplaced agent, or the owner, from any folder. It needs no approval of its own —
it reports on the one in force, and changes nothing about it. Who is asking is placed before
anything prints, the way `status` places it (`status.ts:138`): from the caller's parent processes —
on macOS one `ps` per parent, on Linux the `/proc` table — never from the environment.

One function decides the view, once (`viewFor`, `information/usage.ts`), and every line below — the
text and `--json` alike — is rendered from the one report it builds:

- The owner **at a terminal** reads the **full view**: every team named, every root carried, every
  team's own rows, every problem in the words its own read produced.
- Every other caller reads the **restricted view**.

That comparison is deliberate, and it is fail-closed: a process that double-forks out of the herdr
tree walks to no herdr ancestor and is placed as the owner without a terminal (`owner-no-tty`) —
the placement a forged ancestry would produce; a caller the walk places as the owner without a
terminal is nevertheless admitted to launch seats by `mayLaunchSeats`. While the walk cannot tell a
real detached owner from a detached stranger, every caller but the owner at a terminal reads the
restricted view, a detached owner's own runs included; the day placement is trustworthy, this one
comparison flips and nothing else changes. The per-team widening field (`owner | seats`) is not
read by this build: a team's route to the full view is not built yet.

## The report

    usage on this machine, 1 team, 2 labs, 1 account

The header counts the machine: every team the walk read — a store whose record cannot be read is
one of them — every lab any team's file puts in use (a lab in use with no account declared for it
yet is one), and every account any file declares or any state holds a reading for. The counts are
whole-machine in both views, whatever the caller's own team turns out to carry; the blocks under
them are not: the restricted view renders the labs the caller's own team carries, and a lab only
other teams put in use is counted and renders for the owner alone. Every block is a lab and its
accounts, in lab name order; an account belongs to the lab its own team's rule gives it — the
vendor of the first seat that spends it, else the account's own name — and one account keeps one
lab whoever else maps it.

Under a lab, one line per account and window, grouping every team's own row for that window:

    openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh

The figure is the newest counted reading of that account and window on this machine, whichever team
took it, and the line is `status`'s own row shape (`budgetLine`) except for where the figure came
from and how the line closes:

- The caller's own team's reading prints as its own seat and moment — `scout  changed 4m ago`, or
  `-` where no seat is recorded.
- Another team's reads `read by another team, 4m ago` in the restricted view and `read by <team>,
  4m ago` in the full one. On equal moments the caller's own team stands first, so a machine line
  says least about another team when the figure could be the caller's.
- A reader whose team's watch is not recording is told so in a closing clause: `(no watch is
  recording for <project>)` for the caller's own team, `(no watch is recording for it)` for another
  team's reading the restricted view cannot name, and `(not known whether a watch is recording)`
  when that team's state cannot be read. A watch that is recording is not announced.
- A line with nothing counted for it reads `unknown` and carries no figure. A figure inside its
  reserve says `inside reserve 20%`, and a figure that did not come from the first source its
  account names is `status line (fallback)` — the same two marks `status` prints.
- A line with a figure ends it with the pace the figure is moving at — `pace 5.3%/h`, the used
  points per hour the window's last two readings measure, one decimal and signed — or with `pace
  not known` where there is no pair to measure. The rows carry the word too. A spend line, a
  spend account's row, and a machine line with nothing counted for it carry no word at all. A
  restricted machine line whose newest figure is another team's carries none either: that pace is
  that team's, withheld rather than unknown, and nothing stands in its place — the line passes
  straight from its state to its watch clause.

Pace is read from the pair the state keeps and nothing else: the reading before this one, its
figure and the moment it moved (the point the watch writes beside a reading whenever one was in
the state before it). It is
the difference of the two figures over the hours between their moments, one decimal, signed — a
window filling back up reads below zero, and a figure that did not move across its pair reads
`pace 0.0%/h`. It reads `pace not known` where the state holds no usable pair: a reading stored
before the point was written, a point whose reading is older than the section's `stale_after`, a
pair whose two moments are the same, and a window whose reset changed since the pair was taken.
Pace is a passenger — it moves no figure, no state, no mark and no other command's table, and
`status`, the gate and the watch print the same with it or without it.

Ages are exact in both views — `2m`, `40m`, `1h30m` — the moment a reader can compute the figure's
age from; no view rounds them.

Under each line come that account's rows: the caller's own team's only in the restricted view,
every team's in the full one. A row repeats the line's own fields — what is left and used, when it
resets, the seat the figure came from, how long ago, its source and its state — after its team's
name where `status` writes the indentation:

    beacon  daily  left 70%  used 30%  resets unknown  claude-keeper  last seen 40m ago  status line (fallback)  stale

`status line (fallback)` marks a figure that did not come from the first source its account names,
`inside reserve 20%` a figure inside its reserve, and `last seen` a stale figure with no known
reset: the same words, from the same table, that `status` prints.

A row prints only while the reading behind it is bound: its account must be one the team's file in
force names — a budget account, or the account a seat in force's own `account:`/`vendor:` resolves
to — and its window and source must be ones this tool writes: `session`, `daily`, `weekly`; `check`,
`status_line`. One that is not is not rendered at all, and one fixed line per kind says so, under
the caller's own block:

    note: a stored reading names an account this team's file does not: not shown
    note: a stored reading carries a window or source this tool does not write: not shown

The team in force is the approved copy once a verified approval is in force, never the live file: a
name only the live file writes — a `vendor:` edited after approval, a seat it added — binds no
stored reading, and the standing's own why-line already says the file differs. A copy that cannot
be read binds nothing at all: no block of the caller's own carries a row, the figures of its budgets
included, and the one line

    note: the approved copy of the team file cannot be read: nothing is shown by name

stands for them — `mine` is null in `--json`, and the watch clause names `it` rather than any
project, since the name too is that copy's.

An account nothing can read carries the tool's own why-line under its rows — `doctor`'s and the
gate's own words, never a message a read produced:

      (beacon: no pattern can read this account)

one of `no pattern can read this account`, `its check is unapproved; that account reads unknown`,
`first sight only, not yet counted` (`doctor.ts:154`, `:192`, `gate.ts:90`). A why prints only under
an account that reads `unknown` everywhere in the report: an account whose newest counted reading is
another team's says nothing about the team whose own pattern cannot read it. The restricted view
prints another team's why as `(another team: …)` when the account is one the caller's own file
names.

A file that names no account gets the tool's own sentence in the same place — `not known: this
team's file declares no account, so nothing is counted` — and a file whose budgets are not the ones
in force gets the why-line `status` prints for that standing: the one above for a file never
approved, the legacy record's repair line, or the one that says the file differs from the approved
copy and names the section — `budgets`. Those are why-lines, not refusals: the exit is 0 either
way.

A lab whose accounts the caller's own file does not name is counted, never named or given a figure:

    anthropic: 2 other accounts

and a lab with nothing declared for it yet says so:

    anthropic  not known (no team declares an account for it yet)

## What the restricted view carries

The restricted view is a closed list of fields, built once by `reportOf`
(`information/usage.ts`) before either renderer runs and rendered by the one renderer both views
share, so the text and `--json` can never disagree. Nothing a read of another team produced crosses
it: no name, no root, no path, no message. Specifically, it never carries

- another team's **name** — a machine line's team, a row's, a note's scope (`read by another team`,
  `another team: …`) — nor another team's **root**, which is a path this tool derived from the
  machine;
- another team's **rows**: only the caller's own team's rows print under a machine line;
- another team's **pace**: a machine line whose newest reading is another team's carries no pace
  element at all — `null` in `--json`, absent from the text — so a withheld figure never reads as
  a failed computation, while the caller's own rows keep their pace;
- another team's **problems in their own words**: a store's own message becomes the fixed sentence
  `a store on this machine cannot be read: the owner reads the reason`, and a team's problem becomes
  one fixed sentence per kind, counted;
- the **seat** on another team's machine line (a seat name is the caller's own team's material);
- and any **figure of an account the caller's own file does not name** — such an account is counted
  in the lab's `others` and never given a line, a figure or a why.

Five things the design called droppable are carried **on purpose**, and each is one field with its
own test:

- the machine's **counts** (`counts`): one team's machine and four teams' machines are different
  situations, and the count of teams is not a name;
- whether a line's figure is the caller's own or another team's (`machine.other`; in the text, the
  words `read by another team`) and the **age** it was read at (`machine.age`) — the reader decides
  on the figure, so the reader is told what it is;
- the **watch clause** (`machine.watch`): a reader deciding off a figure needs to know whether a
  watch is refreshing it;
- the **count** on an anonymized note (`notes[].count`, `2 teams' states cannot be read …`): one
  team's problem and four teams' problems are different situations;
- the **full age** — `2m`, not `a few minutes ago`: the moment is what the figure's age is computed
  from, and rounding it would take a decision away from the reader.

What else the restricted view prints of the caller's own team is its own: the project name from the
copy in force (a live `project:` edit after approval is not shown), the loader's problems as fixed
sentences, the state's own reason with this project's own path relative to its root, and the
`note:` lines above. A file that does not load reads, one note per distinct line,

    note: .agents/team.yaml does not load (line 4): run team status for the reason

a file that cannot be read reads `.agents/team.yaml cannot be read: the owner reads the reason`, and
a state that cannot be read reads the tool's own reason with the project's own relative path
(`.agents/team.state.json is not valid JSON; move it aside and run the command again`). A refused
approval — a record in the store that does not verify for this project — reads one fixed sentence
in place of the store's own words, which carry absolute paths:

    note: the approval on this machine does not verify for this project: the owner runs `team approve`

## The JSON

`--json` prints the same report as one document, format 1, for a script to read. No field is left
out: every key below is printed in both views — the page's Examples section has the whole document,
as the command prints it.

- `format` is 1; `at` is the moment of the read, so a script can compute every `age` against it;
  `view` is `full` or `restricted`; `mine` is the caller's own project, or null outside any project
  (and null when the copy in force that names it cannot be read).
- `counts` is the header's three numbers — `teams`, `labs`, `accounts`.
- `labs` is the blocks, in the same order: one entry per lab, `accounts` holding one entry per
  machine line. A subscription entry carries `account`, `kind`, `machine` (the line's own fields:
  `window`, `left`, `used`, `resetsIn`, `changedAt`, `age`, `source`, `fallback`, `state`, `inside`,
  `reserve`, `other`, and `watch` when the clause prints) and `teams`, one entry per row under the
  line — the team it belongs to as this caller reads it, and `row`, which is `status --json`'s own
  row object under `budgets`. A spend entry carries the money instead of a window (`amount`,
  `currency`, `at`, `age`, `source`, `state`). A subscription line's `seat` is present for the
  caller's own team's line and left out of another team's in the restricted view; the full view
  carries every team's. A spend line has no seat — its reading is a check's, and a check belongs
  to no seat. `labs[].others`, when present, is the count of accounts in that lab
  the caller's own file does not name, and it is present only when there is at least one.
- `unknown` is the why-lines, each with the `scope` it printed under — the caller's own project's
  name, or `another`.
- `notes` is the `note:` lines, each with its `scope`, and a `count` when the line stands for more
  than one team (or more than one store) — `count` is present only when it is more than one.

The full view is the same document with the names allowed in: `team` on every machine line, `root`
on every row entry, every team's rows, every lab, and each note named per team. The restricted
document is exactly this shape, and a field added later to a team's own reading reaches neither
renderer until it is added to the report's own types.

## Refusals

| Message | Exit |
| --- | --- |
| `team usage: <the parser's own error>`, with the usage | 2 |
| `team usage: the store folder cannot be read: the owner reads the reason` | 2 |

Everything else — no file here, a file that does not load, a state that cannot be read, another
team's store unreadable — is a note line and exit 0. The command runs no check, opens no pane and
calls no CLI, so nothing else can refuse it. The second line is the stores folder itself
unreadable; it is the command's one refusal beside the invocation, and the owner reads the folder
and the read's own reason in its place (`team usage: the store folder <folder> could not be read:
<why>`) — that message carries a path this machine derived, so it is the owner's.

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first console is also on [the `team usage` page](../commands/usage.md); the rest run only here,
and their order and their output matter only here.

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
account for it yet. Run from the seat's own pane, the report is the restricted view:

```console
$ team usage ; echo "exit $?"
usage on this machine, 1 team, 2 labs, 1 account

anthropic  not known (no team declares an account for it yet)
openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known
  beacon    session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known
exit 0
```

`--json` prints the same report as one document. Every figure carries the moment behind it
(`changedAt`), and the top-level `at` is the read's own, so a script can compute the age of every
figure itself:

```console
$ team usage --json ; echo "exit $?"
{
  "format": 1,
  "at": "2026-10-04T09:00:00.000Z",
  "view": "restricted",
  "mine": "beacon",
  "counts": {
    "teams": 1,
    "labs": 2,
    "accounts": 1
  },
  "labs": [
    {
      "lab": "anthropic",
      "accounts": []
    },
    {
      "lab": "openai",
      "accounts": [
        {
          "account": "openai",
          "kind": "subscription",
          "machine": {
            "window": "session",
            "left": 40,
            "used": 60,
            "resetsIn": "44m",
            "changedAt": "2026-10-04T08:58:00.000Z",
            "age": "2m",
            "source": "check",
            "fallback": false,
            "state": "fresh",
            "inside": false,
            "reserve": 20,
            "pace": null,
            "other": false,
            "seat": null
          },
          "teams": [
            {
              "team": "beacon",
              "row": {
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
                "reserve": 20,
                "pace": null
              }
            }
          ]
        }
      ]
    }
  ],
  "unknown": [],
  "notes": []
}
exit 0
```

The same command run by the owner at a terminal prints the same text on this one-team machine — the
two faces differ in the text only when another team's names are allowed in — and `--json` with
`"view": "full"`, `"team": "beacon"` on every machine line and `"root": "."` on every row.

A machine that holds other teams reads the same header, with their teams counted and their labs
counted where the caller's own team carries them: an account their files declare and the caller's
does not is counted in the lab's `others` (`anthropic: 2 other accounts`) and never given a line, a
figure or a why; a machine line whose newest figure is theirs reads `read by another team, 2m ago`;
and whatever their reads could not answer is one fixed sentence per kind, counted
(`note: 2 teams' states cannot be read (not valid JSON; move it aside and run the command again)`).
Nothing a read of theirs produced crosses — no name, no root, no path, no message — and that is the
whole of what this page's restricted sections promise.
