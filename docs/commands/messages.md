# team messages

Shows a message that is already waiting and writes the receipt that says it was shown. Anyone in
the checkout may run it. A send writes the message as one signed record into the recipient's
folder, `<root>/.agents/send-drops/<session>/<seat>/<id>`; `team messages` reads every record still
waiting there, verifies its signature with this checkout's message key, publishes the signed read
receipt (`<id>.read.json`) with an exclusive, no-clobber link, makes it durable, and prints the
body. The receipt is the read-once gate every reader shares, so a record another reader already
served is skipped, and a body is never printed without the receipt that proves it went out. A
record that does not verify prints no body and writes nothing. A waiting general seat brief is not
shown here: it belongs to the seat's own turn-start reader, and the run skips it and notes the seat
(see below). An entry at a receipt name that
does not verify is held rather than repaired, and shows no body. A message a previous build left
in `.agents/messages/<seat>/` is read the same way and keeps its own print-then-write order. The
owner's mailbox, `.agents/messages/owner/`, is read with the rest: the Runtime
writes a signed record there for each event it delivers to the owner (see [the event log and the
bus](../internal/events.md)), its `FROM` is `runtime`, and the run shows it and writes its receipt
like any other waiting record.

A second form reads a client's own replies. `team messages --client <grant-file> --key <key-file>`
presents the owner's client grant and the client's private key; the command builds and verifies a
signed request, admits it against the grant, and reads only that client's inbox,
`<root>/.agents/send-drops/<session>/.clients/<client id>/`. A seat's mailbox is never read on
this path, and a client grant opens no seat's mailbox. A reply is shown only when its signature
verifies, it names this client and its thread, and the seat and agent that wrote it are the ones
the thread's originating grant signed. The grant that opened the thread must still be in the
canonical grants folder; it need not still be active, so a client keeps its history across a
revocation and a reissue. The grant must be a `--inbox` grant: one written without it carries
the send-only vocabulary, and the read is refused with the owner's repair named.

