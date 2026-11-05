# team show

Prints the full message record `<id>` (or a unique prefix of at least 8 characters) from the
caller's own mailbox with its compact sender header and reply/ack footer, and marks the message read
with the same signed receipt [`team messages`](messages.md) and [`team ack`](ack.md) publish: one
`read` sidecar beside the record, `<id>.read.json`, written in the addressee's own folder with an
exclusive, no-clobber link before the body is printed.

When a seat opts into `compact_delivery: true` on its entry in `.agents/team.yaml`, its
cross-session socket frame carries only the compact sender header, the first content line of the
message body, and `↩ team show <id> · team reply <id> · team ack <id>`, while the full message body
remains in the signed drop record on disk. Running `team show <id>` displays the full multi-line
body on demand and marks the message read so the unread watch does not re-wake it.

Re-running `team show <id>` on a message in the caller's own mailbox that was already read or
replied to is idempotent: the full message is still printed, the existing receipt stays byte for
byte, and under `--json` `written` is `false`.

The record is found the way [`team reply`](reply.md) and [`team ack`](ack.md) find it: its id (or
unique prefix of at least 8 characters) is looked up in
`<root>/.agents/send-drops/<session>/<seat>/<id>`, it must verify against this checkout's message
key, it must name the caller as its recipient, and it must sit in that addressee's own folder. A
record that does not verify, one addressed to another seat, one found in another seat's folder, a
prefix shorter than 8 characters, or an ambiguous prefix in the caller's mailbox is refused, and
no body text is printed. The displayed sender header is an attribution resting on the shared
checkout key, never a verification of who ran the command.

## Synopsis

    team show <id> [--json]

`<id>` is the record being shown, as it is named in the caller's folder (or an unambiguous prefix
of at least 8 characters in that mailbox; an ambiguous prefix is refused naming the matching ids).

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | one document instead of the rendered lines, registered as `schema/show.schema.json` |

## What it reads and writes

Reads the team file, the caller's placement, the message key, and the record the id names in the
caller's own mailbox. Writes one signed `read` receipt beside it,
`.agents/send-drops/<session>/<seat>/<id>.read.json`, in the addressee's own folder when no `read`
or `replied` receipt serves it yet. Nothing else is written.

## Who may run it

The owner, or a seat of the team, from a terminal outside herdr or its own pane. A run with no
terminal is refused. The caller must be the record's addressee — the record's `to` names it, and
the record sits in its own folder.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| shown | the compact sender header, the full message body, and `↩ team reply <prefix> "…" · team ack <prefix>` on stdout | 0 |
| refused | `team show: <reason>` on stderr | 1 |
| configuration | `team show: <team-file problem>` on stderr | 2 |
| usage | `team show: <problem>` and the usage on stderr | 2 |

Under `--json` a run that shows the message prints one `team.show` document — `{format, id, prefix,
project, session, seat, from, from_id, rule, at, written, content}` — where `written` says whether
this run published the receipt (`false` when an earlier read or reply already served it); a refused
run prints the structured error document instead (`error.id` is `show.refused`,
`show.configuration` or `show.usage`) and stderr stays empty.

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
    compact_delivery: true
    delivery_order: [native, typed]
```

The coordinator sends the scribe a message; the handoff writes the signed record under the id it
prints:

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

The scribe inspects the full message by its 8-character prefix (`22222222`), which marks it read
and prints the full body with its reply/ack footer. Running `team show` a second time still shows
the message:

```console caller=claude-scribe
$ team show 22222222 ; echo "exit $?"
from the file's seat claude-keeper (no registry record yet) (an orchestrator or operator to a seat of its own team [nv-22222222]):

the draft is ready for review

↩ team reply 22222222 "…" · team ack 22222222
exit 0
$ team show 22222222 ; echo "exit $?"
from the file's seat claude-keeper (no registry record yet) (an orchestrator or operator to a seat of its own team [nv-22222222]):

the draft is ready for review

↩ team reply 22222222 "…" · team ack 22222222
exit 0
```

Another seat's caller cannot show the scribe's message:

```console caller=claude-keeper
$ team show 22222222 ; echo "exit $?"
team show: record 22222222-2222-4222-8222-222222222222 is addressed to claude-scribe, not to claude-keeper
exit 1
```

A prefix shorter than 8 characters is refused:

```console caller=claude-scribe
$ team show 2222 ; echo "exit $?"
team show: record prefix "2222" is shorter than 8 characters; pass at least 8 characters
exit 1
```

An unknown id is refused, naming the session:

```console caller=claude-scribe
$ team show 33333333-3333-4333-8333-333333333333 ; echo "exit $?"
team show: no record named 33333333-3333-4333-8333-333333333333 waits in this project's session "beacon"
exit 1
```

`team show` requires an `<id>`:

```console caller=claude-scribe
$ team show ; echo "exit $?"
team show: <id> is required
Usage: team show <id> [--json]

Prints the full message record <id> (or a unique prefix of at least 8
characters) from the caller's own mailbox with its compact sender header and
reply/ack footer, and marks the message read with the same signed read receipt
`team messages` and `team ack` write. Re-running `team show <id>` on a message
that was already read or replied to in the caller's own mailbox still displays
it.

Exits 0 when the message is shown, 1 when the caller or the record is refused,
2 when the invocation or the team file can't be read.
exit 2
```
