# team approve

The owner approves the team file: reads it, shows what changed since the last approval, and writes
the record this machine holds it to. By default it asks nothing — the summary is the last thing
printed and the write follows it; `--confirm` brings back the question for the number of seats.
Every command that starts, moves or changes a team checks that record first, so an edit to the file
needs a new approval before it can run. `--show` prints the same comparison and stops, writing
nothing. The owner's write comes only from a real terminal, and refuses, before writing, when
input is already waiting on the terminal its own standard input is attached to — the rest of a
pasted block, which must not be left to approve on its own — and when that terminal cannot be
read to make the check. A delegate's write comes from the pane the file names, under the gate
below: an ordinary change — the roster, a rule — passes it, any other owner section never does.

## Synopsis

    team approve [--show] [--confirm] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), its validation, and, when there is one, the approved
copy this machine holds. It also reads `overrides.yaml` in that same store, when the owner has one.
Writes the approval record — the team file and the override file, as approved — and the ledger of
every seat the team has had here — both in the store, `~/.config/team/<project>-<hash>` — and one
line in `.agents/team.log`. The record is signed, and signing moves this project's counter in
`~/.config/team-key`, a folder of its own beside the store. `--show` writes nothing.

## Who may run it

The owner, from a terminal outside herdr, approves anything. The approved delegate may approve
too: the pane a `delegates` entry names, with `approve` among its commands, placed exactly where
the approved file puts it — the gate reads the pane, never the name a seat is given, and every
other caller is refused with `only the owner or the approved delegate approves a team file`.

A delegate's approval is for ordinary changes: the roster — seats and the launch lines that place
them — and `rules`. The guard is an allowlist, and it is fail-closed: `rules` is the only owner
section it admits, and every other one is refused by default — `delegates` first, and `budgets`,
`limits`, identity, `trust`, the workspace whose `setup` runs commands, the operator and
orchestrator sections, and any section a later version adds — with
`this change needs the owner: <what changed>`. The orchestrator's seat may approve that same
ordinary class when the approved `grant` lists `approve`. The run is this folder's own file:
`--file` is refused before a different path is read, the first approval stays the owner's, and
a change to any owner section — `grant` included — stays the owner's. The ceiling counts: adding or taking out a
seat on a file that declares no `limits` moves the default ceiling with it — `limits` changed —
so that roster edit is the owner's, while the same edit on a file whose ceiling is declared
leaves `limits` alone and is the delegate's, or the granted seat's. The difference is judged against the approved
copy alone, before anything else is read, so a delegate can never widen its own grant, raise a
ceiling, hand a seat the verdict over the team, point `setup` at a command, or add a folder the
owner did not trust: the widened value is never signed, and the owner is the only caller who
can approve it. A delegated run that signs prints the same `Approved.` sentence and writes one
audit line, below. `--show` may be run by anyone, in any terminal.

## Flags

| Flag | Meaning |
| --- | --- |
| `--show` | print the comparison, ceilings and seats, and stop; change nothing |
| `--confirm` | ask for the number of seats before writing, as approve used to |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

With no record on this machine, the whole file, numbered, so the owner reads exactly what is being
approved. With a record, a line per changed section or seat against the approved copy:

    + 6: trust:
    + 7:   - .

    Needs a new approval: `trust` changed.

Nothing at all changed is said plainly:

    ./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

    Nothing in it needs a new approval.

