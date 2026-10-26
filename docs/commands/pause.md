# team pause

A pause stops a seat taking new work: the whole team's, or one seat's own. It lives in the team
state (`.agents/team.state.json`), never in the team file: the file waits for the owner's approval,
and a stop that waits is no stop. A team-wide pause stops every seat: `team next` claims nothing and
`team watch` sends no work — a push or a typed nudge — each seat that takes work being told once,
when the pause lands, to finish the step it is on. A per-seat pause, `team pause <seat>`, stops that
seat alone: it claims nothing and gets no work nudge, while the rest of the team keeps claiming and
being nudged. `team status` prints the pause, and each seat paused on its own, above their rows.
`team resume` clears the team's record, `team resume <seat>` one seat's; each leaves the other
standing.

The pause records a stop point for every declared seat that is not a human's: what the seat's
record held when the pause landed (its stage and last activity) and the worktree it was given (its
branch and folder). A per-seat pause records one stop point, for that seat. A human seat is never a
target and records nothing.

## Synopsis

    team pause [<name>] [--seat <seat>] [--team <team>] [--reason <text>] [--all] [--json]
    team pause --client <grant-file> --key <client-key> [--team <team>] [--reason <text>] [--json]

The first positional is resolved against the seats the current folder's team declares first, then
against the registered teams by name, project or id. A name that is both a declared seat and a
registered team is refused, and the explicit `--seat <name>` or `--team <team>` says which one was
meant. `team pause --seat <name>` is the explicit seat form even outside the folder's team;
`team pause --team <team>` is the explicit team-wide form.

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
name alone. A per-seat pause writes one entry in a top-level `seat_pauses` map instead, with one
stop point for that seat:

    {
      "format": 1,
      "seat_pauses": {
        "worker": {
          "by": "owner",
          "at": "2026-10-04T09:00:00.000Z",
          "stops": [{ "seat": "worker", "stage": "ready" }]
        }
      },
      "sessions": {}
    }

The team's `pause` and the `seat_pauses` map are independent: a seat may be paused while the team
is, and one record clearing leaves the other standing. Pausing under a pause on the same target
writes nothing and is refused, naming the record in force. A hand-edited value that is not the
record this command writes is dropped when the state is read, so it is never printed by any reader.

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
| `<seat>` | a seat the current folder's team declares; pauses that seat alone |
| `--seat <seat>` | the explicit seat form: the named seat of the current folder's team |
| `--team <team>` | the explicit team-wide form, even when a declared seat has that name; with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--reason <text>` | the line stored as the pause's reason |
| `--all` | every registered team; a team whose file does not load is named on `stderr` and left as it is; refused with `--seat`, `--team` and `--json` |
| `--client <grant-file>` | the client form: an owner-signed developer bundle grant that carries `pause`, see [A client's pause](#a-clients-pause) |
| `--key <client-key>` | the client's private key file; required with `--client`, refused without it |
| `--json` | emit a `team.pause` v1 JSON document (`schema/pause.schema.json`) on `stdout`; refused with `--all` |
| `--help`, `-h` | the usage, and exit 0 |

## A client's pause

A client with no terminal that the owner signed a **developer** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-developer-bundle)) pauses that one team with `team pause --client <grant-file> --key <client-key>`. The grant is verified whole before any gate, and again under the grant lock before the first effect; it must carry `pause` and name exactly this team, and the run is the one team the grant's folder holds: `<team>` and `--all` are the owner's and are refused with `--client` (exit 2). The run is the second door past the placement and who-may-run-it gates, never the owner's, and is logged as `client:<id>` and as `client-pause-authorized: …`. It is as graceful as the plain pause: ongoing work finishes and nothing is interrupted, only new work is withheld until `team resume`. A refusal is `pause.client-refused` (exit 1).

## Refusals

| Message | Exit |
| --- | --- |
| `team pause: unexpected "<word>"` (with the usage) | 2 |
| `team pause: --all takes no <team>` (with the usage) | 2 |
| `team pause: --all and --seat can't be used together` (with the usage) | 2 |
| `team pause: --all and --team can't be used together` (with the usage) | 2 |
| `team pause: --seat and --team can't be used together` (with the usage) | 2 |
| `team pause: --seat takes no positional name` (with the usage) | 2 |
| `team pause: --team takes no positional name` (with the usage) | 2 |
| `team pause: --all and --json can't be used together` (with the usage) | 2 |
| `team pause: --reason needs text` (with the usage) | 2 |
| `team pause: <why the team file did not load>` | 2 |
| `team pause: no team named "<team>" is registered on this machine` | 2 |
| `team pause: "<team>" names more than one team on this machine; name one by its id` | 2 |
| `team pause: "<name>" names both a seat of <project> and a registered team; use team pause --seat <name> or team pause --team <name>` | 2 |
| `team pause: no seat named "<name>" is declared in <project>` | 2 |
| `team pause: no seat named "<name>" is declared in <project>, and no registered team has that name` | 2 |
| `team pause: <name> is a human seat; a pause never touches it` | 2 |
| `team pause: no team is registered on this machine` (`--all`) | 2 |
| `team pause: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat` | 1 |
| `team pause: only the owner or the orchestrator pauses the team; this call is <caller>` | 1 |
| `team pause: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team pause: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team pause: already paused: <pause line>` (team-wide) | 1 |
| `team pause: already paused: <seat> (<pause line>)` | 1 |
| `team pause: <why the state or the registry could not be read or written>` | 1 |

## Exit codes

- `0` — the team, or the one seat, was paused.
- `1` — it was refused: the caller may not pause, a pause already stands, the run has no
  terminal, or the state or the registry can't be read or written.
- `2` — the invocation can't be read, the team file can't, or the name resolves to no seat and no
  registered team, or to more than one team.

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
