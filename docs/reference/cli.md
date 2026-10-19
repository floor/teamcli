# CLI reference

Generated from `contract/cli.json` by `scripts/contract.ts`. This file is checked in; `bun run contract:check` builds both from the command definitions and fails when either copy differs.

## `team`

Hidden: no

Usage:

    team <command> [options]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--about` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | yes |
| `--version` | no | no | no |
| `-V` | no | no | yes |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `command` | no | no |

## `add`

Hidden: no

Usage:

    team add <name> [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]

### Who may run it

`owner-only` — adding a seat is the owner's in 0.5.0, where no `agree` or `grant` holders stand

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--effort` | yes | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--like` | yes | no | no |
| `--model` | yes | no | no |
| `--session` | yes | no | no |
| `--temporary` | no | no | no |
| `--until` | yes | no | no |
| `--worktree` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | yes | no |

## `answer`

Hidden: no

Usage:

    team answer <seat> trust [--session <name>] [--file <path>] [--json]

Literal: `trust`

### Who may run it

`pane-authority` — a key into another agent's pane belongs to the pane's lead, a seat above it, or the owner's word for that case; trust, login and security prompts to the owner's alone — pane authority is its own gate, and this map admits no one to it

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `ask-show`

Hidden: no

Usage:

    team ask-show <request_id> --ask <path> --marker <path> --key <path> [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--ask` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--key` | yes | no | no |
| `--marker` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `request_id` | no | no |

## `broker`

Hidden: no

Usage:

    team broker

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `bus`

Hidden: no

Usage:

    team bus

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `check`

Hidden: no

Usage:

    team check [--session <name>] [--file <path>] [--repair] [--json]
    team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--pr` | yes | no | no |
| `--repair` | no | no | no |
| `--session` | yes | no | no |
| `--since` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `ref` | yes | no |

## `commits`

Hidden: no

Usage:

    team commits check <ref> [--since <ref>] [--file <path>] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `check`

Hidden: no

Usage:

    team commits check <ref> [--since <ref>] [--file <path>] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--since` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `ref` | no | no |

## `conformance-adapter`

Hidden: yes

Usage: none

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

None.

### Positionals

None.

## `delegate`

Hidden: no

Usage:

    team delegate <session/pane> --commands <act,...> [--dry-run] [--json]

### Who may run it

`owner-only` — a standing grant with a command list, written against this map: the owner's

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--commands` | yes | no | no |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `session/pane` | no | no |

## `doctor`

Hidden: no

Usage:

    team doctor [--session <name>] [--file <path>] [--login] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--login` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `down`

Hidden: no

Usage:

    team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>] [--json]

### Who may run it

`owner-or-leads` — `stop`: the owner or `leads` for its own team, and the owner may always stop

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--abandon` | no | no | no |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `--wait` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `drops`

Hidden: no

Usage:

    team drops [--follow] [--json]
    team drops --read --seat <seat> [--session <session>]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--follow` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--read` | no | no | no |
| `--seat` | yes | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `feed`

Hidden: no

Usage:

    team feed [--seat <name>] [--limit <n>] [--all] [--audit <path>] [--briefs <dir>] [--follow] [--json]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--audit` | yes | no | no |
| `--briefs` | yes | no | no |
| `--follow` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--limit` | yes | no | no |
| `--seat` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `grant`

Hidden: no

Usage:

    team grant <seat> --scope <act,...> [--dry-run] [--json]
    team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run] [--json]

### Who may run it

`owner-only` — granting is the approval, and the owner grants alone in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--capabilities` | yes | no | no |
| `--dry-run` | no | no | no |
| `--expires` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--name` | yes | no | no |
| `--scope` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | yes | no |
| `seat\|@team` | yes | no |

## `help`

Hidden: yes

Usage:

    team <command> [options]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

None.

### Positionals

None.

## `hold`

Hidden: no

