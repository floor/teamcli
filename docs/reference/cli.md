# CLI reference

Generated from `contract/cli.json` by `scripts/contract.ts`. This file is checked in; `bun run contract:check` builds both from the command definitions and fails when either copy differs.

## `team`

Hidden: no

Usage:

    team <command> [options]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
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

    team add <name> [--dry-run] [--session <name>] [--file <path>]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--dry-run] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--like` | yes | no | no |
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

## `approve`

Hidden: no

Usage:

    team approve [--show] [--confirm] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--confirm` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--show` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

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

    team check [--session <name>] [--file <path>]
    team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--pr` | yes | no | no |
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

## `doctor`

Hidden: no

Usage:

    team doctor [--session <name>] [--file <path>] [--login]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
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

## `help`

Hidden: yes

Usage:

    team <command> [options]

### Flags

None.

### Positionals

None.

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

    team issues

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

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

## `send`

Hidden: no

Usage:

    team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --list [--json]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--list` | no | no | no |
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

    team status [--session <name>] [--file <path>] [--json]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `up`

Hidden: no

Usage:

    team up [--dry-run] [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `usage`

Hidden: no

Usage:

    team usage [--json]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
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
    team worktree remove <task> [--session <name>] [--file <path>]

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

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

    team worktree remove <task> [--session <name>] [--file <path>]

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `task` | no | no |
