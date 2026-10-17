# `team commits check`: rationale and known limits

What moved off [the `team commits check` page](../commands/commits.md): what the run
reads and writes, the findings in their own words, the refusals, and the known limits. The
synopsis, the flags, the caller table and the exit codes stay on the page.

## What the run does: the ref, the range, the findings

Checks a commit, or a range of commits, against the team file's rules: every commit must carry a
seat's signature where the file says, and no line of its message may match a forbidden pattern.
`commits check` is what a seat runs on its own branch before it reports, and what CI runs on
every push. The request to merge is a separate run, [`team pr check`](pr.md), which checks a pull
request's body alone and needs no git.

## What it reads and writes

Reads the team file (or the one `--file` names), the ledger of this machine's store (every seat the
team has had here, so a removed seat's commits still pass), and the git history of `<ref>`. It
writes nothing: no state file, no log line, no store.

## Who may run it

Anyone. It needs no herdr session, no terminal and no approval of its own; a seat runs it on its
own branch and CI runs it on a push.

## What it finds

Every commit checked gets a row in a column-0 table, and every finding becomes a `difference:`
block under it:

    COMMIT      STATUS   DETAIL
    <sha>  refused  Tidy the logs
    difference: commit <sha> "Tidy the logs", line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
      repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)
      who: any seat

`STATUS` is `ok`, `refused`, or `exempt` (a human's commit, or a merge, where the file exempts
them). `DETAIL` is the commit's subject. Each `repair:` names what fixes that commit — the
`who:` is `any seat`, because any seat may reword the offending commit.

| Finding | Meaning |
| --- | --- |
| `no signature: expected "Agent: {display} · {role}" in the final trailer block` | the message carries no signature at all |
| `the signature is not in the final trailer block` | a seat's signature is there, but not where the file's rule says |
| `the signature shares its paragraph with prose ("…"), so git reads no trailer block: put it in a paragraph of its own, with trailers only` | the signature touches ordinary text, so git reads no trailer |
| `a signature no seat of this team has had (the model, the version and the role must all match one seat)` | a signature-shaped line naming a model, version or role no seat has |
| `forbidden pattern <source>` | the line matches one of the file's patterns, or one of the two defaults |

The summary says what was read — `<n> commits checked`, `<n> by a human or a merge`, `<n> skipped
(since <ref>)` — and then `ok`, or `1 commit refused`, or `2 commits refused`.

Under `--json` the same report is the `team.commits` document (`schema/commits.schema.json`):
one entry per commit with its `status`, `exempt` and `findings`, the `differences` with their
`repair` and `who`, the loader's warnings as `notes` (the plain report prints none: a file
deprecation warning is `team check`'s to print), and a `summary` of the counts. A refusal is
the `team.error` document on stdout, with the `contract/exit-codes.json` row id, and stderr stays
empty.

## Refusals

| Message | Exit |
| --- | --- |
| `team commits check: a <ref> is required` (with the usage) | 2 |
| `team commits check: one <ref> at most` (with the usage) | 2 |
| `team commits check: unknown option --<name>` (with the usage) | 2 |
| `team commits check: --since needs a value` (with the usage) | 2 |
| `team commits check: <path>, line <n>: <message>` | 2 |
| `team commits check: not in a git repository` | 2 |
| `team commits check: "<ref>" doesn't name a commit` | 2 |
| `team commits check: the range "<ref>" can't be resolved` | 2 |
| `team commits check: the range "<ref>" holds no commit` | 2 |
| `team commits check: since "<ref>" doesn't name a commit here (a shallow clone doesn't hold the history it needs)` | 2 |
| `team commits check: since "<ref>" is not reachable from "<ref>"` | 2 |

The body's own refusals are [`team pr check`](pr.md)'s. The old spelling `team check …` still
runs all of this, one notice line first: [`team check`](check.md).

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The two
single-commit consoles (no `HEAD~2` and `HEAD`) also stand on [the `team commits check`
page](../commands/commits.md), where `test/docs.test.ts` executes them; the range and `--since`
runs stand only in this note and are not executed — `test/docs.test.ts` reads `docs/commands/`
alone.

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

A seat signs its commits in a trailer block of its own:

```commit
Sketch the layout

Agent: Claude Opus 5.5 · implementer
```

The person named in `identity.humans` never signs:

```commit email=jane@acme.example
Review the copy
```

This one forgot, and this one signed but leaked a line the file forbids:

```commit
Add the metrics page

The counters come from the tracker's webhook, not from a poll.
```

```commit
Tidy the logs

The reader printed one line too many, so the reports carried noise.

Claude-Session: 8f21c4a9
Agent: Claude Opus 5.5 · implementer
```

The commit a person wrote needs no signature:

```console
$ team commits check HEAD~2 ; echo "exit $?"
COMMIT      STATUS  DETAIL
<sha>  exempt  Review the copy
team commits check: 1 commit checked, 1 by a human or a merge: ok
exit 0
```

The newest commit signs, but leaks the forbidden line:

```console
$ team commits check HEAD ; echo "exit $?"
COMMIT      STATUS   DETAIL
<sha>  refused  Tidy the logs
difference: commit <sha> "Tidy the logs", line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)
  who: any seat
team commits check: 1 commit checked: 1 commit refused
exit 1
```

A range reads newest first and reports every commit with findings:

```console
$ team commits check HEAD~3..HEAD ; echo "exit $?"
COMMIT      STATUS   DETAIL
<sha>  refused  Tidy the logs
<sha>  exempt   Review the copy
<sha>  refused  Add the metrics page
difference: commit <sha> "Tidy the logs", line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)
  who: any seat
difference: commit <sha> "Add the metrics page": no signature: expected "Agent: {display} · {role}" in the final trailer block
  repair: sign the commit message in a final trailer block of its own (git commit --amend)
  who: any seat
team commits check: 3 commits checked, 1 by a human or a merge: 2 commits refused
exit 1
```

`--since` leaves that commit and everything reachable from it out of the report:

```console
$ team commits check HEAD~3..HEAD --since HEAD~1 ; echo "exit $?"
COMMIT      STATUS   DETAIL
<sha>  refused  Tidy the logs
difference: commit <sha> "Tidy the logs", line 5: forbidden pattern ^Claude-Session: — "Claude-Session: 8f21c4a9"
  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)
  who: any seat
team commits check: 1 commit checked, 2 skipped (since <sha>): 1 commit refused
exit 1
```

A ref that names nothing can't be checked:

```console
$ team commits check origin/main ; echo "exit $?"
team commits check: "origin/main" doesn't name a commit
exit 2
```
