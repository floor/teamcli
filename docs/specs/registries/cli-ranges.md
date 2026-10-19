---
created: 2026-10-18
updated: 2026-10-18
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75)
source: src/profiles/*.yaml (tested)
---

# Registry: cli-ranges

**What it lists.** The tested CLI version interval from each shipped profile.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `antigravity` | Tested from `1.2.16` through `1.4.1` inclusive. | present at 0.5.0 | `src/profiles/antigravity.yaml`: tested | binary agy; rules as a first message; range does not promise untested releases or resume support. |
| `claude-code` | Tested from `2.1.288` through `2.1.302` inclusive. | present at 0.5.0 | `src/profiles/claude-code.yaml`: tested | binary claude; rules as an option; range does not promise untested releases or resume support. |
| `codex` | Tested from `0.157.0` through `0.161.0` inclusive. | present at 0.5.0 | `src/profiles/codex.yaml`: tested | binary codex; rules as a first message; range does not promise untested releases or resume support. |
| `cursor` | Tested from `2026.10.01` through `2026.10.14` inclusive. | present at 0.5.0 | `src/profiles/cursor.yaml`: tested | binary cursor-agent; rules as a first message; range does not promise untested releases or resume support. |
| `gemini` | Tested from `0.64.0` through `0.64.0` inclusive. | present at 0.5.0 | `src/profiles/gemini.yaml`: tested | binary gemini; rules as a first message; range does not promise untested releases or resume support. |
| `grok` | Tested from `1.0.50` through `1.0.52` inclusive. | present at 0.5.0 | `src/profiles/grok.yaml`: tested | binary grok; rules as an option; range does not promise untested releases or resume support. |
| `jules` | Tested from `0.1.42` through `0.1.42` inclusive. | present at 0.5.0 | `src/profiles/jules.yaml`: tested | binary jules; rules prepended to each brief; range does not promise untested releases or resume support. |
| `muse` | Tested from `1.4.9` through `1.4.9` inclusive. | present at 0.5.0 | `src/profiles/muse.yaml`: tested | binary muse; rules as a first message; range does not promise untested releases or resume support. |

Proof: `test/profile-schema.test.ts`, `test/readme-profile-range-boundaries.test.ts`, `test/docs/antigravity-tested-range-boundary.test.ts`. Conversation resume support is a separate launch-accounts feature; the accounts/gates contribution does not change these measured ranges.

Contributions reconciled at this draft: accounts and gates, budgets, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
