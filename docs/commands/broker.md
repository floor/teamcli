# team broker

Runs the one process that holds the tracker credential and answers `team next` over a local
socket. The owner starts it, in a terminal outside herdr, one per clone. Ctrl-C stops it. Nothing
starts it for you, and nothing restarts it.

## Synopsis

    team broker

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--help`, `-h` | — | the usage, and exit 0 |

An unknown argument is refused with the usage and exit 2; `--json` is one of them, because no
`--json` runs on the daemon loop. Ctrl-C, or SIGTERM, ends the serve loop, removes the socket
file, and exits 0.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, in a foreground terminal outside herdr, one per clone | run it |
| a run with no terminal | nothing: `team broker: only the owner runs this, from a terminal outside herdr` |
| a seat, a pane, or any call under herdr at all | nothing: `team broker: only the owner runs broker, from a terminal outside herdr; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| it served until it was stopped | `team broker: answering on .agents/broker.sock` once the socket is bound and serving; `team broker: stopped` when the loop ended and the socket file was removed — every line to stderr, nothing on stdout | 0 |
| it refused to start, or the team file's policy is refused | `team broker: <reason>` — the caller is not the owner, no task source, a source the broker does not serve, the Keychain credential was refused, a broker is already answering, or the socket could not be bound | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team broker: <problem>`, with the usage | 2 |

## Example

This page's fixture team is the file-sourced one the other pages use, so the run below is the
refusal a file source earns: the broker serves a tracker source, and a file source's records are
already in the checkout. A broker source writes the team's configuration with the tracker in place of
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

Rationale, behaviour, refusals and known limits: [docs/internal/broker.md](../internal/broker.md).
