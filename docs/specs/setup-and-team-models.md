---
created: 2026-10-19
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Runtime setup; Planning project analysis; Roles and skills team models
public: not yet; staged for review and port
---

# Spec: setup and team models

## 1. Scope

This spec carries the detection, proposal, preview and team-model contracts from the archived
setup and team-model designs. Those interfaces are **proposed, not implemented at v0.5.0**:
`contract/cli.json` registers none of `detect`, `presets`, `preset`, `guide`, `start` or `create`.
The existing one-seat initializer, profile login checks and example validation are identified
separately below. Capability admission belongs to [grants](grants.md), launch to
[launch](launch.md), account readings to [accounts and gates](accounts-and-gates.md) and
[budgets](budgets.md), and the cast of particular agents to the separate casting spec.

The old mandatory approval, signed-team baseline, `START` confirmation and `--sign-only` flow
are superseded. The preview safeguards below apply to a future grant/create flow; they do not
add an approval command, require another approval after a valid grant, or make a proposal a grant.

## 2. Terms

- **Detection**: safe project metadata and profile install/version/login observations, without
  executing a discovered project check.
- **Preset / team model**: versioned role-based team data with assumptions and fit requirements;
  a team model is not a language model or a credential bundle.
- **Proposal**: an explained candidate team, with observations distinguished from choices.
- **Fit**: whether available authorized agents satisfy a model's stated requirements.
- **Preview snapshot**: the exact candidate bytes read for a preview, retained until application.
- **Create authority**: existing owner authority or a valid applicable grant, checked independently
  of the candidate file; see [grants](grants.md).

## 3. Formats

### 3.1 Proposed detection report

`team detect --json` would write one format-1 object to stdout, not a project file. Unavailable
facts are `null`, never invented defaults. Arrays of observations retain provenance; an empty
check list is not evidence that the project needs no checking. This is the archived proposed
shape, not a JSON schema shipped at the tag.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `format` | integer | yes | `1` | planned | Report version |
| `clis` | array of objects | yes | none | planned | Shipped profile observations |
| `clis[].cli`, `.binary` | string | yes | none | planned | Profile identifier and executable |
| `clis[].installed` | boolean or null | yes | null if unavailable | planned | Installation observation |
| `clis[].version` | string or null | yes | null if unavailable | planned | Observed version |
| `clis[].logged_in` | boolean or null | yes | null if unavailable | planned | Login exit-status observation, not account identity |
| `clis[].login_check` | string or null | yes | null if unavailable | planned | Shipped check used |
| `project.root` | string | yes | none | planned | Project-relative root, `.` in the example |
| `project.git` | boolean or null | yes | null if unavailable | planned | Git observation |
| `project.visibility` | object | yes | none | planned | `value` (public/private or null) and `source` |
| `project.checks` | array of objects | yes | none | planned | Each has string `command` and `source`; never bare strings |
| `project.check_search` | array of strings | yes | none | planned | Places searched, not commands executed |
| `project.ci` | array of strings | yes | none | planned | Discovered workflow paths |
| `project.team_file` | object | yes | none | planned | `present` boolean and project-relative `path`; contents unread |

Illustrative proposed report (no corresponding test fixture at the tag):

```json
{"format":1,"clis":[{"cli":"codex","binary":"codex","installed":true,"version":null,"logged_in":null,"login_check":"codex login status"}],"project":{"root":".","git":true,"visibility":{"value":null,"source":"not found"},"checks":[{"command":"npm test","source":"package.json scripts.test"}],"check_search":["package.json","Makefile","justfile","pyproject.toml","go.mod",".github/workflows"],"ci":[".github/workflows/test.yml"],"team_file":{"present":false,"path":"team config"}}}
```

### 3.2 Proposed presets and model package

`team presets --json` would print `{format, presets}`; `team preset <name> --yaml` would print
complete candidate YAML without creating or replacing a file. The package owns a versioned core
set available offline; the complete library is intended to be browsable on teamcli.io and later
open to contributions. At the tag, `examples/team.yaml` exists, but no browsable model library,
library manifest or contribution protocol is established by the command contract.

