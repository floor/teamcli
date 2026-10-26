# team bus

Runs the foreground process that owns the project's event log (`events.jsonl`), runs the periodic
reconciliation pass over durable message and seat records, and serves `publish` and `subscribe`
over `.agents/bus.sock`. The reconciliation pass and each subscription verify only the event
records appended since the last verified sequence; when the log's checkpoint is missing or does
not match — after a trim or a rewrite, or because a record was altered — the whole retained log is
verified again, so an earlier alteration is still caught. The owner starts it, in a terminal outside herdr, and a seat the team marks `leads` starts it from that seat's own pane. One per clone. Ctrl-C
stops it. A run with no terminal can ask the owner seat instead: `--request` records the start and the owner answers on the owner page; `--approval` runs the signed answer once. A signed always rule for `team-bus` covering this folder admits the start with no request. The daemon's heartbeat restarts a bus that has stopped answering, with a wait that grows from one second to thirty, and `team up` starts one when the socket is dead. Events are routed by the policy's table to a position — `lead`, `operator`, `sender`,
`subject`, `owner` — or to a seat named by its plain name or registry agent id, and an event routed
to `owner`, or one a watch addresses to `owner`, is delivered by the Runtime: the watch's
notification and one signed record in the owner's mailbox, `.agents/messages/owner/`, which
`team messages` lists. The owner's urgent kinds ring on the pass that reads them; the rest wait
for one digest record a pass. When no bus is running, `team
watch` falls back cleanly to polling, and on a sequence `gap` it resets its cursor and clears its
active-condition set so the next pass re-announces any still-true reports while a subscriber's
message projection rebuilds from the durable records (`team send` writes those records directly and
never uses the bus in this build; the bus picks up message and receipt records through its
reconciliation pass).

## Synopsis

    team bus
    team bus --request
    team bus --approval <request-id>

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--request` | — | record this start for the owner seat and exit; the owner answers on the owner page |
| `--approval` | `<request-id>` | run the start the owner seat signed, once |
| `--help`, `-h` | — | the usage, and exit 0 |

An unknown argument is refused with the usage and exit 2; `--json` is one of them, because no
`--json` runs on the daemon loop. Ctrl-C, or SIGTERM, ends the serve loop, removes the socket
file, and exits 0.

The bus reads three of the owner's event thresholds when it starts: how often it reconciles
(`event-reconcile-interval-seconds`), how much of the event log it keeps
(`event-retention-days`), and when a held record reaches the lead
(`event-held-threshold-seconds`). A signed policy source that cannot be read or verified refuses
the start (`team bus: <problem>`, exit 2) rather than running on numbers no level chose.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, in a foreground terminal outside herdr, one per clone | run it |
| a seat the team marks `leads`, from that seat's own pane | run it |
| a run with no terminal, via `--request`, a signed `--approval`, or an always rule for `team-bus` | run it; the owner answers on the owner page and types nothing in a terminal |
| a run with no terminal, otherwise | nothing: ``team bus: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane`` |
| a seat that is not a lead | nothing: ``team bus: only the owner or a `leads` seat runs `bus`, from a terminal outside herdr or its own pane; this call is <caller>`` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| it started, served, and stopped cleanly | `team bus: answering on .agents/bus.sock` once the socket is bound and serving; `team bus: stopped` when the loop ended and the socket file was removed — every line to stderr, nothing on stdout | 0 |
| it refused to start, or the socket could not be bound | `team bus: <reason>` — the caller is not the owner or a `leads` seat, a bus is already answering on `.agents/bus.sock`, another start holds `.agents/bus.sock.lock`, or the socket could not be bound | 1 |
| the invocation or team configuration can't be read | `team bus: <problem>`, with the usage when the arguments were invalid | 2 |

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

```console
$ team bus extra ; echo "exit $?"
team bus: unexpected "extra"
Usage: team bus
       team bus --request
       team bus --approval <request-id>

Runs the event bus for this clone over `.agents/bus.sock`, appending signed event records to the
project's event log and reconciling durable message and seat records. The owner runs it from a
terminal outside herdr, and a seat the team marks `leads` runs it from that seat's own pane.
Ctrl-C stops it.

The owner-seat form needs no owner terminal: --request records this start (repository, team, HEAD;
fifteen minutes) and sends it to the owner seat, where the owner answers on the owner page with a
passkey or Touch ID; --approval <request-id> then runs it, once, as signed. A signed always rule
for team-bus covering this folder admits the run with no request. The daemon restarts a dead bus
on its own, and so does team up.

Exits 0 when it started and stopped cleanly, or when a request was recorded, 1 when it refused to
start or could not bind its socket, 2 when the invocation or team configuration can't be read.
exit 2
```

Rationale, wire protocol, reconciliation, privileged kinds, owner delivery, and known limits:
[docs/internal/events.md](../internal/events.md).
