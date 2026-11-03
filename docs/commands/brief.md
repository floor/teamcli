# team brief

`team brief rollout` delivers TeamCLI's general seat brief — the built-in first text every seat
gets, held in this build — to the team's declared seats without a launch. The brief is [the
general seat brief](../briefs/general.md); a launch writes it into a seat's drop folder itself,
as a signed message record, before it types anything, and this command is the same delivery for a
team whose seats are already up, or whose briefs were written by an earlier build.

A delivery is a claim and a drop. The claim, in the session's state, names the delivery's
incarnation, the runtime epoch, the brief's sha256 and the drop id the record must have; the drop
is the signed message record at exactly that id. `team brief rollout` writes both through the
boundary every launch calls, so a seat delivered here and one delivered by `team up` stand
identically. The plan reads both: a seat is `current` when its claim is this build's brief and the
record at the claim's id verifies. `current` is the delivery's currency, never the seat's read —
whether the seat has read the brief is [`team check`](check.md)'s line, and the rollout writes no
receipt.

The dry run is the default and writes nothing at all: no state, no drop, no receipt. A seat with
no claim, an old build's claim or an earlier text is delivered at the id that delivery will use; a
name held by a file that is not this brief's, a link or a folder is left untouched and recovered at
the claim's next attempt. A declared seat the state does not record as running is not mailed into
its stopped folder: its next launch delivers it, and the plan says so. A human seat is delivered to
like any other and is never read.

A live inbox server keeps the parsers of the build it started with: installing a build does not
reload a running process, and a server from an older build can refuse a record this build signs
before it ever reaches its body. When a due seat's listener marker names another build — or
records no build identity at all — the plan reports the seat `stale`, writes nothing to it, and
says that the seat's CLI host must restart for its MCP server to reload the installed build. The
check never downgrades a signature: the runtime is refreshed, not the record.

How a delivery travels is the [`brief-transport`](policy.md) policy, read at entity, project and
team. `file`, the default, is exactly the claim and drop above. `message` writes the same claim
and the same signed record, then sends the whole brief through the seat's own delivery legs, with
the send command's own walk: the seat gets the whole body — never a pointer — and the send's
receipt, history line and outcome are an ordinary send's. `memory` is an experiment that no
runtime in this build proves zero-persistence for: a `memory` policy delivers nothing, refuses
every seat and every `team send --brief`, and falls back to neither of the other two transports.
A launch reads the same policy and delivers the same way.

`team brief prune` is the other verb: it retires the calling seat's own launch-brief retry
sidecars — the `<id>.pending` markers a held delivery leaves beside its record for `team watch` to
retry. A marker's retry can no longer be right when the seat's claim has moved past that delivery,
or when the seat has read the delivery the claim names; a marker of the current claim that is not
read is exactly the one a retry still owes, and is never touched. Prune applies the retry pass's
own two rules, reads them from the state and the drop folder, and prints what it would retire; it
removes nothing without `--apply`, and then removes only those markers. A signed record, a
receipt, an unread delivery and any other send's marker are left exactly where they are. The
caller must be the seat itself, on the pane the state records for it: the owner and every other
pane are refused.

