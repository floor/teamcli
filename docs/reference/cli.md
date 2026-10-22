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

## `ack`

Hidden: no

Usage:

    team ack <id> [--json]

### Who may run it

`owner-or-own-team` — marking a message read is the record's addressee on its own pane, or the owner: the signed receipt is the same gate team messages writes, and it never reaches another seat's folder

A run with no terminal is refused: only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `id` | no | no |

## `add`

Hidden: no

Usage:

    team add <name> [--like <seat>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
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

`any-caller` — it verifies signed ask and marker files under a key the caller already holds: no team file, no seat and no terminal is read

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

## `brief`

Hidden: no

Usage:

    team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]

### Who may run it

`team-read` — the rollout plan reads the team's seats and their delivery claims: the owner, a seat the read gate places on its recorded pane, or an approved delegate pane; --file and --session are the owner's alone, and --apply delivers the general seat brief to the team's live seats

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `rollout`

Hidden: no

Usage:

    team brief rollout [--apply] [--seat <seat>] [--session <session>] [--file <path>] [--json]

#### Who may run it

`team-read` — the command's only verb: the plan is read by the owner, a seat the read gate places on its recorded pane, or an approved delegate pane, and --apply writes only the seat's claim and its signed drop

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--apply` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--seat` | yes | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

## `broker`

Hidden: no

Usage:

    team broker

### Who may run it

`owner-only` — the broker reads the tracker credential from the owner's keychain, one per clone, from a terminal outside herdr

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

`owner-only` — the bus reconciles the project's event log, and the owner runs it, one per clone, from a terminal outside herdr

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

## `client`

Hidden: no

Usage:

    team client keygen --out <dir> [--json]

### Who may run it

`any-caller` — its one verb writes a fresh app key pair and reads no team file, seat or terminal: the key is the caller's own, and only the owner's signed grant makes it authoritative

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `keygen`

Hidden: no

Usage:

    team client keygen --out <dir> [--json]

#### Who may run it

`any-caller` — it writes a fresh app key pair into a directory the caller names, and reads no team file, seat or terminal: the key is the caller's own, and only the owner's signed grant makes it authoritative

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--out` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

## `commits`

Hidden: no

Usage:

    team commits check <ref> [--since <ref>] [--file <path>] [--json]

### Who may run it

`any-caller` — it reads the commit range and the ledger only, from any folder, and asks for no session and no terminal

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

#### Who may run it

`any-caller` — the check reads the commit range and the ledger only, from any folder, and asks for no session and no terminal

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

## `config`

Hidden: no

Usage:

    team config keys [<level>] [--json]

### Who may run it

`any-caller` — it lists the settings registry the release ships and changes nothing: the registry is the same for every project, and no team file, seat or terminal is read

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `keys`

Hidden: no

Usage:

    team config keys [<level>] [--json]

#### Who may run it

`any-caller` — the listing is the command's only verb and reads the registry only: no team file, seat or terminal is read

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `level` | yes | no |

## `conformance-adapter`

Hidden: yes

Usage: none

### Who may run it

`any-caller` — the hidden port answers classify and yaml requests on stdin: it reads no team file and asks for no caller

### Flags

None.

### Positionals

None.

## `daemon`

Hidden: no

Usage:

    team daemon status [--json]
    team daemon run [--root <folder>] [--started-by <source>] [--presence] [--watch]
    team daemon install [--root <folder>] [--presence] [--watch] [--dry-run] [--json]
    team daemon uninstall [--json]
    team daemon fault-watch --root <folder> --route <routeId> [--dry-run] [--json]

### Who may run it

`owner-only` — the one machine daemon is the owner's: install, uninstall and run are owner-only, and the system service manager's no-terminal start is the owner's own login session

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `fault-watch`

Hidden: no

Usage:

    team daemon fault-watch --root <folder> --route <routeId> [--dry-run] [--json]

#### Who may run it

`owner-only` — the diagnostic asks the running daemon to end one hosted run under the install/uninstall admission: the owner, or the owner's dev-mode admission for a placed lead; it starts, stops and kills no process

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--root` | yes | no | no |
| `--route` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `install`