## Synopsis

    team messages [--json]
    team messages --client <grant-file> --key <key-file> [--since <id>] [--ack <id>] [--limit <n>] [--request-id <id>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--client` | `<file>` | read this client's replies from the grant file the owner wrote for it |
| `--key` | `<file>` | the client's private key, `client.key`; required with `--client` |
| `--since` | `<id>` | show only replies ordered after that reply; the id must be a verified reply in this inbox |
| `--ack` | `<id>` | write the read receipt beside that reply; the id is validated on its own, whether or not the page shows it |
| `--limit` | `<n>` | the page bound, from 1 to 100; without it, 20 |
| `--request-id` | `<id>` | the signed request's own id; generated when absent, and claimed once per checkout |
| `--json` | — | the same reading as one document, format 1, registered as `schema/messages.schema.json`: the context, the message rows, the notes, the differences with their repairs, and the counts; the client form is the `team.messages.client` v1 document in `schema/messages-client.schema.json` |

## Who may run it

Anyone in the checkout. The watch asks the recipient's pane to run it. The command shows every
waiting message in the checkout, not only the caller's: a seat runs as the owner-user, and the
mailbox is not a wall between seats.

The client form has no caller placement and reads no seat: the client id in the verified request
decides which inbox is read, and the owner's grant and the client's own key are the whole
authority.

## Output and exit codes

The reading opens with the context line (`team <project>, session "<session>"`) and the headed
table `ID  FROM  TO  SENT  STATUS`, one row per waiting record; each verified body prints under
its own `<seat>/<id>:` heading, then the notes and the differences print, and one summary line
(`<n> message` or `<n> messages`) closes it. `SENT` is the record's own timestamp read as its age; `--json` also
carries the exact ISO string as `sent`. The `FROM` cell reads the sender as the project's
[`sender_name`](../team-file.md#sender_name) word asks; `--json` carries the record's own `from`,
and the signed record keeps the sender's registry id apart from it.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every waiting record was shown and receipted | the reading above, each verified row `shown`, its read receipt published and durable before its body is printed; a record another reader already served is skipped | 0 |
| a general seat brief was waiting | no row and no body for it, no receipt; a note names the seat: `<seat>: the general seat brief is not shown here; the seat's own turn-start reader serves it.` | 0 |
| nothing was waiting | the same reading with no rows, the note `nothing is waiting`, and `0 messages` | 0 |
| a record did not verify, a read or replied receipt name is held by an entry that does not verify, the message key is missing or unreadable, or the team file can't be read | the record as a `refused` row with its `difference:` block (`repair:` names the file, `who: any seat`), or `team messages: no message key; nothing was shown` / `team messages: <team-file problem>` | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team messages: <problem>`, with the usage for the invocation | 2 |

A record that does not verify prints no body and writes no receipt. A record whose receipt name is
held by an entry that does not verify prints no body, and the entry is left as it is: it may
record a read that already happened, so the run never deletes or rewrites it.

A general seat brief is never shown here, because its read is bound to the seat's current claim and
only the seat's own turn-start reader writes that receipt. The record is verified first — a brief
that does not verify is still a refused row with its difference — and a verified one is skipped
with no row, no body, no receipt and no claim or state read. One note names each seat it skipped:
`<seat>: the general seat brief is not shown here; the seat's own turn-start reader serves it.`
The counts are unchanged: a skipped brief is neither `shown` nor `refused`.

The client reading has the same shape: the context line, the table, one heading and body under
each verified reply, the notes and differences, the `ack:` line when `--ack` was given, and the
closing `<n> message` or `<n> messages`. A refused record is a `refused` row with its difference
and never a body. `--since` narrows the page to replies ordered after the named reply by time,
then by id; `--limit` cuts that page. `--ack` is independent of the page: its reply is validated
against the whole verified inbox, so a reply outside the page can be acknowledged without its
body being printed. A receipt is written once and never replaced: a second acknowledgement of the
same reply prints `ack: <id> already acknowledged` and writes nothing. Every client invocation,
a usage refusal included, writes `key isolation: enforced against team panes (key file still readable by same-user processes)` to stderr
first; under `--json` the same line also rides in the document as `key_isolation`.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the client reading completed, with or without shown replies | the reading above; an `ack:` line follows an `--ack` | 0 |
| nothing was waiting | the reading with no rows and the note `nothing is waiting` | 0 |
| a record or the ack does not verify, or the request, grant, placement or inbox can't be read | the refused rows with their differences, or `team messages: refused: <why>` | 1 |
| the client key is missing or unreadable, or the ack receipt cannot be signed | `team messages: <why>` | 1 |
| the client invocation can't be read | `team messages: <why>` and the usage | 2 |

The client reading has the same shape: the context line, the table, one heading and body under
each verified reply, the notes and differences, the `ack:` line when `--ack` was given, and the
closing `<n> message` or `<n> messages`. A refused record is a `refused` row with its difference
and never a body. `--since` narrows the page to replies ordered after the named reply by time,
then by id; `--limit` cuts that page. `--ack` is independent of the page: its reply is validated
against the whole verified inbox, so a reply outside the page can be acknowledged without its
body being printed. A receipt is written once and never replaced: a second acknowledgement of the
same reply prints `ack: <id> already acknowledged` and writes nothing. Every client invocation,
a usage refusal included, writes `key isolation: enforced against team panes (key file still readable by same-user processes)` to stderr
first; under `--json` the same line also rides in the document as `key_isolation`.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the client reading completed, with or without shown replies | the reading above; an `ack:` line follows an `--ack` | 0 |
| nothing was waiting | the reading with no rows and the note `nothing is waiting` | 0 |
| a record or the ack does not verify, or the request, grant, placement or inbox can't be read | the refused rows with their differences, or `team messages: refused: <why>` | 1 |
| the client key is missing or unreadable, or the ack receipt cannot be signed | `team messages: <why>` | 1 |
| the client invocation can't be read | `team messages: <why>` and the usage | 2 |

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

Nothing is waiting:

```console
$ team messages ; echo "exit $?"
team beacon, session "beacon"
  ID  FROM  TO  SENT  STATUS

note: nothing is waiting

0 messages
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/messages.md](../internal/messages.md).
