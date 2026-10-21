# team daemon

The one machine-wide TeamCLI daemon. One daemon serves every team and checkout on this machine:
it answers its own protocol on the one machine socket and, in this build, also hosts each
checkout's existing send and bus endpoints in the same process, so no second or third daemon
process runs for a second checkout. `run` is the foreground process the system service manager
starts; `install` writes and registers the user service unit that starts it at login and restarts
it after a failure; `uninstall` removes that unit; `status` is the one-line health reading;
`fault-watch` asks a running daemon to end one hosted watch's run as a counted fault, so the
recovery path can be seen on a real daemon.

The daemon reads no credential store. The broker feature is not hosted in this build, and a
machine with no broker handler never falls back to a per-clone broker.

## Synopsis

    team daemon status [--json]
    team daemon run [--root <folder>] [--started-by <source>] [--presence] [--watch]
    team daemon install [--root <folder>] [--presence] [--watch] [--dry-run] [--json]
    team daemon uninstall [--json]
    team daemon fault-watch --root <folder> --route <routeId> [--dry-run] [--json]

A subcommand is required. `--root` is repeatable and names the checkouts this one daemon hosts;
without it, the checkout whose folder the command runs in is hosted. `install` validates every
named checkout when it writes the unit: a root whose team file cannot be read is refused, never
silently dropped, because a unit that hosts nothing must not be written in its place.

## The subcommands

`status` reads the daemon's state record, probes the machine socket and prints one line:

- `team daemon: running (pid <pid>); started <source>; since <time>; heartbeat <time>; …; socket <path>`
  — the daemon answered its health probe; a process that exists but does not answer adds
  `probe unanswered (<reason>)` (or `probe refused (<code>)`) and is still reported running,
  never healthy and never not running; stuck requests are counted on the same line;
- `team daemon: unknown (<why>); socket <path>` — the state record or the socket cannot be read,
  so the reading cannot tell;
- `team daemon: not running; socket <path>` — there is neither a live state record nor a socket.

`run` starts the daemon in the foreground and serves until it receives SIGINT or SIGTERM. It
prints `team daemon: running (pid <pid>); socket <path>; roots <n> (send <n>, bus <n>); broker not
hosted`, and on a signal closes the machine socket, appends `daemon stopped` to the log and prints
`team daemon: stopped`. A second start that finds a live daemon prints
`team daemon: already running (pid <pid>)` and exits 0; a start that finds another start holding
the machine lock says so, starts nothing and exits 1. `--started-by` names the launcher in the
record: `manual` (the default), `service-manager` (the unit), or `team-up`.

`run --presence` also hosts each checkout's presence pipeline: the spool ingester, the activity
reconciler, the publisher and the per-seat health answer. Without the flag the daemon does not
read presence at all, and a start without it behaves exactly as before. The opt-in is the `run`
flag alone; `install --presence` writes that same flag into the unit's run command, so a
service-managed daemon hosts presence only after an owner installs it that way. There is no
second policy key for it. A seat whose native attachment is expected but
cannot be proven is answered as unproven for that seat, never silently as its route's hook seat.
A Codex seat attaches only to the explicit endpoint its own state record carries, and only while
that record's binding is the seat's current presence binding; a missing, malformed or
earlier-incarnation record stays unproven. The hosted send server asks the same per-seat answer
before typing in the last mile, so a seat that is not proven current is held, not typed into.

`run --watch` also hosts one watch per checkout on the daemon's existing heartbeat. Without the
flag no checkout's watch is hosted, and the daemon reads no pane for one. The opt-in is the `run`
flag alone; `install --watch` writes that same flag into the unit's run command, so a
service-managed daemon hosts a watch only after an owner installs it that way. Presence and watch
are independent flags: a daemon may host either, both or neither. A hosted watch renews and
verifies its own authority on every fixed heartbeat beat and does not blur that beat into the
watch's sweep rhythm; `status` and `check` name a watch that is standing down, stopped, failed or
whose outbound gate is closed, and say nothing while it is simply cycling. The hosted loop is in
the current source; its live activation and installed acceptance are not proven, and the pane watch
remains the path the build ships by default ([watch](watch.md)).

`install` writes the user service unit and registers it with the system service manager. It
prints `team daemon: installed for <n> checkout(s); the system service manager starts it at login
and restarts it after a failure`. `--dry-run` prints what it would do, including the unit path
under `--json`, and writes nothing: `… would install …; nothing was written`.

`uninstall` removes the unit. A machine that never carried one is not an error:
`team daemon: not installed; nothing to remove`, exit 0; a removed unit prints
`team daemon: uninstalled; the system service manager no longer starts it`.

