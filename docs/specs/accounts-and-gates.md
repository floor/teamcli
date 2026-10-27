---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75) and int/0.5.1 (8acb470b, unreleased)
for: Runtime (chapters B, C, D, I and J; commitments 49 to 53, folded from amendment 01 on 2026-10-19)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: Accounts, resume, entity identity, and gate slots

## 1. Scope

This specification defines the file formats, environment mappings, lock files, commands, and runtime rules for seat conversation resume (`resume: true`), per-entity provider launch accounts (`accounts.yaml`), per-entity GitHub identities (`identity.yaml`), and project gate slot locks (`team lock`, `team unlock`, and `team gate`). It covers what is shipped at `v0.5.0 (52db9b75)` and `int/0.5.1 (8acb470b, unreleased)` (`<home>/.config/team/entities.yaml`, `<home>/.config/team/accounts.yaml`, `.agents/team.state.json` session tracking, and `team lock` / `team unlock`) together with the planned additions specified by Runtime amendment 01 (targeted after the event-driven `team send` work, outside `0.5.1`'s guaranteed scope unless time allows, with the amendment's owner confirmations remaining with the owner; not built at `int/0.5.1 8acb470b`). General seat launch profiles and state files belong to `launch.md`, agent and team registry records to `registry.md`, policy inheritance to `policies.md`, and the gate scripts' test-selection and report formats to `quality-gates.md`.

## 2. Terms

- `agent_session`: the session identifier recorded for a seat in `.agents/team.state.json` (`src/state.ts`); under `resume: true`, a lowercase hexadecimal UUID (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) backed by a verified on-disk transcript.
- `start_cwd`: the working directory in which a seat's launch command was started, recorded in `.agents/team.state.json` (`src/state.ts`).
- `cli_pid`: the child CLI process identifier spawned inside a seat's pane (recorded under `launched` in `.agents/team.state.json`, `src/state.ts`).
- `resume`: a boolean seat field in `team config` (`default: false`) requesting deterministic conversation continuity across CLI process exits (planned for 0.5.1).
- `account`: a seat field in `team config` naming either a per-entity provider launch account in `<home>/.config/team/entities/<entity>/accounts.yaml` (planned for 0.5.1) or a machine billing subscription in `<home>/.config/team/accounts.yaml` (`src/information/machine-accounts.ts`).
- `usage_account`: an optional field on a launch account in `<home>/.config/team/entities/<entity>/accounts.yaml` mapping the seat's token spend to a billing entry in `<home>/.config/team/accounts.yaml` (defaults to `provider`).
- `identity.github`: the per-entity GitHub credentials and commit-author block in `<home>/.config/team/entities/<entity>/identity.yaml` (planned for 0.5.1).
- `private-patterns.txt`: an entity's mode `0600` file of extended regular expressions at `<home>/.config/team/entities/<entity>/private-patterns.txt` scanned before a push.
- `who`: the holder file inside a `team lock` directory `<home>/.config/team/locks/<name>.lock/who` (`src/lock/machine.ts`).
- `owner`: the holder file inside a gate slot or conversation lock directory (`light-slot-{1..4}.lock/owner`, `heavy-run{,-2,-3}.lock/owner`, `hourly-suite.lock/owner`, `conversation-<id>.lock/owner`).
- `lstart`: the process start timestamp string from `ps -o lstart= -p <pid>`, written on line 3 of `owner` in 0.5.1 to detect OS process-identifier reuse.

## 3. Formats

### 3.1 Seat resume fields (`team config` and `.agents/team.state.json`)

- **Where:** `team config` (seat declaration, written by the project owner) and `.agents/team.state.json` (runtime state, written atomically under the session lock by `team`; `src/state.ts`).
- **Status at `v0.5.0 (52db9b75)` and `int/0.5.1 (8acb470b)`:** `agent_session`, `start_cwd`, and `launched` are shipped in `src/state.ts`; `resume: true` in `team config` and missing-transcript refusal state are 0.5.1 additions (not built at `int/0.5.1 8acb470b`).