## Synopsis

    team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]
    team brief prune [--apply] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--apply` | — | rollout: run the plan: write each due seat's claim and signed drop, recover a held name at the claim's next attempt, and report each seat as it ended. prune: remove the markers the dry run listed. Without it nothing is written or removed |
| `--seat` | a declared seat name | rollout only: plan or deliver for that seat alone; the other seats are not planned, written or reported, so a targeted retry leaves the team alone |
| `--session` | a session name | rollout only: the session to deliver in; the team file's own unless the owner names another |
| `--file` | a path | rollout only: the team file to read; the owner's alone |
| `--json` | — | one document instead of the lines: `team.brief` (`format: 1`, `project`, `session`, `apply`, `seats`, `counts`) for rollout, `team.brief-prune` (`format: 1`, `project`, `session`, `seat`, `apply`, `files`, `counts`) for prune |
| `--help`, `-h` | — | the usage, and exit 0 |

A subcommand is required: `team brief` alone, another word, or an extra word is an invocation
error, as is an unknown flag. `prune` takes `--apply` and `--json` alone; `--seat`, `--session`
and `--file` are `rollout`'s.

## What it reads and writes

Reads the team file — the one the checkout git names, or this folder's own team root — and, from
`.agents/team.state.json`, the session's seat records and each seat's brief claim. It reads the
drop folder of every seat the state records as running and of every human seat, at
`.agents/send-drops/<session>/<seat>/`: the record the claim names is verified against the
checkout's message key and compared with the claim's seat, session, incarnation and expected id,
and a live `.inbox-listener` beside it is read for the build identity its server records.

`--apply` writes the claim in the state under the state's lock, then the signed record at exactly
the claim's id, and finalizes the claim at the record's own time. A name held by a foreign regular
file, a link, a FIFO or a folder is never replaced, removed or followed: the run records the
claim's next attempt and posts the drop at that attempt's id instead, leaving the held name byte
for byte as it was found. Nothing is typed, no pane is read, and herdr is not called.

`prune` reads the team file and, for the calling seat, the state's brief claim and the markers in
the seat's own drop folder. A marker is listed when its id is not the claim's — the seat's reader
refuses the older delivery as superseded — or when a signed read receipt bound to the claim says
the seat read it. The receipt must carry the claim's brief sha256, incarnation and epoch, as this
build's reader writes them: a receipt from a build that bound no claim proves no read, and the
marker stays. `--apply` removes each listed marker with one removal per file and checks that the
name is gone, so a removal that fails is reported as failed rather than counted as retired. The
folder is guarded the way `team drops` guards it: a step that is a link or a file refuses the run
instead of reading through it, and a claim that cannot be read retires nothing.

The claim is read again after the folder listing, before any marker is removed. A launch that
publishes a newer claim while the run lists the folder writes that claim's marker right after it,
and the marker is already in the listing; retiring it as superseded would remove the delivery the
retry owes. A claim that changed retires nothing, and the run says so. A claim is written before
its marker, so a claim published after this check cannot slip a marker into the listing.

## Who may run it

The owner reads any team file it names. Everyone else is held to the read gate: a seat whose own
placement — name, session and pane — matches the state's record may read its team's plan, and a
caller outside every seat is told `this team is not yours to read`. A caller who is not the owner
cannot aim `--file` or `--session`: those flags name another team's or another session's records,
and the refusal is the owner's.

`prune` is the seat's own act and only the seat's: the caller must be the seat whose drop folder
it is, placed on the pane the state records for it. The owner is refused, and so is a seat calling
from any other pane; a seat the file does not declare is refused with the same sentence.

## Output and exit codes

The plan prints one line per declared seat:

- `brief <seat>: current <hash12> <id>` — the claim is this build's brief and its record verifies;
- `deliver <seat>: <hash12> -> <id>` — the delivery the plan would make, at the claim's lifetime
  (a seat with no claim has no lifetime yet, so its row shows the id a fresh one would produce,
  and `--apply` mints the lifetime it writes and reports the id it used);
- `recover <seat>: the name at <id> is not this brief's; would deliver at <id>` — the name at the
  claim's id is held, and the delivery moves to the claim's next attempt;
- `not running <seat>: delivered at its next launch` — not a target this run;
- `stale <seat>: <reason>` — the seat's live inbox server runs another build, so the seat is not
  written to; the reason says which host restart reloads the installed build;
- `human <seat>: delivery only` — delivered, never read.

`--apply` replaces `deliver` with the same line and `recover` with `recovered <seat>: the name at
<id> is not this brief's; delivered at <id>`; a seat already current is printed as current, a
stale seat is printed as stale and written nothing, and a seat whose delivery failed is
`failed <seat>: <reason>`.

The prune prints one line per marker, then a count:

- `would retire <path>: <why>` — the dry run would remove the marker; `<why>` is `the delivery was
  read` or `the seat's current claim names a newer delivery`;
- `retired <path>: <why>` — `--apply` removed it;
- `failed <path>: <error>` — `--apply` could not remove it, and the run says so;
- `1 file to retire` / `2 files to retire`, or with `--apply` `1 file retired` and, when a removal
  failed, `1 file not removed`.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the dry run finds every live or human seat current | the per-seat lines | 0 |
