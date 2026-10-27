---
created: 2026-10-19
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: 005 Quality
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: release checks and records

## 1. Scope

This specification defines the `team config` `releases` section, the `team release check <package@version>` command and its human and JSON output contracts, the SemVer 2.0.0 version and channel rules, the four base public-record checks (`npm`, `tag`, `github`, `changelog`) and the `dist-tags` warning, the optional `linear` and `activity` release-record checks, the bounded HTTP and macOS Keychain contracts, and the `scripts/check-release-date.ts` pre-publish check. It lifts the contract of archived internal RFCs 0004 (`0004-releases.md`) and 0005 (`0005-release-records.md`) as built at `v0.5.0 (52db9b75)`. It does not publish packages, create or push tags, edit GitHub releases, modify npm `dist-tags`, mutate Linear milestones or status updates, or write activity files; every operation in this specification is read-only and stateless.

## 2. Terms

- **Release declaration (`ReleaseDecl`):** one entry in the top-level `releases` sequence of `team config`, binding an npm `package` name to a `github` `owner/repo` and optional `trusted_publishing`, `linear_*`, and `activity_*` settings (`src/file/sections/releases.ts`).
- **SemVer 2.0.0 version:** a version string matching `SEMVER_PATTERN` (`major.minor.patch` with optional `-<prerelease>` and `+<build>`, and no leading `v` prefix; `src/release/grammar.ts`).
- **Prerelease channel:** the classification determined by `hasPrerelease(version)` — `true` when the version carries a `-<prerelease>` part before any `+<build>` metadata, `false` otherwise (`src/release/grammar.ts`).
- **Check status (`Status`):** one of `pass`, `missing`, or `unknown` (`src/release/checks.ts`). `missing` means a completed, interpretable read disproved a required condition; `unknown` means a required read failed, timed out, exceeded a budget cap, or returned an unexpected HTTP status or malformed structure.
- **Compound check:** a check whose verdict combines multiple part checks or sequential network reads (`npm` with provenance, `tag` ref/object/compare, and `linear` project/milestone/update conditions) without short-circuiting required reads whose inputs are known (`src/release/checks.ts`).
- **Endpoint read and HTTP attempt:** one logical call to `Reader.read(url, request)` (`READ_CAP = 14` per command invocation) and one underlying `fetch` call (`ATTEMPT_CAP = 28` per command invocation, including at most one retry per endpoint read; `src/release/checks.ts`, `src/release/http.ts`).
- **Trusted publishing:** a release declaration with `trusted_publishing: true`, requiring an npm SLSA v1 provenance attestation (`predicateType: "https://slsa.dev/provenance/v1"`) in addition to the version record and checksums (`src/release/checks.ts`).
- **Linear release record:** the paired `linear_project` UUID and `linear_keychain_service` configuration verified by a single bounded GraphQL `POST` to `https://api.linear.app/graphql` for a completed milestone named `<version>` and an unarchived project status update on or after the changelog release date (`src/release/checks.ts`).
- **Activity marker:** the paired `activity_file` path and `activity_marker` template verified by an exact single-line match on the repository's default branch (`src/release/checks.ts`).

## 3. Formats

### 3.1 `team config` `releases` section (`src/file/sections/releases.ts`, `src/release/grammar.ts`)