| Model information | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| When to use it and assumptions | prose | yes | none | planned | Three lines explaining applicability |
| Cost | seat count and plan assumptions | yes | none | planned | Resource implications, not an invented price |
| Lessons from actual use | prose | for a model drawn from use | none | planned | What went wrong; otherwise no claimed experience |
| Roles and counts | role-based seat data | yes | none | planned | Functions, not product names fixed as assignments |
| Fit requirements | declared constraints | yes | none | planned | For example, another lab or permission to read private material |
| Dimensions | classified values | yes | none | planned | Project kind, size, review, shape, autonomy, available resources, visibility |

These are semantic requirements; serialized field names, model versioning and the fit-result
wire format remain open. The dimensions cover code libraries, applications, websites,
documentation/books and research; small/medium/large projects; no/one/two independent reviewers;
solo, peers, coordinator/operator and several teams under an orchestrator; and differing
delegation, lab availability, remaining resources and public/private scope. The initial target
is about a dozen models covering each dimension value, not a claim of shipped inventory.

The four archived presets remain distinct:

| Preset | Role topology | Purpose |
|---|---|---|
| `solo` | one coordinator also implementing | A single agent |
| `small` | coordinator, two implementers, one reviewer | Balanced delivery |
| `review-heavy` | coordinator, one implementer, two reviewers | More review capacity |
| `docs` | coordinator, writer, reviewer | Writing and its review |

Their common proposal preferences are shared workspace, rules derived only from detected
checks, distinct implementer labs where available, and reviewers distinct from the work they
review. These are candidate assignments, not authority or an exemption from the configured
review minimum in [policies](policies.md).

### 3.3 Proposed preview and explained proposal

The preview MUST show the exact candidate's shell-quoted launch line per seat, CLI, lab,
account reference, model/version or “decided by the launcher”, trusted folders, rules, dialog
policy, delegation and resource ceilings. Strings MUST be stripped of control, escape and
bidirectional controls, quoted and bounded; audit rendering MUST use the same cleaning.
Authority MUST be shown separately from proposed file contents. A file edit supplies no grant.
Any console applying such a proposal MUST use the same preview, authority and unchanged-byte
checks; an unreadable candidate or unverifiable authority MUST leave application unavailable.
The historical console's fixed `a`/`A` approval actions are superseded, not new bindings here.

The proposal MUST explain each chosen CLI, lab, model or launcher, account, seat, folder, check
and same-lab review fallback, including unknowns and unmet requirements. It MUST distinguish
project-size judgment from discovered facts. Preview serialization, its fingerprint and the
create command's exact options are not implemented or fixed by this draft.

## 4. Commands and options

### 4.1 At the release tag

Relevant exact synopsis lines from `contract/cli.json`:

```text
team init [--restore] [--json]
team doctor [--session <name>] [--file <path>] [--login] [--json]
team check [--session <name>] [--file <path>] [--repair] [--json]
team up [--dry-run] [--serial] [--session <name>] [--file <path>] [--json]
```

`init` writes a one-seat starter, selecting the first shipped CLI whose login check returns
true; unknown is not true and does not stop the search. It falls back to `claude-code` if none
qualifies (`src/commands/init.ts`, `firstLoggedInCli` and `skeleton`). This is not project
analysis or a multi-role model selector. `doctor --login` uses shipped login probes; its fixed
runner has a 15-second timeout (`src/commands/doctor.ts`). Neither command implements the
proposed detection report. `check --repair` may repair state: it is not the read-only detection
search. Existing exits and admission stay with [exit codes](registries/exit-codes.md),
[grants](grants.md) and the command-owning specs.

### 4.2 Proposed read-only interfaces

```text
team detect [--json] [--file <path>]
team presets [--json]
team preset <name> --yaml
team guide
```

All four are intended to be ungated and write nothing. `detect --file` only observes whether
the contained team-file path is present; it does not read that file. The guide MUST tell the
proposing agent to detect first, choose a fitting preset, explain its choices, and treat
writing candidate YAML as file editing rather than authority. It MUST direct application
through the current grant/create rules and forbid credential/session reads and CLI-dialog input.
It MUST NOT instruct anyone to grant authority by typing a confirmation word for the agent.

