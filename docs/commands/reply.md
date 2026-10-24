# team reply

Answers the sender of a message record, or closes its thread. A reply is itself one signed
record — written into the folder of the seat it answers, mode 0600, by renaming a temporary file
into place — and it carries the same thread as the message it answers: `in-reply-to` names the
record it answers, and `thread` is the first message's id. The record it answers is the one this
checkout's session holds for the caller: its id is looked up in
`<root>/.agents/send-drops/<session>/<seat>/<id>`, it must sit in the caller's own folder,
it must name the caller as its recipient, and it must verify against this checkout's message key.
A record that does not verify, or one addressed to another seat, is refused and nothing is
written. A message an earlier build left in `.agents/messages/` carries no thread: it is read,
not answered.

A reply goes to the sender of the record it answers, never to a third seat, and the pair is
judged by the same rules as a send's, with the reply rule (`reply-on-open-thread`) asked after
the targeted and grant rules and before the declared-seat rule: a reply on an open thread is
admitted by the reply rule even between two seats no earlier rule pairs. The rule reads the
thread, not the invitation: it admits a reply on any open thread, and a thread is open until it
is closed or the clock or the cap ends it.

A record a client wrote is answered on the client's own thread. A record carrying `from_client` is
the client's opening record, and only that record is answered: the reply's `to` is
`client:<client id>`, its `to_id` is null, and its `to_client` names the client and the grant that
opened the thread. The record is written into the client's inbox,
`<root>/.agents/send-drops/<session>/.clients/<client id>/`, and a signed `replied` receipt goes
beside the opening record in the answering seat's folder. The thread's age and cap count the
verified replies in that inbox too.

The pair is admitted by the thread's originating grant, read from the canonical grants folder by
the id the opening record carries — never by scanning for another grant, and never by a later
grant. The grant must be active when the reply is written, must carry the `--inbox` vocabulary
(`send` and `messages`), and must still bind the recipient the opening record names: the
registry's coordinator team, seat and agent id, the same checkout and the same session. A changed
binding, a revoked or expired grant, a send-only grant, the owner, or any other seat is refused,
and nothing is written. A thread opened under a send-only grant is not reauthorized by a new one:
the client starts a new thread under a `--inbox` grant. The reply runs under the grant lock and
then the seat lock, in that order, so a revocation that wins the grant lock is seen before the
record is written. Under both locks the reply rechecks the thread and the binding before it signs:
the verified client inbox and the close sidecars are read again with a fresh clock, and the
grant's team, checkout, session, seat and agent are resolved again; a thread that closed, aged out
or reached its cap during the wait, or a binding that changed, is refused and nothing is written. A client reply writes no project message-history line.

A thread ends in three ways. `team reply <id> --close` writes a signed close sidecar beside the
record it answers, `<id>.closed.json` — a thread's close is the addressee's own act, and it
writes no message. A thread whose newest record is `thread-ttl` old (72 hours) is closed by the
clock, and a thread that reaches `thread-cap` records (50) ends at the cap, for an exchange
nobody closes. Both numbers are the owner's to change. A reply written on a closed thread is not
refused for that reason: it opens a new thread that cites the record it answers — its own id is
the new thread, and `in-reply-to` names the last record of the closed one. Closing an already
closed thread is refused, naming what ended it, and nothing is written.

The answered record moves to `replied`: the reply writes a signed receipt (`<id>.replied.json`)
beside the message it answers, in the answering seat's own folder. The reply is delivered the way
the drop leg delivers — the record is left in the target's folder, nothing is typed and no frame
is sent — and the receiving seat's own watch rings the message-display wake line: the rendered
header and the fixed `Read it with: team drops --read.` hint. A
[team send --wait](send.md) waiting on that thread wakes on the reply record and returns
`answered`. A reply's text is
kept in the record, and the project's message history keeps one line for it, with `thread`,
`in-reply-to` and `via: drop`.

## Synopsis

    team reply <id> <text> [--json]
    team reply <id> --close [--json]