Hidden: no

Usage:

    team daemon install [--root <folder>] [--presence] [--watch] [--dry-run] [--json]

#### Who may run it

`owner-only` — registering the user service unit is the owner's act; the owner's dev-mode admission for a placed lead is the one other way

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--presence` | no | no | no |
| `--root` | yes | no | no |
| `--watch` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `run`

Hidden: no

Usage:

    team daemon run [--root <folder>] [--started-by <source>] [--presence] [--watch]

#### Who may run it

`owner-only` — starting the one machine daemon is the owner's, or the system service manager starting it in the owner's login session; a seat or a pane never starts it

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--presence` | no | no | no |
| `--root` | yes | no | no |
| `--started-by` | yes | no | no |
| `--watch` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `status`

Hidden: no

Usage:

    team daemon status [--json]

#### Who may run it

`any-caller` — the status reading is one health probe over the machine socket and reads no team file and no secret

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `uninstall`

Hidden: no

Usage:

    team daemon uninstall [--json]

#### Who may run it

`owner-only` — removing the user service unit is the owner's act; the owner's dev-mode admission for a placed lead is the one other way

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

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

## `development-mode`

Hidden: no

Usage:

    team development-mode [--json]
    team development-mode set <local-fast|pr-per-change|off> [--show] [--dry-run] [--json]

### Who may run it

`any-caller` — it reads the machine development mode and, with `--show` or `--dry-run`, prints the owner-authorization fingerprint for the switch; it changes nothing and asks for no team file, seat or terminal

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `set`

Hidden: no

Usage:

    team development-mode set <local-fast|pr-per-change|off> [--show] [--dry-run] [--json]

#### Who may run it

