# Send host

The send host is a warm process that runs `team send`, `team reply` and `team ack` lines for the
CLI, so a send does not pay for starting the runtime and loading the send graph each time. The
machine daemon starts and supervises it when its run carries `--send-server`
([`team daemon`](../commands/daemon.md)). Without the host every line runs in its own process, as
it always has.

## How a line reaches it

The CLI is the client. For one of the three commands it connects to
`~/.config/team/send-host.sock` and writes one request: the arguments, the folder, the
environment and whether each stream is a terminal. The host answers with the line's output and exit
code, or hands the line back.

| What happens | The client |
| --- | --- |
| no socket, the connection fails, or it is not made within 50 ms | runs the line itself: it was never submitted |
| the host answers `fallback` | runs the line itself: the host did nothing for it |
| the host answers with output and an exit code | prints them and exits with that code |
| anything else after the request was written (the host closed, the answer is unreadable or late) | exits 1 with a note that the line's outcome is unknown, and never runs it again |

`TEAMCLI_SEND_HOST=0` makes the CLI skip the host for that run.

## What the host proves

Before a request is queued, the host reads the client from the kernel: the same user, the
process that connected and its parent, its folder (which must be the request's), whether it runs
in a sandbox, and the program build. A request from a sandboxed process, from another build, or
with a home or temporary folder that the warm modules cannot honour is handed back at once. While
the line runs, the caller's ancestor walk starts at the client's own parent, and the first effect
checks that the client is still the one that connected.

The host never decides an admission that is the owner's. A line that a charter admits, that an
owner-seat rule admits, or that would run with the owner as the acting principal is handed back
before it writes anything; so is a placement that would put back a lost herdr name. Only a caller
placed as an unconfined seat runs in the host. A line the host runs carries no daemon or watch
authority.

## Running and recycling

The host runs one line at a time. A request that waits more than 2 s is handed back. After a
line returns, the host waits up to 200 ms for work the line left running (a late webhook
continuation). It recycles after 500 lines, after 30 minutes idle, above 400 MB, or when a line
leaves a scope or deferred work open: queued requests are handed back, the running one finishes,
and the daemon starts the next host.

The host logs to `~/.config/team/send-host.log`.
