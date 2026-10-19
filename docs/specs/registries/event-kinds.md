---
created: 2026-10-18
updated: 2026-10-18
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75), absent; int/0.5.1 8acb470b, built but unreleased
source: src/bus/kinds.ts and src/policy/events.ts at int/0.5.1 8acb470b
---

# Registry: event-kinds

**What it lists.** The integration bus kind vocabulary and planned quota extensions; no bus kinds exist at the release tag.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `message.arrived` | a record is written for a seat | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:57`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: recipient |
| `message.delivered` | a receipt is appended | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:58`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: sender |
| `message.read` | a receipt is appended | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:59`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: sender |
| `message.replied` | a receipt is appended | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:60`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: sender |
| `message.held` | a record waits with a reason | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:61`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: sender, lead; lead delay uses held threshold |
| `seat.working` | the seat state changes to `working` | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:63`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: none |
| `seat.idle` | the seat state changes to `idle` | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:64`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: none |
| `seat.idle-timeout` | a seat has been `idle` past `idle-threshold` with no `--wait` open on it and no lease held | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:65`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead |
| `seat.blocked` | the state reads `blocked`, with the prompt's kind | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:66`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, operator |
| `seat.at-prompt` | the seat waits at a prompt, with the prompt's kind | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:67`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, operator; privileged; owner joins for OWNER_PROMPT_KINDS |
| `seat.unreachable` | the seat cannot be reached | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:68`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, operator; owner joins for lead’s own seat |
| `seat.done` | the process left its pane | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:69`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, operator; owner joins for lead’s own seat |
| `work.claimed` | a lease is taken | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:71`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead; vocabulary/default existence does not prove every producer hook |
| `work.done` | a lease is finished | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:72`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead; vocabulary/default existence does not prove every producer hook |
| `work.released` | a lease is let go | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:73`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead; vocabulary/default existence does not prove every producer hook |
| `work.gate` | a gate stamp is written, green or red | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:74`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead; vocabulary/default existence does not prove every producer hook |
| `work.suite` | a suite report is written, green or red | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:75`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead; vocabulary/default existence does not prove every producer hook |
| `team.seat-added` | the roster changes | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:77`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, owner |
| `team.seat-removed` | the roster changes | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:78`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, owner |
| `team.seat-reloaded` | the roster changes | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:79`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, owner |
| `team.grant-issued` | a grant record is written | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:80`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, subject, owner; privileged |
| `team.grant-revoked` | a grant record is revoked | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:81`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, subject, owner; privileged |
| `team.grant-expired` | a grant record passes its expiry | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:82`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, subject, owner; privileged |
| `team.policy-changed` | a policy value is set at any level | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:83`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, subject, owner; privileged |
| `team.policy-refused` | a routing change is refused, naming the rule, the requester and the kind | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:84`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: owner; privileged |
| `release.ready` | the lead's own words to the owner (`team raise`): a release is ready | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:87`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: owner |
| `decision.needed` | the lead's own words to the owner (`team raise`): a decision is needed | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:88`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: owner |
| `record.invalid` | a record failed its check | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:90`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: owner; privileged |
| `security.refused` | a guarded act was refused | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:91`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: owner; privileged |
| `team.event-log-dropped` | retention dropped a sequence range | built at int/0.5.1 8acb470b, unreleased | `src/bus/kinds.ts:94`, `src/policy/events.ts` at int/0.5.1 8acb470b | default: lead, operator |

**Not in the tool at the release tag, named by a text:**

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `quota.pace-low` | Pace warning/tightening/last-call notice. | planned | Planning chapter H commitments 19–20 | Absent from both pinned code vocabularies; no producer claimed. |
| `quota.floor-reached` | Privileged owner decision at the pace floor. | planned | Planning chapter H commitments 19–20 | Absent from both pinned code vocabularies; no producer claimed. |
| `quota.seat-walled` | Seat/account usage wall. | planned | Planning chapter H commitments 19–20 | Absent from both pinned code vocabularies; no producer claimed. |
| `quota.unknown` | Unknown/stale account with running seats. | planned | Planning chapter H commitments 19–20 | Absent from both pinned code vocabularies; no producer claimed. |
| `quota.recovered` | Recovery above tightening mark. | planned | Planning chapter H commitments 19–20 | Absent from both pinned code vocabularies; no producer claimed. |
| `quota.action` | Before/after and reversal action record; bus-kind status unresolved. | planned | Planning chapter H commitments 19–20 | Absent from both pinned code vocabularies; no producer claimed. |

The accepted send-events §4.3 supplies the conceptual event list. Integration adds release/decision/security/retention kinds. The corrected events spec §§3 and 6 and the pinned code agree on all thirty entries, recollected above with their declaration lines. The historical accepted-amendment/build count remains an editorial point in that spec’s §7; it changes no registry entry. Its `team.policy-refused` default is owner-only, whereas the text names lead and owner; both positions are preserved here for reconciliation, with code defining Today. Work-author and red-integration routing clauses in the text require producer context; the default kind table alone does not prove those hooks. Budget text’s four-kind slip is corrected to five crossings; quota.action remains a record until its bus status is decided. Proof at int/0.5.1 8acb470b: `test/bus-routing.test.ts`, `test/bus-reconcile.test.ts`, `test/bus-owner.test.ts`; no budget-event proof. The privileged set cannot be silently reduced or self-subscribed to. The owner-routed prompt kinds recollected from the same contribution are `permission`, `trust`, `login`, `vendor notice` and `rate limit`; these qualify `seat.at-prompt`, rather than adding event-kind entries. The built-in privileged set is the eight rows marked privileged above.

Contributions reconciled at this draft: accounts and gates, budgets, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
- **Re-collected** (2026-10-18): corrected events spec fix round 1; all thirty pinned kinds and declaration lines retained; stale count-discrepancy note removed.