Then the ceilings the approval would fix — `3 seats at most, 2 temporary` — and the
seat names — and, when the file has a `delegates` section, one `Delegate: pane <pane> may run
<commands>.` line per entry, in file order — and the signing's number for this
project on this machine, with the date of the last one and the key's fingerprint: `approval #4
for this project; the last one was on 2026-10-04; key fe21ef6293de.` With `--confirm` the
question comes next, before the write; without it the summary is the last thing printed and the
write follows directly. The seat ceiling defaults
to the seats the file declares plus the
temporary ones, so adding a seat widens it, and that shows up as `limits` changed too. What needs a
new approval is a change to an owner section
(`trust`, `limits`, `machine`, `rules`, `identity`, `workspace`, `orchestrator`, `operator`,
`session`, `visibility`, `tools`, `budgets`, `watch` — its timings included, down to `watch.checks`,
whose turn-offs are their own line — and `delegates`, its entries, their panes and their command
lists included) or to a seat's own fields. A seat taken out does not.
Parking or stopping one does, except that `remove --keep` and `add` record the new digest
themselves, so those commands do not send the owner back to `approve`. Until an edit is
approved its section changes nothing: the watch, the budget reports, the check cadence, `up`'s and
`add`'s launch gate and `status`'s table run with the approved values, or with the defaults when
nothing was approved. A stored copy that no longer validates: `budgets` falls back to no accounts (no
budget reports, no check runs) and the difference is reported until the next approve; `up` and `add`
refuse a drifted file before the gate.

## A delegated approval

A delegated run prints the same summary, passes the same key guards and performs the same write as
the owner's: the same record, the same signature, the same store. What it does not have is the
question — `--confirm` is inert for a delegate, nothing is asked on any terminal, and the audit
line, not an answer, is its record. `--file` is refused: a delegate approves the placed
`.agents/team.yaml`, and nothing else. When the gate passes, the write appends one line to
`.agents/team.log` naming the pane and what the approval sealed:

    2026-10-07T12:00:00.000Z delegate [delegate] other/w1:p1 approve: `rules` changed

The gate verifies the standing approval, the approved copy and the evidence — the state, `herdr`'s
answers, the placement — before it lets a delegate run, and refuses with its own text when any of
them fails: `delegation needs a verified approval: <what is not in force>`,
`delegation needs a readable approved copy: run \`team approve\``, or `delegation cannot verify its
placement or seats: <why>`. Every refusal writes nothing: the record, the log and the key are
untouched.

## Refusals

| Message | Exit |
| --- | --- |
| `team approve: unexpected "x"` (with the usage) | 2 |
| `team approve: line <n>: <message>` / `team approve: <message>` | 2 |
| `team approve: the approval store <store> is inside <folder>, where seats work` | 1 |
| `team approve: only the owner approves a team file, from a terminal outside herdr; this call is <caller>` (no `delegates` section) | 1 |
| `team approve: only the owner or the approved delegate approves a team file; this call is <caller>` | 1 |
| `team approve: this change needs the owner: <what changed>` (an owner section that is not `rules`) | 1 |
| `team approve: --file is the owner's; the approved delegate cannot use it` | 1 |
| `team approve: delegation needs a verified approval: <what is not in force>` / `delegation needs a readable approved copy: run \`team approve\`` / `delegation cannot verify its placement or seats: <why>` / `the approved delegate must be an external non-seat pane` / `the approved delegate <pane> may not run \`approve\`; its approved commands are <commands>` | 1 |
| `team approve: input was waiting on the terminal: run \`team approve\` on its own line` | 1 |
| `team approve: the terminal this call runs on could not be read to check for input waiting on it; nothing was written` | 1 |
| `team approve: not approved; nothing was written` (`--confirm`) | 1 |

A file that loads with warnings prints them on stderr as
`team approve: warning, line <n>: <message>` and goes on. The last refusal is what `--confirm`'s
answer gets when it is not the number of seats: a blank answer, a wrong one, and a closed terminal
are all the same answer.

The two input refusals are the default path's. The check reads the terminal this call's own standard
input is attached to — never `/dev/tty`, which is not that terminal when the command runs without a
controlling one. It reads once, up to 4096 bytes: a terminal with nothing queued answers `EAGAIN`
and the run goes on; a complete line waiting there is taken as a pasted block's remainder and
refuses the call, and the read consumes that line — which is why the refusal says to run the
command by itself. Cooked mode, the default, makes only complete lines (Enter included) visible, so
a partial line typed without Enter is not seen; raw mode makes every byte already typed visible, and
the read takes up to 4096 of them. A terminal that cannot be found or read at all refuses with the
second message rather than approving blind. Either way the check looks at one moment: input that
arrives after the check and before the write is not seen.

## Exit codes

