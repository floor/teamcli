# team messages

Shows a message that is already waiting and writes the receipt that says it was shown. Anyone in
the checkout may run it. It verifies the record, prints the body, and writes the receipt in that one
step; a record that does not verify prints no body and writes nothing. Nothing in this build writes
a message record: the watch only rings when a record is already there.

## Synopsis

    team messages

## Who may run it

Anyone in the checkout. The watch asks the recipient's pane to run it. The command shows every
waiting message in the checkout, not only the caller's: a seat runs as the owner-user, and the
mailbox is not a wall between seats.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every waiting record was shown and receipted | each verified record's body, with its receipt written after stdout returned | 0 |
| nothing was waiting | `team messages: nothing is waiting` | 0 |
| a record did not verify, the message key is missing or unreadable, or the team file can't be read | `team messages: <seat>/<id> does not verify: <why>`, or `team messages: no message key; nothing was shown` | 1 |
| the invocation can't be read, or this folder is not a git checkout | `team messages: <problem>`, with the usage for the invocation | 2 |

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
team messages: nothing is waiting
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/messages.md](../internal/messages.md).
