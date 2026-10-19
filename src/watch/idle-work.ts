// The idle-with-work producer: one read-only snapshot of the seats the watch would call quiet
// and the records its picker would still offer them. `status`, `check` and the watch's own
// dispatcher read this one function, so they cannot disagree about who is idle or what is
// takeable. Nothing here claims, releases, sends, types or writes: the reading is a photograph,
// and the dispatcher's decision is taken on it elsewhere.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import type { IdleWorkInput, IdleWorkReport } from '../idle_work.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { takeable } from '../commands/next.ts';
import { liveLeases } from '../tasks/lease.ts';
import { fileSourceOf, readFileSource } from '../tasks/queue.ts';
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
 * a tracker has an unknown count here — no broker snapshot is read and the tracker is never read
 * over the network — and the reading says unknown rather than zero.
 */
export function idleWorkReport(input: IdleWorkInput): IdleWorkReport {
  const now = input.now.getTime();
  const threshold = idleThresholdReading(input.team, input.root, input.home, input.now);
  const seats = idleSeatsOf(input, threshold.seconds, now);
  const counted = takeableNow(input, seats, now);
  const report: IdleWorkReport = {
    format: 1,
    at: input.now.toISOString(),
    threshold_seconds: threshold.seconds,
    takeable: counted.takeable,
    idle: seats.map(({ name, since }) => ({ seat: name, since })),
  };
  if (threshold.unknown !== undefined) report.threshold_unknown = threshold.unknown;
  if (counted.refused !== undefined) report.refused = counted.refused;
  return report;
}

type IdleWorker = { name: string; since: string | null };

function idleSeatsOf(input: IdleWorkInput, threshold_seconds: number, now: number): IdleWorker[] {
  const { team, state, live } = input;
  if (live === null || !live.running) return [];
  const idle: IdleWorker[] = [];
  for (const seat of team.seats) {
    if (seat.human === true || seat.parked || seat.stopped) continue;
    if (seat.name === team.orchestrator || seat.name === team.operator) continue;
    if (input.swaps?.includes(seat.name) === true) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (agent === undefined) continue;
    // Exactly as the watch's own work drops read a seat: one agent, herdr's quiet word, no turn
    // running, no dialog, and an empty prompt on the screen.
    if (live.agents.filter((candidate) => candidate.name === seat.name).length !== 1) continue;
    const quiet = agent.status === 'idle' || agent.status === 'done';
    if (!quiet) continue;
    const screen = readScreen(seat.cli, live.screens[agent.pane]);
    if (screen.kind !== 'idle') continue;
    const since = sinceOf(state.seats[seat.name]?.last_active);
    // A seat with no stamp cannot be shown to have waited the window: the snapshot counts a
    // clock it can read, and never guesses that a freshly launched seat has been idle.
    if (since === null || now - Date.parse(since) < threshold_seconds * 1000) continue;
    idle.push({ name: seat.name, since });
  }
  return idle;
}

/** The persisted idle clock, or null when the state records no stamp the reader can parse: a
 *  seat with no provable clock is not counted idle by this snapshot. */
function sinceOf(stamp: string | undefined): string | null {
  if (stamp === undefined || !Number.isFinite(Date.parse(stamp))) return null;
  return stamp;
}

/** The records at least one idle seat could claim now, under the picker's rules, with live
 *  leases removed. `takeable: null` means a named file source could not be read; the reason is
 *  carried so the reading never looks like an empty queue. */
function takeableNow(input: IdleWorkInput, seats: readonly IdleWorker[], now: number): { takeable: number | null; refused?: string } {
  if (input.pause != null) return { takeable: 0 };
  const source = fileSourceOf(input.team);
  // A declared tracker is the team's source, and this reading has no broker snapshot behind it:
  // the count is unknown, never zero, so no dispatcher reads it as "no work".
  if (source === null) {
    return { takeable: null, refused: 'the team declares a linear task source and no broker snapshot is available here' };
  }
  const read = readFileSource(input.root, source);
  if (read.kind === 'missing') return { takeable: null, refused: `${source.path} is missing` };
  if (read.kind === 'outside') return { takeable: null, refused: `${source.path} is outside the team root` };
  if (read.kind === 'not-a-list') return { takeable: null, refused: `${source.path} is not a task list` };
  const held = new Set(liveLeases(input.root, now).map((lease) => lease.id));
  const pull = input.team.tasks?.source === 'file' ? input.team.tasks.pull ?? 'self' : 'self';
  const ids = new Set<string>();
  for (const seat of seats) {
    for (const record of takeable(read.records, seat.name, pull, false)) {
      if (!held.has(record.id)) ids.add(record.id);
    }
  }
  return { takeable: ids.size };
}