| `--apply` leaves every live or human seat current | the per-seat lines | 0 |
| the dry run finds delivery, recovery or stale work | the per-seat lines | 1 |
| `--apply` leaves a live or human seat stale or failed | the per-seat lines, with the failed seat's reason | 1 |
| a caller who is not the owner aims `--file` or `--session` | the owner-only refusal | 1 |
| prune's dry run finds nothing to retire | `0 files to retire` | 0 |
| prune's `--apply` removes every marker it listed | the retired rows and `N files retired` | 0 |
| prune's dry run lists markers to retire | the `would retire` rows and `N files to retire` | 1 |
| prune's `--apply` leaves a marker unremoved | the failed row and `N files not removed` | 1 |
| prune's caller is not the seat, or not on its recorded pane | `team brief prune: <why>` | 1 |
| prune's current brief claim changed while the run read its markers | `team brief prune: <why>`, and nothing retired | 1 |
| the invocation can't be read | `team brief: <problem>`, with the usage | 2 |
| a caller who may not read this team asks | `team brief: this team is not yours to read` | 2 |
| the team file can't be read or parsed | `team brief: <problem>` | 2 |

The `--json` document is `{"schema": {"name": "team.brief", "version": 1}, "format": 1,
"project": …, "session": …, "apply": …, "seats": [{"seat", "action", "hash12", "id", "from",
"reason", "current"}], "counts": {"current", "deliver", "recover", "not_running", "human",
"stale_listener", "failed"}}`. `action` is `current`, `deliver`, `recover`, `recovered`,
`not-running`, `stale-listener`, `human` or `failed`; `hash12` is the first twelve hex digits of
the brief's sha256; `from` and `reason` are `null` unless the row names them. An invocation or
team-file error under `--json` prints the `team.error` document with its `brief.*` id instead.

The prune's document is `{"schema": {"name": "team.brief-prune", "version": 1}, "format": 1,
"project": …, "session": …, "seat": …, "apply": …, "files": [{"path", "id", "from", "reason",
"outcome", "error"}], "counts": {"files", "retired", "failed"}}`. `reason` is `read` or
`superseded`; `outcome` is `would-retire`, `retired` or `failed`, and `error` is `null` unless the
row failed. A refusal under `--json` prints the `team.error` document with `brief.prune-refused`.

## Example

```fixture
agents: all
now: "2026-10-04T09:00:00Z"
state:
  briefs:
    claude-keeper:
      id: c1578a15-8f39-5f88-b6ce-d66a311a39ba
      at: "2026-10-04T08:00:00.000Z"
      incarnation: inc_000000000000
      epoch: run_000000000000
      sha256: 43ef85c0d984fb5cc5ea8fb6d4cf563f45ac170e81b5400923e14580ba2f8fdc
      attempt: 0
      stage: claimed
    claude-beacon:
      id: 68f249a5-9e9b-5069-b564-9ed33d1b6e45
      at: "2026-10-04T08:00:00.000Z"
      incarnation: inc_000000000001
      epoch: run_000000000001
      sha256: 43ef85c0d984fb5cc5ea8fb6d4cf563f45ac170e81b5400923e14580ba2f8fdc
      attempt: 0
      stage: claimed
    desk:
      id: 1002932a-2cf8-5a47-b232-034a69a406ab
      at: "2026-10-04T08:00:00.000Z"
      incarnation: inc_000000000002
      epoch: run_000000000002
      sha256: 43ef85c0d984fb5cc5ea8fb6d4cf563f45ac170e81b5400923e14580ba2f8fdc
      attempt: 0
      stage: claimed
```

```yaml file=.agents/team.yaml
format: 1
project: beacon
operator: claude-keeper

identity:
  humans: [jane@acme.example]

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: orchestrator
    name: claude-keeper
    leads: true
    label: orchestrator
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

  - role: operator
    name: desk
    label: desk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
