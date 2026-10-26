# team pr check

Checks one pull request body against the team file's rules: the body must end with the signature
the file's `pullRequests` rule writes, and no line may match a forbidden pattern. It checks the
body alone, so it needs no repository at all — a project without git can check a request to merge.
The commits are a separate run, [`team commits check`](commits.md).

## Synopsis

    team pr check <file> [--file <path>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<file>` | a path, or `-` | the pull request's body; `-` reads standard input |
| `--file <path>` | a team file | deprecated: a legacy team file to read instead of the team's registry record |
| `--json` | — | the report as the `team.pr` document (`schema/pr.schema.json`); a refusal as the `team.error` document on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an agent-run CLI, or the owner, from any folder | run it: it needs no herdr session and no terminal |
| CI, on a push | run it, with the body written to a file or piped in with `-` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the body passes | `team pr check: 1 pull request body checked: ok` | 0 |
| the body was refused | one `difference:` block per finding — what, `repair:`, `who:` — then `team pr check: 1 pull request body checked: the pull request body refused` | 1 |
| the check can't run: a bad invocation, a team file that can't be read, or a body file that can't be read | `team pr check: <reason>`, with the usage for a bad invocation | 2 |

Under `--json` the report is the `team.pr` document (`schema/pr.schema.json`), and a refusal
writes the `team.error` document on stdout with its `contract/exit-codes.json` id; stderr stays
empty.

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

A pull request's body signs on its last line:

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

The same run under `--json`:

```console
$ team pr check body.md --json ; echo "exit $?"
{
  "schema": {
    "name": "team.pr",
    "version": 1
  },
  "format": 1,
  "differences": [
    {
      "what": "pull request body: no signature: expected \"**Agent:** {display} · {role}\" in the last line",
      "repair": "end the pull request body with a seat's signature (its author can edit it on the pull request)",
      "who": "any seat"
    }
  ],
  "notes": [
    "line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read"
  ],
  "summary": {
    "differences": 1,
    "owner_differences": 0
  },
  "notice": null
}
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/pr.md](../internal/pr.md).
