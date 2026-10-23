# team down

Stops the team: asks every running seat the live file names to exit, closes its workspace, and
stops the herdr session — unless something was left in it: an agent still running at the end keeps
the session up, and the last line says it is not stopped and counts what is left in it. A pane herdr names with something the file does not carry is closed when
the state records that pane and that workspace for one seat, and left running when no seat record
accounts for it: the name is not what decides. A pane with no name is closed on that same record.
When the record also holds the process `up` launched, the pane is closed only while that process
is still in the pane. Any other such pane is left as it is and named. A seat is only asked when it
is free, so a working, blocked or half-typed seat is left running and named. A seat the file marks
`human: true` is left running with no exit line typed into it, even with `--abandon`: nothing is
typed into it; left running. A seat whose profile
says herdr cannot report it (`herdr_status: unreliable`) is free when the profile's own screen
reads idle, whatever herdr's status says, and it is stopped on its own exit key at that screen.
`--dry-run` prints the plan and runs nothing.

## Synopsis

    team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>] [--json]
    team down --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--wait] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | print the plan, and the refusals the real run would stop on; a run that reaches its plan runs nothing |
| `--wait` | — | give a working seat up to 120 seconds to come free; one that never does is left running, as without it |
| `--abandon` | — | the owner's: close the workspace of a seat that can't be asked, typing nothing into it; a seat this run asks and cannot stop is closed in the same run |
| `--session` | `<name>` | the herdr session to stop, instead of `team.session`; the owner's alone — a delegate is refused it by the gate |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone — a delegate is refused it by the gate |
| `--client` | `<grant-file>` | the client form: an owner-signed down grant for one team, see [A client's down grant](#a-clients-down-grant) |
| `--key` | `<client-key>` | the client's private key file, which proves the client holds the key the grant names; required with `--client`, refused without it |
| `--team` | `<team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | — | one `team.down` document instead of the working lines; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--abandon`, `--session` and `--file` are the owner's own |
| a run with no terminal | nothing, including `--dry-run`: ``team down: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane`` |
| the orchestrator's seat — and any seat the record marks a lead: the map's `leads` | stop the other seats; never the orchestrator's or the operator's own seat |
| the approved delegate, when the file's `delegates` section names it | stop the whole team, the orchestrator's and the operator's seats included; never `--abandon`, `--session` or `--file` |
| a client with no terminal that holds an owner-signed down grant for this team | stop the whole team the grant names, with `--client`; never `--abandon`, `--session` or `--file` |

## A client's down grant

A client with no terminal that the owner signed a down grant for (`team grant --client <id> --team
<team> --down`, or `--up --down` for one record that carries both; see
[team grant](grant.md#an-up-or-down-grant)) stops that one team with:

    team down --client ~/.config/team/grants/cg_<24 hex>.json --key ~/.config/team-client/<id>/client.key

Run it in the team's folder, or from anywhere with `--team <team>`. `--file`, `--session` and
`--abandon` are the owner's and are refused with `--client`; the run is bound to the folder the
owner signed. A folder of another team is refused; so is a team of the same name at another folder.
Before any step the run verifies, and refuses with the reason and the owner's next step when any
check fails:

1. the grant file is the owner-signed record in the grants folder, byte for byte, and its ops
   include `down` (a send grant is refused here, and so is an up-only grant, with the request that
   would add `down`);
2. it is not expired and not revoked;
3. the key file proves identity: the key is the one the grant names;
4. the team, its registry id and its real folder are the ones the grant binds, and the team's entity
   is still compatible with the grant's.

**A changed team file does not block `down`.** The up grant binds the fingerprints of the team file
the owner approved, so a new seat needs a new signature before the client can launch it. A stop is
different: the team has to be stoppable after its file changed, so `down` never compares
fingerprints. It also stays allowed when the folder's team file no longer loads, as long as the run
is made in the signed folder or names the team; the run's own file read then says what is wrong.
The identity checks above are never relaxed.

Then it runs as the owner's own stop of the whole team, with no terminal: it never prompts, and
closes the same seats the owner's `team down` would, the orchestrator's and the operator's seats
included. It reaches no other session, file, team or command, and it cannot abandon a seat.
`--dry-run` verifies the grant and prints the plan, and writes nothing. A team that is already
stopped answers `nothing to stop`, as for the owner.

A real run writes one line to the team's own log (`.agents/team.log`) once the grant verified:

    client-down-authorized: grant <cg_id> client <client-id> team <project> root <root> request <rid>

A refusal after the client's key proved identity writes `client-down-refused: grant <cg_id>:
<reason>`. A refusal before it (a wrong key, an unreadable grant) writes nothing, so a stranger
cannot fill the log. A run re-reads the grant under its lock before the first step, so a revocation
in the middle of a run ends it before anything is closed.

The `down.detached` refusal of a run with no terminal is unchanged for every caller that does not
present a grant; `--client` is the only way a caller with no terminal passes it. The grant is for
one team: a client that launched several teams needs a grant for each of them today.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seats it could stop were stopped | `<seat>: stopped` per seat; `session <session>: stopped and cleared` | 0 |
| a seat was left running — busy, blocked, at its own exit question, on an unreadable screen | its `  skip` line, and the last line naming it | 0 |
| there was nothing to stop | `session <session> is not running: nothing to stop` | 0 |
| `--dry-run` | the plan; `dry run: nothing was run` | the refusal's own exit, else 0 |
| the down grant, or the client run it admits, does not verify (`down.client-refused`) | `team down: <reason and the owner's next step>`; nothing ran | 1 |
| the run was refused, or a step was held | `team down: <reason>` for a refusal; a held step ends on its own line instead, `<seat>: left out: <reason>` | 1 |
| the invocation, the team file or herdr can't be read | `team down: <problem>` and the usage | 2 |

`--json` prints one `team.down` document instead: `project`, `session`, the seat names the file
declares as `seats`, the working lines as collapsed `notes`, and the closing line as
`action_summary`; `dry_run` is `false` and `status` is `stopped`. A session that is not running is
`status` `idle`, and every line it printed is a note. With `--dry-run` it prints the plan as
`plan` — the warning first when there is one, then one step per plan line, `prefix` `+`, `!` or
`skip` — with `dry_run` `true` and `status` `dry-run`. A refusal under `--json` prints the
`team.error` document on stdout — its `id` is the contract row for that refusal (`down.caller`,
`down.grant-scope`, …) — and nothing on stderr; a step that was held is the error document too,
`down.held`.

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
```

```fixture
agents: all
watch: alive
state:
  seats:
    claude-beacon: {stage: ready, cli: claude-code}
```

Two seats idle, a watch running: this is the whole plan. The watch is named and left running.

```console
$ team down --dry-run ; echo "exit $?"
watch: its pid is only in the state; left running
+ herdr --session beacon pane run w1:p1 /exit
  wait until claude-keeper's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w1
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ herdr session stop beacon
    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)
dry run: nothing was run
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/down.md](../internal/down.md).
