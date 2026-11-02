# The fallback store (`team fallback`)

Rationale and limits behind [`team fallback prune`](../commands/fallback.md) and the daemon's own
retirement pass. The episode itself — its marker, its ledgers, its escalation — is documented in
the module header at `src/send/fallback-events.ts`; this page states only how an episode is
retired, and what that cannot do.

## What "finished" means (`finishedKind`)

- `delivered`: `status: "delivered"`.
- `refused`: `status: "all-failed"` with `escalatedAt` set — exhaustion was decided and the main
  escalation published.
- `expired`: `status: "trying"`; whether it is old enough is the retention word's question.
- Null: an `outbox` intent is still pending, or `all-failed` has no `escalatedAt` yet. The
  escalation pass must flush such an episode first, and retirement must never archive it.

## The retention word

`fallbackRetentionOf` reads `event-retention-days` through `eventThresholdsInForce`, the same
resolver the event log's retention uses, at `upToLevel: 'team'`, from the receiver's own chain: the
team file is selected exactly as `escalationDelayOf` selects it (`ctx.recipientTeam`, else the
sender's team only when the receiver stands in the sender's root). No team file in hand, or a
chain that will not load, gives `seconds: null` and a refusal: expired episodes stay, delivered and
refused ones still retire because they need no word, and the command refuses the whole run. An
expired episode is eligible at `updatedAt + retention_days × 86400 s`, inclusively.

The plan reads the chain at most once per distinct receiver (team, seat, id, root) and only when
an expired candidate exists, so a store of delivered and escalated episodes costs no policy read.
`plan.retention` reports the first word resolved; with mixed receivers in a store whose words
differ, it is the first one's, and each candidate is judged by its own receiver's word.

## The archive

Under the store's own folder (`~/.config/team/<project>-<hash>/`):

- `fallback-archive/markers/<episode-hash>.json` — the retired marker, written `0600` in a `0700`
  folder through the same temp-and-rename write the live marker uses. A repeat retirement of the
  same episode overwrites it; same-episode writers are serialized by the key lock.
- `fallback-archive/attempts/fallback-attempts-<episode-hash>.jsonl` — the episode's attempt
  ledger, renamed there, or appended to when an earlier retirement already archived one.
- The publication ledger (`fallback-published-<episode-hash>.jsonl`) is **not** moved. It is the
  replay-dedup proof and must outlive the episode; it is therefore the one file per episode that
  grows without a retirement bound. It gains a line only when the episode publishes an event, so
  it grows with escalations, not with attempts.

The live marker is unlinked only after the marker is archived and the attempt ledger has moved. A
failure at any step leaves the live marker in place, is reported as a refusal, and is retried next
pass. The episode's key-lock folder is removed after the lock is released; an empty folder a live
holder re-took stays and the reclaim pass judges it.

## A fact after retirement

The archived marker is read when no live marker exists, and checked against the fact exactly as a
live one would be:

- `delivered` or `refused`: `state: "duplicate"`, nothing written, no event.
- `expired`: the episode **reopens** — the archived marker is the base, a new live marker and a new
  attempt ledger are written, and the archived summary stays readable beside it.
- Another recipient or digest: the same `conflict` a live marker gives.
- An unreadable archive is a `marker` refusal, never a guess.

## Lock reclaim and the race with a live pass

`reclaimLockDir` removes a key-lock folder when its lock file is absent (folder older than
`youngMs`, 60 s by default, so an acquirer between `mkdir` and `open` keeps its folder), when its
holder is dead, or when its lock is pid-less and older than the one-second young-lock window.
`takeOver` renames the lock aside and puts it back if it finds a different live pid, so two
reclaimers cannot both remove a live holder's key. `reclaimFallbackLocks` walks only names matching
`fallback-[0-9a-f]{16}` under the swept root's store; a folder that is not an episode's is never
touched.

`withLock` now recreates its folder and retries, at most eight times, when the create fails with
`ENOENT` — or `EINVAL`, which the platform also reported when a folder was recycled between the
`mkdir` and the `open` (measured in the lane's stress scene). A reclaim therefore cannot make a
live acquirer throw: the worst case is one extra `mkdir` and `open`.

## Cadence and cost

- A direct `sweepFallbackEscalations` call retires nothing unless it is given `retire`; the
  daemon's heartbeat passes it once every 30 s (`FALLBACK_STORE_PASS_MS`), the first pass a full
  interval after start, so a pinned clock never drifts into retirement and a restart never rewrites
  history its first ticks might still be reading.
- One pass retires at most `FALLBACK_STORE_PASS_LIMIT` (256) episodes and judges at most that many
  lock folders; a long history drains over several passes instead of one tick holding the event
  loop.
- A retired episode leaves the walk: the next scan reads no marker for it, so the sweep's cost
  falls with history rather than growing with it. The publication ledger is the only per-episode
  file that stays and is not scanned by the sweep.
