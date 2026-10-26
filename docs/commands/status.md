# team status

Shows the team as it stands: one line per seat with what the session's herdr shows of it, and one
`difference` for each way the file, the state and the live session disagree, each naming the command
that repairs it. It changes nothing but the owner's `last_valid` copy of the file it read; a run that
is not the owner's writes nothing at all.

A row's state is herdr's word, with up to one reading the screen adds: a quiet seat holding text
in its input box reads `(unsent text)`, a quiet seat on a screen its profile cannot read reads
`(screen not recognised)`, and a quiet seat stopped on its provider's usage limit reads `(rate
limit on <account>, resets at <time>)` — the pool the seat spends, its own `account:` or its
vendor when it names none, and the reset the screen gives when it gives one.

For a seat whose profile says herdr cannot report it (`herdr_status: unreliable`), the word is
the screen's instead of herdr's: the idle table, or a box holding text, reads `idle`; a running
turn reads `working`; any other screen the profile reads reads `blocked`; and a screen the
profile cannot read keeps herdr's `unknown`, with the note that names herdr's word. The same
reading decides the quiet a mark above needs, and `team check` and the watch take their state and
attention from it too.

A seat's model is the one its screen names, checked against the file's. A screen that names none
is a note, never a difference: the column shows the seat's declared display marked
`(declared, unread)` — the registry record's declaration when one exists, otherwise the file's or
the state's retained one — so the value is never presented as a reading the screen confirmed.

A pane that no longer holds the process `team` launched is not by itself a difference: when a
program `team` did not launch is in front and the agent session the seat's records bind — its
registry record where one exists, the copy stored with its launch where none does — is the
session the pane reports now — a herdr restart brings the pane back under a new shell pid — the
row is the ordinary one. The two records must agree: a record for another team, seat, CLI or
herdr session, or a state naming another session than the record, binds nothing, and a state's
copy never overrules a record it disagrees with. Otherwise a pane with no CLI left reads `missing`
(the CLI ended, or a restore left the shell in front) and a pane fronted by any other program
reads `restored, not launched by team`; both carry a difference, and the second's model is `-`,
never the file's.

That pane is not silent, though: when the seat's launch line starts a launcher — a program other
than the CLI's own binary, or a file that says the launcher chooses the model — a seat that is
not a lead adds a difference of its own, `<seat>: its launch line starts a launcher, and the
process in its pane is not the one team launched`, repaired with `team restart <seat>` while that
session still ties the pane to the seat; the row stays the one the live session gives it. A
lead's own seat is never restarted alone, so its line is a note and not a difference: `<seat>:
started by a launcher; team cannot tell its process from the one it launched`, with no command
that stops the team. And a pane nothing ties is repaired the same way — `team restart <seat>
--abandon` for a seat that is not a lead while herdr still names that seat on the pane the state
recorded, `look at the pane` where it does not, and, for a lead's own seat, a note naming what the
pane runs and no difference at all — when its screen names a model the file does not carry, or
its launch line starts a launcher; a pane it can say nothing about is repaired by looking at it.
The flag is named in the repair, never assumed: a plain restart only leaves that pane as it is,
and `--abandon` is what takes the process in front. Nothing either report says starts a seat.

A seat no source has heard from past the blind threshold — five minutes shipped, tightened by the
machine, an entity, a project, the team or the seat, and opened again only by a project — counts
as not working, in the check and
in the status alike: the run adds the owner's difference `<seat>: unknown for over <threshold> —
blind, and it counts as not working`, repaired with the owner's look at the pane, and
[`team seats`](seats.md) prints the reading itself as `unknown (blind)` beside the source it was
read from. The `--json` documents carry the same reading on each row: `state` and `state_source`
in [`team seats --json`](seats.md), and `seat_state` and `seat_state_source` in this command's —
`state` here keeps the meaning it published, the comparison's phrase about the record — with
`blind: true` on a row only where it applies.

A process a seat recorded with `team proc add` shows too: one `note:` line per live record —
`proc <name>: <by> since <at>`, with `, pid <n>` when one is recorded — printed after the other
notes. A record whose process has ended is not printed, and a team that recorded none shows no
such line. `--json` carries the same reading as a `procs` array, absent when there is none.

A swap the project waits on ([team swap](swap.md)) is one `note:` line of its own, in seat order:
`swap <seat>: <from> -> <to> (<reason>), queued <instant>, waits for <what>, runs by <instant>` —
the same line `team swap` prints for the record, so the reading says what each seat waits on
before the swap runs. `--json` carries the records as a `swaps` array of `{ "seat": …, "swap": … }`,
absent when nothing waits.

The watch the state records is one `note:` of its own, before the proc notes: `watch: pane <pane>,
pid <n>, last heartbeat <age>` — where it runs, whose process it is once a pass has recorded one
(`pid not recorded yet` in the moment between `up` and that first pass, `pane not recorded` for a
watch that has not seen itself in a pane), and how old its last heartbeat is. When every seat is
running and that heartbeat is older than two in-force intervals, the reading also carries the
difference `the watch's last pass was <n> minutes ago`, repaired with `team watch --session
<session>`, which starts the watch in its workspace again.

A watch the machine daemon hosts is a different watch from that one, and the reading says it after
the daemon's own line: `watch: in daemon, last cycle <age>` for a watch whose last pass completed,
with the age the record gives it and never a borrowed one, and `watch: in daemon, not yet cycled`
while no pass has completed. The phases say themselves: `watch: starting in the daemon, not yet
cycled`, `watch: stopping in the daemon`, `watch: stopped in the daemon (<reason>)` and `watch:
failed in the daemon (<reason>)`, with `no reason recorded` where the record gives none. A watch
standing down for a live pane watch reads `watch: standing by; a live pane watch owns this session
(<reason>)`: it leaves that session to the pane watch and touches nothing there. A watch whose
outbound effects are closed adds `watch: outbound effects blocked (no verified admitted sender is
injected); it is not enforcing anything` — it can cycle while those effects are closed, and the
reading never prints it as enforcing. The phase line says how old the last pass is, not whether it
failed; the check names a failed pass. A stopped or failed watch is terminal in the record: nothing
here restarts it, and the daemon does not bring it back by itself, so it runs again only when it is
started again. A route the daemon records no watch for prints no such line: a watch exists only
where one was started on purpose. With more than one watched route, each line ends with its route,
`… (<root>)`, so a failed route still reads beside a good one. These lines are notes: never a
difference, never in a total, never an exit.

## A leftover team file

When the team is in the registry and a `.agents/team.yaml` is still in the project, the run
prints one note — `.agents/team.yaml is still in this project, and is no longer read (the team is
in the registry): run team migrate to move it to the Trash` — and neither refuses nor counts it.
A leftover that says something else than the registry is a difference, with `team import` as the
repair.

## Synopsis

    team status [--session <name>] [--file <path>] [--project <name>] [--all] [--json]
    team status --client <grant-file> --key <client-key> [--team <team>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's |
| `--project` | `<name>` | cover the project the name holds — its teams, read from the registry — instead of one team's reading; anyone may aim it, from any folder |
| `--all` | — | render the expanded seat registry columns (`SEAT`, `NICKNAME`, `ID`, `ROLE`, `CLI`, `MODEL`, `EFFORT`, `STATUS`, `STATE`, `SOURCE`, `LAST ACTIVE`, `PANE`); those expanded columns print in the table under `--all` alone, while every `--json` row carries the seat's own reading as `seat_state` and `seat_state_source` either way |
| `--client` | `<grant-file>` | the client form: an owner-signed bundle grant that carries `status`, see [A client's status](#a-clients-status) |
| `--key` | `<client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team` | `<team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | — | the same reading as one JSON document instead of the table, the notes and the repairs |
| `--help`, `-h` | — | the usage, and exit 0 |

