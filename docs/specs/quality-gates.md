---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Module 005 Quality
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: Quality gates, suite paces, commit signature checks, and finding records

## 1. Scope

This specification defines the formats, commands, exit codes, and rules for TeamCLI's commit and pull-request signature and forbidden-pattern checks (`team commits check`, `team pr check`), the project suite (`bun run ci`, `bun run e2e`, capture provenance, docs examples, and tarball checks), the three-pace external gate scripts, not published (`light-check.sh`, `push-gate.sh`, `hourly-suite.zsh`, `hub-sweep.zsh`, `gate-common.sh`), and the finding and gate records. It separates what the released TeamCLI code implements at `v0.5.0 (52db9b75)` from the external gate scripts, not published (`light-check.sh`, `push-gate.sh`, `hourly-suite.zsh`, `hub-sweep.zsh`, `gate-common.sh` — neither in the public repository nor in the CLI at `v0.5.0`), alongside the finding record and quality policies proposed by Module 005 Quality. Machine slot lock directories (`team lock`, `light-slot-{1..4}.lock`, `heavy-run{,-2,-3}.lock`, `hourly-suite.lock`) are specified in `accounts-and-gates.md`, the Kernel's `review` and `gate` effect records in `records-and-ledger.md`, policy inheritance in `policies.md`, and the round lifecycle in `round.md`.

## 2. Terms

- `identity`: the section of `team config` configuring commit and pull-request signature templates, positions, human exemptions, `since` boundary, and forbidden regular expressions (`src/file/types.ts`, `src/check/config.ts`).
- `Finding`: a single check violation returned by `team commits check` or `team pr check` (`src/check/message.ts`), or a blocking defect recorded by a gate or reviewer.
- `FindingKind`: the closed union `'forbidden' | 'signature-missing' | 'signature-misplaced' | 'signature-in-prose' | 'signature-unknown'` in `src/check/message.ts`.
- `provenance`: the classification of each screen conformance fixture in `contract/capture-coverage.json` as `'capture'`, `'constructed'`, or `'undocumented'` (`scripts/coverage.ts`).
- `HUB_IMPORTERS`: the direct test-importer threshold (`default: 10` in `gate-common.sh`) above which a changed `src/` module contributes only its own name/path test to the light check and defers its other test importers to `hub-sweep.zsh`.
- `DEPTH1_MAX`: the cap on non-hub depth-1 test additions in the light check (`default: 60` in `gate-common.sh`), above which overflow files are deferred to `hub-sweep.zsh`.
- `heavy_tests`: the map of standalone slow test files in `gate-common.sh` (over ~60 seconds alone, such as `test/broker.test.ts` at `963` seconds) that run in the light check only when directly touched by the diff.
- `TEAM_EXIT_IDS`: comma-separated list of exit-code identifiers touched by a diff, exported by `gate-common.sh` to filter `test/exit-codes.test.ts` during local gate runs.
- `RED` / `RED-<ref>`: blocking finding marker files written by `hourly-suite.zsh` (`hourly-suite/RED` for the integration tip, stopping all merges into the integration branch; `hourly-suite/RED-<ref>` for other refs) and `hub-sweep.zsh` (`hub-sweep/RED-<branch>`).

## 3. Formats

### 3.1 Team file `identity` section (`team config`) and `commit-signature` policy

