# team route

Answers one seat's address for the native channel: a sender that delivers with its own cross-session
tool asks here first, then delivers itself, then writes the delivery down with
[team send](send.md) `--record`. The CLI neither delivers nor dials anything: it judges the pair,
resolves the recipient live, reads the address from the registry and the recipient's own pane, and
records that it handed the address out.

## Synopsis

    team route <seat> [--json] [--dry-run]

`<seat>` names one seat: a bare seat or nickname, a `@nickname`, a `seat@team` or
`nickname@team`, `lead@team`, or an agent id — the same address grammar
[`team send`](send.md#addressing) takes.
Access is decided exactly as a
send's is, against the same team file, the same team rules, the same grant store, and default deny;
the rule that admitted the pair is named in the answer. A spec the registry holds no record for is
refused — a route hands out a recorded address, and `team up` or `team register` writes the record.

## Who may run it

A run with no terminal — an agent outside herdr, a detached script — is refused before the team file
is read. A seat is judged by the same admission as `team send`; the owner and admitted seats are
answered.

## The address

The recipient is resolved live before any address is read: herdr must name the seat on a pane of
its session, running the CLI its registry record names, and that pane is the one read. A recorded
pane is never trusted — panes close and are reused, and an address read from a pane another seat
now stands on would be that seat's. A seat herdr does not name there, names twice, or names on
another CLI is refused, and no address is answered.

The answer opens on the team's context line, `team <project>, session "<session>"`, names the
recipient's agent id, session, CLI and pane, and its socket with the state the reading found it in:

- the recorded address, while its own process still runs in the pane and its path is still there —
  `live`;
- the recorded address when its process is gone — `stale`, named so the sender does not dial it;
- no recorded address, and one socket among the pane's processes — `pane` (the lines word it
  `found on the pane`);
- a recorded address and a pane that could not be read — `unread`: the path is named and nothing
  about it is claimed, because a route never silently swaps a recorded address for another;
- nothing — `none`.

It closes on the resolved address, said once: `<seat>: routed at <path|no socket> (<state>)`.

`native` says whether the recipient's CLI carries the cross-session channel at all. This process
never opens, dials or writes to another session's socket; whether to dial the path is the sender's
own decision, in its own process. `--json` prints one document instead of the lines: the action
surface and the answer in one — `{format: 1, dry_run, status, action_summary, project, session,
seat, agent, recipient_session, cli, pane, address, socket_state, native, rule}` — registered as
`schema/route.schema.json`. `session` is the caller's team session; the recipient's travels as
`recipient_session`. `--dry-run` adds `plan`: the one record step a real run would take.

## The record

A route is one record before it is one answer: one JSON line is appended to the receiving project's
`routes.jsonl`, beside its `messages.jsonl` in the state folder, naming the pair, the rule, the
address and its state and when. A record that cannot be written is a refusal — an address this CLI
handed out is accountable, or it is not handed out. A recorded route writes one line to the
receiving team's `.agents/team.log` — `looked up <seat>: <state>, native <yes|no>` — a lookup and
never a delivery word: reading an address is not a message arriving. `--dry-run` answers the same,
prints the one plan step — `+ record: <seat>: append the route to <path>` — then `dry run: nothing
was run`, and writes nothing, no log line included.

## Telling a seat to use it

A team's `rules:` carries one item that wires a seat to both halves — the route first, the seat's
own delivery to the session this answer prints, then the record:

> - Deliver to another seat natively when `team route <seat>` admits the pair and answers
>   `native yes` — route first, then your own cross-session SendMessage to the session the answer
>   prints, then write the delivery down with `team send --record <seat> --channel native --ms <n>`
>   — and fall back to plain `team send <seat> <message>` only on a definite failure, the route
>   refused, the seat not Claude's, or your SendMessage call itself failed or reported no such
>   session; a call that returned delivered the message, so record it native and never send it
>   again however long an answer takes, and a delivery is recorded exactly once, by the path that
>   delivered it.

The item is quoted for the owner to paste — no team file ships with it, and this repository never
writes one. A seat whose CLI is not Claude's never sees `native yes`, so the line reads to it as
it always behaved, plain `team send`. Only a definite failure falls back: a missing, slow or
absent answer is not a delivery signal, and the plain send that does fall back builds admission
from the same records this command judges with, so it cannot deliver what a refusal refused. A
Claude sender addresses the session by the name printed above, never the socket path: the `socket`
column and its state are the audit's and a non-Claude dialer's, and `stale`, `unread` or `none` is
a warning about the pane, never a reason to hand-dial.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| addressed and recorded | the context line, `<seat>  <id>  (<name>)` and the session, cli, pane, socket, native and rule lines, then the summary `<seat>: routed at <path\|no socket> (<state>)` | 0 |
| `--dry-run`, addressed, nothing written | the same lines, then the step `+ record: <seat>: append the route to <path>` and `dry run: nothing was run` | 0 |
| run with no terminal | `team route: only the owner or a seat the send admission admits runs this, from a terminal outside herdr or its own pane` | 1 |
| refused (admission, or a seat with no registry record) | `team route: refused: <reason>` | 1 |
| record could not be written | `team route: refused: the route record could not be written: <problem>` | 1 |
| team file unreadable | `team route: <problem>` | 2 |
| invocation cannot be read | `team route: <problem>` and the usage | 2 |

Under `--json` the same answer is one document (`team.route`), and a refusal is the structured error
document (`team.error`, its `error.id` the contract row), with stderr empty.

`--help` and `-h` show usage and exit 0.
