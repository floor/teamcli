# team resume

`team resume` clears the pause that `team pause` placed and restarts the queue: `team next` claims
again and the watch dispatches work to idle seats again. `team resume <seat>` clears only that
seat's own pause: it claims and is nudged again, while the rest of the team is untouched. It prints
the record it removed, with the stop points the pause held, so the lead knows where every seat
stopped. A resume when no pause stands on its target writes nothing and is refused.

A seat's resume leaves a standing team-wide pause in place and names it; a team-wide resume leaves
every `seat_pauses` record standing and prints each as `still paused: <seat> (<pause line>)`.

## Synopsis

    team resume [<name>] [--seat <seat>] [--team <team>] [--all] [--json]

The first positional is resolved against the seats the current folder's team declares first, then
against the registered teams, exactly as `team pause` resolves it; `--seat <name>` and
`--team <team>` are the explicit forms, and a name that is both is refused.

## What it reads and writes

Reads the team file in the current folder, or the registered team `<team>` names, and the state
beside its file. With `--all`, it reads every team in the machine's registry. It deletes the
top-level `pause` record from the state, or one entry of the top-level `seat_pauses` map, and
writes nothing else:

    {
      "format": 1,
      "sessions": {}
    }

The plain run prints `resumed <project> (<pause line>)` and then one `stop <seat>: …` line per stop
point the record held; for a seat it prints `resumed <seat> (<pause line>)` and that seat's stop.
`--json` carries the same record in `resumed`, with `target: "seat"` and the seat's name in
`value` for a seat, and `still_paused` naming seats a team-wide resume left standing. A team named
as `<team>` whose file does not load is a refusal; with `--all` such a team is named on `stderr`
and left as it is. Every target's caller is judged before any state is written, so a run that
refuses one team resumes none.

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
| `<seat>` | a seat the current folder's team declares; resumes that seat alone |
| `--seat <seat>` | the explicit seat form: the named seat of the current folder's team |
| `--team <team>` | the explicit team-wide form, even when a declared seat has that name |
| `--all` | every registered team; a team whose file does not load is named on `stderr` and left as it is; refused with `--seat`, `--team` and `--json` |
| `--json` | emit a `team.resume` v1 JSON document (`schema/resume.schema.json`) on `stdout`; refused with `--all` |
| `--help`, `-h` | the usage, and exit 0 |

## Refusals

| Message | Exit |
| --- | --- |
| `team resume: unexpected "<word>"` (with the usage) | 2 |
| `team resume: --all takes no <team>` (with the usage) | 2 |
| `team resume: --all and --seat can't be used together` (with the usage) | 2 |
| `team resume: --all and --team can't be used together` (with the usage) | 2 |
| `team resume: --seat and --team can't be used together` (with the usage) | 2 |
| `team resume: --seat takes no positional name` (with the usage) | 2 |
| `team resume: --team takes no positional name` (with the usage) | 2 |
| `team resume: --all and --json can't be used together` (with the usage) | 2 |
| `team resume: <why the team file did not load>` | 2 |
| `team resume: no team named "<team>" is registered on this machine` | 2 |
| `team resume: "<team>" names more than one team on this machine; name one by its id` | 2 |
| `team resume: "<name>" names both a seat of <project> and a registered team; use team resume --seat <name> or team resume --team <name>` | 2 |
| `team resume: no seat named "<name>" is declared in <project>` | 2 |
| `team resume: no seat named "<name>" is declared in <project>, and no registered team has that name` | 2 |
| `team resume: <name> is a human seat; a pause never touches it` | 2 |
| `team resume: no team is registered on this machine` (`--all`) | 2 |
| `team resume: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat` | 1 |
| `team resume: only the owner or the orchestrator resumes the team; this call is <caller>` | 1 |
| `team resume: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team resume: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team resume: not paused` — `not paused: <project>` per team under `--all`, `not paused: <seat>` for a seat | 1 |
| `team resume: the team is paused, not the seat; team resume clears the team` | 1 |
| `team resume: <why the state or the registry could not be read or written>` | 1 |

## Exit codes

- `0` — the team, or the one seat, resumed.
- `1` — it was refused: the caller may not resume, no pause stands on the target, the run has no
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