- **Where:** `team config` under `identity:` (`src/file/types.ts`, `src/file/signature.ts`, `src/check/config.ts`).
- **Who writes it:** the project owner.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `identity.signature.commits.template` | `string` | no | `'Agent: {display} · {role}'` | 0.5.0 | Template rendered per seat in `team config` and the historical seat ledger (`{display}`, `{model}`, `{version}`, `{role}`). Must include `{role}` and either `{display}` or both `{model}` and `{version}`. |
| `identity.signature.commits.position` | `'trailer' \| 'last-line' \| 'anywhere'` | no | `'trailer'` | 0.5.0 | Where the signature must appear in a commit message (`trailer` requires git's final trailer block in a trailer-only last paragraph). |
| `identity.signature.commits.exempt` | `('merge')[]` | no | `['merge']` | 0.5.0 | Exempts merge commits from requiring a signature (never from forbidden patterns). |
| `identity.signature.pullRequests.template` | `string` | no | `'**Agent:** {display} · {role}'` | 0.5.0 | Template required in a pull-request body. |
| `identity.signature.pullRequests.position` | `'trailer' \| 'last-line' \| 'anywhere'` | no | `'last-line'` | 0.5.0 | Where the signature must appear in a pull-request body (`trailer` means the last paragraph). |
| `identity.humans` | `string[]` | no | `[]` | 0.5.0 | Author email addresses whose commits are exempt from the signature requirement (never from forbidden patterns). |
| `identity.since` | `string \| null` | no | `null` | 0.5.0 | Commit ref at and below which historical commits are skipped unless overridden by `--since`. |
| `identity.forbidden` | `string[]` | no | `['^Claude-Session:', 'https?://claude\\.ai/code/session']` | 0.5.0 | Regular expressions forbidden on every line of a commit message or pull-request body (`DEFAULT_FORBIDDEN` is always prepended). |
| `identity.forbiddenPublic` | `string[]` | no | `[]` | 0.5.0 | Additional forbidden regular expressions enforced when `visibility: public`. |

Example (`team config` from `docs/commands/commits.md` at `v0.5.0`):

```yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

identity:
  humans: [jane@acme.example]
```

### 3.2 `team.commits` and `team.pr` JSON reports and `Finding` object (`schema/commits.schema.json`, `schema/pr.schema.json`)

- **Where:** emitted on `stdout` by `team commits check <ref> --json` and `team pr check <file> --json` (`src/commands/commits.ts`, `src/commands/pr.ts`, `src/check/message.ts`).

`Finding` object fields (`src/check/message.ts`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `kind` | `FindingKind` | yes | — | 0.5.0 | One of `'forbidden'`, `'signature-missing'`, `'signature-misplaced'`, `'signature-in-prose'`, `'signature-unknown'`. |
| `message` | `string` | yes | — | 0.5.0 | Human-readable finding explanation. |
| `line` | `integer` (`>= 1`) | no | — | 0.5.0 | 1-based line number in the commit message or pull-request body. |
| `text` | `string` | no | — | 0.5.0 | The offending line text. |

`team.commits` top-level fields (`schema/commits.schema.json` at `v0.5.0`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `schema` | `{ name: 'team.commits', version: 1 }` | yes | — | 0.5.0 | Document schema identifier. |
| `format` | `1` | yes | `1` | 0.5.0 | Output contract format version. |
| `ref` | `string` | yes | — | 0.5.0 | Checked commit or range argument. |
| `since` | `string \| null` | yes | `null` | 0.5.0 | Effective `since` boundary commit. |
| `commits` | `CommitEntry[]` | yes | — | 0.5.0 | Array of `{ hash, subject, status: 'ok' \| 'refused' \| 'exempt', exempt: 'merge' \| 'human' \| null, findings: Finding[] }`. |
| `skipped` | `integer` (`>= 0`) | yes | `0` | 0.5.0 | Number of commits skipped by `since`. |
| `pull_request` | `Finding[] \| null` | yes | `null` | 0.5.0 | Findings on the pull-request body when checked via the legacy `team check --pr` alias, else `null`. |
| `differences` | `{ what, repair, who }[]` | yes | — | 0.5.0 | Actionable difference blocks (`who` in `'the owner' \| "the team's lead" \| 'a grant holder' \| 'any seat'`). |
| `notes` | `string[]` | yes | `[]` | 0.5.0 | Validation warnings from loading the team file. |
| `summary` | `{ commits, refused, exempt, skipped, ok }` | yes | — | 0.5.0 | Aggregate counts and boolean pass status. |
| `notice` | `string \| null` | yes | `null` | 0.5.0 | Deprecation notice (set when invoked via the legacy `team check <ref>` alias). |

Example (`team pr check body.md --json` from `docs/commands/pr.md` at `v0.5.0`):

```json
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
```

### 3.3 Capture coverage matrix (`contract/capture-coverage.json`)

- **Where:** `contract/capture-coverage.json` and `src/profiles/trust-captures.ts`, generated and verified by `scripts/coverage.ts`.
- **Who writes it:** `bun run coverage --write`; verified by `bun run coverage:check`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `clis` | `string[]` | yes | — | 0.5.0 | Profiled CLIs (`antigravity`, `claude-code`, `codex`, `cursor`, `gemini`, `grok`, `jules`, `muse`). |
| `cells` | `Record<string, Record<Kind, { real, constructed, undocumented }>>` | yes | — | 0.5.0 | Counts per CLI and screen `Kind` (`idle`, `working`, `unsent`, `permission`, `question`, `exit question`, `trust`, `vendor notice`, `provider error`, `rate limit`, `unknown`). |
| `notProduced` | `Record<string, Record<string, string>>` | yes | — | 0.5.0 | Screen kinds a CLI does not produce, with the reason from its fixture README. |
| `fixtures` | `{ file, cli, kind, provenance }[]` | yes | — | 0.5.0 | Every screen fixture manifest entry (`220` `capture` and `49` `constructed` at `v0.5.0`). |
| `problems` | `string[]` | yes | `[]` | 0.5.0 | Provenance mismatches; must be empty (`[]`) for `coverage:check` to pass. |

### 3.4 Gate stamps, hub-sweep queue, suite reports, and red finding markers

- **Where:** written by the external gate scripts, not published (`push-gate.sh`, `light-check.sh`, `hub-sweep.zsh`, `hourly-suite.zsh` — neither in the public repository nor in the CLI at `v0.5.0`), under the configured gate notes directory.

| Artifact | Path pattern | Writer | Contents |
|---|---|---|---|
| Push-gate stamp | `gate/<branch_sanitized>-<sha>.ok` | `push-gate.sh` | Single line: `<sha> <branch> typecheck <space-separated test files or no-test-files>`. |
| Push-gate log | `gate/<branch_sanitized>-<sha>.log` | `push-gate.sh` | Selection reasons, private-pattern scan result, typecheck, commit-signature check, and per-file test timings. |
| Hub-sweep queue dir | `hub-sweep/queue/<branch_sanitized>-<sha12>-<set_hash12>/` | `light-check.sh` (removed by `hub-sweep.zsh`) | `files` (one test path per line), `hubs` (`<module> (<n> direct test importers)`), `meta` (`branch=`, `sha=`, `top=`, `created=`), `pid`. |
| Hub-sweep report | `hub-sweep/<branch_sanitized>-<sha>.md` | `hub-sweep.zsh` | Worktree, branch, SHA, file count, start/end timestamps, duration, `GREEN`/`RED`/`ERROR` verdict, pass/fail/skip/error/expect counts, per-file timings, hub modules, and failures by file. |
| Hourly-suite state | `hourly-suite.last-sha` | `hourly-suite.zsh` | Single line holding the 40-char commit SHA of the last completed hourly suite pass. |
| Hourly-suite pending sidecar | `hourly-suite/<sha>.pending` | `hourly-suite.zsh` | Line 1 `<ref>`, line 2 `<subject>`; created before `bun run ci` and removed when `hourly-suite/<sha>.md` is written so `sweep_no_report` can report `SIGKILL`-interrupted runs on the next pass. |
| Hourly-suite report | `hourly-suite/<sha>.md` | `hourly-suite.zsh` | Integration tip SHA and subject, start/end timestamps, exit code and `GREEN`/`RED`/`ERROR` verdict (or `NO REPORT`), marker path, last step, test counts, and failures by file. |
| Shared red marker | `hourly-suite/RED` | `hourly-suite.zsh`, `hub-sweep.zsh` | Written when a pass on the integration tip fails or exits without a report: line 1 `<sha>`, followed by failing test file paths (or `no report: …` / `stopped at: …`), ending with `no merges into the integration branch until understood`. |
| Branch red marker | `hourly-suite/RED-<ref_sanitized>`, `hub-sweep/RED-<branch_sanitized>` | `hourly-suite.zsh`, `hub-sweep.zsh` | Written when a non-tip ref fails: line 1 `branch <ref>`, line 2 `<sha>`, failing test files, ending with `no merge of this branch into the integration branch until understood`. |

### 3.5 Proposed store finding record (Module 005 §2 commitments 2 and 7, §10 question 2)

- **Status at `v0.5.0 (52db9b75)`:** not yet in `src/`; red markers are cleared in practice by renaming `RED` to `RED.understood-<timestamp>` with the closer and reason.
- **Proposed fields:** `id`, `work_id` / `effect_id` (the exact state or commit SHA the finding was raised on), `finder` (seat id and lab), `severity` (`blocking` or `advisory`), `status` (`open` or `closed`), `closed_by` (owner, finder, or a seat of a lab other than the work's author lab), `closed_on_state` (commit SHA / effect id), and `reason` (reopened automatically if the target state changes after closing).

## 4. Commands and options

### 4.1 Shipped CLI commands at `v0.5.0 (52db9b75)` (`contract/cli.json`)

```text
team commits check <ref> [--since <ref>] [--file <path>] [--json]
team pr check <file> [--file <path>] [--json]
team check [<ref>] [--pr <file>] [--since <ref>] [--file <path>] [--json]
```

- **Exit codes (`contract/exit-codes.json`):**
  - `team commits check`:
    - `0`: `commits.passed`
    - `1`: `commits.refused`
    - `2`: `commits.threw`, `commits.empty-range`, `commits.file`, `commits.file-invalid`, `commits.invocation`, `commits.ledger`, `commits.no-commit`, `commits.not-a-ref`, `commits.not-a-repo`, `commits.outside`, `commits.range`, `commits.since-missing`, `commits.since-unreachable`
  - `team pr check`:
    - `0`: `pr.passed`
    - `1`: `pr.refused`
    - `2`: `pr.body`, `pr.file`, `pr.file-invalid`, `pr.invocation`, `pr.ledger`, `pr.not-a-repo`

### 4.2 Suite commands (`package.json` and `.github/workflows/ci.yml` at `v0.5.0`)

```text
bun run ci
bun run e2e
bun scripts/check-pack.ts <tarball>
```

Where `bun run ci` executes in order:
1. `bun run typecheck` (`tsc --noEmit`)
2. `bun test`
3. `bun run build` (`bun scripts/build.ts`)
4. `node dist/cli.js --version`
5. `bun run conformance` (`bun scripts/conformance.ts --impl "node dist/cli.js conformance-adapter"`)
6. `bun run schema:check` (`bun scripts/schema.ts`)
7. `bun run contract:check` (`bun scripts/contract.ts --check`)
8. `bun run coverage:check` (`bun scripts/coverage.ts --check`)
9. `bun run exit-codes:check` (`bun scripts/exit-codes.ts --check`)
10. `bun run readme:check` (`bun scripts/check-readmes.ts`)

### 4.3 External gate scripts, not published (`light-check.sh`, `push-gate.sh`, `hourly-suite.zsh`, `hub-sweep.zsh`, `gate-common.sh` — neither in the public repository nor in the CLI at `v0.5.0`)

```text
zsh <gates-dir>/light-check.sh
zsh <gates-dir>/push-gate.sh [<git-push-args>...]
zsh <gates-dir>/hourly-suite.zsh [--loop]
zsh <gates-dir>/hub-sweep.zsh <queue-dir>
```

Environment knobs (`gate-common.sh`, `light-check.sh`, `hourly-suite.zsh`, `hub-sweep.zsh`):
- `HUB_IMPORTERS` (default `10`), `DEPTH1_MAX` (default `60`), `GATE_BASE` (default `origin/main` or newest non-main merge-base with `GATE_INTEGRATION`), `GATE_PRIVATE_PATTERNS`.
- `LIGHT_CHECK_MAX_MIN` (default `10`), `LIGHT_NO_HUB_SWEEP` (`1` disables background sweep queueing).
- `HOURLY_INTERVAL` (default `3600` seconds), `HOURLY_INTEGRATION_REF`.
- `HUB_SWEEP_SLOT_TRIES` (default `90` tries × `20` seconds = `1800` seconds).

## 5. Rules

1. **Commit and pull-request signatures and forbidden patterns.** Every non-exempt commit checked by `team commits check <ref>` and every pull-request body checked by `team pr check <file>` MUST carry a signature matching a seat in `team config` or the project's historical seat ledger (`mergeLedger`) at the configured position (`trailer` in a trailer-only last paragraph by default for commits; `last-line` by default for pull-request bodies), and MUST NOT contain any line matching `DEFAULT_FORBIDDEN` (`^Claude-Session:`, `https?://claude\.ai/code/session`), `identity.forbidden`, or (when `visibility: public`) `identity.forbiddenPublic`. Commits whose author email is in `identity.humans` and merge commits (when `'merge'` is in `identity.signature.commits.exempt`) are exempt from the signature requirement but MUST still pass all forbidden-pattern checks. A signature line in the last paragraph of a commit message that shares its paragraph with non-trailer prose MUST be refused with `signature-in-prose`; a signature matching the template's shape with unknown `{model}`, `{version}`, or `{role}` values MUST be refused with `signature-unknown`. (*Source:* `src/check/config.ts`, `src/check/message.ts`, `src/check/signature.ts`, `src/file/signature.ts` at `v0.5.0`; *proof:* `test/commits.test.ts`, `test/pr.test.ts`, `test/check/run.test.ts`, `test/check/message.test.ts`.)

2. **Full suite, capture provenance, executable documentation, tarball guard, and local end-to-end run.**
   - `bun run coverage:check` MUST fail if any screen fixture in `test/fixtures/` lacks stated provenance in its folder README or if `contract/capture-coverage.json` or `src/profiles/trust-captures.ts` is out of date; prose never determines provenance, and a fixture listed under a `Constructed` or `Not produced` heading MUST NOT be counted as a real `capture` (`scripts/coverage.ts`; *proof:* `test/scripts/coverage.test.ts`). Under Module 005 Quality commitments 12 and 15, screen-fixture verification MUST keep the name capture provenance, a code test-coverage floor policy MUST NOT be added under Module 005 Quality commitment 12, and code test coverage SHOULD be reported as a per-package coverage report only (the per-package code coverage report is unbuilt at `v0.5.0`).
   - Every console example in `docs/commands/*.md` MUST execute against its declared fixture in `test/docs.test.ts` and match its expected output and exit code byte for byte (*proof:* `test/docs.test.ts`).
   - `bun scripts/check-pack.ts <tarball>` MUST extract the packed npm tarball and exit `1` (naming the file path only, never the matched identifier) if any packaged file matches the internal tracker identifier pattern, or exit `2` if the tarball cannot be extracted (`scripts/check-pack.ts`; *proof:* `.github/workflows/ci.yml`).
   - `bun run e2e` MUST run locally only, refuse to start when the multiplexer is absent, when `team-test-e2e` already exists, or when machine load, free memory, or swap crosses its gate (`GATE_WAIT_MS = 60_000`), and MUST clean up its temporary session and directories on every exit path (`scripts/e2e.ts`; *proof:* `test/e2e.test.ts`).

3. **Dependency-aware test selection (`gate_select_tests` in `gate-common.sh`, external gate scripts, not published).** Both `light-check.sh` and `push-gate.sh` MUST select test files from the branch diff against `GATE_BASE` in exact order:
   - (a) `test/cli-smoke.test.ts` with reason `always` whenever the file exists;
   - (b) every `test/**/*.test.ts` file touched by the diff with reason `touched`;
   - (c) over a 2-hop reverse-import graph of relative specifiers across `src/*.ts`, for each affected depth-0 and depth-1 module: if its direct test importers (excluding `test/exit-codes.test.ts` and `heavy_tests`) exceed `HUB_IMPORTERS` (`10`), add only its name/path convention test (`test/<rel>.test.ts`, `test/<name>.test.ts`) to `tests` and defer its other importers to `hub_left_final`; otherwise add its direct test importers and name/path convention tests up to `DEPTH1_MAX` (`60`) non-hub tail files and defer any overflow to `hub_left_final` with reason `depth-1 tail over 60`;
   - (d) for each depth-2 module, add its tests (applying the same hub rule) only while `(${#tests} - touched_n) <= 80`; if the dependency selection exceeds `80` files, drop all depth-2 additions and leave them to the hourly suite;
   - (e) if any changed file matches `docs/*`, `README.md`, `npm-readme.md`, or `src/commands/*`, add `test/docs.test.ts`, `test/next.test.ts`, and `test/docs/*.test.ts` with reason `docs`;
   - (f) select `test/exit-codes.test.ts` only when directly touched, when `scripts/exit-codes.ts` or `scripts/contract.ts` changed (unfiltered), when a hunk of `test/exit-codes.test.ts` lies outside a `scene('...')` block (unfiltered), or when the diff against `GATE_BASE` touches `// exit: <id>` markers in `src/`, `"id": "<id>"` rows in `contract/exit-codes.json`, or `scene('<id>')` blocks in `test/exit-codes.test.ts` (filtered via `TEAM_EXIT_IDS`). A file in `heavy_tests` (`test/broker.test.ts`) MUST NOT be selected unless directly touched by the diff. (*Source:* `gate-common.sh`; *proof:* `cli-smoke-selection.test.zsh`.)

4. **Three gate paces and red markers (`light-check.sh`, `hub-sweep.zsh`, `push-gate.sh`, `hourly-suite.zsh`, external gate scripts, not published).**
   - **Per-batch (`light-check.sh` and `hub-sweep.zsh`):** `light-check.sh` compares the branch against the newest merge-base with `GATE_INTEGRATION` not on `origin/main` (or `origin/main` otherwise), warns on `private-patterns.txt` matches, atomically queues `hub-sweep.zsh` once per `(branch, head_sha[1..12], set_hash[1..12])` when `hub_left_final` is non-empty, runs `bun run typecheck` and the selected `tests` under a `LIGHT_CHECK_MAX_MIN` (`10` min) watchdog that kills only its own `bun` process tree, and frees its light slot with `INT`/`TERM`/`HUP` ignored during release. `hub-sweep.zsh` runs the deferred files in one heavy slot, releases the heavy slot immediately after the test loop before writing `hub-sweep/<branch>-<sha>.md` and sending its notification, and on failure writes `hourly-suite/RED` (if on the integration tip) or `hub-sweep/RED-<branch>`. (*Proof:* `light-check-limit.test.zsh`, `light-check-release-race.test.zsh`, `lock-reclaim.test.zsh`.)
   - **Per-push (`push-gate.sh`):** `push-gate.sh` refuses uncommitted changes and pushes from `main`, selects tests against `origin/main`, refuses the push if `gate_private_scan` finds any match in added diff lines or commit messages (printing `file:line pattern <n>` or `commit:<sha>:<line> pattern <n>`, never the matched text), runs `bun run typecheck`, runs `team commits check origin/main..HEAD --point push_gate` when `team config` exists and the installed CLI supports `--point`, runs the selected tests, writes `gate/<branch>-<sha>.ok`, and invokes `git push`.
   - **Per-hour (`hourly-suite.zsh`):** `hourly-suite.zsh` runs in a dedicated detached worktree on the integration tip at most once per hour when the tip SHA has advanced and no heavy slot or `hourly-suite.lock` is held. A failure in `git worktree` or `bun install --frozen-lockfile` is reported as `ERROR` without writing `RED` or updating `hourly-suite.last-sha`. Once `bun run ci` starts, `<sha>.pending` and the `EXIT` trap guarantee that any killed or crashed run writes a `NO REPORT` markdown file and the ref's `RED` marker; a failing `bun run ci` writes `hourly-suite/<sha>.md` and `hourly-suite/RED` (or `RED-<ref>`). (*Proof:* `hourly-suite.test.zsh`, `lock-reclaim.test.zsh`.) Under Module 005 Quality commitment 14, only the lead of the team that owns the suite MAY add a named exception in the hourly suite, under a delegation record; the exception MUST be recorded in an exceptions file beside the marker with the issue id and the fix's commit, and MUST land with the fix or within the day, or else the next run removes it (unbuilt at `v0.5.0`).

## 6. Registries

### `registries/exit-codes.md`

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `commits.passed` | every commit passed | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD` (exit 0) |
| `commits.refused` | a commit was refused | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD` (exit 1) |
| `commits.threw` | a forbidden pattern is not a regular expression | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD` (exit 2) |
| `commits.empty-range` | the range holds no commit | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD..HEAD` (exit 2) |
| `commits.file` | the team file can't be read | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD` (exit 2) |
| `commits.file-invalid` | the team file can't be parsed | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD --file team.yaml` (exit 2) |
| `commits.invocation` | the invocation can't be read | 0.5.0 | `contract/exit-codes.json` | `team commits check` (exit 2) |
| `commits.ledger` | the approval ledger can't be read | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD` (exit 2) |
| `commits.no-commit` | the ref names nothing | 0.5.0 | `contract/exit-codes.json` | `team commits check not-a-ref` (exit 2) |
| `commits.not-a-ref` | since is not a ref | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD --since --bad` (exit 2) |
| `commits.not-a-repo` | not inside a git repository | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD` (exit 2) |
| `commits.outside` | the check is not in a git repository | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD --file team.yaml` (exit 2) |
| `commits.range` | the range can't be resolved | 0.5.0 | `contract/exit-codes.json` | `team commits check missing..also` (exit 2) |
| `commits.since-missing` | since doesn't name a commit | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD --since missing` (exit 2) |
| `commits.since-unreachable` | since is not reachable from the ref | 0.5.0 | `contract/exit-codes.json` | `team commits check HEAD --since topic` (exit 2) |
| `pr.passed` | the pull request body passed | 0.5.0 | `contract/exit-codes.json` | `team pr check body.md` (exit 0) |
| `pr.refused` | the pull request body was refused | 0.5.0 | `contract/exit-codes.json` | `team pr check body.md` (exit 1) |
| `pr.body` | the pull request body can't be read | 0.5.0 | `contract/exit-codes.json` | `team pr check missing.md` (exit 2) |
| `pr.file` | the team file can't be read | 0.5.0 | `contract/exit-codes.json` | `team pr check body.md` (exit 2) |
| `pr.file-invalid` | the team file can't be parsed | 0.5.0 | `contract/exit-codes.json` | `team pr check body.md --file team.yaml` (exit 2) |
| `pr.invocation` | the invocation can't be read | 0.5.0 | `contract/exit-codes.json` | `team pr check` (exit 2) |
| `pr.ledger` | the approval ledger can't be read | 0.5.0 | `contract/exit-codes.json` | `team pr check body.md` (exit 2) |
| `pr.not-a-repo` | not inside a git repository | 0.5.0 | `contract/exit-codes.json` | `team pr check body.md` (exit 2) |

### `registries/policy-names.md`

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `development-mode` | project development mode (`local-fast` or `pr-per-change`, default `local-fast`) | 0.5.0 | `src/policy/types.ts` | shipped in `POLICY_NAMES` at `v0.5.0` |
| `board` | board and issue-tracking rules for a project or entity | 0.5.0 | `src/policy/types.ts` | shipped in `POLICY_NAMES` at `v0.5.0` |
| `review-terms` | review vocabulary and disposition terms for a project or entity | 0.5.0 | `src/policy/types.ts` | shipped in `POLICY_NAMES` at `v0.5.0` |
| `commit-signature` | trailing `Agent: <model> <version> · <role>` line, forbidden patterns, and observed-model match at commit-msg hook, push gate, and CI | planned | `src/check/config.ts` (as `team config` `identity:`) | proposed by Module 005 Quality (§2 commitment 9, §10 question 9) |
| `done` | what a piece of work must meet before it counts as checked and as done (for a change, a batch of a round, or a release) | planned | none at `v0.5.0` | proposed by Module 005 Quality (§2 commitments 1 and 12, §10 question 1) |
| `review-line` | the before/after review line (which work is checked before it lands and which after) | planned | none at `v0.5.0` | proposed by Module 005 Quality (§2 commitments 3 and 12, §10 question 3) |
| `review-lab` | which labs check which (reviewer from a lab other than the authors') | planned | none at `v0.5.0` | proposed by Module 005 Quality (§2 commitments 11 and 12, §10 question 5) |
| `real-run` | which work requires a run of the real thing in an isolated environment | planned | none at `v0.5.0` | proposed by Module 005 Quality (§2 commitments 4 and 12, §10 question 7) |
| `accept-with-finding` | who may accept work with a blocking finding still open (by default the owner's alone, an agent's only where written by name, recorded each time with the finding passed over; requires the Kernel capability/record handoff of Open point 12 before it can authorize an agent override at a gate) | planned | none at `v0.5.0` | proposed by Module 005 Quality (§2 commitments 7 and 12, §10 question 12) |
| `review-count` | how many reviewers must agree | planned | none at `v0.5.0` | proposed by Module 005 Quality (§2 commitment 12, §10 question 5) |

## 7. Open points

1. **`done` policy format:** whether `done` is an enforced/advised policy per work kind (change, batch, release) read by `round close` and work-item states, or remains defined by the round-close sequence alone.
2. **Store finding record and red markers:** defining the on-disk finding record in the Runtime store (state raised on, closer rules, automatic reopening on state change) and whether `hourly-suite/RED` and `RED.understood-<time>` become its first record kind.
3. **`review-line` always-before list:** how `review-line` represents the always-before categories that lie outside Kernel capabilities ("what a person runs by hand", "written where others read", and changes to the review policy itself).
4. **Owner-signed lab binding:** reconciling Kernel §5's requirement for an owner-signed lab binding with `team config`'s `vendor` field and the registry's recorded lab.
5. **Single home for `review-lab` and `review-count`:** consolidating `review-lab` and `review-count` in Module 005's policy set, cited by Module 010 Workflow.
6. **Governance of temporary test exceptions (settled by Module 005 Quality commitment 14):** only the lead of the team that owns the suite may add a named exception in the hourly suite, under a delegation record; it must be recorded in an exceptions file beside `hourly-suite/RED` with the issue id and the fix's commit, and must land with the fix or within the day, or else the next run removes it (Module 005 Quality commitment 14). *Unbuilt for the build:* specify the on-disk exceptions-file format beside `hourly-suite/RED` and the next-run automatic removal check.
7. **`real-run` policy and release live matrix:** specifying which changes require a local `bun run e2e` run before round close and whether the pre-release live matrix becomes a machine-read checklist.
8. **Check cost and effectiveness columns in the daily report:** adding per-check hold time, file count, findings raised, and escaped findings caught by later checks to Module 010's daily report.
9. **`commit-signature` three enforcement points and registry roster:** shipping the worktree `commit-msg` hook, `--point push_gate`, and observed-model matching in a release, and deciding whether CI reads the registry roster instead of `.github/team.yaml`.
10. **Capture provenance and per-package code coverage report (settled by Module 005 Quality commitments 12 and 15):** screen-fixture verification keeps the name capture provenance, a code test-coverage floor policy MUST NOT be added under Module 005 Quality commitment 12, and code test coverage is reported as a per-package coverage report only (Module 005 Quality commitment 15). *Unbuilt for the build:* specify the per-package code coverage report command and output path.
11. **Acceptance pass placement and `gate` records:** deciding whether the packed-binary acceptance scenes join `bun run ci` or remain a pre-release check, and whether their scene result lines emit the first Kernel §15 `gate` records.
12. **Kernel capability and record handoff for `accept-with-finding`:** Module 005 commitment 7 requires accepting work with an open blocking finding to be a separate right from ordinary `gate`/`merge`/`deploy`, while Kernel §3 has a closed capability vocabulary, Kernel §5 excludes module records from constraint predicates, and Kernel §13 forbids a module from creating a gate; until the Kernel capability/record handoff is defined and reviewed, `accept-with-finding` alone cannot authorize an agent to bypass a blocking finding or supply a Kernel gate input.

## Revision log

- **Draft** (2026-10-18): lifted from Module 005 Quality (v2 draft) and the external gate scripts, not published; read at `v0.5.0 (52db9b75)`.
- **Fold of round 1** (2026-10-19): separated the external gate scripts, not published (`light-check.sh`, `push-gate.sh`, `hourly-suite.zsh`, `hub-sweep.zsh`, `gate-common.sh`, and their `.test.zsh` test files — neither in the public repository nor in the CLI at `v0.5.0`) from the `v0.5.0 (52db9b75)` CLI release in §1, §3.4, §4.3, and §5 Rules 3–4; carried the settled dispositions of Module 005 Quality commitments 12, 14, and 15 into §5 Rules 2 and 4 and §7 Open points 6 and 10; and marked the unresolved Kernel capability/record handoff for `accept-with-finding` in §6 and §7 Open point 12.
