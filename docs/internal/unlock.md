# `team unlock`: rationale and known limits

What moved off [the `team unlock` page](../commands/unlock.md): what the run reads and writes, and
the states the release leaves alone. The synopsis, the flags, the caller rule, the refusals in
their own words, the exit codes and the example stay on the page.

## What it reads and writes

Reads the team file in the current folder, and the lock's `who` file under
`<home>/.config/team/locks/<name>.lock`. When the caller matches, it removes `who` and then the
directory. The directory goes second, and only when it is empty: a file left beside `who` is not
swept, and `who` is put back.

## A lock that cannot be released

A lock whose holder file is missing, unreadable, or not the four lines
[`team lock`](../commands/lock.md) writes is left where it is — the directory is not removed to
find out. When no caller can release it, the owner removes it by hand, as
[`team lock`](../commands/lock.md) describes under "When the holder is gone".
