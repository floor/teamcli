# The event log and the bus (`team bus`)

This page states the internal contract for the project event log (`events.jsonl`), the
reconciliation pass (`src/bus/reconcile.ts`), the event kinds and routing table (`src/bus/kinds.ts`),
owner delivery (`src/bus/owner.ts`), and the Unix domain socket service at `.agents/bus.sock`
(`src/bus/server.ts`, `src/commands/bus.ts`), implementing RFC 002 Amendment 01 §4.1–§4.5 and §7.

## 1. The event log (`src/bus/log.ts`)

- **Location and permissions**: `<home>/.config/team/<project>-<hash>/events.jsonl` (rotated to `.1`
  at `MAX_EVENT_LOG_BYTES = 100_000_000`, keeping `EVENT_LOG_KEPT = 2` files). Every directory
  in the store ladder is checked without following symbolic links (`O_NOFOLLOW` + `lstat`) and sealed
  at mode `0700`; every event log file is written and rotated at mode `0600`.
- **Retention**: the log keeps 30 days (`EVENT_THRESHOLDS.retention_days`) or 100 MB per team
  (`EVENT_LOG_TOTAL_BYTES`), whichever comes first. Past either bound, the oldest sealed segment is
  dropped first — a segment is dated by its last write. An idle live file past the window is sealed
  and dropped by the same pass. The bus applies the window at start (`pruneEventLog`) and after each
  append. A segment is unlinked whole and a surviving file is never rewritten, so every record still
  read is byte for byte the one that was verified. Each pass that drops something writes one
  operational line to `.agents/team.log` (`bus [event-log] retention dropped …`) and appends one
  signed `team.event-log-dropped` record naming the dropped range and its reason (`age` or `size`):
  `dropped_newest_seq` is the newest sequence that pass dropped, while `dropped_oldest_seq` is the
  oldest sequence retention has dropped, carried forward from earlier declarations so losing a
  declaration record with its segment does not leave an older hole undeclared.
- **Signed records**: Each line is a JSON object `{ payload, signature }`, where `signature` is an
  Ed25519 signature over the canonical JSON of `payload` under domain `team.event.v1\n` using the
  checkout's message key (`messageKeyOf(home)`). Unverified or malformed lines are skipped and
  counted in `unverified`.
- **Sequence numbers and deduplication**: The log mints each event a strictly increasing integer
  sequence number (`seq: 1, 2, ...`). When `deduplicate` is enabled (the default), appending an
  event whose `(kind, record_id, session)` is already present in the retained log returns the
  existing record with `duplicate: true` without writing a second line.
- **No body, no instructions**: An event carries `v: 1`, `seq`, `ts`, `kind`, `session`,
  `record_id`, and optional routing/context tokens (`from`, `to`, `seat`, `subject`, `thread`,
  `via`, `reason`, `prompt`, `rule`). It never carries a message body.
- **Subscriber sequence tracking and `gap` recovery**: Subscribers apply events through
  `createSequenceTracker`, which accepts only `seq > cursor` and drops duplicates or reordered
  records. When the records between a subscriber's cursor and the oldest event retained in the
  rotated log are missing (`cursor + 1 < oldestSeq`), `readEventsFromCursor` returns
  `{ ok: true, kind: 'gap', oldest_seq, newest_seq }` so the subscriber resyncs from the durable
  records before following on. When the retained `team.event-log-dropped` records cover the whole
  missing window, the answer also carries `reason: 'retention'` and the dropped bounds
  (`dropped_oldest_seq`, `dropped_newest_seq`); an uncovered window carries neither, so a hole
  nothing declares still reads as one.

## 2. The reconciliation pass (`src/bus/reconcile.ts`)

- Runs once when `team bus` starts and every `DEFAULT_RECONCILE_INTERVAL_SECONDS` (120s) thereafter.
- Scans the durable records on disk:
  1. `.agents/send-drops/<session>/<seat>` for drop files (`message.arrived`), `.pending` markers
     (`message.held`), and `.delivered`/`.read`/`.replied` receipts;
  2. `.agents/messages/<seat>` for signed message records (`message.arrived`) and `.read.json`
     receipts (`message.read`); an owner digest record the Runtime itself wrote (`from: runtime`,
     id `digest-<16 hex>`) summarizes events already in the log, so it raises nothing and is never
     batched into a later digest;
  3. `<storeDir>/messages.jsonl` for message deliveries, reads, replies, holds, and failures;
  4. `.agents/team.state.json` for seat state transitions newer than the seat's last event.
- Appends any missing event idempotently (keyed by `(kind, record_id, session)`) and fans newly
  raised events out to active subscribers.

## 3. Event kinds, privileged kinds, and routing (`src/bus/kinds.ts`)

