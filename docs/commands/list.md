# team list

Shows the herdr sessions on this machine: the running ones, unless `--all` is given. One row per
session. It can be run from any folder. It changes nothing — no session is started or stopped, no
pane is read, no team file or state is written. A session with no team file is an orphan, and
nothing about any row fails the list.

## Synopsis

    team list [--all] [--seats] [--watch] [--json]

## Flags

| Flag | Meaning |
| --- | --- |
| `--all` | include stopped sessions; without it, only running sessions are listed |
| `--seats` | show the active seat breakdown (`ready / working / waiting / stopped`) and seat rows per session |
| `--watch` | refresh the table every 2 seconds until interrupted |
| `--json` | print a JSON array, one object per row, valid when the array is empty |
| `--help`, `-h` | the usage, and exit 0 |

## Who may run it

Anyone, from any folder. It needs no approval and no project of its own. When herdr cannot be
asked, the command prints one sentence and exits 0; `--json` prints `[]`.

## Columns

| Column | Meaning |
| --- | --- |
| TEAM | the herdr session name |
| PROJECT | the team file's `project`, `-` for an orphan, `?` when a file names the session and its project cannot be read |
| STATUS | `running` or `stopped` |
| SEATS | how many seats the team file validates, the roster's length for an orphan that is running, `-` for a stopped orphan, `?` when the count cannot be read |
| ACTIVITY | the running roster, counted (`2 idle`, `1 working, 1 ?`), `-` when nothing is running or the roster is empty, `?` when the roster cannot be read |
| NOTE | `orphan`, `team file unreadable`, `roster unread`, `same workspace as <session>`, `near <session>` |

Rows are ordered by session name. Herdr's own `default` session is listed like any other: an orphan
when no team file names it, and hidden while it is stopped unless `--all` is set.

## Seat rows

`--seats` prints each running session's roster under its own row, indented two spaces, one line per
seat, with no header of its own: `name`, `id`, `status`, `cli`, `model`, `pane`. A value herdr and
the team file do not give is `-`, a status that cannot be read is `?`, and `status` is herdr's own
word with two changes: a blocked seat is `waiting`, and a seat the file declares that herdr does not
have is `stopped` — so every declared seat has a row. A stopped session has no roster and no rows.

With `--seats`, `ACTIVITY` is that roster counted by readiness, an `idle` or `ready` seat counting
as ready — `2 ready / 0 working / 0 waiting / 0 stopped` — and `--json` adds `roster` and
`active` to each object: the six shown fields per seat, plus `role`, `effort` and `last_active`
when the team file is read, `null` for what is not there. A session with no team file carries
fewer keys: `name`, `status`, `pane`.

## Duplicates

A duplicate is two listed sessions whose team files resolve to the same directory: the real path of
the folder that holds `.agents`. The note is `same workspace as <the other sessions>`. Names that
match after lowercasing and removing hyphens, underscores and dots are near-duplicates (`md3-io`
and `md3io`) and carry the note `near <the other sessions>`; a pair the directory rule already
names is not named again as near. What the rules do and do not catch, with the examples, stands on
the internal page.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the list was printed, including an empty list and herdr not answering |
| 2 | the arguments are not this command's |

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

The fixture's session is running, and both seats are idle:

```console
$ team list ; echo "exit $?"
TEAM    PROJECT  STATUS   SEATS  ACTIVITY  NOTE
beacon  beacon   running  2      2 idle
exit 0
```

`--seats` adds each session's running roster under its row:

```console
$ team list --seats ; echo "exit $?"
TEAM    PROJECT  STATUS   SEATS  ACTIVITY                                     NOTE
beacon  beacon   running  2      2 ready / 0 working / 0 waiting / 0 stopped
  claude-keeper  -  idle  -  -  -
  claude-beacon  -  idle  -  -  -
exit 0
```

A stopped session is left out unless `--all` is set, and herdr not answering is not an error. The
`--json` array, the stopped and absent-herdr readings, and the usage refusal's own text stand on
the internal page. What it reads and writes, the orphans and the `?` readings, the duplicate rules
in full, and the known limits: [docs/internal/list.md](../internal/list.md).
