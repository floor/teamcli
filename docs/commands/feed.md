# team feed

Reads the project's message history from `~/.config/team/<project>-<hash>/messages.jsonl`
(mode `0600`, inside the project's state folder and never in a lobby or the repository), together
with any `briefs/<from>-to-<to>.md` files and Desk audit lines when present. It reads: it writes
nothing, and following the log never grows it.

Each completed `team send` run (`delivered`, `delivered (read)`, `sent (unconfirmed)`,
`answered`, `held`, `not-submitted`, `timeout`, or `unreachable`) appends one JSON object per
line to `messages.jsonl`:

    {"ts":"<ISO-8601>","from":"<sender>","to":"<seat>","body":"<text>","id":"<uuid>","outcome":"<outcome>","spec":"<address as written>","resolved":"<agt-id>","ms":<milliseconds>,"via":"<socket|typed|mcp-inbox>","failed":["<leg>: <reason>",...],"note":"<qualifier>","thread":"<uuid>","in_reply_to":"<uuid>"}

The last eight fields are optional. `thread` is the first message's id, carried on every line of
one conversation; `in_reply_to` is the id of the record a reply answers, absent on the message
that opened the thread. `spec` is the address the sender wrote when it was a form
rather than the seat's own name — a `@<nickname>`, a `<seat|nickname>@<team>`, `lead@<team>`, or
an agent id — and `resolved` is the registry id (`agt_…`) that address resolved to; the two are written
together, and `to` is that seat either way. `ms` is the whole milliseconds from send to outcome,
written when the send measured it, and `via` is the path the message actually travelled — `typed`
(a composer trigger), `socket` (a frame), or `mcp-inbox` (the seat's own inbox, where the message
is still the signed record) — absent when it never left the sender. `failed` names
the delivery legs a send walked past, each as `<leg>: <reason>`: the legs of the seat's delivery
order that definitely could not take the send — the ones a walk passed before the leg that took
it, or every leg that failed on a walk that ran out of legs — `native` (recorded `unavailable`
while no socket write is made) or `mcp-inbox` (recorded `no live inbox listener` when no server
is serving that seat's inbox, and `no receipt within 10m` on the watch's later typed line for a
message the seat's client left unread past the fallback window) in this
build. It is absent when no leg failed, and a line that has none of the six, from a build older
than these fields, carries the six required fields alone. `note` is the short qualifier the
outcome word cannot carry alone: a delivered send whose box cleared before herdr's status or the
transcript showed the seat act reads `taken, not yet confirmed`, and the sign that the seat acted
is read later — a later line for the same id reads `taken but never acted on` when that sign
never came. The table shows `ms` and `via` with the outcome in the KIND column, `delivered (via
socket in 812 ms)`, and carries `spec`, `resolved`, `failed`, `note`, `thread` and `in_reply_to`
in the `--json` event, since the plain row keeps the channel that took the send.

The log rotates at 1 MB and keeps three files (`messages.jsonl`, `messages.jsonl.1`,
`messages.jsonl.2`), each at mode `0600`. Pre-flight refusals, `--list`, and `--dry-run` write
nothing to `messages.jsonl`.

## Synopsis

    team feed [--seat <name>] [--limit <n>] [--all] [--audit <path>] [--briefs <dir>] [--follow] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--seat <name>` | a seat name | only entries where `from` or `to` is `<name>` |
| `--limit <n>` | 1 to 10,000 | at most the last `<n>` entries (default 50) |
| `--all` | — | merge `messages.jsonl` across every project state folder under `~/.config/team/<project>-<hash>/`, so a pane beside Desk can follow all team discussions even outside a project checkout |
| `--audit <path>` | a JSONL file | read an explicit Desk or guard `audit.jsonl` file |
| `--briefs <dir>` | a directory | read an explicit `briefs/<from>-to-<to>.md` directory, including timestamped `## <ISO-8601> — From <Name>: ...` sections |
| `--follow` | — | keep reading as new entries arrive, including across log rotations |
| `--json` | — | print one `team.feed` document (`format: 1`, `project`, `session`, `events`), not one line per entry |
| `--help`, `-h` | — | the usage, and exit 0 |

`--follow` and `--json` can't be used together: a follow runs until it is stopped, and `--json`
is one document per run. The refusal is an invocation error — the usage on stderr, exit 2 — and
it does not print a `team.error` document, since the run was told to follow.

## What it reads and writes

Reads `.agents/team.yaml` to resolve the project name and checkout root (or scans all
`~/.config/team/<project>-<hash>/` folders when `--all` is given or when run outside a checkout),
then reads `messages.jsonl` (and `.1`, `.2`) with `O_NOFOLLOW`, together with `briefs/*-to-*.md`
and any Desk guard or bridge `audit.jsonl` and signed answer files under `~/.config/team/lobby/`.
If a symbolic link or FIFO stands at the log or in the state folder ladder, `team feed` refuses and
does not follow it. Writes nothing.

## Who may run it

Anyone in the checkout may run it.

## Output and exit codes

A reading run prints one context line, `team <project>, session "<session>"` — omitted when the
run names no single team, as `--all` and a run outside a checkout do — then the table, then one
summary line, `<n> event` or `<n> events`. The table's columns are:

| Column | Meaning |
| --- | --- |
| TIME | when the entry was written, `HH:MM:SS` |
| KIND | the send outcome, with `via <path>` and `in <n> ms` when the send measured them |
| SEAT | `<from> -> <to>` |
| DETAIL | the body, folded to one line; a reply opens with `re <id>: `, the record it answers |

An empty history prints the context line and `0 events` — no table. `--follow` prints one
header, table and count each time a pass brings new entries, so a reader can tell one arrival
from the next.

One message is one row. A send filed as `sent (unconfirmed)` and a later line for the same id —
a `delivered (read)` receipt, a typed fallback, or a taken delivery's later report — are one
message's outcome moving: a reading shows the latest line once, and the address the send
recorded (`spec`, `resolved`) stays on that row. The send's measured milliseconds are not
carried over, since they timed the send and not the outcome that followed it. A `--follow` pass
prints the update when it arrives, because it is new information.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the feed was printed | the context line, the `TIME  KIND  SEAT  DETAIL` table, and `<n> event` or `<n> events` | 0 |
| the history was empty | the context line and `0 events` | 0 |
| the history log can't be read | `team feed: the history log cannot be read: <reason>` (with `--json`, a `team.error` document) | 1 |
| the invocation can't be read (including `--follow` with `--json`), or this folder is not a git checkout, or the team file can't be read | `team feed: <problem>`, with the usage for the invocation (with `--json`, a `team.error` document) | 2 |

With `--json` the run prints one pretty-printed `team.feed` document:

    {"schema":{"name":"team.feed","version":1},"format":1,"project":"<project>","session":"<session>","events":[{"ts":"<ISO-8601>","from":"<sender>","to":"<seat>","body":"<text>","id":"<uuid>","outcome":"<outcome>","status":"<sent|held|delivered|read|replied>","ms":<milliseconds>,"via":"<socket|typed|mcp-inbox>","failed":["<leg>: <reason>"],"note":"<qualifier>","thread":"<uuid>","in_reply_to":"<uuid>"}]}

`project` and `session` are `null` when the run names no single team. `status` is derived from the
outcome, never stored: `delivered (read)` is `read`, `delivered` is `delivered`, `held` is `held`,
`answered` is `replied`, and every other outcome — a `sent (unconfirmed)` send, a `timeout`, a
`not-submitted`, an `unreachable`, a `refused` — is `sent`. `ms`, `via`, `failed`, `note`, `thread`
and `in_reply_to` appear on an event only when the history line carries them. The schema is
published at `schema/feed.schema.json`.

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

  - role: reviewer
    name: gpt-reviewer
    label: reviewer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
```

Before any message has been sent, `team feed` reports an empty history:

```console
$ team feed ; echo "exit $?"
team beacon, session "beacon"
0 events
exit 0
```

After a send, `team feed` prints the exchange with its timestamp, sender, recipient, outcome and
body. No server serves this seat's inbox, so the send walks to its drop folder — `via drop` —
and reads `sent (unconfirmed)` until the seat's own turn-start read writes the signed receipt,
which a running watch records as one more line, `delivered (read)`:

```console
$ team send gpt-reviewer "the gate is green" ; echo "exit $?"
team beacon, session "beacon"
gpt-reviewer: sent (unconfirmed) (drop, 0 ms)
exit 0
$ team feed ; echo "exit $?"
team beacon, session "beacon"
  TIME      KIND                                   SEAT                   DETAIL
  09:00:00  sent (unconfirmed) (via drop in 0 ms)  owner -> gpt-reviewer  from the owner — admitted by: the owner the gate is green
1 event
exit 0
$ team feed --seat gpt-reviewer ; echo "exit $?"
team beacon, session "beacon"
  TIME      KIND                                   SEAT                   DETAIL
  09:00:00  sent (unconfirmed) (via drop in 0 ms)  owner -> gpt-reviewer  from the owner — admitted by: the owner the gate is green
1 event
exit 0
```
