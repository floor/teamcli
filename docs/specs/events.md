---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: int/0.5.1 (8acb470b), unreleased
for: Amendment 01 to Communication (module 002, v2 draft)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: events

## 1. Scope

This spec covers the event half of a bidirectional `team send`: the signed event record and its
log, the bus that appends and serves it, the routing policy that says who receives which kind, and
the message's life after a send's outcome (status, thread, reply). The message record itself, the
history line and the admission rules are the messaging spec's; this spec borrows them unchanged.

## 2. Terms

- **event** — a signed record in the project's event log, appended by the bus when a durable record
  changes; it says what happened, when, to which record, and nothing else.
- **event log** — `events.jsonl` in the project's state folder, sequence-numbered, rotated.
- **bus** — the process that owns the event log: `team bus`, beside the broker, over
  `.agents/bus.sock`.
- **cursor** — a subscriber's position in the log: a sequence number.
- **gap** — the bus's answer when a cursor is older than the oldest event the log keeps.
- **kind** — an event's closed-world word (`message.arrived`, `seat.idle`, …).
- **privileged kind** — a kind no seat may subscribe itself to and only the owner routes.
- **status** — a message's derived state after the send's outcome: `sent`, `delivered`, `read`,
  `replied`, `held`.
- **thread** — the first message's id; a reply carries it and `in_reply_to`.
- **subscription** — a seat's registration on the bus: its agent id, its pane, its cursor.

## 3. Formats

### The event record

