# `team proc`: rationale and known limits

What moved off [the `team proc` page](../commands/proc.md): what the run reads and writes,
how a seat holds a name, the JSON document, and the refusal examples. The synopsis, the flags,
who may run it and the exit codes stay on the page.

## What it reads and writes

Reads the team file in the current folder, and the team's state beside it. Writes one record
under `sessions[<session>].procs` in `.agents/team.state.json`:

    "procs": {
      "release-watch": {
        "by": "claude-keeper",
        "at": "2026-10-04T09:00:00.000Z",
        "pid": 4243,
        "note": "the release CI run"
      }
    }

`by` is the recording seat's name, or `owner` for the owner at a terminal. `list` and `done`
write nothing of their own, except that `add` and `done` clear the dead records they find before
they write — the one moment the file is tidied.

## Naming, and the name a seat holds

`add` takes a name an earlier record holds in one case: the caller's own record, which it
replaces, and any record whose process is gone, which anyone may take. A name another seat holds
and whose process is still alive is refused — the two `add`s would otherwise take turns
overwriting each other, and `list` would name one process where two run.

Two seats that each want a record for the same kind of work spell the names apart:
`release-watch` and `release-build`, or the seat's own name in it.

A name is refused as an invocation error, and the record is not touched. A pid that is not
running is refused before anything is written: nothing is watched on your behalf, so the record
would be a note about nothing.

## Examples

`--json` is the records as a document, in the order the rows are printed:

```console
$ team proc list --json
{
  "format": 1,
  "procs": [
    {
      "name": "release-build",
      "by": "claude-desk",
      "at": "2026-10-04T09:00:00.000Z",
      "pid": 4243,
      "note": "the release build"
    },
    {
      "name": "release-watch",
      "by": "owner",
      "at": "2026-10-04T09:00:00.000Z",
      "note": "the release CI run"
    }
  ]
}
```

A second seat may not take a live name. The record stays where it is:

```console caller=claude-keeper
$ team proc add release-build ; echo "exit $?"
team proc: "release-build" is claude-desk's, live since 2026-10-04T09:00:00.000Z
exit 1
```

The seat that recorded it clears it. A name no record holds is refused, and another seat's live
record is not the caller's to clear:

```console caller=claude-desk
$ team proc done release-build
proc release-build: done
$ team proc done release-build ; echo "exit $?"
team proc: no process named "release-build"
exit 1
$ team proc done release-watch ; echo "exit $?"
team proc: "release-watch" is the owner's; only the owner clears it
exit 1
```