- `0` — approved, or `--show` printed the comparison and stopped before anything was written.
- `1` — refused: a seat ran it, the store sits where seats work, input was waiting on the terminal,
  the terminal could not be read to check for input waiting, or (`--confirm`) the answer was not the
  number of seats. Also every delegated refusal: a caller that is not the approved pane, a change
  that needs the owner, `--file`, or anything the gate could not verify. Nothing is written.
- `2` — the invocation, the team file or the file's validation is bad.

## The signed record

The record this command writes is signed. The key and one counter per project live outside the
store, in a folder of their own — `~/.config/team-key` (the folder 700, its files 600) — created at
the first approval on that machine. The signature covers the whole record: the approval, the stored
copy of the file, the project root it approves, and the counter's number. Every reader — `up`,
`add`, `worktree`, `watch`, `status`, `doctor`, `init --restore` — verifies the whole record through
one snapshot; a record that was changed after approval, was signed for another root, or is older
than the counter says is not an approval, and the command that needs one refuses, naming the case
and the repair.

The root the record names is the project folder's real path — symlinks resolved by the
filesystem, a trailing slash gone — and the store's name carries its hash, so two spellings of
one folder are one project. Nothing is normalised silently: two Unicode spellings the platform's
own realpath keeps apart are two roots with two stores, and what the platform does with them is
the platform's doing, not undone here.

The record's shape is strict, and checked whole before anything is built from it: a field this
version does not know is refused naming its path (`"fingerprints.<name>"`,
`"checks.<account>"`), and so is a missing or wrongly-typed one. A record that is not whole
JSON, or breaks its shape anywhere, is refused with a line that says what is wrong — never a
crash. A record that carries a signature or a generation but says `format: 1` is refused as
contradictory, not read as legacy; the `format` field sits inside the signed bytes, so it cannot
be flipped outside the signature.

The key is written whole or not at all: a temporary file of mode 600 in the same folder, then
linked into place — `link` never overwrites, so the first writer wins, and two first approvals
that race end with the one key both then use. A key file that is torn, empty or not a team key
is never regenerated over: every command that needs it refuses with the repair — restore it
from a copy — because a new key would orphan every record already signed.

Each signing moves the project's counter, and the line after the seat names names it, with the
signing key's short fingerprint: `approval #4 for this project; the last one was on 2026-10-04;
key fe21ef6293de.` The fingerprint is the first twelve hex digits of the key's public half;
`team doctor` and `team status` show the same three — the number, its date, the key. An
amendment — `add` starting a stopped seat, `remove --keep` parking one — is a signing too, and
moves the counter like an approval.

Approvals guard against mistakes, not against a hostile process running as the owner. The
signature refuses a record changed by something that does not use the key — a hand edit to the
store, a record carried over from another project. A process that can read the key can re-sign
any record at the number it already had, and nothing `team` shows will differ; the counter says
what `team` wrote, never every signing that ever happened. What a *replaced* key does change is
the fingerprint: an owner who noted it sees the swap. That is evidence, not prevention — `team`
computes the fingerprint, and a seat can replace `team` itself.

A record written by an earlier `team`, before records were signed, is not trusted. The commands
that need an approval in force (`up`, `add`, `worktree`, `init --restore`) refuse with `approved
before records were signed: run \`team approve\` once`, while the watch keeps watching, `status`
keeps reporting and `down` and `remove` keep working. Approving once replaces it with a signed
record.

