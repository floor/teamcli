# `team broker`: rationale and known limits

What moved off [the `team broker` page](../commands/broker.md): what the run reads and
writes, the socket and the files beside it, what it prints, the refusals in their own words, and
the known limits. The synopsis, the flags, the caller table and the exit codes stay on the page.

## What the run does: the credential, the socket, the seat gate

Runs the one process that holds the tracker credential and answers `team next` over a local
socket. The owner starts it, in a terminal outside herdr, one per clone. Ctrl-C stops it.

The credential lives with the broker process. `team next` asks the broker over a local socket;
the seat never reads the key. The broker never puts its own credential, or the tracker's API
access, into any field it returns.
This guarantee is about what the broker injects. It says nothing about what a person typed into a
field: a `title` or a `description` the user wrote reaches the seat exactly as it would reach a
human teammate. TeamCLI does not scrub a secret a user typed.
The broker runs as the same OS user as the seats. That is an integrity boundary, not an
authenticity one: a hostile process of the owner's user can still reach the socket. True isolation
needs a separate principal or a sandbox.
The policy says which fields cross. A field left out is absent from the record, never blank. With
no policy the nine typed fields cross and the `description` does not; the `description` crosses
when the team allows it, and it is built by the adapter at the source — a source URL is dropped at
read, not scrubbed from a string.
The socket sits at `.agents/broker.sock` in this clone and carries the filesystem's own
permissions. The broker reads the key from the macOS Keychain, once, at start — the facility `team
release check` uses. On a platform without that facility the broker refuses to start. A run
with no terminal is refused before the Keychain is read.
The broker is a running process. Nothing starts it for you, and nothing restarts it.

A request is one JSON line: the one op `read`, and the seat and pane the caller claims. The broker
checks that claim against the team file and the session state before it reads anything — the check
is on the claim, and it is not a proof of the sender. A name that is not a seat, a seat with no
recorded pane, and the wrong pane are each refused, with the sentences `team next` prints.
The broker writes nothing to the tracker: the Linear document is a query, and a seat's take stays
the local lease in this clone.

CI binds a real unix socket in a scratch directory and runs the broker over it with the credential
and the tracker injected the way `team release check` injects its Keychain reader and its fetch: a
literal key string and an answer map keyed by URL. That run proves the seam and the discipline —
one header, one host, no redirect, the policy applied before the answer crosses — and it proves
the seat's own files, environment and outputs never hold the key. It never reads the Keychain,
never opens a network connection, and it cannot prove the same-principal limit, which is not
testable at all.

## What it reads and writes

Reads the team root (`loadTeamFile`: the checkout, or the folder holding `.agents/team.yaml`),
the team file, and the Keychain service the file names
(`tasks.linear.keychainService`) once at start, through the facility above. Per request it makes
one bounded read-only Linear query under `tasks.linear.project`, from this process, and applies
the `tasks.policy` before the answer is serialized: a field the policy leaves out is absent from
the record, never blank.

Binds the unix socket `.agents/broker.sock` at that root. The socket file, the start lock
beside it, and the takeover claim beside that (`.agents/broker.sock.lock.takeover`, which
removes a dead start's lock; a killed claim-holder can leave it, and the next start clears it)
are the files it writes — the lock and the claim each created through a private temp that names
its writer (`.agents/broker.sock.lock.<pid>.new`, the claim's one segment further), removed as
the create ends, and a temp a kill left behind cleared by the next start. The lock is released
when the walk ends, and the socket file is removed when it stops; a file at that path that is
not a socket is never unlinked. It never writes the tracker, the team file or a lease.

## Who may run it

The owner, in a foreground terminal outside herdr, one per clone. A call placed as a seat, in a
pane, or under herdr at all is refused before the Keychain is read and before any bind — a pane
is a pane whether or not a CLI runs in it. The gate guards a mistaken or ordinary call, not a
hostile process running as the same user; nothing here can tell the two apart, because nothing
distinguishes them — the same user may do all of it by hand. It refuses to start without a
terminal, on a platform without the Keychain facility, when the team file declares no
task source or one it does not serve, or when a broker is already answering on the socket.

## What it prints

`team broker: answering on .agents/broker.sock` once the socket is bound and serving.

`team broker: cleared a stale socket file` when the start found a socket file that nothing was
answering on — a broker killed, not stopped — and cleared it before binding. A file a live broker
owns is answered, never cleared. Starts are serialized across processes by a lock beside the
socket, `.agents/broker.sock.lock`: a start takes it before the first ask and holds it until its
walk ends — for a serve, the moment the socket is listening. A second start waits on that lock
and then asks the path as any start does: it finds a broker answering and stops with the refusal
below, having cleared and bound nothing. A start that waits out the lock's deadline stops with
its own refusal and touches nothing; a lock a killed start left behind is taken over, not
waited on. The serialization is between starts that leave the paths alone: a same-principal
process that removes the lock path or the socket path while a start runs can still split two
starts — one left serving on a socket nothing reaches, the other owning the path — and the
lock holds exactly the paths it names.

`team broker: stopped` when the loop ended and the socket file was removed.

Every line goes to stderr. Nothing is printed on stdout. No `--json` runs on the daemon loop: the
invocation takes no flags, so `--json` is refused as an unknown argument, with the usage, on
stderr, and exit 2.

## Refusals

```text
team broker: only the owner runs this, from a terminal outside herdr
team broker: only the owner runs `broker`, from a terminal outside herdr; this call is <caller>
team broker: the team file declares no task source
team broker: tasks.source must be linear; the broker serves a tracker source
team broker: tasks.policy.omit must not name id or title, the record itself
team broker: this platform has no such facility
team broker: the run is not interactive
team broker: the lookup failed
team broker: a broker is already answering on .agents/broker.sock
team broker: another start is binding .agents/broker.sock; try again
team broker: the socket could not be bound
team broker: the socket could not be bound: <code>
```

A team file the validator refuses prints its own sentence after `team broker: `.

On start the broker asks the socket path three ways: something answering there is a live broker
(the refusal above); a leftover socket file that answers `ECONNREFUSED` is a broker that was
killed, and it is cleared and the socket bound; nothing there, and the socket is bound. A path
that is not a socket is refused before any ask — never cleared, never bound over, whatever would
have answered on it. A path that cannot be bound is a line, never a crash.

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console, and the two file
fences it reads, are also on [the `team broker` page](../commands/broker.md).

This page's fixture team is the file-sourced one the other pages use, so the run below is the
refusal a file source earns: the broker serves a tracker source, and a file source's records are
already in the checkout. A broker source writes `.agents/team.yaml` with the tracker in place of
the path:

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

tasks:
  source: file
  path: .agents/tasks.yaml

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

```text
tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
  policy:
    omit: [description]
    transform:
      id: bare
```

```console
$ team broker ; echo "exit $?"
team broker: tasks.source must be linear; the broker serves a tracker source
exit 1
```
