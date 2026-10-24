# team seat

One seat as an object: the settings it holds and where each value comes from, the row `team seats`
reads for it (status, state, source, pane, last active), its last turn as the CLI hook wrote it,
and the newest session TeamCLI recorded for it in this session — the conversation, when it started
and ended, and its cost when one was measured. The read form reads the team file, the signed
settings records in the registry, the state, the session registry and the CLI hook; it writes
nothing. The seat's lifecycle verbs are grouped under
the same word and run the commands of their names.

The settings half is `team settings <seat>`; the status half is the seat's row in `team seats`. The
conversation is the newest registry record whose team, seat and herdr session are this one's; a seat
that has no record reads `-` for each conversation field and `unknown` for cost, never a guessed
value.

## Synopsis

    team seat <seat> [--session <name>] [--file <path>] [--json]
    team seat <seat> --client <grant-file> --key <client-key> [--team <team>] [--json]
    team seat add <seat>
    team seat remove <seat>
    team seat restart <seat>
    team seat rename <seat> <name>

## The grouped lifecycle

`team seat add`, `remove`, `restart` and `rename` run the commands of the same names — the same
handlers, with the words after the verb handed to them unchanged. The top-level commands stay as
aliases, and their options are theirs: a grouped verb takes that command's own flags (`--cli` on
`add`, `--keep` on `remove`, `--dry-run` on `restart`, `--renumber` on `rename`, and so on), and
`team add --help` and its siblings document them. The grouped verb prints that command's output and
returns its exit codes; the table below is for the read form. `seat` is not a seat name in the verb
position: `team seat add` is the lifecycle command, never a read of a seat called `add`.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's |
| `--client` | `<grant-file>` | the client form of the read: an owner-signed manager bundle grant that carries `seat`; it reads that one team. `--file` and `--session` are refused with it. A refusal is `seat.client-refused` (exit 1) |
| `--key` | `<client-key>` | the client's private key file; required with `--client` |
| `--team` | `<team>` | with `--client`, the team the grant is for |
| `--json` | — | print a JSON document (`format: 1`, `project`, `session`, `seat`, `settings`, `status`, `turn`, `conversation`, and `cost`/`tokens` when the record holds them); a setting a signed record wins adds `source_file` |
| `--help`, `-h` | — | the usage, and exit 0 |

## Fields

| Field | Meaning |
| --- | --- |
| `project`, `session`, `role`, `id` | the team, the herdr session, the seat's role, and its stable handle (`seat_<12 hex>`) or `-` before first launch |
| `status` | the comparison's phrase for the seat against the session |
| `state`, `source` | the seat's own reading and where it came from, as `team seats` prints them |
| `pane`, `last active` | the herdr pane and the age of the seat's last trace, or `-` |
| `turn` | the CLI hook's last boundary — `working since …` or `idle since …` — for a CLI that keeps one, inside the day; `-` otherwise |
| `conversation`, `cli session`, `resumable` | the newest recorded session's id, the CLI's own session id and whether the CLI keeps it to resume |
| `started`, `ended` | when that session started and ended, or `-` |
| `cost` | the measured or estimated cost the record holds, or `unknown` |

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the seat was printed |
| 1 | an owner-only flag was refused, the team file declares no seat of that name, or the session registry cannot be read |
| 2 | the invocation, the team file, herdr, or a signed settings record cannot be read |

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
```

```fixture
agents: none
now: "2026-10-04T09:00:00Z"
state:
  retained_seats:
    claude-keeper:
      id: seat_0123456789ab
      last_active: "2026-10-04T08:58:00.000Z"
sessions:
  - seat: claude-keeper
    started: "2026-10-04T08:30:00Z"
    ended: "2026-10-04T08:50:00Z"
    reason: restart
    cli_session: cli-1
    cost:
      amount: 1.2
      currency: USD
      source: measured
    tokens:
      in: 100
      out: 20
      source: measured
```

The seat has no live agent and a recorded session that ended as a restart:

```console
$ team seat claude-keeper ; echo "exit $?"
  KEY             VALUE                   SOURCE     APPLIES
  model           Claude Opus             team file  restart that resumes
  effort          max                     team file  restart that resumes
  nickname        agamemnon               team file  at once
  delivery_order  mcp-inbox, typed, drop  default    at once
  human           false                   default    at once

  FIELD         VALUE
  project       beacon
  session       beacon
  role          coordinator
  id            seat_0123456789ab
  status        missing
  state         done
  source        process
  pane          -
  last active   2m ago
  turn          -
  conversation  ses_000000000001
  cli session   cli-1
  resumable     yes
  started       2026-10-04 08:30Z
  ended         2026-10-04 08:50Z
  cost          1.2 USD
exit 0
```

`--json` carries the same readings, and omits `cost` and `tokens` for a record that holds neither:

```console
$ team seat claude-keeper --json ; echo "exit $?"
{
  "schema": {
    "name": "team.seat",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "seat": "claude-keeper",
  "settings": [
    {
      "key": "model",
      "value": "Claude Opus",
      "source": "team file",
      "applies": "restart-resume"
    },
    {
      "key": "effort",
      "value": "max",
      "source": "team file",
      "applies": "restart-resume"
    },
    {
      "key": "nickname",
      "value": "agamemnon",
      "source": "team file",
      "applies": "at-once"
    },
    {
      "key": "delivery_order",
      "value": [
        "mcp-inbox",
        "typed",
        "drop"
      ],
      "source": "default",
      "applies": "at-once"
    },
    {
      "key": "human",
      "value": false,
      "source": "default",
      "applies": "at-once"
    }
  ],
  "status": {
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
  },
  "turn": null,
  "conversation": {
    "id": "ses_000000000001",
    "cli_session": "cli-1",
    "resumable": true,
    "started": "2026-10-04T08:30:00Z",
    "ended": "2026-10-04T08:50:00Z",
    "reason": "restart"
  },
  "cost": {
    "amount": 1.2,
    "currency": "USD",
    "source": "measured"
  },
  "tokens": {
    "in": 100,
    "out": 20,
    "source": "measured"
  }
}
exit 0
```

A name the team file does not declare is refused before any pane is read:

```console
$ team seat ghost ; echo "exit $?"
team seat: no seat "ghost" is declared in beacon
exit 1
```
