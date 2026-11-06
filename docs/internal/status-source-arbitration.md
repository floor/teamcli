# Source arbitration candidate

A pure function in `src/status/source-arbitration.ts`. It is not a command and it is not wired to a
hook, a screen, a process table, or a dispatcher. Its result does not permit dispatch, wake, or
typing.

## Precedence

A snapshot must name the same seat and incarnation as the caller's current context. A native
advisory wins only when that snapshot is healthy and its continuity is proven. Healthy native
working or quiet beats a lower tier. Quiet is not renamed to idle and does not expire because time
passed: time is not an input.

If native cannot win, host is next, then screen. If none of those is usable the result is unknown
immediately. An explicitly current screen prompt may refine native quiet, or native working when
prompt coverage is partial. The winning source and a fixed disagreement reason are both kept. A
screen prompt classifies; it does not authorize an answer.

## Gate and process proof

An open native permission gate stays owner-required. Host and screen readings may attach a prompt
class and may not clear or weaken the gate. Only the native candidate snapshot can show the gate
already cleared.

Session-end without a matching process fact stays process-confirmation-needed and does not become
quiet or idle. A process fact counts only when its seat, incarnation, and process identity match
and its fence is newer than the last accepted fence. Clean exit is `exited` only when that fact
says clean and no gate is open. Abnormal exit is unreachable. An unknown exit fact stays
unconfirmed. A stale or mismatched fact does not replace the current result. Nothing here probes
an operating system.

## What is still unproven

That a live adapter supplied the snapshot, that the process identity is the seat's real process,
or that a person may be asked to answer. Those are later adapter obligations.
