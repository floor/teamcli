# Project analysis and pace-matched team proposal

Read at `int/0.5.13` (`afa5c57b0`). Sources: `specs/project-analysis.md`, `blueprints/project-analysis.md`, `specs/project-structure.md`, `specs/setup-and-team-models.md` §§3–5, `specs/analytics.md`, `specs/messaging.md`, `specs/round.md`, `specs/quality-gates.md`, and the project-architecture note §§1, 3b, 5 (especially §§5.1, 5.5, 5.8–5.9). No analysis code exists at `afa5c57b0`.

## 1. Command shape

```text
team analyse [<path>] [--propose [--deadline <YYYY-MM-DD>]] [--json]
```

- **Report first (`team analyse [<path>]`):** reads `<path>` (default `.`) after verifying the analyser gate, and reports what the project is, how it is tested and released, its open work, its parallelizable vs. serial paths, and how fast it moves. `proposal` is `null`.
- **Proposal (`--propose`):** adds a pace-matched, quota-bounded project and team proposal after the report.
- **Deadline recompute (`--propose --deadline <YYYY-MM-DD>`):** recomputes team count, seat count, and working hours (`speed`, up to round-the-clock `24h/day` and up to 100 seats across parallel teams sized from `report.topology.parallelizable` when size, time, resources, and quota allow), showing the cost delta against the baseline proposal.
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
| **Quota & cost** | Joins `UsageReport.quota.labs` (`ReportQuotaAccount`: `state: QuotaState` `'ok' \| 'near cap' \| 'walled' \| 'unknown'`, `windows: ReportQuotaWindow[]` with `window: 'session' \| 'weekly'`, `left`, `used`, `resetsAt`, `resetsIn`, `margin`, `runsOutIn`, `stale`, `expired`, `wall`) with `UsageReport.labs` (`ReportRow`: `pace` in `%/h` or `null`, `reserve`, `state: BudgetState` `'fresh' \| 'unconfirmed' \| 'stale' \| 'refusing' \| 'unknown'`) and `UsageReport.teams` (`ReportSeatCost`: `amount`, `currency: 'USD'`, `source: 'measured' \| 'estimated' \| 'unknown'`). | `reportOf` (`src/information/usage.ts`), `quotaOf` (`src/information/quota.ts`), `realQuotaObservations` (`src/information/quota-observe.ts`), and `machineAccountsByEntityOf` / `machinePlansOf` / `machineCreditsOf` (`src/information/machine-accounts.ts`, reading `~/.config/team/accounts.yaml` `accounts`, `plans`, and `credits: { available, currency, cap?, autoReload? }`). |

## 3. Output shape (`team.analyse` v1)