`<id>` is the record being answered, as it is named in the caller's folder. `<text>` is every
remaining word, joined with single spaces; `--close` takes no text. A reply's text is required and
must not be empty.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--close` | — | closes the answered record's thread, writing a signed `<id>.closed.json` beside it; takes no text |
| `--json` | — | one document instead of the lines, registered as `schema/reply.schema.json`: the action surface and the outcome in one |

## What it reads and writes

Reads the team file, the caller's placement, the message key, and the record the id names with
the records and close sidecars of its thread. Writes one signed record,
`.agents/send-drops/<session>/<seat>/<id>` (mode 0600), into the answered sender's folder, and a
signed `replied` receipt beside the answered record (`<id>.replied.json`); a `--close` writes the
signed close sidecar `<id>.closed.json` beside it instead. A reply on a client thread is the one
exception to the destination: its record goes into the client's own inbox folder, and no history
line is appended. The seat's folder and the reply's
record are each written under the seat's lock (`<state dir>/seat-locks/<session>/<seat>`), so two
commands never write into one folder at once. It writes one line to `.agents/team.log`, and
appends the reply to the project's message history ([team feed](feed.md)); when the reply record
cannot be written, the receipt is not written either and the run is a refusal.

A reply that is refused writes nothing: no record, no receipt, no close, no history line.

## Who may run it

The owner, or a seat of the team, from a terminal outside herdr or its own pane. A run with no
terminal is refused. The caller must be the record's addressee — the record's `to` names it, and
the record sits in its own folder — and the reply reaches the seat the record's `from` names: a
sender the team file no longer declares is not reached by a reply. The owner answers a seat's
record through this same path. A record the owner sent is answered at its entity's
`owner-reply-to` endpoint — the `seat@team` address an owner-origin message names — and the
`floor` entity answers `orchestrator@floor` when it declares none. The reply is written into that
endpoint seat's own folder, and the receipt stays beside the answered record; an entity that
declares no endpoint, or an endpoint the registry cannot resolve, is refused and nothing is
written. A client thread is answered by its recipient
seat alone, on its own pane and session, and only while the registry still names that seat and
agent for the grant's team; the owner and every other seat are refused.

## Output and exit codes

A run that writes opens on stdout with the context line (`team <project>, session "<session>"`),
then the outcome line. A refused run prints its line on stderr and has none.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| replied | `<seat>: replied` on stdout — the seat the reply went to | 0 |
| replied to a client | `client:<client id>: replied` on stdout | 0 |
| closed | `<thread>: closed` on stdout | 0 |
| refused | `team reply: <reason>` on stderr | 1 |
| a client thread refused | `team reply: <reason>` on stderr — the thread's grant, placement or binding does not admit the reply | 1 |
| configuration | `team reply: <team-file problem>` on stderr | 2 |
| usage | `team reply: <problem>` and the usage on stderr | 2 |

Under `--json` a written run prints one `team.reply` document — `{format, status, action_summary,
project, session, record, thread, in_reply_to, to, rule, reply, at}` — where `status` is `replied`
or `closed`, `record` is the reply's own id (`null` for a close), and `rule` is the admitting
rule; a refused run prints the structured error document instead (`error.id` is `reply.refused`,
`reply.client-refused`, `reply.configuration` or `reply.usage`) and stderr stays empty.

Refusals name what stopped them, and nothing is written:

    team reply: no record named <id> waits in this project's session "<session>"
    team reply: the message <id> was written by an earlier build and has no thread; it is read, not answered
    team reply: no message key; nothing was written
    team reply: record <id> does not verify against this message key
    team reply: record <id> is addressed to <seat>, not to <caller>
    team reply: record <id> was sent by the owner, and the owner's reply endpoint is missing (<why>); nothing was written
    team reply: record <id> was sent by the owner, and the owner's reply endpoint <target> cannot be resolved: <reason>; nothing was written
    team reply: the thread's grant <grant id> is send-only; only a grant with send and messages opens a client thread a seat may answer. ...; nothing was written
    team reply: the thread <thread> is already closed; nothing was written
    team reply: the thread <thread> ended: no record on it for 72h; nothing was written
    team reply: the thread <thread> ended at its 50-record cap; nothing was written
    team reply: refused: <reason>

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

The scribe answers it: one signed record, on the same thread, in the coordinator's folder.

```console caller=claude-scribe
$ team reply 22222222-2222-4222-8222-222222222222 "the draft reads well" ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: replied
exit 0
```

`--close` ends the thread. A second close names what ended it:

```console caller=claude-scribe
$ team reply 22222222-2222-4222-8222-222222222222 --close ; echo "exit $?"
team beacon, session "beacon"
22222222-2222-4222-8222-222222222222: closed
exit 0
$ team reply 22222222-2222-4222-8222-222222222222 --close ; echo "exit $?"
team reply: the thread 22222222-2222-4222-8222-222222222222 is already closed; nothing was written
exit 1
```

An id nothing holds is refused, and the session is named:

```console caller=claude-scribe
$ team reply 33333333-3333-4333-8333-333333333333 "anyone there?" ; echo "exit $?"
team reply: no record named 33333333-3333-4333-8333-333333333333 waits in this project's session "beacon"
exit 1
```

A reply needs an id and a text:

```console caller=claude-scribe
$ team reply ; echo "exit $?"
team reply: <id> is required
Usage: team reply <id> [<text>] [--close] [--json]
       team reply <id> --close

Replies to the sender of the message record <id>, or closes its thread.
A reply is a signed record in the sender's folder, on the same thread; it is
admitted while the thread is open. --close ends the thread, and a later reply
opens a new one that cites the closed thread's last record.

Exits 0 when the reply or the close is written, 1 when the reply is refused or no
record holds <id>, 2 when the invocation or the team file can't be read.
exit 2
```