## Examples

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
```

```fixture
approved: false
```

The first run shows the whole file, because this machine has no copy of it to compare against:

```console
$ team approve --show ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: never approved on this machine. The whole file:

  1: format: 1
  2: project: beacon
  3: coordinator: claude-keeper
  4: operator: claude-keeper
  5:
  6: trust:
  7:   - ~/.config/team/lobby
  8:   - ~/Code/beacon
  9:
  10: workspace:
  11:   mode: shared
  12:
  13: seats:
  14:   - role: coordinator
  15:     name: claude-keeper
  16:     label: coordinator
  17:     cli: claude-code
  18:     vendor: anthropic
  19:     model: Claude Opus
  20:     version: "5.5"
  21:     launch: claude --model claude-opus-5-5

Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
approval #1 for this project; key fe21ef6293de.
Owner-authorization fingerprint: 4d72c10c02a010e7edf90c95317f2236802f1951b4d8d3f43fbcdf4c11277b6d
exit 0
```

The owner approves it — no question by default:

```console
$ team approve
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: never approved on this machine. The whole file:

  1: format: 1
  2: project: beacon
  3: coordinator: claude-keeper
  4: operator: claude-keeper
  5:
  6: trust:
  7:   - ~/.config/team/lobby
  8:   - ~/Code/beacon
  9:
  10: workspace:
  11:   mode: shared
  12:
  13: seats:
  14:   - role: coordinator
  15:     name: claude-keeper
  16:     label: coordinator
  17:     cli: claude-code
  18:     vendor: anthropic
  19:     model: Claude Opus
  20:     version: "5.5"
  21:     launch: claude --model claude-opus-5-5

Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
approval #1 for this project; key fe21ef6293de.
Owner-authorization fingerprint: 4d72c10c02a010e7edf90c95317f2236802f1951b4d8d3f43fbcdf4c11277b6d
Approved. The record is in ~/.config/team/beacon-<hash>; signed with key fe21ef6293de; check the rest with `team doctor`.
```

A seat can read the comparison — even the orchestrator's — but a seat is not the owner, and nothing is
written for it:

```console caller=claude-keeper
$ team approve ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

Nothing in it needs a new approval.
Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
approval #2 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 4d72c10c02a010e7edf90c95317f2236802f1951b4d8d3f43fbcdf4c11277b6d
team approve: only the owner approves a team file, from a terminal outside herdr; this call is claude-keeper
exit 1
```

An owner section is the owner's to change, and the comparison says so before the write:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon
  - ~/Code/worktrees/beacon

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
```

```console
$ team approve --show ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 9:   - ~/Code/worktrees/beacon

Needs a new approval: `trust` changed.
Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
approval #2 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 8cd9f8b6c145b912717ea320a1efd28e4b9c496dde0c9674bbcc6e2c7362ddd0
exit 0
```

A new seat needs one too — a seat already approved may be taken out without bothering the owner.
Parking or stopping one needs an approval, unless `remove --keep` or `add` wrote the mark and
recorded the digest. A seat the file never had is not approved:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon
  - ~/Code/worktrees/beacon

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
```

`--confirm` asks, and a wrong answer writes nothing:

```console answer="1"
$ team approve --confirm ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 9:   - ~/Code/worktrees/beacon
  + 23:   - role: implementer
  + 24:     name: claude-beacon
  + 25:     label: implementer
  + 26:     cli: claude-code
  + 27:     vendor: anthropic
  + 28:     model: Claude Opus
  + 29:     version: "5.5"
  + 30:     launch: claude --model claude-opus-5-5

Needs a new approval: `trust` changed; `limits` changed; seat claude-beacon is not in the approved file.
Ceilings approved: 3 seats at most, 2 temporary.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
approval #2 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 5d59b3e9b25cc131d0200014782f1aa2d84bdfe701655b8a4115d844a603593c

Type the number of seats (2) to approve this file, and its commands and rules, to run: 1
team approve: not approved; nothing was written
exit 1
```

The same protection without `--confirm`: a line already waiting on the terminal — the rest of a
pasted block — makes the run refuse before anything is written:

```console waiting="1"
$ team approve ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 9:   - ~/Code/worktrees/beacon
  + 23:   - role: implementer
  + 24:     name: claude-beacon
  + 25:     label: implementer
  + 26:     cli: claude-code
  + 27:     vendor: anthropic
  + 28:     model: Claude Opus
  + 29:     version: "5.5"
  + 30:     launch: claude --model claude-opus-5-5