`releases` is an optional top-level sequence in `team config` (`owner: false`: it names public records and a Keychain service name, never a secret, and grants no seat authority, so editing it requires no owner approval digest update). When present, it MUST be a non-empty list of map entries (`minItems: 1`) with no unknown keys.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `releases` | array of objects | no (`minItems: 1` when present) | `[]` | 0.5.0 | package release declarations read by `team release check` and validated by `team check` / `team doctor` |
| `releases[].package` | string | yes | — | 0.5.0 | npm package name matching `^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$` (`PACKAGE_PATTERN`), at most `214` UTF-8 bytes (`PACKAGE_BYTES`), unique across `releases` |
| `releases[].github` | string | yes | — | 0.5.0 | GitHub repository `owner/repo` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` (`GITHUB_PATTERN`) |
| `releases[].trusted_publishing` | boolean | no | `false` | 0.5.0 | unquoted YAML boolean `true` or `false` only; when `true`, `npm` check requires SLSA v1 provenance attestation |
| `releases[].linear_project` | string | paired with `linear_keychain_service` | — | 0.5.0 | canonical lowercase UUID matching `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (`LINEAR_PROJECT_PATTERN`) |
| `releases[].linear_keychain_service` | string | paired with `linear_project` | — | 0.5.0 | non-empty macOS Keychain service name, at most `255` UTF-8 bytes (`KEYCHAIN_SERVICE_BYTES`), containing no control characters (`0x00`–`0x1f`, `0x7f`–`0x9f`); names the Keychain item, never the secret key |
| `releases[].activity_file` | string | paired with `activity_marker` | — | 0.5.0 | printable ASCII (`0x20`–`0x7e`) slash-separated repository-relative path, at most `512` UTF-8 bytes (`ACTIVITY_FILE_BYTES`), each segment matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (`ACTIVITY_SEGMENT`) |
| `releases[].activity_marker` | string | paired with `activity_file` | — | 0.5.0 | non-empty printable ASCII (`0x20`–`0x7e`) line template, at most `200` UTF-8 bytes (`ACTIVITY_MARKER_BYTES`), no control characters, containing `<package>` exactly once and `<version>` exactly once |

Example `team config` `releases` configuration:

```yaml
releases:
  - package: material
    github: acme/material
    trusted_publishing: true
    linear_project: 73495f50-f9e0-4469-8585-e7af6aa49567
    linear_keychain_service: linear-release-check
    activity_file: docs/releases.md
    activity_marker: "Released <package> <version>"
  - package: "@acme/cli"
    github: acme/cli
```

### 3.2 SemVer 2.0.0 version and channel grammar (`src/release/grammar.ts`)

| Symbol / Function | Pattern / Signature | Since | Meaning |
|---|---|---|---|
| `CORE` | `(?:0\|[1-9][0-9]*)` | 0.5.0 | non-negative decimal integer without leading zeros |
| `PRERELEASE_IDENT` | `(?:0\|[1-9][0-9]*\|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)` | 0.5.0 | dot-separated prerelease identifier (numeric without leading zeros, or alphanumeric/hyphen) |
| `BUILD_IDENT` | `[0-9a-zA-Z-]+` | 0.5.0 | dot-separated build-metadata identifier |
| `SEMVER_PATTERN` | `^${CORE}\.${CORE}\.${CORE}(?:-${PRERELEASE_IDENT}(?:\.${PRERELEASE_IDENT})*)?(?:\+${BUILD_IDENT}(?:\.${BUILD_IDENT})*)?$` | 0.5.0 | exact Semantic Versioning 2.0.0 version without a leading `v` |
| `hasPrerelease(version)` | `(version.split('+')[0]).includes('-')` | 0.5.0 | `true` for prerelease versions (`1.2.0-rc.1`), `false` for stable versions (`1.2.0`, `1.2.0+20261019`) |
| `compareVersions(a, b)` | `(a: string, b: string) => -1 \| 0 \| 1 \| null` | 0.5.0 | SemVer 2.0.0 §11 precedence comparison (ignoring build metadata); returns `null` when either input does not match `SEMVER_PATTERN` |

### 3.3 Human output format and JSON output schema (`src/commands/release.ts`, `schema/release.schema.json`)

#### Human output (`renderPlainRelease`)

1. Header line: `package <name>, version <version>`
2. Table (`formatTable`) with headers `CHECK`, `STATE`, `DETAIL` and rows in the fixed order `npm`, `tag`, `github`, `changelog`, followed by `linear` (when configured) and `activity` (when configured). On a TTY, `STATE` cells are colored green for `pass`, red for `missing`, and yellow for `unknown`.
3. Optional warning line immediately after the table when `staleNextWarning` returns a string:
   `warn  npm's next dist-tag points at <next>, older than latest <latest>: run npm dist-tag add <name>@<latest> next`
4. Summary line: `<n> check(s), <m> missing`

Example plain output:

```text
package material, version 0.2.0
CHECK      STATE  DETAIL
npm        pass   exact version, checksums, and provenance found
tag        pass   tag resolves to a commit on the default branch
github     pass   published release matches SemVer channel
changelog  pass   changelog entry has a valid release date
linear     pass   Linear milestone is complete and a qualifying status update exists
activity   pass   public activity marker found
6 checks, 0 missing
```

