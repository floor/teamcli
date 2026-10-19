---
created: 2026-10-18
updated: 2026-10-18
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: 010 Workflow
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: The round

## 1. Scope

This specification defines the round as 010 Workflow decides it: the record `round start` writes, the settings with their defaults, the fixed close sequence, the timing records and the daily report, the red markers, and the install step's forward-only rule. **None of it is a command at the tag** — the round is a playbook run by hand, and every format below is planned, marked as such. What exists at the tag and the round builds on — the seat state, the liveness policy names, `team next`, the commit check — is named in §3.6 and owned by the seat-state, policies and quality-gate specifications.

## 2. Terms

- `round`: the unit of a team's building work under a development mode; opens with `round start`, ends with `round close` (010 Workflow §2c).
- `development mode`: `local-fast` (the default) or `pr-per-change`; the advised policy of that name.
- `integrator`: the orchestrator, or a seat it names, that merges the builders' local branches into the integration branch.
- `light check`: the per-batch check — an incremental typecheck, the tests the batch touches, and the tests of the files that import a changed module to dependency depth 2, with a budget of 60 seconds at that depth.
- `batch`: the integrator's merge unit, per commit or per `batch-interval`.
- `acknowledgement`: a receipt — a dispatch becomes an assignment when the seat acknowledges it; a delivery outcome is not a receipt.
- `liveness`: whether a seat of an open round is working, read from the seat state, not from a pane.
- `blind`: a seat in state `unknown` past `unknown-threshold`, counted as not working; a must-fix the lead is told of.
- `rollback`: an install that replaces the running version with an older one, declared as such and recorded with the two versions and the reason.
- `marker`: the record a red result writes — the shared marker for the integration tip, `RED-<branch with / as _>` for another branch.
- `heavy slot`: the machine's one heavy run at a time; the hourly full suite takes one.

## 3. Formats

### 3.1. The round record (planned; not built)

What `round start` declares and writes down, with the start time recorded:

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `development-mode` | name | yes | `local-fast` | planned | The mode the round runs under (§2b of the text) |
| integration branch | ref | yes | — | planned | The branch the integrator merges into |
| worktrees | one per builder | yes | — | planned | One worktree per builder seat in the round |
| integrator | seat | yes | the orchestrator | planned | The orchestrator, or a seat it names |
| seats | list | yes | — | planned | The seats in the round |
| tracker items | list | yes | — | planned | The items the round takes |
| start time | timestamp | yes | — | planned | Recorded at the open |

Who may open a round is the Kernel's row for starting work; by default the team's lead.

### 3.2. The round's settings (decided; read at the tag as policies where noted)

| Setting | Default | Levels | Used by | At the tag |
|---|---|---|---|---|
| `development-mode` | `local-fast` | entity, project, team | the round's mode | an advised policy name, default `local-fast`, a lower level chooses |
| `batch-interval` | 10 minutes | project, team | the integrator's batches | not built |
| `light-check` | incremental typecheck, the touched tests and the tests of the files that import a changed module to dependency depth 2; budget 60 seconds at that depth | project, team | the integrator's check | not built |
| `ack-timeout` | 2 minutes; one resend, then another seat | team | the dispatch | not built; receipts do not exist, so acknowledgement is the seat's pull through `team next` |
| `seat-idle` | 5 minutes | team | liveness | the seat state's trace freshness is a policy name defaulting to 120 seconds at the tag (see §7) |
| `unknown-threshold` | 5 minutes; past it a seat in state `unknown` counts as not working and is flagged blind | team | liveness | the policy name for blindness defaults to 300 seconds at the tag |
| `idle-to-lead` | 5 minutes | project, team | liveness | the policy name defaults to 300 seconds at the tag |
| `idle-to-owner` | 15 minutes | entity, project | liveness | the policy name defaults to 900 seconds at the tag |
| `review-lab` | a lab other than the authors'; a level may require more, never less | entity, project, team | the close's review | not built |
| `push-gate-budget` | 60 seconds | project | the close's timing | not built |
| `daily-report` | on, at the entity's end of day | entity, project, team | the report | not built |
| `hourly-suite` | one full suite on the integration tip every 1 hour while a round is open; skipped when the tip has not moved, another pass holds the lock, or a heavy slot is held | project, team | the hourly pass | not built |
| `red-stops-merges` | on: a red on the integration tip stops every merge into the integration branch; a red on any other branch blocks only that branch's merge; each until the lead clears its marker | project, team | the merges | not built; until the round is a command it is the integrator's discipline and the lead's clearing of the marker |
| `borrow-seat` | off | project | staffing | not built |

A lower level inherits each setting and may tighten it; it may loosen only where the setting's text allows it.

### 3.3. The close sequence (planned; not built)

`round close` is one fixed, scripted sequence; no step is skipped and none is reordered; a failed step stops the sequence, names the step and the reason, and the round stays open until the step passes or the lead reopens the round:

1. freeze the integration branch, no merge after this point;
2. the review of the whole by a reviewer from a lab other than the authors' (`review-lab`);
3. the full test suite, once, locally;
4. the docs: changelog and the pages the work changed;
5. one push;
6. one pull request;
7. CI, once;
8. the merge, as a merge commit;
9. the install (forward only, §3.5);
10. the round report (§3.4).

Under `pr-per-change` steps 5 to 8 run per change and the close runs the rest once.

### 3.4. The timings and the daily report (planned; not built)

