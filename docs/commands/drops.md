# team drops

Lists the drop files waiting in the calling seat's own drop folder. A drop is what another
seat's `team send` writes under `.agents/send-drops/<session>/<seat>/` when its delivery ends on
the drop leg: the file is one signed message record — the sender, the rule that admitted it, the
thread, and the body — and the file is the message. `team drops` reads the folder and never
moves, deletes, or marks a drop. `team drops --follow` prints each drop that appears while it
runs, one line per file, so a Claude Code Monitor in the receiving seat can turn each arrival
into a notification.

A drop is not only a send's. Before a launch types anything into a seat, the launch writes the
general seat brief — TeamCLI's built-in default, the first text every seat gets — into that
seat's folder as the same signed message record, and nothing is ever typed for it. Every delivery
is a claim in the session's state: the brief's sha256, the delivery's incarnation and runtime
epoch, its attempt, and the ids of the deliveries it replaced (the newest fifty). `team up`
writes it to every seat it launches or relaunches and to every declared seat the session records
no launch of, human seats among them, and when this build's brief is ahead of a live seat's claim
it also delivers to that seat without relaunching it; `team add`, `team register`, `team restart`,
`team reload` and `team rename` write it to the seat they act on and refuse a human seat's pane
before any launch. A listing shows only the delivery the seat's current claim names: the
superseded ids its claim records are skipped by name, and a launch record whose digest or
incarnation is not the claim's is not waiting mail. `team drops --read` serves the same current
claim — it verifies the record, writes its receipt and prints the brief, and an earlier delivery
is skipped without a receipt and without a refusal.

`team drops --read` is the same folder served to the launch's own turn-start hook: the launch
line names the seat and session, each waiting record is verified with the checkout's message
key, its signed `<id>.read.json` receipt is written before its body is printed, and at most ten
bodies are handed over a run, newest first. A plain-text drop an earlier build wrote cannot be
verified at all: the read skips it, reports it by count on stderr, and leaves it in place, and it
does not use one of the ten. A signed record an earlier build wrote under the `unread-<uuid>`
name it gave a runtime report to the team's lead is served and receipted like any other record:
the listing and the read agree on what is waiting, and the receipt takes it out of both. A
record that is otherwise malformed, or an earlier delivery of the
general seat brief, is not a body either and does not use one of the ten. It asks for no placed
caller, because a CLI's hook runs outside any pane. The launch passes `--epoch <run_id>`, the
runtime it started the reader under; a record the launch wrote is served only when the claim on
disk is the same id, incarnation, digest and epoch, and a process started under an earlier
runtime serves nothing until its seat is launched again. With no `--epoch` — a read by hand — the
receipt binds the claim it serves.

A receipt beside a drop says it was handed over, and a drop with one is read and not listed:
the seat's inbox server writes `<id>.read.json` when an `inbox_read` call returns the message,
and the turn-start `team drops --read` writes the same receipt before it hands a body over; it
is the same signed status receipt `team messages` writes, signed with the checkout's message
key. `team drops` verifies it; a file at that name the key did not sign, or one naming
another message, seat, checkout or session, proves nothing and the drop is still listed. A
receipt for the general seat brief also carries the claim's binding — its incarnation, the text's
sha256 and the runtime epoch — and only a receipt carrying this claim's three counts as its read;
one an earlier agent, an earlier text or an earlier runtime left does not, so the delivery is
still listed and the read meets the occupied name. The read never
replaces such a receipt: a name already held by a file that does not verify for this claim is a
refusal, its body is not printed, and the file is left in place — only
`team brief rollout --apply` moves past it, by recovering the delivery at a new id.

