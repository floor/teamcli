# team list

Shows the herdr sessions on this machine: the running ones, unless `--all` is given. One row per
session. It can be run from any folder. It changes nothing — no session is started or stopped, no
pane is read, no team file or state is written.

## Synopsis

    team list [--all] [--json]

## What it reads and writes

Reads `herdr session list --json`, and for each session it keeps, that session's registry
(`<session_dir>/session.json`, for each workspace's `identity_cwd`) and, when the registry does not
name a team file, this machine's approval stores. A team file is `.agents/team.yaml` whose `session`
is the herdr session (an omitted `session` is the project name). A link standing in for the file is
not opened. For a running session it also reads `herdr agent list` — the roster, not a pane. A
stopped session is not asked for a roster.

It writes nothing.

A session with no team file is an orphan. A file that names the session but does not validate, a
roster that cannot be read, and a seat whose status herdr gives as `unknown` or not at all, show
`?`. None of those fail the list. When herdr cannot be asked, the command prints one sentence and
exits 0; `--json` prints `[]`.

## Who may run it

Anyone, from any folder. It needs no approval and no project of its own.

## Flags

| Flag | Meaning |
| --- | --- |
| `--all` | include stopped sessions; without it, only running sessions are listed |
| `--json` | print a JSON array, one object per row, valid when the array is empty |
| `--help`, `-h` | the usage, including the duplicate rule below, and exit 0 |

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

## Duplicates

A duplicate is two listed sessions whose team files resolve to the same directory: the real path of
the folder that holds `.agents`. The note is `same workspace as <the other sessions>`. The same
`project:` in two directories is two teams and is not flagged — two clones share a name and are not
the same checkout.

Session names that match after lowercasing and removing hyphens, underscores and dots are
near-duplicates (`md3-io` and `md3io`). The note is `near <the other sessions>`. A pair the
directory rule already names is not named again as near. A shared prefix is not enough:
`radiooooo` and `radiooooo-ios` are different names, and so are `teamcli` and `teamcli.io`.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the list was printed, including an empty list and herdr not answering |
| 2 | the arguments are not this command's |

## Examples

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

`--json` prints the same rows as an array. The keys are stable, and an empty list is `[]`:

```console
$ team list --json ; echo "exit $?"
[
  {
    "team": "beacon",
    "project": "beacon",
    "status": "running",
    "seats": "2",
    "activity": "2 idle",
    "note": ""
  }
]
exit 0
```

A stopped session is left out unless `--all` is set. Herdr not answering is not an error:

```console herdr=stopped
$ team list ; echo "exit $?"
no running sessions
exit 0
```

```console herdr=stopped
$ team list --all ; echo "exit $?"
TEAM    PROJECT  STATUS   SEATS  ACTIVITY  NOTE
beacon  beacon   stopped  2      -
exit 0
```

```console herdr=none
$ team list ; echo "exit $?"
herdr is not running
exit 0
```

```console herdr=none
$ team list --json ; echo "exit $?"
[]
exit 0
```

An option it does not know stops it before it reads anything:

```console
$ team list --nope ; echo "exit $?"
team list: unknown option --nope
Usage: team list [--all] [--json]

Run from any folder. Lists the herdr sessions on this machine, the running ones unless --all is given, and changes nothing.

A duplicate is two listed sessions whose team files resolve to the same directory, the real path of the folder that holds .agents. The same project name in two directories is two teams and is not flagged. Session names that match after lowercasing and removing hyphens, underscores and dots are near-duplicates. A pair the directory rule already names is not named again as near.
exit 2
```
