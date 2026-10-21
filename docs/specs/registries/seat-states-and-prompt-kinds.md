---
created: 2026-10-18
updated: 2026-10-18
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75)
source: src/labels/state.ts; src/launch/execute.ts; src/watch/check.ts
---

# Registry: seat-states-and-prompt-kinds

**What it lists.** Seat states, their source words, screen kinds, watch-check names, and integration event-prompt kinds in separate namespaces.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `working` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `idle` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `done` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `blocked` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `held` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `unreachable` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `unknown` | Observed exclusive seat state | present at 0.5.0 | `src/labels/state.ts`: SeatStateWord | SeatStateWord |
| `cli` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `cli-hook` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `herdr` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `trace` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `process` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `hold` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `none` | State-reading source | present at 0.5.0 | `src/labels/state.ts`: StateSource | StateSource |
| `idle` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `working` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `permission` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `trust` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `question` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `exit question` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `vendor notice` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `provider error` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `rate limit` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `unsent` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `unknown` | Screen classifier result; not itself a seat-state word | present at 0.5.0 | `src/launch/execute.ts`: ScreenKind | ScreenKind |
| `missing` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; always on |
| `restored` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `model-drift` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; always on |
| `attention` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; always on |
| `provider-error` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `unsent` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `idle` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `extra` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `team-idle` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `approval` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; always on |
| `load` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `memory` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `disk` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `swap-free` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `swap-growth` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |
| `budget` | Watch check name. | present at 0.5.0 | `src/watch/check.ts`: CHECK_NAMES | separate check namespace; configurable |

**Not in the tool at the release tag, named by a text:**

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `permission` | Owner-routed event prompt kind. | 0.5.1 unreleased | `src/bus/kinds.ts` at int/0.5.1 8acb470b | Separate event-prompt namespace; login has no distinct ScreenKind at the tag. |
| `trust` | Owner-routed event prompt kind. | 0.5.1 unreleased | `src/bus/kinds.ts` at int/0.5.1 8acb470b | Separate event-prompt namespace; login has no distinct ScreenKind at the tag. |
| `login` | Owner-routed event prompt kind. | 0.5.1 unreleased | `src/bus/kinds.ts` at int/0.5.1 8acb470b | Separate event-prompt namespace; login has no distinct ScreenKind at the tag. |
| `vendor notice` | Owner-routed event prompt kind. | 0.5.1 unreleased | `src/bus/kinds.ts` at int/0.5.1 8acb470b | Separate event-prompt namespace; login has no distinct ScreenKind at the tag. |
| `rate limit` | Owner-routed event prompt kind. | 0.5.1 unreleased | `src/bus/kinds.ts` at int/0.5.1 8acb470b | Separate event-prompt namespace; login has no distinct ScreenKind at the tag. |

Runtime chapter C supplies the state semantics. A hold, unreachable pane and ended process outrank ordinary signals; blocking screen conditions outrank idle clocks. Sources remain ranked, with the recent-trace exception to an idle reading; `blind` is a flag after the unknown threshold, not an eighth state. Proof: `test/seat-state.test.ts`, `test/watch-checks.test.ts`. Repeated spelling in two namespaces is deliberate.

**Current note, after the v0.5.0 tag.** The rows above record the tag and do not change. A later addition reads the daemon's presence projection as the `presence` state-reading source: canonical presence words `working`, `idle`, `waiting-for-a-person`, `gone` (displayed as `working`, `idle`, `blocked`, `done`), runtime sources `runtime-hook`, `runtime-event`, `daemon-launch`, and the event instant kept beside them. A projection under the seat's recorded runtime binding answers before any screen or trace, live or last known; the terminal-host screen is the labelled fallback only where no projection exists, and a malformed one reads `unknown` from `presence`. Proof: `test/seat-state.test.ts`, `test/labels-presence.test.ts`.

**Second current note.** `quota out` joins the observed seat-state words (`src/labels/state.ts`: SeatStateWord): a quiet seat whose screen is its provider's usage wall reads `quota out` instead of the host's word, with the pool it spends and the reset exactly as the screen words it (`quota out on <account>, resets at <time>`; `resets in <span>` for a span, `no reset time named` when the screen words none). The screen kind stays `rate limit`, and the watch's line is `is out of quota … usage limit`, never a second state word. Proof: `test/seat-state.test.ts`, `test/status.test.ts`, `test/quota-out-state.test.ts`.

Contributions reconciled at this draft: accounts and gates, budgets, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