#### JSON output (`schema/release.schema.json`, `team.release` v1)

When `--json` is passed, normal check runs write one `team.release` v1 JSON object to stdout (`additionalProperties: false`):

| Field | Type | Required | Since | Meaning |
|---|---|---|---|---|
| `schema` | `{ name: "team.release", version: 1 }` | yes | 0.5.0 | schema identifier |
| `format` | `1` | yes | 0.5.0 | payload format version |
| `package` | string (`minLength: 1`) | yes | 0.5.0 | checked npm package name |
| `version` | string (`minLength: 1`) | yes | 0.5.0 | checked SemVer 2.0.0 version |
| `checks` | object | yes | 0.5.0 | check outcomes keyed by check name (`npm`, `tag`, `github`, `changelog` required; `linear`, `activity` present when configured) |
| `checks.<name>.status` | `"pass"` \| `"missing"` \| `"unknown"` | yes | 0.5.0 | outcome of check `<name>` |
| `checks.<name>.detail` | string (`minLength: 1`) | yes | 0.5.0 | single-line diagnostic or confirmation message |
| `warning` | string (`minLength: 1`) | no | 0.5.0 | present only when npm's `next` dist-tag points at a SemVer version older than `latest` |
| `summary` | `{ checks: integer, missing: integer, unknown: integer }` | yes | 0.5.0 | total checks run (`4`, `5`, or `6`) and counts of `missing` and `unknown` outcomes |

Example JSON output:

```json
{
  "schema": { "name": "team.release", "version": 1 },
  "format": 1,
  "package": "material",
  "version": "0.2.0",
  "checks": {
    "npm": { "status": "pass", "detail": "exact version and checksums found" },
    "tag": { "status": "pass", "detail": "tag resolves to a commit on the default branch" },
    "github": { "status": "pass", "detail": "published release matches SemVer channel" },
    "changelog": { "status": "pass", "detail": "changelog entry has a valid release date" }
  },
  "summary": { "checks": 4, "missing": 0, "unknown": 0 }
}
```

#### Error output on exit `64` (`release.usage` and `release.configuration`)

- Without `--json`, writes `team release: <message>\n` to stderr.
- With `--json`, writes a `team.error` v1 envelope to stdout with `error.code` set to `"release.usage"` or `"release.configuration"`, `error.message` set to `<message>`, and `error.fix` set to `null`.

### 3.4 Linear GraphQL query and variables (`src/release/checks.ts`)

When the `linear` check runs, it sends a single HTTP `POST` to `https://api.linear.app/graphql` (`LINEAR_URL`) with headers `Content-Type: application/json` and `Authorization: <key>`, and JSON body `{ "query": RELEASE_RECORDS_QUERY, "variables": { "projectId": "<linear_project>", "first": 100 } }`, where `RELEASE_RECORDS_QUERY` is byte for byte:

```graphql
query ReleaseRecords($projectId: String!, $first: Int!) {
  project(id: $projectId) {
    id
    archivedAt
    projectMilestones(first: $first, includeArchived: true) {
      nodes { name status }
      pageInfo { hasNextPage }
    }
    projectUpdates(first: $first, includeArchived: true) {
      nodes { createdAt archivedAt }
      pageInfo { hasNextPage }
    }
  }
}
```

## 4. Commands and options

### 4.1 `team release check` (`src/commands/release.ts`)

```text
team release check <package@version> [--json] [--file <path>]
```

| Argument / Option | Required | Default | Meaning |
|---|---|---|---|
| `check` | yes | — | the only subcommand of `team release` |
| `<package@version>` | yes | — | target package name and SemVer 2.0.0 version separated at the last `@` (`at = target.lastIndexOf('@')`, with `at > 0`) |
| `--json` | no | `false` | emit `team.release` v1 (or `team.error` v1 on exit `64`) as JSON on stdout; recognized anywhere in `argv` except immediately after `--file` |
| `--file <path>` | no | main checkout's `team config` | load the team file from `<path>` (`loadTeamFile(io.cwd, { file, checkOnly: true })`) |

Exit codes: `0` (`release.passed`), `1` (`release.missing`), `2` (`release.unknown`), `64` (`release.usage` or `release.configuration`).

