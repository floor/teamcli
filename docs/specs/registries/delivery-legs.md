---
created: 2026-10-18
updated: 2026-10-18
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75); integration comparison int/0.5.1 8acb470b, unreleased
source: src/settings/inherit.ts (DELIVERY_LEGS)
---

# Registry: delivery-legs

**What it lists.** Delivery-leg names and their release-specific presence.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `native` | Sender’s own tool handoff and explicit delivery record. | present at 0.5.0 | `src/settings/inherit.ts`: DELIVERY_LEGS | Default order follows the list; unavailable legs are recorded. |
| `mcp-inbox` | Inbox transport name; unavailable in the release-tag implementation. | present at 0.5.0 | `src/settings/inherit.ts`: DELIVERY_LEGS | Default order follows the list; unavailable legs are recorded. |
| `typed` | Drop record followed by pane wake line under pane rules. | present at 0.5.0 | `src/settings/inherit.ts`: DELIVERY_LEGS | Default order follows the list; unavailable legs are recorded. |

**Not in the tool at the release tag, named by a text:**

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `drop` | The record written whole, nothing typed, the seat told by watching its folder. | built at int/0.5.1 8acb470b, unreleased | `src/settings/inherit.ts`: DELIVERY_LEGS at int/0.5.1 8acb470b | Needs no bus; absent from v0.5.0. |
| `socket-accepted` | Historical proposal for relaxed receiving-side socket admission. | planned | Delivery policy text; `src/policy/types.ts` rejects the value at v0.5.0 | Not an executable leg at either pinned revision; not a default or option. |

At v0.5.0 a lower level drops or reorders inherited legs and adds none. At int/0.5.1 8acb470b, unreleased, `native` has a special explicitly chosen-leg exception in `src/policy/types.ts`; the integration fallback is `mcp-inbox`, `drop`, `typed`, while its complete leg vocabulary is `native`, `mcp-inbox`, `typed`, `drop`. Human panes use drop only in that integration build. The corrected events spec §6 now agrees that drop is built at the pinned integration revision, unreleased. A receiver without a folder watcher does not walk that leg; the leg itself needs no bus. Proof: `test/send-delivery-order.test.ts`, `test/settings-inherit.test.ts`; integration checks reside with the send-events implementation.

Contributions reconciled at this draft: accounts and gates, budgets, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
- **Re-collected** (2026-10-18): corrected events spec fix round 1; drop marked built at int/0.5.1 8acb470b, unreleased; stale planned-status discrepancy removed.
