# team ping

The comms test as a command. `team ping <seat>` sends one seat a message asking it to run
[`team reply`](reply.md) in its terminal tool (a reply written as text reaches no one); `team ping --all` sends one to every seat of the caller's own team. It
then waits and prints one row per seat with the stage times, each from the start of that seat's
send: how long the send took and the leg that took it, when a carrier's signed `delivered` receipt
landed (a socket, a runtime queue, a typed wake or a channel push took the body), when the seat's
own signed read receipt landed (the seat saw the body: a carrier never writes one, and a writer-side
copy or a lead's clearance is not counted), when the seat sent its reply (its signed `at`: the agent acted)
and when the reply landed in the caller's folder; or why the send was refused.

Each message is an ordinary [`team send`](send.md), run as this same program in the caller's own
folder and environment, with the caller's own standard input — a terminal stays that terminal, so
the owner at a terminal sends as the owner and a run without one is refused as a send would be: the
same admission, signing and delivery. A refused send is a row with its
refusal, never a route around it. A seat of another team is named `<seat>@<team>` (the team's
session, name or id); the send rules decide whether this caller reaches it. The answer is an
ordinary reply on the message's thread, admitted by the reply's own rule, never by this command.

## Synopsis

    team ping <seat> [--wait <seconds>] [--json]
    team ping --all [--wait <seconds>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--all` | — | every seat `team seats` lists for the caller's team |
| `--wait` | `<seconds>` | how long to wait for the replies, 0 to 3600; 120 when left out |
| `--json` | — | one `team.ping` document instead of the lines |

## What it reads and writes

Reads `team seats --json` for the team's seats (`--all`), then, per message, the sent record by its
id among the registered teams' folders and the caller's own team configuration, verified with the
machine's message key. Its signed root, session, recipient and sender decide where the rest is
read, never the folder the command runs in: the recipient's
`.agents/send-drops/<session>/<seat>/<id>.read.json` receipt, counted only when its signature
verifies and it names that id, recipient, root and session; and the reply's destination, resolved
the way [`team reply`](reply.md) resolves it — for a seat's message the sender's own folder (its
team found by the sender's signed agent id in the registry roster, else the team the caller binds
to); for the owner's message the entity's `owner-reply-to` endpoint, which may be a seat of another
team — where a reply counts only when its record verifies, sits on the message's thread, comes
from the recipient by name and agent id to that destination's seat and agent id, and carries this
run's token. Writes nothing itself: each message is
written by its own `team send`, with that send's history line, and each answer by its seat's
`team reply`.

## Who may run it

Whoever `team send` admits, message by message.

## Output and exit codes

One line per seat on stdout:
`<seat>: send <s> s (<leg>); <stages>; reply sent <s> s, landed <s> s`, or
`<seat>: send <s> s; refused: <reason>`, or
`<seat>: send <s> s (<leg>); <stages>; no reply within <n> s (<send outcome>)`,
where `<stages>` names each stage a verified receipt proves, in order: `delivered <s> s` when a
carrier's signed delivered receipt came, then `read <s> s` for the seat's own read, or
`no read receipt from the seat` when none came. The seat's read is the earliest of its own read
receipt, its replied receipt and its acknowledgement note; a writer-side copy, a lead's or the
owner's clearance and a carrier's delivery are never counted as it.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| replied | every row replied | 0 |
| unanswered | a row without a reply in time, or a refused send | 1 |
| usage | `team ping: <problem>` and the usage on stderr | 2 |

Under `--json` it prints one `team.ping` document — `{token, wait_seconds, rows, all_replied}`,
each row `{seat, team, id, outcome, leg, send_ms, delivered_ms, read_ms, reply_sent_ms, reply_landed_ms, reply_by, status}`
with `status` one of `replied`, `read`, `delivered` (a carrier's delivery and no read by the seat), `not read` or `refused`; a usage refusal prints the structured error document (`error.id`
`ping.usage`).