- **Closed union (`EVENT_KINDS`)**: message lifecycle (`message.arrived`, `.delivered`, `.read`,
  `.replied`, `.held`), seat lifecycle (`seat.working`, `.idle`, `.idle-timeout`, `.blocked`,
  `.at-prompt`, `.prompt-escalated`, `.unreachable`, `.done`), work lifecycle (`work.claimed`, `.done`, `.released`,
  `.gate`, `.suite`), and team/governance (`team.seat-added`, `.seat-removed`, `.seat-reloaded`,
  `.grant-issued`, `.grant-revoked`, `.grant-expired`, `.policy-changed`, `.policy-refused`),
  the lead's own `release.ready` and `decision.needed`, the two refusals — `record.invalid` for a
  record that does not verify, `security.refused` for an identity or an admission the rules deny —
  plus the operational `team.event-log-dropped` that retention raises. That kind is not privileged
  and is routed to `lead` and `operator` by default: it reports log maintenance, not governance.
  `release.ready` and `decision.needed` are the two kinds `team raise` writes; they are routed to
  `owner` alone and delivered at once, and they are not privileged — the command's caller rule,
  not a subscription ban, is what keeps the line the lead's. A refusal carries its rule and its
  object — the record id, the seat, the path — and never the refused content; the producer raises
  one event per rule and object in an hour and counts the repeats in `.agents/team.log`.
