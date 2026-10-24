# team remove

Takes one seat out of the team: asks it to exit, waits for its pane to come back to its shell,
closes its workspace, and edits the file so the seat is not started again. `--keep` leaves the seat
in the file as `stopped: true`; a seat that is busy — working, blocked at a prompt, at its own exit
question, on a screen the profile does not recognise, or holding unsent text — is left as it is,
unless its owner abandons it. A seat the file marks `human: true` leaves the file without its pane
being touched: nothing is typed into it; left running.

## Synopsis

    team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>] [--json]
    team remove <name> --client <grant-file> --key <client-key> --team <team> [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--keep` | — | leave the seat in the file with `stopped: true`: `team up` leaves it out, and `team add <name>` starts it again. On the orchestrator's or the operator's seat it is a swap: the file is not edited, the state records the swap, and `team add <name>` starts the new agent |
| `--abandon` | — | the owner's: close the workspace of a seat that can't be asked, typing nothing into it |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--client` | `<grant-file>` | the client form: an owner-signed manager bundle grant that carries `remove`, see [A client's remove](#a-clients-remove) |
| `--key` | `<client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team` | `<team>` | with `--client`, the team the grant is for; required |
| `--json` | — | one `team.remove` document instead of the closing line; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## A client's remove

A client with no terminal that the owner signed a **manager** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-manager-bundle)) removes a seat of
that one team with

    team remove spare --client ~/.config/team/grants/cg_<24 hex>.json --key ~/.config/team-client/<id>/client.key --team teamcli

`--team` is required. The grant is verified whole before the terminal check, which no client has a record for,
and again under the grant lock before the first effect; it must carry `remove` and name exactly this team.
Without `--client` the refusal below is unchanged. The run is never the owner's, and it is narrower than the
owner's: `--keep`, `--abandon`, `--file` and `--session` are refused with `--client` (exit 2), a seat marked
`human: true` is never removed, and the orchestrator and the operator are never removed (exit 1,
`remove.client-refused`). The approval record is not touched: the roster change is for the owner to approve with
the owner seat, and the closing line says so. Removing a seat does not end `team up --client`, because a removed
seat is no difference to the fingerprints the owner signed. The run is logged as `client-remove-authorized: …`.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--abandon`, `--session` and `--file` are the owner's own |
| a seat an active create-grant names by its own registry id | remove a named seat, for a file whose root and this call's folder both sit under the paths that record covers, before it expires; a lead seat, `--keep`, `--abandon`, `--session` and `--file` are not granted |
| a run with no terminal | nothing: ``team remove: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane`` — a caller outside herdr has no registry record, so no record admits it |
| the orchestrator's seat — and any seat the record marks a lead: the map's `leads` | remove another seat; never the orchestrator's or the operator's own seat, and never `--abandon` |
| the approved delegate, when the file's `delegates` section names it | remove a named seat; never `--keep`, `--abandon`, `--session` or `--file` |
| the orchestrator's seat, when the file's `grant` lists `swap` | `--keep` on the operator's seat (a swap) |
| the approved delegate whose entry lists `swap` | `--keep` on the orchestrator's or the operator's seat (a swap) |

### Swapping a lead seat

`team remove <lead> --keep`, then `team add <lead>`, replaces the agent on the orchestrator's or
the operator's seat — a new model, a new effort, a fresh process — without stopping the team.
The seat stays in the file, unedited, and stays the lead through the gap: a lead is never
`stopped: true`. The stop is an ordinary one — a working seat, a seat holding unsent text, a
prompt or an unrecognised screen is left as it is — and it is never the seat's own: closing its
pane would end the call before the new agent starts (`<name> can't swap its own seat`). The
owner may swap either lead; the orchestrator's seat may swap the operator's when the file's
`grant` lists `swap`; an approved delegate whose entry lists `swap` may swap either. The state
records who started the swap (`swapping`), `team doctor` names it until the seat runs again, the
log has one line for the stop and one for the start, and a granted or delegated swap adds its
audit line.

A caller other than the owner meeting a seat herdr reports idle or done that is not free takes the
seat out of the team and leaves its pane running: nothing typed, the workspace left open, the
pane's agent renamed so it no longer answers the seat's name.

A seat whose profile says herdr cannot report it (`herdr_status: unreliable`) is free when the
profile's own screen reads idle, so the owner's removal stops it on its profile's exit key as it
stops any free seat.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat was stopped, or was not running | `<seat>: stopped`, then `removed <name>` — or `stopped <name>` with `--keep`, `removed temporary <name>` for a temporary seat | 0 |
| a lead seat was stopped for a swap | `stopped <name> for a swap; the file still names it the orchestrator (or the operator): \`team add <name>\` starts its new agent` | 0 |
| a caller other than the owner took the seat out with its pane left running | `removed <name> (its pane <pane> was left running; nothing was typed; it now reads as <name>-left)` | 0 |
| the run was refused, or the seat was left behind | `team remove: <reason>`, and the file is not edited | 1 |
| the invocation, the team file or the state can't be read, or the edit would not validate | `team remove: <problem>` and the usage | 2 |

`--json` prints one `team.remove` document instead: `project`, `session`, the seat name as
`seat`, the working lines the stop printed as `notes`, and the closing line as `action_summary`;
`dry_run` is `false` and `status` says what the run did — `removed`, `kept` (`--keep`),
`temporary` (a temporary seat) or `swapped` (a lead seat stopped for `team add`). A refusal under
`--json` prints the `team.error` document on stdout — its `id` is the contract row for that
refusal (`remove.caller`, `remove.busy`, `remove.edit`, …) — and nothing on stderr; a stop that
could not be completed is `remove.stop-failed` (`remove.no-launch` when the call cannot reach
herdr at all).

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

  - role: implementer
    name: claude-reviewer
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: all
```

A seat mid-turn is not interrupted — its work would be lost — and `remove` says which state it was
in:

```console screens="claude-beacon=working"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon is working; left as it is
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/remove.md](../internal/remove.md).