Archived proposed result identifiers, **not registered at the tag**, are:

| Interface | Proposed result IDs | Exit status |
|---|---|---|
| detect | `detect.report`; `detect.findings`; `detect.configuration`, `detect.usage` | 0; 1 after the report for unavailable facts; 2 for configuration/invocation |
| presets | `presets.list`; `presets.usage` | 0; 2 |
| preset | `preset.printed`; `preset.unknown`, `preset.usage` | 0; 2 |
| guide | `guide.page`; `guide.usage` | 0; 2 |

Unknown preset output is `team preset: unknown preset "<name>"; run team presets`.
The detection finding says `team detect: some facts were not found; see null fields in --json output`.
Historical `start.*` and signed-baseline drift results are not contributions of this spec.

### 4.3 Proposed first run

This is an illustrative future transcript; the first four commands are absent at the tag.

1. A person asks an agent already authorized to read the project to propose a team.
2. The agent runs `team detect --json`; no discovered test or workflow runs.
3. It runs `team presets --json`, then `team preset small --yaml`; both print only.
4. It writes a candidate `team config` within its existing write authority, examines the
   project and explains its selected roles, resources, checks, scope and review compromises.
5. The principal authorized to create receives the proposal and reads the complete preview.
   A required grant is obtained through the existing owner-controlled grant mechanism; where
   a valid grant already covers creation, there is no second mandatory approval.
6. The future create flow rechecks the previewed bytes and current authority before applying
   them and launching through the Runtime. Changed bytes require a fresh preview; declining
   applies nothing. A grant does not answer a CLI trust or permission dialog.

At the tag, the available path starts with the gated initializer and live-file launch flow;
this transcript does not claim that `team create` or a preview/application transaction exists.

## 5. Rules

Rules 1–8 are proposed contracts carried from the archived designs, adapted to grants. They
have **proof: none at the tag**. Existing supporting behavior is identified in rules 9–10.

1. Detection MUST read only safe metadata and shipped install/version/login observations. It
   MUST NOT read credentials, session files, keys, quotas, account identities, shell history or
   CLI configuration. Login probes MUST discard output and use exit status; help MUST disclose
   that those probes may use a CLI's network session. Unlike `doctor`'s opt-in `--login`, the
   proposed detector always probes each shipped profile. It MUST NOT freeze the historical
   three-profile list as the current shipped set. Source: archived setup design; supporting
   runner `src/commands/doctor.ts`, profiles `src/profiles/`. Proof: none for detect at the tag.

2. Check discovery MUST search `package.json`, `Makefile`, `justfile`, `pyproject.toml`, `go.mod`
   and `.github/workflows` as metadata, record where each command came from, and MUST NOT
   execute a discovered check. The `--file` observation MUST reject a symlink or a path outside
   the lexical project root and MUST NOT read its contents. Source: archived setup design.
   Proof: none at the tag; traversal limits and parser resource bounds still need a design.

3. A preset MUST print only. The proposing agent MUST explain selections and same-lab reviews,
   MUST NOT turn chat agreement or a candidate file into authority, and MUST NOT answer a CLI
   dialog. Source: archived setup design, updated to [grants](grants.md). Proof: none at the tag.

4. A future create flow MUST render one byte snapshot, compare the current candidate bytes
   with it immediately before applying, and apply only that previewed candidate under current
   valid authority. A mismatch or decline MUST leave the proposed application, grant creation
   and launch unapplied. It MUST NOT silently widen an existing grant or restore a signed-team
   baseline as a prerequisite to every launch. Source: archived setup preview safeguard,
   adapted to the grant/create flow. Proof: none at the tag; atomic application remains open.

5. Models MUST name roles rather than fixed labs. Requirements for an agent kind, independent
   lab, private-material scope or other prerequisite MUST be explicit. Before proposing a
   model, the selector MUST report unmet requirements as “this model does not fit what you
   have”, rather than create resources or relax authority to fit it. Source: archived
   team-model design. Proof: none at the tag; requirement serialization remains open.

