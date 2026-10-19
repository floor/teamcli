---
created: 2026-10-18
updated: 2026-10-19
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75)
source: src/policy/types.ts
---

# Registry: policy-names

**What it lists.** Canonical enforced/advised catalogue names, with proposed names kept apart.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `gate-lift` (in code: `dev-mode`, until the rename ships) | Lifts the caller gate for the listed everyday operations only. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `seats-cross-teams` | Whether a seat listing may include other teams. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `state-trace-window-seconds` | Recent-trace window for state inference. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `state-blind-after-seconds` | Unknown-state duration before blind reporting. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `state-hook-working-seconds` | Turn-start hook’s priority interval. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `liveness-idle-lead-seconds` | Idle threshold for a lead notice. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `liveness-idle-owner-seconds` | Idle threshold for an owner notice. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `delivery-order` | Order of permitted delivery legs. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `development-mode` | Local-fast or PR-per-change development workflow. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `shared-checkout-hygiene` | Shared checkout working rules. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `pane-conduct` | Conduct before sending a key into a pane. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `seat-numbering` | Width and separator of seat-number prefixes. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `board` | Project’s decision-making terms as advised text. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |
| `review-terms` | Project’s review terms as advised text. | present at 0.5.0 | `src/policy/types.ts` | Canonical kebab-case; aliases normalize at load. |

**Not in the tool at the release tag, named by a text:**

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `ack-timeout` | Round acknowledgement deadline. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `batch-interval` | Local integration batch cadence. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `borrow-seat` | Temporary engagement of a seat for round work. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `budget-actions` | Off, advice-only or automatic action selection. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `budget-floor` | Spend-account balance floor as a policy. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `budget-marks` | Used-percentage warning marks as policies. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `budget-reserve` | Subscription reserve as a policy. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `commit-signature` | Signature template, forbidden lines, model match and enforcement strictness. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `conversation-recording` | Whether conversations are recorded: `none`, `all`, or a list of channels and participants. | planned | 003 Memory’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `conversation-retention` | How long recorded conversations are retained; default 30 days, a setting per level. | planned | 003 Memory’s proposed policy; not in `src/policy/types.ts` | OD-20261019-32, answer 19; the memory spec reference awaits its public destination; no executable catalogue entry. |
| `daily-report` | Daily round report setting. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `duty-conflict` | Refusal or report for incompatible positive duties; proposed default refuse, error names both rules. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `entity-boundary` | Declared entity-root boundary; implemented scope checks do not make this a scalar catalogue name. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `forward-only-install` | Refuse backward installation except an explicit recorded rollback. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `hourly-suite` | Full-suite cadence during a round. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `light-check` | Light-check command/selection setting. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `memory-accept` | Who accepts a memory entry at a level: the owner, or a holder by grant. | planned | 003 Memory’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `memory-at-start` | What an agent is given at a start: everything allowed, or the entries tagged for the work in hand. | planned | 003 Memory’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `memory-attach-limit` | The most memory spaces a seat may attach; default three. | planned | 003 Memory’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `memory-review-after` | How long an entry goes unconfirmed before it is offered for removal. | planned | 003 Memory’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `model-rule` | The entity’s rule for which models may run on which seats; the tool lists the seats that break it, proposes each replacement, swaps one by one with the handover and reads the status bar back, and `team check` and `team watch` flag every breach. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Entity level only; carried out in every team of the entity. |
| `pace-conduct` | Lean-turn advice during tightening. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `pace-floor` | Margin floor requiring the owner’s decision. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `pace-tighten` | Threshold for tighter reporting and lean-turn advice. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `pace-warn` | Warning threshold on the account/lab clock margin. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `pane-authority` | Who may answer another pane’s prompt; command gate exists, scalar catalogue entry does not. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `push-gate-budget` | Budget for the push gate. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `red-stops-merges` | Hold new merges after a failed hourly suite. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `release-critical` | How work permitted at the budget floor is identified. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `required-approvers` | Named approval requirements per operation. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `required-skill-delivery` | Refuse/report an undelivered required skill; proposed default refuse, scope entity/project/team. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `review-lab` | Round review-lab setting. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Spec §6 contribution; no executable catalogue entry. |
| `review-labs-min` | The least number of labs, other than the author’s, that review the naming-method text and every casting. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | Entity, project and team levels; default 2; counts labs, not reviewers — Quality’s `review-count` is a different setting. Spec: [casting.md](../casting.md). |
| `round-close-sequence` | Prescribed round-closing sequence. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `swap-targets` | Subset of declared accounts allowed for a seat swap. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `swap-wait-seconds` | How long a queued model swap waits at the seat’s task boundary before it runs at the next pause between two turns, logged. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | A setting; 30 minutes proposed; a broken seat swaps without waiting. |
| `unknown-is-spent` | Whether unreadable resource counts as spent. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `who-may-remove-seat` | Proposed authorization policy for seat removal. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `who-may-start` | Proposed authorization policy for starting. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |
| `who-may-stop` | Proposed authorization policy for stopping. | planned | Defining unit’s proposed policy; not in `src/policy/types.ts` | No scalar catalogue entry; feature-specific implementation, if any, is stated in Meaning. |

