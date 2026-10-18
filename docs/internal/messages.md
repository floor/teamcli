# `team messages`: rationale and known limits

What moved off [the `team messages` page](../commands/messages.md): what the run reads and
writes, the key and the receipt, the behaviour behind the lines it prints, the refusals in their
own words, and the known limits. The synopsis, the caller line and the exit codes stay on the
page.

## What the run does: the mailbox, the receipt, the key

Shows a message that is already waiting and writes the receipt that says it was shown. Anyone in
the checkout may run it. It verifies the record, prints the body, and writes the receipt in that
one step. A record that does not verify prints no body and writes nothing.

Nothing in this build writes a message record. No command writes the first record: not `team
watch`, not `team messages`, not a seat. `team send` gives a seat the body in a drop file and one
typed trigger line — its cross-session socket path is refused in this build — which is not this
mailbox and leaves no record here. A report is not typed into a seat: it goes to the log, and a
report for the owner also to the desktop notification. The watch only rings
`Team: run team messages` when a record is already there.

The signature is integrity, not authenticity. Every seat runs as the owner-user, so a signature
says the record was not rewritten after it was signed. It does not say which seat sent it. `from`
is a name the writer put on the record. The receipt says a process was shown the body, not that
the recipient acted on it.

The message key is a second file, `~/.config/team-key/messages.json`, beside the approval key.
It is created the first time a message or a receipt is signed. An empty mailbox creates nothing.
The approval key never signs a message.

## What it reads and writes

Reads the git checkout (`findRoot`), the team file's session, and
`.agents/messages/<seat>/<id>.json`. The id is the filename. The recipient is the seat directory.
The root is `findRoot`. The session is the team file's session. A copy under a new id, or into
another seat's directory, or bound to another checkout or session, does not verify.

Writes `.agents/messages/<seat>/<id>.read.json` for each record that verifies, signed with the
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
`nothing is waiting`, and three zero counts. An invocation, checkout, team-file or key refusal
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

    difference: <seat>/<id> does not verify: the record is not a message
      repair: remove .agents/messages/<seat>/<id>.json, or restore it from the sender
      who: any seat

    difference: <seat>/<id> does not verify: its id is <payload id>, and the filename is the id
      repair: move .agents/messages/<seat>/<id>.json to .agents/messages/<seat>/<payload id>.json, or remove it
      who: any seat

    difference: <seat>/<id> does not verify: it is addressed to <payload to>
      repair: move .agents/messages/<seat>/<id>.json to .agents/messages/<payload to>/<id>.json, or remove it
      who: any seat

    difference: <seat>/<id> does not verify: it is bound to another checkout
      repair: remove .agents/messages/<seat>/<id>.json: it is bound to another checkout
      who: any seat

    difference: <seat>/<id> does not verify: it is bound to session "<session>"
      repair: remove .agents/messages/<seat>/<id>.json: it is bound to another session
      who: any seat

    difference: <seat>/<id> does not verify: the signature is not the message key's
      repair: remove .agents/messages/<seat>/<id>.json, or have the sender re-send it
      who: any seat

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
