# team ping

The comms test as a command. `team ping <seat>` sends one seat a message asking it to answer with
[`team reply`](reply.md); `team ping --all` sends one to every seat of the caller's own team. It
then waits and prints one row per seat with the stage times, each from the start of that seat's
send: how long the send took and the leg that took it, when the seat's signed read receipt landed
(the message reached its session), when the seat sent its reply (its signed `at`: the agent acted)
and when the reply landed in the caller's folder; or why the send was refused.

Each message is an ordinary [`team send`](send.md), run as this same program in the caller's own
folder and environment: the same admission, signing and delivery. A refused send is a row with its
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

Reads `team seats --json` for the team's seats and session, each target's
`.agents/send-drops/<session>/<seat>/<id>.read.json` receipt, and the records in the caller's own
session folder for replies on each message's thread. Writes nothing itself: each message is
written by its own `team send`, with that send's history line, and each answer by its seat's
`team reply`.

## Who may run it

Whoever `team send` admits, message by message.

## Output and exit codes

One line per seat on stdout:
`<seat>: send <s> s (<leg>); read <s> s; reply sent <s> s, landed <s> s`, or
`<seat>: send <s> s; refused: <reason>`, or
`<seat>: send <s> s (<leg>); read <s> s; no reply within <n> s (<send outcome>)`
(`no read receipt` in place of `read <s> s` when none came).

| Outcome | What is printed | Exit |
| --- | --- | --- |
| replied | every row replied | 0 |
| unanswered | a row without a reply in time, or a refused send | 1 |
| usage | `team ping: <problem>` and the usage on stderr | 2 |

Under `--json` it prints one `team.ping` document — `{token, wait_seconds, rows, all_replied}`,
each row `{seat, team, id, outcome, leg, send_ms, read_ms, reply_sent_ms, reply_landed_ms, status}`
with `status` one of `replied`, `read`, `not read` or `refused`; a usage refusal prints the structured error document (`error.id`
`ping.usage`).