## Synopsis

    team drops [--follow] [--json]
    team drops --read --seat <seat> [--session <session>] [--epoch <run_id>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--follow` | — | keep reading the folder and print one line per new drop, `from <sender> — <path>`, flushed as each is read; Ctrl-C stops it and exits 0 |
| `--json` | — | print one `team.drops` document (`format: 1`, `project`, `session`, `seat`, `drops`, `counts`) |
| `--read` | — | hand the seat's waiting messages to the launch's turn: verify each record, write its signed `<id>.read.json` receipt, then print its body; at most ten a run, newest first. `--seat` is required |
| `--seat` | a seat name | the seat whose folder `--read` serves; only with `--read` |
| `--session` | a session name | the launch's session, when given; only with `--read`, and it must be the team file's own |
| `--epoch` | a runtime epoch | the epoch the launch started this reader under; when given, only a brief delivered under that epoch is served; only with `--read` |
| `--help`, `-h` | — | the usage, and exit 0 |

`--follow` and `--json` can't be used together: a follow is a stream of lines, not one document.
`--read` can't be used with either: it answers one turn with the bodies, not a listing or a
stream. `--seat`, `--session` or `--epoch` without `--read` is an invocation error, not a silent
no-op.

## What it reads and writes

Reads `.agents/team.yaml` to resolve the project, the session, and the calling seat, then reads
`.agents/send-drops/<session>/<seat>/`. The file is the one the checkout git names, or, in a
folder that is not a repository, this folder's own team root — a team whose file lives outside
any checkout reads exactly the same way. A drop's file name is the send's id. A record's payload
names its sender; a raw body file an earlier build wrote still names one on its first line.
Names with a dot in them — `<id>.pending`, `<id>.taken`, `<id>.read.json`,
`<id>.<hex>.tmp` — are sidecars, not drops, and are not listed. A listing read for a placed seat
skips the current brief claim's superseded ids by name, and a verified launch record whose digest
or incarnation is not that claim's is not listed. Nothing is written
or removed, and the folder is not created: a folder that does not exist yet is an empty one.
`--read` is the one mode that writes: the signed `<id>.read.json` receipt beside each record it
hands over (mode 0600), and nothing else — the drop itself is never moved or deleted. A message
it cannot verify or receipt is a refusal, and its body is not printed; a receipt name held by a
file that does not verify for the served claim is refused the same way, and the file is left in
place. A plain-text drop an earlier build wrote is the exception: nothing in it can be verified,
so the read skips it, reports it by count on stderr, and leaves it in place, while the signed
records around it are still served. A signed record an earlier build wrote under the
`unread-<uuid>` name it gave a runtime report to the team's lead is not an exception: it is
served and receipted like any other record, so it leaves the listing when it is read.

## Who may run it

Only the seat itself, on the pane the state records for it: a drop folder is one seat's mailbox,
and the command answers from the caller's own placement. The owner, another seat, and a seat
running on another pane are refused. `--follow` runs until it is stopped, so it belongs to the
receiving seat and is not a command a lead runs for someone else. `--read` is the launch's own
invocation, not a seat's: the launch line names its seat and session, no pane is asked for, and
the team file must declare that seat. The launch's turn-start hook runs it.

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
| `--read` handed the waiting records over | their bodies, newest first, one after another with a blank line between; nothing when none wait | 0 |
| `--read` found plain-text drops an earlier build wrote | `team drops: <n> drop(s) are not signed records and are not served` on stderr, and no body from them | 0 |
| `--read` found only earlier deliveries of the general seat brief | `team drops: <n> drop(s) carry an earlier general seat brief and are not served` on stderr, and no body | 0 |
| the caller is not a placed seat of this team | `team drops: only a seat of this team reads its own drops; this call is <caller>`, or the no-pane / another-pane refusal | 1 |
| the team file can't be read, or the drop folder can't be read | `team drops: <problem>` | 1 |
| `--read` refused a waiting record and no body could be handed over | `team drops: <reason>`, and the unproven body is not printed | 1 |
| `--read` named another session, or a seat the file does not declare | `team drops: the team's session is "…", not "…"`, or `team drops: the team file declares no seat "…"` | 1 |
| the invocation can't be read, `--follow` and `--json` are both given, `--read` is given without `--seat` or with `--follow` or `--json`, or this folder is neither a checkout nor a team root | `team drops: <problem>`, with the usage for the invocation | 2 |

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

A drop the orchestrator sent. A build before readable sender names wrote the agent id on the
first line, and this build still reads that form; the line it writes names the sender as the
receiving team's [`sender_name`](../team-file.md#sender_name) word asks:

```file file=.agents/send-drops/beacon/claude-keeper/3b3e9a27-e222-4e2e-90d9-95f4273e319d
from agt_000000000001 (orchestrator, orchestrator@0123456789ab) — admitted by: an orchestrator or operator to a seat of its own team

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
