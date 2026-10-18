# The event log and the bus (`team bus`)

This page states the internal contract for the project event log (`events.jsonl`), the
reconciliation pass (`src/bus/reconcile.ts`), the event kinds and routing table (`src/bus/kinds.ts`),
and the Unix domain socket service at `.agents/bus.sock` (`src/bus/server.ts`, `src/commands/bus.ts`),
implementing RFC 002 Amendment 01 §4.1–§4.4 and §7.

## 1. The event log (`src/bus/log.ts`)

- **Location and permissions**: `<home>/.config/team/<project>-<hash>/events.jsonl` (rotated to `.1`
  and `.2` at `MAX_EVENT_LOG_BYTES = 1_000_000`, keeping `EVENT_LOG_KEPT = 3` files). Every directory
  in the store ladder is checked without following symbolic links (`O_NOFOLLOW` + `lstat`) and sealed
  at mode `0700`; every event log file is written and rotated at mode `0600`.
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
  records. When a subscriber requests `cursor > 0` that is older than the oldest event retained in
  the rotated log (`cursor < oldestSeq`), `readEventsFromCursor` returns
  `{ ok: true, kind: 'gap', oldest_seq, newest_seq }` so the subscriber resyncs from the durable
  records before following on.

## 2. The reconciliation pass (`src/bus/reconcile.ts`)

- Runs once when `team bus` starts and every `DEFAULT_RECONCILE_INTERVAL_SECONDS` (120s) thereafter.
- Scans the durable records on disk:
  1. `.agents/send-drops/<session>/<seat>` for drop files (`message.arrived`), `.pending` markers
     (`message.held`), and `.delivered`/`.read`/`.replied` receipts;
  2. `.agents/messages/<seat>` for signed message records (`message.arrived`) and `.read.json`
     receipts (`message.read`);
  3. `<storeDir>/messages.jsonl` for message deliveries, reads, replies, holds, and failures;
  4. `.agents/team.state.json` for seat state transitions newer than the seat's last event.
- Appends any missing event idempotently (keyed by `(kind, record_id, session)`) and fans newly
  raised events out to active subscribers.

## 3. Event kinds, privileged kinds, and routing (`src/bus/kinds.ts`)

- **Closed union (`EVENT_KINDS`)**: message lifecycle (`message.arrived`, `.delivered`, `.read`,
  `.replied`, `.held`), seat lifecycle (`seat.working`, `.idle`, `.idle-timeout`, `.blocked`,
  `.at-prompt`, `.unreachable`, `.done`), work lifecycle (`work.claimed`, `.done`, `.released`,
  `.gate`, `.suite`), and team/governance (`team.seat-added`, `.seat-removed`, `.seat-reloaded`,
  `.grant-issued`, `.grant-revoked`, `.grant-expired`, `.policy-changed`, `.policy-refused`).
- **Privileged self-subscription ban**: `team.grant-*`, `team.policy-*`, `seat.at-prompt`, and any
  kind in the owner's `privileged-kinds` list are privileged. A seat that is not a default recipient
  (`lead`/`operator`) may never subscribe itself to a privileged kind. When a seat attempts to do
  so, the bus refuses the subscription with rule `privileged-self-subscription`, logs the refusal to
  `.agents/team.log`, and appends a `team.policy-refused` event routed to the owner.
- **Owner-at-once set (OD-20261018-05)**: `DEFAULT_OWNER_AT_ONCE_KINDS` names the urgent kinds
  delivered to the owner immediately rather than batched.

## 4. The bus socket (`src/bus/server.ts`) and `team watch`

- Binds `.agents/bus.sock` at mode `0600` under `.agents/bus.sock.lock`, using the same `lstat`
  gate and two-sighting stale-socket recovery as `.agents/broker.sock`.
- Each live subscriber has a bounded outbound queue (`DEFAULT_SUBSCRIBER_BUFFER_LIMIT = 256`); if a
  slow subscriber's queue overflows, the bus sends `{ ok: true, kind: 'gap', oldest_seq, newest_seq }`
  and closes the stream so the subscriber resyncs from durable records.
- `team watch` subscribes to `.agents/bus.sock` at the start of each pass (`syncWatchBus`), applies
  events in sequence order, resyncs on `gap`, publishes `seat.unreachable`, `seat.at-prompt`, and
  `seat.blocked` when its poll detects a missing, prompted, or blocked seat, and falls back cleanly
  to polling when no bus is running.

## 5. Same-user (`M`-not-`A`) boundary

Every seat runs as the same OS user (`owner-user`), and the checkout's message key sits on disk
where every seat can read it. As stated in `SECURITY.md` (OD-20261018-03) and RFC 002 Amendment 01
§7, the signature and the bus socket are integrity controls against a mistaken agent, not
containment against a hostile same-user process. Because events carry no body, instruct nobody, and
are derived from durable records (which the reconciliation pass re-scans), losing or forging an
event cannot fabricate a grant or alter a message record.