Lives in `<project state folder>/events.jsonl` (beside `messages.jsonl`), written by the bus alone;
one JSON line per event, a `payload` and its `signature` (Ed25519, the checkout's message key,
domain `team.event.v1\n`). The log mints monotonically increasing sequence numbers (`seq: 1, 2,
…`), writes atomically, and rotates: retained files `events.jsonl`, `.1`, `.2`, at most 100 MB in
all; retention drops declare themselves with one signed `team.event-log-dropped` record naming the
dropped sequence range. Fields (`src/bus/log.ts`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `v` | `1` | yes | — | 0.5.1 | the record's version |
| `seq` | number | yes | minted | 0.5.1 | the log's sequence number, in order |
| `ts` | string (ISO-8601) | yes | — | 0.5.1 | when the event was appended |
| `kind` | event kind | yes | — | 0.5.1 | what happened (the kinds table) |
| `session` | string | yes | — | 0.5.1 | the team file's session |
| `record_id` | string | yes | — | 0.5.1 | the durable record the event is derived from |
| `from` | string | no | absent | 0.5.1 | the sender, on message events |
| `to` | string | no | absent | 0.5.1 | the recipient, on message events |
| `seat` | string | no | absent | 0.5.1 | the seat, on seat events |
| `subject` | string | no | absent | 0.5.1 | the subject seat, where a table row names one |
| `thread` | string | no | absent | 0.5.1 | the thread the record belongs to |
| `via` | string | no | absent | 0.5.1 | the leg a delivery went by |
| `reason` | string | no | absent | 0.5.1 | a short reason (`retention` on a retention drop) |
| `prompt` | string | no | absent | 0.5.1 | the prompt's kind on `seat.at-prompt` |
| `rule` | string | no | absent | 0.5.1 | the rule named, on a refusal |
| `dropped_oldest_seq` | number | no | absent | 0.5.1 | on `team.event-log-dropped`: the oldest sequence retention has dropped |
| `dropped_newest_seq` | number | no | absent | 0.5.1 | on `team.event-log-dropped`: the newest sequence the pass dropped |

An event carries no body and no instruction.

### The message's status and thread

The message record is the messaging spec's; at the tip it carries `from`, `from_id`, `to`, `to_id`,
`rule`, `thread` and `in_reply_to` beside the v0.5.0 fields, and its status is derived, never
edited, from its receipts in the event log's order, moving forward only (`src/commands/messages.ts`).
The status words:

| Status | Meaning |
|---|---|
| `sent` | the record exists and a transport took it |
| `delivered` | the transport confirmed the seat's program has it (the inbox fetched it, the drop watcher receipted it, or the typed outcome was `delivered`) |
| `read` | the seat's own tool showed the body |
| `replied` | a record on the thread answers it |
| `held` | the record waits: a dialog, unsent text in the box, or an unreachable seat; the side and reason named |

`held` is one word on two records: an attempt's outcome, and the message's status while no later
attempt has. `not-submitted`, `timeout`, `unreachable` and `refused` stay outcomes of an attempt,
never statuses.

### The kinds table

Closed-world (`src/bus/kinds.ts`, `EVENT_KINDS`): thirty kinds at the pinned ref, each cited to
its line. Default recipients: "lead" is the seat whose role holds `leads`; "operator" is the team
file's operator seat; "sender" and "subject" are the records' own fields; the routing policy's
defaults are the table.

| Kind | Raised when | Default recipients | Source (`src/bus/kinds.ts` at 8acb470b) |
|---|---|---|---|
| `message.arrived` | a record is written for a seat | the recipient (this is the delivery) | line 57 |
| `message.delivered` | a receipt is appended | the sender | line 58 |
| `message.read` | a receipt is appended | the sender | line 59 |
| `message.replied` | a receipt is appended | the sender | line 60 |
| `message.held` | a record waits with a reason | the sender, and the lead after `held-threshold` | line 61 |
| `seat.working` | the seat state changes to `working` | nobody: the bus and the watch read it; a lead that wants it adds itself | line 63 |
| `seat.idle` | the seat state changes to `idle` | nobody, as `seat.working` | line 64 |
| `seat.idle-timeout` | a seat has been `idle` past `idle-threshold` with no `--wait` open on it and no lease held | the lead | line 65 |
| `seat.blocked` | the state reads `blocked`, with the prompt's kind | the lead and the operator | line 66 |
| `seat.at-prompt` | the seat waits at a prompt, with the prompt's kind | the lead and the operator; the owner for a permission, trust, login or vendor prompt | line 67 |
| `seat.unreachable` | the seat cannot be reached | the lead and the operator; the owner for the lead's own seat | line 68 |
| `seat.done` | the process left its pane | the lead and the operator; the owner for the lead's own seat | line 69 |
| `work.claimed` | a lease is taken | the lead; the task's author where the record names one | line 71 |
| `work.done` | a lease is finished | the lead; the task's author where the record names one | line 72 |
| `work.released` | a lease is let go | the lead; the task's author where the record names one | line 73 |
| `work.gate` | a gate stamp is written, green or red | the lead and the branch's author; a red on the integration tip to every seat holding `merge` on it, and to the operator | line 74 |
| `work.suite` | a suite report is written, green or red | as `work.gate` | line 75 |
| `team.seat-added` | the roster changes | the lead, and the owner | line 77 |
| `team.seat-removed` | the roster changes | the lead, and the owner | line 78 |
| `team.seat-reloaded` | the roster changes | the lead, and the owner | line 79 |
| `team.grant-issued` | a grant record is written | the lead, the subject seat, and the owner | line 80 |
| `team.grant-revoked` | a grant record is revoked | the lead, the subject seat, and the owner | line 81 |
| `team.grant-expired` | a grant record passes its expiry | the lead, the subject seat, and the owner | line 82 |
| `team.policy-changed` | a policy value is set at any level | the lead, the subject seat, and the owner | line 83 |
| `team.policy-refused` | a routing change is refused, naming the rule, the requester and the kind | the owner, the implementation's default; the accepted amendment names the lead and the owner (§7) | line 84 |
| `release.ready` | the lead's own words to the owner (`team raise`): a release is ready | the owner | line 87 |
| `decision.needed` | the lead's own words to the owner (`team raise`): a decision is needed | the owner | line 88 |
| `record.invalid` | a record failed its check | the owner | line 90 |
| `security.refused` | a guarded act was refused | the owner | line 91 |
| `team.event-log-dropped` | retention dropped a sequence range | declared in the log itself | line 94 |

The prompt kinds on `seat.at-prompt` whose default routing includes the owner: `permission`,
`trust`, `login`, `vendor notice`, `rate limit` (`OWNER_PROMPT_KINDS`).

## 4. Commands and operations

### `team bus`

```
team bus
```

Runs the event bus for this clone over `.agents/bus.sock`, appending signed event records to the
project's event log and reconciling durable message and seat records. Only the owner runs it, from
a terminal outside the pane manager. Ctrl-C stops it. Exit codes: `bus.started` (0), `bus.stopped`
(0), `bus.refused` (1), `bus.configuration` / `bus.usage` (2).

The bus's two operations on the socket: `subscribe` (a seat by registry id, its pane, a cursor — a
sequence number) and `publish` (a runtime tool handing it a record that changed). Each subscriber
gets a bounded buffer; one that was away reads from its cursor. When records between the cursor and
the oldest retained sequence are missing, the answer is `gap` with `oldest_seq`, and the subscriber
resyncs from the underlying records before following on.

### `team reply`

```
team reply <id> [<text>] [--close] [--json]
team reply <id> --close
```

Replies to the sender of the message record `<id>`, or closes its thread. A reply is a signed
record in the sender's folder, on the same thread; it is admitted while the thread is open.
`--close` ends the thread, and a later reply opens a new one that cites the closed thread's last
record. Exit codes: `reply.replied` (0), `reply.refused` (1), `reply.configuration` /
`reply.usage` (2).

### The MCP inbox

