// The idle-with-work producer: one read-only snapshot of the seats the watch would call quiet
// and the records its picker would still offer them. `status`, `check` and the watch's own
// dispatcher read this one function, so they cannot disagree about who is idle or what is
// takeable. Nothing here claims, releases, sends, types or writes: the reading is a photograph,
// and the dispatcher's decision is taken on it elsewhere.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import type { IdleWorkInput, IdleWorkReport, PresenceSource } from '../idle_work.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { takeable } from '../tasks/select.ts';
import type { TaskRecord } from '../tasks/adapter.ts';
import { liveLeases } from '../tasks/lease.ts';
import { fileSourceOf, readFileSource } from '../tasks/queue.ts';
import { nativeAllowsTyping, presenceSeatOf, presenceVerdict, type PresenceRead, type PresenceVerdict } from './presence.ts';
import { readScreen } from './screen.ts';

/**
 * The threshold the claim waits on is the `idle-threshold` policy: a duration with its unit
 * (`5m`, `30s`) or whole seconds, normalized to numeric seconds, 300 when nothing declares it.
 * Only the entity, project and team levels set it, and a shorter window is the tighter one, so
 * the chain is read to `team` and the effective value is the one in force. A chain that cannot
 * be read resolves nothing: the reading uses the documented default, and the read-only snapshot
 * never writes the expired-policy markers the commands do. `watch.idleFirst` and the stamp of an
 * already-typed nudge are not this threshold and play no part here.
 */
export function idleThresholdSeconds(team: TeamFile, root: string, home: string | undefined, now: Date): number {
  return idleThresholdReading(team, root, home, now).seconds;
}

/** The threshold with its provenance: a chain that cannot be read is not a chain that declared
 *  nothing, so it carries `unknown` and the snapshot says the window in force is unknown rather
 *  than acting on the documented default. */
