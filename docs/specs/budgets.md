---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75); chapter H comparison at int/0.5.1 8acb470b, unreleased
for: Planning chapter H; Runtime
public: staged for review; contains no private links
---

# Spec: budgets

## 1. Scope

This spec covers budget configuration, readings, check contracts, quota reporting, launch refusals and marks. The implemented reading and gate files cited below are byte-identical between v0.5.0 and int/0.5.1 8acb470b; the bus is built only at that integration revision, unreleased. Proposed planning, events, automatic reactions and hierarchical cost accounting are kept explicitly separate in §7 and are not current interfaces.

## 2. Terms

- `subscription`: an account whose windows carry percentages and a reserve.
- `spend`: an account with a balance, currency and floor.
- `status_line`, `check`: ordered reading sources in budget configuration.
- `fresh`, `unconfirmed`, `stale`, `refusing`, `unknown`: table states.
- `last-seen`: an internal reading verdict, rendered through the table’s state vocabulary.
- `margin`: elapsed share of the quota window minus used share, in percentage points.
- `paceFrom`: used percentage points per hour between two points of a fresh reading; distinct from margin.

## 3. Formats

### 3.1. Team-file budgets section

The owner writes `budgets` in the team file. Unknown keys are refused. Sources: `src/file/sections/budgets.ts`, `src/file/types.ts`; proof: `test/budgets.test.ts`, `test/budgets-owner.test.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| stale_after | duration s/m/h | no | 30m | present at 0.5.0 | Reading freshness interval; parsed seconds. |
| check_every | positive duration | no | 10m | present at 0.5.0 | Command check cadence; zero invalid. |
| marks | nonempty percentage[] | no | [50, 75, 90] | present at 0.5.0 | Each above 0, at most 100; replaces watch.quota_marks with warning. |
| accounts | map | no | {} | present at 0.5.0 | No account budgeted until named. |
| accounts.<name>.kind | subscription or spend | yes | none | present at 0.5.0 | Account kind. |
| shared | boolean | no | false | present at 0.5.0 | Shared account declaration. |
| reserve | percentage | subscription only | none | present at 0.5.0 | Above 0, at most 100; spend rejects it. |
| floor | amount and ISO-style currency | spend only | none | present at 0.5.0 | Nonnegative amount, up to four decimals, three uppercase letters; subscription rejects it. |
| sources | ordered unique check/status_line[] | no | check when command given, else subscription status_line | present at 0.5.0 | Nonempty; spend rejects screen reading and needs a check. |
| check | one command token | when check source | none | present at 0.5.0 | No whitespace or arguments; use wrapper. |

Test excerpt, `test/watch-budget.test.ts`:

```yaml
accounts:
  openai: { kind: subscription, reserve: 3%, sources: [check], check: openai-quota }
```

### 3.2. Counted subscription and spend readings

The watch folds project readings under the project-state lock; subscriptions occupy `state.budgets`, spend balances `state.spend`. `StoredReading` timestamps are ISO strings; in-memory `Seen` times are milliseconds. Sources: `src/budgets/readings.ts`; proof: `test/readings.test.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| account | string | yes | none | present at 0.5.0 | Budget bucket. |
| window | session/daily/weekly | yes | none | present at 0.5.0 | Window name. |
| left / used | number | yes | none | present at 0.5.0 | Percentages. |
| changedAt | ISO timestamp | yes | none | present at 0.5.0 | Last screen change, or measurement time of check. |
| resetsAt | ISO timestamp or null | yes | null when unknown | present at 0.5.0 | Reset anchor. |
| seat | string or null | yes | null for check | present at 0.5.0 | Screen source seat; checks have no seat. |
| source | status_line or check | no in old records | status_line | present at 0.5.0 | Provenance. |
| confirmed | boolean | yes | none | present at 0.5.0 | Screen confirmation or check confirmed on first read. |
| was | {left, at} | no | absent | present at 0.5.0 | Prior figure at last change in same reset window; at stored as ISO. A malformed point is discarded whole. |

`StoredSpend` is `{account: string, amount: number, currency: string, at: ISO timestamp}`. Checks supply a run time rather than an output timestamp for spend. Saving merges by account; a check that did not run leaves its prior balance.

### 3.3. Machine-wide informational observations