The launch installs an MCP server in a Claude seat's session (`src/mcp/inbox.ts`) that holds a
subscription on the bus. A message or event for the seat arrives as a notice on the next tool
round — a count and a cursor, one line per tool round however many arrived, never one line per
event. The seat's own fetch is the `delivered` receipt; reading a body with the inbox tool is the
`read` receipt, shown as a message from the seat named on the record after the signature check; the
reply tool writes the reply record. Nothing is typed into the pane.

### The delivery order, with `drop`

`DELIVERY_LEGS` at the tip: `native`, `mcp-inbox`, `typed`, `drop`. The fallback order
(`src/settings/inherit.ts`): `mcp-inbox`, then `drop`, then `typed`.

- `mcp-inbox` takes a send only while the seat's own inbox server is listening, and writes the
  message to that inbox without typing; otherwise it is skipped as `no live inbox listener`.
- `drop` writes the same 0600 file and types nothing at all: a receiver that watches its folder —
  the inbox server where its CLI has an MCP front, the launch's start-of-turn read where it has a
  hook — takes the message there, and a seat that watches nothing never walks this leg.
- `typed` stays the last fallback.
- `native` is not in the default: a level that names it is the sender choosing its own
  cross-session channel and recording the delivery itself; it is the one leg a declared word may
  add.

## 5. Rules

1. **The bus alone appends.** An event is appended by the bus when a durable record changes: a
   message's status, a seat's state, a piece of work, the roster, a grant, a policy. (Proof: the
   bus log tests at the tip.)
2. **The record is the truth; the event is derived.** A subscriber applies events in sequence and
   drops one it has seen, so a duplicate or a reordered delivery changes no state; whoever doubts
   an event reads the record it names.
3. **A stale cursor is a `gap`, never silent loss.** When `cursor + 1 < oldestSeq`, the bus answers
   `gap` with `oldest_seq`; the subscriber resyncs from the records (its messages folder, the seat
   states, the leases, the file) before following on. A retention drop declares itself with a
   signed `team.event-log-dropped` record naming the range. (`src/bus/log.ts`,
   `readEventsFromCursor`.)
4. **The reconcile pass re-raises.** At the bus's start and every `reconcile-interval`, the bus
   lists the durable records with no event (a message record with no `arrived`, a receipt with no
   event, a seat state newer than its last event) and raises them: a tool that crashed between its
   record and its publish loses time, never the event. (`src/bus/reconcile.ts`.)
5. **Routing is a policy.** `event-routing`, in the policy catalogue's form. Scope: entity,
   project, team, seat. Values: a map from event kind to recipients, each a position (`lead`,
   `operator`, `sender`, `subject`, `owner`) or a seat by registry id. Default: the kinds table.
   Set by: the owner at any scope; a holder named by grant at project or team for non-privileged
   kinds; a seat for itself only by adding itself, never to a privileged kind. (`src/bus/routing.ts`,
   `src/policy/events.ts`.)
6. **No self-subscription to a privileged kind.** The built-in privileged kinds are
   `seat.at-prompt`, `team.grant-issued`, `team.grant-revoked`, `team.grant-expired`,
   `team.policy-changed`, `team.policy-refused`, `record.invalid` and `security.refused`
   (`DEFAULT_PRIVILEGED_KINDS`); the owner may grow the set through `privileged-kinds`, and no level
   below the owner may remove any of them or self-subscribe to one. The default recipients of a
   privileged kind stand at every level. A seat that is a default recipient is not self-subscribing:
   the ban is on the seat's own act.
7. **A refusal is visible.** The bus refuses the write, names the rule `privileged-self-subscription`
   with the requester and the kind, appends a refusal record to the operational log, and raises
   `team.policy-refused` to the owner — the implementation's default at the pinned ref
   (`src/policy/events.ts`, used by `src/bus/routing.ts`). The accepted amendment names the lead
   and the owner; §7 keeps both positions for reconciliation. (`PRIVILEGED_SELF_SUBSCRIPTION_RULE`,
   `src/bus/refusals.ts`.)
