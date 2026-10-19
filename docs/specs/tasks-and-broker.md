---
created: 2026-10-18
updated: 2026-10-18
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Planning; Runtime
public: staged for review; contains no private links
---

# Spec: tasks and broker

## 1. Scope

This spec covers the task-source section, canonical records, local leases, the broker wire protocol and field filtering at v0.5.0. It describes implemented reads and claims, and labels unimplemented intake, progress and timing features in §7. Operational authority and the record ledger belong to their own specifications.

## 2. Terms

- `file`: read-only YAML task source inside the checkout.
- `linear`: bounded tracker source read inside the broker.
- `TaskRecord`: the typed record shared by both adapters.
- `TaskRefusal`: source position and reason for an invalid record.
- `Lease`: local, unsigned claim held by a seat and pane.
- `read`: the only broker wire operation implemented at the tag.

## 3. Formats

### 3.1. The task-source section

The owner writes `tasks` in the team file. The section is owner-controlled, permits one source and rejects unknown keys. An omitted section is `null`, with no guessed backlog. Source: `src/file/sections/tasks.ts`; proof: `test/issues.test.ts`, `test/next.test.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| source | file or linear | yes | none | present at 0.5.0 | One source per team. |
| path | relative path | file only | absent | present at 0.5.0 | Inside checkout, including symlink resolution; absolute, tilde, backslash, NUL and escaping traversal refused. |
| linear.project | nonempty string | linear only | absent | present at 0.5.0 | The sole tracker project. |
| linear.keychainService | nonempty string | linear only | absent | present at 0.5.0 | Credential service reference, read only by broker. |
| pull | self or any | no | self at use | present at 0.5.0 | Self allows unassigned or own assignments; any allows every assignment. |
| fallback | file or id | no | file at use | present at 0.5.0 | Tie-break for records without a priority. |
| cadence | positive duration, s/m/h | no | absent | present at 0.5.0 | Paces next --wait only; zero refused. |
| policy | TaskPolicy | linear only | default field set | present at 0.5.0 | Rejected with file source. |

### 3.2. Task records and refusals

The owner writes a YAML list for the file adapter; the tracker adapter maps one response to the same record. `[]` is a valid empty file. Source: `src/tasks/file.ts`, `adapter.ts`, `linear.ts`, `src/broker/protocol.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| id | string | yes | none; omitted stays absent | present at 0.5.0 | Task token: /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/; file adapter checks it, broker checks final transformed tracker id. |
| title | string | yes | none; omitted stays absent | present at 0.5.0 | Nonempty single line, at most 200 characters. |
| priority | number or text | no | none; omitted stays absent | present at 0.5.0 | Finite number or nonempty single-line text. Tracker numeric zero and below map to absence. |
| assignee | string | no | none; omitted stays absent | present at 0.5.0 | Nonempty single line; tracker assignee.displayName. |
| milestone | string | no | none; omitted stays absent | present at 0.5.0 | Nonempty single line; tracker projectMilestone.name. |
| deadline | string | no | none; omitted stays absent | present at 0.5.0 | Nonempty single line; tracker targetDate; parsing time belongs to plan display. |
| blocked-by | task id[] | no | none; omitted stays absent | present at 0.5.0 | File/policy spelling; typed and wire spelling blockedBy. |
| repos | string[] | no | none; omitted stays absent | present at 0.5.0 | Nonempty single-line names; empty list allowed. |
| needs | string[] | no | none; omitted stays absent | present at 0.5.0 | Nonempty single-line names; empty list allowed. |
| description | string | no | none; omitted stays absent | present at 0.5.0 | Nonempty, at most 4000 characters; multiline allowed. |

Unknown fields, malformed values and repeated accepted ids yield `{index, id?, reason}`; `index` is one-based and `id` appears only if accepted. A refused record does not reserve its id. A read is `{kind: "missing"}`, `{kind: "not-a-list"}`, `{kind: "outside"}`, or `{kind: "records", records: TaskRecord[], refusals: TaskRefusal[]}`. No task lifecycle state, estimate or author field exists. Proof: `test/issues.test.ts`, `test/linear.test.ts`, `test/broker.test.ts`.

Test fixture excerpt (`test/next.test.ts`, task fields only):

No standalone YAML example selected; the source tests contain fixture builders.

### 3.3. Local lease

