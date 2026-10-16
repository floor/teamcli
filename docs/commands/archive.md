# team archive

Snapshots the team as it is — the team file, the state and the send queues — into one archive
folder, then stops the team. The stop is [team down](down.md) itself, in the same run: its
refusals, its waits and its exit codes are that command's own, and a stop it refuses leaves the
snapshot where it was written. `--keep-running` takes the snapshot alone. Every run writes a new
folder: an archive is never overwritten.

## Synopsis

    team archive [--out <folder>] [--keep-running] [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--out` | `<folder>` | where the archive folder goes, instead of `~/.config/team/archive`; the owner's alone |
| `--keep-running` | — | the snapshot alone: the stop is skipped. With it, `--wait`, `--abandon` and `--session` are refused rather than quietly ignored |
| `--dry-run` | — | print both halves' plans — the archive's and the stop's — and write nothing |
| `--wait`, `--abandon`, `--session`, `--file` | — | the stop's own flags, handed to `down` unchanged; `--session` and `--file` are the owner's alone |
| `--help`, `-h` | — | the usage, and exit 0 |

## The archive folder

Written under `--out` — `~/.config/team/archive` by default — as
`<project>-<root hash>-<UTC stamp>/`: the user store's folder name, one segment deeper, with the
moment the snapshot was taken. The hash is the project path's, so two checkouts of one project
archive side by side, and the stamp is to the second, so two runs of one second name the same
folder, which is refused, never overwritten.

```text
beacon-5e46a02374b3-20261004T090000Z/
  team.yaml           the team file, verbatim, mode 0600
  team.state.json     the state, verbatim, when there is one
  send-drops/         the queues, verbatim: <session>/<seat>/<id>
  manifest.json       what the archive is, and the hash a restore verifies
```

The manifest is `format: 1`, `kind: teamcli-archive`, and names the project, the session, the root
and the moment it was taken, who ran it, the teamcli that wrote it, the team file's and the
state's sha256 and byte count, and the queues' file count per seat. A team that never launched has
no state and no queues, and its archive holds neither. Links are never followed into the archive:
a link where a file would be is skipped, never copied and never read through. A folder that
already exists is refused, never merged into.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it, and the stop it ends with; `--out` and `--file` are the owner's own |
| the orchestrator's or the operator's seat | the snapshot, and then the stop `down` allows that seat |
| any other seat | the snapshot alone: `down` refuses the stop afterwards, in its own words, and the archive stays where it was written |
| a run with no terminal | nothing, before anything is written: `team archive: only the owner runs this, from a terminal outside herdr` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the snapshot was written, and the stop ran | `archived <folder>:` and one line per entry, then the stop's own output | the stop's own exit, 0 when it stops the team |
| `--keep-running` | the lines above, then `--keep-running: the stop is skipped.` | 0 |
| `--dry-run` | `would archive to <folder>:`, its entries, `dry run: nothing was archived`, then the stop's plan | the stop's own dry-run exit: the refusal's own exit, else 0 |
| the folder exists already | `team archive: <folder> exists already: an archive is never overwritten` | 1 |
| the caller, `--out` or `--file` is refused | `team archive: <reason>` | 1 |
| the invocation or the team file can't be read | `team archive: <problem>`, with the usage for a bad option | 2 |

## Example

The team this runs against, with one message still queued for a seat:

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

```file file=.agents/send-drops/beacon/claude-beacon/9c1f2ab4-77d1-4e02-9a3c-2f5e0c8b1d44
the gate is green
```

```fixture
agents: all
watch: alive
state:
  seats:
    claude-beacon: {stage: ready, cli: claude-code}
```

`--dry-run` prints both halves' plans and writes nothing:

```console
$ team archive --dry-run ; echo "exit $?"
would archive to ~/.config/team/archive/beacon-<hash>-20261004T090000Z:
  team.yaml
  team.state.json
  send-drops (1 file)
dry run: nothing was archived
would stop the team:
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

Without `--dry-run` the folder is written first, and then the stop runs:

```console
$ team archive ; echo "exit $?"
archived ~/.config/team/archive/beacon-<hash>-20261004T090000Z:
  team.yaml
  team.state.json
  send-drops (1 file)
watch: its pid is only in the state; left running
claude-keeper: stopped
claude-beacon: stopped
session beacon: stopped and cleared
exit 0
```

`--keep-running` takes the snapshot alone — the team keeps running, nothing is stopped — and
`--out` puts that folder wherever it is told; a relative path is the caller's own folder:

```console
$ team archive --keep-running --out archives ; echo "exit $?"
archived ./archives/beacon-<hash>-20261004T090000Z:
  team.yaml
  team.state.json
  send-drops (1 file)
--keep-running: the stop is skipped.
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/archive.md](../internal/archive.md).
