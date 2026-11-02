# team fallback

Every send keeps a fallback episode beside the message it could not deliver in one pass: a marker
beside the message record, one attempt ledger in the project's state store, and — once every live
route has failed — a publication ledger holding the signed event the episode emitted. An episode
ends when the message is delivered, when the escalation goes out, or when the walk is abandoned
and its last attempt is past the retention word. This command lists those finished episodes and,
with `--apply`, retires them.

## Synopsis

    team fallback prune [--apply] [--json]

`prune` is the only verb. A dry run changes nothing; `--apply` retires every listed episode it may
retire and reclaims stale lock folders.

## What is listed

| State | Meaning | When it is retired |
| --- | --- | --- |
| `delivered` | the message reached the seat | at once |
| `refused` | every live route failed and the main escalation was published | at once |
| `expired` | the walk was never finished: no failure has been escalated, and no delivery followed | once its last attempt is at least the receiver's signed `event-retention-days` old; until then it is listed with the action `none` |

An episode with an event intent a crash left unflushed is not listed at all: the escalation pass
flushes it first. Each listed episode is one row: the message, the seat, its state, its age, and
the action `--apply` would take.

## How retirement works

Retiring moves the marker and the attempt ledger into the store's archive beside the live store,
under `fallback-archive/markers/` and `fallback-archive/attempts/`. The publication ledger stays
where it was: replay dedup must outlive the episode, so a repeated event is found and not
appended again after the episode is gone. The episode's key-lock folder is removed, and a lock
folder whose owner is gone — an empty folder older than a minute, or one whose lock names a dead
process — is reclaimed in the same pass. A live or young lock, and a folder that is not an
episode's, are left alone.

A fact that arrives after retirement is answered from the archive: a delivered or refused episode
is a duplicate that writes nothing, an expired one reopens because the walk evidently was not
finished, and another digest or recipient is the conflict a live marker gives.

The retention word is read from the receiver's own signed chain, never from a release default. A
chain that cannot be read refuses the run — with exit 1 and the reason — rather than retiring
expired episodes on a guess.

## Who may run it

Any caller may read the dry run. `--apply` is the owner's, from a terminal rather than a seat's
pane; a caller that is not the owner is refused, and nothing is written.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the dry run finds nothing finished | `no finished fallback episode stands in this project's state store` | 0 |
| the dry run finds nothing to retire | the summary ending `none to retire` | 0 |
| the dry run finds episodes to retire | the summary ending `N episodes to retire` | 1 |
| `--apply` retires every listed episode it may retire | the summary ending `N episodes retired` | 0 |
| `--apply` leaves an episode unretired | the summary ending `N episodes could not be retired` | 1 |
| `--apply` is refused | `team fallback: <reason>` — the caller is not the owner | 1 |
| the retention word cannot be read | `team fallback: <reason>` | 1 |
| the invocation or the team configuration can't be read | `team fallback: <problem>` and the usage | 2 |

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

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
$ team fallback prune ; echo "exit $?"
no finished fallback episode stands in this project's state store
exit 0
```

## Notes

The daemon runs the same retirement and the same reclaim on its own schedule, so a store drains
without an operator. `--apply` is for an operator who wants it done now, or for a store the daemon
does not host. The internal contract — file names, the archive layout, the retention resolution,
and the lock-reclaim race — is in [fallback internals](../internal/fallback.md).
