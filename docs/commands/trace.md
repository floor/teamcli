# team trace

Prints one message's story from the receiving team's signed event log: the steps a send, the
bus, a seat and a watch filed for one message id, in the order they were written.

Every step of a message's life is an event of its own in the receiving team's state folder
(`~/.config/team/<project>-<hash>/events.jsonl`), signed and filed under the message id plus a
step tail: `message.staged` as `<id>:staged`, each leg the walk tried as
`<id>:leg.tried:<route>`, the sender's webhook post as `<id>:webhook.posted`, the bus's arrival as
the bare `<id>`, the seat's receipts as `<id>:delivered`, `<id>:read` and `<id>:replied`, and the
watch's retries as `<id>:wake.retried:<try>:<via>`. A trace is a filtered, signature-verified read
of that log: it keeps every record whose id is the message id or starts with `<id>:`, sorts them by
the log's own sequence, and prints them with the quiet time between each step and the one above
it. There is no second store and no summary the log does not hold.

The steps live in the receiving team's store, so run the trace in that team's checkout — a sender
reading its own closing line from another checkout sees only the steps that checkout's store
holds, and the command prints what it found rather than what it expected. `team send` prints the
id on its closing line, so the line a sender quotes is the trace's key.

It reads: the trace appends no event, writes no file, and asks for no terminal or pane. An
unverified or self-contradicting record is skipped and counted, never repaired into a step.

## Synopsis

    team trace <id> [--json]

`<id>` is the message id, or a full step id (`<id>:staged`) to print that one step.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | print one `team.trace` document (`format: 1`, `project`, `session`, `id`, `steps`, `summary`, `unverified`), not the context line and table |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

Reads the team's configuration (its registry record; `.agents/team.yaml` on the legacy `file`
source) to resolve the project name, session and checkout root, then reads the state folder's
`events.jsonl` with `O_NOFOLLOW`, verifying each record's signature through the bus log. If a
symbolic link or FIFO stands at the log or in the state folder ladder, the run refuses and does
not follow it. Writes nothing.

## Who may run it

Any seat with a registry record may run it — the same row the Runtime's read surfaces carry,
because the trace reads the team's own verified log and changes nothing.

## Output and exit codes

A reading run prints one context line, `team <project>, session "<session>"`, then the table, then
one summary line, `<n> step` or `<n> steps`. The table's columns are:

| Column | Meaning |
| --- | --- |
| TIME | when the step was written, `HH:MM:SS.mmm` in UTC, from the record's own signed instant |
| STEP | the event kind: `message.staged`, `leg.tried`, `webhook.posted`, `message.arrived`, `message.delivered`, `message.read`, `message.replied`, `wake.retried` |
| VIA | the leg or channel the step names (`socket`, `typed`, `mcp-inbox`, `drop`, `webhook`), or `-` |
| OUTCOME | the step's own outcome word (`delivered`, `sent`, `failed`, `posted`, `retried`, …), or `-` |
| MS | the cost the step measured, in whole milliseconds, or `-` |
| DELTA | the quiet time from the step above it, as `0 ms` or `+<n> ms`; `-` on the first step |
| NOTE | the step's reason, when it carried one, or `-` |

The order is the log's own sequence, so it is chronology, not a chosen order: a watch's retry and
the seat's receipt appear exactly where they were written. A negative DELTA is printed, not
smoothed away — a step stamped before the step above it is a clock disagreement a reader should
see.

An id the log holds no step for prints the context line and `0 steps`, and one sentence on
stderr saying so. Records that failed verification are skipped; when any were, the text run says
how many on stderr (the `--json` document carries the count as `unverified`), and the run still
succeeds.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the trace was printed | the context line, the `TIME  STEP  VIA  OUTCOME  MS  DELTA  NOTE` table, and `<n> step` or `<n> steps` | 0 |
| the log holds no step under that id | the context line and `0 steps`; stderr names the id | 1 |
| the event log can't be read | `team trace: the event log cannot be read: <reason>` (with `--json`, a `team.error` document) | 1 |
| the invocation can't be read, or this folder is not a git checkout, or the team file can't be read | `team trace: <problem>`, with the usage for the invocation (with `--json`, a `team.error` document) | 2 |

With `--json` the run prints one pretty-printed `team.trace` document:

    {"schema":{"name":"team.trace","version":1},"format":1,"project":"<project>","session":"<session>","id":"<id>","steps":[{"seq":<n>,"ts":"<ISO-8601>","kind":"<event kind>","record_id":"<id or id:step>","from":"<sender>","to":"<seat>","thread":"<uuid>","via":"<route>","outcome":"<word>","ms":<milliseconds>,"reason":"<text>","delta_ms":<milliseconds or null>}],"summary":"<n> step or <n> steps","unverified":<n>}

