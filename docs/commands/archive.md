# team archive

Snapshots the team as it is — the team file, the state and the send queues — into one archive
folder, then stops the team. The stop is [team down](down.md) itself, in the same run: its
refusals, its waits and its exit codes are that command's own, and a stop it refuses leaves the
snapshot where it was written. `--keep-running` takes the snapshot alone. Every run writes a new
folder: an archive is never overwritten.

`team archive --seat <seat> --older-than <dur>` is the scoped move: it takes one seat's
acknowledged message families — and the plain-text drops an earlier build wrote — out of the trees
a bus pass re-reads, into their own dated archive, with a sha256 manifest. Nothing is deleted, the
team keeps running, and only the owner or a seat this team marks `leads` runs it.

## Synopsis

    team archive [--out <folder>] [--keep-running] [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]
    team archive --seat <seat> --older-than <dur> [--dry-run] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--out` | `<folder>` | where the archive folder goes, instead of `~/.config/team/archive`; the owner's alone |
| `--keep-running` | — | the snapshot alone: the stop is skipped. With it, `--wait`, `--abandon` and `--session` are refused rather than quietly ignored |
| `--dry-run` | — | print both halves' plans — the archive's and the stop's — and write nothing |
| `--wait`, `--abandon`, `--session`, `--file` | — | the stop's own flags, handed to `down` unchanged; `--session` and `--file` are the owner's alone |
| `--seat` | `<seat>` | the scoped form: the seat of this team whose message families are moved |
| `--older-than` | `<dur>` | the scoped form's window, `90m`, `12h`, `7d` or `30s`, read from the newest file of each family |
| `--help`, `-h` | — | the usage, and exit 0 |

The scoped form takes `--seat`, `--older-than`, `--dry-run` and `--file` only: `--out`,
`--keep-running`, `--wait`, `--abandon` and `--session` describe the whole-team snapshot and the
stop, and are refused with it rather than quietly ignored.

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

## The scoped move

One *family* is a message record and every sidecar beside it: its `held`, `delivered`, `read`,
`replied` and `closed` receipts, its bookkeeping markers, and its fallback record. The record must
verify against this checkout's message key and name the seat, the session and this checkout; a
`read` or `replied` receipt must verify before the family is due. A family is pre-checked whole
before anything moves: every source must be readable without following a link and every
destination name free, so a refusal leaves the family where it is. Its files are then renamed one
at a time; a failure part way is reported, what moved stays moved, and the manifest holds exactly
the files that moved. A file is never unlinked.

The scoped move reads the same trees the bus does, and writes beside them, dated by the run's day:

```text
.agents/send-drops-archive/<YYYY-MM-DD>/<session>/<seat>/   record first, then its sidecars
.agents/messages-archive/<YYYY-MM-DD>/<seat>/               the earlier store: receipt first
.agents/archive-manifests/<YYYY-MM-DD>/manifest-<stamp>.tsv   one row per moved file
```

The manifest holds one header line and one row per moved file — sha256, byte count, and the
source and destination paths relative to the checkout — and is written only after something
moved. A dry run prints the count it would move and writes nothing: no folder, no manifest, no
receipt. One family's failure is reported on stderr and the rest of the run continues.

A plain-text drop an earlier build wrote where a record would be has no record, no receipt and no
reader: it moves whole, alone, and is never served or acknowledged. The general seat brief, a
client's record, a family a handoff has pending or taken, an unread or delivered-only family, a
family newer than the window, and one that does not verify always stay where they are. They are
counted on the summary as `stay <reason>: <count>`.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it, and the stop it ends with; `--out` and `--file` are the owner's own |
| the orchestrator's or the operator's seat | the snapshot, and then the stop `down` allows that seat |
| any other seat | the snapshot alone: `down` refuses the stop afterwards, in its own words, and the archive stays where it was written |
| a run with no terminal | nothing, before anything is written: `team archive: only the owner runs this, from a terminal outside herdr` |
| the owner or a seat this team marks `leads`, scoped form | the move of one seat's due families; the same admission `team ack --seat` asks |
| any other seat, scoped form | nothing: `team archive: only the owner or a seat this team marks \`leads\` moves another seat's messages` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the snapshot was written, and the stop ran | `archived <folder>:` and one line per entry, then the stop's own output | the stop's own exit, 0 when it stops the team |
| `--keep-running` | the lines above, then `--keep-running: the stop is skipped.` | 0 |
| `--dry-run` | `would archive to <folder>:`, its entries, `dry run: nothing was archived`, then the stop's plan | the stop's own dry-run exit: the refusal's own exit, else 0 |
| the folder exists already | `team archive: <folder> exists already: an archive is never overwritten` | 1 |
| the caller, `--out` or `--file` is refused | `team archive: <reason>` | 1 |
| the invocation or the team file can't be read | `team archive: <problem>`, with the usage for a bad option | 2 |
| scoped, every due family moved | `seat <seat>, older than <dur>: <n> family(ies) moved (<f> files)`, one `stay <reason>: <count>` line per reason, then `manifest: <path>` | 0 |
| scoped, nothing was due | `seat <seat>, older than <dur>: nothing to move` | 0 |
| scoped, a family could not move | the summary and `team archive: <reason>` on stderr for each family left in place | 1 |
| scoped, refused | `team archive: only the owner or a seat this team marks \`leads\` moves another seat's messages; this call is <caller>` on stderr | 1 |

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
