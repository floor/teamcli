# team queues

The per-seat delivery queues of a checkout (rfc-event-comms, steps E6 and E7).

## Synopsis

    team queues status
    team queues activate
    team queues reader on|off

## What each verb does

| Verb | Effect | Who |
| --- | --- | --- |
| `status` | prints the root's floor state (`dark`, `active`, `fenced`, `unknown`), the reader switch, and each seat queue's check (`complete` or `incomplete` with the reason) | anyone |
| `activate` | dark in this build: refused for everyone (exit 1) until the managed launch boundary (E7b) is reviewed and merged. The transaction it will run proves every live actor at the floor (level 3), then writes PROTOCOL, the signed ACTIVATION record, and PUBLISHED once the record is durable | — |
| `reader on` | on an active root at level 3 whose every seat queue is complete (no hole, every unread message placed, pending dual writes drained, quarantine empty), writes the signed READER switch: seats then read their mail in queue order, each message with its seq | the owner, or a lead in development mode |
| `reader off` | removes the switch: every reader is back on the legacy listing at once (the rollback) | the owner, or a lead in development mode |

The switch changes the order mail is offered in, never which mail waits: the canonical records and
the receipts that settle a message are the same in both modes. A listing that cannot be proved in
queue order at read time (a lock held, a hole, a message with no entry, a root not active) is the
legacy listing, so a fallback delays order and never hides a message.

The daemon never activates a root on its own. Every first-body hand-over takes the durable read claim
whatever the root's floor state, so a second carrier gets a pointer.

## Exit codes

| Outcome | Exit |
| --- | --- |
| the status printed, the root activated (or already active), the switch set | 0 |
| a change refused or failed (the reason is printed) | 1 |
| the invocation or the project can't be read | 2 |
