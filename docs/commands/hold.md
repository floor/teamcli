# team hold

A hold is a note on the team's work: why it was placed, who placed it and when, and when it lapses.
It lives in the team state (`.agents/team.state.json`), never in the team file: placing one edits
no team file, and a hold that waits is no hold. A hold is the project's, not one session's.
`status` prints it as its first `note:` and `doctor` as the last `note` line before the summary. A
record whose `until` has passed reads as no hold at all, so a lapsed hold needs no writer to clear
it: every reader stops showing it, and the next `team hold` replaces it. In this build nothing else
consults a hold: no command, no launch and no watch changes what it does while one stands.

## Synopsis

    team hold <reason> [--until <time>] [--json]
    team hold --release [--json]
    team hold <reason> --client <grant-file> --key <client-key> [--team <team>] [--until <time>] [--json]
    team hold --release --client <grant-file> --key <client-key> [--team <team>] [--json]

## What it reads and writes

Reads the team file in the current folder and the state beside it, and the pane the state records
for the caller's seat when a seat runs it. Writes one `hold` record at the top level of the state:

    {
      "format": 1,
      "hold": {
        "reason": "freeze deploys",
        "by": "owner",
        "at": "2026-10-04T09:00:00.000Z",
        "until": "2026-10-04T18:00:00.000Z"
      },
      "sessions": {}
    }

`until` is absent when the hold names no end. Placing a hold under one that still stands writes
nothing and is refused, naming the hold in force; a hold that has lapsed is replaced. `--release`
removes the record and writes nothing else. A hand-edited value that is not the record this command
writes — a reason with no text, a name or an instant that doesn't parse — is dropped when the state
is read, so it is never printed by any reader.

## Who may run it

The caller rule is the session walk's: the owner, or the team's orchestrator or operator running on
its own seat.

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | place and release |
| the orchestrator's or the operator's seat, on the pane the state records for it | place and release |
| a run with no terminal | nothing: `team hold: only the owner, the orchestrator or the operator runs this, from a terminal outside herdr or its own seat` |
| any other seat, or an agent-run CLI | nothing: `team hold: only the owner, the orchestrator or the operator holds the team; this call is <caller>` |
| the orchestrator's or the operator's seat, when the state records no pane for it | nothing: `team hold: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` |
| the same seat on a pane the state doesn't record for it | nothing: `team hold: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` |

## Flags

| Flag | Meaning |
| --- | --- |
| `<reason>` | the line stored as the reason; required unless `--release` |
| `--until <time>` | a local `<HH:MM>`, the next time that clock comes (today, or tomorrow when today's has passed), or an ISO 8601 instant carrying `Z` or an offset |
| `--release` | clears the hold that stands; takes no `<reason>` and no `--until` |
| `--client <grant-file>` | the client form: an owner-signed developer bundle grant that carries `hold`, see [A client's hold](#a-clients-hold) |
| `--key <client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team <team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | emit a `team.hold` v1 JSON document (`schema/hold.schema.json`) on `stdout` |
| `--help`, `-h` | the usage, and exit 0 |

## A client's hold

A client with no terminal that the owner signed a **developer** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-developer-bundle)) places or releases the hold of that one team with `team hold --client <grant-file> --key <client-key>`. The grant is verified whole before any gate, and again under the grant lock before the first effect; it must carry `hold` and name exactly this team, and the run is the one team the grant's folder holds: `<team>` and `--all` are the owner's and are refused with `--client` (exit 2). The run is the second door past the placement and who-may-run-it gates, never the owner's, and is logged as `client:<id>` and as `client-hold-authorized: …`. A refusal is `hold.client-refused` (exit 1).

## Refusals

| Message | Exit |
| --- | --- |
| `team hold: a <reason> is required` (with the usage) | 2 |
| `team hold: unexpected "<word>"` (with the usage) | 2 |
| `team hold: --release takes no <reason> and no --until` (with the usage) | 2 |
| `team hold: <why the team file did not load>` | 2 |
| `team hold: --until is a local <HH:MM>, or an ISO 8601 instant with Z or an offset, and nothing else` | 1 |
| `team hold: already held: <reason>` — `already held until <instant>: <reason>` when the hold names an end | 1 |
| `team hold: not held` | 1 |
| `team hold: only the owner, the orchestrator or the operator runs this, from a terminal outside herdr or its own seat` | 1 |
| `team hold: only the owner, the orchestrator or the operator holds the team; this call is <caller>` | 1 |
| `team hold: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team hold: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team hold: <why the state could not be read or written>` | 1 |

## Exit codes

- `0` — the hold was placed, or released.
- `1` — it was refused: the caller may not hold the team, a hold already stands, no hold stands, `--until` is neither shape, the state can't be read or written, or the run has no terminal.
- `2` — the invocation can't be read, or the team file can't.

## Example

```fixture
approved: false
herdr: none
agents: none
watch: none
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
```

The owner holds the team until an instant, and a second hold is refused by name:

```console
$ team hold "freeze deploys" --until 2026-10-04T18:00:00Z ; echo "exit $?"
hold until 2026-10-04T18:00:00.000Z: freeze deploys
exit 0
$ team hold "keep the tree still" ; echo "exit $?"
team hold: already held until 2026-10-04T18:00:00.000Z: freeze deploys
exit 1
```

`--release` clears it, and a release with no hold is refused:

```console
$ team hold --release ; echo "exit $?"
hold: released
exit 0
$ team hold --release ; echo "exit $?"
team hold: not held
exit 1
```

`--until` takes a clock or an instant, and nothing else. A hold with no `--until` stands until it
is released:

```console
$ team hold "freeze deploys" --until tomorrow ; echo "exit $?"
team hold: --until is a local <HH:MM>, or an ISO 8601 instant with Z or an offset, and nothing else
exit 1
$ team hold "freeze deploys" ; echo "exit $?"
hold: freeze deploys
exit 0
```

An agent-run CLI is refused, and so is the orchestrator's seat with no pane recorded for it — a
team the state never brought up:

```console caller=agent
$ team hold "freeze deploys" ; echo "exit $?"
team hold: only the owner, the orchestrator or the operator holds the team; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

```console caller=claude-keeper
$ team hold "freeze deploys" ; echo "exit $?"
team hold: no pane is recorded for seat claude-keeper in this session: a lead stops that seat and runs `team up`
exit 1
```
