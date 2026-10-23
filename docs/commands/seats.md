# team seats

Shows the seat registry for the team: one row per seat whose STATUS is not `stopped`, or every seat
when `--all` is given, with its human name when the file writes one, its stable seat handle
(`seat_<12 hex>`), role, CLI, model, effort, status, state, last active time, and pane.

## Synopsis

    team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]
    team seats --client <grant-file> --key <client-key> [--team <team>] [--all] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's |
| `--client` | `<grant-file>` | the client form: an owner-signed manager bundle grant that carries `seats`; it reads that one team, as signed. `--file`, `--session` and `--watch` are refused with it. A refusal is `seats.client-refused` (exit 1) |
| `--key` | `<client-key>` | the client's private key file; required with `--client` |
| `--team` | `<team>` | with `--client`, the team the grant is for |
| `--all` | — | include the seats whose STATUS reads `stopped`; without it those rows are dropped, and every other state is listed either way |
| `--watch` | — | refresh the table every 2 seconds until interrupted |
| `--json` | — | print a JSON document (`format: 1`, `project`, `session`, `seats`), each seat carrying its own reading as `state` and `state_source`, and `blind: true` where it applies; a seat the daemon observes also carries `presence` — the canonical four-state word (`working`, `idle`, `waiting-for-a-person`, `gone`), its runtime source (`runtime-hook`, `runtime-event`, `daemon-launch`), the event and its `since` instant, and `live` — beside the legacy state word |
| `--help`, `-h` | — | the usage, and exit 0 |

## Columns

| Column | Meaning |
| --- | --- |
| SEAT | the seat name |
| NICKNAME | the seat's human name from the file ([`nickname`](../team-file.md#seats)), or `-` when it writes none |
| ID | the stable seat handle (`seat_<12 hex>`), or `-` before first launch |
| ROLE | the seat's role (`temporary` when no declared seat matches) |
| CLI | the CLI profile (`claude-code`, `codex`, `cursor`, `antigravity`, `grok`) |
| MODEL | the live model reading or declared display |
| EFFORT | the effort level, or `-` when unset |
| STATUS | the comparison's phrase for the seat against the session (`working`, `missing`, `stopped`, …) |
| STATE | the seat's own reading, best source first — `working`, `idle`, `done`, `blocked`, `held`, `unreachable` or `unknown`; an `unknown` past the blind threshold (five minutes shipped, tightened by the machine, an entity, a project, the team or the seat, and opened again only by a project) reads `unknown (blind)` |
| SOURCE | where that reading came from — `cli`, `presence`, `cli-hook`, `herdr`, `trace`, `process`, `hold` or `none`; `presence` is the daemon's reading of the seat's own turn events, its last known word when the route is not currently healthy, and `cli` is the screen's fallback classification, used only when no such reading exists |
| LAST ACTIVE | `now` when working, relative age (`2m ago`), or `-` |
| PANE | the herdr pane, or `-` when not running |

The handle belongs to the seat, not to one run of it. It is minted on the seat's first launch or
`team add`, and parked in the state's `retained_seats` when the record goes away: `team down` and
`team remove <seat> --keep` park it, and the next `team up` or `team add <seat>` records the same
handle again — so a seat that is stopped and started again comes back as itself. A plain
`team remove <seat>` drops the handle with the record, and the name starts over at its next launch.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the seats table or JSON document was printed |
| 1 | a flag the caller may not aim |
| 2 | the arguments or team file cannot be read, herdr does not answer, or the caller may not read this team |

## Example

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
  - role: coordinator
    name: claude-keeper
    nickname: agamemnon
    leads: true
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    effort: max
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    stopped: true
    launch: claude --model claude-opus-5-5
```

```fixture
agents: []
now: "2026-10-04T09:00:00Z"
state:
  retained_seats:
    claude-keeper:
      id: seat_0123456789ab
      last_active: "2026-10-04T08:58:00.000Z"
    claude-beacon:
      id: seat_fedcba987654
      last_active: "2026-10-04T08:00:00.000Z"
```

Without `--all`, stopped seats are omitted:

```console
$ team seats ; echo "exit $?"
team beacon, session "beacon"
SEAT           NICKNAME   ID                 ROLE         CLI          MODEL            EFFORT  STATUS   STATE  SOURCE   LAST ACTIVE  PANE
claude-keeper  agamemnon  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     missing  done   process  2m ago       -
1 seat
exit 0
```

With `--all`, stopped seats are included:

```console
$ team seats --all ; echo "exit $?"
team beacon, session "beacon"
SEAT           NICKNAME   ID                 ROLE         CLI          MODEL            EFFORT  STATUS   STATE  SOURCE   LAST ACTIVE  PANE
claude-keeper  agamemnon  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     missing  done   process  2m ago       -
claude-beacon  -          seat_fedcba987654  implementer  claude-code  Claude Opus 5.5  -       stopped  done   process  1h ago       -
2 seats
exit 0
```

`--json` prints the same registry as one document: each seat's `status` is the comparison's
phrase about the record, and its own reading — the table's `STATE` and `SOURCE` — rides beside it
as `state` and `state_source`, with `blind: true` only where it applies:

```console
$ team seats --json ; echo "exit $?"
{
  "schema": {
    "name": "team.seats",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "seats": [
    {
      "name": "claude-keeper",
      "nickname": "agamemnon",
      "id": "seat_0123456789ab",
      "role": "coordinator",
      "cli": "claude-code",
      "model": "Claude Opus 5.5",
      "effort": "max",
      "status": "missing",
      "state": "done",
      "state_source": "process",
      "last_active": "2026-10-04T08:58:00.000Z",
      "pane": null,
      "launch_line": "claude --model claude-opus-5-5"
    }
  ]
}
exit 0
```
