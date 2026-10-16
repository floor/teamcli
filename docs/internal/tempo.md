# `team tempo`: rationale and known limits

What moved off [the `team tempo` page](../commands/tempo.md): what the run reads and writes, and
the runs the page no longer carries. The synopsis, the flags, the caller table, the output and
exit codes table and the one example stay on the page.

## What it reads and writes

Reads the team file in the current folder. Writes one line, `tempo: <word>`, after `format:`
when the key is missing, or on the line that already names it. The rest of the file is left
as it is. A line that already says that word is not rewritten.

## The runs the page no longer carries

The three runs below stood on the page before its one-glance cut, in the order they stood in, and
they stand there no longer. None is executed by any test — `test/docs.test.ts` runs the console
fences of `docs/commands/` alone — and each runs against the page's own team file.

The same word again leaves the line:

```console
$ team tempo urgent ; echo "exit $?"
tempo: urgent
exit 0
```

A word the file does not know is the usage:

```console
$ team tempo faster ; echo "exit $?"
team tempo: "faster" must be relaxed, normal or urgent
Usage: team tempo <word>
exit 2
```

A seat can't run it:

```console caller=agent
$ team tempo urgent ; echo "exit $?"
team tempo: only the owner runs tempo, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```