| Field | Location | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|---|
| `resume` | `team config` (`seats[]`) | `boolean` | no | `false` | 0.5.1 (planned) | When `true`, `team` pre-assigns or resumes the seat's UUID conversation across CLI exits. Incompatible with a custom `launch:` string. |
| `account` | `team config` (`seats[]`) | `string` | no | — | 0.5.0 (billing) / 0.5.1 (launch) | Names a launch account in `entities/<entity>/accounts.yaml` first, or a billing subscription in `accounts.yaml`. |
| `agent_session` | `.agents/team.state.json` (`seats.<name>`) | `string` | no | — | 0.5.0 | Session identifier observed from the multiplexer or, under `resume: true`, the lowercase UUID verified on disk (mirrored to the seat's registry record). |
| `start_cwd` | `.agents/team.state.json` (`seats.<name>`) | `string` | no | — | 0.5.0 | Working directory in which the seat was launched; keys transcript lookup for cwd-scoped CLIs. |
| `launched` | `.agents/team.state.json` (`seats.<name>`) | `object` | no | — | 0.5.0 | `{ shell_pid: number, child_pids: number[] }` identifying the live CLI process in the pane. |

Example (`team config` seat declaration, 0.5.1):

```yaml
seats:
  - name: orchestrator
    role: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    resume: true
  - name: implementer-01
    role: implementer
    cli: claude-code
    vendor: deepseek
    model: DeepSeek V4.1
    version: "1.0"
    account: deepseek
```

### 3.2 Per-conversation lock (`<home>/.config/team/locks/conversation-<id>.lock`)

- **Where:** `<home>/.config/team/locks/conversation-<id>.lock`, with holder file `owner` inside.
- **Who writes it:** `team` during `up`, `add`, `restart`, or `reload` for any seat with `resume: true` (planned for 0.5.1; not built at `int/0.5.1 8acb470b`).

| Line in `owner` | Format | Required | Since | Meaning |
|---|---|---|---|---|
| Line 1 | `<holder-label>` | yes | 0.5.1 (planned) | Human-readable holder label (`<seat> (<team>)`). |
| Line 2 | `<seat> <pid> <utc-epoch>` | yes | 0.5.1 (planned) | Whitespace-separated words: seat name, process id (launcher pid during spawn, atomically rewritten to `<cli_pid>` before the launcher exits), and UTC epoch seconds. |
| Line 3 | `lstart <ps -o lstart= -p <cli_pid>>` | yes | 0.5.1 (planned) | Trimmed output of `ps -o lstart= -p <cli_pid>`, compared by `reclaim_dead_lock` when `kill -0 <pid>` succeeds. |

Example (`owner` inside `conversation-018f4a3c-7b2e-7000-8000-000000000001.lock`):

```text
orchestrator (beacon)
orchestrator 48210 1792350000
lstart Sun Oct 18 07:48:47 2026
```

### 3.3 Entity configuration (`entities.yaml`) and provider launch accounts (`entities/<entity>/accounts.yaml`)

- **Where:**
  - `<home>/.config/team/entities.yaml`: owner-signed file holding `<entity>.roots` and `<entity>.policies` (`src/entities.ts`, `src/policy/sources.ts`; shipped in `0.5.0`).
  - `<home>/.config/team/entities/<entity>/accounts.yaml`: unsigned mode `0600` operational file holding per-entity provider launch accounts (planned for `0.5.1`; never holds `roots` or `policies`).
  - `<home>/.config/team/accounts.yaml`: machine-level billing subscriptions (`src/information/machine-accounts.ts`; shipped in `0.5.0`).

| Field in `entities/<entity>/accounts.yaml` | Type | Required | Default | Since | Meaning & environment / argv mapping |
|---|---|---|---|---|---|
| `provider` | `string` | yes | — | 0.5.1 (planned) | Provider identifier (`deepseek`, `glm`, `kimi`). |
| `usage_account` | `string` | no | `provider` | 0.5.1 (planned) | Billing subscription key in `<home>/.config/team/accounts.yaml` (for example `glm` maps to `zai`). |
| `cli` | `string` | yes | — | 0.5.1 (planned) | Target CLI profile (`claude-code`). |
| `endpoint` | `string` | yes | — | 0.5.1 (planned) | Exported as `ANTHROPIC_BASE_URL`. |
| `keychain` | `string` | yes | — | 0.5.1 (planned) | macOS Keychain service name read via `security find-generic-password -s <keychain> -a "$USER" -w`; secret exported as `ANTHROPIC_AUTH_TOKEN` (`ANTHROPIC_API_KEY` is unset). |
| `default_model` | `string` | no | seat's `model` | 0.5.1 (planned) | Fallback for `$model`; exported as `ANTHROPIC_MODEL=$model`. |
| `opus_model` | `string` | no | `$model` | 0.5.1 (planned) | Exported as `ANTHROPIC_DEFAULT_OPUS_MODEL=${opus_model:-$model}`. |
| `sonnet_model` | `string` | no | `$model` | 0.5.1 (planned) | Exported as `ANTHROPIC_DEFAULT_SONNET_MODEL=${sonnet_model:-$model}`. |
| `haiku_model` | `string` | no | `$model` | 0.5.1 (planned) | Exported as `ANTHROPIC_DEFAULT_HAIKU_MODEL=${haiku_model:-$model}`. |
| `fable_model` | `string` | no | unset | 0.5.1 (planned) | When declared, exported as `ANTHROPIC_DEFAULT_FABLE_MODEL`. |
| `subagent_model` | `string` | no | `$model` | 0.5.1 (planned) | Exported as `CLAUDE_CODE_SUBAGENT_MODEL=${subagent_model:-$model}`. |
| `effort_default` | `string` | no | unset | 0.5.1 (planned) | When declared on account or seat, exported as `CLAUDE_CODE_EFFORT_LEVEL`. |
| `auto_compact_window` | `number` | no | unset | 0.5.1 (planned) | When declared, exported as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. |
| `max_context_tokens` | `number` | no | unset | 0.5.1 (planned) | When declared, exported as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. |
| `timeout_ms` | `number` | no | unset | 0.5.1 (planned) | When declared, exported as `API_TIMEOUT_MS`. |
| `skip_permissions` | `boolean` | no | `false` | 0.5.1 (planned) | When `true`, appends `--dangerously-skip-permissions`. |
| `isolate_mcp` | `boolean` | no | `false` | 0.5.1 (planned) | When `true`, appends `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. |
| `key_prefix_deny` | `string[]` | no | `[]` | 0.5.1 (planned) | Forbidden prefixes for the Keychain secret (for example `["sk-ant-"]`); matching secrets refuse launch. |
| `binary` | `string` | no | CLI profile binary | 0.5.1 (planned) | Explicit binary path when the CLI sits outside `PATH`. |
| `env` | `Record<string, string>` | no | `{}` | 0.5.1 (planned) | Additional environment variables exported into the child process. |
| `args` | `string[]` | no | `[]` | 0.5.1 (planned) | Additional CLI arguments appended at launch. |

Standard provider launch account reference table (0.5.1):

| Field | `deepseek` | `glm` | `kimi` |
|---|---|---|---|
| `provider` | `deepseek` | `glm` | `kimi` |
| `usage_account` | `deepseek` | `zai` | `kimi` |
| `cli` | `claude-code` | `claude-code` | `claude-code` |
| `endpoint` | `https://api.deepseek.com/anthropic` | `https://api.z.ai/api/anthropic` | `https://api.kimi.ai/coding/` |
| `keychain` | `deepseek-api-key` | `glm-api-key` | `kimi-api-key` |
| `default_model` | `deepseek-flash` | `glm-5.3` | `k3-256k` |
| `opus_model` | `$model` | `$model` | `$model` |
| `sonnet_model` | `$model` | `$model` | `$model` |
| `haiku_model` | `$model` | `glm-5.3-flash` | `$model` |
| `fable_model` | *(unset)* | *(unset)* | `$model` |
| `subagent_model` | `$model` | `$model` | `$model` |
| `effort_default` | `max` | *(unset)* | `high` |
| `auto_compact_window` | `786432` | *(unset)* | `262144` |
| `max_context_tokens` | *(unset)* | *(unset)* | `262144` |
| `timeout_ms` | *(unset)* | `3000000` | *(unset)* |
| `skip_permissions` | `true` | `true` | `false` |
| `isolate_mcp` | `true` | `true` | `true` |
| `key_prefix_deny` | `["sk-ant-"]` | `["sk-ant-"]` | `["sk-ant-"]` |

Example (`<home>/.config/team/entities/acme/accounts.yaml`, mode `0600`):

```yaml
accounts:
  deepseek:
    provider: deepseek
    usage_account: deepseek
    cli: claude-code
    endpoint: https://api.deepseek.com/anthropic
    keychain: deepseek-api-key
    default_model: deepseek-flash
    effort_default: max
    auto_compact_window: 786432
    skip_permissions: true
    isolate_mcp: true
    key_prefix_deny:
      - sk-ant-
```

### 3.4 Entity GitHub identity (`<home>/.config/team/entities/<entity>/identity.yaml`)

- **Where:** `<home>/.config/team/entities/<entity>/identity.yaml` (mode `0600`, unsigned; planned for 0.5.1).
- **Who writes it:** the entity owner.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `github.account` | `string` | yes | — | 0.5.1 (planned) | GitHub login for the entity. |
| `github.author_name` | `string` | yes | — | 0.5.1 (planned) | Exported as `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME`. |
| `github.author_email` | `string` | yes | — | 0.5.1 (planned) | Exported as `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL`. |
| `github.keychain` | `string` | yes | — | 0.5.1 (planned) | macOS Keychain service name holding the fine-grained PAT (`github_pat_...`); exported as `GH_TOKEN` (`GITHUB_TOKEN` unset). |

Child process Git environment injected alongside `GH_TOKEN`:

| Variable | Value |
|---|---|
| `GIT_CONFIG_COUNT` | `4` |
| `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` | `credential.https://github.com.helper` / `""` |
| `GIT_CONFIG_KEY_1` / `GIT_CONFIG_VALUE_1` | `credential.https://github.com.helper` / `!gh auth git-credential` |
| `GIT_CONFIG_KEY_2` / `GIT_CONFIG_VALUE_2` | `url.https://github.com/.insteadOf` / `git@github.com:` |
| `GIT_CONFIG_KEY_3` / `GIT_CONFIG_VALUE_3` | `url.https://github.com/.insteadOf` / `ssh://git@github.com/` |

Example (`<home>/.config/team/entities/acme/identity.yaml`, mode `0600`):

```yaml
github:
  account: acme-bot
  author_name: Acme
  author_email: bot@acme.example
  keychain: acme-github-token
```

### 3.5 Private patterns file (`<home>/.config/team/entities/<entity>/private-patterns.txt`)

- **Where:** `<home>/.config/team/entities/<entity>/private-patterns.txt` (mode `0600`, outside every repository, never committed).
- **Format:** line-oriented text; blank lines and lines matching `/^[ \t]*#/` are ignored; every other line is an extended regular expression tested against added diff lines and commit messages.

### 3.6 Declared gates (`gates:` in `team config`) and lock files (`who` vs `owner`)

- **Where:**
  - `gates:` in `team config` (`light`, `sweep`, `full`, `push`; planned for 0.5.1).
  - `<home>/.config/team/locks/<name>.lock/who`: written by `team lock` (`src/lock/machine.ts`; shipped at `v0.5.0`).
  - `light-slot-{1..4}.lock/owner`, `heavy-run{,-2,-3}.lock/owner`, `hourly-suite.lock/owner`: written by the gate runners (deployed in the gate scripts at `v0.5.0`; bundled into `team gate` with line 3 `lstart` in `0.5.1`).

Shipped `team lock` `who` fields (`src/lock/machine.ts` at `v0.5.0`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `team` | `string` | yes | — | 0.5.0 | Project name from `team config`. |
| `run` | `string` | yes | `""` | 0.5.0 | One-line note passed via `--for`. |
| `by` | `string` | yes | — | 0.5.0 | Caller identity (`owner` or seat name). |
| `at` | `string` | yes | — | 0.5.0 | UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SSZ`). |

Gate slot `owner` lines:

| Lock kind | Line 1 | Line 2 | Line 3 (0.5.1) |
|---|---|---|---|
| `heavy-run{,-2,-3}.lock`, `hourly-suite.lock` | `<holder-label>` (e.g. `hourly-suite (hourly-suite)` or `hub-sweep (<branch>)`) | `<holder> <pid> <utc-epoch>` (e.g. `run <pid> <epoch>` or `hub-sweep <pid> <epoch>`) | `lstart <ps -o lstart= -p <pid>>` |
| `light-slot-{1..4}.lock` | `<branch> <pid> <HH:MM:SS>` | *(blank in 0.5.1 so the line-2-then-line-1 parser falls through to line 1's `<pid>`)* | `lstart <ps -o lstart= -p <pid>>` |

Example (`team lock` output from `docs/commands/lock.md` at `v0.5.0`):

```console
$ team lock heavy-run --for "release CI"
heavy-run: taken
team: beacon
run: release CI
by: owner
at: 2026-10-04T09:00:00Z
```

## 4. Commands and options

### 4.1 Shipped at `v0.5.0 (52db9b75)` (`contract/cli.json`)

```text
team lock <name> [--for <text>] [--wait <seconds>] [--json]
team unlock <name> [--json]
```

- `<name>`: lowercase letters, digits, and hyphens (`^[a-z0-9-]+$`), at most 64 characters.
- `--for <text>`: note stored as `run` in `who`.
- `--wait <seconds>`: integer seconds to poll (`0` to `86400`), 1 second at a time, without breaking a held lock.
- `--json`: emits `team.lock` (`schema/lock.schema.json`) or `team.unlock` (`schema/unlock.schema.json`).
- **Exit codes (`contract/exit-codes.json`):**
  - `team lock`: `0` (`lock.taken`), `1` (`lock.held`, `lock.io`), `2` (`lock.invocation`, `lock.project`).
  - `team unlock`: `0` (`unlock.released`), `1` (`unlock.io`, `unlock.not-held`, `unlock.not-yours`, `unlock.unknown-holder`), `2` (`unlock.invocation`, `unlock.project`).

### 4.2 Planned for `0.5.1` after event-driven `team send` (Runtime amendment 01; outside `0.5.1`'s guaranteed scope unless time allows, owner confirmations pending)

```text
team up [--fresh [<seat>]]
team restart <seat> [--fresh]
team reload [--fresh [<seat>]]
team check [--repair]
team root [--entity <entity>]
team launch-env --entity <entity> [--account <name>] -- <cli> [<args>...]
team gate <light|full|push|sweep>
team gate --reclaim-wedged <slot>
```

- `--fresh [<seat>]`: mints a new lowercase UUID, starts the CLI with `--session-id <new-uuid>` instead of `--resume`, updates `agent_session` once the new transcript appears on disk, and logs both retired and new UUIDs in `.agents/team.log`.
- `team check --repair`: owner-only repair mode that clears an unowned `conversation-<id>.lock` (whose `owner` file is missing or unreadable past the launch timeout) only after verifying no live pane or process holds `<id>`.
- `team root [--entity <entity>]`: resolves the caller's entity (from `--entity`, else the current checkout's project/team registry record, else the caller's placed seat) and prints the entity root from `<home>/.config/team/entities.yaml` under `<entity>.roots` (replacing `M3_LIBRARY_DIR`); exits non-zero when unplaced or when no root is declared.
- `team launch-env`: one-release forwarder helper that constructs the account/identity environment and flags in-process and `exec`s `<cli>` directly without nested `team up`.
- `team gate <light|full|push|sweep>`: runs the declared project gate with paths resolved from the entity and project configuration.
- `team gate --reclaim-wedged <slot>`: owner-only command that clears a gate slot lock whose `owner` file is missing or has no readable pid, after verifying no gate runner process is active.

## 5. Rules

1. **Two-part deterministic resume contract.** A CLI profile MUST NOT be enabled for full `resume: true` lifecycle unless measured runs prove both (a) fresh pre-assignment of a `team`-minted lowercase UUID (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) at initial launch via `--session-id <uuid>`, and (b) deterministic resume of that UUID via `--resume <uuid>` after verifying that the transcript file exists and is non-empty on disk. `team` MUST write `agent_session` only after the transcript exists on disk and MUST NOT record human-readable session titles. Combining `resume: true` with a custom `launch:` string MUST be refused by `team check` and launch. (*Source:* `src/state.ts`, `src/profiles/*.yaml` at `v0.5.0`; *proof:* none at the tag for `resume: true`.)

| CLI profile (`v0.5.0` / `int/0.5.1` tested range) | Flags offered | `resume: true` status (planned) |
|---|---|---|
| `grok` (`1.0.50`–`1.0.52`) | `--session-id <uuid>`, `--resume <id\|title>` | Supported (UUID only, never title, never `--restore-code`). |
| `claude-code` (`2.1.288`–`2.1.302`) | `--session-id <uuid>`, `--resume <id>` | Resume of existing/imported UUID supported (transcript at `<home>/.claude/projects/<cwd-slug>/<id>.jsonl`); fresh pre-assignment refused fail-closed until evidenced by a measured run. |
| `gemini` (`0.64.0`) | `--session-id <uuid>`, `--resume` (latest/index) | Refused (`--resume` does not accept a deterministic UUID). |
| `codex` (`0.157.0`–`0.161.0`) | `codex resume [SESSION_ID]` | Refused (no pre-assignment flag at initial launch). |
| `cursor` (`2026.10.01`–`2026.10.14` at `v0.5.0`; `2026.10.01`–`2026.10.16` at `int/0.5.1`) | `--resume [chatId]` | Refused (no pre-assignment flag at initial launch). |
| `antigravity` (`1.2.16`–`1.4.1` at `v0.5.0`; `1.2.16`–`1.4.2` at `int/0.5.1`) | `--conversation <id>` | Refused (no pre-assignment flag at initial launch). |
| `muse` (`1.4.9`) | `muse resume (--last\|<session-ref>)` | Refused (no `--session-id <uuid>` pre-assignment flag at initial launch). |

2. **Missing-transcript per-seat refusal.** When starting a new CLI process for a `resume: true` seat whose recorded `agent_session` has no non-empty transcript on disk, `team` (`up`, `restart`, `reload`) MUST refuse that seat only, record the refusal on that seat's state entry, write the error to `stderr`, and continue launching remaining seats in `team up`. `team check` MUST remain read-only and report the recorded state without mutating `.agents/team.state.json`. (*Source:* Runtime commitment 49; *proof:* none at the tag.)

3. **Atomic double-live conversation refusal.** Before checking or binding a conversation `<id>`, `team` MUST hold the session mutator lock and acquire `<home>/.config/team/locks/conversation-<id>.lock`, writing the launcher pid on line 2 of `owner` and atomically rewriting line 2 to `<seat> <cli_pid> <utc-epoch>` and line 3 to `lstart <ps -o lstart= -p <cli_pid>>` before the launcher exits. If `owner` is missing or unreadable past the launch timeout, only `team check --repair` (after verifying no live pane or process holds `<id>`) MAY remove the lock. While holding both locks, `team` MUST scan all live multiplexer panes, all `.agents/team.state.json` and registry records (primary guard), and the process table `ps` for target CLI processes whose `--resume`, `--session-id`, or `--conversation` argument equals `<id>` (best-effort guard), and if any live holder is found MUST refuse the seat's launch before creating, closing, or typing into a pane, naming the seat, `<id>`, and the holding session, pane, and pid. (*Source:* Runtime commitment 49; *proof:* none at the tag.)

4. **Single entity authority source and account resolution precedence.** `<home>/.config/team/entities.yaml` MUST remain the single owner-signed source for `<entity>.roots` and `<entity>.policies` (`src/entities.ts`, `src/policy/sources.ts`). `<home>/.config/team/entities/<entity>/` MUST hold only unsigned mode `0600` operational files (`accounts.yaml`, `identity.yaml`, `private-patterns.txt`). When a seat declares `account: <name>`, `team` MUST look up `<name>` in `<home>/.config/team/entities/<entity>/accounts.yaml` first (building the provider launch and attributing usage to `usage_account`, which defaults to `provider`), fall back to `<home>/.config/team/accounts.yaml` as a billing-only subscription when absent from the entity launch file (`src/information/usage.ts`), and refuse at `team check` and launch when present in neither. Custom `launch:` commands remain mutually exclusive with a launch `account:`, and `team check` MUST warn when `launch:` references a path inside a docs repository. (*Source:* `src/entities.ts`, `src/information/machine-accounts.ts`, `src/information/usage.ts` at `v0.5.0`; *proof:* `test/usage.test.ts` at `v0.5.0` for billing accounts; none at the tag for entity launch accounts.)

5. **Keychain reads, prefix guards, and attribute-only `team doctor`.** On non-macOS platforms, `team check`, `team doctor`, and seat launch MUST fail closed whenever a seat or entity references a `keychain` entry. On macOS, `team doctor` MUST query `security find-generic-password -s <service> -a "$USER"` without `-w` so no secret is read into memory, distinguishing missing items from locked or denied keychains. At seat launch (`up`, `add`, `restart`, `reload`, `launch-env`), `team` MUST read the secret with `-w`, enforce `key_prefix_deny` on provider keys and the `github_pat_` prefix on `identity.github.keychain`, inject secrets and launch-account environment variables (including `ANTHROPIC_AUTH_TOKEN`, `AGENT_UNATTENDED=1`, and `GH_TOKEN`) only into the child CLI process environment with `GIT_CONFIG_COUNT=4` SSH-to-HTTPS rewrites, and MUST NOT print or log secret values or text matching `private-patterns.txt`. (*Source:* Runtime commitments 50–51; the frozen accepted text's §7 (2-runtime/history/amendment-01-launch-accounts-resume-accepted-2026-10-18.md); *proof:* none at the tag.)

6. **Gate slot locks, any-held skip order, and dead-lock reclamation.** `team lock` and `team unlock` MUST enforce single-holder directory locks at `<home>/.config/team/locks/<name>.lock` with `who`, never breaking a held or unreadable lock (`src/lock/machine.ts`; *proof:* `test/lock.test.ts` at `v0.5.0`). For `team gate`, the runner pool uses 4 light slots (`light-slot-{1..4}.lock`, waiter timeout `GATE_SLOT_WAIT_MAX_MIN=15`, run wall-clock timeout `LIGHT_CHECK_MAX_MIN=10` killing only the check's own `bun` tree), 3 heavy slots (`heavy-run{,-2,-3}.lock`, where `sweep` detaches first and waits up to `HUB_SWEEP_SLOT_TRIES=90` × 20s = 30 min), and `hourly-suite.lock`. No process MAY wait for a heavy slot while holding a light slot or wait for a light slot while holding a heavy slot. `team gate full` MUST execute in exact order: (1) `sweep_no_report`, (2) compare tip SHA to `last-sha`, (3) reclaim dead `hourly-suite.lock` and take it by `mkdir`, (4) reclaim dead locks across `heavy-run{,-2,-3}.lock` and if ANY heavy slot is held (`-d`), release `hourly-suite.lock`, log `heavy slot ... is held; skipping`, and skip the hour, (5) take the first free heavy slot by `mkdir` or, if all 3 were taken in a race, release `hourly-suite.lock` and skip. `reclaim_dead_lock` MUST parse the first all-digit word from line 2 then line 1 of `owner`, check `kill -0 <pid>` and (in 0.5.1) compare line 3's `lstart` against `ps -o lstart= -p <pid>`, verify `owner` is byte-for-byte unchanged, and atomically rename the lock directory before removing it. A lock with no readable pid MUST NOT be auto-reclaimed by a timer and MAY be cleared only by `team gate --reclaim-wedged <slot>`. `team gate push` MUST fail closed when `private-patterns.txt` is missing, unreadable, or matched. (*Source:* `src/lock/machine.ts` at `v0.5.0`, Runtime commitment 52; *proof:* `test/lock.test.ts` at `v0.5.0`, plus gate stub suites `hourly-suite.test.zsh`, `lock-reclaim.test.zsh`, `light-check-limit.test.zsh`, `light-check-release-race.test.zsh`, `cli-smoke-selection.test.zsh`.)

7. **Wrapper replacement inventory and staged migration.** Six obsolete knowledge-base tools scripts were superseded by shipped commands and removed at `eca38e5`: `team.sh` (`team up`), `team-watch.sh` and `agent-watchdog.sh` (`team watch`), `agent-queue.sh` (`team broker` / `team next`), `owner-runner.sh` (`team grant` / `delegates`), and `seat-roster.py` (`team seats` / `team usage`). The eight remaining entries follow a two-step replacement schedule (targeted after the event-driven `team send` work, outside `0.5.1`'s guaranteed scope unless time allows, with the amendment's owner confirmations remaining with the owner): (Step 1) the two session-resume wrappers move to `resume: true` on `orchestrator` and `architect`, the three provider wrappers (`claude-deepseek.sh`, `claude-glm.sh`, `claude-kimi.sh`) move to `account: deepseek`, `account: glm`, and `account: kimi`, the entity GitHub identity wrapper moves to `identity.github`, and the gate scripts folder (`teamcli-gates/`) moves to `gates:` in `team config` plus `team gate`; (Step 2, after `0.5.1` in Runtime amendment 02) `merge-train.sh` moves to `team merge-train` carrying all five gates (head unchanged during CI, all checks `SUCCESS`, reviewed SHA is an ancestor of head, zero behind `origin/main`, and every post-review first-parent commit is a clean two-parent mechanical merge). Migration MUST (a) change nothing during `0.5.0`, (b) ship `usage_account` attribution and dry-run environment/argv equivalence checks against the wrapper scripts first, (c) populate `<home>/.config/team/entities/<entity>/{accounts.yaml,identity.yaml,private-patterns.txt}` (`0600`) and replace existing wrapper scripts with one-line `exec team launch-env ...` forwarders, (d) import existing session UUIDs and verify non-empty transcripts before reloading `resume: true` seats, (e) migrate non-primary entities first and the tool's own team last while seats are idle with external backups, and (f) delete the forwarders once zero references remain across all team files. (*Source:* Runtime commitment 53; *proof:* none at the tag.)

## 6. Registries

### `registries/exit-codes.md`

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `lock.taken` | the lock was taken | 0.5.0 | `contract/exit-codes.json` | `team lock heavy-run` (exit 0) |
| `lock.held` | the lock is already held | 0.5.0 | `contract/exit-codes.json` | `team lock heavy-run` (exit 1) |
| `lock.io` | the lock directory could not be written | 0.5.0 | `contract/exit-codes.json` | `team lock heavy-run` (exit 1) |
| `lock.invocation` | the invocation can't be read | 0.5.0 | `contract/exit-codes.json` | `team lock` (exit 2) |
| `lock.project` | the caller's project can't be read | 0.5.0 | `contract/exit-codes.json` | `team lock heavy-run` (exit 2) |
| `unlock.released` | the lock was released | 0.5.0 | `contract/exit-codes.json` | `team unlock heavy-run` (exit 0) |
| `unlock.io` | the lock directory could not be removed | 0.5.0 | `contract/exit-codes.json` | `team unlock heavy-run` (exit 1) |
| `unlock.not-held` | the lock is not held | 0.5.0 | `contract/exit-codes.json` | `team unlock heavy-run` (exit 1) |
| `unlock.not-yours` | the lock is held by someone else | 0.5.0 | `contract/exit-codes.json` | `team unlock heavy-run` (exit 1) |
| `unlock.unknown-holder` | the lock's holder can't be read | 0.5.0 | `contract/exit-codes.json` | `team unlock heavy-run` (exit 1) |
| `unlock.invocation` | the invocation can't be read | 0.5.0 | `contract/exit-codes.json` | `team unlock` (exit 2) |
| `unlock.project` | the caller's project can't be read | 0.5.0 | `contract/exit-codes.json` | `team unlock heavy-run` (exit 2) |

### `registries/cli-ranges.md`

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `antigravity` | tested range `1.2.16`–`1.4.1` (`1.2.16`–`1.4.2` at `int/0.5.1`) | 0.5.0 | `src/profiles/antigravity.yaml` | `resume: true` refused in 0.5.1 (no pre-assignment flag at initial launch) |
| `claude-code` | tested range `2.1.288`–`2.1.302` | 0.5.0 | `src/profiles/claude-code.yaml` | `resume: true` resumes existing/imported UUID (`--resume <id>`); fresh `--session-id <uuid>` refused until measured |
| `codex` | tested range `0.157.0`–`0.161.0` | 0.5.0 | `src/profiles/codex.yaml` | `resume: true` refused in 0.5.1 (no pre-assignment flag at initial launch) |
| `cursor` | tested range `2026.10.01`–`2026.10.14` (`2026.10.01`–`2026.10.16` at `int/0.5.1`) | 0.5.0 | `src/profiles/cursor.yaml` | `resume: true` refused in 0.5.1 (no pre-assignment flag at initial launch) |
| `gemini` | tested range `0.64.0` | 0.5.0 | `src/profiles/gemini.yaml` | `resume: true` refused in 0.5.1 (`--resume` does not accept a deterministic UUID) |
| `grok` | tested range `1.0.50`–`1.0.52` | 0.5.0 | `src/profiles/grok.yaml` | `resume: true` supported in 0.5.1 (`--session-id <uuid>`, `--resume <uuid>`, UUID only) |
| `jules` | tested range `0.1.42` | 0.5.0 | `src/profiles/jules.yaml` | non-interactive CLI profile |
| `muse` | tested range `1.4.9` | 0.5.0 | `src/profiles/muse.yaml` | `resume: true` refused in 0.5.1 (no `--session-id <uuid>` pre-assignment flag at initial launch) |

## 7. Open points

1. **`claude-code --session-id <uuid>` fresh pre-assignment measurement:** fresh pre-assignment on `claude-code` remains refused fail-closed until a measured run proves `claude --session-id <fresh-uuid>` creates a new conversation transcript on disk rather than requiring an existing one.
2. **macOS `security` exit codes on locked keychains:** the exact exit codes (`44` for item-not-found vs `36` for interaction-not-allowed) and non-blocking behavior of `security find-generic-password` without `-w` on a locked keychain must be verified by implementation tests before 0.5.1 ships.
3. **Short-lived GitHub App tokens (`ghs_`):** whether `identity.github` should accept `ghs_...` installation tokens alongside `github_pat_...` fine-grained PATs (while still refusing `ghp_...` and `gho_...`) is pending owner confirmation.
4. **Machine billing `accounts.yaml` vs entity `accounts.yaml`:** whether `<home>/.config/team/accounts.yaml` stays separate and linked via `usage_account:` permanently or merges into per-entity files in a later release is pending owner confirmation.
5. **Light-slot acquisition in `team gate push`:** whether `team gate push` remains lock-free or acquires one of the 4 light slots during its test leg is pending owner confirmation.

## Revision log

- **Draft** (2026-10-18): lifted from Runtime amendment 01 (v2 draft); read at `v0.5.0 (52db9b75)` and `int/0.5.1 (8acb470b)`.
