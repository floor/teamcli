# team messages

Shows a message that is already waiting and writes the receipt that says it was shown. Anyone in
the checkout may run it. A send writes the message as one signed record into the recipient's
folder, `<root>/.agents/send-drops/<session>/<seat>/<id>`; `team messages` reads every record still
waiting there, verifies its signature with this checkout's message key, prints the body, and writes
the signed read receipt (`<id>.read.json`) in that one step. A record that does not verify prints
no body and writes nothing. A message a previous build left in `.agents/messages/<seat>/` is read
the same way. The owner's mailbox, `.agents/messages/owner/`, is read with the rest: the Runtime
writes a signed record there for each event it delivers to the owner (see [the event log and the
bus](../internal/events.md)), its `FROM` is `runtime`, and the run shows it and writes its receipt
like any other waiting record.

## Synopsis

    team messages [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | the same reading as one document, format 1, registered as `schema/messages.schema.json`: the context, the message rows, the notes, the differences with their repairs, and the counts |

## Who may run it

Anyone in the checkout. The watch asks the recipient's pane to run it. The command shows every
waiting message in the checkout, not only the caller's: a seat runs as the owner-user, and the
mailbox is not a wall between seats.

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
| every waiting record was shown and receipted | the reading above, each verified row `shown` and its body printed before the receipt is written | 0 |
| nothing was waiting | the same reading with no rows, the note `nothing is waiting`, and `0 messages` | 0 |
| a record did not verify, the message key is missing or unreadable, or the team file can't be read | the record as a `refused` row with its `difference:` block (`repair:` names the file, `who: any seat`), or `team messages: no message key; nothing was shown` / `team messages: <team-file problem>` | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team messages: <problem>`, with the usage for the invocation | 2 |

A record that does not verify prints no body and writes no receipt.

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