A step carries only the optional fields its event has, so a step that named no route has no
`via` rather than an empty one. `delta_ms` is `null` on the first step and a whole number after
it. The schema is published at `schema/trace.schema.json`.

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

The send files its steps under the id it prints on the closing line. This page pins that id so
the trace below can name it:

```console send-id="66666666-6666-4666-8666-666666666666"
$ team send gpt-reviewer "the gate is green" ; echo "exit $?"
team send: gpt-reviewer: queued, no event adapter (no event adapter of this seat took it); the message waits in its bus inbox
team beacon, session "beacon"
gpt-reviewer: sent (unconfirmed) (drop, 0 ms); queued; gpt-reviewer reads it at its next turn, and nothing here gives it one (pull-only) (id <id>)
exit 0
```

`team trace` then reads the id back: the staging, every leg the walk tried with its route, verdict
and cost, and the last step's quiet time from the step above it:

```console
$ team trace 66666666-6666-4666-8666-666666666666 ; echo "exit $?"
team beacon, session "beacon"
  TIME          STEP            VIA        OUTCOME      MS  DELTA  NOTE
  09:00:00.000  message.staged  -          -            -   -      -
  09:00:00.000  leg.tried       native     unreachable  0   0 ms   no trusted runtime session is recorded for this seat (no agent record for this seat)
  09:00:00.000  leg.tried       mcp-inbox  unreachable  0   0 ms   no live inbox listener
  09:00:00.000  leg.tried       drop       held         0   0 ms   the record is stored; no seat was woken
4 steps
exit 0
```

A full step id prints that one step, which is how a reader checks one leg without the rest of the
story:

```console
$ team trace 66666666-6666-4666-8666-666666666666:staged ; echo "exit $?"
team beacon, session "beacon"
  TIME          STEP            VIA  OUTCOME  MS  DELTA  NOTE
  09:00:00.000  message.staged  -    -        -   -      -
1 step
exit 0
```

An id the log holds no step for is an empty answer, not an error document:

```console
$ team trace 11111111-1111-4111-8111-111111111111 ; echo "exit $?"
team beacon, session "beacon"
0 steps
team trace: no step is filed under 11111111-1111-4111-8111-111111111111 in this team's event log
exit 1
```

`--json` prints the same steps as one document:

```console
$ team trace 66666666-6666-4666-8666-666666666666 --json ; echo "exit $?"
{
  "schema": {
    "name": "team.trace",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "id": "66666666-6666-4666-8666-666666666666",
  "steps": [
    {
      "seq": 1,
      "ts": "2026-10-04T09:00:00.000Z",
      "kind": "message.staged",
      "record_id": "66666666-6666-4666-8666-666666666666:staged",
      "from": "owner",
      "to": "gpt-reviewer",
      "thread": "66666666-6666-4666-8666-666666666666",
      "delta_ms": null
    },
    {
      "seq": 2,
      "ts": "2026-10-04T09:00:00.000Z",
      "kind": "leg.tried",
      "record_id": "66666666-6666-4666-8666-666666666666:leg.tried:native",
      "from": "owner",
      "to": "gpt-reviewer",
      "thread": "66666666-6666-4666-8666-666666666666",
      "via": "native",
      "outcome": "unreachable",
      "ms": 0,
      "reason": "no trusted runtime session is recorded for this seat (no agent record for this seat)",
      "delta_ms": 0
    },
    {
      "seq": 3,
      "ts": "2026-10-04T09:00:00.000Z",
      "kind": "leg.tried",
      "record_id": "66666666-6666-4666-8666-666666666666:leg.tried:mcp-inbox",
      "from": "owner",
      "to": "gpt-reviewer",
      "thread": "66666666-6666-4666-8666-666666666666",
      "via": "mcp-inbox",
      "outcome": "unreachable",
      "ms": 0,
      "reason": "no live inbox listener",
      "delta_ms": 0
    },
    {
      "seq": 5,
      "ts": "2026-10-04T09:00:00.000Z",
      "kind": "leg.tried",
      "record_id": "66666666-6666-4666-8666-666666666666:leg.tried:drop",
      "from": "owner",
      "to": "gpt-reviewer",
      "thread": "66666666-6666-4666-8666-666666666666",
      "via": "drop",
      "outcome": "held",
      "ms": 0,
      "reason": "the record is stored; no seat was woken",
      "delta_ms": 0
    }
  ],
  "summary": "4 steps",
  "unverified": 0
}
exit 0
```