```

Each seat's claim names a lifetime whose record the folder does not hold yet: a launch that wrote
the claim was stopped before its drop. The dry run plans the deliveries and writes nothing:

```console
$ team brief rollout ; echo "exit $?"
deliver claude-keeper: 43ef85c0d984 -> c1578a15-8f39-5f88-b6ce-d66a311a39ba
deliver claude-beacon: 43ef85c0d984 -> 68f249a5-9e9b-5069-b564-9ed33d1b6e45
human desk: delivery only
exit 1
```

`--apply` writes each claim and its signed drop, in the seat folders under
`.agents/send-drops/beacon/`, and reports the same ids:

```console
$ team brief rollout --apply ; echo "exit $?"
deliver claude-keeper: 43ef85c0d984 -> c1578a15-8f39-5f88-b6ce-d66a311a39ba
deliver claude-beacon: 43ef85c0d984 -> 68f249a5-9e9b-5069-b564-9ed33d1b6e45
human desk: delivery only
exit 0
```

Now the claims and their records agree, so the plan finds every seat current; the human seat is
still reported as delivery only, because it is never read:

```console
$ team brief rollout ; echo "exit $?"
brief claude-keeper: current 43ef85c0d984 c1578a15-8f39-5f88-b6ce-d66a311a39ba
brief claude-beacon: current 43ef85c0d984 68f249a5-9e9b-5069-b564-9ed33d1b6e45
human desk: delivery only
exit 0
```

A name that is not this brief's is never replaced. Here another file sits at the implementer's
expected id; the plan moves the delivery to the claim's next attempt and says what it found:

```file file=.agents/send-drops/beacon/claude-beacon/68f249a5-9e9b-5069-b564-9ed33d1b6e45
not a message record: another program's file, left where it is
```

```console
$ team brief rollout ; echo "exit $?"
brief claude-keeper: current 43ef85c0d984 c1578a15-8f39-5f88-b6ce-d66a311a39ba
recover claude-beacon: the name at 68f249a5-9e9b-5069-b564-9ed33d1b6e45 is not this brief's; would deliver at b9918705-5c76-57d6-9734-4d47d3cb233d
human desk: delivery only
exit 1
```

`--apply` posts the record at the second attempt's id and leaves the held file exactly as it was:

```console
$ team brief rollout --apply ; echo "exit $?"
brief claude-keeper: current 43ef85c0d984 c1578a15-8f39-5f88-b6ce-d66a311a39ba
recovered claude-beacon: the name at 68f249a5-9e9b-5069-b564-9ed33d1b6e45 is not this brief's; delivered at b9918705-5c76-57d6-9734-4d47d3cb233d
human desk: delivery only
exit 0
```

`--json` prints the same plan as one document:

```console
$ team brief rollout --json ; echo "exit $?"
{
  "schema": {
    "name": "team.brief",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "apply": false,
  "seats": [
    {
      "seat": "claude-keeper",
      "action": "current",
      "hash12": "43ef85c0d984",
      "id": "c1578a15-8f39-5f88-b6ce-d66a311a39ba",
      "from": null,
      "reason": null,
      "current": true
    },
    {
      "seat": "claude-beacon",
      "action": "current",
      "hash12": "43ef85c0d984",
      "id": "b9918705-5c76-57d6-9734-4d47d3cb233d",
      "from": null,
      "reason": null,
      "current": true
    },
    {
      "seat": "desk",
      "action": "human",
      "hash12": "43ef85c0d984",
      "id": "1002932a-2cf8-5a47-b232-034a69a406ab",
      "from": null,
      "reason": null,
      "current": true
    }
  ],
  "counts": {
    "current": 2,
    "deliver": 0,
    "recover": 0,
    "not_running": 0,
    "human": 1,
    "stale_listener": 0,
    "failed": 0
  }
}
exit 0
```

A held delivery leaves a retry marker beside its record. Here the keeper's folder holds one marker
for the delivery its claim names — unread, so a retry still owes it — and one for an earlier
delivery the claim has moved past:

```file file=.agents/send-drops/beacon/claude-keeper/c1578a15-8f39-5f88-b6ce-d66a311a39ba.pending
{"id":"c1578a15-8f39-5f88-b6ce-d66a311a39ba","from":"the launch","to":"claude-keeper","body":"an earlier held delivery\n","ts":"2026-10-04T08:30:00.000Z","tries":0}
```

```file file=.agents/send-drops/beacon/claude-keeper/0b2c4d6e-8f0a-4b1c-9d2e-3f4a5b6c7d8e.pending
{"id":"0b2c4d6e-8f0a-4b1c-9d2e-3f4a5b6c7d8e","from":"the launch","to":"claude-keeper","body":"an earlier held delivery\n","ts":"2026-10-04T08:45:00.000Z","tries":0}
```

The seat's own prune lists only the second: the first is the delivery its claim names, and
nothing says the seat has read it:

```console caller=claude-keeper
$ team brief prune ; echo "exit $?"
would retire ./.agents/send-drops/beacon/claude-keeper/0b2c4d6e-8f0a-4b1c-9d2e-3f4a5b6c7d8e.pending: the seat's current claim names a newer delivery
1 file to retire
exit 1
```

```console caller=claude-keeper
$ team brief prune --apply ; echo "exit $?"
retired ./.agents/send-drops/beacon/claude-keeper/0b2c4d6e-8f0a-4b1c-9d2e-3f4a5b6c7d8e.pending: the seat's current claim names a newer delivery
1 file retired
exit 0
```

The current claim's unread marker is still there, so the run after it has nothing to do:

```console caller=claude-keeper
$ team brief prune ; echo "exit $?"
0 files to retire
exit 0
```

The owner is not a seat of the team, so their prune is refused and touches nothing:

```console
$ team brief prune ; echo "exit $?"
team brief prune: only a seat of this team retires its own launch-brief retry markers; this call is owner
exit 1
```

The invocation is checked before anything is read:

```console
$ team brief ; echo "exit $?"
team brief: a subcommand is required: rollout or prune
Usage: team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]
       team brief prune [--apply] [--json]

