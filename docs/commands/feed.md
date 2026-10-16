# team feed

Reads and follows the project's message history from `~/.config/team/<project>-<hash>/messages.jsonl`
(mode `0600`, inside the project's state folder and never in a lobby or the repository), together
with any `briefs/<from>-to-<to>.md` files and Desk audit lines when present.

Each completed `team send` run (`delivered`, `answered`, `held`, `timeout`, or `unreachable`)
appends one JSON object per line to `messages.jsonl`:

    {"ts":"<ISO-8601>","from":"<sender>","to":"<seat>","body":"<text>","id":"<uuid>","outcome":"<outcome>"}

The log rotates at 1 MB and keeps three files (`messages.jsonl`, `messages.jsonl.1`,
`messages.jsonl.2`), each at mode `0600`. Pre-flight refusals, `--list`, and `--dry-run` write
nothing to `messages.jsonl`.

## Synopsis

    team feed [--seat <name>] [--limit <n>] [--follow] [--all] [--audit <path>] [--briefs <dir>] [--json]

`--seat <name>` filters to entries where `from` or `to` is `<name>`. `--limit <n>` prints at most
the last `<n>` entries (1 to 10,000, default 50). `--follow` keeps reading as new entries arrive,
including across log rotations. `--all` merges `messages.jsonl` across every project state folder
under `~/.config/team/<project>-<hash>/` so a pane beside Desk can follow all team
discussions even outside a project checkout. `--audit <path>` reads an explicit Desk or guard
`audit.jsonl` file, and `--briefs <dir>` reads an explicit `briefs/<from>-to-<to>.md` directory
(including timestamped `## <ISO-8601> — From <Name>: ...` sections). `--json` prints one JSON
object per line instead of the formatted table lines.

## What it reads and writes

Reads `.agents/team.yaml` to resolve the project name and checkout root (or scans all
`~/.config/team/<project>-<hash>/` folders when `--all` is given or when run outside a checkout),
then reads `messages.jsonl` (and `.1`, `.2`) with `O_NOFOLLOW`, together with `briefs/*-to-*.md`
and any Desk guard or bridge `audit.jsonl` and signed answer files under `~/.config/team/lobby/`.
If a symbolic link or FIFO stands at the log or in the state folder ladder, `team feed` refuses and
does not follow it. Writes nothing.

## Who may run it

Anyone in the checkout may run it.

## Exit codes

| Outcome | Exit | Printed |
| --- | --- | --- |
| ok | 0 | the matching entries (or `(no messages)` when empty without `--json` or `--follow`) on stdout |
| unreadable | 1 | `team feed: the history log cannot be read: <reason>` on stderr |
| usage | 2 | `team feed: <message>` and the usage on stderr |
| configuration | 2 | `team feed: <message>` on stderr |

## Examples

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

Before any message has been sent, `team feed` reports an empty history:

```console
$ team feed ; echo "exit $?"
(no messages)
exit 0
```

After a send, `team feed` prints the recorded exchange with its timestamp, sender, recipient, outcome, and body:

```console
$ team send gpt-reviewer "the gate is green" ; echo "exit $?"
gpt-reviewer: delivered
exit 0
$ team feed ; echo "exit $?"
09:00:00  owner -> gpt-reviewer  [delivered]  from the owner — admitted by: the owner
          
          the gate is green
exit 0
$ team feed --seat gpt-reviewer ; echo "exit $?"
09:00:00  owner -> gpt-reviewer  [delivered]  from the owner — admitted by: the owner
          
          the gate is green
exit 0
```