The claim command writes `.agents/leases/<id>.json` under the leases-directory lock, atomically. Linked worktrees resolve to the main checkout’s state; another clone or machine is outside this guarantee. Source: `src/tasks/lease.ts`; proof: `test/next.test.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| format | literal 1 | yes | none | present at 0.5.0 | Lease format. |
| id | string | yes | none | present at 0.5.0 | Claimed task id. |
| seat | string | yes | none | present at 0.5.0 | Holder name. |
| pane | string | yes | none | present at 0.5.0 | Recorded holder pane. |
| acquiredAt | ISO timestamp | yes | none | present at 0.5.0 | First claim time. |
| renewedAt | ISO timestamp | yes | none | present at 0.5.0 | Last renewal. |
| until | ISO timestamp | yes | none | present at 0.5.0 | Renewal time plus 30 minutes; fixed, not a setting. |

A live lease is one whose parsed `until` is strictly after the clone’s current clock. Re-running `next` renews the holder’s live lease if the record remains in the read; when missing, it keeps that lease and takes no second id. Release removes the caller’s files, including expired files, and records no progress. Expired or malformed files may be replaced. The lease is unsigned; no automatic renewal runs during work. An expiry permits duplicated work; idempotency and automatic renewal are unimplemented design obligations.

### 3.4. Broker request and answer

The foreground owner process binds `.agents/broker.sock`; starts serialize beside it. One JSON line each way, with `MAX_REQUEST_BYTES = 64 * 1024`, `MAX_ANSWER_BYTES = 4 * 1024 * 1024` and a five-second client deadline. The implementation compares the UTF-8-decoded string’s `.length` to those nominal byte constants; it does not count encoded octets. Source: `src/broker/protocol.ts`, `client.ts`, `server.ts`; proof: `test/broker.test.ts`, `test/broker-contract.test.ts`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| op | literal read | request | none | present at 0.5.0 | Exactly op, seat and pane; extra keys rejected. |
| seat / pane | string | request | none | present at 0.5.0 | Nonempty, up to 200 characters; no LF, CR or NUL; claimed placement, no token. |
| ok / read / notice? | true / TaskRead / nonempty string | success | notice absent | present at 0.5.0 | Unknown keys and malformed read shapes rejected whole. |
| ok / at / message | false / caller or read / nonempty string | refusal | none | present at 0.5.0 | Distinguishes placement refusal from failed read; internal failure details stay at broker terminal. |

The broker reads the credential once from the system key store in an interactive supported-platform owner run. It checks the declared seat and recorded pane before serving the read. A second live broker refuses; a stale socket needs two observations with a turn between; a non-socket path is never removed or bound over. Private temporary files name the writer for the start lock and takeover claim. Nothing supervises or restarts the process. Same-user reach remains: these are accident guards, not hostile-process authentication.

### 3.5. Field policy and tracker adapter

The team owner writes `tasks.policy` for `linear` only. `allow` lists the fields and must include `id` and `title`; `omit` removes fields from the default set and must include neither. The two cannot be combined. Default: all typed fields except `description`; description crosses only through explicit `allow`. `transform: {id: bare}` is the sole transform: last nonempty slash-separated segment, including refusal ids; a refusal id with no segment is omitted. A missing field remains absent. Source: `src/broker/policy.ts`, `src/file/sections/tasks.ts`, `src/broker/server.ts`; proof: `test/broker.test.ts`.

The broker applies the policy after adapter mapping and before serialization. It validates final transformed ids and duplicates at their source positions. The Linear adapter makes one POST to the fixed `LINEAR_URL`, one Authorization header, no redirects, a bounded timeout and body; it reads the first 100 issues of exactly one project. The query selects identifier, title, priority, assignee.displayName, projectMilestone.name, targetDate and description; it selects no state and sends no filter. Project identity and a Boolean `pageInfo.hasNextPage` are required. A second page is never read; `hasNextPage` prints “the tracker holds more tasks than this read; the take still proceeds”. Archived issues are omitted by the tracker default, not an explicit tool filter. Source: `src/tasks/linear.ts`, `src/release/http.ts`; proof: `test/linear.test.ts`.

## 4. Commands and options

Exact owned entries from `contract/cli.json` at v0.5.0:

```json
[
  {
    "flags": [
      {
        "hidden": false,
        "name": "--help",
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
    "name": "broker",
    "positionals": [],
    "subcommands": [],
    "usage": [
      "team broker"
    ]
  },
  {
    "flags": [
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
        "hidden": true,
        "name": "-h",
        "repeatable": false,
        "takesValue": false
      }
    ],
    "hidden": false,
    "name": "issues",
    "positionals": [],
    "subcommands": [],
    "usage": [
      "team issues [--json]"
    ]
  },
  {
    "flags": [
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
        "name": "--mine",
        "repeatable": false,
        "takesValue": false
      },
      {
        "hidden": false,
        "name": "--release",
        "repeatable": false,
        "takesValue": false
      },
      {
        "hidden": false,
        "name": "--wait",
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
    "name": "next",
    "positionals": [],
    "subcommands": [],
    "usage": [
      "team next [--mine | --release] [--wait] [--json]"
    ]
  },
  {
    "flags": [
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
        "hidden": true,
        "name": "-h",
        "repeatable": false,
        "takesValue": false
      }
    ],
    "hidden": false,
    "name": "plan",
    "positionals": [],
    "subcommands": [],
    "usage": [
      "team plan [--json]"
    ]
  }
]
```

Exit identifiers and codes are in [exit-codes](registries/exit-codes.md); this area uses the `issues.*`, `next.*`, `plan.*` and `broker.*` rows. Broker has no JSON option. `next --mine` conflicts with `--release`; `--wait` conflicts with `--release` and `--json`, and requires cadence.

## 5. Rules

1. A file read MUST stay inside the checkout and return each valid record or its indexed refusal. Source: `src/tasks/file.ts`, `src/file/sections/tasks.ts`; proof: `test/issues.test.ts`.
2. A broker read MUST withhold its own credential and apply field policy before the answer crosses. It does not scrub secrets a person wrote in task prose. Source: `src/broker/server.ts`, `src/tasks/linear.ts`, `src/broker/policy.ts`; proof: `test/broker.test.ts`, `test/linear.test.ts`. The design also names environment secrecy; no cited test reads the seat environment.
3. A pull MUST pass the declared-seat and recorded-pane placement gate; the owner and undeclared names are refused. Source: `src/commands/next.ts`; proof: `test/next.test.ts`.
4. The takeable set MUST exclude nonempty `blockedBy`, `repos` or `needs`. With `self`, assignments are absent or the caller’s; `--mine` accepts the caller’s only; `any` imposes no assignee filter. This is not scope/skill/blocker resolution and escalates nothing. Source: `src/commands/next.ts`; proof: `test/next.test.ts`, `test/plan.test.ts`.
5. Ordering MUST be numeric priority ascending, text priority by locale comparison, then absent priority. Equal numeric or text priorities retain input order; `fallback: id` sorts only the absent-priority group. Source: `src/commands/next.ts`; proof: `test/next.test.ts`.
6. Local claims MUST serialize on the leases lock so two live leases in one clone do not cover one id. No tracker write or remote claim occurs. Source: `src/tasks/lease.ts`, `src/commands/next.ts`; proof: `test/next.test.ts`.
7. `plan` MUST show the takeable ordered queue without a claim or write; a held item may appear. A parseable deadline strictly before now is `overdue` and decides nothing; unknown dates remain `open`. `issues` lists file order without this placement gate and refuses the broker source. Source: `src/commands/plan.ts`, `issues.ts`; proof: `test/plan.test.ts`, `test/issues.test.ts`.
8. The wait loop MUST pause at the fixed positive cadence while empty; it emits the empty answer once, and ends on a claim, refusal, signal or nonadvancing clock. It has no back-off or quiet hours. Source: `src/commands/next.ts`; proof: `test/next.test.ts`.

## 6. Registries

### operations

`next` | pull by a declared seat on its recorded pane | present at 0.5.0 | `src/permissions/map.ts`, `src/commands/next.ts` | read-surface row; actual command uses placement
`use-broker` | operational capability naming broker use | present at 0.5.0 | `src/permissions/grants.ts`, `src/permissions/map.ts` | vocabulary exists; not gated at the broker

### exit-codes

`issues.*`, `next.*`, `plan.*`, `broker.*` | task listing, claim, plan and broker outcomes | present at 0.5.0 | `contract/exit-codes.json` | expand every id verbatim in the registry

## 7. Open points

The owner-set intake agreement and escalation path are not implemented. Proposed alternatives are an enforced `task-intake` policy or owner-controlled `tasks.intake`; neither spelling is implemented or decided. Nonempty repository, skill and blocker lists make an item untakeable for everyone. No source state field prevents completed tracker items from being pulled. Lease renewal during work, configurable duration, safe retry records, pulls/releases/expiry history, tracker claims and writes, deadlines as notices, back-off, quiet hours and estimates are unimplemented. Multiple sources are deferred. The broker gates placement rather than `use-broker`; its three conceptual operations (pull, claim, read non-secret fields) have only the read wire operation here. Direction, priorities, assignments and acceptance remain human or a named delegate’s; task completion reports confer no acceptance.

The order implementation narrows the source’s “fallback” wording: `id` applies to missing priority, not all equal priorities. This spec states the code’s rule without deciding a change. `team broker` is outside gate-lifting at this tag; the older draft’s proposed removal is already built.

## Revision log

- **Draft** (2026-10-18): lifted formats and mechanics from Planning commitments 1–14; reread from v0.5.0 with source-test pointers. First-introduction releases were not audited; “present at 0.5.0” is a snapshot label.
