# `team messages`: rationale and known limits

What moved off [the `team messages` page](../commands/messages.md): what the run reads and
writes, the key and the receipt, the behaviour behind the lines it prints, the refusals in their
own words, and the known limits. The synopsis, the caller line and the exit codes stay on the
page.

## What the run does: the mailbox, the receipt, the key

Shows a message that is already waiting and writes the receipt that says it was shown. Anyone in
the checkout may run it. It verifies the record, publishes the signed read receipt with the same
exclusive, no-clobber link the inbox uses, makes it durable, and then prints the body. The receipt
is the per-id gate every reader shares, so a message another reader already served is skipped, and
no body is shown without the receipt that proves the exposure. A record that does not verify
prints no body and writes nothing. The older `.agents/messages` store keeps its own receipt shape
and its original print-then-write order.

`team send` writes the record: one signed message per send, into the recipient's folder
`<root>/.agents/send-drops/<session>/<seat>/<id>`, before the leg that carries it runs. The typed
leg types the wake line that names the record, the drop leg leaves the record for its seat, and
the mcp-inbox leg puts the same record in the seat's inbox. The watch rings
`Team: run team drops --read --seat <seat> --session <session>` — the waiting seat's own read —
when a record is already there, and never writes one. A message a
previous build left in `.agents/messages/<seat>/` is read the same way. The owner's mailbox is
`.agents/messages/owner/`: the Runtime writes one signed record there for each event it delivers
to the owner, its `from` is `runtime`, and the run lists it and writes its receipt like any other
record (see [the event log and the bus](events.md)). A report to the owner still goes to the log,
and also to the desktop notification.

The signature is integrity, not authenticity. Every seat runs as the owner-user, so a signature
says the record was not rewritten after it was signed. It does not say which seat sent it. `from`
is a name the writer put on the record. The receipt says a process was shown the body, not that
the recipient acted on it.

The message key is a second file, `~/.config/team-key/messages.json`, beside the approval key.
It is created the first time a message or a receipt is signed. An empty mailbox creates nothing.
The approval key never signs a message.

## What it reads and writes

Reads the team root the shared loader resolves (`loadTeamFile`: the enclosing checkout, or the
folder that holds `.agents/team.yaml`), the team file's session, and
`.agents/send-drops/<session>/<seat>/<id>`, and the older store's
`.agents/messages/<seat>/<id>.json` where a previous build left one. The id is the filename. The
recipient is the seat directory. The root is that resolution. The session is the team file's, or for a
record the session directory it was found under. A copy under a new id, or into another seat's
directory, or bound to another root or session, does not verify.

Writes the signed read receipt beside the record, `<id>.read.json` in the same folder — the older
store keeps its own receipt shape at `.agents/messages/<seat>/<id>.read.json` — signed with the
message key under its own domain. For a record in the transport tree the receipt is published
before the body, through the same `link` the inbox uses, and it is flushed with its folder before
the body is printed: exactly one reader — this run, `team drops --read` or `inbox_read` — wins
the id, and a crash after the print leaves the receipt that proves the exposure. A receipt that
cannot be published prints no body and leaves the id waiting; one that was linked but could not be
flushed prints no body and spends the id. The older store keeps its original order: the body
prints first and its receipt is written after `io.stdout` returns.

A valid `read` or `replied` receipt at the name means another reader already served the message:
the run skips it silently, with no row and no body. An entry at the read or replied receipt name
that does not verify for this message is not proof the content went unserved — it may hide a read
that happened, so it is preserved and the record is a `refused` row with no body, and the
difference tells the caller to inspect the file rather than remove it. A link, a FIFO or a folder
at either name is refused the same way.

A waiting general seat brief is not a message this mailbox serves. Its read is bound to the seat's
current claim — the incarnation, the delivered digest and the runtime epoch — so only the seat's
own readers write that receipt, `team drops --read` and the inbox's `inbox_read`. The run verifies
the record like any other, then skips it: no row, no body, no receipt, and no claim or state read.
One note names each seat it skipped — `<seat>: the general seat brief is not shown here; the
seat's own turn-start reader serves it.` — in the text reading and in `notes` under `--json`. The
skip comes after verification, so a brief that does not verify is still a refused row with its
difference and its `record.invalid` event. The counts stay `messages = shown + refused`: a skipped
brief is in neither. A brief that already has a receipt is skipped by the waiting filter before
this point, and no receipt is ever rewritten.

