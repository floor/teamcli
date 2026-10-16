# team feed

Reads and follows the project's message history: `messages.jsonl` in the project's state folder,
together with any `briefs/<from>-to-<to>.md` files and Desk audit lines when present.

Each completed `team send` run (`delivered`, `answered`, `held`, `timeout`, or `unreachable`)
appends one JSON object per line to `messages.jsonl`:

    {"ts":"<ISO-8601>","from":"<sender>","to":"<seat>","body":"<text>","id":"<uuid>","outcome":"<outcome>"}

Pre-flight refusals, `--list`, and `--dry-run` write nothing to `messages.jsonl`.

## Synopsis

    team feed [--seat <name>] [--limit <n>] [--follow] [--all] [--audit <path>] [--briefs <dir>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--seat` | `<name>` | entries where `from` or `to` is `<name>` |
| `--limit` | `<n>` | at most the last `<n>` entries (1 to 10,000, default 50) |
| `--follow` | — | keep reading as new entries arrive, including across log rotations |
| `--all` | — | merge `messages.jsonl` across every project state folder under `~/.config/team/<project>-<hash>/`, so a pane beside Desk can follow all team discussions even outside a project checkout |
| `--audit` | `<path>` | read an explicit Desk or guard `audit.jsonl` file |
| `--briefs` | `<dir>` | read an explicit `briefs/<from>-to-<to>.md` directory, timestamped `## <ISO-8601> — From <Name>: ...` sections included |
| `--json` | — | one JSON object per line instead of the formatted table lines |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

Anyone in the checkout may run it.

## Output and exit codes

| Outcome | Exit | Printed |
| --- | --- | --- |
| ok | 0 | the matching entries (or `(no messages)` when empty without `--json` or `--follow`) on stdout |
| unreadable | 1 | `team feed: the history log cannot be read: <reason>` on stderr |
| usage | 2 | `team feed: <message>` and the usage on stderr |
| configuration | 2 | `team feed: <message>` on stderr |

## Example

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
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: gpt-reviewer
    label: reviewer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
```

Before any message has been sent, `team feed` reports an empty history; after a send it prints the recorded exchange
with its timestamp, sender, recipient, outcome, and body:

```console
$ team feed ; echo "exit $?"
(no messages)
exit 0
$ team send gpt-reviewer "the gate is green" ; echo "exit $?"
gpt-reviewer: delivered
exit 0
$ team feed ; echo "exit $?"
09:00:00  owner -> gpt-reviewer  [delivered]  the gate is green
exit 0
$ team feed --seat gpt-reviewer ; echo "exit $?"
09:00:00  owner -> gpt-reviewer  [delivered]  the gate is green
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/feed.md](../internal/feed.md).