Usage:

    team hold <reason> [--until <time>] [--json]
    team hold --release [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--release` | no | no | no |
| `--until` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `reason` | yes | no |

## `init`

Hidden: no

Usage:

    team init [--restore] [--json]

### Who may run it

`owner-only` — writing a team where none exists is the owner's act in 0.5.0: no create-bounds exist yet, so no agent holds `create`

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--restore` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `issues`

Hidden: no

Usage:

    team issues [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `list`

Hidden: no

Usage:

    team list [--all] [--seats] [--watch] [--json]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--seats` | no | no | no |
| `--watch` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `lock`

Hidden: no

Usage:

    team lock <name> [--for <text>] [--wait <seconds>] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--for` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--wait` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

## `mcp`

Hidden: no

Usage:

    team mcp status [--json]
    team mcp doctor [--json]
    team mcp serve --seat <seat> [--session <session>]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `doctor`

Hidden: no

Usage:

    team mcp doctor [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `serve`

Hidden: no

Usage:

    team mcp serve --seat <seat> [--session <session>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--seat` | yes | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `status`

Hidden: no

Usage:

    team mcp status [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

## `messages`

Hidden: no

Usage:

    team messages [--json]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `next`

Hidden: no

Usage:

    team next [--mine | --release] [--wait] [--json]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--mine` | no | no | no |
| `--release` | no | no | no |
| `--wait` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `plan`

Hidden: no

Usage:

    team plan [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `policy`

Hidden: no

Usage:

    team policy [--seat <name>] [--file <path>] [--json]
    team policy set <level> <name> <value> [--until <iso>] [--kind <enforced|advised>] [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]
    team policy unset <level> <name> [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--seat` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `set`

Hidden: no

Usage:

    team policy set <level> <name> <value> [--until <iso>] [--kind <enforced|advised>] [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--entity` | yes | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--kind` | yes | no | no |
| `--project` | yes | no | no |
| `--seat` | yes | no | no |
| `--until` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `level` | no | no |
| `name` | no | no |
| `value` | no | no |

### `unset`

Hidden: no

Usage:

    team policy unset <level> <name> [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--entity` | yes | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--project` | yes | no | no |
| `--seat` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `level` | no | no |
| `name` | no | no |

## `pr`

Hidden: no

Usage:

    team pr check <file> [--file <path>] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `check`

Hidden: no

Usage:

    team pr check <file> [--file <path>] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `file` | no | no |

## `proc`

Hidden: no

Usage:

    team proc add <name> [--pid <pid>] [--note <text>] [--json]
    team proc list [--json]
    team proc done <name> [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `add`

Hidden: no

Usage:

    team proc add <name> [--pid <pid>] [--note <text>] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--note` | yes | no | no |
| `--pid` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

### `done`

Hidden: no

Usage:

    team proc done <name> [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

### `list`

Hidden: no

Usage:

    team proc list [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

## `projects`

Hidden: no

Usage:

    team projects [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `raise`

Hidden: no

Usage:

    team raise <kind> <text> [--dry-run] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `kind` | no | no |
| `text` | no | no |

## `register`

Hidden: no

Usage:

    team register <seat> [--session <name>] [--pane <id>] [--dry-run] [--json]

### Who may run it

`owner-or-own-team` — a registry record is a report and confers no right: the owner, or the seat's own team

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--pane` | yes | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `release`

Hidden: no

Usage:

    team release check <package@version> [--json] [--file <path>]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `check`

Hidden: no

Usage:

    team release check <package@version> [--json] [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `package@version` | no | no |

## `reload`

Hidden: no

Usage:

    team reload <seat> [--file <path>] [--json]

### Who may run it

`owner-or-leads` — the `start` row for a running seat, as `restart`: closing and relaunching one seat is the same act

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `remove`

Hidden: no

Usage:

    team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>] [--json]

### Who may run it

`owner-or-leads` — removing a seat: the owner or `leads`; a seat holding `grant`, `agree` or `leads` stands only by the owner

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--abandon` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--keep` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

## `rename`

Hidden: no

Usage:

    team rename <seat> <new-seat> [--session <name>] [--file <path>] [--json]
    team rename --renumber [--dry-run] [--session <name>] [--file <path>] [--json]

### Who may run it

`owner-or-leads` — renaming a seat: the owner or `leads` for its own team

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--renumber` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | yes | no |
| `new-seat` | yes | no |

## `reply`

Hidden: no

Usage:

    team reply <id> [<text>] [--close] [--json]
    team reply <id> --close

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--close` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `id` | no | no |
| `text` | yes | no |

## `restart`

Hidden: no

Usage:

    team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>] [--json]

### Who may run it

`owner-or-leads` — the `start` row for a seat: as `start`

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--abandon` | no | no | no |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `revoke`

Hidden: no

Usage:

    team revoke grant [--dry-run] [--json]
    team revoke delegate <session/pane> [--dry-run] [--json]
    team revoke <name> [--dry-run] [--json]

### Who may run it

`owner-only` — removing a standing grant is the owner's edit, and the revocation channel of 0.5.0 is the owner at a terminal

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

### `delegate`

Hidden: no

Usage:

    team revoke delegate <session/pane> [--dry-run] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `session/pane` | no | no |

### `grant`

Hidden: no

Usage:

    team revoke grant [--dry-run] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

## `route`

Hidden: no

Usage:

    team route <seat> [--json] [--dry-run]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `seats`

Hidden: no

Usage:

    team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `--watch` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `send`

Hidden: no

Usage:

    team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --confirm <id> [--json] [--dry-run]
    team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
    team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
    team send --list [--json]

### Who may run it

`admission` — admission is chain position and the pair's setting, never a role's name: it is decided by the send admission, and this map admits no one to it

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--channel` | yes | no | no |
| `--confirm` | yes | no | no |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--list` | no | no | no |
| `--ms` | yes | no | no |
| `--record` | yes | no | no |
| `--timeout` | yes | no | no |
| `--wait` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | yes | no |
| `message` | yes | no |

## `status`

Hidden: no

Usage:

    team status [--session <name>] [--file <path>] [--project <name>] [--all] [--json]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--project` | yes | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `tempo`

Hidden: no

Usage:

    team tempo <word> [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `word` | no | no |

## `unlock`

Hidden: no

Usage:

    team unlock <name> [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

## `up`

Hidden: no

Usage:

    team up [--dry-run] [--serial] [--session <name>] [--file <path>] [--json]

### Who may run it

`owner-or-leads` — `start`: it runs the hash-pinned start command, and an operation is reached only through `leads` held in a role, never through a grant

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--serial` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `usage`

Hidden: no

Usage:

    team usage [--json] [--all] [--tree]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--tree` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `watch`

Hidden: no

Usage:

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--no-notify` | no | no | no |
| `--no-nudge` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `worktree`

Hidden: no

Usage:

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>] [--json]
    team worktree list [--session <name>] [--file <path>] [--json]
    team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>] [--json]

### Who may run it

`unlisted` — the command-to-capability map holds no row for this word: its own module decides who may run it, and no row here admits a caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `list`

Hidden: no

Usage:

    team worktree list [--session <name>] [--file <path>] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `new`

Hidden: no

Usage:

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--kind` | yes | no | no |
| `--seat` | yes | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `task` | no | no |

### `remove`

Hidden: no

Usage:

    team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>] [--json]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--branch` | yes | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `task` | no | no |
