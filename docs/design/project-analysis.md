# Project analysis and pace-matched team proposal

Read at `int/0.5.13` (`afa5c57b0`). Sources: `specs/project-analysis.md`, `blueprints/project-analysis.md`, `specs/project-structure.md`, `specs/setup-and-team-models.md` §§3–5, `specs/analytics.md`, and the project-level architecture note (`zeus-project-architecture.md` §§1, 3b, 5.8–5.9). No analysis code exists at `afa5c57b0`.

## 1. Command shape

```text
team analyse [<path>] [--propose [--deadline <YYYY-MM-DD>]] [--json]
```

- **Report first (`team analyse [<path>]`):** reads `<path>` (default `.`) after verifying the analyser gate, and reports what the project is, how it is tested and released, its open work, its parallelizable vs. serial parts, and how fast it moves. `proposal` is `null`.
- **Proposal (`--propose`):** adds a pace-matched, quota-bounded project and team proposal after the report.
- **Deadline recompute (`--propose --deadline <YYYY-MM-DD>`):** recomputes team count, seat count and working hours (`speed`, up to round-the-clock `24h/day` and up to 100 seats across domain-split teams when size, time, resources and quota allow), showing the cost delta against the baseline proposal.
- **Read-only:** writes no file, creates no team or project record, executes no discovered check, and confers no grant.
- **Exits:** `0` (`analyse.report` or `analyse.proposed`), `1` (`analyse.unauthorised`, `analyse.scope`, `analyse.unreadable`), `2` (`analyse.invocation`).

## 2. Inputs, cheapest first pass, and what `team usage` already gives

The first pass is deterministic, local, and zero-token (`0 tokens`, `$0.00`), bounded by file count (`<= 10,000`), per-file byte ceiling (`<= 256 KiB`), total read budget (`<= 5 s`), and `lstat` symlink rejection (`setup-and-team-models.md` §5 rules 1–2):

