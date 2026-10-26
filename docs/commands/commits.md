# team commits check

Checks a commit, or a range of commits, against the team file's rules: every commit must carry a
seat's signature where the file says, and no line of its message may match a forbidden pattern.
`commits check` is what a seat runs on its own branch before it reports, and what CI runs on
every push. The request to merge is a separate run, [`team pr check`](pr.md), which checks a pull
request's body alone and needs no git.

## Synopsis

    team commits check <ref> [--since <ref>] [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<ref>` | one commit, or a range when it holds `..` | the commits to check, passed to git as given (`origin/main..HEAD`) |
| `--since <ref>` | a commit | skip this commit and everything reachable from it, for this run; overrides `identity.since` |
| `--file <path>` | a team file | deprecated: a legacy team file to read instead of the team's registry record |
| `--json` | — | the report as the `team.commits` document (`schema/commits.schema.json`); a refusal as the `team.error` document on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an agent-run CLI, or the owner, from any folder | run it: it needs no herdr session and no terminal |
| a seat, on its own branch, before it reports | run it |
| CI, on a push | run it |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every commit checked passes | a `COMMIT  STATUS  DETAIL` table, one row per commit (`ok`, `refused` or `exempt`), then `team commits check: <n> commits checked, <n> by a human or a merge: ok` — with `<n> skipped (since <ref>)` when `--since` left commits out | 0 |
| at least one commit was refused | the same table, then one `difference:` block per finding — what was found, `repair:`, `who:` — then the same counts, ending `<n> commits refused` | 1 |
| the check can't run: a bad invocation, a team file that can't be read, or a ref that names nothing | `team commits check: <reason>`, with the usage for a bad invocation | 2 |

Under `--json` the report is the `team.commits` document (`schema/commits.schema.json`), and a
refusal writes the `team.error` document on stdout with its `contract/exit-codes.json` id; stderr
stays empty.

## Example

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

The newest commit signs, but leaks a line the file forbids:

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

The same run under `--json`:

```console
$ team commits check HEAD --json ; echo "exit $?"
{
  "schema": {
    "name": "team.commits",
    "version": 1
  },
  "format": 1,
  "ref": "HEAD",
  "since": null,
  "commits": [
    {
      "hash": "<sha>",
      "subject": "Tidy the logs",
      "status": "refused",
      "exempt": null,
      "findings": [
        {
          "kind": "forbidden",
          "message": "forbidden pattern ^Claude-Session:",
          "line": 5,
          "text": "Claude-Session: 8f21c4a9"
        }
      ]
    }
  ],
  "skipped": 0,
  "pull_request": null,
  "differences": [
    {
      "what": "commit <sha> \"Tidy the logs\", line 5: forbidden pattern ^Claude-Session: — \"Claude-Session: 8f21c4a9\"",
      "repair": "rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)",
      "who": "any seat"
    }
  ],
  "notes": [
    "line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read"
  ],
  "summary": {
    "commits": 1,
    "refused": 1,
    "exempt": 0,
    "skipped": 0,
    "ok": false
  },
  "notice": null
}
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/commits.md](../internal/commits.md).