`--json` emits one envelope via `writeJson(io, 'team.analyse', payload)` (`schema/analyse.schema.json`). Unobserved values are `"not known"` or `null`, never invented zeros (`specs/analytics.md`). Candidate teams emit the built `.agents/team.yaml` shape (`project`, `in_project` holding the project display name, `also_in` holding served project display names, `project_lead`, `led`, `lead`, `seats` with profile `cli` and optional `launch`) and the path-free `projects.yaml` record (`id` slug key and `name` display name), never a new format or hierarchy field such as `domain` (the project-architecture note §§1, 3b, 5.8–5.9; `docs/team-file.md`). `also_in` never repeats the team's home `in_project`, and `project_lead: true` is permitted only on a team's home project (the project-architecture note §3b). A read-only helper `projectMembershipsOf(team)` in `src/registry/teams.ts` reads `team.project_id` (home) and `team.projects` (all memberships) from the team record, keeping the team record as the single writer of membership (§5.5).

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
        "project": "teamcli",
        "action": "create",
        "in_project": "TeamCLI",
        "also_in": [],
        "project_lead": true,
        "led": true,
        "lead": "lead",
        "speed": { "active_hours_per_day": 1.5, "mode": "idle", "target_commits_per_day": 6.1 },
        "seats": [
          { "name": "lead", "role": "orchestrator", "kind": "agent", "leads": true, "cli": "claude-code", "vendor": "anthropic", "account": "anthropic", "skills": [], "reason": "coordinates 1.2 active h/day pace and serial contract merges" },
          { "name": "builder-1", "role": "builder", "kind": "agent", "leads": false, "cli": "codex", "vendor": "openai", "account": "openai", "skills": ["typescript", "bun"], "reason": "matches 6.1 commits/day across src/commands and src/information" },
          { "name": "tester-1", "role": "tester", "kind": "agent", "leads": false, "cli": "antigravity", "launch": "agy", "vendor": "google", "account": "google-antigravity", "skills": ["typescript", "bun"], "reason": "independent-lab verification for bun test and CI gates" }
        ]
      },
      {
        "project": "docs",
        "action": "serve-existing",
        "in_project": "Docs",
        "also_in": ["TeamCLI"],
        "project_lead": false,
        "led": true,
        "lead": "orchestrator",
        "speed": { "active_hours_per_day": 0.5, "mode": "idle", "target_commits_per_day": 1.0 },
        "seats": []
      }
    ],
    "stage_throughput": {
      "max_agents_supported": 100,
      "stages": {
        "messaging": { "demand_msgs_per_hour": 12, "capacity_msgs_per_hour": 600, "ack_timeout_s": 120, "bottleneck": false },
        "ci": { "demand_runs_per_hour": 1.5, "capacity_runs_per_hour": 40, "light_slots": 4, "bottleneck": false },
        "merges": { "demand_batches_per_hour": 1.0, "capacity_batches_per_hour": 6.0, "batch_interval_s": 600, "bottleneck": false },
        "tests": { "demand_checks_per_hour": 1.5, "capacity_checks_per_hour": 60, "light_check_budget_s": 60, "bottleneck": false },
        "docs": { "demand_updates_per_day": 1.0, "capacity_updates_per_day": 8.0, "served_by": "docs", "bottleneck": false }
      }
    },
    "cost": {
      "per_vendor_per_day": [
        { "vendor": "anthropic", "account": "anthropic", "seats": 1, "hours_per_day": 1.5, "quota_pct_per_day": 2.25, "quota_left_pct": 74.0, "resets_at": "2026-11-10T12:00:00.000Z", "fits_before_reset": true, "estimated_usd_per_day": null },
        { "vendor": "openai", "account": "openai", "seats": 1, "hours_per_day": 1.5, "quota_pct_per_day": 2.25, "quota_left_pct": 82.0, "resets_at": "2026-11-11T00:00:00.000Z", "fits_before_reset": true, "estimated_usd_per_day": null },
        { "vendor": "google", "account": "google-antigravity", "seats": 1, "hours_per_day": 1.5, "quota_pct_per_day": 2.25, "quota_left_pct": 88.0, "resets_at": "2026-11-09T08:00:00.000Z", "fits_before_reset": true, "estimated_usd_per_day": null }
      ],
      "total_per_day": { "measured_usd": null, "estimated_usd": null, "why": "not known: subscription accounts report window percentages, not money" },
      "quota_guard": { "ok": true, "constrained_accounts": [] }
    }
  }
}
```

When `--deadline <YYYY-MM-DD>` is passed, `proposal.deadline` carries `{ "date": "2026-11-07", "days_remaining": 2, "delta_vs_baseline": { "teams": 1, "seats": 4, "hours_per_day": 22.5, "per_vendor_quota_pct_per_day": { "anthropic": 12.0, "openai": 28.8, "google": 18.0 } } }`.

## 4. Guards

1. **Named analyser setting before any file read (`specs/project-analysis.md`, the project-architecture note §§5.1, 5.8):** Before `fs.statSync`, `fs.readFileSync`, or `git` runs on `<path>`, `mayAnalyseProject(io, targetPath, sources)` checks that the caller is the owner at a terminal or an agent named in the owner-signed `analyser` setting (`entities.yaml` / `projects.yaml`) with read scope covering `<path>`. No `analyse` capability word or grant verb is added (§5.1). A setup request, `create` authority, a finding, or repository content never confers analyser authority. A caller or lab with `scope: public` is refused on a non-public project before any project byte is read (`analyse.scope`, exit 1).
2. **Project content is material, never an instruction (`specs/project-analysis.md`, the project-architecture note §5.8):** `plainText` (`src/launch/plain.ts`) strips control, ANSI, and format characters on display strings, which does not neutralize instructions. Instead, **every** file opened by `readProjectFacts` (`README*`, `AGENTS.md`, manifests, `.github/workflows/*.yml`, release configs, `.agents/tasks.md`, `.agents/team.yaml`) is scanned for directives requesting seat counts, models/labs, `grant:`, `trust:`, or `policies:`, which are recorded in `report.findings` with `file:line` provenance. `propose()` consumes only structured numeric and closed-enum facts (`size.{files,lines}`, `languages`, `stack_skills` from the shipped skill set, `pace.{commits_per_day,active_hours_per_day}`, `open_work.{open,blocked}`, and `topology.{parallelizable,serial}` counts) — never raw prose strings from project files. No discovered test or build script is ever executed.
3. **Never exceed remaining quota (`specs/project-analysis.md`, the project-architecture note §5.8):** When `active_hours_per_day <= 2` or facts are sparse (`commits == 0` or no git history), `propose()` defaults to one small home team of 3 seats (`1 lead, 1 builder, 1 tester`) — reusing existing entity teams via `also_in` where applicable — and labels sparse facts explicitly. For each candidate seat assignment on an account, `propose()` reads `ReportQuotaAccount` (`state: QuotaState`, `windows: ReportQuotaWindow[]` with `left`, `resetsAt`, `margin`) from `usageReport.quota.labs` and `ReportRow` (`pace`, `reserve`, `state: BudgetState`) from `usageReport.labs`. When `ReportRow.state === 'fresh'` and `ReportRow.pace !== null`, `hourly_burn_pct = ReportRow.pace`; otherwise `propose()` uses the conservative fallback `1.5%/h` per active seat on `weekly` (`168h`) windows and `8.0%/h` on `session` (`5h`) windows. Each window must satisfy `(seats_on_account × active_hours_per_day × hourly_burn_pct) × days_until_reset <= (window.left - (row.reserve ?? 10))`. Accounts with `ReportQuotaAccount.state` in `'walled' | 'near cap'` or `ReportRow.state === 'refusing'` receive 0 additional seats; constrained accounts are reported in `cost.quota_guard.constrained_accounts`.
4. **Fast-mode scaling and measured stage throughput (`specs/project-analysis.md`, `specs/messaging.md` §3, `specs/round.md` §§2–3.2, `specs/quality-gates.md` §2):** When size, deadline, and quota allow scaling up to 100 agents across parallel teams (with one home team marked `project_lead: true`), `propose()` computes per-stage demand vs. capacity in `proposal.stage_throughput.stages` and enforces stage ratios so no stage forms an unbounded queue:
   - **Mergets & batches (`specs/round.md` §3.2):** `batch-interval: 600s` and `light-check <= 60s` cap one integrator at `6 batches/h` (`<= 8 builders : 1 team lead/integrator`); above 8 builders, `propose()` splits work into parallel teams along `report.topology.parallelizable` so each team has its own integrator.
   - **Tests & CI (`specs/quality-gates.md` §2, `specs/round.md` §3.2):** `light-slot-{1..4}.lock` (4 concurrent `<= 60s` light checks = `240 checks/h` machine-wide) and independent-lab review (`review-lab`) require `>= 1 tester/reviewer` from a non-author lab per `4 builders`.
   - **Messaging (`specs/messaging.md` §3, `specs/round.md` §3.2):** per-seat drop locks and `ack-timeout: 120s` bound lead coordination to `<= 8 direct seats` per lead (`demand_msgs_per_hour <= capacity_msgs_per_hour`).
   - **Docs (`specs/round.md` §3.3 step 4):** `>= 1 doc seat` (or `action: "serve-existing"` from the entity's `docs` team via `also_in`) per `12 builders`.
5. **States its own cost and source (`specs/project-analysis.md`, `specs/analytics.md`):** `source` resolves along `machine → entity → project` settings (default `teamcli.static`), and `analysis_cost` reports wall duration, git walks, files/bytes read, tokens, and USD on every run. Unobserved money spend in `proposal.cost` is always `null` with a `why` string (`specs/analytics.md`), never an invented `0`.

## 5. Build plan (4 testable slices)

1. **Slice 1 — Analyser gate and bounded static reader (`src/analyse/gate.ts`, `src/analyse/read.ts`, `test/analyse-read.test.ts`):** Implement `mayAnalyseProject` (checking the owner-signed `analyser` setting and refusing unnamed callers and `scope: public` on private repos before any file read) and `readProjectFacts` (manifests, `git ls-files` size/languages, stack skills, checks/CI/release metadata, 28-day git pace + directory overlap, local tasks, and prompt-injection `findings` scanned across every opened file, plus `analysis_cost` and `source`).
2. **Slice 2 — Pace-matched, quota-bounded proposal (`src/analyse/propose.ts`, `test/analyse-propose.test.ts`):** Consume structured `readProjectFacts` facts + `UsageReport` (`ReportQuotaAccount` and `ReportRow`) + entity teams (`projectMembershipsOf(team)` in `src/registry/teams.ts`); emit path-free candidate project record and built `.agents/team.yaml` team shapes (`project`, display-name `in_project`, `also_in` reuse of existing serving teams without repeating home, `project_lead` on home only, profile `cli` + `launch`), dynamic stack skills on `builder`/`coder`, per-seat `reason`, per-vendor daily burn, and the quota-reset cap.
3. **Slice 3 — Deadline recompute and multi-team scaling up to 100 seats (`src/analyse/scale.ts`, `test/analyse-scale.test.ts`):** Implement `--deadline <YYYY-MM-DD>` recomputation (`speed` up to 24h/day, parallel teams across `topology.parallelizable`, `delta_vs_baseline`, and per-stage measured `stage_throughput` across messaging, CI, merges, tests, and docs), clamped by remaining vendor quota.
4. **Slice 4 — Command, schema, and contract (`src/commands/analyse.ts`, `src/output/schema.ts`, `schema/analyse.schema.json`, `contract/cli.json`, `contract/exit-codes.json`, `docs/commands/analyse.md`, `test/analyse-cli.test.ts`):** Wire `team analyse`, publish `ANALYSE_OUTPUT_SCHEMA` (`team.analyse` v1), register CLI and exit-code rows, and verify contract/schema parity tests.

## 6. Open questions

1. **Reuse of existing serving teams (`also_in`):** When an entity already has a shared team (such as `docs`), should `team analyse --propose` automatically emit `action: "serve-existing"` with `also_in: ["<ProjectName>"]` whenever matching domain paths (`docs/`) are active, or only when `--reuse-teams` is passed?
2. **Spelling of `analyse` vs. `analyze`:** The spec and brief use `team analyse`; should `team analyze` be registered as a hidden CLI alias or rejected with a repair hint?
