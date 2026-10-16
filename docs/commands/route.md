# team route

Answers one seat's address for the native channel: a sender that delivers with its own cross-session
tool asks here first, then delivers itself, then writes the delivery down with
[team send](send.md) `--record`. The CLI neither delivers nor dials anything: it judges the pair,
reads the recipient's address from the registry and the pane, and records that it handed the address
out.

## Synopsis

    team route <seat> [--json] [--dry-run]

`<seat>` names one seat: a bare seat, a `seat@team`, or an agent id. Access is decided exactly as a
send's is, against the same team file, the same team rules, the same grant store, and default deny;
the rule that admitted the pair is named in the answer. A spec the registry holds no record for is
refused — a route hands out a recorded address, and `team up` or `team register` writes the record.

## Who may run it

A run with no terminal — an agent outside herdr, a detached script — is refused before the team file
is read. A seat is judged by the same admission as `team send`; the owner and admitted seats are
answered.

## The address

The answer names the recipient's agent id, session, CLI and pane, and its socket with the state the
reading found it in:

- the recorded address, while its own process still runs in the pane and its path is still there —
  `live`;
- the recorded address when its process is gone — `stale`, named so the sender does not dial it;
- no recorded address, and one socket among the pane's processes — `pane` (the lines word it
  `found on the pane`);
- a recorded address and a pane that could not be read — `unread`: the path is named and nothing
  about it is claimed, because a route never silently swaps a recorded address for another;
- nothing — `none`.

`native` says whether the recipient's CLI carries the cross-session channel at all. This process
never opens, dials or writes to another session's socket; whether to dial the path is the sender's
own decision, in its own process. `--json` prints one document instead of the lines:
`{seat, agent, session, cli, pane, socket, socket_state, native, rule, status, exit}`.

## The record

A route is one record before it is one answer: one JSON line is appended to the receiving project's
`routes.jsonl`, beside its `messages.jsonl` in the state folder, naming the pair, the rule, the
address and its state and when. A record that cannot be written is a refusal — an address this CLI
handed out is accountable, or it is not handed out. `--dry-run` answers the same and writes nothing.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| addressed and recorded | `<seat>  <id>  (<name>)` and the session, cli, pane, socket, native and rule lines | 0 |
| `--dry-run`, addressed, nothing written | the same, plus `(dry run; nothing was recorded)` | 0 |
| run with no terminal | `team route: only the owner runs this, from a terminal outside herdr` | 1 |
| refused (admission, or a seat with no registry record) | `team route: refused: <reason>` | 1 |
| record could not be written | `team route: refused: the route record could not be written: <problem>` | 1 |
| team file unreadable | `team route: <problem>` | 2 |
| invocation cannot be read | `team route: <problem>` and the usage | 2 |

`--help` and `-h` show usage and exit 0.