| `done` | Completion criteria setting. | planned | Quality proposed policies, spec §6 | Not in the v0.5.0 scalar catalogue; no gate implemented by this row. |
| `review-line` | Minimum written review evidence. | planned | Quality proposed policies, spec §6 | Not in the v0.5.0 scalar catalogue; no gate implemented by this row. |
| `real-run` | Requirement for an actual checking run. | planned | Quality proposed policies, spec §6 | Not in the v0.5.0 scalar catalogue; no gate implemented by this row. |
| `accept-with-finding` | Whether work may be accepted with a recorded finding. | planned | Quality proposed policies, spec §6 | Not in the v0.5.0 scalar catalogue; no gate implemented by this row. |
| `review-count` | Review-count setting. | planned | Quality proposed policies, spec §6 | Not in the v0.5.0 scalar catalogue; no gate implemented by this row. |

### Consensus settings (planned)

Module 006's commitment 11. None is in the v0.5.0 catalogue; the v2 draft is the rule, and this
block is where its allowed values and proposed defaults live. All inherit entity, project and
team, tightening only (more voices, more labs, fewer returns before the stop, a nearer due time).

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `decision-rule` | Which rule decides each kind of decision. | planned | Consensus commitment 11 | A map from kind (a text accepted, a change checked, an entry remembered, a power given, a finding closed, a team's shape chosen) to who and which means (a fact; a trial; a vote; one voice that hears the others; a rule already written, found and applied; review in rounds; the owner; a project's own). No proposed default: where nothing is set, one voice decides. |
| `voices-min` | The floor's minimum independent voices. | planned | Consensus commitment 11 | A number; no proposed default in the draft. |
| `labs-min` | The floor's minimum labs. | planned | Consensus commitment 11 | A number; no proposed default in the draft. |
| `answer-due` | The window answers are due by. | planned | Consensus commitment 11 | A duration; no proposed default in the draft. |
| `rounds-max` | The returns of one point before the decider decides. | planned | Consensus commitment 11 | A number; the draft proposes three (open question 7). |
| `escalate-to` | Who is escalated to at the limit. | planned | Consensus commitment 11 | One of the lead, the board, the owner, set by kind; no proposed default in the draft. |
| `vote-lending` | Whether a voice may be lent, never to the producer. | planned | Consensus commitment 11 | `off` or `on`; the draft proposes `off` (open question 7). |

| `event-routing` | Additive routing map by event kind. | 0.5.1 unreleased | `src/policy/events.ts` at int/0.5.1 8acb470b | Implemented settings group; not a scalar POLICY_CATALOGUE entry at v0.5.0. |
| `privileged-kinds` | Owner-sovereign growing set of protected kinds. | 0.5.1 unreleased | `src/policy/events.ts` at int/0.5.1 8acb470b | Implemented settings group; not a scalar POLICY_CATALOGUE entry at v0.5.0. |
| `event-thresholds` | Owner-sovereign event timing and retention group. | 0.5.1 unreleased | `src/policy/events.ts` at int/0.5.1 8acb470b | Implemented settings group; not a scalar POLICY_CATALOGUE entry at v0.5.0. |
| `owner-at-once` | Owner-sovereign immediacy list. | 0.5.1 unreleased | `src/bus/kinds.ts` at int/0.5.1 8acb470b | Implemented settings group; not a scalar POLICY_CATALOGUE entry at v0.5.0. |

Aliases are accepted spellings, not new entries. The source’s DEV_MODE_OPERATIONS array has nine names although its comment says eight; read the array. Budget policies and routing settings are not silently added to the scalar catalogue. Proof: `test/policy.test.ts`, `test/settings-as-policies.test.ts`. Quality’s §6 contributes completion, review-evidence, real-run, acceptance-with-finding and reviewer-count proposals; their classification remains proposed. Registry/board/review strings are advised and do not authorize an act.

Contributions reconciled at this draft: accounts and gates, budgets, casting, consensus, events, grants, launch, memory, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

The policy-area spec contribution is not yet available at this handoff. The release vocabulary is fully read from `src/policy/types.ts`, and proposed names are retained from the current policy catalogue and completed area contributions; the final policy-area §6 comparison remains for the editor once that draft arrives.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
- **Amended** (2026-10-19): six planned memory rows added for the Memory v2 draft's fold — `memory-accept`, `memory-at-start`, `memory-attach-limit`, `memory-review-after`, `conversation-recording`, `conversation-retention`; no implementation source at the tag.
- **Amended** (2026-10-19): the seven planned consensus rows completed for the Consensus v2 draft's fold — a named planned block carrying each setting's allowed values and the draft's proposed defaults; no implementation source at the tag.
- **Amended** (2026-10-19): three planned rows added for the Policies v2 draft's fold of the night's decisions — `model-rule` (entity level only), `swap-wait-seconds` (a setting, 30 minutes proposed; a broken seat swaps without waiting) and `review-labs-min` (entity, project and team levels, default 2; labs, not reviewers — a new row, since Quality's `review-count` counts reviewers and is not this setting); no implementation source at the tag.
- **Agreed Phase B review fold** (2026-10-19): the planned model-rule row includes reading the status bar back under OD-20261019-01; no catalogue name or implementation status changes.
- **Amended** (2026-10-19): the planned `review-labs-min` row carries the casting spec ([casting.md](../casting.md), S6) in its Note; its levels, default and labs-not-reviewers meaning are unchanged.

- **Phase A review and first-handover fold** (2026-10-19): the casting reference is deferred as plain prose so the included files do not link to the excluded casting spec; casting added to the contribution summary; conversation-retention added as the sixth planned memory policy under OD-20261019-32, answer 19 (30 days by default), with its public spec destination pending.