## A client's status

A client with no terminal that the owner signed a bundle grant for (`team grant --client <id>
--team <team> --bundle observer` or `operator`, see
[Client grant bundles](../concepts/client-grant-bundles.md)) reads one team's status with

    team status --client ~/.config/team/grants/cg_<24 hex>.json --key ~/.config/team-client/<id>/client.key

The grant must carry `status` in its signed `allowed_ops`; one that does not is refused, and so is
any other team or folder than the one signed. The run is never the owner's whatever terminal it
stands in: `--file`, `--session`, `--project` and `--all` are refused with `--client`, and the one
write of an owner's run (the `last_valid` copy) is not made. The team file is not compared with
the one the owner signed: a file edit does not end a grant's status. Each run writes
`client-status-authorized: grant <cg_id> client <client-id> team <project> root <root> request
<rid>` to `<root>/.agents/team.log`, or `client-status-refused: …` after the key proved who the
client is. A refusal is `status.client-refused` (exit 1). The exit is otherwise the status's own:
0 when the session agrees with the file, 1 when it differs.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | read the team, and aim the read with `--file` and `--session` |
| a seat of the team, placed in the file's session, on the pane the state records for it | read the team; a seat the state records no pane for, or records on another pane, fails closed |
| a pane outside the team that the live file names in its `delegates` entries | read the team; a pane newly named by the live file also passes |
| anyone else, an owner's run without a terminal included | nothing: the fixed sentence `team status: this team is not yours to read` on stderr, stdout empty, exit 2 |

`--file` and `--session` aimed by anyone else are refused before any file or session is read —
`--file is the owner's, from a terminal outside herdr; this call is …`, or `only the owner runs
this, from a terminal outside herdr` for a run with no terminal — and exit 1. And herdr has to
answer once the caller has passed the gate: without it, `status` can't say anything and exits 2.

