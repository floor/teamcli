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

    team add <name> [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--effort` | yes | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
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

    team ask-show <request_id> --ask <path> --marker <path> --key <path>

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--ask` | yes | no | no |
| `--help` | no | no | no |
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

    team commits check <ref> [--since <ref>] [--file <path>]

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

    team commits check <ref> [--since <ref>] [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--since` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `ref` | no | no |

## `conformance-adapter`

Hidden: yes

Usage: none

### Flags

None.

### Positionals

None.

## `delegate`

Hidden: no

Usage:

    team delegate <session/pane> --commands <act,...> [--dry-run] [--json]

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

    team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--abandon` | no | no | no |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--session` | yes | no | no |
| `--wait` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `feed`

Hidden: no

Usage:

    team feed [--seat <name>] [--limit <n>] [--all] [--audit <path>] [--briefs <dir>] [--follow] [--json]

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

### Flags

None.

### Positionals

None.

## `hold`

Hidden: no

Usage:

    team hold <reason> [--until <time>] [--json]
    team hold --release [--json]

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

    team init [--restore]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--restore` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `issues`

Hidden: no

Usage:

    team issues [--json]

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

    team messages

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `next`

Hidden: no

Usage:

    team next [--mine | --release] [--wait]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--mine` | no | no | no |
| `--release` | no | no | no |
| `--wait` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `plan`

Hidden: no

Usage:

    team plan

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `pr`

Hidden: no

Usage:

    team pr check <file> [--file <path>]

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

    team pr check <file> [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `file` | no | no |

## `proc`

Hidden: no

Usage:

    team proc add <name> [--pid <pid>] [--note <text>]
    team proc list [--json]
    team proc done <name>

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

    team proc add <name> [--pid <pid>] [--note <text>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
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

    team proc done <name>

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
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

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `register`

Hidden: no

Usage:

    team register <seat> [--session <name>] [--pane <id>] [--dry-run]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
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

    team reload <seat> [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `remove`

Hidden: no

Usage:

    team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--abandon` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--keep` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | no | no |

## `restart`

Hidden: no

Usage:

    team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--abandon` | no | no | no |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
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
    team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
    team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
    team send --list [--json]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--channel` | yes | no | no |
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

    team tempo <word>

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `word` | no | no |

## `unlock`

Hidden: no

Usage:

    team unlock <name> [--json]

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

    team up [--dry-run] [--serial] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--serial` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `usage`

Hidden: no

Usage:

    team usage [--json] [--all]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `watch`

Hidden: no

Usage:

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

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

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]
    team worktree list [--session <name>] [--file <path>]
    team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>]

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

    team worktree list [--session <name>] [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `new`

Hidden: no

Usage:

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
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

    team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--branch` | yes | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `task` | no | no |
