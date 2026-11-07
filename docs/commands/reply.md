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

Answering is a read (ADR `zeus-message-path`, D3): once the reply record is written, the seat's
signed `read` receipt for the answered id is published under its own name beside it,
`<id>.read.json` with `read_by: reply`, and the `replied` receipt follows under `replied`'s name.
The read is an annotation beside the reply, never a condition of it: a receipt that cannot be
written changes no exit and hides no reply.

A reply goes to the sender of the record it answers, never to a third seat, and the pair is
judged by the same rules as a send's, with the reply rule (`reply-on-open-thread`) asked after
the targeted and grant rules and before the declared-seat rule: a reply on an open thread is
admitted by the reply rule even between two seats no earlier rule pairs. The rule reads the
thread, not the invitation: it admits a reply on any open thread, and a thread is open until it
is closed or the clock or the cap ends it.

A seat's answer to the entity's main orchestrator is the one reply the main orchestrator's reach
admits in return, and it is bound to the record that reach wrote. The answered
record must verify, sit in the caller's own folder and name the caller as its recipient, and it
must have been sent by the lead of the entity's head team — the team whose project is the entity
itself, the seat that team's live file names its orchestrator. The reply stays on that record's
thread: the thread's opening record must verify and carry the same sender, and a closed thread is
refused rather than reopened, because reopening it would be a new thread the seat opened. A
forged or unsigned record, a thread another sender opened, and a record addressed to another seat
are refused, and nothing is written. The reach is the `seats_cross_teams` setting, entity →
project → team → seat, with the same default on and the same project loosening level as the send
direction: a level that closes it closes this reply too, and a seat still opens no thread of its
own to the main orchestrator — a plain `team send orchestrator@<entity>` stays refused.

The folder is the one the answered seat's own reader reads. A record from a seat of another team
is answered into that team's transport tree, bound to the root and session that team's live file
names — the same place a send to that seat writes, and the place its `team messages` and inbox
server scan. The live file, not the registry's snapshot of it, decides the session: a team that
moved to another session is answered in the new one. A seat name alone cannot say which team that
is, because two teams may name a seat alike; the registry id the answered record carries places
it. A record whose sender the registry cannot place — no id
on the record, an id the registry does not hold, a retired agent, or an agent that no longer holds
the seat the record names — is refused, and nothing is written.

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
beside the message it answers, in the answering seat's own folder. The record is then carried
through the receiving seat's own cascade, exactly as a send of it would be: its channel-class legs
(the development channel's push, the frame on a Claude session's cross-session socket, the seat's
own runtime queue, a headless resume of its own session), the seat's sender-posted webhook, the
profile-gated typed wake, and the bus inbox under all three. The outcome line names the leg that
took it, in the same words a send prints — `delivered (socket)`, `sent (channel) (… ms)`,
`delivered (webhook, … ms)`, `delivered (typed wake)`, `queued to its native runtime (…)`,
`resumed headlessly (…)` — and `delivered (drop)` when the mailbox takes it, which the run confirms
only after the written record passes the checks the recipient's own readers make: its name is the
id, its `to`, `root` and `session` bind it to that seat and that tree, and its signature verifies. A
queue or resume acceptance is transport only: the line says `queued to its native runtime` or
`resumed headlessly` until a signed read receipt arrives, and `delivered (read)` when it does. A
record whose delivery cannot be confirmed says the folder it wrote to and that the recipient's
reader was not confirmed.
The receiving seat's own watch rings the message-display wake line: the rendered header and the
fixed `Read it with: team drops --read.` hint. A
[team send --wait](send.md) waiting on that thread wakes on the reply record and returns
`answered`. A reply's text is kept in the record, and the project's message history keeps one line
for it, with `thread`, `in-reply-to` and the leg's `via`.

## Synopsis

    team reply <id> <text> [--json]
    team reply <id> --close [--json]

`<id>` is the record being answered, as it is named in the caller's folder (or an unambiguous
prefix of at least 8 characters in that mailbox; an ambiguous prefix is refused naming the
matching ids). `<text>` is every
remaining word, joined with single spaces; `--close` takes no text. A reply's text is required and
must not be empty.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--close` | — | closes the answered record's thread, writing a signed `<id>.closed.json` beside it; takes no text |
| `--json` | — | one document instead of the lines, registered as `schema/reply.schema.json`: the action surface and the outcome in one |

## What it reads and writes

Reads the team file, the caller's placement, the message key, the record the id names with
the records and close sidecars of its thread, and — for a sender of another team — that team's
live file and registry record. Writes one signed record,
`.agents/send-drops/<session>/<seat>/<id>` (mode 0600), into the answered sender's folder — its
own team's tree when the record came from another team — and a
signed `replied` receipt beside the answered record (`<id>.replied.json`); a `--close` writes the
signed close sidecar `<id>.closed.json` beside it instead. A reply on a client thread is the one
exception to the destination: its record goes into the client's own inbox folder, and no history
line is appended. The seat's folder and the reply's
record are each written under the seat's lock (`<state dir>/seat-locks/<session>/<seat>`), so two
commands never write into one folder at once. A reply that finds a seat's lock held waits for the
holder — polling every 25 ms for up to two seconds — and refuses with the holder's process id only
when the wait runs out. It writes one line to `.agents/team.log`, and
appends the reply to the project's message history ([team feed](feed.md)); when the reply record
cannot be written, the receipt is not written either and the run is a refusal.

A reply that is refused writes nothing: no record, no receipt, no close, no history line.

## Who may run it

The owner, or a seat of the team, from a terminal outside the terminal host or its own pane. A run with no
terminal is refused. The caller must be the record's addressee — the record's `to` names it, and
the record sits in its own folder — and the reply reaches the seat the record's `from` names, in
the team the record's registry id places it: a sender whose own file no longer declares the seat
is not reached by a reply. Across teams the reply is written into the sender's own tree, under
the root and session its live file names, and that team's live file is read before anything is
written. The
owner answers a seat's
record through this same path. A record the owner sent is answered at its entity's
`owner-reply-to` endpoint — the `seat@team` address an owner-origin message names — declared by
that entity's own record; no entity ships one. The reply is written into that
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
| replied | `<seat>: delivered (socket)`, `<seat>: sent (channel) (… ms)`, `<seat>: delivered (webhook, … ms)`, `<seat>: delivered (typed wake)`, `<seat>: delivered (read) (… native queue receipt)`, `<seat>: queued to its native runtime (…); no receipt within … ms`, `<seat>: resumed headlessly (…); no receipt within … ms`, or `<seat>: delivered (drop)` on stdout — the seat the reply went to and the leg that took it; the drop is claimed once its reader's folder holds the verified record | 0 |
| replied, reader unconfirmed | `<seat>: wrote to <folder>, and could not confirm the recipient's reader will read it` on stdout | 0 |
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
    team reply: the thread <thread> is already closed; a seat answers the entity's main orchestrator only on the open thread that orchestrator opened, and never opens one; nothing was written
    team reply: <sender>: the thread <thread> was not opened by the entity's main orchestrator; a seat replying to the entity's main orchestrator on its thread is the reach's only reply, and a seat never opens a thread to the main orchestrator; nothing was written
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
claude-keeper: delivered (drop)
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
