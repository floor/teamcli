# team pause

A pause stops the team taking new work. It lives in the team state
(`.agents/team.state.json`), never in the team file: the file waits for the owner's approval, and a
stop that waits is no stop. While the record stands, `team next` claims nothing and `team watch`
sends no work — a push or a typed nudge — each seat that takes work being told once, when the
pause lands, to finish the step it is on. `team status` and `team seats` print the pause above
their rows. `team resume` clears it and restarts the queue.

The pause records a stop point for every declared seat that is not a human's: what the seat's
record held when the pause landed (its stage and last activity) and the worktree it was given (its
branch and folder). A human seat is never touched and records nothing.

## Synopsis

    team pause [<team>] [--reason <text>] [--all] [--json]
    team pause --client <grant-file> --key <client-key> [--team <team>] [--reason <text>] [--json]

## What it reads and writes

Reads the team file in the current folder, or the registered team `<team>` names, and the state
beside its file. With `--all`, it reads every team in the machine's registry. Writes one `pause`
record at the top level of the state:

    {
      "format": 1,
      "pause": {
        "by": "owner",
        "at": "2026-10-04T09:00:00.000Z",
        "reason": "freeze deploys",
        "stops": [
          { "seat": "claude-keeper" }
        ]
      },
      "sessions": {}
    }

`reason` is absent when `--reason` was not given. A stop point carries `stage`, `branch`, `path`
and `last_active` only when the tool holds them; a seat with no record and no worktree is a seat
name alone. Pausing under a pause writes nothing and is refused, naming the record in force. A
hand-edited value that is not the record this command writes is dropped when the state is read, so
it is never printed by any reader.

`--all` writes to every registered team it could read and names the ones it could not on `stderr`:
that team is left as it is, and the run goes on. A team named as `<team>` whose file does not load
is a refusal instead, because it is the only thing the run was for. Every target's caller is judged
before any state is written, so a run that refuses one team pauses none.

## Who may run it

The caller rule is narrower than `team hold`'s: the owner, or the team's own orchestrator running on
its own seat. The operator's lever is `team hold`, not a pause.

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | pause and resume |
| the team's orchestrator's seat, on the pane the state records for it | pause and resume |
| a run with no terminal | nothing: `team pause: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat` |
| any other seat, or an agent-run CLI | nothing: `team pause: only the owner or the orchestrator pauses the team; this call is <caller>` |
| the orchestrator's seat, when the state records no pane for it | nothing: `team pause: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` |
| the same seat on a pane the state doesn't record for it | nothing: `team pause: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` |

## Flags

| Flag | Meaning |
| --- | --- |
| `<team>` | a registered team's id, project or session name; without it, the team file of the current folder |
| `--reason <text>` | the line stored as the pause's reason |
| `--all` | every registered team; a team whose file does not load is named on `stderr` and left as it is |
| `--client <grant-file>` | the client form: an owner-signed developer bundle grant that carries `pause`, see [A client's pause](#a-clients-pause) |
| `--key <client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team <team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | emit a `team.pause` v1 JSON document (`schema/pause.schema.json`) on `stdout`; refused with `--all` |
| `--help`, `-h` | the usage, and exit 0 |

## A client's pause

A client with no terminal that the owner signed a **developer** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-developer-bundle)) pauses that one team with `team pause --client <grant-file> --key <client-key>`. The grant is verified whole before any gate, and again under the grant lock before the first effect; it must carry `pause` and name exactly this team, and the run is the one team the grant's folder holds: `<team>` and `--all` are the owner's and are refused with `--client` (exit 2). The run is the second door past the placement and who-may-run-it gates, never the owner's, and is logged as `client:<id>` and as `client-pause-authorized: …`. It is as graceful as the plain pause: ongoing work finishes and nothing is interrupted, only new work is withheld until `team resume`. A refusal is `pause.client-refused` (exit 1).

## Refusals

| Message | Exit |
| --- | --- |
| `team pause: unexpected "<word>"` (with the usage) | 2 |
| `team pause: --all takes no <team>` (with the usage) | 2 |
| `team pause: --all and --json can't be used together` (with the usage) | 2 |
| `team pause: --reason needs text` (with the usage) | 2 |
| `team pause: <why the team file did not load>` | 2 |
| `team pause: no team named "<team>" is registered on this machine` | 2 |
| `team pause: "<team>" names more than one team on this machine; name one by its id` | 2 |
| `team pause: no team is registered on this machine` (`--all`) | 2 |
| `team pause: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat` | 1 |
| `team pause: only the owner or the orchestrator pauses the team; this call is <caller>` | 1 |
| `team pause: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team pause: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team pause: already paused: <pause line>` | 1 |
| `team pause: <why the state or the registry could not be read or written>` | 1 |

## Exit codes

- `0` — the team was paused.
- `1` — it was refused: the caller may not pause the team, a pause already stands, the run has no
  terminal, or the state or the registry can't be read or written.
- `2` — the invocation can't be read, the team file can't, or `<team>` names no registered team or
  more than one.

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

The owner pauses the team with a reason; the stop point names the one declared seat, which has no
record yet. A second pause is refused by the record in force:

```console
$ team pause --reason "freeze deploys" ; echo "exit $?"
paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys
stop claude-keeper: no record
exit 0
$ team pause ; echo "exit $?"
team pause: already paused: paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys
exit 1
```

`team resume` clears it and prints the stop points it held; a resume with no pause is refused:

```console
$ team resume ; echo "exit $?"
resumed beacon (paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys)
stop claude-keeper: no record
exit 0
$ team resume ; echo "exit $?"
team resume: not paused
exit 1
```

An agent-run CLI is refused, and so is a declared seat with no pane recorded for it — a team the
state never brought up:

```console caller=agent
$ team pause ; echo "exit $?"
team pause: only the owner or the orchestrator pauses the team; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

```console caller=claude-keeper
$ team pause ; echo "exit $?"
team pause: no pane is recorded for seat claude-keeper in this session: a lead stops that seat and runs `team up`
exit 1
```