### 4.2 `team check` / `team doctor` (`src/file/sections/releases.ts`)

Validates the `team config` `releases` section against the schema and rules in §3.1 and §5 Rule 1 without making any network or Keychain calls.

### 4.3 `scripts/check-release-date.ts`

```text
bun scripts/check-release-date.ts <version>
```

Reads `CHANGELOG.md` from the repository root (`process.cwd()`). Invoked in `.github/workflows/release.yml` (`bun scripts/check-release-date.ts "${GITHUB_REF_NAME#v}"`) before publishing to verify that `CHANGELOG.md` has a bracketed `## [<version>] - YYYY-MM-DD` section with a real calendar date (not the `YYYY-MM-DD` placeholder). Exits `0` when the bracketed section exists with a valid calendar date, `1` when the section is missing or its date is a placeholder or invalid calendar date, and `2` when `<version>` (`process.argv[2]`) is missing or `CHANGELOG.md` cannot be read.

## 5. Rules

1. **Configuration validation and pair completeness (`src/file/sections/releases.ts`, `src/release/grammar.ts`).**
   - When `releases` is present in `team config`, it MUST be a non-empty sequence of maps containing only the allowed keys (`package`, `github`, `trusted_publishing`, `linear_project`, `linear_keychain_service`, `activity_file`, `activity_marker`).
   - Every entry MUST supply a valid `package` (`PACKAGE_PATTERN`, `<= 214` bytes) and `github` (`GITHUB_PATTERN`), and no two entries in `releases` may name the same `package` (`releases names "<pkg>" twice`).
   - `trusted_publishing`, when present, MUST be an unquoted YAML boolean literal `true` or `false` (`a release's trusted_publishing must be the boolean true or false`).
   - `linear_project` and `linear_keychain_service` MUST appear together or not at all (`a release's linear_project and linear_keychain_service come together`); `activity_file` and `activity_marker` MUST likewise appear together or not at all (`a release's activity_file and activity_marker come together`).
   - (*Source:* `src/file/sections/releases.ts`, `src/release/grammar.ts` at `v0.5.0`; *proof:* `test/release/section.test.ts`, `test/release/grammar.test.ts`.)

2. **Invocation validation and exit-64 precedence (`src/commands/release.ts`).**
   - `team release` MUST validate command-line syntax and argument grammars before reading the team file: any option parse error from `readArgs(argv, ['file'], ['json'])`, a missing or unknown subcommand (`sub !== 'check'`), a missing `<package@version>` or extra positional argument, a target that cannot split into non-empty `<package>` and `<version>` at `lastIndexOf('@') > 0`, a `<package>` rejected by `packageProblem`, or a `<version>` not matching `SEMVER_PATTERN` MUST exit `64` with `release.usage` even if the team file is missing or malformed.
   - Only after all CLI arguments pass validation is the team file loaded via `loadTeamFile(io.cwd, { file: args.values.file, checkOnly: true })`. Any file load or validation failure MUST exit `64` with `release.configuration` (reporting the file path and 1-based line number when positive).
   - Only after the team file loads cleanly is `<package>` looked up in `team.releases`; if absent, the command MUST exit `64` with `release.usage` (`<package> is not declared in the team file's releases`).
   - `--json` anywhere in `argv` except as the option value following `--file` (`jsonRequested(argv)`) MUST format even an exit-64 failure as a `team.error` v1 JSON object.
   - (*Source:* `src/commands/release.ts` at `v0.5.0`; *proof:* `test/release/command.test.ts`.)

