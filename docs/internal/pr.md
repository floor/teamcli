# `team pr check`: rationale and known limits

What moved off [the `team pr check` page](../commands/pr.md): what the run reads and
writes, the findings in their own words, the refusals, and the known limits. The synopsis, the
flags, the caller table and the exit codes stay on the page.

## What the run does: the body, the signature, the patterns

Checks one pull request body against the team file's rules: the body must end with the signature
the file's `pullRequests` rule writes, and no line may match a forbidden pattern. It checks the
body alone, so it needs no repository at all — a project without git can check a request to merge.
The commits are a separate run, [`team commits check`](commits.md).

## What it reads and writes

Reads the team file (or the one `--file` names), the ledger of this machine's store, and the file
holding the body (`-` reads standard input). It writes nothing, and it runs no git command: the
folder it runs in needs no repository.

## Who may run it

Anyone. It needs no herdr session, no terminal and no approval of its own; CI runs it on a push,
with the body written to a file or piped in with `-`.

## What it finds

Each finding is printed as a `difference:` block with its repair:

    difference: pull request body, line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
      repair: edit the pull request body so the line no longer matches (its author can edit it on the pull request)
      who: any seat

| Finding | Meaning |
| --- | --- |
| `no signature: expected "**Agent:** {display} · {role}" in the last line` | the body carries no signature on its last line |
| `forbidden pattern <source>` | the line matches one of the file's patterns, or one of the two defaults |

The closing line says `team pr check: 1 pull request body checked: ok`, or
`…: the pull request body refused`.

Under `--json` the same report is the `team.pr` document (`schema/pr.schema.json`): the
`differences` with their `repair` and `who`, the loader's warnings as `notes` (the plain report
prints none: a file deprecation warning is `team check`'s to print), and a `summary` of
the differences. A refusal is the `team.error` document on stdout, with the
`contract/exit-codes.json` row id, and stderr stays empty.

## Refusals

| Message | Exit |
| --- | --- |
| `team pr check: a <file> is required` (with the usage) | 2 |
| `team pr check: one <file> at most` (with the usage) | 2 |
| `team pr check: unknown option --<name>` (with the usage) | 2 |
| `team pr check: <path>, line <n>: <message>` | 2 |
| `team pr check: can't read the pull request body: <error>` | 2 |

The old spelling `team check … --pr <file>` still runs this body check, one notice line first:
[`team check`](check.md).

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The first
two consoles (a passing body, and one that forgot the signature) also stand on [the `team pr
check` page](../commands/pr.md), where `test/docs.test.ts` executes them; the rest stand only in
this note and are not executed — `test/docs.test.ts` reads `docs/commands/` alone. The page's own
`--json` console is not repeated here.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

identity:
  humans: [jane@acme.example]

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

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

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

A pull request's body signs on its last line. A trailing Cursor publication block is not that line: the end marker `<!-- CURSOR_AGENT_PR_BODY_END -->`, then the one open-in-web / open-in-cursor `<div>`. Any other line after the signature still refuses the body.

```file file=pr.md
The metrics page is ready for review.

**Agent:** Claude Opus 5.5 · implementer
```

```console
$ team pr check pr.md ; echo "exit $?"
team pr check: 1 pull request body checked: ok
exit 0
```

This one forgot the signature:

```file file=body.md
Bump the retry window to thirty seconds.

The old one timed out on the flaky test.
```

```console
$ team pr check body.md ; echo "exit $?"
difference: pull request body: no signature: expected "**Agent:** {display} · {role}" in the last line
  repair: end the pull request body with a seat's signature (its author can edit it on the pull request)
  who: any seat
team pr check: 1 pull request body checked: the pull request body refused
exit 1
```

And this one signs, but leaks the line the file forbids:

```file file=leak.md
Tidy the logs.

The reader printed one line too many.

Claude-Session: 8f21c4a9
**Agent:** Claude Opus 5.5 · implementer
```

```console
$ team pr check leak.md ; echo "exit $?"
difference: pull request body, line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
  repair: edit the pull request body so the line no longer matches (its author can edit it on the pull request)
  who: any seat
team pr check: 1 pull request body checked: the pull request body refused
exit 1
```

A body file that isn't there can't be read:

```console
$ team pr check missing.md ; echo "exit $?"
team pr check: can't read the pull request body: ENOENT: no such file or directory, open './missing.md'
exit 2
```
