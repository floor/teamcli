# team queues

The per-seat delivery queues of a checkout (rfc-event-comms, steps E6, E7 and E7b).

## Synopsis

    team queues status
    team queues activate
    team queues prove [<seat>]
    team queues deactivate
    team queues reader on|off

## What each verb does

| Verb | Effect | Who |
| --- | --- | --- |
| `status` | prints the root's floor state (`dark`, `active`, `fenced`, `unknown`), the reader switch, and each seat queue's check (`complete` or `incomplete` with the reason) | anyone |
| `activate` | turns on at-least-once delivery for the team. It is refused while any live TeamCLI process of the team (the daemon, a seat's inbox server) reports a level below 3 or none. It writes PROTOCOL, the signed ACTIVATION record, and PUBLISHED once the record is durable | the owner, or a lead in development mode |
| `prove [<seat>]` | places one channel proof probe for each running Claude Code seat that `activate` refuses as "unproven since launch" (a live channel listener, no proving ack yet), or for the named seat. The probe is a signed, stamped record from the runtime; the seat's channel server pushes it with an offer token, and the seat's ack with that offer writes the proof `activate` reads. An ack without the offer settles the probe and proves nothing. A probe still waiting for the current listener is not placed again. This is the only proof before activation for a seat whose pane is protected (the entity's main orchestrator). It activates nothing | the owner, or a lead in development mode |
| `deactivate` | the rollback to dark, in one command. It removes the reader switch, the publication, the record and the marker in that order, each durably, behind a `DEACTIVATING` marker; a cut-off rollback is finished by running it again, and `activate` refuses while one is unfinished | the owner, or a lead in development mode |
| `reader on` | on an active root at level 3 whose every seat queue is complete (no hole, every unread message placed, pending dual writes drained, quarantine empty), writes the signed READER switch: seats then read their mail in queue order, each message with its seq | the owner, or a lead in development mode |
| `reader off` | removes the switch: every reader is back on the legacy listing at once | the owner, or a lead in development mode |

## At-least-once delivery

A message sent while its team is not proven dark is **stamped** (`lvl: 3`, inside the signed
record). A stamped message:

- is delivered until its recipient acknowledges it: `team ack <id>`, the channel's `ack` tool, a
  reply, or a lead's clearance. A read by itself, a stream write or a typed line never settles it;
- is offered again on its seat's retry ladder, with no last attempt: on the channel after 60 s,
  then on a doubling wait that stops growing at 30 minutes; on the typed and event legs on the
  watch's ladder (5, 10, 20, then every 30 minutes);
- carries, in every copy, a header naming the message and its delivery number. Any copy after the
  first says it is a re-send, so a repeat is never silent, in whatever order the copies arrive;
- keeps all of this for its whole life, through a rollback and a later activation;
- is never moved out of its seat's inbox while the seat is in the registry, running or stopped. When
  the seat is retired, it moves to `archive/<YYYY-MM>/unread/` and its sender is told
  "not delivered: seat retired".

The daemon rolls an active team back to dark on its next pass when a TeamCLI process below level 3
appears. A build older than this one refuses a stamped record as unsupported, so it never presents
one. **Not covered:** an older TeamCLI process started outside TeamCLI's own launch.

The reader switch changes the order mail is offered in, never which mail waits. A listing that
cannot be proved in queue order at read time is the legacy listing, so a fallback delays order and
never hides a message.

The daemon never activates a root on its own.

## Exit codes

| Outcome | Exit |
| --- | --- |
| the status printed, the root activated (or already active), rolled back, the switch set | 0 |
| a change refused or failed (the reason is printed) | 1 |
| the invocation or the project can't be read | 2 |
