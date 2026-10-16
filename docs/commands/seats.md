# team seats

Shows the seat registry: one row per seat — every seat with `--all`, otherwise the running ones — with its stable
handle (`seat_<12 hex>`), role, CLI, model, effort, status, last active and pane. A flag the caller may not aim exits 1;
an unreadable invocation or team file, herdr not answering, or a caller that may not read this team exits 2.

## Synopsis

    team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session`, `--file` | `<name>`, `<path>` | the herdr session or team file to read, instead of `team.session` and `.agents/team.yaml`; the owner's |
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

The handle belongs to the seat, not to one run of it: it is minted at the seat's first launch or `team add`, and parked
in the state's `retained_seats` when the record goes away — `team down` and `team remove <seat> --keep` park it, and the
next `team up` or `team add <seat>` records the same handle again. A plain `team remove <seat>` drops it with the record.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | read the team, and aim the read with `--file` and `--session` |
| a seat of the team, placed in the file's session, on the pane the state records for it | read the team; a seat the state records no pane for, or records on another pane, fails closed |
| a pane outside the team that the approved file names in its `delegates` entries | read the team |
| anyone else | nothing: `team seats: this team is not yours to read`, exit 2. `--file` and `--session` aimed by anyone else are refused before any file or session is read, and exit 1 — `team seats: --file is the owner's, from a terminal outside herdr; this call is claude-keeper`, `team seats: --session is the owner's, from a terminal outside herdr; this call is claude-keeper` |

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

Without `--all`, stopped seats are omitted; with `--all`, they are included:

```console
$ team seats ; echo "exit $?"
SEAT           ID                 ROLE         CLI          MODEL            EFFORT  STATUS   LAST ACTIVE  PANE
claude-keeper  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     missing  2m ago       -
exit 0
$ team seats --all ; echo "exit $?"
SEAT           ID                 ROLE         CLI          MODEL            EFFORT  STATUS   LAST ACTIVE  PANE
claude-keeper  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     missing  2m ago       -
claude-beacon  seat_fedcba987654  implementer  claude-code  Claude Opus 5.5  -       stopped  1h ago       -
exit 0
```