The second run, once every waiting record has a receipt, prints the zero-message reading: the
table's headers and no rows, `note: nothing is waiting`, and `0 messages`.

Under `--json` the reading is one `team.messages` v1 document on stdout, its `schema` tag first:
`format`, `project`, `session`, every row as `{ id, from, to, sent, sent_display, status, body? }`
— `sent` the exact ISO string `SENT` renders as an age, `body` only on a row that verified — then
`notes`, `differences` (each `{ what, repair, who }`), `summary` (the `differences` and
`owner_differences` counts every reading envelope carries) and `counts` (`messages`, `shown`,
`refused`, the table's own closing figures). An empty mailbox's document carries no rows, the note
`nothing is waiting`, and three zero counts. An invocation, root, team-file or key refusal
under `--json` writes a `team.error` v1 document on stdout instead — `messages.invocation`,
`messages.not-a-repo`, `messages.file` or `messages.key`, its `message` and a null `repair` — and
stderr stays empty. The exit code is the same as without `--json`.

`team init` lists `.agents/messages/` in `.git/info/exclude`, the same way it lists the team file.

## Who may run it

Anyone in the checkout. The watch asks the recipient's pane to run it. The command shows every
waiting message in the checkout, not only the caller's: a seat runs as the owner-user, and the
mailbox is not a wall between seats.

## Refusals

A record that fails one of these prints no body and writes no receipt. It is a `refused` row in
the table, and the run prints its difference before the summary; `who` is `any seat`, and the
repair names the file the table already shows:

    difference: <seat>/<id> does not verify: the record is not a message record
      repair: remove .agents/send-drops/<session>/<seat>/<id>, or restore it from the sender
      who: any seat

    difference: <seat>/<id> does not verify: its id is <payload id>, and the filename is the id
      repair: move .agents/send-drops/<session>/<seat>/<id> to .agents/send-drops/<session>/<seat>/<payload id>, or remove it
      who: any seat

    difference: <seat>/<id> does not verify: it is addressed to <payload to>
      repair: move .agents/send-drops/<session>/<seat>/<id> to .agents/send-drops/<session>/<payload to>/<id>, or remove it
      who: any seat

    difference: <seat>/<id> does not verify: it is bound to another checkout
      repair: remove .agents/send-drops/<session>/<seat>/<id>: it is bound to another checkout
      who: any seat

    difference: <seat>/<id> does not verify: it is bound to session "<session>"
      repair: remove .agents/send-drops/<session>/<seat>/<id>: it is bound to another session
      who: any seat

    difference: <seat>/<id> does not verify: the signature is not the message key's
      repair: remove .agents/send-drops/<session>/<seat>/<id>, or have the sender re-send it
      who: any seat

A file in the older store prints the same differences with `.agents/messages/<seat>/<id>.json` in
place of the record's path, and its shape refusal reads `the record is not a message`.

A record that verifies can still be refused at its receipt names. The read or replied name may be
held by a file that does not verify for this message, or by something that is not a file, or the
receipt may fail to publish or to flush. The body is not printed, the entry is left exactly as it
is — this read never deletes or rewrites a receipt, because a damaged one may be the only evidence
that a body was exposed — and the difference names it:

    difference: <seat>/<id> was not shown: the read receipt name is held by a file that does not verify for this message
      repair: inspect .agents/send-drops/<session>/<seat>/<id>.read.json: it is left as it is, because it may record a read that already happened
      who: any seat

A receipt that was linked but could not be flushed spends the id: the run prints no body, and the
difference says the receipt stays and the message stays spent. A message another reader already
served is not a refusal — it is skipped silently, with no row and no body.

A missing or unreadable message key is a refusal of the whole run, with nothing shown:

    team messages: no message key; nothing was shown

An empty mailbox is not a refusal:

    note: nothing is waiting

## The client inbox

The read side of a client grant is a second reader with its own folder, its own admission and its
own receipt. It never reads a seat's mailbox, and a seat never reads it.

The folder is `<root>/.agents/send-drops/<session>/.clients/<client id>/`. The leading dot is what
keeps it out of every seat reader: `team messages`, `team reply`, `team drops`, the watch and the
bus reconciliation all filter the session folder's first segment with a name pattern a leading dot
cannot match. A reply on a client thread lands there, written by the seat the thread's grant names;
the client's read is the only reader.

The folder is created mode 0700 and never `chmod`'ed. A folder found with any group or other bit, a
symbolic link, another user's folder, or a non-directory is refused with the repair named, rather
than repaired in place. Records and receipts are written whole at mode 0600 through a temporary
file linked onto the final name: publication never replaces an existing name, and no `chmod` call
runs on the inbox or its files.

### Admission

A read is a signed request, and the command verifies it before it scans anything:

1. the grant file is read and its signature and shape verify;
2. the grant's client id and entity must be the one principal and entity this build admits —
   `grok-bot` and `floor` — and its recipient must resolve to `orchestrator@floor`;
3. the signed v2 request is verified against the grant's public key: the domain, the operation
   `messages`, the grant id, client id, key id, entity, `since`, `ack`, `limit`, `request id` and
   `issued_at` are all inside the signature, and the grant must be canonical, unexpired and
   unrevoked;
4. the grant is checked active again, and the registry binding is resolved a second time: the
   coordinator's team, seat and agent id, the checkout and the session must still be the ones the
   grant signs;
5. the request id is claimed under the grant lock before any row is scanned: a replay of an
   already-claimed request is refused with nothing read and nothing written;
6. the inbox folder is checked as above, and the message key is read;
7. only then is the folder scanned.

Every failure before step 7 leaves no row scanned and no receipt written.

### What is shown

A file in the inbox is shown only when its signature verifies and it names this client and its own
thread: `to` is `client:<client id>`, `to_id` is null, `to_client` names the same client and the
grant that opened the thread, `thread` and `in_reply_to` are the opening record's id, the record's
root and session are this checkout's, the writer is the seat and agent id the grant signs, and the
opening record itself verifies with `from_client` and no `to_client`. A file that fails any of
these is a `refused` row with its difference and prints no body.

The thread's originating grant must be in the canonical grants folder; it need not still be
active. A revoked or expired grant leaves the history readable, and a later grant never
reauthorizes a thread. A file named `<id>.read.json` is the read receipt, a sibling the scan skips.

### The ack

`--ack <id>` acknowledges one reply independently of the page: the id is validated against every
verified reply in the inbox, so a reply outside `--since`/`--limit` can be acknowledged without
its body being printed. The acknowledgement is written as a signed `<id>.read.json` receipt at
0600, once: a second acknowledgement prints `ack: <id> already acknowledged` and writes nothing.
An existing receipt that does not verify is not replaced — the ack is refused, the run exits 1,
and the reason names the file for the owner to remove. A reply whose body is outside the page is
never printed.

### The client pane guard

A client key is the client's, never a seat's. `team send --client`, `team messages --client` and
`team client keygen` place their caller with the same parent-process walk the owner gates use (never an environment
variable) and refuse a caller that runs inside a herdr pane — a seat, an agentless team pane, or a
process either started — before the grant or the key is opened: exit 1, `send.client-pane`,
`messages.client-pane` or `client.keygen.pane`. Every grant-verified client form (`team up
--client`, `team down --client`, `team status --client` and the bundle ops such as `pause`,
`resume`, `hold`, `add`, `remove`, `seat`, `seats`, `reload`, `restart` and `sessions`) runs the
same guard inside `verifyClientUp`, so it is refused with that command's own client refusal
before its grant or key is read. Keys stay under `~/.config/team-client`, and
an external client outside herdr (an agent CLI included) is not refused. A usage error is still judged first and keeps exit 2. The guard is a
policy, not a wall: the owner's dev mode lifts it through the shared owner-gate admission
(`devModeOwnerLiftAtCwd`), and a lifted run prints the dev-mode warning and goes on. Seatbelt
confinement of `~/.config/team-client` for guarded seats belongs to the pane guard
(`src/guard`), which is not on this line yet.

### Known limits

The key is still a file on disk: `key isolation: enforced against team panes (key file still readable by same-user processes)` is printed on
stderr on every client invocation, usage refusals included, and carried in the JSON as
`key_isolation`. The read protects the inbox from other principals by grant and signature, not the
key from same-user processes. The request replay claim is per checkout and client; it does not
expire on its own. The page bound is 20 by default and 100 at most.

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console, and the file fence
it reads, are also on [the `team messages` page](../commands/messages.md).

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
