# team lock

Takes a named lock on this machine, so one heavy run holds it at a time: a directory under
`~/.config/team/locks/` holding a `who` file that names the run. A second take is refused and writes
nothing.

## Synopsis

    team lock <name> [--for <text>] [--wait <seconds>]

## Flags

| Flag | Meaning |
| --- | --- |
| `<name>` | the lock's name: lowercase letters, digits and hyphens, at most 64 characters |
| `--for <text>` | the note stored as `run`; a line break in it becomes a space |
| `--wait <seconds>` | wait this many seconds, a second at a time, for the holder to release the lock; at most 86400 |
| `--help`, `-h` | the usage, and exit 0 |

## Who may run it

Anyone who can write their own home, from a folder whose team file loads: a folder with no team file
is refused before the lock is touched, since the holder has to name a project. The caller is the
project in the current folder and who is running — the owner at a terminal, or the seat's name — and
[`team unlock`](unlock.md) releases the lock only when that same pair is in `who`: a seat does not
remove a lock it did not take.

## Refusals

| Message | Exit |
| --- | --- |
| `team lock: a <name> is required` (with the usage) | 2 |
| `team lock: unexpected "<word>"` (with the usage) | 2 |
| `team lock: "<name>" is a name, not a path: lowercase letters, digits and hyphens` (with the usage) | 2 |
| `team lock: --wait is a whole number of seconds` (with the usage) | 2 |
| `team lock: --wait is at most 86400 seconds` (with the usage) | 2 |
| `team lock: <why the team file did not load>` | 2 |
| `<name>: held since <at> by <by> (<team>) — <run>, for <age>` | 1 |
| `<name>: held; its holder file is not there yet` | 1 |
| `<name>: held; its holder file cannot be read` | 1 |
| `<name>: held; its lock is not a directory` | 1 |

A held lock is never removed by this command. A holder file that is missing or unreadable is still a
held lock: nothing is cleared and nobody is guessed. The wait does not break the lock. When `--wait`
ends, the same refusal is printed. Exit 0 is the take, 1 a held lock, 2 an invocation or team file
that cannot be read.

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

The owner takes it. The file names the project and the caller:

```console
$ team lock heavy-run --for "release CI"
heavy-run: taken
team: beacon
run: release CI
by: owner
at: 2026-10-04T09:00:00Z
```

Rationale, behaviour, refusals and known limits: [docs/internal/lock.md](../internal/lock.md).