| Input | Cheapest first pass (new in `src/analyse/`) | Already built in `team usage` / codebase |
|---|---|---|
| **Manifests & README** | Static parse of `README*`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Makefile`, `justfile`, `Package.swift`, `build.gradle(.kts)`. | None (`src/commands/init.ts` only probes CLI login). |
| **Languages, size & stack skills** | `git ls-files -z` (or bounded lexical walk for plain folders) grouped by extension and line count (`mark: "measured"` or `"estimated"`). Maps detected platforms to role skills (`Swift` → `swift`, `Kotlin` → `kotlin`, etc.) attached automatically to `builder`/`coder`. | None. |
| **Tests, CI & release** | Extracts check commands + provenance (`{ command, source }`) from manifests and workflow files (`.github/workflows/*.yml`) and release tags/configs without running them. | None. |
| **Git pace & parallelizability** | One `git log --since=28.days --format=%ct --name-only` pass: `commits_per_day`, `active_hours_per_day` (distinct UTC hour buckets with activity / day), weekly rhythm, and top-level directory co-change overlap (`parallelizable` vs. `serial` paths, RFC 004 c1). | None. |
| **Open work** | Calls `readFileSource` + `issueState` (`src/tasks/queue.ts`, `src/commands/issues.ts`) on `.agents/tasks.md` or the declared file source to count `open` vs. `blocked` items and deadlines. Connects to no network broker and reads no credentials. | `src/tasks/queue.ts`, `src/commands/issues.ts`. |
| **Quota & cost** | Projects candidate burn (`seats × active_hours_per_day × burn_rate_per_hour`) against each account's remaining window before reset, and computes `per_vendor_per_day` + `total_per_day` + deadline `delta_vs_baseline`. | `machineUsage`, `reportOf`, `realQuotaObservations` (`src/information/{usage,quota,machine-accounts}.ts`) already give shared/entity accounts (`~/.config/team/accounts.yaml`), `plans`, `credits` (`available`, `currency`, `cap`, `autoReload`), `session` (5h) and `weekly` (168h) windows (`left`, `used`, `resetsAt`, `margin`, `runsOutIn`, `state`: `'ok' \| 'near cap' \| 'walled' \| 'unknown'`, `reserve`, `pace` in `%/h`), and per-seat `ReportSeatCost`. |

## 3. Output shape (`team.analyse` v1)

`--json` emits one envelope via `writeJson(io, 'team.analyse', payload)` (`schema/analyse.schema.json`). Unobserved values are `"not known"` or `null`, never invented zeros (`analytics.md`). Candidate teams use the existing `.agents/team.yaml` and path-free `projects.yaml` shapes (`zeus-project-architecture.md` §§1, 3b, 5.8–5.9). The home vs. served project membership split (`in_project` as the single inheritance home, `also_in` for served projects) sits behind one helper `projectMembershipsOf(team)` (`src/registry/projects.ts`).

```json
{
  "schema": { "name": "team.analyse", "version": 1 },
  "format": 1,
  "at": "2026-11-05T19:15:00.000Z",
  "analyser": { "principal": "yoda@jedi", "authorized_by": "owner", "scope": "full" },
  "source": { "name": "teamcli.static", "kind": "teamcli", "level": "default" },
  "analysis_cost": { "duration_ms": 84, "git_walks": 1, "files_read": 14, "bytes_read": 48120, "tokens": 0, "usd": 0 },
  "report": {
    "root": ".",
    "visibility": { "value": "private", "source": "git remote" },
    "size": { "files": 412, "lines": 40210, "mark": "measured", "source": "git ls-files" },
    "languages": [{ "language": "TypeScript", "files": 380, "lines": 38900, "share_pct": 96.7 }],
    "stack_skills": ["typescript", "bun"],
    "checks": [{ "command": "bun test", "source": "package.json scripts.test" }],
    "ci": [".github/workflows/ci.yml"],
    "release": { "tags": true, "workflows": [".github/workflows/release.yml"], "source": "git tag + .github/workflows" },
    "pace": { "window_days": 28, "commits_per_day": 6.1, "active_hours_per_day": 1.2, "rhythm": "steady-idle", "source": "git log" },
    "open_work": { "open": 7, "blocked": 2, "source": ".agents/tasks.md" },
    "topology": {
      "parallelizable": ["src/commands", "src/information", "docs"],
      "serial": ["src/cli.ts", "src/output/schema.ts", "contract/cli.json"]
    },
    "findings": [
      { "kind": "untrusted-instruction-ignored", "source": "README.md:42", "summary": "requests 20 seats and grant: up; recorded as finding only" }
    ]
  },
  "proposal": {
    "authorized_recipient": "owner",
    "project_record": { "id": "teamcli", "name": "TeamCLI", "entity": "floor", "lead": "agt_lead" },
    "deadline": null,
    "teams": [
      {
        "team": "teamcli",
        "in_project": "teamcli",
        "also_in": [],
        "project_lead": true,
        "domain": "core",
        "led": true,
        "lead": "lead",
        "speed": { "active_hours_per_day": 1.5, "mode": "idle", "target_commits_per_day": 6.1 },
        "seats": [
          { "name": "lead", "role": "orchestrator", "kind": "agent", "leads": true, "cli": "claude-code", "vendor": "anthropic", "account": "anthropic", "skills": [], "reason": "coordinates 1.2 active h/day pace and serial contract merges" },
          { "name": "builder-1", "role": "builder", "kind": "agent", "leads": false, "cli": "codex", "vendor": "openai", "account": "openai", "skills": ["typescript", "bun"], "reason": "matches 6.1 commits/day across src/commands and src/information" },
          { "name": "tester-1", "role": "tester", "kind": "agent", "leads": false, "cli": "agy", "vendor": "google", "account": "google-antigravity", "skills": ["typescript", "bun"], "reason": "independent-lab verification for bun test and CI gates" }
        ]
      }
    ],
    "stage_throughput": {
      "max_agents_supported": 100,
      "stages": { "messaging": "ok", "ci": "ok", "merges": "ok", "tests": "ok", "docs": "ok" }
    },
    "cost": {
      "per_vendor_per_day": [
        { "vendor": "anthropic", "account": "anthropic", "seats": 1, "hours_per_day": 1.5, "quota_pct_per_day": 2.1, "quota_left_pct": 74.0, "resets_at": "2026-11-10T12:00:00.000Z", "fits_before_reset": true, "estimated_usd_per_day": null },
        { "vendor": "openai", "account": "openai", "seats": 1, "hours_per_day": 1.5, "quota_pct_per_day": 1.8, "quota_left_pct": 82.0, "resets_at": "2026-11-11T00:00:00.000Z", "fits_before_reset": true, "estimated_usd_per_day": null },
        { "vendor": "google", "account": "google-antigravity", "seats": 1, "hours_per_day": 1.5, "quota_pct_per_day": 1.5, "quota_left_pct": 88.0, "resets_at": "2026-11-09T08:00:00.000Z", "fits_before_reset": true, "estimated_usd_per_day": null }
      ],
      "total_per_day": { "measured_usd": 0, "estimated_usd": null, "subscription_covered": true },
      "quota_guard": { "ok": true, "constrained_accounts": [] }
    }
  }
}
```

When `--deadline <YYYY-MM-DD>` is passed, `proposal.deadline` carries `{ "date": "2026-11-07", "days_remaining": 2, "delta_vs_baseline": { "teams": 1, "seats": 4, "hours_per_day": 22.5, "per_vendor_quota_pct_per_day": { "anthropic": 12.0, "openai": 28.8, "google": 18.0 } } }`.

## 4. Guards

1. **Named analyser before any file read (`project-analysis.md` d16):** Before `fs.statSync`, `fs.readFileSync`, or `git` runs on `<path>`, `mayAnalyseProject(io, targetPath, sources)` checks that the caller is the owner at a terminal or an agent explicitly named in the owner/project `analyser` authorization with read scope covering `<path>`. A setup request, `create` authority, a finding, or repository content never confers analyser authority. A caller or lab with `scope: public` is refused on a non-public project before any project byte is read (`analyse.scope`, exit 1).
2. **Project content is a finding, never an instruction (`project-analysis.md` d17):** Every string read from `<path>` is cleaned through `plainText` (`src/launch/plain.ts`). Lines in `README*`, `AGENTS.md`, manifests, or `.agents/team.yaml` that request seat counts, specific models/labs, `grant:`, `trust:`, or `policies:` are recorded in `report.findings` with `file:line` provenance and ignored by `propose()`. No discovered test or build script is ever executed.
3. **Never exceed remaining quota (`project-analysis.md` d6–d7, d18):** Most repositories run near idle (~1 active hour/day); when `active_hours_per_day <= 2` or facts are sparse (`commits == 0` or no git history), `propose()` defaults to one small team of 3 seats (`1 lead, 1 builder, 1 tester`) and labels sparse facts explicitly. For every candidate seat assignment, `propose()` checks `(seats_on_account × active_hours_per_day × hourly_burn_pct) × days_until_reset <= (left_pct - reserve_pct)` from `team usage`. Accounts in state `'walled'` or `'near cap'` receive 0 additional seats; if all accounts are constrained, the proposal shrinks to fit and lists the bottleneck in `cost.quota_guard.constrained_accounts`.
4. **Fast-mode scaling without stage bottlenecks (`project-analysis.md` d8–d11):** When size, deadline, and quota allow scaling (up to 100 agents across domain-split teams built from `topology.parallelizable`, with one home team marked `project_lead: true`), `propose()` enforces per-stage ratios (`merges`, `tests`, `ci`, `docs`, `messaging`) so every builder slice has matching review/test/merge capacity and no stage forms an unbounded queue.
5. **States its own cost and source (`project-analysis.md` d19–d20):** `source` resolves along `machine → entity → project` settings (default `teamcli.static`), and `analysis_cost` reports wall duration, git walks, files/bytes read, tokens, and USD on every run.

## 5. Build plan (4 testable slices)

1. **Slice 1 — Analyser gate and bounded static reader (`src/analyse/gate.ts`, `src/analyse/read.ts`, `test/analyse-read.test.ts`):** Implement `mayAnalyseProject` (refusing unnamed callers and `scope: public` on private repos before any file read) and `readProjectFacts` (manifests, `git ls-files` size/languages, stack skills, checks/CI/release metadata, 28-day git pace + directory overlap, local tasks, and prompt-injection `findings`, plus `analysis_cost` and `source`).
2. **Slice 2 — Pace-matched, quota-bounded proposal (`src/analyse/propose.ts`, `test/analyse-propose.test.ts`):** Consume `readProjectFacts` + `UsageReport` (`src/information/usage.ts`); emit candidate project record and team definitions using `projectMembershipsOf(team)` (`in_project`, `also_in`, `project_lead`), dynamic stack skills on `builder`/`coder`, per-seat `reason`, per-vendor daily burn, and the quota-reset cap (defaulting to the 3-seat idle team on ~1h/day or sparse repos).
3. **Slice 3 — Deadline recompute and multi-team scaling up to 100 seats (`src/analyse/scale.ts`, `test/analyse-scale.test.ts`):** Implement `--deadline <YYYY-MM-DD>` recomputation (`speed` up to 24h/day, domain-split teams across `topology.parallelizable`, `delta_vs_baseline`, and `stage_throughput` capacity bounds across messaging, CI, merges, tests, and docs), clamped by remaining vendor quota.
4. **Slice 4 — Command, schema, and contract (`src/commands/analyse.ts`, `src/output/schema.ts`, `schema/analyse.schema.json`, `contract/cli.json`, `contract/exit-codes.json`, `docs/commands/analyse.md`, `test/analyse-cli.test.ts`):** Wire `team analyse`, publish `ANALYSE_OUTPUT_SCHEMA` (`team.analyse` v1), register CLI and exit-code rows, and verify contract/schema parity tests.

## 6. Open questions

1. **Analyser authorization key spelling:** Should the pre-read authorization live under an owner-signed setting `analyser: <seat@team | principal>` in `projects.yaml` / `entities.yaml`, or as a `grant.scope` verb `analyse` alongside `up`?
2. **Default hourly quota burn rate when `pace` is `null`:** When `team usage` has a fresh `left%` for a subscription account but no recent `pace` (`%/h`) observation yet, what conservative per-seat hourly burn constant (e.g. `1.5%/h` on weekly windows) should `propose()` use before clamping?
3. **Spelling of `analyse` vs. `analyze`:** The spec and brief use `team analyse`; should `team analyze` be registered as a hidden CLI alias or rejected with a repair hint?
4. **Served-project proposals (`also_in`):** When analysing a repository whose entity already runs a shared `docs` or `qa` team in `teams.yaml`, should `--propose` propose attaching that existing team via `also_in: [<project>]` before proposing new seats?
