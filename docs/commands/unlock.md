# team unlock

Releases the lock [`team lock`](lock.md) took — but only when its holder file, `who`, names this
caller: the same project and the same `by` line. Anyone else is shown who holds it and refused.
A lock that cannot be released is left exactly where it is, and [`team lock`](lock.md) tells the
owner how to clear one by hand.

## Synopsis

    team unlock <name>

## Flags

| Flag | Meaning |
| --- | --- |
| `<name>` | the lock's name, the same closed set as [`team lock`](lock.md) |
| `--help`, `-h` | the usage, and exit 0 |

## Who may run it

The caller who took it. The same rules as [`team lock`](lock.md) for who that is.

## Refusals

| Message | Exit |
| --- | --- |
| `team unlock: a <name> is required` (with the usage) | 2 |
| `team unlock: unexpected "<word>"` (with the usage) | 2 |
| `team unlock: "<name>" is a name, not a path: lowercase letters, digits and hyphens` (with the usage) | 2 |
| `team unlock: <why the team file did not load>` | 2 |
| `<name>: not held` | 1 |
| `<name>: held by <by> (<team>) since <at> — <run>, not you` | 1 |
| `<name>: its holder file is not there yet; left <path> in place` | 1 |
| `<name>: its holder file cannot be read; left <path> in place` | 1 |
| `<name>: its lock is not a directory; left <path> in place` | 1 |

A lock that is not held, or held by someone else, is never removed: nothing is cleared and nobody
is guessed.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | the lock was released |
| 1 | it is not held, it is held by someone else, its holder can't be read, or the directory could not be removed |
| 2 | the invocation can't be read, or the team file can't |

## Example

```fixture
approved: false
herdr: none
agents: none
watch: none
```

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
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

Take it, then release it. Releasing a lock that is not held is a refusal:

```console
$ team lock demo --for "a check"
demo: taken
team: beacon
run: a check
by: owner
at: 2026-10-04T09:00:00Z
$ team unlock demo
demo: released
$ team unlock demo ; echo "exit $?"
demo: not held
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/unlock.md](../internal/unlock.md).