`fault-watch` asks the one running daemon to end exactly one hosted watch's in-flight run, as a
diagnostic of the recovery path. It names one checkout with `--root` and that checkout's route id
with `--route`; the command derives the expected id from the checkout's own team file and refuses
any other, then reads the running daemon's record and requires a required, live watch with that
exact id. It writes one request file, mode 0600, into the machine folder, and the daemon's next
heartbeat consumes it once: the named route's run leaves by its own seam, the ordinary fault path
records it (`failures` + 1, the diagnostic reason), and one restart follows on the next heartbeat.
Only that route is touched — no process is signalled, no second route is ended, no run is started
and no authority is granted. The daemon refuses and unlinks a request that names another home or
another daemon run, is not a private 0600 file, or matches no required live watch, and it answers
`not reached` for one still pending when it closes. `--dry-run` proves admission, the checkout and
the route and writes nothing. `fault-watch --json` prints the `team.daemon-fault` document.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--root` | a checkout folder | host that checkout; repeatable, and validated when the unit is written; belongs to `run` and `install` |
| `--started-by` | `service-manager`, `manual` or `team-up` | the launcher recorded in the state; belongs to `run`, and defaults to `manual` |
| `--presence` | — | host each checkout's presence pipeline; belongs to `run` and `install`, is written into the unit by `install`, and is off by default |
| `--watch` | — | host one watch per checkout on the daemon's heartbeat; belongs to `run` and `install`, is written into the unit by `install`, is independent of `--presence`, and is off by default |
| `--route` | a 32-character route id | the one hosted route to fault; belongs to `fault-watch`, where it is required |
| `--dry-run` | — | print the install or fault plan and write nothing; belongs to `install` and `fault-watch` |
| `--json` | — | one JSON document instead of the line; belongs to `status`, `install`, `uninstall` and `fault-watch` |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

Under the machine folder `~/.config/team`: the daemon's state record
`daemon.state.json` (pid, uid, start time, launcher, version, heartbeat, hosted features and
stuck requests), the Unix socket `daemon.sock` (mode 0600 in a 0700 folder), the one log
`daemon.log`, and the single-instance lock `daemon.lock`. `install` and `uninstall` write and
remove the user service unit the platform adapter owns; no command prints that path as prose
except under `--json`. Each hosted checkout's team file is read to find its send and bus
endpoints. Under `run --presence` the daemon additionally reads each hosted checkout's presence
folders `<team-file-folder>/presence/<session>/<seat>/` — the `spool` of staged records, the
append-only `events.jsonl` and the `current.json` projection — writes the ingester's `events.jsonl`,
`current.json` and session `status.json`, and writes the applied fence
(`presence_applied`) into the seat's state record. That record's `codex_endpoint` entry is then
read when a Codex seat's target is resolved; it is never written here. Under `run --watch` the
daemon additionally reads each hosted checkout's team file, state record and panes for its watch;
that watch types nothing itself and can take the send command's own direct-wake legs only while
its captured authority verifies for the route. Nothing in this command reads a credential store.
`fault-watch` additionally writes the one pending request `daemon.fault-request.json` and reads
the last result `daemon.fault-result.json` in the same machine folder; both are 0600 inside its
0700 folder, the request is unlinked by the daemon when it consumes it, and the result names the
request's nonce. A request still pending when the daemon closes is answered `not reached`.

## Who may run it

| Subcommand | Who |
| --- | --- |
| `status` | anyone; it reads the machine's daemon record and no team file |
| `run` | the owner, or the no-terminal start the system service manager makes with `--started-by service-manager`; a seat or a pane never starts the machine daemon |
| `install`, `uninstall` | the owner alone |
| `fault-watch` | the same admission as `install` and `uninstall`: the owner, or the dev-mode admission for a placed lead; it signals no process and grants nothing |

A caller who is not the owner is refused with `only the owner installs or removes the machine
daemon; this call is <placement>` (`daemon.not-owner`). The service-manager start is the one
no-terminal start admitted; every other no-terminal caller is refused (`daemon.run-not-owner`).

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| `status` reads the daemon, whatever it says | the one status line, or the `team.daemon-status` document | 0 |
| `run` serves and then stops | the running line, then `team daemon: stopped` | 0 |
| `run` finds one already serving | `team daemon: already running (pid <pid>)` | 0 |
| `install --dry-run` | the plan and `nothing was written` | 0 |
| `install` writes and registers the unit | `team daemon: installed for <n> checkout(s); …` | 0 |
| `uninstall` removes the unit, or finds none | `uninstalled; …` or `not installed; nothing to remove` | 0 |
| `fault-watch` faults the one named route's hosted run | `faulted the hosted watch for <folder> (route <id>); …` | 0 |
| `fault-watch --dry-run` | the plan and `nothing was written` | 0 |
| `fault-watch` refused: not the owner, no running daemon, a route id or watch that does not match, a watch that cannot be faulted, a request already waiting, or the daemon's own `refused` or `not reached` answer | `team daemon: <reason>` | 1 |
| refused: not the owner, a run the admission refuses, no service manager adapter, a failed install or uninstall, another start holding the lock, a failed start | `team daemon: <reason>` | 1 |
| the invocation can't be read, or a named root can't be read | `team daemon: <problem>`, with the usage for an invocation error | 2 |

`status --json` prints `{"schema": {"name": "team.daemon-status", "version": 1}, "format": 1,
"daemon": …}` with the health reading's fields: `state`, `running`, `pid`, `uid`, `since`,
`startedBy`, `version`, `heartbeatAt`, `features`, `stuck`, `probe`, `why` and `socket`.
`install --json` and `uninstall --json` print `team.daemon-install` with `command`, `dry_run`,
`installed`, `unit_path`, `program` and `roots` (`install`), or `unit_path` and `removed`
(`uninstall`). A refusal under `--json` prints the `team.error` document with its `daemon.*` id.
