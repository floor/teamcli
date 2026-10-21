# team raise

A raise is a lead's own line to the owner, delivered the moment it is written rather than waiting in
the watch's next digest. Two kinds may be raised: `release.ready`, when a release needs the owner's
go, and `decision.needed`, when a call is the owner's to make. Both are routed to `owner` alone and
both stand in the owner-at-once list, so the watch rings them; the command writes the owner's record
itself, under the id the event's own delivery would use, and the watch that later reads the event
finds it already there and stays silent. One raise is one record and one notification.

Two guards keep the owner's mailbox quiet. The same kind and line from the same seat within the hour
is one record, not two: the record's body gains ` (×N)`. And ten raises reach the owner per team per
UTC day; an eleventh is refused, and the refusal says the line did not reach the owner. A merge
appends no event, so it adds no raise to the day's count.

## Synopsis

    team raise <kind> <text> [--dry-run] [--json]

## What it reads and writes

Reads the team file in the current folder and the state beside it — the pane the state records for
the caller's seat — then the event log and the record the owner's mailbox already holds. Writes one
signed message record to `.agents/messages/owner/evt-<seq>-<hash>.json` and one event to the log:

    {
      "v": 1,
      "seq": 41,
      "ts": "2026-10-04T09:00:00.000Z",
      "kind": "release.ready",
      "session": "beacon",
      "record_id": "raise-4f0c8d3a19b7",
      "from": "claude-keeper",
      "to": "owner",
      "reason": "the release is ready for the owner"
    }

The event carries no body: its `reason` is the one line, the same words the record's body holds. A
merge rewrites that record's body as `<line> (×N)` and appends no event. `--dry-run` reads the log
and the record, says what would happen, and writes nothing at all — no event, no record, no
notification, no state.

## Who may run it

The line is the lead's: the orchestrator's seat, or a seat the team file marks `leads`.

| Caller | May |
| --- | --- |
| the orchestrator's seat or a lead's seat, on the pane the state records for it | raise |
| the owner | nothing: `team raise: only the orchestrator's seat or a lead's raises to the owner; this call is owner` |
| any other seat | nothing: `team raise: only the orchestrator's seat or a lead's raises to the owner; this call is <name>` |
| an agent-run CLI | nothing: `team raise: only the orchestrator's seat or a lead's raises to the owner; this call is unplaced (it is run by an agent (claude) outside herdr)` |
| a lead's seat, when the state records no pane for it | nothing: `team raise: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` |
| a lead's seat on a pane the state doesn't record for it | nothing: `team raise: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` |

## Flags

| Flag | Meaning |
| --- | --- |
| `<kind>` | `release.ready` or `decision.needed`, and nothing else |
| `<text>` | the one line the owner reads; required, and at most 500 characters |
| `--dry-run` | print the route and the action, and write nothing; exits 0 |
| `--json` | emit a `team.raise` v1 JSON document (`schema/raise.schema.json`) on `stdout` |
| `--help`, `-h` | the usage, and exit 0 |

## Refusals

| Message | Exit |
| --- | --- |
| `team raise: a <kind> is required` (with the usage) | 2 |
| `team raise: <kind> is not a kind the owner is raised with: release.ready or decision.needed` (with the usage) | 2 |
| `team raise: a <text> is required` (with the usage) | 2 |
| `team raise: unexpected "<word>"` (with the usage) | 2 |
| `team raise: the <text> is one line of at most 500 characters` (with the usage) | 2 |
| `team raise: <why the team file did not load>` | 2 |
| `team raise: only the orchestrator's seat or a lead's raises to the owner; this call is <caller>` | 1 |
| `team raise: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team raise: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team raise: ten raises have reached the owner today; this <kind> line was not delivered` | 1 |
| `team raise: the event log can't be read: <why>`, `the event log can't be written: <why>`, or `the owner's record can't be written: <why>` | 1 |

## Exit codes

- `0` — the line was delivered or merged into the record already open, or `--dry-run` said what it would do.
- `1` — it was refused: the caller is not a lead, the day's ten raises are spent, or the log or the owner's record can't be read or written.
- `2` — the invocation can't be read, or the team file can't.

## Example

```fixture
approved: false
herdr: none
agents: all
watch: none
caller: claude-keeper
```

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
  - role: project coordinator
    name: claude-keeper
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: scout
    name: claude-scout
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

The orchestrator's seat raises a release, and the same line again within the hour is the same
record, counted:

```console
$ team raise release.ready "the release is ready for the owner" ; echo "exit $?"
team beacon, session "beacon"
raise: release.ready delivered to the owner at once
exit 0
$ team raise release.ready "the release is ready for the owner" ; echo "exit $?"
team beacon, session "beacon"
raise: release.ready merged into the owner's record (×2)
exit 0
```

`--dry-run` says what the raise would do and writes nothing, so the count it reads is still the
count the next real raise finds:

```console
$ team raise release.ready "the release is ready for the owner" --dry-run ; echo "exit $?"
team beacon, session "beacon"
raise: would merge release.ready into the owner's record (×3)
exit 0
$ team raise decision.needed "pick the launch name" --dry-run ; echo "exit $?"
team beacon, session "beacon"
raise: would deliver decision.needed to the owner at once
exit 0
$ team raise release.ready "the release is ready for the owner" ; echo "exit $?"
team beacon, session "beacon"
raise: release.ready merged into the owner's record (×3)
exit 0
```

The owner reads the line; the owner does not raise it, and neither does a seat the team file does
not mark `leads`:

```console caller=owner
$ team raise release.ready "the release is ready for the owner" ; echo "exit $?"
team raise: only the orchestrator's seat or a lead's raises to the owner; this call is owner
exit 1
```

```console caller=claude-scout
$ team raise release.ready "the release is ready for the owner" ; echo "exit $?"
team raise: only the orchestrator's seat or a lead's raises to the owner; this call is claude-scout
exit 1
```

A kind the owner is not raised with is refused with the usage, and so is a missing line:

```console
$ team raise notify "the release is ready for the owner" ; echo "exit $?"
team raise: notify is not a kind the owner is raised with: release.ready or decision.needed
Usage: team raise <kind> <text> [--dry-run] [--json]

<kind> is release.ready or decision.needed, and <text> is the one line the owner reads.
Only the orchestrator's seat or a seat the team marks `leads` raises.

Exits 0 when the line is delivered or merged into one already open, 1 when it is refused or the log or the owner's record can't be written, 2 when the invocation or team file can't be read.
exit 2
```