6. Every model MUST be loaded and validated by the tool's own checks on every model change.
   A contribution MUST carry assumptions, cost and any actual-use lessons and pass those
   checks before joining the library. Validation MUST use current create/validation rules,
   not a removed approval command. Source: archived team-model design. Proof: none for a model
   library at the tag; the existing example check is narrower (rule 10).

7. The core model set MUST be packaged for offline creation; the browsable library and later
   contributions MUST retain the same fit and validation requirements. Initial candidates are
   role-based website delivery, package delivery with independent safety review, many small
   content tasks, coordination across several teams, solo and pair shapes. They claim no
   private team's identity or measured success. Source: archived team-model design.
   Proof: none at the tag; publication and contribution mechanics remain open.

8. For `small`, eligible profiles MUST have installed binaries and a true login observation,
   ordered by shipped profile then launcher. Assign implementers to V1 and V2 when available;
   choose the first unused lab for coordinator, else V1. Choose the reviewer first outside
   both implementers and coordinator, then outside both implementers, then V2 reviewing only
   the V1 implementer, else V1 reviewing both. The proposal MUST state the actual independence,
   including any shared coordinator lab. Unknown model mappings use `model_from: launcher`;
   only detected checks seed rules. Source: archived setup design. Proof: none at the tag.

   | Available labs | Implementers | Coordinator | Reviewer and disclosed limitation |
   |---|---|---|---|
   | A, B, C, D | A, B | C | D reviews both; differs from both |
   | A, B, C | A, B | C | C reviews both; shares coordinator's lab |
   | A, B | A, B | A | B reviews A only; cannot differ from both implementers |
   | A | A, A | A | A reviews both; all reviews are same-lab |

9. The shipped initializer MUST treat an unknown login observation as unknown rather than a
   successful sign-in. Source: `src/commands/init.ts`, `firstLoggedInCli`; proof:
   `test/init.test.ts` at v0.5.0. This does not prove a preset selector.

10. The shipped example MUST remain valid under the team-file validator. Source:
    `examples/team.yaml`, `src/file/validate.ts`; proof: `test/examples.test.ts` and
    `test/readme-example.test.ts` at v0.5.0. This does not prove the proposed model library.

## 6. Registries

- [Exit codes](registries/exit-codes.md): the eleven proposed read-only result IDs in §4.2
  (`detect.*`, `presets.*`, `preset.*`, `guide.*`) are a planned contribution, not tag entries.
- [Operations](registries/operations.md) and [capabilities](registries/capabilities.md): no new
  operational capability is added by observing or proposing. Existing create and lifecycle
  admission stay with grants; exact future create-operation registration remains open.
- [Policy names](registries/policy-names.md): role-model fit does not create a policy that
  grants access, overrides visibility or lowers the required review minimum.

## 7. Open points

- The detector, print-only presets, guide and full first-run/create transaction are not built
  at v0.5.0. Profile probes and a one-seat initializer supply only supporting pieces.
- Model manifest, serialized fit constraints/results, project-size criteria and model versioning
  remain to specify. Whether a model may include a proposed autonomy/grant section remains
  open; it cannot itself confer any authority.
- Guide text needs its final command synopsis after create is designed; the historical exact
  guide and `start` transcript cannot be copied because they require the superseded approval.
- Detection needs finite file-size/search-depth/time bounds and symlink-safe metadata reading;
  preview application needs an implementation that closes the recheck/application race. No
  existing test is claimed for either guarantee.
- The library's website, contribution intake and coverage of the model dimensions remain
  unimplemented; “preset”, “model” and “example” still need one user-facing naming decision.
- The old setup design's restart/copy lifecycle and knowledge-folder details belong to the
  Runtime's safety, launch and registry specs. They are not additional setup authority here.

## Revision log

- **Draft** (2026-10-19): lifted detection, presets, proposal and preview safeguards from the
  archived setup design and model-library requirements from the archived team-model design;
  read `contract/cli.json`, initializer, doctor and example checks at v0.5.0. Proposed interfaces
  are separated from supporting implementation; mandatory approval is replaced by grant/create
  admission, without claiming create is implemented.
