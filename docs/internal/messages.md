# `team messages`: rationale and known limits

What moved off [the `team messages` page](../commands/messages.md): what the run reads and
writes, the key and the receipt, the behaviour behind the lines it prints, the refusals in their
own words, and the known limits. The synopsis, the caller line and the exit codes stay on the
page.

## What the run does: the mailbox, the receipt, the key

Shows a message that is already waiting and writes the receipt that says it was shown. Anyone in
the checkout may run it. It verifies the record, prints the body, and writes the receipt in that
one step. A record that does not verify prints no body and writes nothing.

`team send` writes the record: one signed message per send, into the recipient's folder
`<root>/.agents/send-drops/<session>/<seat>/<id>`, before the leg that carries it runs. The typed
leg types the wake line that names the record, the drop leg leaves the record for its seat, and
the mcp-inbox leg puts the same record in the seat's inbox. The watch rings
`Team: run team messages` when a record is already there, and never writes one. A message a
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
message key under its own domain. The receipt is written only after `io.stdout` has returned the
body: a write that throws leaves no receipt, and the record stays waiting. A receipt that does
not verify leaves the message waiting.
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

A missing or unreadable message key is a refusal of the whole run, with nothing shown:

    team messages: no message key; nothing was shown

An empty mailbox is not a refusal:

    note: nothing is waiting

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
