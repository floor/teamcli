# team daemon

The one machine-wide TeamCLI daemon. One daemon serves every team and checkout on this machine:
it answers its own protocol on the one machine socket and, in this build, also hosts each
checkout's existing send and bus endpoints in the same process, so no second or third daemon
process runs for a second checkout. `run` is the foreground process the system service manager
starts; `install` writes and registers the user service unit that starts it at login and restarts
it after a failure; `uninstall` removes that unit; `status` is the one-line health reading.

The daemon reads no credential store. The broker feature is not hosted in this build, and a
machine with no broker handler never falls back to a per-clone broker.

## Synopsis

    team daemon status [--json]
    team daemon run [--root <folder>] [--started-by <source>] [--presence]
    team daemon install [--root <folder>] [--presence] [--dry-run] [--json]
    team daemon uninstall [--json]

A subcommand is required. `--root` is repeatable and names the checkouts this one daemon hosts;
without it, the checkout whose folder the command runs in is hosted. `install` validates every
named checkout when it writes the unit: a root whose team file cannot be read is refused, never
silently dropped, because a unit that hosts nothing must not be written in its place.

## The four subcommands

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

`install` writes the user service unit and registers it with the system service manager. It
prints `team daemon: installed for <n> checkout(s); the system service manager starts it at login
and restarts it after a failure`. `--dry-run` prints what it would do, including the unit path
under `--json`, and writes nothing: `… would install …; nothing was written`.

`uninstall` removes the unit. A machine that never carried one is not an error:
`team daemon: not installed; nothing to remove`, exit 0; a removed unit prints
`team daemon: uninstalled; the system service manager no longer starts it`.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--root` | a checkout folder | host that checkout; repeatable, and validated when the unit is written; belongs to `run` and `install` |
| `--started-by` | `service-manager`, `manual` or `team-up` | the launcher recorded in the state; belongs to `run`, and defaults to `manual` |
| `--presence` | — | host each checkout's presence pipeline; belongs to `run` and `install`, is written into the unit by `install`, and is off by default |
| `--dry-run` | — | print the install plan and write nothing; belongs to `install` |
| `--json` | — | one JSON document instead of the line; belongs to `status`, `install` and `uninstall` |
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
read when a Codex seat's target is resolved; it is never written here. Nothing in this command
reads a credential store.

## Who may run it

| Subcommand | Who |
| --- | --- |
| `status` | anyone; it reads the machine's daemon record and no team file |
| `run` | the owner, or the no-terminal start the system service manager makes with `--started-by service-manager`; a seat or a pane never starts the machine daemon |
| `install`, `uninstall` | the owner alone |

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
| refused: not the owner, a run the admission refuses, no service manager adapter, a failed install or uninstall, another start holding the lock, a failed start | `team daemon: <reason>` | 1 |
| the invocation can't be read, or a named root can't be read | `team daemon: <problem>`, with the usage for an invocation error | 2 |

`status --json` prints `{"schema": {"name": "team.daemon-status", "version": 1}, "format": 1,
"daemon": …}` with the health reading's fields: `state`, `running`, `pid`, `uid`, `since`,
`startedBy`, `version`, `heartbeatAt`, `features`, `stuck`, `probe`, `why` and `socket`.
`install --json` and `uninstall --json` print `team.daemon-install` with `command`, `dry_run`,
`installed`, `unit_path`, `program` and `roots` (`install`), or `unit_path` and `removed`
(`uninstall`). A refusal under `--json` prints the `team.error` document with its `daemon.*` id.
