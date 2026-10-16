# `team feed`: rationale and known limits

What moved off [the `team feed` page](../commands/feed.md): where the history lives and how it
rotates, what the run reads and refuses to follow, the flags in their own words, and the known
limits. The synopsis, the flag table, the outcome list, the caller rule and the exit codes stay on
the page.

## Where the history lives

Reads and follows the project's message history from
`~/.config/team/<project>-<hash>/messages.jsonl` (mode `0600`, inside the project's state folder
and never in a lobby or the repository), together with any `briefs/<from>-to-<to>.md` files and
Desk audit lines when present.

The log rotates at 1 MB and keeps three files (`messages.jsonl`, `messages.jsonl.1`,
`messages.jsonl.2`), each at mode `0600`. Pre-flight refusals, `--list`, and `--dry-run` write
nothing to `messages.jsonl`.

## What it reads and writes

Reads `.agents/team.yaml` to resolve the project name and checkout root (or scans all
`~/.config/team/<project>-<hash>/` folders when `--all` is given or when run outside a checkout),
then reads `messages.jsonl` (and `.1`, `.2`) with `O_NOFOLLOW`, together with `briefs/*-to-*.md`
and any Desk guard or bridge `audit.jsonl` and signed answer files under `~/.config/team/lobby/`.
If a symbolic link or FIFO stands at the log or in the state folder ladder, `team feed` refuses and
does not follow it. Writes nothing.

## The flags, in their own words

        team feed [--seat <name>] [--limit <n>] [--follow] [--all] [--audit <path>] [--briefs <dir>] [--json]

`--seat <name>` filters to entries where `from` or `to` is `<name>`. `--limit <n>` prints at most
the last `<n>` entries (1 to 10,000, default 50). `--follow` keeps reading as new entries arrive,
including across log rotations. `--all` merges `messages.jsonl` across every project state folder
under `~/.config/team/<project>-<hash>/` so a pane beside Desk can follow all team
discussions even outside a project checkout. `--audit <path>` reads an explicit Desk or guard
`audit.jsonl` file, and `--briefs <dir>` reads an explicit `briefs/<from>-to-<to>.md` directory
(including timestamped `## <ISO-8601> — From <Name>: ...` sections). `--json` prints one JSON
object per line instead of the formatted table lines.

`--all` reads every project state folder under this home, so it follows the machine's history
rather than this checkout's, and it is the one form that answers outside a checkout at all.