`--project` is the exception to that gate: it reads the project level, out of the registry — no
team file, no herdr, no caller check — the way [team projects](projects.md) reads. `--session`
and `--file` name one team's readings and do not apply beside it: aiming them together is the
invocation refusal, exit 2.

## Output and exit codes

When `watch.queue_dir` names the team's queue directory, a `queues:` section lists the depth
for each seat. Each queue is `<seat>.md`: top-level numbered entries and unchecked Markdown
tasks count as work; checked tasks, nested details and fenced examples do not. Missing,
unreadable, non-file or larger-than-1-MiB queues read `unknown`, not zero.

The section closes with the directory's backlog file, `linear-backlog.md`, as `backlog: <n>
unclaimed`: its top-level numbered items that are unchecked and carry no `claimed:` or `done:`
marker, in their own text or in the text under them. A missing or unreadable backlog file reads
`backlog: unknown`, never zero. JSON rows carry the depth as `queue_depth` (a number or `null`)
and the document carries the backlog count as `queue_backlog`; both fields are absent when
queues are not configured.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| no difference | the seats table, the `budgets:` table when the file names an account or a reading is stored, one `note:` line per note, then `no differences` | 0 |
| at least one difference | the same, then one `difference:` line with its `  repair:` and `  who:` lines under it per difference, and the count: `1 difference`, or `2 differences, 1 for the owner` when a repair is the owner's | 1 |
| a flag the caller may not aim | the refusal every command gives it | 1 |
| `--project` with a name no project holds | `team status: no project named "<name>"; nothing to show` | 1 |
| `--project` covering a project | the project's name, id, entity and lead, then one line per team: its session, lifecycle and seat count, or `not registered` for a team no record holds | 0 |
| the invocation or the team file can't be read, herdr doesn't answer, or the caller may not read this team | `team status: <problem>`, `team status: herdr doesn't answer; is it installed and running?`, or the one fixed sentence | 2 |

`--json` prints the reading as one document and nothing else, with the same exit code; a caller
who may not read the team gets the fixed sentence and no document.

A hold on the team ([team hold](hold.md)) is the first `note:` the reading prints — `hold: <reason>`,
or `hold until <instant>: <reason>` — and `--json` carries the same record as the document's
top-level `hold` while it stands. A hold past its `until` reads as none: neither the note nor the
document carries one that has lapsed.

Every line the table prints is cleaned first: escape sequences, control characters and invisible
format characters carried by the team file, the state, a pane or herdr are removed, and the columns
are padded on the cleaned text, so a value can never move the cursor, paint the terminal or open a
second line. `--json` is the one text not cleaned: the document carries each string as it was read,
escaped where JSON requires it, for a parser rather than a terminal.

Every row of the seats table ends with the word for the channel a send would take to reach that
seat: `socket` while the file declares the seat `cli: claude-code` and the pane's own processes
carry a live session socket, and `typed` otherwise — another CLI, a pane that is gone, one herdr
could not read. No path opens a cross-session socket directly; `--wait` writes the signed record
through the receiving seat's delivery walk and awaits a reply record on the thread. The word
is read from the processes the comparison already holds, so no extra herdr call is made; only the
socket file itself is looked up on disk. `--json` rows carry no such word: `reach` is the plain
table's alone.

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
team beacon, session "beacon"
  SEAT           STATE    MODEL            PANE   REACH
  claude-keeper  missing  Claude Opus 5.5  -      typed
  claude-beacon  working  Claude Opus 5.5  w1:p1  typed
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: watch: pane w9:p1, pid 4242, last heartbeat 0s ago
difference: claude-keeper is in the file and is not running
  repair: team restart claude-keeper
  who: the team's lead
1 difference
exit 1
```

Each difference names both the repair command (`repair:`) and the role that runs it (`who:`).
The `what 0.5.0 must not pretend:` block and its first line live on
`team --about` and [`team doctor`](doctor.md), not on every status read.

`--project` covers the teams the registry lists under a project, wherever they run. A team no
record holds reads as `not registered`; `--json` prints the project record and each team's
reading as one document instead:

```yaml file=../../.config/team/projects.yaml
projects:
  beacon:
    name: Beacon
    entity: acme
    lead: null
    teams: ["7a8b9c0d1e2f", "3d4e5f607182"]
    provenance: { registered_by: team, registered_at: "2026-10-05T04:00:00.000Z", updated_at: "2026-10-05T04:00:00.000Z" }
```

```console
$ team status --project Beacon ; echo "exit $?"
project Beacon  beacon  entity acme  lead -
  7a8b9c0d1e2f  not registered
  3d4e5f607182  not registered
exit 0
$ team status --project nope ; echo "exit $?"
team status: no project named "nope"; nothing to show
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/status.md](../internal/status.md).