The watch writes the machine configuration’s `usage/readings.json` (relative to the TeamCLI configuration root), an array of `MachineReading`. It is informational and independent of the launch gate’s confirmed project readings. The directory is private and writes use a lock, a private temporary file and rename; latest observation per account/window/pool wins. Source: `src/information/machine-readings.ts`; proof: `test/usage-machine-readings.test.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| account | nonempty string | yes | none | present at 0.5.0 | Observed account. |
| window | session/daily/weekly | yes | none | present at 0.5.0 | Observed window. |
| left / used | number | yes | none | present at 0.5.0 | Left in [0,100], used exactly 100-left. |
| observedAt | safe nonnegative integer | yes | none | present at 0.5.0 | Observation time in milliseconds. |
| resetsAt | safe nonnegative integer or null | yes | null | present at 0.5.0 | Reset time in milliseconds. |
| pool | gemini or claude-gpt | no | absent | present at 0.5.0 | Provider pool qualifier. |

No team name, seat, filesystem path or screen text is retained. Shared subscription declarations are resolved from the machine accounts configuration; an explicit seat account wins, otherwise CLI and launcher select the paying account. No credential or CLI session file is read by this reporting path.

### 3.4. Approved check and output contract

At approval, a check is resolved and its named executable hashed; only that file is hashed, not imports. The approved descriptor is `{command: string, path: string, hash: string}`. Before running, the stored path is hashed again; PATH is not re-resolved. Missing, changed or unapproved checks do not run. Source: `src/budgets/checks.ts`, `run.ts`; proof: `test/budget-run.test.ts`.

A run has only `PATH` and `HOME` in its environment, no arguments, ignored stdin and stderr, a ten-second timeout with SIGKILL, and requires exit 0. Raw stdout is parsed and dropped, never returned or logged. A check command itself may access its own vendor data; this contract exposes only figures to TeamCLI.

Subscription output has one to three unique window lines:

```text
<session|daily|weekly> <0..100>% <used|left> [resets <Nh[Nm]|Nm>] [at <10-digit Unix seconds>]
```

One trailing newline is allowed; CRLF is a line ending, an embedded CR is not. Any malformed line or repeated window rejects the whole output. A future `at` clamps to the run time; reset durations anchor to the measurement time. Without `at`, use the run time. Spend output is exactly one line `<nonnegative amount with up to four decimals> <three uppercase currency letters>`, matching the floor currency; its timestamp is the run time. Failure, timeout, invalid output or currency mismatch means no reading. Test example from `test/budget-run.test.ts`: the grammar is exercised with session, daily and weekly lines and explicit measurement timestamps.

### 3.5. Quota view, thresholds and advice

`team usage --tree` groups accounts and windows by the lab of the running model, with seats, used, left, reset, source, observation age and margin. Sources: `src/information/quota.ts`, `quota-observe.ts`, `usage.ts`; proof: `test/usage-quota.test.ts`, `test/usage-review-524.test.ts`.

Printed margin wins; otherwise margin is the percentage of the known window elapsed minus used. The quota view recognizes session (five hours) and weekly (seven days); the budget check contract also accepts daily, without inventing a daily quota-view window. The quota view ages observations after five minutes or a passed reset, removes their margin from advice, and says unknown without a fresh figure. A fresh wall screen or used at 100 is `walled`; used at least 90 or margin at most −50 is `near cap`; otherwise `ok`. Advice targets `ok` accounts with margin at least +10, most headroom first, preferring a weekly margin when available. It prints advice and performs no action. This freshness rule is separate from budget `stale_after`.

### 3.6. Quota report document fields

The report is built once for text and JSON rendering. The following is the quota block inside the usage report, from `src/information/quota.ts`; all fields listed without `?` are required, including nullable values. They are present at v0.5.0 and unchanged at the integration revision; no new schema is asserted.

| Record | Fields and types | Default / absence | Writer and meaning |
|---|---|---|---|
| `ReportQuota` | `format: 1`, `accountsFile: string`, `labs: ReportQuotaLab[]`, `advice: string` | no invented figure | Usage report builder; configuration reference, lab groups and one advice line. |
| `ReportQuotaLab` | `lab: string`, `state: QuotaState`, `accounts: ReportQuotaAccount[]` | empty accounts allowed | Lab of the running model, rather than its launcher CLI. |
| `ReportQuotaAccount` | `account: string`, `pool?: gemini or claude-gpt`, `state: QuotaState`, `windows: ReportQuotaWindow[]`, `seats: string[]`, `seatsOther?: number`, `wallResets: string or null` | optional pool/other-seat count absent; unknown wall reset null | Account group under the caller’s permitted view; other-team seats may only be counted. |
| `ReportQuotaWindow` | `window: session or weekly`, `used: number or null`, `left: number or null`, `resetsAt: ISO string or null`, `resetsIn: string or null`, `margin: number or null`, `source: QuotaSource`, `seat: string or null`, `age: string`, `stale: boolean`, `wall: boolean` | unavailable figures and margin null | Observed quota window; wall reports do not manufacture a percentage. |
| `QuotaSource` | status line; cli usage; machine reading; quota screen | explicit source | Source spelling as printed by the reporting model. |
| `QuotaState` | ok; near cap; walled; unknown | unknown without fresh evidence | Classification thresholds are in §3.5. |

Proof: `test/usage-quota.test.ts` exercises the shared block, wall handling, stale advice exclusion, model lab attribution and restricted-view counts. Future quota events carry only the fields proposed in §7.1; no event payload schema is implemented yet.

## 4. Commands and options

Exact `usage` entry from `contract/cli.json` at v0.5.0:

```json
[
  {
    "flags": [
      {
        "hidden": false,
        "name": "--all",
        "repeatable": false,
        "takesValue": false
      },
      {
        "hidden": false,
        "name": "--help",
        "repeatable": false,
        "takesValue": false
      },
      {
        "hidden": false,
        "name": "--json",
        "repeatable": false,
        "takesValue": false
      },
      {
        "hidden": false,
        "name": "--tree",
        "repeatable": false,
        "takesValue": false
      },
      {
        "hidden": true,
        "name": "-h",
        "repeatable": false,
        "takesValue": false
      }
    ],
    "hidden": false,
    "name": "usage",
    "positionals": [],
    "subcommands": [],
    "usage": [
      "team usage [--json] [--all] [--tree]"
    ]
  }
]
```

`--json` writes the `team.usage` document, `--all` asks for every permitted team breakdown, `--tree` the quota view. Any caller may read; the owner’s terminal gets the full view, other callers get the allow-listed restricted view. `usage.block` is success; `usage.invocation` and `usage.store` are exit 2; see [exit-codes](registries/exit-codes.md). `up`, `add` and `restart` consult the launch gate; task commands remain in [tasks-and-broker](tasks-and-broker.md).

## 5. Rules

1. The reading selector MUST discard a known passed reset, prefer confirmed live readings, then the newest change. One screen sight stays unconfirmed until it changes or another seat agrees. A check is confirmed immediately. Source: `src/budgets/readings.ts`; proof: `test/readings.test.ts`.
2. Configured sources MUST be tried in order per window. Fresh lower sources may replace a failed, stale, unknown or unconfirmed higher one. A stale inside-reserve reading with a known future reset remains a refusal fallback. With no reset, stale near-reserve readings are unknown; only more than twice the reserve outside it may remain as last seen, below an inside-reserve fallback. Source: `src/budgets/readings.ts`; proof: `test/readings.test.ts`, `test/budget-refusals.test.ts`.
3. A fresh reading’s two-point pace MUST use `(previous left - current left) / hours between points`, rounded to one decimal; absent, stale or nonpositive-time pairs have no pace. A same-window change records the prior point; a reset changes the instance and clears it. This slope is not the quota view’s clock margin. Source: `src/budgets/readings.ts`; proof: `test/readings.test.ts`, `test/usage.test.ts`.
4. The launch gate MUST refuse a counted subscription reading with left at or below reserve, or a fresh spend balance at or below its same-currency floor; its explanation names the figure, window where relevant, age and accounts with room. An unknown or unconfirmed reading is said and does not refuse. `up` reaches this gate only with a verified prior approval record, including at the integration revision; `add` and `restart` also call the gate. Source: `src/budgets/gate.ts`, `src/commands/up.ts`, `add.ts`, `restart.ts`; proof: `test/budget-refusals.test.ts`.
5. The watch MUST report used-mark crossings to the operator once per window, rearming after reset or a ten-point fall when no reset is known. Reserve and spend-floor crossings go to the owner, once while held and again if they return. Unknown while seats run goes to the operator; a bare first sight is not that unknown report. It runs no action and refuses no seat. Source: `src/watch/checks/budget.ts`; proof: `test/watch-budget.test.ts`. Provider-limit reports are a separate `provider-error` check, `test/provider-error-check.test.ts`.
6. Reporting MUST name what was observed and preserve unknown rather than inventing room. No token pricing, effective subscription cost, per-task budget, spend-envelope reservation, automatic swap, budget-driven hold or goal decomposition exists here. Source: `src/information/usage.ts`, `src/commands/plan.ts`, `next.ts`; proof: existing reading tests only; proposed actions have no proof at the pinned revisions.

## 6. Registries

### event-kinds — all planned at both pinned revisions

`quota.pace-low` | warning, tightening or last-call crossing | planned | Planning chapter H commitment 19 | lead/operator; owner summary
`quota.floor-reached` | account pace reaches floor requiring owner decision | planned | Planning chapter H commitment 19 | privileged; owner, lead and operator at once
`quota.seat-walled` | account wall or seat usage limit | planned | Planning chapter H commitment 19 | lead/operator at once
`quota.unknown` | unknown/stale account with active seats | planned | Planning chapter H commitment 19 | operator
`quota.recovered` | recovery above tightening mark for two readings | planned | Planning chapter H commitment 19 | lead; hysteresis unresolved
`quota.action` | automatic action and reversal record | planned | Planning chapter H commitment 20 | text calls it a record; event-kind status unresolved

### policy-names — all planned at both pinned revisions

`pace-warn` | warning margin | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`pace-tighten` | tightening margin | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`pace-floor` | owner decision margin | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`budget-marks` | used-figure marks | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`budget-reserve` | subscription reserve | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`budget-floor` | spend floor | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`unknown-is-spent` | unknown accounting rule | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`budget-actions` | off, advise or act | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`release-critical` | release work classification | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`swap-targets` | allowed account subset | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision
`pace-conduct` | lean-turn advice for leads | planned | Planning chapter H commitments 17–21 | not in the policy catalogue at either pinned revision

## 7. Open points

### 7.1. Proposed chapter H interfaces; not implemented

The following preserves proposed detail lifted from Planning chapter H. It is not an implemented format or a new decision. The bus exists at int/0.5.1 8acb470b, unreleased, but its closed kind list contains no `quota.*` and the budget watch still uses its existing reports.

#### Planning commitment 17

**The marks are the owner's policies: warn, tighten and floor, per account and per lab, tightening
    only.** Three marks on the pace margin (in points, negative when the spend runs ahead of the
    clock) and the marks on the used figure (the reading specification’s `marks`, the `reserve` and the spend `floor`)
    are settings in amendment 02's form, scoped entity, project, team and seat, owner-signed, and a
    lower level may move a mark earlier (a margin nearer zero, a lower used figure, a larger reserve) and
    never later. The defaults are today's numbers, the owner's rules of 2026-10-17 as the night watch
    applies them: `pace-warn` at −12.5 points, `pace-tighten` at −13.4, `pace-floor` at −14.0, with
    one more notice at −13.8 as the floor's last call; `marks` at 50, 75 and 90 percent used;
    `reserve` as each account declares it; `floor` for a spend account as declared. The marks name
    the account (`anthropic`, `openai`, `deepseek`) and may name the lab instead, which covers every
    account the lab's seats draw on. No mark loosens the Kernel's envelope, which stays above them
    (§8): a mark selects where the envelope's boundary is announced and acted on, it does not move it.

#### Planning commitment 18

**The plan is cut against the budget, and the trade-offs are said in plain words.** `team plan
    "<goal>"` breaks the goal into items with a role and an estimate in tokens per model class,
    machine time and heavy slots (steps 1 and 3 of §1); it reads every account's figures (commitment
    15) and places each item on the account and the lab where it pays, defers to a reset what no
    window carries, and places heavy runs in the machine's slots (Runtime commitment 52; `team
    lock`); it prints the timing with its cost per account and the alternatives with theirs, one
    sentence each; and it writes nothing until the owner, or a delegate he named, approves, when the
    items become records of the source (commitment 2) in the plan's order (commitment 11) and the
    queue the seats pull (commitment 5). An estimate is kept beside the item and compared with what
    happened (commitment 12; 010 commitment 5; 004). A plan is a proposal to whoever may approve it,
    never an intake rule and never a pull.

The source flow's assignment illustration is “Claude where it pays (the lead's turns, the design calls, the reviews the owner wants from it), other labs for builds and reviews”, with work deferred to a reset when a window cannot carry it and heavy runs placed in the machine's slots. Its timing illustration is “Tuesday within budget; Monday if you allow 4% more Anthropic this week”, with the figure each option costs on each account. These are proposal illustrations, not fixed lab assignments, actual readings or authorization to raise a budget; the owner's approval is still required.

The proposed historical-cost input to these estimates is specified in §7.3. An estimate remains distinct from an observed outcome, and unavailable history is unknown rather than a zero-cost precedent.

#### Planning commitment 19

**Budget events are raised on the bus, and the owner hears the floor at once.** Five kinds, in
    002's form (the accepted amendment 01), each carrying the account, the lab, the window, the used
    and left figures, the margin, the reset, the reading's age and source, and the mark crossed:
    `quota.pace-low` (level `warn` or `tighten`, and `last-call` at the floor's notice) to the lead
    and the operator, the owner in his summary; `quota.floor-reached` to the lead, the operator and
    the owner at once, a decision that needs him, a privileged kind no level
    removes a recipient from; `quota.seat-walled` (a seat whose account is walled or at a hundred
    percent, or whose screen shows a usage limit) to the lead and the operator at once; `quota.unknown`
    (an account that reads unknown or stale while seats run on it) to the operator; and
    `quota.recovered` (the margin back above `pace-tighten` for two readings) to the lead. Each event
    is raised once per crossing and re-armed when the window resets or the figure recovers (the watch contract).

#### Planning commitment 20

**The circuit breaker: four automatic actions, each a Runtime act under an owner policy, logged
    and reversible, loosening nothing.** When `budget-actions` is `act` (the policy of commitment 21),
    the Runtime does, on the event that names it:
    - **Swap an out-of-token seat.** On `quota.seat-walled`, the seat is relaunched on another account
      the entity declares (Runtime commitment 50: the launch accounts of the entity, the keychain
      reference and never the key), chosen as `team usage`'s advice chooses it, the account with the
      most headroom first; the seat keeps its registry id, its grants, its lease and its item (the
      Runtime's commitment 2; 008 commitment 7), and the swap waits for the seat's idle prompt, never
      cutting a turn. The target respects the cross-lab review rule (Kernel §5): a reviewer never
      lands on the lab of the authors it reviews, and a swap that would is refused and said. The lead
      is told, and the seat is not swapped back by itself (question 4).
    - **Refuse `add` and `up` on a drained account.** The launch gate refuses a seat whose account is
      inside its reserve, at its spend floor, walled, or past the pace floor, naming the figure, the
      window, the age and the accounts with room (the launch-gate contract); unknown is said and refuses nothing.
    - **Batch the leads' reports.** On `pace-low` at `tighten`, the leads' reports to the owner and to
      each other go to the batched cadence (`report-cadence` tightened to its batched value; 010
      commitment 6), and the leads' own Claude turns are advised lean (`pace-conduct`, advised).
    - **Hold non-release work on the account at the floor.** On `quota.floor-reached`, `team next`
      refuses a pull onto a seat of that account unless the item is release-critical (an item of the
      open release round, 010 commitment 11, or one the owner marked), the plan is re-cut onto the
      other accounts (commitment 18), and a `team hold` records the reason (Runtime §10, question 7);
      the owner's answer lifts the hold or widens the floor, and nothing else does.
    Every action writes a record with its before and after (`quota.action`: the event, the act, the
    seat or the account, the policy level that allowed it) and its reversal when `quota.recovered`
    says so or when the lead reverses it by hand; an action that cannot be recorded does not happen
    (Kernel §15). None loosens anything: a swap moves a seat within the entity's declared accounts
    and never adds one, a refusal refuses, a batching delays, a hold holds.

#### Planning commitment 21

**All of it is the owner's to set, and the actions are off until he turns them on.** The settings
    of this chapter, each in the catalogue's form (amendment 02), scoped entity, project, team, seat,
    inheriting downward and tightening only: `pace-warn`, `pace-tighten`, `pace-floor` (points of
    margin, per account or lab; tighter is nearer zero); `budget-marks`, `budget-reserve`,
    `budget-floor` (the reading specification’s three, as policies beside the team file's section); `unknown-is-spent`
    (`off` for subscriptions, `on` for spend; tighter is `on`); `budget-actions` (`off`, `advise`,
    `act`; the default `advise` prints what `act` would do, `act` does it; tighter is `off`, and a
    lower level may turn actions off and never on); `release-critical` (how an item is marked so: the
    open round's items, a label, or the owner's list); `swap-targets` (the accounts a swap may land
    on, a subset of the entity's declared accounts; tighter is fewer). Four things hold whatever is
    set: unknown is never plenty; no action loosens a limit; the owner hears the floor at once; a
    credential is never read.

#### Planning commitment 22

**Costs are real, and a subscription's cost is what it actually lands.** The owner's requirement
    of 2026-10-14 (the reading specification’s requirement update; the real-cost requirement): the budget reports actual spend per seat, per
    model and per team, from the provider's usage or billing data or from measured tokens at real
    prices, never estimates alone; and for a subscription both the billed spend and the effective cost,
    the fee amortised over use plus the quota consumed. The plan's estimates (commitment 18) are in
    the same units, so an estimate and its real cost sit side by side (004; 010 commitment 18's daily
    report).

The hierarchical token and money records, CLI sources and views extending this commitment are specified in §7.3.


### 7.2. Questions preserved from the chapter

The default unit (account or lab), the last-call point, swap-back, release-critical marking authority, recovery hysteresis, delegation to enable actions and whether plan approval reserves the spend envelope remain open. Cost units are input/output/cache tokens and money where known; price, allocation and estimation details remain open in §7.3. The source’s “four kinds” is an editorial slip corrected to five; all five are preserved. In both mark clauses, a margin nearer zero is tighter; this clarifies the existing wording and settles nothing further. The action record is named `quota.action`, without settling whether it is also a bus kind.

Current quota margin and two-point budget pace have different units; the proposed language conflates them. Unknown-is-spent is unimplemented; the spend envelope remains unbuilt, while current unknown subscription readings refuse no launch. Credential access stays in an owner-declared check or a future launch mechanism; reporting never opens a credential. A future swap waits for idle, preserves identity and task, respects independent review, changes no account declarations, and is not swapped back automatically. Every proposed action records before, after and reversal and does not happen if it cannot be recorded. It never loosens a limit.

### 7.3. Proposed cost accounting and views; not implemented

This is the proposed interface for Planning commitments 18 and 22. It extends the real-cost requirement; it does not change the implemented command contract in §4 or claim a shipped collector, registry schema or view. No proof exists yet for this extension. The fields below are a logical format inventory for review; wire names, schema version and exact encodings remain to specify.

#### Attribution and record shape

One turn's observed usage belongs to its **agent (the occupant's session) → seat → team → project → entity**. Costs roll up through that registry hierarchy, in **input, output and cache tokens**, and **money where known**, by **day, week and release**. A CLI session total is not itself a per-turn measurement; source granularity remains explicit until the turn runner supplies one record per turn. Parent totals summarize the same usage rather than introducing another charge.

| Logical field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| Attribution | registry references for agent, seat, team, project, entity | yes | no invented reference | planned | Agent identifies the occupant's session; the chain places usage in its owning scopes. |
| Turn / session | source reference plus granularity | yes | unknown turn when only session usage is exposed | planned | Separates a session observation from a measured turn; exact identity and update/deduplication rules remain to specify. |
| Measurement time | timestamp | yes | none | planned | Assigns usage to reporting periods; exact encoding and period boundaries remain to specify. |
| Input tokens | nonnegative count or unknown | yes | unknown | planned | Input usage exposed by the CLI, not a missing figure replaced by zero. |
| Output tokens | nonnegative count or unknown | yes | unknown | planned | Output usage exposed by the CLI. |
| Cache tokens | source-labelled count(s) or unknown | yes | unknown | planned | Preserves the source's cache categories; reconciliation with input and any combined total remains to specify. |
| Money | amount, currency and basis, or unknown | yes | unknown | planned | Uses the entity's account: subscription or API price, stated as such. Billed and effective subscription costs stay distinguishable. |
| Source | CLI/collector identity and evidence reference | yes | none | planned | Names where the figures came from, their granularity and any unverified support. |
| Account / model | observed or registry references | when known | unknown | planned | Explains whose resource was spent and on which model; does not invent an allocation. |
| Task / handover | task and handover references | for task attribution | absent until attributed | planned | Connects usage to the task whose handover supplies its cost. |
| Release | release reference | for release attribution | absent until attributed | planned | Defines the release membership needed for a release-cost view. |

Records live in the registry under its usual grants. These views do not widen a caller's access. Collection uses the CLI's exposed usage output or turn-runner result, not a new credential or session-file reader. Monetary figures retain their account, currency and stated basis; no unpriced tokens or quota percentage are silently converted into money.

An unexposed quantity is **unknown, never zero**. A known zero remains a measured zero. If only part of a roll-up is known, the view preserves that incompleteness instead of presenting the known subtotal as the complete cost; the exact coverage encoding is still open. Estimates are labelled separately from measured costs.

#### Per-CLI sources to collect and verify

These are the proposed sources, not claims that their collectors or all their metrics are verified at either pinned revision.

| CLI / collector | Proposed source | Granularity or verification boundary |
|---|---|---|
| Claude Code | Per-turn usage in JSON print mode; session cost | Retain the distinction between the turn's tokens and a session-level cost. |
| Codex | `codex exec --json` | Verify exposed token, cache and money fields; unexposed figures stay unknown. |
| Grok | `grok usage <session>` | Session source; verify its exposed fields and do not label the whole session as one turn. |
| Antigravity | Its JSON output | Per-CLI usage fields and support remain to verify. |
| Cursor | Its JSON output | Per-CLI usage fields and support remain to verify. |
| Turn runner | One usage/outcome record per turn | Planned collection boundary for exact per-turn attribution. |
| Other profiles | No source named by this proposal | Unknown until a source is specified and verified. |

#### Views and planner input

Proposed hierarchy-view synopsis, separate from the shipped synopsis in §4:

```text
team usage --by entity|project|team|seat|agent [--since …]
```

The bars select one grouping. The time-filter grammar and defaults remain to specify; no new exit id or JSON schema is asserted here.

| View | Proposed content | Unknown handling / unresolved interface |
|---|---|---|
| Usage by hierarchy level | Input, output and cache tokens; money where known; day, week and release breakdowns within the permitted scope | Keep missing dimensions and incomplete coverage visible. Exact period selection and output schema remain open. |
| Cost of a task | Usage attributed through the task's handover record, with observed cost beside its estimate | Unattributed or unavailable usage is not zero; command and handover field encodings remain open. |
| Cost of a release | Usage belonging to the release, preserving the same units and provenance | Release membership and attribution rules remain open. |
| Top spenders | Ranked spenders and what they spent on, with the grouping and measure stated | Unknown spend is not ranked as zero; token/cache comparison and cross-currency ordering remain to specify. |
| Planner input | Recorded past costs used to estimate proposed work, retaining evidence and matching units for later outcome comparison | No history means unknown, not free work. Selection of comparable history and the estimation method remain open. |

#### Staged delivery and remaining format questions

| Target | Planned result | Status |
|---|---|---|
| 0.5.2 | Collect per-seat usage from CLIs that expose it now; add `--by` views | Planned, not an interface at either pinned revision. |
| 0.5.3 | Exact per-turn records through the turn runner | Planned. |
| 0.6 | Per-task and per-release costs feeding the planner | Planned. |

Still to specify: record identities and updates without double counting cumulative readings; cache-category normalization; day/week timezone and boundaries; release membership and task/handover attribution; price provenance and versioning; subscription allocation; incomplete-coverage encoding; view schemas, filtering, ranking and exits; and the planner's comparison/estimation method. These details do not reopen the hierarchy, required units, unknown rule, views or use of past costs.

## Revision log

- **Draft** (2026-10-18): lifted chapter H mechanics and proposed detail; read implementation at v0.5.0 and compared budget and reporting files at int/0.5.1 8acb470b, unreleased. No automatic budget action is claimed built.
- **Cost-accounting fold** (2026-10-18): §7.3 adds the proposed cost hierarchy, logical record inventory, per-CLI sources, unknown handling, usage/task/release/top-spender views, historical-cost estimates and staged delivery. The implemented formats and command contract are unchanged.

- **Editorial review fold** (2026-10-19): restored the source flow's assignment and Tuesday/Monday budget illustrations in §7.1, explicitly illustrative and unbuilt; no threshold, command or authorization changed.