export function idleThresholdReading(team: TeamFile, root: string, home: string | undefined, now: Date): { seconds: number; unknown?: string } {
  try {
    const resolved = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity,
        projectId: home === undefined ? null : projectIdOfTeam(home, team, root),
        teamRoot: root,
        team,
      },
      { now, upToLevel: 'team' },
    );
    if (!resolved.ok) {
      const why = resolved.refusals.map((refusal) => refusal.message).join('; ');
      return { seconds: 300, unknown: why === '' ? 'the policy chain could not be read' : why };
    }
    const value = resolved.policies['idle-threshold']?.value;
    return typeof value === 'number' ? { seconds: value } : { seconds: 300, unknown: 'idle-threshold did not resolve to a number' };
  } catch (error) {
    return { seconds: 300, unknown: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The snapshot. An idle seat is one the watch's dispatcher could act on this pass: a declared,
 * non-human seat that is not a lead, parked, stopped, swapped or holding a running turn — herdr
 * says `idle` or `done`, its screen reads the empty prompt, and no dialog is up. Its clock is
 * `last_active`, the persisted last time it reached ready or was seen working; a seat with no
 * stamp has no provable clock and is not counted. `takeable` is the records at
 * least one of those seats could claim under the picker's own rules (`takeable`), minus ids a
 * live lease in this clone already holds. A paused team claims nothing. A team whose file names
 * a tracker counts the caller's prefetched broker snapshot when one is supplied; without one the
 * count is unknown rather than zero, and nothing here reads the tracker over the network.
 */
export function idleWorkReport(input: IdleWorkInput): IdleWorkReport {
  const now = input.now.getTime();
  const threshold = idleThresholdReading(input.team, input.root, input.home, input.now);
  const seats = idleSeatsOf(input, threshold.seconds, now);
  const counted = takeableNow(input, seats.seats, now);
  const report: IdleWorkReport = {
    format: 1,
    at: input.now.toISOString(),
    threshold_seconds: threshold.seconds,
    takeable: counted.takeable,
    idle: seats.seats.map(({ name, since, native_since, presence_source }) => ({
      seat: name,
      since,
      ...(native_since === undefined ? {} : { native_since }),
      ...(presence_source === undefined ? {} : { presence_source }),
    })),
  };
  if (threshold.unknown !== undefined) report.threshold_unknown = threshold.unknown;
  if (counted.refused !== undefined) report.refused = counted.refused;
  if (seats.unknown !== undefined) report.presence_unknown = seats.unknown;
  return report;
}

type IdleWorker = { name: string; since: string; native_since?: string; presence_source?: PresenceSource };

function idleSeatsOf(
  input: IdleWorkInput,
  threshold_seconds: number,
  now: number,
): { seats: IdleWorker[]; unknown?: string } {
  const { team, state, live } = input;
  const reads = input.presence ?? null;
  // Without a prefetched native read the snapshot is exactly today's: a live herdr read is
  // required. With one, native seats are read even when herdr has nothing this pass; the screen
  // path only runs for a seat whose native channel is explicitly absent or unsupported.
  if (reads === null && (live === null || !live.running)) return { seats: [] };
  const idle: IdleWorker[] = [];
  let unknown: string | undefined;
  for (const seat of team.seats) {
    if (seat.human === true || seat.parked || seat.stopped) continue;
    if (seat.name === team.orchestrator || seat.name === team.operator) continue;
    if (input.swaps?.includes(seat.name) === true) continue;
    // A seat paused on its own is not an idle worker: no wake and no typed work until its
    // resume, while the rest of the team keeps being nudged.
    if (input.seatPauses?.[seat.name] !== undefined) continue;
    const record = state.seats[seat.name];
    const since = sinceOf(record?.last_active);
    if (reads !== null) {
      const presence = presenceSeatOf(state, seat.name, input.presenceChannelHealthy);
      const read = reads.get(seat.name) ?? {
        kind: 'absent' as const,
        why: 'the pass read no presence for this seat',
      };
      const verdict: PresenceVerdict = presenceVerdict(read, presence, {
        now: input.now,
        thresholdSeconds: threshold_seconds,
      });
      if (verdict.idle) {
        // A usage wall outranks the projection's idle word: the runtime's turn ended, but the
        // CLI's own screen proves nothing can be typed there until the wall lifts, so the seat
        // is blocked, never an idle worker. The gate reads the pane this pass holds; a pass with
        // no live reading or no single agent for the seat keeps the projection's answer.
        if (live !== null && live.running) {
          const agents = live.agents.filter((candidate) => candidate.name === seat.name);
          const pane = agents.length === 1 ? agents[0]?.pane : undefined;
          if (pane !== undefined && readScreen(seat.cli, live.screens[pane]).kind === 'rate limit') continue;
        }
        if (since === null) {
          // The verdict proved the persisted stamp parses; a missing value here is still a hold,
          // never a wake on a clock this snapshot cannot read.
          unknown ??= `${seat.name}: the native idle reading carries no persisted claim stamp`;
          continue;
        }
        idle.push({
          name: seat.name,
          since,
          native_since: verdict.nativeSince,
          presence_source: verdict.source,
        });
        continue;
      }
      if (verdict.reason === 'invalid') {
        unknown ??= `${seat.name}: ${verdict.why}`;
        continue;
      }
      if (verdict.reason !== 'fallback-absent' && verdict.reason !== 'fallback-unsupported') continue;
    }
    // The labelled terminal-host reading, with the gates the watch used before the store existed.
    if (live === null || !live.running) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (agent === undefined) continue;
    if (live.agents.filter((candidate) => candidate.name === seat.name).length !== 1) continue;
    const quiet = agent.status === 'idle' || agent.status === 'done';
    if (!quiet) continue;
    const screen = readScreen(seat.cli, live.screens[agent.pane]);
    if (screen.kind !== 'idle') continue;
    if (since === null || now - Date.parse(since) < threshold_seconds * 1000) continue;
    idle.push({
      name: seat.name,
      since,
      ...(reads === null ? {} : { presence_source: 'terminal-host' as const }),
    });
  }
  return unknown === undefined ? { seats: idle } : { seats: idle, unknown };
}

/** The seats no automatic path may type at or count idle this pass: a projection proven
 *  working, waiting for a person or gone, and one that cannot be trusted at all. The allow is
 *  explicit (`nativeAllowsTyping`): a qualified native idle or a genuinely absent or unsupported
 *  channel leaves the labelled screen path in charge. The threshold is zero because this gate
 *  asks only what the state is, not whether an idle episode has aged. */
export function nativeHeldSeats(input: {
  team: IdleWorkInput['team'];
  state: IdleWorkInput['state'];
  presence: ReadonlyMap<string, PresenceRead>;
  channelHealthy?: (seat: string) => boolean;
  now: Date;
}): ReadonlySet<string> {
  const held = new Set<string>();
  for (const seat of input.team.seats) {
    // Nothing is ever typed into a human's pane, and no human seat runs an idle episode.
    if (seat.human === true) continue;
    const read = input.presence.get(seat.name) ?? {
      kind: 'absent' as const,
      why: 'the pass read no presence for this seat',
    };
    const verdict = presenceVerdict(
      read,
      presenceSeatOf(input.state, seat.name, input.channelHealthy),
      { now: input.now, thresholdSeconds: 0 },
    );
    if (!nativeAllowsTyping(verdict)) held.add(seat.name);
  }
  return held;
}

/** The persisted idle clock, or null when the state records no stamp the reader can parse: a
 *  seat with no provable clock is not counted idle by this snapshot. */
function sinceOf(stamp: string | undefined): string | null {
  if (stamp === undefined || !Number.isFinite(Date.parse(stamp))) return null;
  return stamp;
}

/** The records at least one idle seat could claim now, under the picker's rules, with live
 *  leases removed. `takeable: null` means a named source could not be read; the reason is
 *  carried so the reading never looks like an empty queue. A tracker team counts the caller's
 *  prefetched broker snapshot; without one the count stays unknown, never zero. */
function takeableNow(input: IdleWorkInput, seats: readonly IdleWorker[], now: number): { takeable: number | null; refused?: string } {
  if (input.pause != null) return { takeable: 0 };
  const source = fileSourceOf(input.team);
  let records: readonly TaskRecord[];
  if (source === null) {
    const snapshot = input.broker;
    // A declared tracker is the team's source. Without a snapshot the count is unknown, never
    // zero, so no dispatcher reads it as "no work".
    if (snapshot == null) {
      return { takeable: null, refused: 'the team declares a linear task source and no broker snapshot is available here' };
    }
    if (snapshot.kind === 'refused') return { takeable: null, refused: snapshot.why };
    records = snapshot.records;
  } else {
    const read = readFileSource(input.root, source);
    if (read.kind === 'missing') return { takeable: null, refused: `${source.path} is missing` };
    if (read.kind === 'outside') return { takeable: null, refused: `${source.path} is outside the team root` };
    if (read.kind === 'not-a-list') return { takeable: null, refused: `${source.path} is not a task list` };
    records = read.records;
  }
  const held = new Set(liveLeases(input.root, now).map((lease) => lease.id));
  const pull = input.team.tasks?.pull ?? 'self';
  const ids = new Set<string>();
  for (const seat of seats) {
    for (const record of takeable(records, seat.name, pull, false)) {
      if (!held.has(record.id)) ids.add(record.id);
    }
  }
  return { takeable: ids.size };
}
