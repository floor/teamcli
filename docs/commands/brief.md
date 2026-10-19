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

## Synopsis

    team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--apply` | — | run the plan: write each due seat's claim and signed drop, recover a held name at the claim's next attempt, and report each seat as it ended; without it nothing is written |
| `--seat` | a declared seat name | plan or deliver for that seat alone; the other seats are not planned, written or reported, so a targeted retry leaves the team alone |
| `--session` | a session name | the session to deliver in; the team file's own unless the owner names another |
| `--file` | a path | the team file to read; the owner's alone |
| `--json` | — | print one `team.brief` document (`format: 1`, `project`, `session`, `apply`, `seats`, `counts`) instead of the per-seat lines |
| `--help`, `-h` | — | the usage, and exit 0 |

`rollout` is the command's one subcommand, and it is required: `team brief` alone, another word,
or an extra word is an invocation error, as is an unknown flag.

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

## Who may run it

The owner reads any team file it names. Everyone else is held to the read gate: a seat whose own
placement — name, session and pane — matches the state's record may read its team's plan, and a
caller outside every seat is told `this team is not yours to read`. A caller who is not the owner
cannot aim `--file` or `--session`: those flags name another team's or another session's records,
and the refusal is the owner's.

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

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the dry run finds every live or human seat current | the per-seat lines | 0 |
| `--apply` leaves every live or human seat current | the per-seat lines | 0 |
| the dry run finds delivery, recovery or stale work | the per-seat lines | 1 |
| `--apply` leaves a live or human seat stale or failed | the per-seat lines, with the failed seat's reason | 1 |
| a caller who is not the owner aims `--file` or `--session` | the owner-only refusal | 1 |
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

## Example

```fixture
agents: all
now: "2026-10-04T09:00:00Z"
state:
  briefs:
    claude-keeper:
      id: 05353e46-4677-50bc-8eac-f642da422c12
      at: "2026-10-04T08:00:00.000Z"
      incarnation: inc_000000000000
      epoch: run_000000000000
      sha256: 4b273912a6c995f1b2b8ab1a43a0432cad323c1dbb986c9ae50b4ad2a7f84fec
      attempt: 0
      stage: claimed
    claude-beacon:
      id: ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34
      at: "2026-10-04T08:00:00.000Z"
      incarnation: inc_000000000001
      epoch: run_000000000001
      sha256: 4b273912a6c995f1b2b8ab1a43a0432cad323c1dbb986c9ae50b4ad2a7f84fec
      attempt: 0
      stage: claimed
    desk:
      id: 12248236-e207-59a8-a58e-60490a832242
      at: "2026-10-04T08:00:00.000Z"
      incarnation: inc_000000000002
      epoch: run_000000000002
      sha256: 4b273912a6c995f1b2b8ab1a43a0432cad323c1dbb986c9ae50b4ad2a7f84fec
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
deliver claude-keeper: 4b273912a6c9 -> 05353e46-4677-50bc-8eac-f642da422c12
deliver claude-beacon: 4b273912a6c9 -> ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34
human desk: delivery only
exit 1
```

`--apply` writes each claim and its signed drop, in the seat folders under
`.agents/send-drops/beacon/`, and reports the same ids:

```console
$ team brief rollout --apply ; echo "exit $?"
deliver claude-keeper: 4b273912a6c9 -> 05353e46-4677-50bc-8eac-f642da422c12
deliver claude-beacon: 4b273912a6c9 -> ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34
human desk: delivery only
exit 0
```

Now the claims and their records agree, so the plan finds every seat current; the human seat is
still reported as delivery only, because it is never read:

```console
$ team brief rollout ; echo "exit $?"
brief claude-keeper: current 4b273912a6c9 05353e46-4677-50bc-8eac-f642da422c12
brief claude-beacon: current 4b273912a6c9 ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34
human desk: delivery only
exit 0
```

A name that is not this brief's is never replaced. Here another file sits at the implementer's
expected id; the plan moves the delivery to the claim's next attempt and says what it found:

```file file=.agents/send-drops/beacon/claude-beacon/ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34
not a message record: another program's file, left where it is
```

```console
$ team brief rollout ; echo "exit $?"
brief claude-keeper: current 4b273912a6c9 05353e46-4677-50bc-8eac-f642da422c12
recover claude-beacon: the name at ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34 is not this brief's; would deliver at a82dcad2-b691-588e-a145-c45431e7baab
human desk: delivery only
exit 1
```

`--apply` posts the record at the second attempt's id and leaves the held file exactly as it was:

```console
$ team brief rollout --apply ; echo "exit $?"
brief claude-keeper: current 4b273912a6c9 05353e46-4677-50bc-8eac-f642da422c12
recovered claude-beacon: the name at ef8d0a3f-a6d5-5b9e-bd18-b5874beb6d34 is not this brief's; delivered at a82dcad2-b691-588e-a145-c45431e7baab
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
      "hash12": "4b273912a6c9",
      "id": "05353e46-4677-50bc-8eac-f642da422c12",
      "from": null,
      "reason": null,
      "current": true
    },
    {
      "seat": "claude-beacon",
      "action": "current",
      "hash12": "4b273912a6c9",
      "id": "a82dcad2-b691-588e-a145-c45431e7baab",
      "from": null,
      "reason": null,
      "current": true
    },
    {
      "seat": "desk",
      "action": "human",
      "hash12": "4b273912a6c9",
      "id": "12248236-e207-59a8-a58e-60490a832242",
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

The invocation is checked before anything is read:

```console
$ team brief ; echo "exit $?"
team brief: a subcommand is required: rollout
Usage: team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]

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

Options:
  --apply    run the plan; each seat is reported as delivered, recovered or
             failed, and a seat already current is reported current
  --seat     one declared seat to plan or deliver for; the others are left
             untouched
  --session  the session to deliver in, the team file's own unless the owner
             names another
  --file     the team file to read, the owner's alone
  --json     one team.brief document ({format, project, session, apply, seats,
             counts}) instead of the per-seat lines

Exits 0 when the dry run finds every live or human seat current (brief.plan)
or --apply leaves every one of them current (brief.current); 1 when the dry
run finds delivery work (brief.stale), --apply leaves a seat stale or failed
(brief.incomplete), or a caller who is not the owner aims --file or --session
(brief.file-owner, brief.session-owner); 2 when the invocation can't be read
(brief.invocation), a caller who may not read this team asks
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
