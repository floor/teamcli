# team resume

`team resume` clears the pause that `team pause` placed and restarts the queue: `team next` claims
again and the watch dispatches work to idle seats again. It prints the record it removed, with
the stop points the pause held, so the lead knows where every seat stopped. A resume when no pause stands writes
nothing and is refused.

## Synopsis

    team resume [<team>] [--all] [--json]
    team resume --client <grant-file> --key <client-key> [--team <team>] [--json]

## What it reads and writes

Reads the team file in the current folder, or the registered team `<team>` names, and the state
beside its file. With `--all`, it reads every team in the machine's registry. It deletes the
top-level `pause` record from the state and writes nothing else:

    {
      "format": 1,
      "sessions": {}
    }

The plain run prints `resumed <project> (<pause line>)` and then one `stop <seat>: …` line per stop
point the record held. `--json` carries the same record in `resumed`. A team named as `<team>`
whose file does not load is a refusal; with `--all` such a team is named on `stderr` and left as it
is. Every target's caller is judged before any state is written, so a run that refuses one team
resumes none.

## Who may run it

The caller rule is `team pause`'s: the owner, or the team's own orchestrator running on its own
seat.

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | resume |
| the team's orchestrator's seat, on the pane the state records for it | resume |
| a run with no terminal | nothing: `team resume: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat` |
| any other seat, or an agent-run CLI | nothing: `team resume: only the owner or the orchestrator resumes the team; this call is <caller>` |
| the orchestrator's seat, when the state records no pane for it | nothing: `team resume: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` |
| the same seat on a pane the state doesn't record for it | nothing: `team resume: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` |

## Flags

| Flag | Meaning |
| --- | --- |
| `<team>` | a registered team's id, project or session name; without it, the team file of the current folder |
| `--all` | every registered team; a team whose file does not load is named on `stderr` and left as it is |
| `--client <grant-file>` | the client form: an owner-signed developer bundle grant that carries `resume`, see [A client's resume](#a-clients-resume) |
| `--key <client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team <team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | emit a `team.resume` v1 JSON document (`schema/resume.schema.json`) on `stdout`; refused with `--all` |
| `--help`, `-h` | the usage, and exit 0 |

## A client's resume

A client with no terminal that the owner signed a **developer** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-developer-bundle)) resumes that one team with `team resume --client <grant-file> --key <client-key>`. The grant is verified whole before any gate, and again under the grant lock before the first effect; it must carry `resume` and name exactly this team, and the run is the one team the grant's folder holds: `<team>` and `--all` are the owner's and are refused with `--client` (exit 2). The run is the second door past the placement and who-may-run-it gates, never the owner's, and is logged as `client:<id>` and as `client-resume-authorized: …`. A refusal is `resume.client-refused` (exit 1).

## Refusals

| Message | Exit |
| --- | --- |
| `team resume: unexpected "<word>"` (with the usage) | 2 |
| `team resume: --all takes no <team>` (with the usage) | 2 |
| `team resume: --all and --json can't be used together` (with the usage) | 2 |
| `team resume: <why the team file did not load>` | 2 |
| `team resume: no team named "<team>" is registered on this machine` | 2 |
| `team resume: "<team>" names more than one team on this machine; name one by its id` | 2 |
| `team resume: no team is registered on this machine` (`--all`) | 2 |
| `team resume: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat` | 1 |
| `team resume: only the owner or the orchestrator resumes the team; this call is <caller>` | 1 |
| `team resume: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team resume: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team resume: not paused` — `not paused: <project>` per team under `--all` | 1 |
| `team resume: <why the state or the registry could not be read or written>` | 1 |

## Exit codes

- `0` — the team resumed.
- `1` — it was refused: the caller may not resume the team, no pause stands, the run has no
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

A resume with no pause is refused; after a pause, it clears the record and prints what it held:

```console
$ team resume ; echo "exit $?"
team resume: not paused
exit 1
$ team pause --reason "freeze deploys" ; echo "exit $?"
paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys
stop claude-keeper: no record
exit 0
$ team resume ; echo "exit $?"
resumed beacon (paused since 2026-10-04T09:00:00.000Z by owner: freeze deploys)
stop claude-keeper: no record
exit 0
```

An agent-run CLI is refused:

```console caller=agent
$ team resume ; echo "exit $?"
team resume: only the owner or the orchestrator resumes the team; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```