Delivers this build's general seat brief to every declared seat that is live
or human. The plan reads each seat's claim and the signed record the claim
names: a seat with no claim, an old build's claim or an earlier text is
delivered at the id that delivery uses, and a name held by a file that is not
this brief's, or by a link or a folder, is recovered at the claim's next
attempt without touching what is there. A human seat is delivered and never
read. A declared seat that is not running is left for its next launch. A seat
whose live inbox server records another build is reported stale and is not
written to: that server keeps the parsers it started with, and restarting the
seat's CLI host is what reloads the installed build. Without --apply the plan
is printed and nothing is written: no state, no drop, no receipt.

The launch-brief retry sidecars in the calling seat's own folder are what
`prune` retires: a launch delivery that a held send left a try marker for, and
whose retry can no longer be right because the seat's claim names a newer
delivery, or because the seat has read the one it names. It prints one row per
file and, without --apply, removes nothing. It never removes a signed record, a
receipt, the marker of a delivery the seat has not read, or any other send's
marker; a claim it cannot read retires nothing; and a caller that is not a seat
of this team on its recorded pane is refused.

Options:
  --apply    rollout: run the plan; each seat is reported as delivered,
             recovered or failed, and a seat already current is reported
             current. prune: remove the files the dry run listed
  --seat     rollout only: one declared seat to plan or deliver for; the
             others are left untouched
  --session  rollout only: the session to deliver in, the team file's own
             unless the owner names another
  --file     rollout only: the team file to read, the owner's alone
  --json     one document instead of the per-command lines: team.brief
             ({format, project, session, apply, seats, counts}) for rollout,
             team.brief-prune ({format, project, session, seat, apply, files,
             counts}) for prune

Exits 0 when the dry run finds every live or human seat current (brief.plan),
--apply leaves every one of them current (brief.current), prune has nothing to
retire (brief.prune-clean), or prune's --apply removes every file it listed
(brief.prune-applied); 1 when the dry run finds delivery work (brief.stale),
--apply leaves a seat stale or failed (brief.incomplete), prune's dry run lists
files to retire (brief.prune-due), prune's --apply leaves one unremoved
(brief.prune-incomplete), a caller who is not the seat's own pane asks prune
(brief.prune-refused), or a caller who is not the owner aims --file or
--session (brief.file-owner, brief.session-owner); 2 when the invocation can't
be read (brief.invocation), a caller who may not read this team asks
(brief.not-yours), or the team file can't be read (brief.file,
brief.file-invalid).
exit 2
```

A caller outside every seat learns nothing of the team, and the plan is not printed:

```console caller=agent
$ team brief rollout ; echo "exit $?"
team brief: this team is not yours to read
exit 2
```

Rationale, the claim and drop it writes, recovery, and known limits:
[docs/internal/brief.md](../internal/brief.md).
