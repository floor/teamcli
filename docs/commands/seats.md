# team seats

Shows the seat registry for the team: one row per seat whose STATUS is not `stopped`, or every seat
when `--all` is given, with its stable seat handle (`seat_<12 hex>`), role, CLI, model, effort, status, last active time,
and pane.

## Synopsis

    team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to read, instead of `team.session`; the owner's |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's |
| `--all` | — | include the seats whose STATUS reads `stopped`; without it those rows are dropped, and every other state is listed either way |
| `--watch` | — | refresh the table every 2 seconds until interrupted |
| `--json` | — | print a JSON document (`format: 1`, `project`, `session`, `seats`) |
| `--help`, `-h` | — | the usage, and exit 0 |

## Columns

| Column | Meaning |
| --- | --- |
| SEAT | the seat name |
| ID | the stable seat handle (`seat_<12 hex>`), or `-` before first launch |
| ROLE | the seat's role (`temporary` when no declared seat matches) |
| CLI | the CLI profile (`claude-code`, `codex`, `cursor`, `antigravity`, `grok`) |
| MODEL | the live model reading or declared display |
| EFFORT | the effort level, or `-` when unset |
| STATUS | the seat's live state |
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
SEAT           ID                 ROLE         CLI          MODEL            EFFORT  STATUS   LAST ACTIVE  PANE
claude-keeper  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     missing  2m ago       -
exit 0
```

With `--all`, stopped seats are included:

```console
$ team seats --all ; echo "exit $?"
SEAT           ID                 ROLE         CLI          MODEL            EFFORT  STATUS   LAST ACTIVE  PANE
claude-keeper  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     missing  2m ago       -
claude-beacon  seat_fedcba987654  implementer  claude-code  Claude Opus 5.5  -       stopped  1h ago       -
exit 0
```