The round records the duration of each step: the start, each batch (merge and check), each dispatch to its acknowledgement, each close step, and the push gate against `push-gate-budget`. A daily report per team (`daily-report`, default on, at the entity's end of day) lists the rounds, the batches, the idle time, the liveness tellings, the failed steps, the rollbacks and the timings against their budgets. The report goes up the chain; the owner reads the report, not the panes.

### 3.5. The install and the rollback (planned; not built)

An install replaces the running version with a newer one. Going back is a rollback: declared as such, recorded with the two versions and the reason, told to the owner and to the open round. An install that would run an older version without that declaration is refused — the `forward-only-install` policy, whose gate is the install step, not this spec's.

### 3.6. What exists at the tag

- `team next [--mine | --release] [--wait] [--json]`: the re-dispatch the round's rules name; until receipts exist, a seat's acknowledgement is its pull through this command.
- `team commits check <ref> [--since <ref>] [--file <path>] [--json]`: the commit and range check against the team file's seat list, which a close's review leans on.
- The seat state (working, idle, done, blocked, held, unreachable, unknown), read from ranked sources — the seat-state specification's.
- The liveness thresholds as enforced policy names with defaults (`300`/`300`/`900` seconds for the lead, owner and blindness rules; `120` seconds for the trace window) — the policies specification's.

## 4. Commands and options

None at the tag: `round start` and `round close` are planned, not commands. The commands the round's rules name at the tag:

```text
team next [--mine | --release] [--wait] [--json]
team commits check <ref> [--since <ref>] [--file <path>] [--json]
```

## 5. Rules

1. **A task is taken only on the seat's acknowledgement.** A dispatch MUST become an assignment only when the seat acknowledges it; a delivery outcome MUST NOT count as one — "delivered" says the message reached the seat's program, not that the seat read it. A dispatch not acknowledged within `ack-timeout` MUST be sent once more, then dispatched to another seat, and both recorded. *Decided by* 010 Workflow commitment 13. *Proof:* none at the tag (receipts are not built; acknowledgement is the pull through `team next`).
2. **No idle seats.** When its task is done, a seat MUST take the next unassigned item of the round that its role can do, acknowledge it and start, without waiting to be asked; a seat with nothing it can take MUST say so once to the integrator and stop; re-dispatch is the tool's (`team next`), never a hand-typed message. *Decided by* commitment 15. *Proof:* `team next` at the tag; the pull rule is discipline.
3. **Integration and the light check are automatic.** Under `local-fast` the integrator MUST merge the builders' local branches per commit or per batch and run the light check on each batch; a failed batch MUST go back to its builder with the failure while the round goes on for the others; nothing is merged silently, nothing fails silently, and no seat merges by hand. *Decided by* commitment 12. *Proof:* none at the tag.
4. **Liveness tells by thresholds.** When no seat of an open round is working for `idle-to-lead`, the lead MUST be told; for `idle-to-owner`, the owner; each telling recorded; a seat `unknown` past `unknown-threshold` counts as not working and MUST be flagged blind; the integrator re-dispatches on its own. *Decided by* commitment 14. *Proof:* the thresholds are policy names at the tag; the telling is not built.
5. **Installs go forward only.** An install that would run an older version without a declared, recorded rollback MUST be refused, and the refusal and the rollback told to the owner and the open round. *Decided by* commitment 16. *Proof:* none at the tag.
6. **The close is one fixed sequence** (§3.3); a failed step stops it, names the step and the reason. *Decided by* commitment 17. *Proof:* none at the tag.
7. **Every step is timed and the day is reported** (§3.4). *Decided by* commitment 18. *Proof:* none at the tag.
8. **An hourly full suite covers what the light check cannot see.** While a round is open, one seat runs the full suite on the integration tip once an hour; a pass is skipped when the tip is the sha the last pass ran, when another pass holds the lock, or when a heavy slot is held; a red result on the integration tip stops the round's merges until the lead has understood the failure and cleared the shared marker; a red on any other branch writes `RED-<branch with / as _>` and blocks only that branch's merge; a pass that cannot start is an error, not a red tip. *Decided by* commitment 20. *Proof:* none at the tag.
9. **The owner decides; the round runs.** What reaches the owner from a round: a liveness telling at `idle-to-owner`, a rollback, a blocker he alone can lift, the round report, and the decisions that are his — priorities, releases, publishes, deploys and policies. Everything else runs without him, and a round never waits on the owner for a step that is not his. *Decided by* commitment 19. *Proof:* none at the tag.

## 6. Registries

This specification contributes no registry rows of its own; the two policies the round defines (`forward-only-install`, `round-close-sequence`) are rows of `registries/policy-names.md` in its planned table (see the policies specification, §6), and the liveness thresholds are the policy names already listed there.

## 7. Open points

1. **The round is not a command at the tag**: `round start`, `round close`, the timings and the report are decided and not built; the settings exist only as the policy names the liveness thresholds became.
2. **Receipts are not built**, so the acknowledgement rule (§5.1) cannot hold; acknowledgement is the seat's pull through `team next`.
3. **The trace-freshness default differs from the text's `seat-idle`**: the text's `seat-idle` is 5 minutes; the policy name that governs how fresh a trace must be for a seat to read as working defaults to 120 seconds at the tag. Whether `seat-idle` is that policy or a fourth threshold is unsettleable from the code alone.
4. **`red-stops-merges` is discipline, not a gate**, until the round is a command: it is as strong as the integrator's discipline and the lead's clearing of the marker.
5. **The development mode is advised**: the tool runs none of the mode's steps itself at the tag, so neither mode is enforced.
6. **The hourly suite's heavy slot and lock** are the machine-load rules the watch and budgets specifications own; the round names them, it does not define them.

## Revision log

- **Draft** (the writer, 2026-10-18): lifted from 010 Workflow draft 2 (§2c, §2d, the settings table); read at `v0.5.0 (52db9b75)` — the round is not built, and the formats are marked planned; the liveness thresholds recorded as the policy names they became.
