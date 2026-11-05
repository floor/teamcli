# team messages

Shows a message that is already waiting in the caller's mailbox and writes the receipt that says
it was shown. A send writes the message as one signed record into the recipient's folder,
`<root>/.agents/send-drops/<session>/<seat>/<id>`; `team messages` reads every record still waiting
there, verifies its signature with this checkout's message key, publishes the signed read receipt
(`<id>.read.json`) with an exclusive, no-clobber link, makes it durable, and prints the body. The
receipt is the read-once gate every reader shares, so a record another reader already served is
skipped, and a body is never printed without the receipt that proves it went out. A record that
does not verify prints no body and writes nothing. A waiting general seat brief is not shown here:
it belongs to the seat's own turn-start reader, and the run skips it and notes the seat (see below).
An entry at a receipt name that
does not verify is held rather than repaired, and shows no body. A message a previous build left
in `.agents/messages/<seat>/` is read the same way and keeps its own print-then-write order.

A run serves one mailbox: the owner's, or the seat its caller is placed as in the team's session,
by the same placement `team send` and `team ack` judge. The record stores are shared, so records
addressed to other seats are still listed — one `waiting` row each, carrying the fields a key can
verify — but they are never receipted: the receipt is the read that spends an id, and only the
addressed mailbox's own reader may spend it. A seat's run carries no body for them. The owner's
run is the whole session's read-only view, so its waiting rows carry the verified body too and
still write no receipt for another mailbox. A caller the placement cannot resolve reads nothing
and publishes nothing. The owner's mailbox, `.agents/messages/owner/`,
is the owner's own: the Runtime
writes a signed record there for each event it delivers to the owner (see [the event log and the
bus](../internal/events.md)), its `FROM` is `runtime`, and the owner's run shows it and writes its
receipt like any other waiting record of that mailbox.

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

The owner, or a seat of the team's session, placed by the caller rules `team send` and `team ack`
use. The run serves the caller's own mailbox, and the watch asks the recipient's pane to run it, so
a seat reads only its own mail. A call the placement cannot resolve — a terminal it cannot walk to
a seat, or a pane this session does not hold — reads nothing: no body, no receipt, exit 1. There
is no checkout-wide view that spends mail: records for other mailboxes list as `waiting` rows,
without their bodies and without receipts.

The client form has no caller placement and reads no seat: the client id in the verified request
decides which inbox is read, and the owner's grant and the client's own key are the whole
authority.

## Output and exit codes

The reading opens with the context line (`team <project>, session "<session>"`) and the headed
table `ID  FROM  TO  SENT  STATUS`, one row per waiting record: the caller's mailbox's records as
`shown` or `refused`, and every record addressed to another mailbox as `waiting`; each verified
body prints under
its own `<seat>/<id>:` heading, then the notes and the differences print, and one summary line
(`<n> message` or `<n> messages`) closes it. `SENT` is the record's own timestamp read as its age; `--json` also
carries the exact ISO string as `sent`. The `FROM` cell reads the sender as the project's
[`sender_name`](../team-file.md#sender_name) word asks, followed by `(attributed)` — every
displayed sender is attributed, never verified: the shared checkout key every seat can read
proves a record was not changed after signing, not who wrote it — or `(unattributed)` when no key
could vouch for the file. A printed body is rendered the same way [`team drops --read`](drops.md)
renders one: its `from … — admitted by: …` line is folded into the compact header (`from <name> (<short rule>):`, `<Display>, a client (owner relay):`, or `<Kind> seat <name> (<short rule>):` for a non-Claude seat), and a
body with no such line opens with `[attributed sender: <sender>]`, the message's own words
untouched. `--json` carries the record's own `from` with `sender_attribution` beside it
(`attributed`, `launch-brief`, or `none`), its `body` stays the signed bytes — only the text
reading marks it — and the signed record keeps the sender's registry id apart from it.
A `waiting` row writes no
receipt: it says the record is there for its own mailbox's reader, and a seat's run carries no
body for it. The owner's run is read-only over the whole session and does carry the verified body
on a `waiting` row; a record that does not verify carries none, whichever the caller. `--json`
counts the rows as `messages`, the bodies served as `shown`, the differences as `refused`, and the
other mailboxes' rows as `waiting`.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every waiting record of the caller's mailbox was shown and receipted | the reading above, each verified row `shown`, its read receipt published and durable before its body is printed; a record another reader already served is skipped | 0 |
| a record for another mailbox was waiting | one `waiting` row for it and no receipt; a seat's run carries no body, and the note `1 message addressed to another mailbox is waiting; it is listed without its body, and no receipt is written for it.` (`2 messages … are waiting; they are listed without their bodies, and no receipts are written for them.` for more); the owner's run carries the verified body and the note `1 message … ; it is shown read-only, and no receipt is written for it.` (`2 messages … are waiting; they are shown read-only, and no receipts are written for them.` for more) | 0 |
| a general seat brief of the caller's own mailbox was waiting | no row and no body for it, no receipt; a note names the seat: `<seat>: the general seat brief is not shown here; the seat's own turn-start reader serves it.` | 0 |
| nothing was waiting | the same reading with no rows, the note `nothing is waiting`, and `0 messages` | 0 |
| the caller is not the owner or a seat of the team's session | `team messages: only the owner or a seat of this session reads a mailbox; this call is <caller>` (under `--json`, the `messages.caller` envelope); nothing is listed and nothing is receipted | 1 |
| a record did not verify, a read or replied receipt name is held by an entry that does not verify, the message key is missing or unreadable, or the team file can't be read | the record as a `refused` row with its `difference:` block (`repair:` names the file, `who: any seat`), or `team messages: no message key; nothing was shown` / `team messages: <team-file problem>` | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team messages: <problem>`, with the usage for the invocation | 2 |

A record that does not verify prints no body and writes no receipt. A record whose receipt name is
held by an entry that does not verify prints no body, and the entry is left as it is: it may
record a read that already happened, so the run never deletes or rewrites it.

A general seat brief in the caller's own mailbox is never shown here, because its read is bound to
the seat's current claim and only the seat's own turn-start reader writes that receipt. The record
is verified first — a brief that does not verify is still a refused row with its difference — and
a verified one is skipped with no row, no body, no receipt and no claim or state read. One note
names each seat it skipped:
`<seat>: the general seat brief is not shown here; the seat's own turn-start reader serves it.`
The counts are unchanged: a skipped brief is neither `shown` nor `refused`. A brief waiting for
another mailbox is a plain `waiting` row, like any record that mailbox's reader has not served.

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
