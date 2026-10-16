# team brief

Hands a seat its brief and records it. `team brief <seat> <file>` copies the file once into the
team's brief folder, so a later edit of the file does not change what the seat was given. It
writes the seat's record, then delivers the brief's text through [team send](send.md): the same
drop file, the same one trigger line, the same outcomes. The seat marks the brief finished with
`team brief --done`, and `team brief --list` shows where every seat stands.

## Synopsis

    team brief <seat> <file> [--dry-run] [--json]
    team brief --done [--seat <name>] [--summary <text>] [--json]
    team brief --list [--json]

## What it reads and writes

Reads the team file in the current folder and `<file>`. The file is opened without following a
link, and is refused when it is a link, not a regular file, empty, not UTF-8 text, or over
262,144 bytes. Nothing is written for a refused file.

Writes, under `.agents/briefs/<session>/<seat>/`, a snapshot `<id>.md` (mode 0600, in folders of
mode 0700) and `current.json`, the seat's one record: the id, the file's name (not its path),
its SHA-256, who handed it and when, and its status. The status is `assigned` while the brief is
handed over, then `delivered`, `held`, `unreachable` or `refused` as `team send` answers, and
`done` once the seat says so. A new brief replaces the seat's record; the earlier snapshot stays.
Each outcome appends one line to the team log.

`--done` writes `done`, the time, who said it, and an optional one-line `--summary` (control
bytes removed, at most 280 characters). `--list` writes nothing.

## Who may run it

| Caller | `<seat> <file>` | `--done` | `--list` |
| --- | --- | --- | --- |
| the owner, from a terminal outside herdr | yes | any seat, with `--seat` | yes |
| the orchestrator, from its own seat | yes | any seat, with `--seat` | yes |
| a seat, from its own recorded pane | no | its own brief | yes |
| a run with no terminal | no | no | yes |

`<seat> <file>` asks the same question `team send` does, so a seat that may not send may not
hand a brief. A seat must be the pane the state records for it to mark its own brief done.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the brief was handed and the seat took it | `<seat>: briefed (<id>, <digest>)` | 0 |
| `--dry-run` | `<seat>: would hand <file> (<digest>) through team send; nothing was written` | 0 |
| `--done` | `<seat>: marked done` | 0 |
| `--list` | one row per seat: name, status (`none` until handed), file name, age, summary | 0 |
| the seat held it: busy, locked, in a dialog, or an unsent draft | `team brief: <seat>: held: <why>`. The brief is recorded; the same command sends it again | 1 |
| the seat was not reached | `team brief: <seat>: unreachable: <why>`. The brief is recorded | 1 |
| `team send` refused after the record was written | `team brief: <seat>: refused: <why>`. The brief is recorded | 1 |
| nothing was handed: a caller that may not, an undeclared seat, a brief file that cannot be taken, or no active brief to mark done | `team brief: refused: <why>` | 1 |
| a run with no terminal | `team brief: only the owner runs this, from a terminal outside herdr` | 1 |
| the invocation can't be read, or the team file or brief folder can't be used | `team brief: <problem>`, with the usage for a bad invocation | 2 |

With `--json`, each outcome is one document: `seat`, `status`, `exit`, and `id`, `sha256` or
`error` where they apply. `--list --json` is an array of `seat`, `status`, `brief`, `id`,
`assigned_at` and `summary`.

## Not in this build

`--worktree` pairing and `--wait` are not here. The orchestrator is not told when a seat marks
its brief done: a seat may not send, so the word is the record and the log line, read with
`team brief --list`. The watch does not report it yet.