8. **Tighter is additive for recipients, shorter-only for thresholds.** A level may add recipients
   among its own seats and remove none a level above set; `held-threshold`,
   `unreachable-threshold` and `idle-threshold` tighten shorter only. The event log's retention has
   a default (`DEFAULT_EVENT_RETENTION_SECONDS`, derived from the thresholds' retention days).
9. **The owner is reached by the runtime, never through a seat.** What the policy routes to `owner`
   is delivered on the machine as a notification and in the owner inbox, with no seat in the path;
   a connector is one more delivery beside those, never the only one and never a gate.
   (`src/bus/owner.ts`.)
10. **Admission is checked when each record is written, replies included.** The thread adds one
    rule, `reply-on-open-thread`: a reply to the sender of a record on an open thread is admitted
    while the thread is open, neither seat has been removed, and no revocation or deny applies to
    the pair; the rule is named on the record, and the owner may switch it off per team. A thread
    admits nothing by itself.
11. **No typing into a pane a human types in.** A typed line is refused for the owner's own seat
    and for any pane the owner launched by hand; the leg is recorded unavailable with the reason
    and the next leg runs.
12. **Retry without blindness.** A held record is retried when the seat next subscribes or its
    state turns to `working` or `idle` (inbox), at the watcher's next pass (drop), or only on
    `seat.idle` (typed); several held records for one seat go as one wake line naming them all, or
    one per idle turn in order. A fall-through happens only on a definite failure before the send
    went through, never on a missing acknowledgement after one. A duplicate id is dropped by the
    receiver; a doubled receipt is dropped by its sequence.
13. **An event is not a message.** It carries no body and instructs nobody; the inbox verifies the
    signature before it shows a body, and an event that wakes a seat says something waits, not what
    to do. A subscription is not a capability.

## 6. Registries

- **event-kinds** (registries/event-kinds.md): the kinds table of §3 (thirty kinds), plus the
  prompt kinds `permission`, `trust`, `login`, `vendor notice`, `rate limit` and the built-in
  privileged kinds of rule 6 — all from `src/bus/kinds.ts` at the tip.
- **delivery-legs** (registries/delivery-legs.md): `drop` | the record written whole, nothing
  typed, the seat told by watching its folder | built at int/0.5.1 8acb470b, unreleased |
  `src/settings/inherit.ts` (`DELIVERY_LEGS`) | needs no bus.
- **policy-names** (registries/policy-names.md): `event-routing` (enforced by the bus),
  `privileged-kinds` (owner-sovereign, grows only).
- **exit-codes** (registries/exit-codes.json's rows): `bus.started`, `bus.stopped`,
  `bus.refused`, `bus.configuration`, `bus.usage`; `reply.replied`, `reply.refused`,
  `reply.configuration`, `reply.usage`.

## 7. Open points

- **The build holds thirty kinds; the accepted amendment's table as written names twenty-five.** The
  amendment's prose counts twenty-four and its §4.3 table adds `team.policy-refused`, so the table
  names twenty-five. The build at int/0.5.1 8acb470b adds five beyond that table — `release.ready`
  (line 87), `decision.needed` (line 88), `record.invalid` (line 90), `security.refused` (line 91)
  and `team.event-log-dropped` (line 94) — or six against the prose's twenty-four, counting
  `team.policy-refused` (line 84). The count to carry is thirty; the spec's §3 lists them all,
  each with its source line.
- **`team.policy-refused`'s audience.** The build's default is the owner alone
  (`src/policy/events.ts` at int/0.5.1 8acb470b; `src/bus/routing.ts` uses it for the refusal
  record), while the accepted amendment names the lead and the owner. Both positions are kept
  here: the code defines Today, and the amendment's lead-and-owner requirement stands for
  reconciliation.
- Owner question 5 is settled (OD-20261018-05, under the owner's delegation, revisable by the
  owner): at once, only a blocker or a decision that needs the owner, a release ready for his go,
  and a security refusal or a forged or invalid record; the rest batched in the lead's summary. The
  same word settles which kinds `privileged-kinds` grows to.
- The status words are derived in the messages command; `thread-ttl` and `thread-cap` are named by
  the text, and their defaults are the build's tuning.
- The watch is a subscriber first and a poller second; which of its reads stay polls (the screen,
  the machine, the pane manager's own word) is the build's choice, measured before claimed.
- Which CLIs take a drop watcher is measured in the build before the leg's default order is claimed
  for them.

## Revision log

- **Draft** (the writer, 2026-10-18): lifted from the send-events amendment's v2 draft; read at
  int/0.5.1 (8acb470b).
- **Folded** (the writer, 2026-10-19): owner question 5 recorded as settled by OD-20261018-05 (the
  blocker or decision, the release ready, the security or invalid record at once; the rest
  batched), matching the amendment's v2 fold.
- **Fix round 1** (the writer, 2026-10-18, on the architect's line): §3's kinds table is one row per
  kind, all thirty, each with its source line in `src/bus/kinds.ts` at the pinned ref; §7 opens
  with the amendment/build count; `drop` is "built at int/0.5.1 8acb470b, unreleased" in the
  delivery-legs entry.
- **Count resolved** (the writer, 2026-10-19): the §7 marker reconciled from
  `src/bus/kinds.ts` at int/0.5.1 8acb470b — thirty kinds; five beyond the accepted table as
  written (twenty-five), six against its prose (twenty-four).
- **Fold after the pre-round reviews** (the writer, 2026-10-19): `team.policy-refused` names the
  build's owner-only default in §3 and rule 7, with the accepted amendment's lead-and-owner
  audience kept separately for reconciliation (§7).