`owner-only` — the owner alone switches the machine development mode, from a terminal outside herdr, or with the existing out-of-band owner-authorization token for exactly this machine, mode and prior generation; the switch is signed with the owner key and logged

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--show` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `local-fast\|pr-per-change\|off` | no | no |

## `doctor`

Hidden: no

Usage:

    team doctor [--session <name>] [--file <path>] [--login] [--json]

### Who may run it

`any-caller` — the report changes nothing; the owner alone gets the budget checks, and every other caller gets the same report without them

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
    team drops --read --seat <seat> [--session <session>] [--epoch <run_id>]

### Who may run it

`seat-only` — a drop folder is one seat's mailbox: the seat the team declares, on the pane the state records for it, and never the owner; --read is the launch line's own invocation and asks for no caller

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--epoch` | yes | no | no |
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
    team grant --client <client-id> --entity <entity> --public-key <file> [--team <team>] [--seat <seat>] [--expires <ISO>] [--inbox] [--allow-grant] [--grant-entity <entity,...>] [--grant-project <project-id,...>] [--grant-team <team,...>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --request [--team <team>] [--seat <seat>] [--expires <ISO>] [--inbox] [--allow-grant] [--grant-entity <entity,...>] [--grant-project <project-id,...>] [--grant-team <team,...>] [--json]
    team grant --execute <request-id> --code <code> [--approve <once|always>] [--json]
    team grant --execute <request-id> [--json]
    team grant --answer <request-id> <oui|always|non> [--json]
    team grant --deny <request-id> [--json]
    team grant --add-owner-seat --team <team> --signer <name> [--entity <entity>] [--json]
    team grant --add-owner-signer --signer <name> --type <mac-keystore|webauthn> [--signer-public-key <hex>] [--credential-id <id>] [--rp-id <id>] [--json]
    team grant --approve-as-owner-seat <request-id> <oui|always|non> [--signer <name>] [--assertion <file>] [--at <ISO>] [--json]
    team grant --owner-seat-inbox [--json]
    team grant --approvals [--json]
    team grant --revoke-approval <rule-id> [--json]
    team grant --client-request --via <master-grant-file> --key <client-key> --client <client-id> --entity <entity> --public-key <file> [--team <team>] [--seat <seat>] [--expires <ISO>] [--inbox] [--json]

### Who may run it

`owner-only` — granting is the approval, and the owner grants alone in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--add-owner-seat` | no | no | no |
| `--add-owner-signer` | no | no | no |
| `--allow-grant` | no | no | no |
| `--answer` | yes | no | no |
| `--approvals` | no | no | no |
| `--approve` | yes | no | no |
| `--approve-as-owner-seat` | yes | no | no |
| `--assertion` | yes | no | no |
| `--at` | yes | no | no |
| `--capabilities` | yes | no | no |
| `--client` | yes | no | no |
| `--client-request` | no | no | no |
| `--code` | yes | no | no |
| `--credential-id` | yes | no | no |
| `--deny` | yes | no | no |
| `--dry-run` | no | no | no |
| `--entity` | yes | no | no |
| `--execute` | yes | no | no |
| `--expires` | yes | no | no |
| `--grant-entity` | yes | no | no |
| `--grant-project` | yes | no | no |
| `--grant-team` | yes | no | no |
| `--help` | no | no | no |
| `--inbox` | no | no | no |
| `--json` | no | no | no |
| `--key` | yes | no | no |
| `--name` | yes | no | no |
| `--owner-seat-inbox` | no | no | no |
| `--public-key` | yes | no | no |
| `--request` | no | no | no |
| `--revoke-approval` | yes | no | no |
| `--rp-id` | yes | no | no |
| `--scope` | yes | no | no |
| `--seat` | yes | no | no |
| `--signer` | yes | no | no |
| `--signer-public-key` | yes | no | no |
| `--team` | yes | no | no |
| `--type` | yes | no | no |
| `--via` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | yes | no |
| `seat\|@team` | yes | no |
| `oui\|always\|non` | yes | no |

## `help`

Hidden: yes

Usage:

    team <command> [options]

### Who may run it

`any-caller` — the help text reads no team file and asks for no caller

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

`team-change` — a hold is the team's: the owner, the orchestrator's seat or the operator's seat, on its recorded pane, places and releases it

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
    team init --request [--json]
    team init --execute <request-id> [--json]
    team init --approve-as-owner-seat <request-id> <oui|always|non> [--signer <name>] [--assertion <file>] [--json]
    team init --approvals [--json]
    team init --revoke-approval <rule-id> [--json]
    team init --approval-mode <none|always-rule|per-action> --scope <folder> [--signer <name>] [--assertion <file>] [--json]
    team init --approval-modes [--json]

### Who may run it

`owner-only` — writing a team where none exists is the owner's act in 0.5.0: no create-bounds exist yet, so no agent holds `create`

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--approval-mode` | yes | no | no |
| `--approval-modes` | no | no | no |
| `--approvals` | no | no | no |
| `--approve-as-owner-seat` | yes | no | no |
| `--assertion` | yes | no | no |
| `--execute` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--request` | no | no | no |
| `--restore` | no | no | no |
| `--revoke-approval` | yes | no | no |
| `--scope` | yes | no | no |
| `--signer` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `oui\|always\|non` | yes | no |

## `issues`

Hidden: no

Usage:

    team issues [--json]

### Who may run it

`any-caller` — it lists the task file the owner committed, from the checkout, and asks for no session and no terminal

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

`any-caller` — any caller may take a free machine lock from a folder whose team file loads; a lock another caller holds is refused, and unlock releases only the caller's own

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
    team mcp serve --seat <seat> [--session <session>] [--file <path>] [--epoch <run_id>]

### Who may run it

`any-caller` — status and doctor write nothing and ask for no caller; serve is the launch line's own invocation for a declared seat and asks for none either

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

#### Who may run it

`any-caller` — the report writes nothing and asks for no caller

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

    team mcp serve --seat <seat> [--session <session>] [--file <path>] [--epoch <run_id>]

#### Who may run it

`any-caller` — the launch line names its seat and session; the server reads and receipts only that seat's inbox, and asks for no caller

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--epoch` | yes | no | no |
| `--file` | yes | no | no |
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

#### Who may run it

`any-caller` — the report writes nothing and asks for no caller

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
    team messages --client <grant-file> --key <key-file> [--since <id>] [--ack <id>] [--limit <n>] [--request-id <id>] [--json]

### Who may run it

`seat-record` — a read surface of the Runtime and the modules: any seat with a registry record, and the `read` scope is not enforced in 0.5.0

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--ack` | yes | no | no |
| `--client` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--key` | yes | no | no |
| `--limit` | yes | no | no |
| `--request-id` | yes | no | no |
| `--since` | yes | no | no |
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

## `pause`

Hidden: no

Usage:

    team pause [<team>] [--reason <text>] [--all] [--json]

### Who may run it

`team-pause` — a pause stops every seat's intake of new work, the orchestrator's own lever on the team: the owner or the orchestrator's seat, on its recorded pane; the operator is not admitted, and its own stop is `team hold`

A run with no terminal is refused: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--reason` | yes | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `team` | yes | no |

## `plan`

Hidden: no

Usage:

    team plan [--json]

### Who may run it

`seat-only` — a declared seat of this team plans, on the pane the state records for it; the owner and a run with no terminal are not admitted

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

`team-read` — the view is read by the owner, a seat the state places on its recorded pane, or an approved delegate pane; set and unset are the owner's alone, from a terminal outside herdr

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

#### Who may run it

`owner-only` — the owner alone sets the policy, from a terminal outside herdr, signed and logged

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

#### Who may run it

`owner-only` — the owner alone unsets the policy, from a terminal outside herdr, signed and logged

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

`any-caller` — it reads a pull request body and the checks only, from any folder, and asks for no session and no terminal

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

#### Who may run it

`any-caller` — the check reads the pull request body and the checks only, from any folder, and asks for no session and no terminal

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

## `presence-hook`

Hidden: yes

Usage: none

### Who may run it

`any-caller` — the hidden hook stages one presence record under the project folder its own launch wrote into its argv: it reads no team file, no seat and no terminal, and its words are the launch's own

### Flags

None.

### Positionals

None.

## `proc`

Hidden: no

Usage:

    team proc add <name> [--pid <pid>] [--note <text>] [--json]
    team proc list [--json]
    team proc done <name> [--json]

### Who may run it

`owner-or-own-team` — add and done are the owner's or a declared seat's, from a terminal; list reads what status does, so an approved delegate pane may list too

A run with no terminal is refused: only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane

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

#### Who may run it

`owner-or-own-team` — the owner or a declared seat records its process; a seat of another team and a run with no terminal are refused

A run with no terminal is refused: only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane

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

#### Who may run it

`owner-or-own-team` — a seat clears its own, a lead clears another seat's, and the owner clears any; a run with no terminal is refused

A run with no terminal is refused: only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane

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

#### Who may run it

`team-read` — the owner, a seat the state places on its own pane, or an approved delegate pane reads the list

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

`any-caller` — it reads the project registry and changes nothing, from any folder

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

## `queue`

Hidden: no

Usage:

    team queue add <title> --id <id> [--assignee <name>] [--priority <value>] [--json]
    team queue list [--json]
    team queue ready <task> --commit <sha> [--version <version>] [--json]
    team queue install <task> --commit <sha> [--version <version>] [--json]

### Who may run it

`any-caller` — list reads the local task queue from the checkout and asks no caller; add is the owner's or a seat of this team's, on the pane the state records for it

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

    team queue add <title> --id <id> [--assignee <name>] [--priority <value>] [--json]

#### Who may run it

`owner-or-own-team` — adding to the local queue is the owner's or a declared seat's; the module refuses a seat the state cannot place on its recorded pane

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--assignee` | yes | no | no |
| `--help` | no | no | no |
| `--id` | yes | no | no |
| `--json` | no | no | no |
| `--priority` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `title` | no | no |

### `install`

Hidden: no

Usage:

    team queue install <task> --commit <sha> [--version <version>] [--json]

#### Who may run it

`owner-or-own-team` — an install is the owner's, or the one seat the file designates with an approved `installer:` on its recorded pane; the module refuses every other seat

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--commit` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--version` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `task` | no | no |

### `list`

Hidden: no

Usage:

    team queue list [--json]

#### Who may run it

`any-caller` — the listing reads the checkout and the queue only, and asks for no session and no terminal

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

None.

### `ready`

Hidden: no

Usage:

    team queue ready <task> --commit <sha> [--version <version>] [--json]

#### Who may run it

`seat-only` — a green slice ready is a declared seat's own record of the task its live lease holds, on the pane the state records for it; the owner is not admitted

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--commit` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--version` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `task` | no | no |

## `raise`

Hidden: no

Usage:

    team raise <kind> <text> [--dry-run] [--json]

### Who may run it

`leads-only` — the line is the lead's: the orchestrator's seat or a seat the team marks `leads`, on its recorded pane, and the owner is not admitted

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

`any-caller` — it reads the release facts and asks for no session, terminal or login; the Linear check alone needs the owner's keychain

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

#### Who may run it

`any-caller` — the check reads the release facts and asks for no session, terminal or login; the Linear check alone needs the owner's keychain

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

`admission` — a reply is judged by the send admission exactly as a send is, with the reply rule; the caller must be the record's addressee

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

## `resume`

Hidden: no

Usage:

    team resume [<team>] [--all] [--json]

### Who may run it

`team-pause` — a resume reopens the intake a pause closed, by the same gate: the owner or the orchestrator's seat, on its recorded pane; the operator is not admitted

A run with no terminal is refused: only the owner or the orchestrator runs this, from a terminal outside herdr or its own seat

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--all` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `team` | yes | no |

## `revoke`

Hidden: no

Usage:

    team revoke grant [--dry-run] [--json]
    team revoke delegate <session/pane> [--dry-run] [--json]
    team revoke <name> [--dry-run] [--json]
    team revoke <client-grant-id> [--json]
    team revoke --client <client-grant-id> [--json]

### Who may run it

`owner-only` — removing a standing grant is the owner's edit, and the revocation channel of 0.5.0 is the owner at a terminal

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--client` | yes | no | no |
| `--dry-run` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `name` | yes | no |
| `client-grant-id` | yes | no |

### `delegate`

Hidden: no

Usage:

    team revoke delegate <session/pane> [--dry-run] [--json]

#### Who may run it

`owner-only` — removing a standing delegation is the owner's edit, and the revocation channel of 0.5.0 is the owner at a terminal

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

#### Who may run it

`owner-only` — removing a standing grant is the owner's edit, and the revocation channel of 0.5.0 is the owner at a terminal

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

`admission` — a route is judged by the send admission: the owner and admitted seats are answered, and a run with no terminal is refused

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

## `seat`

Hidden: no

Usage:

    team seat <seat> [--session <name>] [--file <path>] [--json]
    team seat add <seat> [--session <name>] [--file <path>] [--json]
    team seat remove <seat> [--session <name>] [--file <path>] [--json]
    team seat restart <seat> [--session <name>] [--file <path>] [--json]
    team seat rename <seat> <name> [--session <name>] [--file <path>] [--json]

### Who may run it

`team-read` — one seat as an object — its settings, its status row and its newest session: the owner, a seat the read gate places on its recorded pane, or an approved delegate pane; `--file` and `--session` are the owner's alone, and the lifecycle verbs gate as the commands they run (their rows below)

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

### `add`

Hidden: no

Usage:

    team seat add <seat> [--session <name>] [--file <path>] [--json]

#### Who may run it

`owner-only` — the `add` row for a seat: adding a seat is the owner's in 0.5.0, where no `agree` or `grant` holders stand

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

### `remove`

Hidden: no

Usage:

    team seat remove <seat> [--session <name>] [--file <path>] [--json]

#### Who may run it

`owner-or-leads` — the `remove` row for a seat: the owner or `leads`; a seat holding `grant`, `agree` or `leads` stands only by the owner

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

### `rename`

Hidden: no

Usage:

    team seat rename <seat> <name> [--session <name>] [--file <path>] [--json]

#### Who may run it

`owner-or-leads` — the `rename` row for a seat: the owner or `leads` for its own team

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |
| `name` | no | no |

### `restart`

Hidden: no

Usage:

    team seat restart <seat> [--session <name>] [--file <path>] [--json]

#### Who may run it

`owner-or-leads` — the `restart` row for a seat: as `start`, the owner or `leads` for its own team

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--session` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `seats`

Hidden: no

Usage:

    team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]

### Who may run it

`team-read` — the owner, a seat the state places on its recorded pane, or an approved delegate pane reads the seats; --session and --file are the owner's alone

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
    team send <seat> --brief <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --client <grant-file> --key <key-file> <address> [--request-id <id>] <message>
    team send --client <grant-file> --key <key-file> <address> [--request-id <id>] --file <path>
    team send --confirm <id> [--json] [--dry-run]
    team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
    team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
    team send --list [--json]

### Who may run it

`admission` — admission is chain position and the pair's setting, never a role's name: it is decided by the send admission, and this map admits no one to it

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--brief` | yes | no | no |
| `--channel` | yes | no | no |
| `--client` | yes | no | no |
| `--confirm` | yes | no | no |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--key` | yes | no | no |
| `--list` | no | no | no |
| `--ms` | yes | no | no |
| `--record` | yes | no | no |
| `--request-id` | yes | no | no |
| `--timeout` | yes | no | no |
| `--wait` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | yes | no |
| `message` | yes | no |
| `address` | yes | no |

## `sessions`

Hidden: no

Usage:

    team sessions [<seat>] [--by <model|team|entity>] [--json]

### Who may run it

`any-caller` — it lists the machine-wide session registry the state records and changes nothing: no team file, no seat and no terminal is read

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--by` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | yes | no |

## `settings`

Hidden: no

Usage:

    team settings <seat> [--file <path>] [--json]
    team settings set <seat> <key> <value> [--file <path>] [--dry-run] [--json]
    team settings set <seat> <key=value> [--dry-run] [--json]
    team settings unset <seat> <key> [--file <path>] [--dry-run] [--json]

### Who may run it

`team-read` — one seat's settings and where each value comes from: the owner, a seat the read gate places on its recorded pane, or an approved delegate pane; `--file` is the owner's alone, and set and unset are the owner's outright (their rows below)

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

### `set`

Hidden: no

Usage:

    team settings set <seat> <key> <value> [--file <path>] [--dry-run] [--json]
    team settings set <seat> <key=value> [--dry-run] [--json]

#### Who may run it

`owner-only` — recording a seat's setting is the owner's: a lead's write within its role policy waits for the role policy the approved minimum leaves out, and this build refuses rather than admit a write no policy authorized

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |
| `key` | yes | no |
| `value` | yes | no |
| `key=value` | yes | no |

### `unset`

Hidden: no

Usage:

    team settings unset <seat> <key> [--file <path>] [--dry-run] [--json]

#### Who may run it

`owner-only` — removing a seat's setting is the owner's by the same gate as set: a lead's write within its role policy is not shipped yet, and this build refuses rather than admit one

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry-run` | no | no | no |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |
| `key` | no | no |

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

## `swap`

Hidden: no

Usage:

    team swap [--file <path>] [--json]
    team swap --rule [--file <path>] [--json]
    team swap queue <seat> [--to <target>] [--file <path>] [--json]
    team swap now <seat> [--file <path>] [--json]
    team swap cancel <seat> [--file <path>] [--json]
    team swap --run [--file <path>] [--json]

### Who may run it

`team-read` — the view and `--rule` read is the team's: the owner, a seat the read gate places on its recorded pane, or an approved delegate pane; `queue`, `now` and `cancel` have their own rows, and `--run` changes the team through the same verdict they call

### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--rule` | no | no | no |
| `--run` | no | no | no |
| `-h` | no | no | yes |

### Positionals

None.

### `cancel`

Hidden: no

Usage:

    team swap cancel <seat> [--file <path>] [--json]

#### Who may run it

`team-change` — cancelling a queued swap is the team's: the owner, the orchestrator's seat or the operator's seat, on its recorded pane, through `mayChangeTeamVerdict`

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
| `seat` | no | no |

### `now`

Hidden: no

Usage:

    team swap now <seat> [--file <path>] [--json]

#### Who may run it

`owner-only` — forcing a swap is the owner's word, from a terminal outside herdr or its own seat

A run with no terminal is refused: only the owner runs this, from a terminal outside herdr or its own seat

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
| `seat` | no | no |

### `queue`

Hidden: no

Usage:

    team swap queue <seat> [--to <target>] [--file <path>] [--json]

#### Who may run it

`team-change` — queueing a swap is the team's: the owner, the orchestrator's seat or the operator's seat, on its recorded pane, through `mayChangeTeamVerdict`

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--file` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--to` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `seat` | no | no |

## `tempo`

Hidden: no

Usage:

    team tempo <word> [--json]

### Who may run it

`owner-only` — the tempo word is the owner's, from a terminal outside herdr

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

`any-caller` — a lock is anyone's to take, and its release is the holder's alone: the caller the holder file names releases it, and anyone else is shown the holder

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

`any-caller` — anyone in a terminal or its own pane starts the watch; a run with no terminal is refused before it starts

A run with no terminal is refused: only the owner or a placed seat runs this, from a terminal outside herdr or its own pane

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

## `workflow`

Hidden: no

Usage:

    team workflow check <path> [--json]
    team workflow run <path> --dry --script <path> [--json]
    team workflow replay <definition> <journal> --evidence <path> [--json]

### Who may run it

`any-caller` — the workflow subcommand group: checking, dry-running, or replaying a workflow definition needs no session and no seat

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

    team workflow check <path> [--json]

#### Who may run it

`any-caller` — checks a workflow definition and its transition graph: read-only, so any seat, CI or the owner may run it

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `path` | no | no |

### `replay`

Hidden: no

Usage:

    team workflow replay <definition> <journal> --evidence <path> [--json]

#### Who may run it

`any-caller` — re-evaluates a dry-run journal against a workflow definition and supplied evidence: read-only, so any seat, CI or the owner may run it

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--evidence` | yes | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `definition` | no | no |
| `journal` | no | no |

### `run`

Hidden: no

Usage:

    team workflow run <path> --dry --script <path> [--json]

#### Who may run it

`any-caller` — runs a workflow definition in pure in-memory dry mode against a script: writes no state or ledger, so any seat, CI or the owner may run it

#### Flags

| Flag | Takes a value | Repeatable | Hidden |
| --- | --- | --- | --- |
| `--dry` | no | no | no |
| `--help` | no | no | no |
| `--json` | no | no | no |
| `--script` | yes | no | no |
| `-h` | no | no | yes |

#### Positionals

| Name | Optional | Repeatable |
| --- | --- | --- |
| `path` | no | no |

## `worktree`

Hidden: no

Usage:

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>] [--json]
    team worktree list [--session <name>] [--file <path>] [--json]
    team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>] [--json]

### Who may run it

`team-change` — the owner, the orchestrator's seat or the operator's seat manages worktrees; --session and --file are the owner's

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

#### Who may run it

`team-change` — the owner, the orchestrator's seat or the operator's seat lists the worktrees; --session and --file are the owner's

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

#### Who may run it

`team-change` — the owner, the orchestrator's seat or the operator's seat creates a worktree; --session and --file are the owner's

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

#### Who may run it

`team-change` — the owner, the orchestrator's seat or the operator's seat removes a worktree; --session and --file are the owner's

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
