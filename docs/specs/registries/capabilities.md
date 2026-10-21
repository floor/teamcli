---
created: 2026-10-18
updated: 2026-10-18
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75)
source: src/permissions/grants.ts
---

# Registry: capabilities

**What it lists.** Operational grant words, the separate team-setting word, and explicitly excluded administrative names.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `write` | change files within its `path` scope | 0.5.0 | `src/permissions/grants.ts` (`GRANT_CAPABILITIES`) | in the vocabulary; gates no command at 0.5.0 |
| `read` | be served file contents within its `path` scope; every tool disclosure is a `read` | 0.5.0 | `src/permissions/grants.ts` | in the vocabulary; the scope is not enforced at 0.5.0 |
| `review` | record a verdict on a change (`path`, `branch`) | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `gate` | let a change pass a required check (`path`, `branch`) | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `merge` | bring a change into a trunk (`path`, `branch`); consumes a gate pass | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `deploy` | release to an environment (`env`, optionally `branch`); consumes a gate pass | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `use-broker` | be served a secret-bearing task resource through the broker | 0.5.0 | `src/permissions/grants.ts` | in the vocabulary; the per-seat check is not built |
| `act-as` | use the owner's external identity within its `account` scope | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `create` | start a team within its create-bounds | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | named as never team-grantable; no command row at 0.5.0 |
| `grant` | give a capability to a seat | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | owner-only at 0.5.0 |
| `agree` | confirm a same-copy change | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | no copy agreement by hash at 0.5.0 |
| `leads` | the single authority root | 0.5.0 | `src/file/sections/lead.ts` | read as one lead seat; the envelope is not built; carrying it through a role is planned, while the file’s leads mark exists at int/0.5.1 8acb470b |
| `dialogs.trust` | Owner setting carried by a team grant, never a seat-grant capability or command. | present at 0.5.0 | `src/permissions/grants.ts`: GRANT_SETTINGS | Separate setting namespace. |

Proof: `test/permissions/grants.test.ts`, `test/grant-boundaries.test.ts`, `test/must-not-pretend.test.ts`. The Runtime and records/grants specs contribute the meanings; the executable vocabulary remains the source list. No new capability is granted by a registry entry.

Contributions reconciled at this draft: accounts and gates, budgets, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
