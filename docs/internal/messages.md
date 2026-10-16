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
watch`, not `team messages`, not a seat. `team send` writes a frame to a seat's cross-session
socket, which is not this mailbox and leaves no record here. A report still leaves as today's
nudge,
`Team watch: reports are waiting in .agents/team.log`. The watch only rings
`Team: run team messages` when a record is already there.

The signature is integrity, not authenticity. Every seat runs as the owner-user, so a signature
says the record was not rewritten after it was signed. It does not say which seat sent it. `from`
is a name the writer put on the record. The receipt says a process was shown the body, not that
the recipient acted on it.

The message key is a second file, `~/.config/team-key/messages.json`, beside the approval key.
It is created the first time a message or a receipt is signed; nothing else creates it, and an
empty mailbox creates nothing. The approval key never signs a message.

## What it reads and writes

Reads the git checkout (`findRoot`), the team file's session, and
`.agents/messages/<seat>/<id>.json`. The id is the filename. The recipient is the seat directory.
The root is `findRoot`. The session is the team file's session. A copy under a new id, or into
another seat's directory, or bound to another checkout or session, does not verify.

Writes `.agents/messages/<seat>/<id>.read.json` for each record that verifies, signed with the
message key under its own domain. The receipt is written only after `io.stdout` has returned the
body: a write that throws leaves no receipt, and the record stays waiting. A receipt that does
not verify leaves the message waiting.
The second run, once every waiting record has a receipt, prints that nothing is waiting.

`team init` lists `.agents/messages/` in `.git/info/exclude`, the same way it lists the team file.

## Who may run it

Anyone in the checkout. The watch asks the recipient's pane to run it. The command shows every
waiting message in the checkout, not only the caller's: a seat runs as the owner-user, and the
mailbox is not a wall between seats.

## Refusals

A record that fails one of these prints no body and writes no receipt:

    team messages: <seat>/<id> does not verify: the record is not a message
    team messages: <seat>/<id> does not verify: its id is <id>, and the filename is the id
    team messages: <seat>/<id> does not verify: it is addressed to <seat>
    team messages: <seat>/<id> does not verify: it is bound to another checkout
    team messages: <seat>/<id> does not verify: it is bound to session "<session>"
    team messages: <seat>/<id> does not verify: the signature is not the message key's
    team messages: no message key; nothing was shown

An empty mailbox is not a refusal:

    team messages: nothing is waiting

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
team messages: nothing is waiting
exit 0
```