Needs a new approval: `trust` changed; `limits` changed; seat claude-beacon is not in the approved file.
Ceilings approved: 3 seats at most, 2 temporary.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
approval #2 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 5d59b3e9b25cc131d0200014782f1aa2d84bdfe701655b8a4115d844a603593c
team approve: input was waiting on the terminal: run `team approve` on its own line
exit 1
```

A terminal the check cannot read refuses as well, saying which failure it was, and writes nothing:

```console waiting="unreadable"
$ team approve ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 9:   - ~/Code/worktrees/beacon
  + 23:   - role: implementer
  + 24:     name: claude-beacon
  + 25:     label: implementer
  + 26:     cli: claude-code
  + 27:     vendor: anthropic
  + 28:     model: Claude Opus
  + 29:     version: "5.5"
  + 30:     launch: claude --model claude-opus-5-5

Needs a new approval: `trust` changed; `limits` changed; seat claude-beacon is not in the approved file.
Ceilings approved: 3 seats at most, 2 temporary.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
approval #2 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 5d59b3e9b25cc131d0200014782f1aa2d84bdfe701655b8a4115d844a603593c
team approve: the terminal this call runs on could not be read to check for input waiting on it; nothing was written
exit 1
```

With `--confirm`, the answer is the number of seats, and nothing else — here, two:

```console answer="2"
$ team approve --confirm
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 9:   - ~/Code/worktrees/beacon
  + 23:   - role: implementer
  + 24:     name: claude-beacon
  + 25:     label: implementer
  + 26:     cli: claude-code
  + 27:     vendor: anthropic
  + 28:     model: Claude Opus
  + 29:     version: "5.5"
  + 30:     launch: claude --model claude-opus-5-5

Needs a new approval: `trust` changed; `limits` changed; seat claude-beacon is not in the approved file.
Ceilings approved: 3 seats at most, 2 temporary.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
approval #2 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 5d59b3e9b25cc131d0200014782f1aa2d84bdfe701655b8a4115d844a603593c

Type the number of seats (2) to approve this file, and its commands and rules, to run: 2
Approved. The record is in ~/.config/team/beacon-<hash>; signed with key fe21ef6293de; check the rest with `team doctor`.
```

The same file again is the same text as the approved copy, and the approval stands:

```console
$ team approve --show ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

Nothing in it needs a new approval.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
approval #3 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 5d59b3e9b25cc131d0200014782f1aa2d84bdfe701655b8a4115d844a603593c
exit 0
```

## The overrides file

`overrides.yaml` lives in the approval store, beside the record. It may add dialog patterns
(`unknown`, `trust`, `permission`, `question`) and `quota` patterns to a profile this version
ships, and nothing else: not a composer, a prompt, a footer, a launch line, a stage order, a
case flag, a fold, a code module, nor the `status_model` rules a seat's model is read through —
a profile whose rules declare no model names yields none, and `doctor` says the model can't be
checked rather than claim a reading. A pattern is added after the shipped ones, and a vendor
notice is not among the patterns an override can add: one exists only as the stage its profile
captured, with the version range it was captured on. It cannot take
a shipped pattern out, and it cannot make a screen read `idle` or `unsent` that does not
already, nor stop a shipped permission, trust, question or vendor notice pattern from matching.

`approve` records the file's text with the team file. Until it does, the approved copy stays
in force — or the shipped profiles alone, when there is no copy, or the copy cannot be read.
`doctor` and `status` name the difference. A file that does not parse is refused here, with
its path and its line, and the other commands report that line instead of failing on it.

```yaml file=overrides.yaml
format: 1
profiles:
  codex:
    quota:
      - account: anthropic
        match: '\bL: ([0-9]+)% \(([0-9hm]+)\)'
        used: '{1}%'
        resets: '{2}'
        window: session
```

```console
$ team approve --show ; echo "exit $?"
team approve: warning, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

overrides.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 1: format: 1
  + 2: profiles:
  + 3:   codex:
  + 4:     quota:
  + 5:       - account: anthropic
  + 6:         match: '\bL: ([0-9]+)% \(([0-9hm]+)\)'
  + 7:         used: '{1}%'
  + 8:         resets: '{2}'
  + 9:         window: session

Needs a new approval: `overrides` changed.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
approval #3 for this project; the last one was on 2026-10-04; key fe21ef6293de.
Owner-authorization fingerprint: 5d59b3e9b25cc131d0200014782f1aa2d84bdfe701655b8a4115d844a603593c
exit 0
```
