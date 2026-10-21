# team ack

Marks a message record read without printing it. The act is the same signed receipt
[`team messages`](messages.md) publishes before it shows a body: one `read` sidecar beside the
record, `<id>.read.json`, written in the addressee's own folder with an exclusive, no-clobber
link and made durable before the run says it is done. A seat that has already seen a message — in
a log line, in a summary, in a wake it acted on — acknowledges it here, and the message stops
waiting: `team drops` no longer lists it, the unread watch neither rings it nor reports it, and
the MCP inbox's `inbox_check` no longer counts it unread. `team reply` marks a message read by
answering it; `team ack` is for a message that needs no answer.

The record is found the way [`team reply`](reply.md) finds it: its id is looked up in
`<root>/.agents/send-drops/<session>/<seat>/<id>`, it must verify against this checkout's message
key, it must name the caller as its recipient, and it must sit in that addressee's own folder. A
record that does not verify, one addressed to another seat, and one found in another seat's folder
are refused, and nothing is written. Only the addressee acknowledges a record: one seat never
spends another seat's mail.

An entry already at the receipt name is never replaced. A `read` receipt this build did not sign,
or a path held by something that is not a file, may record a read that already happened, so the
run is refused and the entry is left exactly as it is, with its repair naming the path to inspect.
A signed `replied` receipt already serves the id: the message was read before it was answered, the
run succeeds, and no `read` receipt is written. Acknowledging a message that is already read is
idempotent: the run succeeds, the first receipt stays byte for byte, and the JSON document says
this run wrote nothing. A record a client wrote is refused — its read belongs to the client inbox
— and a message an earlier build left in `.agents/messages/` is read with `team messages`, not
acknowledged. The general seat brief is read by the seat's own turn-start reader, not
acknowledged: its receipt is bound to the seat's brief claim, and a plain receipt at its name
would hold the name that reader needs.

## Synopsis

    team ack <id> [--json]

`<id>` is the record being marked read, as it is named in the caller's folder.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | one document instead of the lines, registered as `schema/ack.schema.json`: the action surface and the outcome in one |

## What it reads and writes

Reads the team file, the caller's placement, the message key, and the record the id names. Writes
one signed `read` receipt beside it, `.agents/send-drops/<session>/<seat>/<id>.read.json`, in the
addressee's own folder. Nothing else is written: no record, no reply, no history line.

## Who may run it

The owner, or a seat of the team, from a terminal outside herdr or its own pane. A run with no
terminal is refused. The caller must be the record's addressee — the record's `to` names it, and
the record sits in its own folder. The owner acknowledges a record addressed to it through this
same path.

## Output and exit codes

A run that marks the message read opens on stdout with the context line
(`team <project>, session "<session>"`), then `<id>: read`. A refused run prints its line on
stderr and has none.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| read | `<id>: read` on stdout — written now, or already served by a `read` or `replied` receipt | 0 |
| refused | `team ack: <reason>` on stderr | 1 |
| configuration | `team ack: <team-file problem>` on stderr | 2 |
| usage | `team ack: <problem>` and the usage on stderr | 2 |

Under `--json` a run that marks the message read prints one `team.ack` document — `{format, status,
action_summary, project, session, record, to, thread, written, at}` — where `status` is `read`,
`record` is the id, `to` is the addressee, and `written` says whether this run published the
receipt (`false` when an earlier read or reply already served it); a refused run prints the
structured error document instead (`error.id` is `ack.refused`, `ack.configuration` or
`ack.usage`) and stderr stays empty.

Refusals name what stopped them, and nothing is written:

    team ack: no record named <id> waits in this project's session "<session>"
    team ack: the message <id> was written by an earlier build; it is read with team messages, not acknowledged
    team ack: no message key; nothing was written
    team ack: record <id> does not verify against this message key
    team ack: record <id> is addressed to <seat>, not to <caller>
    team ack: record <id> is written by a client; its read belongs to the client inbox, not to this command
    team ack: record <id> is the general seat brief; it is read by the seat's own turn-start reader, not acknowledged
    team ack: <id>: not marked read: the read receipt name is held by a file that does not verify for this message
    team ack: <id>: not marked read: the read receipt path is held by something that is not a file

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
    name: claude-scribe
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    delivery_order: [native, typed]
```

The coordinator sends the scribe a message; the scribe's delivery order adds `native`, so the
handoff writes the record under the id it prints.

```console caller=claude-keeper
$ team send claude-scribe "the draft is ready for review" ; echo "exit $?"
team beacon, session "beacon"
claude-scribe: native: nothing was sent; make the call with your own SendMessage, then record it
to: uds:~/cc-socks/4200.sock
message:
from the file's seat claude-keeper (no registry record yet) — admitted by: an orchestrator or operator to a seat of its own team [nv-22222222]

the draft is ready for review
team send --confirm 22222222-2222-4222-8222-222222222222
exit 0
```

The scribe saw it run and needs no answer: `team ack` marks it read without printing the body. A
second run says the same and writes nothing.

```console caller=claude-scribe
$ team ack 22222222-2222-4222-8222-222222222222 ; echo "exit $?"
team beacon, session "beacon"
22222222-2222-4222-8222-222222222222: read
exit 0
$ team ack 22222222-2222-4222-8222-222222222222 ; echo "exit $?"
team beacon, session "beacon"
22222222-2222-4222-8222-222222222222: read
exit 0
```

An id nothing holds is refused, and the session is named:

```console caller=claude-scribe
$ team ack 33333333-3333-4333-8333-333333333333 ; echo "exit $?"
team ack: no record named 33333333-3333-4333-8333-333333333333 waits in this project's session "beacon"
exit 1
```

An acknowledgement needs an id:

```console caller=claude-scribe
$ team ack ; echo "exit $?"
team ack: <id> is required
Usage: team ack <id> [--json]

Marks the message record <id> read, without printing it. The signed read
receipt is the same one team messages writes before it shows a body, so the
message stops waiting for this seat and the unread watch stops ringing it.
A message the caller answers with team reply is marked read by the answer.

Exits 0 when the message is read or already was, 1 when the caller or the
record is refused, 2 when the invocation or the team file can't be read.
exit 2
```
