# team list

One row per herdr session on this machine, the running ones unless `--all` is given. Anyone may run
it from any folder; it needs no approval and changes nothing — no pane is read, no session is
started or stopped, nothing is written. An absent herdr or an empty list is not an error (`--json`
prints `[]`); only bad arguments exit 2.

## Synopsis

    team list [--all] [--seats] [--watch] [--json]

## Flags

| Flag | Meaning |
| --- | --- |
| `--all` | include stopped sessions; without it, only the running ones are listed |
| `--seats` | show the active seat breakdown (`ready / working / waiting / stopped`) and seat rows per session |
| `--watch` | refresh the table every 2 seconds until interrupted |
| `--json` | print a JSON array, one object per row, valid when the array is empty |
| `--help`, `-h` | the usage, and exit 0 |

## Columns

| Column | Meaning |
| --- | --- |
| TEAM | the herdr session name |
| PROJECT | the team file's `project`, `-` for an orphan, `?` when a file names the session and its project cannot be read |
| STATUS | `running` or `stopped` |
| SEATS | how many seats the team file validates, the roster's length for an orphan that is running, `-` for a stopped orphan, `?` when the count cannot be read |
| ACTIVITY | the running roster, counted (`2 idle`, `1 working, 1 ?`), `-` when nothing is running or the roster is empty, `?` when the roster cannot be read |
| NOTE | `orphan`, `team file unreadable`, `roster unread`, `same workspace as <session>`, `near <session>` |

Same-directory sessions carry `same workspace as <the other sessions>`; names equal after
lowercasing and dropping `-`, `_`, `.` (`md3-io`, `md3io`) carry `near <the other sessions>`.

## Seat rows

`--seats` prints each running session's roster under its own row, indented two spaces, one line per
seat: `name`, `id`, `status`, `cli`, `model`, `pane`. A value herdr and the team file do not give is
`-`, a status that cannot be read is `?`, and `status` is herdr's own word with two changes: a
blocked seat is `waiting`, and a seat the file declares that herdr does not have is `stopped` — so
every declared seat has a row. A stopped session has no roster and no rows.

`ACTIVITY` is that roster counted by readiness, an `idle` or `ready` seat counting as ready —
`2 ready / 0 working / 0 waiting / 0 stopped`. `--json` adds `roster` and `active` to each object:
the six shown fields per seat, plus `role`, `effort` and `last_active` when the team file is read,
`null` for what is not there. A session with no team file carries fewer keys: `name`, `status`,
`pane`.

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

The fixture's session is running, and both seats are idle; `--seats` adds the roster under its row:

```console
$ team list --seats ; echo "exit $?"
TEAM    PROJECT  STATUS   SEATS  ACTIVITY                                     NOTE
beacon  beacon   running  2      2 ready / 0 working / 0 waiting / 0 stopped
  claude-keeper  -  idle  -  -  -
  claude-beacon  -  idle  -  -  -
exit 0
```

The `--json` array, the other readings, the rules in full: [docs/internal/list.md](../internal/list.md).
