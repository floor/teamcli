# team lock

Takes a named lock on this machine, so one heavy run holds it at a time. The lock is a directory,
`<home>/.config/team/locks/<name>.lock`, created by a plain `mkdir`. That call fails when the
directory is already there, which is the whole of the take: a second caller is refused and writes
nothing. The holder is a file named `who`, written only after the `mkdir` succeeds.

`<name>` is a name — lowercase letters, digits and hyphens — never a path. `--for` is a one-line
note of what the run is. `--wait` is how many seconds to wait for the holder to release the lock.
The wait does not break it. When it ends, the same refusal is printed.

The caller is the project in the current folder and who is running: the owner at a terminal, or
the seat's name. Unlocking (`team unlock`) removes the lock only when that same pair is in `who`.

## Synopsis

    team lock <name> [--for <text>] [--wait <seconds>] [--json]

## What it reads and writes

Reads the team file in the current folder, to record the project's name. Writes one directory
under the home's `.config/team/locks/`, and one `who` file inside it:

    team: beacon
    run: release CI
    by: owner
    at: 2026-10-04T09:00:00Z

A lock that is already held is only read. A failed take writes nothing: no `who`, and no
replacement of the one already there.

## Who may run it

Anyone who can write their own home, from a folder whose team file loads. A folder with no team
file is refused before the lock is touched: the holder has to name a project.

## Flags

| Flag | Meaning |
| --- | --- |
| `<name>` | the lock's name: lowercase letters, digits and hyphens, at most 64 characters |
| `--for <text>` | the note stored as `run`; a line break in it becomes a space |
| `--wait <seconds>` | wait this many seconds, a second at a time, for the holder to release the lock; at most 86400 |
| `--json` | emit a `team.lock` v1 JSON document (`schema/lock.schema.json`) on `stdout` |
| `--help`, `-h` | the usage, and exit 0 |

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

A held lock is never removed by this command. A holder file that is missing or unreadable is
still a held lock: nothing is cleared and nobody is guessed.

## When the holder is gone

A run that finished the take and never unlocked leaves a holder file. `team lock` refuses, with
or without `--wait`:

    heavy-run: held since 2026-10-04T09:00:00Z by owner (beacon) — release CI, for 3h

`team unlock` from that caller releases it: the same project, and the same `by` (the owner at a
terminal, or the seat's name). Anyone else is refused. When that caller is not coming back, no
`team` command clears the lock. The owner checks that nothing is still running under that holder,
then removes the directory by hand:

    ~/.config/team/locks/<name>.lock

A take that died after the directory was created and before `who` was written, and a holder that
cannot be read, refuse every caller. `team lock` says one of:

    heavy-run: held; its holder file is not there yet
    heavy-run: held; its holder file cannot be read
    heavy-run: held; its lock is not a directory

`team unlock` refuses these too, and leaves the path in place. No `team` command clears them, by
design. The owner checks that nothing is still creating the lock, then removes that same directory
by hand.

A seat does not remove a lock it did not take.

## Exit codes

- `0` — the lock was taken.
- `1` — the lock is held, or the directory could not be written.
- `2` — the invocation can't be read, or the team file can't.

## Examples

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

A second take is refused. The holder file is unchanged, and the age is how long it has been held:

```console
$ team lock heavy-run ; echo "exit $?"
heavy-run: held since 2026-10-04T09:00:00Z by owner (beacon) — release CI, for 0s
exit 1
```

A seat is not the holder, so the lock stays:

```console caller=claude-keeper
$ team unlock heavy-run ; echo "exit $?"
heavy-run: held by owner (beacon) since 2026-10-04T09:00:00Z — release CI, not you
exit 1
```

The owner releases it. A name that steps outside the lock root is refused before anything is created:

```console
$ team unlock heavy-run
heavy-run: released
$ team lock ../out ; echo "exit $?"
team lock: "../out" is a name, not a path: lowercase letters, digits and hyphens
Usage: team lock <name> [--for <text>] [--wait <seconds>] [--json]

Exits 0 when the lock is taken, 1 when it is already held or cannot be written, 2 when the invocation or project can't be read.
exit 2
```
