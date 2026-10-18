# team drops

Lists the drop files waiting in the calling seat's own drop folder. A drop is what another
seat's `team send` writes under `.agents/send-drops/<session>/<seat>/` when its delivery ends on
the drop leg: the file is one signed message record — the sender, the rule that admitted it, the
thread, and the body — and the file is the message. `team drops` reads the folder and never
moves, deletes, or marks a drop. `team drops --follow` prints each drop that appears while it
runs, one line per file, so a Claude Code Monitor in the receiving seat can turn each arrival
into a notification.

A receipt beside a drop says it was handed over, and a drop with one is read and not listed:
the seat's inbox server writes `<id>.read.json` when an `inbox_read` call returns the message,
and it is the same signed status receipt `team messages` writes, signed with the checkout's
message key. `team drops` verifies it; a file at that name the key did not sign, or one naming
another message, seat, checkout or session, proves nothing and the drop is still listed.

## Synopsis

    team drops [--follow] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--follow` | — | keep reading the folder and print one line per new drop, `from <sender> — <path>`, flushed as each is read; Ctrl-C stops it and exits 0 |
| `--json` | — | print one `team.drops` document (`format: 1`, `project`, `session`, `seat`, `drops`, `counts`) |
| `--help`, `-h` | — | the usage, and exit 0 |

`--follow` and `--json` can't be used together: a follow is a stream of lines, not one document.

## What it reads and writes

Reads `.agents/team.yaml` to resolve the project, the session, and the calling seat, then reads
`.agents/send-drops/<session>/<seat>/`. A drop's file name is the send's id. A record's payload
names its sender; a raw body file an earlier build wrote still names one on its first line.
Names with a dot in them — `<id>.pending`, `<id>.taken`, `<id>.read.json`,
`<id>.<hex>.tmp` — are sidecars, not drops, and are not listed. Nothing is written
or removed, and the folder is not created: a folder that does not exist yet is an empty one.

## Who may run it

Only the seat itself, on the pane the state records for it: a drop folder is one seat's mailbox,
and the command answers from the caller's own placement. The owner, another seat, and a seat
running on another pane are refused. `--follow` runs until it is stopped, so it belongs to the
receiving seat and is not a command a lead runs for someone else.

## Output and exit codes

A reading prints the context line (`team <project>, session "<session>"`), the table `FROM  PATH`
with one row per waiting drop, then one summary line, `<n> drop` or `<n> drops`. `FROM` is the
sender the record names — `the owner`, a seat's name, or a registered name — or, in a raw body
file an earlier build wrote, the sender its first line names. It reads `unknown` when there is
neither, and when a record does not verify against the message key. `PATH` is the file's absolute
path.

A follow prints nothing at start: the drops already on disk are waiting, not new. Then it prints
one line, `from <sender> — <path>`, for each drop that appears, and Ctrl-C stops it with exit 0.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the folder was read | the context line, the `FROM  PATH` table, and `<n> drop` or `<n> drops` | 0 |
| a follow ran and was stopped | the lines of the drops that appeared, and nothing else | 0 |
| the caller is not a placed seat of this team | `team drops: only a seat of this team reads its own drops; this call is <caller>`, or the no-pane / another-pane refusal | 1 |
| the team file can't be read, or the drop folder can't be read | `team drops: <problem>` | 1 |
| the invocation can't be read, `--follow` and `--json` are both given, or this folder is not a git repository | `team drops: <problem>`, with the usage for the invocation | 2 |

The `--json` document is `{"schema": {"name": "team.drops", "version": 1}, "format": 1, "project": …, "session": …, "seat": …, "drops": [{"from": …, "received": …, "path": …}], "counts": {"drops": …}}`.
`received` is the file's modification time, ISO 8601.

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
```

Nothing has arrived yet:

```console caller=claude-keeper
$ team drops ; echo "exit $?"
team beacon, session "beacon"
  FROM  PATH

0 drops
exit 0
```

A drop the orchestrator sent:

```file file=.agents/send-drops/beacon/claude-keeper/3b3e9a27-e222-4e2e-90d9-95f4273e319d
from agt_d18cddafed22 (orchestrator, orchestrator@5e46a02374b3) — admitted by: an orchestrator or operator to a seat of its own team

orchestrator: read the review note, then report.
```

```console caller=claude-keeper
$ team drops ; echo "exit $?"
team beacon, session "beacon"
  FROM          PATH
  orchestrator  ./.agents/send-drops/beacon/claude-keeper/3b3e9a27-e222-4e2e-90d9-95f4273e319d

1 drop
exit 0
```

A raw body file an earlier build wrote, with no sender header, is still a drop, and its sender
reads `unknown`:

```file file=.agents/send-drops/beacon/claude-keeper/0a5b7c1d-8e2f-4a6b-9c3d-1e2f3a4b5c6d
an older build left this body with no sender line
```

```console caller=claude-keeper
$ team drops ; echo "exit $?"
team beacon, session "beacon"
  FROM          PATH
  orchestrator  ./.agents/send-drops/beacon/claude-keeper/3b3e9a27-e222-4e2e-90d9-95f4273e319d
  unknown       ./.agents/send-drops/beacon/claude-keeper/0a5b7c1d-8e2f-4a6b-9c3d-1e2f3a4b5c6d

2 drops
exit 0
```

The owner is refused: the folder is a seat's own mailbox.

```console caller=owner
$ team drops ; echo "exit $?"
team drops: only a seat of this team reads its own drops; this call is owner
exit 1
```