3. **Check statuses, compound-read completion, and precedence (`src/release/checks.ts`).**
   - Every check MUST evaluate to `{ status: 'pass' | 'missing' | 'unknown', detail: string }`. An HTTP `404` on a JSON record endpoint maps to `missing`; a `2xx` response with a valid JSON object maps to the parsed record; any other HTTP status (including `3xx`), invalid JSON, non-object JSON root, failed or timed-out request, capped read, or over-limit body on a full-document endpoint maps to `unknown`.
   - A compound check MUST execute every required read whose inputs are known rather than short-circuiting after an earlier `missing` condition, and MUST combine part outcomes with `combine(parts, passDetail)` using strict precedence `unknown` > `missing` > `pass`, returning the `detail` of the first `unknown` part (or, if none, the first `missing` part).
   - A downstream read whose required input is unavailable because an upstream read resolved to `missing` is not required and MUST NOT be requested; a downstream read whose input is unavailable because an upstream read resolved to `unknown` resolves to `unknown`.
   - Overall command exit code MUST be `0` (`release.passed`) when every configured check is `pass`, `2` (`release.unknown`) when at least one configured check is `unknown`, and `1` (`release.missing`) otherwise.
   - (*Source:* `src/release/checks.ts`, `src/commands/release.ts` at `v0.5.0`; *proof:* `test/release/checks.test.ts`, `test/release/records.test.ts`, `test/release/command.test.ts`.)

4. **The four base checks (`npm`, `tag`, `github`, `changelog`) and the `dist-tags` warning (`src/release/checks.ts`).**
   - **`npm` check (`npmCheck`):**
     - Reads `https://registry.npmjs.org/<encodeSegment(package)>/<encodeSegment(version)>`.
     - `404` -> `missing` (`"npm has no <package>@<version>"`); unreadable/non-2xx/non-object -> `unknown` (`"the npm record could not be read"`); `name !== <package>` or `version !== <version>` -> `unknown` (`"the npm record is not for this package and version"`); `dist === undefined` -> `missing` (`"the npm record has no dist"`); non-object `dist` -> `unknown` (`"the npm record's dist is not an object"`).
     - Inspects both `dist.shasum` and `dist.integrity` before deciding (`unknown` beats `missing`): `undefined` -> `missing` (`"the npm record has no dist.<key>"`); non-string -> `unknown` (`"dist.<key> is not a string"`); `""` -> `missing` (`"the npm record has an empty dist.<key>"`).
     - When `trusted_publishing` is `true`, also reads `https://registry.npmjs.org/-/npm/v1/attestations/<encodeSegment(package + "@" + version)>` even if the version part was `missing` or `unknown`: `404` or an `attestations` array without an object having `predicateType === "https://slsa.dev/provenance/v1"` -> `missing` (`"npm shows no provenance attestation for this version"`); unreadable/non-2xx -> `unknown` (`"the attestation response could not be read"`); non-array `attestations` -> `unknown` (`"the attestation response has no attestations list"`).
     - Pass detail: `"exact version, checksums, and provenance found"` when `trusted_publishing` is `true`, else `"exact version and checksums found"`.
   - **`dist-tags` warning (`staleNextWarning`):**
     - Reads `https://registry.npmjs.org/-/package/<encodeSegment(package)>/dist-tags`.
     - Emits `"npm's next dist-tag points at <next>, older than latest <latest>: run npm dist-tag add <package>@<latest> next"` if and only if the read succeeds with a JSON object whose `next` and `latest` fields are valid SemVer 2.0.0 strings and `compareVersions(next, latest) < 0`. Any failed, capped, missing, or non-SemVer read produces `undefined` and never alters any check status or exit code.
   - **Shared repository read (`readRepo`):**
     - Reads `https://api.github.com/repos/<encodeSegment(owner)>/<encodeSegment(repo)>` once. `404` -> `missing` (`"GitHub has no repository <owner>/<repo>"`); unreadable or missing/empty string `default_branch` -> `unknown` (`"the repository could not be read"`). Shared by `tag`, `changelog`, and `activity`.
   - **`tag` check (`tagCheck`):**
     - Reads `.../git/ref/tags/v<encodeSegment(version)>`. `404` -> `missing` (`"GitHub has no tag v<version>"`); unreadable or malformed `object.{type,sha}` (`SHA_PATTERN = /^[0-9a-f]{40}$/`) -> `unknown` (`"the tag could not be read"`).
     - While `target.type === "tag"`, dereferences `.../git/tags/<target.sha>` through at most `4` tag objects (`for (let i = 0; i < 4 && target.type === 'tag'; i++)`): `404` -> `missing` (`"GitHub has no tag object <sha>"`); unreadable or malformed `object` -> `unknown` (`"a tag object could not be read"`); if `target.type === "tag"` after `4` tag-object dereferences, fails with `unknown` (`"the tag chain needs a fifth tag object"`). Any `target.type` other than `"commit"` or `"tag"` -> `missing` (`"the tag does not resolve to a commit"`).
     - When both a resolved commit SHA and `readRepo`'s `default_branch` are known, reads `.../compare/<encodeSegment(commit)>...<encodeSegment(default_branch)>`: `404` -> `missing` (`"GitHub has no compare of the tag and the default branch"`); top-level `status` of `"identical"` or `"ahead"` -> `pass`; `"behind"` or `"diverged"` -> `missing` (`"tag commit is not an ancestor of the default branch"`); any other or unreadable status -> `unknown` (`"the compare could not be read"`). When the compare response is HTTP `2xx` and exceeds `BODY_LIMIT` (`reply.kind === 'over-limit'`), `statusInHead(reply.prefix)` extracts the top-level `"status"` string from the 1 MiB UTF-8 prefix if complete before the cutoff.
     - Combines the tag-chain part, the compare part (when both inputs were known), and any non-`ok` `readRepo` outcome; pass detail is `"tag resolves to a commit on the default branch"`.
   - **`github` check (`githubCheck`):**
     - Reads `.../releases/tags/v<encodeSegment(version)>`. `404` -> `missing` (`"GitHub has no release for v<version>"`); unreadable or non-boolean `draft` / `prerelease` -> `unknown` (`"the release could not be read"`); `draft === true` -> `missing` (`"the release is a draft"`); `prerelease !== hasPrerelease(version)` -> `missing` (`"the release is not marked as a prerelease"` when `hasPrerelease(version)` is `true`, else `"the release is marked as a prerelease"`). Pass detail: `"published release matches SemVer channel"`.
   - **`changelog` check (`changelogCheck`):**
     - If `readRepo` is `missing` or `unknown`, returns that status and detail without requesting `CHANGELOG.md`.
     - Otherwise reads `.../contents/CHANGELOG.md?ref=<encodeSegment(default_branch)>`. `404` -> `missing` (`"the default branch has no CHANGELOG.md"`); unreadable or invalid base64/UTF-8 `file` payload (`decodeContents`) -> `unknown` (`"the changelog could not be read"`).
     - Scans lines (stripping optional `\r` before `\n`) for `^## (?:\[<escaped-version>\]|<escaped-version>) - ([0-9]{4})-([0-9]{2})-([0-9]{2})[ \t]*$`. If a matching line has a valid calendar date (`1970 <= year <= 9999` and valid month/day including leap-year rules), returns `pass` (`"changelog entry has a valid release date"`) and `releaseAt = Date.UTC(year, month - 1, day)`. Otherwise, if any line matched the heading prefix `^## (?:\[<escaped-version>\]|<escaped-version>) - `, returns `missing` (`"the changelog entry for <version> has an invalid date"`), else `missing` (`"CHANGELOG.md has no entry for <version>"`).
   - (*Source:* `src/release/checks.ts` at `v0.5.0`; *proof:* `test/release/checks.test.ts`.)

