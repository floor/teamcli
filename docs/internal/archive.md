# `team archive`: rationale and known limits

What moved off [the `team archive` page](../commands/archive.md): what the run reads and writes,
the folder and its manifest in full, the refusals in their own words, and the known limits. The
synopsis, the flags, the caller table and the exit codes stay on the page.

## Why the snapshot comes first

The archive records the team as it was, so it is written before anything is stopped: the state
the folder holds is the one the stop had not yet touched. The stop itself is `team down`, the
same function with the same sources, so its caller gates, its refusals, its waits and its exit
codes are that command's own — including a stop that is refused, which leaves the snapshot where
it was written. `--keep-running` is for the other need: the file, the state and the queues taken
without stopping anything, which is what the owner used to do by hand.

## What it reads and writes

Reads the team file and its root (through the loader, so `--file` and a folder outside a
repository behave as they do for every command), the state beside it, and the queues' tree under
`.agents/send-drops/`. Writes the archive folder: `<out>/<project>-<root hash>-<UTC stamp>/`,
mode 0700, holding `team.yaml` and, when they exist, `team.state.json` and `send-drops/`, all
mode 0600, and `manifest.json` mode 0600. It never writes the state back, so archiving a live
team changes nothing the team reads. `--dry-run` writes nothing at all, not even a log line, and
prints `down`'s plan in place of its run.

The folder's name is `storePath(project, root, home)`'s own name — the store folder's basename,
a hash of the project's path — with `-<stamp>` appended, the stamp being `now.toISOString()` with
`-` and `:` dropped and the milliseconds removed, so `20261004T090000Z`. Two checkouts of one
project land on different folders; two runs of the same second name the same one, and a folder
that exists is refused, never merged into.

## The manifest

`manifest.json` is the archive's one machine-read file, `format: 1`, `kind: teamcli-archive`,
with `project`, `session`, `root`, `stampedAt`, `by` (the caller, as `describeCaller` prints
it), and `teamcli` (the release that wrote the archive). `team` and `state` carry each file's
`sha256` and `bytes`; `drops` carries the file count per seat — `<session>/<seat>` keys — not a
tree hash, so a queue that grew an entry reads as a count, not as a wrong archive. Only `team`'s
sha256 is verified today: `team init --from-archive` reads the file's bytes and refuses anything
that does not match it. Everything else is the record of what the run saw.

A team that never launched has no state file, and one no message reached has no `send-drops`
folder: the archive holds neither, and the manifest records `null` for it. Links are never
followed into the archive: `filesUnder` reads a file's own `lstat`, so a symlink, a socket, a
fifo or a folder in a queue's place is skipped, never copied and never read through. The send
daemon's own copy of the drops, under the store, is not what this command archives: the clone's
queues are.

## Refusals

| Message | Exit |
| --- | --- |
| `team archive: only the owner runs this, from a terminal outside herdr` — a run with no terminal | 1 |
| `team archive: --out is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team archive: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team archive: --wait, --abandon and --session are the stop's; --keep-running takes the snapshot alone. Drop --keep-running to stop the team.` | 2 |
| `team archive: <folder> exists already: an archive is never overwritten` | 1 |
| `team archive: not inside a git repository: run team from a project, or pass --file` | 2 |
| `team archive: line <n>: <the loader's own message>` — the team file doesn't load | 2 |
| `team archive: unknown option --<name>` (with the usage) | 2 |

## Known limits

- The state and the queues are archived and never restored. `team init --from-archive` writes
  the team file alone and names what else the archive holds. State records panes, worktrees and
  readings of one machine, so restoring it into another would plant that machine's runtime.
- The caller gate is `down`'s, and it comes after the snapshot: a seat the stop then refuses
  still has an archive written, into the user's own store folder by default. `--out` and `--file`
  are the owner's alone.
- `--out` naming a folder inside a checkout puts a copy of the private team file where git may
  see it. The writer does not touch `.git/info/exclude`: the default folder, under the user's
  store, is the one outside every repository.
- An archive is a copy, not a backup: nothing prunes old folders, and nothing checks that a
  restored team file still fits the machine it lands on. The restore validates the file, and the
  placement is the owner's to repair.
