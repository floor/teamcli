# `team lock`: rationale and known limits

What moved off [the `team lock` page](../commands/lock.md): how the take works, what it reads and
writes, the holder the page stopped and the take that died halfway, and the example the page no
longer runs. The synopsis, the flags, the caller rule, the refusals in their own words and the
exit codes stay on the page.

## How the take works

The lock is a directory, `<home>/.config/team/locks/<name>.lock`, created by a plain `mkdir`. That
call fails when the directory is already there, which is the whole of the take: a second caller is
refused and writes nothing. The holder is a file named `who`, written only after the `mkdir`
succeeds.

`<name>` is a name — lowercase letters, digits and hyphens — never a path. `--for` is a one-line
note of what the run is. `--wait` is how many seconds to wait for the holder to release the lock.
The wait does not break it. When it ends, the same refusal is printed.

The caller is the project in the current folder and who is running: the owner at a terminal, or
the seat's name. Unlocking (`team unlock`) removes the lock only when that same pair is in `who`.

## What it reads and writes

Reads the team file in the current folder, to record the project's name. Writes one directory
under the home's `.config/team/locks/`, and one `who` file inside it:

    team: beacon
    run: release CI
    by: owner
    at: 2026-10-04T09:00:00Z

A lock that is already held is only read. A failed take writes nothing: no `who`, and no
replacement of the one already there.

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

## Examples, moved here whole

The runs below stood on the page before its one-glance cut and they stand there no longer: a second
take is refused, a seat that is not the holder is refused, and the owner releases the lock before a
name that leaves the lock root is turned away. None of them is executed by any test —
`test/docs.test.ts` reads `docs/commands/` alone — and all run against the page's own team file:

```console
$ team lock heavy-run ; echo "exit $?"
heavy-run: held since 2026-10-04T09:00:00Z by owner (beacon) — release CI, for 0s
exit 1
```

```console caller=claude-keeper
$ team unlock heavy-run ; echo "exit $?"
heavy-run: held by owner (beacon) since 2026-10-04T09:00:00Z — release CI, not you
exit 1
```

```console
$ team unlock heavy-run
heavy-run: released
$ team lock ../out ; echo "exit $?"
team lock: "../out" is a name, not a path: lowercase letters, digits and hyphens
Usage: team lock <name> [--for <text>] [--wait <seconds>]
exit 2
```