5. **The optional `linear` and `activity` checks (`src/release/checks.ts`, `src/release/keychain.ts`).**
   - **`linear` check (`linearCheck`):**
     - Runs if and only if the declaration includes `linear_project` and `linear_keychain_service`.
     - Evaluates non-secret prerequisites in fixed order before touching the Keychain:
       1. If `changelog.outcome.status === 'unknown'`, returns `unknown` (`"release date could not be read"`).
       2. If `changelog.outcome.status === 'missing'`, returns `missing` (`"release date is missing from changelog"`).
       3. If `!reader.canRead()`, returns `unknown` (`"Linear record could not be read"`).
     - Reads the API key at most once via `keychainReader` (`/usr/bin/security find-generic-password -s <service> -w`): requires `process.platform === 'darwin'`, `io.stdinIsTTY === true`, subprocess exit `status === 0` with `signal === null` within `KEYCHAIN_TIMEOUT_MS = 5000` ms and `STDOUT_CAP = 4096` bytes, passes stdout to `keyOf` which strips one trailing `\n` (LF) only (a trailing `\r\n` leaves `\r`, which fails the printable ASCII check), and requires a non-empty string where every remaining character is printable non-whitespace ASCII (`0x21..0x7e`). Any failure returns `unknown` (`"Keychain access was unavailable"`).
     - Sends one `POST` to `https://api.linear.app/graphql` with `RELEASE_RECORDS_QUERY` and `variables: { projectId: config.project, first: 100 }`. Any non-`2xx` reply, invalid JSON, top-level `"errors"` property, or non-object `data` returns `unknown` (`"Linear record could not be read"`).
     - In `linearRecord`, first checks `data.project`: if missing, non-object, or `project.id !== config.project`, returns `unknown` (`"Linear record is incomplete"`) immediately. When the project row is well-formed, evaluates the remaining three conditions without short-circuiting in table order (`unknown` > `missing` > `pass`, keeping the first condition's `detail`):
       1. `project.archivedAt`: `null` is active; a valid RFC 3339 timestamp string (`timestampOf`) -> `missing` (`"configured Linear project is archived"`); any other value -> `unknown` (`"Linear record is incomplete"`).
       2. `project.projectMilestones`: requires `nodes` array and `pageInfo.hasNextPage === false`, with string `name` and `status` on every node (else `unknown` `"Linear record is incomplete"`). Counts nodes with `name === version`: `0` -> `missing` (`"no matching Linear milestone found"`); `> 1` -> `unknown` (`"multiple matching Linear milestones found"`); `1` with `status !== 'done'` -> `missing` (`"matching Linear milestone is incomplete"`).
       3. `project.projectUpdates`: requires `nodes` array and `pageInfo.hasNextPage === false`, where every node has a valid RFC 3339 `createdAt` string and `archivedAt` either `null` or a valid RFC 3339 string (else `unknown` `"Linear record is incomplete"`). Counts nodes with `archivedAt === null` and `timestampOf(createdAt) >= releaseAt`: `0` -> `missing` (`"no qualifying Linear status update found"`).
     - When no condition fails, returns `pass` (`"Linear milestone is complete and a qualifying status update exists"`).
   - **`activity` check (`activityCheck`):**
     - Runs if and only if the declaration includes `activity_file` and `activity_marker`.
     - If `readRepo` is `missing`, returns `missing` (`"public activity marker is missing"`); if `readRepo` is `unknown`, returns `unknown` (`"public activity file could not be read"`).
     - Reads `.../contents/<path>?ref=<encodeSegment(default_branch)>` where `<path>` encodes each `/` segment of `activity_file` with `encodeSegment`. `404` -> `missing` (`"public activity marker is missing"`); unreadable or invalid base64/UTF-8 `file` content -> `unknown` (`"public activity file could not be read"`).
     - Replaces `<package>` with `name` and `<version>` with `version` in `activity_marker`, splits the decoded file on `/\r\n|\n/` (removing a single trailing `""` element left by a final newline, while preserving all spaces and tabs), and counts lines equal (`===`) to the expanded marker: `0` -> `missing` (`"public activity marker is missing"`); `> 1` -> `unknown` (`"multiple public activity markers found"`); `1` -> `pass` (`"public activity marker found"`).
   - (*Source:* `src/release/checks.ts`, `src/release/keychain.ts` at `v0.5.0`; *proof:* `test/release/records.test.ts`.)

6. **Bounded network and secret-handling invariants (`src/release/http.ts`, `src/release/keychain.ts`, `src/release/checks.ts`).**
   - Every HTTP request MUST target only the allowlisted origins (`https://registry.npmjs.org`, `https://api.github.com`, `https://api.linear.app/graphql`), encode dynamic path and query segments with `encodeSegment` (RFC 3986 unreserved `[A-Za-z0-9._~-]` or uppercase `%HH`), and set `redirect: 'manual'` so redirects are never followed and credentials never cross origins.
   - Each HTTP attempt MUST enforce `TIMEOUT_MS = 5000` ms and a decoded UTF-8 body cap of `BODY_LIMIT = 1_048_576` bytes (`1 MiB`).
   - Only timeouts, transport errors, and HTTP statuses `408`, `429`, and `500`–`599` are retried, at most once per endpoint read (`retried(attempt)`).
   - One command invocation MUST NOT exceed `READ_CAP = 14` endpoint reads or `ATTEMPT_CAP = 28` HTTP attempts across all checks and warnings.
   - The command MUST NOT read `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `LINEAR_API_KEY`, `.npmrc`, `gh` configuration, or git credentials, and MUST NOT write any Keychain secret byte to stdout, stderr, JSON output, error messages, or the filesystem.
   - (*Source:* `src/release/http.ts`, `src/release/keychain.ts`, `src/release/checks.ts` at `v0.5.0`; *proof:* `test/release/checks.test.ts`, `test/release/records.test.ts`.)

7. **Release-date changelog check script (`scripts/check-release-date.ts`).**
   - `bun scripts/check-release-date.ts <version>` MUST require a non-empty `<version>` positional argument in `process.argv[2]` (exiting `2` with `Usage: bun scripts/check-release-date.ts <version>` when missing) and read `CHANGELOG.md` from `process.cwd()` (exiting `2` when `CHANGELOG.md` cannot be read). It MUST scan lines of `CHANGELOG.md` for the bracketed heading `^## \[<escaped-version>\] - ([0-9]{4})-([0-9]{2})-([0-9]{2})[ \t]*$` (unlike `team release check`'s `changelogCheck`, unbracketed `## <version> - YYYY-MM-DD` headings are not matched) and verify that the captured date is a real calendar date (UTC year/month/day round-trip), exiting `0` on match and `1` when the bracketed section is missing or its date is a placeholder (`YYYY-MM-DD`) or invalid calendar date.
   - (*Source:* `scripts/check-release-date.ts`, `.github/workflows/release.yml` at `v0.5.0`; *proof:* `test/scripts/check-release-date.test.ts`, `test/release-workflow.test.ts`.)

## 6. Registries

### [registries/exit-codes.md](registries/exit-codes.md)

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `release.passed` | `every check passed` | 0.5.0 | `contract/exit-codes.json` | `team release check <pkg@ver>` (exit 0) |
| `release.missing` | `a check is missing` | 0.5.0 | `contract/exit-codes.json` | `team release check <pkg@ver>` (exit 1) |
| `release.unknown` | `a check is unknown` | 0.5.0 | `contract/exit-codes.json` | `team release check <pkg@ver>` (exit 2) |
| `release.configuration` | `the team file can't be read` | 0.5.0 | `contract/exit-codes.json` | `team release check <pkg@ver>` (exit 64) |
| `release.usage` | `the invocation can't be read` | 0.5.0 | `contract/exit-codes.json` | `team release check` (exit 64) |

### [registries/operations.md](registries/operations.md)

`team release check` is a stateless, read-only verification command over public registries (and an optional owner-interactive macOS Keychain read) and has no capability or operation gate row in `src/permissions/map.ts` at `v0.5.0`.

## 7. Open points

1. **Linear pagination beyond 100 records:** `RELEASE_RECORDS_QUERY` requests `first: 100` for `projectMilestones` and `projectUpdates` (`includeArchived: true`) and reports `unknown` (`Linear record is incomplete`) when `pageInfo.hasNextPage` is not `false`; whether cursor pagination or server-side filtering should be added when a project exceeds 100 milestones or status updates is open.
2. **Cross-platform credential store for Linear checks:** `keychainReader` requires macOS (`/usr/bin/security`) and an interactive terminal (`stdinIsTTY === true`), returning `unknown` (`Keychain access was unavailable`) on other platforms or headless sessions; whether a cross-platform credential helper is needed remains open.

## Revision log

- **Draft** (2026-10-19): lifted from archived internal RFCs `0004-releases.md` and `0005-release-records.md` and read against `src/commands/release.ts`, `src/file/sections/releases.ts`, `src/release/grammar.ts`, `src/release/http.ts`, `src/release/keychain.ts`, `src/release/checks.ts`, `schema/release.schema.json`, and `scripts/check-release-date.ts` at `v0.5.0 (52db9b75)`.
- **Review fold** (2026-10-19): aligned §3.4 Linear request headers, §4.3 and §5 Rule 7 `scripts/check-release-date.ts` positional `<version>` contract, §5 Rule 4 tag-chain 4-hop limit and exact detail strings, §5 Rule 5 `KEYCHAIN_TIMEOUT_MS` / LF-only `keyOf` / `linearRecord` project guard, and §6 `contract/exit-codes.json` meanings with `v0.5.0 (52db9b75)`.