- **Recipients and how a seat is named**: a kind's recipients are positions — `lead` (the
  orchestrator's seat and every seat marked `leads`), `operator`, `sender` and `subject` (the
  record's own fields), `entity` (the lead of the entity's own team, the one whose `project` is the
  entity — the same seat admission calls the entity's own coordinator, resolved from the registry
  by `src/bus/seats.ts`), and `owner` (the owner's runtime, never a seat) — or seats.
  `EVENT_ROUTING_DEFAULTS` is the release table; a position the event does not carry resolves to
  nobody. A seat is written by
  its plain name or by the registry agent id (`agt_…`) that holds it: an id resolves to a seat only
  while a live, non-retired agent of this team holds it, and an id the registry does not know, one
  that is retired, or one reached through another team is left as written and names nobody
  (`src/bus/seats.ts`). Delivery resolves an id through the registry to the seat that holds it; a
  plain name stands as written. The seat that asks for a write is recorded by its registry id when
  the registry holds one, and by its name only when it has none. No identity comes from a seat
  name: `owner` is not a seat called `owner` but the position the Runtime fills, and a watch takes
  the owner's identity only as the owner's own delivery path (§4).
- **The additive chain**: `resolveRouting` folds `EVENT_ROUTING_DEFAULTS` through the levels' words
  in `POLICY_LEVELS` order. A level adds recipients among its own seats and removes only what its
  own word added; a removal naming a recipient standing above it is refused
  (`routing-removes-inherited`). A kind a level does not name keeps the recipients it has. A
  privileged kind's default recipients are added back at the end of every fold, so the invariant
  stands even when a hand-built chain skipped the check.
- **Privileged kinds**: `team.grant-*`, `team.policy-*`, `seat.at-prompt`, `seat.prompt-escalated`,
  `record.invalid` and
  `security.refused` are privileged, and
  the owner's `privileged-kinds` list grows the set (`growPrivilegedKinds`); the list itself is the
  owner's alone (`privileged-kinds-owner-only`). A seat may never add itself as a recipient of a
  privileged kind (`privileged-self-subscription`), and only the owner, or a holder whose grant
  names the kind (`privileged-owner-only`), routes one. An ordinary kind is a seat's to add itself
  to, at its own level only (`seat-adds-itself-only`); a grant holder's word on an ordinary kind
  sits at project or team (`grant-holder-scope`). A refusal is a value, never a silence: the bus
  appends the record to `.agents/team.log`, raises `team.policy-refused` to its default audience
  `owner`, and says the rule out loud.

## 4. Owner delivery (`src/bus/owner.ts`)

- **The Runtime delivers, not a seat**: an event the routing table sends to `owner`, or one the
  raising side addresses to `owner`, is delivered by the Runtime itself — the machine notification
  the watch raises, and one signed record in the owner's own mailbox. No seat is in the path, so a
  held, unreachable or absent seat silences neither the notification nor the record. Without a home
  to sign with, the notification still goes and the record is not written.
- **The mailbox `team messages` lists**: the record lands in `.agents/messages/owner/`, the
  mailbox the owner's `team messages` run already reads, so his list is one list. Its payload is a
  message addressed to `owner` whose writer is `runtime`; it is written at mode `0600` by renaming
  a temporary file into place, and the run lists it, shows it and writes its receipt with the
  rest.
- **The watch is the owner's delivery path only as itself**: the process delivers when the owner
  check that admits owner-only actions admits it, when it runs in the agentless pane `up` starts
  it in, or when it is the watch this session recorded. A watch a seat starts in its own pane runs
  its passes, publishes its reports and polls, but never subscribes with the owner's identity.
- **At once, or in the pass's digest**: the `owner-at-once` setting (`OWNER_AT_ONCE_SETTING`, the
  owner's alone) names the kinds notified on the pass that reads them, each with its own record:
  `DEFAULT_OWNER_AT_ONCE_KINDS` holds `seat.at-prompt` of a permission, trust, login, vendor or
  rate-limit prompt, `seat.prompt-escalated`, a lead's `seat.unreachable` or `seat.done`, every `team.seat-*`,
  `team.grant-*` and `team.policy-*` kind, the lead's `release.ready` and `decision.needed`, and
  the two refusals `record.invalid` and `security.refused`. Every
  other owner-routed event waits in the pass and lands at its end as one digest record whose body
  is the count (`1 event:` or `<n> events:`), then the pass's lines joined by `; `, each folded to
  one line and clipped to `MAX_OWNER_LINE`.
- **A record is the delivery's own memory**: ids are deterministic — `evt-<seq>-<…>` from the
  kind, the record id and the sequence, `digest-<…>` from the batch's events — so an event
  re-delivered after a restart finds its record and is neither rung nor written again. A watch
  report it already notified is not rung a second time when the report's published event comes
  back on the bus; that event's record is the one in the mailbox.

## 5. The bus socket (`src/bus/server.ts`) and `team watch`

- Binds `.agents/bus.sock` at mode `0600` under `.agents/bus.sock.lock`, using the same `lstat`
  gate and two-sighting stale-socket recovery as `.agents/broker.sock`.
- Each live subscriber has a bounded outbound queue (`DEFAULT_SUBSCRIBER_BUFFER_LIMIT = 256`); if a
  slow subscriber's queue overflows, the bus sends `{ ok: true, kind: 'gap', oldest_seq, newest_seq }`
  and closes the stream so the subscriber resyncs from durable records.
- **Subscription identity**: a subscribe names a seat. A registry agent id resolves to the seat
  that agent holds in this team; an id no live agent of this team holds is refused with `no agent
  of this team holds that id; subscribe with the agent id the registry holds or with the seat
  name`. A claimed pane must be the pane the registry holds for that agent (`the registry holds
  pane X for Y, not Z`); an agent with no pane on record does not contradict a claim. A plain seat
  name stands as written.
- **What a subscription reads**: a kind filter narrows what a subscriber is sent, never who
  receives a record. An event addressed by the raising side to a seat (`to`) reaches that seat, and
  the watch addresses its owner reports to `owner` this way; otherwise the routing table's
  recipients decide.
- **`team watch`**: the owner's delivery path subscribes at the start of each pass
  (`syncWatchBus`), applies events in sequence order, resyncs on `gap` (passing through whether the hole was retention), and hands owner-addressed
  events to `OwnerDelivery` (§4). Any watch publishes its check reports as events
  (`publishWatchReportsToBus`), merging an operator line and an owner line for one record id into
  one event addressed to `owner`; a watch a seat starts polls and publishes but never subscribes
  with the owner's identity. It publishes `seat.unreachable`, `seat.at-prompt`,
  `seat.prompt-escalated`, and
  `seat.blocked` when its poll detects a missing, prompted, blocked, or un-cleared seat, and falls
  back cleanly to polling when no bus is running.
- **A prompt climbs, and never goes silent**: a seat held at a permission, vendor-notice or
  rate-limit prompt starts the watch's clock. A prompt still held after
  `EVENT_THRESHOLDS.prompt_escalation_seconds` (300s, shorten-only like the other event
  thresholds) raises `seat.prompt-escalated`, whose release routing is `entity` and `owner`.
  The owner is unconditional, so a climb is still delivered when the registry names no entity
  lead. A lead's own `seat.at-prompt` is the first rung skipped: `recipientsForEvent` sends it to
  `entity` and `owner` from the start, and no clock is kept for it. A prompt that clears before
  the window is the lead acting: its clock goes and no climb is raised, and one climb is raised
  per prompt spell. The entity lead is reached as one signed runtime record in that lead's
  mailbox under the entity team's own root (`.agents/messages/<seat>/`, the entity team's
  session), written with `writeRuntimeMailboxRecord` so that team's watch rings it as a message.
  Nothing is typed into any pane: a climb is a record and an event, never a keystroke, and a
  human's pane is not a delivery target.

## 6. Same-user (`M`-not-`A`) boundary

Every seat runs as the same OS user (`owner-user`), and the checkout's message key sits on disk
where every seat can read it. As stated in `SECURITY.md` and RFC 002 Amendment 01
§7, the signature and the bus socket are integrity controls against a mistaken agent, not
containment against a hostile same-user process. Because events carry no body, instruct nobody, and
are derived from durable records (which the reconciliation pass re-scans), losing or forging an
event cannot fabricate a grant or alter a message record.
