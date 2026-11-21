import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import { inboxLive, listUnread } from '../mcp/inbox.ts';
import { activate, deactivate, floorState, seatDropFoldersStrict } from '../queue/floor.ts';
import { liveFloorActors } from '../queue/floor-actors.ts';
import { readerSwitch, seatQueueCheck, setReaderSwitch, type SeatBinding } from '../queue/reader.ts';
import { buildIdentity } from '../version.ts';
import { seatDropDir } from '../queue/mail-tree.ts';
import { channelUnproven, type ChannelUnproven } from '../queue/resend.ts';
import { pendingProbe, placeChannelProbe } from '../queue/channel-probe.ts';
import { ACTOR_LEVEL } from '../queue/floor.ts';
import { listenerKeyOf } from '../comms/offer.ts';
import type { TeamFile } from '../file/types.ts';
import { messageKeyState } from '../store/keys.ts';
import { readState, type SeatState } from '../state.ts';
import { typedPaneProof, type TypedPaneSources } from '../launch/identity.ts';
import { realWatchSources } from './watch.ts';
import { permittedEventLegs } from './send.ts';

export const USAGE = `Usage: team queues status
       team queues activate
       team queues prove [<seat>]
       team queues deactivate
       team queues reader on|off

The per-seat delivery queues of this checkout (rfc-event-comms, steps E6-E7).
status      the root's floor state, the reader switch, and each seat queue's check.
activate    turns on at-least-once delivery for this team, once every live TeamCLI process of
            the team runs this build and every running Claude Code seat has a proven channel
            or can receive a typed pointer:
            from then on every message is delivered until its
            recipient acknowledges it (team ack), and every copy names its message and its
            delivery number; any copy after the first says it is a re-send. If an older TeamCLI
            process appears later, the daemon rolls the team back to dark on its next pass.
            Messages sent while the team was active keep the guarantee after a rollback. Not
            covered: an older TeamCLI process started outside TeamCLI's own launch.
prove       places one channel proof probe for each running Claude Code seat that activate
            refuses as unproven since launch (a live channel, no proving ack yet), or for the
            one seat named. The seat's channel server pushes it with an offer token; the seat's
            ack with that offer proves the channel, and activate then counts it. A seat whose
            pane is protected has no other proof before activation. Nothing is activated.
deactivate  the rollback to dark, in one command; it resumes a cut-off rollback.
reader      turns the reader switch on (seats read their mail in queue order, once every seat
            queue is complete) or off (every reader is back on the legacy listing at once).

Exits 0 on success, 1 when the change is refused or fails, 2 when the invocation or project can't be read.
`;

export type QueuesSources = { home: string; now?: () => Date; paneOwner?: TypedPaneSources };

export const queues: Command = (argv, io) => runQueues(argv, io, { home: homedir() });
export default queues;

/** One seat folder's binding and unread ids, read exactly as the seat's own inbox reads them (the
 *  lead binding included, so a lead's clearance settles a message here too). Null when the folder
 *  cannot be listed: an unreadable inbox is never certified as an empty one. */
export function unreadOf(root: string, home: string, lead: string | undefined, dropDir: string, observe = false): { binding: SeatBinding; ids: string[] } | null {
  const parts = dropDir.split('/');
  const seat = parts[parts.length - 1];
  const session = parts[parts.length - 2];
  if (!seat || !session || seatDropDir(root, session, seat) !== dropDir) return null;
  let listedOk = false;
  const ids = listUnread(dropDir, { to: seat, root, session, ...(lead === undefined ? {} : { lead }) }, home, undefined, () => { listedOk = true; }, observe ? { queue: 'skip' } : {}).map(message => message.id);
  if (!listedOk) return null;
  return { binding: { root, session, seat }, ids };
}

export async function runQueues(argv: string[], io: Io, sources: QueuesSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], []);
  if (args.error) return invocation(out, args.error);
  const [verb, value, extra] = args.rest;
  if (verb === undefined || extra !== undefined) return invocation(out, verb === undefined ? 'a verb is required' : `unexpected "${extra}"`);
  if (verb !== 'status' && verb !== 'activate' && verb !== 'deactivate' && verb !== 'reader' && verb !== 'prove') return invocation(out, `unknown verb "${verb}"`);
  if (verb === 'reader' && value !== 'on' && value !== 'off') return invocation(out, 'reader takes on or off');
  if (verb !== 'reader' && verb !== 'prove' && value !== undefined) return invocation(out, `unexpected "${value}"`);
  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    out.stderr('team queues: this folder is not a team checkout\n');
    // exit: queues.project
    return 2;
  }
  const root = loaded.root;
  const home = sources.home;
  const lead = loaded.team.orchestrator ?? undefined;
  if (verb === 'status') {
    const floor = floorState(root, home);
    const flag = readerSwitch(root, home);
    out.stdout(`floor: ${floor.kind}${'level' in floor ? ` (level ${String(floor.level)})` : ''}${'why' in floor ? ` — ${floor.why}` : ''}\n`);
    out.stdout(`reader switch: ${flag.kind}${flag.kind === 'unknown' ? ` — ${flag.why}` : ''}\n`);
    const folders = seatDropFoldersStrict(root);
    if (folders === null) out.stdout('seats: the seat folders cannot all be listed\n');
    for (const dropDir of folders ?? []) {
      const unread = unreadOf(root, home, lead, dropDir, true);
      if (unread === null) {
        out.stdout(`${dropDir}: the inbox cannot be listed\n`);
        continue;
      }
      // Read-only: status drains nothing, signs nothing and moves nothing.
      const check = seatQueueCheck(dropDir, unread.binding, unread.ids, home, { drain: false });
      out.stdout(`${unread.binding.session}/${unread.binding.seat}: ${check.kind === 'complete' ? `complete, observed (${String(check.committed)} unread placed)` : `incomplete — ${check.why}`}\n`);
    }
    // exit: queues.status
    return 0;
  }
  if (!allowed(io, out, sources, verb)) {
    // exit: queues.not-owner
    return 1;
  }
  if (verb === 'activate' || verb === 'prove') {
    // Check before activate creates its folder, takes a lock or recovers a cut-off publication:
    // a refused activation must leave the root and the machine folder exactly as they were.
    const gaps = channelGaps(root, home, loaded.team, lead, sources);
    if (gaps === 'unreadable') {
      out.stderr(`team queues: ${verb === 'prove' ? 'nothing probed' : 'activation refused'}: recorded seat state cannot be read\n`);
      for (const seat of loaded.team.seats) if (seat.cli === 'claude-code' && !seat.stopped) out.stderr(`  ${seat.name}: seat state cannot be read\n`);
      return 1;
    }
    if (verb === 'prove') return proveSeats(out, root, home, loaded.team.session, lead, gaps, value, sources);
    if (gaps.length > 0) {
      out.stderr('team queues: activation refused: running Claude Code seats have no proven channel and no typed pointer proof\n');
      for (const seat of gaps) out.stderr(`  ${seat.seat}: ${seat.why}\n`);
      if (gaps.some(seat => seat.channel === 'unproven since launch')) {
        out.stderr('a seat unproven since launch with a live channel can prove it now: team queues prove, then its ack, then team queues activate again\n');
      }
      return 1;
    }
    const outcome = activate(root, {
      home,
      build: buildIdentity().build,
      actors: () => liveFloorActors(root, home),
      ...(sources.now ? { now: sources.now } : {}),
    });
    if (outcome.kind === 'activated' || outcome.kind === 'already') {
      out.stdout(`activated at level ${String(outcome.level)}\n`);
      // exit: queues.activated
      return 0;
    }
    out.stderr(`team queues: activation ${outcome.kind}${'why' in outcome ? `: ${outcome.why}` : ''}${'below' in outcome && outcome.below.length > 0 ? ` (${outcome.below.map(actor => `${actor.name} pid ${String(actor.pid)} level ${actor.level === null ? 'unknown' : String(actor.level)}`).join(', ')})` : ''}\n`);
    // exit: queues.activation-refused
    return 1;
  }
  if (verb === 'deactivate') {
    const rolled = deactivate(root, home);
    if (rolled.kind === 'dark') {
      out.stdout('dark: the team is back on legacy delivery; messages sent while it was active keep the guarantee\n');
      // exit: queues.deactivated
      return 0;
    }
    out.stderr(`team queues: deactivation ${rolled.kind}${rolled.kind === 'failed' ? `: ${rolled.why}` : ''}; run it again to finish the rollback\n`);
    // exit: queues.deactivation-failed
    return 1;
  }
  const outcome = setReaderSwitch(root, value === 'on', {
    home,
    actors: () => liveFloorActors(root, home),
    unreadOf: (dropDir) => unreadOf(root, home, lead, dropDir),
    ...(sources.now ? { now: sources.now } : {}),
  });
  if (outcome.kind === 'on' || outcome.kind === 'off') {
    out.stdout(`reader switch: ${outcome.kind}\n`);
    // exit: queues.reader
    return 0;
  }
  out.stderr(`team queues: reader ${outcome.kind}${'why' in outcome ? `: ${outcome.why}` : ''}\n`);
  if (outcome.kind === 'refused' && outcome.seats) for (const seat of outcome.seats) out.stderr(`  ${seat.dropDir}: ${seat.why}\n`);
  // exit: queues.reader-refused
  return 1;
}

/** One running Claude Code seat that blocks activation: why, and the channel's own reason. */
type ChannelGap = { seat: string; why: string; channel: ChannelUnproven | 'no message key' };

/**
 * The running Claude Code seats of this root with neither a proven channel nor a permitted,
 * positively proved typed pointer: the activation check, read-only. `unreadable` when the
 * recorded seat state cannot be read (never a positive proof).
 */
function channelGaps(root: string, home: string, team: TeamFile, lead: string | undefined, sources: QueuesSources): ChannelGap[] | 'unreadable' {
  const key = messageKeyState(home);
  const nowMs = (sources.now?.() ?? new Date()).getTime();
  const session = team.session;
  let recorded: Record<string, SeatState>;
  try {
    recorded = readState(join(root, '.agents')).sessions[session]?.seats ?? {};
  } catch {
    return 'unreadable';
  }
  const owner = sources.paneOwner ?? realWatchSources.keyOwner;
  let agents: ReturnType<TypedPaneSources['agents']> = null;
  try { agents = owner?.agents(session) ?? null; } catch { /* Unreadable is not a positive proof. */ }
  // Only this root's running roster is considered. An entity orchestrator in another root
  // has no local recorded pane here; its protected pane cannot block this root's activation.
  return team.seats.filter(seat => seat.cli === 'claude-code' && !seat.stopped).flatMap(seat => {
    const held = recorded[seat.name];
    if (held?.pane === undefined) return [];
    if (agents !== null && !agents.some(agent => agent.pane === held.pane)) return [];
    const why = key.kind !== 'key' ? 'no message key' as const : channelUnproven({
      dropDir: seatDropDir(root, session, seat.name), root, session, seat: seat.name,
      context: { to: seat.name, root, session, ...(lead === undefined ? {} : { lead }) },
      key: key.key, nowMs,
    });
    if (why === null) return [];
    let pointerWhy = 'the typed pointer is protected or its settings cannot be read';
    try {
      const legs = permittedEventLegs({ dir: join(root, '.agents'), root, home, session, seat: seat.name, team, now: () => new Date(nowMs) });
      if (legs.pointer === true && owner !== undefined) {
        const proof = typedPaneProof(held, seat.name, held.pane, session, owner, true);
        if (proof.ok) return [];
        pointerWhy = proof.why;
      }
    } catch { /* No unreadable setting permits typing. */ }
    return [{ seat: seat.name, why: `${why}; ${pointerWhy}`, channel: why }];
  });
}

/**
 * `team queues prove [<seat>]`: one channel proof probe (src/queue/channel-probe.ts) for each seat
 * the activation check refuses as unproven since launch, which is exactly a seat with a live
 * channel listener of this level and no proving ack yet. The seat's own channel server pushes the
 * probe with an offer token; the seat's ack with it proves the channel, and the next activation
 * reads that proof. A seat refused for any other reason is named and gets nothing. A probe still
 * pending for the seat's current listener is not placed twice. Nothing is activated here.
 */
function proveSeats(out: Io, root: string, home: string, session: string, lead: string | undefined, gaps: ChannelGap[], only: string | undefined, sources: QueuesSources): number {
  const now = sources.now?.() ?? new Date();
  const chosen = only === undefined ? gaps : gaps.filter(gap => gap.seat === only);
  if (chosen.length === 0) {
    out.stdout(only === undefined ? 'nothing to prove: no running Claude Code seat is refused by the activation check\n' : `${only}: nothing to prove: the activation check does not refuse it\n`);
    // exit: queues.prove-nothing
    return 0;
  }
  const key = messageKeyState(home);
  // Every check comes first, for every chosen seat, before anything is written: a refusal here
  // leaves the checkout exactly as it was, whatever the other seats would have taken.
  const plan: { seat: string; listenerKey: string; pending: string | null }[] = [];
  const refused: string[] = [];
  for (const gap of chosen) {
    if (gap.channel !== 'unproven since launch' || key.kind !== 'key') {
      refused.push(`  ${gap.seat}: no probe: ${gap.why}\n`);
      continue;
    }
    const dropDir = seatDropDir(root, session, gap.seat);
    // The one listener read the placement binds to: it must still be a channel server of this
    // level, the only kind that pushes a stamped copy with an offer token.
    const live = inboxLive(dropDir, root, session, gap.seat);
    if (!live.live) {
      refused.push(`  ${gap.seat}: no probe: its listener is gone\n`);
      continue;
    }
    if (live.listener.channel !== true || (live.listener.level ?? 0) < ACTOR_LEVEL) {
      refused.push(`  ${gap.seat}: no probe: its listener is not a channel server of this level\n`);
      continue;
    }
    const listenerKey = listenerKeyOf(live.listener);
    plan.push({ seat: gap.seat, listenerKey, pending: pendingProbe({ root, session, seat: gap.seat, key: key.key, listenerKey, nowMs: now.getTime(), ...(lead === undefined ? {} : { lead }) }) });
  }
  if (refused.length > 0) {
    out.stderr('team queues: nothing probed; the checkout is unchanged:\n');
    for (const line of refused) out.stderr(line);
    // exit: queues.prove-refused
    return 1;
  }
  // Placement: each probe is its own write. A write that fails after it began may leave the
  // queue's own void entry for that seat (src/queue/append.ts); what was placed is reported apart
  // from what was not, and the run exits 1 unless every seat has its probe.
  const failed: string[] = [];
  for (const one of plan) {
    if (one.pending !== null) {
      out.stdout(`${one.seat}: probe ${one.pending} is waiting for its ack\n`);
      continue;
    }
    const placed = placeChannelProbe({ home, root, session, seat: one.seat, listenerKey: one.listenerKey, now });
    if (!placed.ok) {
      failed.push(`  ${one.seat}: not placed: ${placed.reason}; its queue may keep a void entry for the attempt\n`);
      continue;
    }
    out.stdout(`${one.seat}: probe ${placed.id} placed; its channel is proven once the seat acks it with its offer\n`);
  }
  if (failed.length > 0) {
    out.stderr(`team queues: probes partly placed: ${String(plan.length - failed.length)} of ${String(plan.length)} seats have one:\n`);
    for (const line of failed) out.stderr(line);
    // exit: queues.prove-partial
    return 1;
  }
  // exit: queues.prove
  return 0;
}

/** activate and reader change what every seat of the root does: the owner's, or a lead's in
 *  development mode (the daemon command's rule). */
function allowed(io: Io, out: Io, sources: QueuesSources, verb: string): boolean {
  const caller = callerOf(io);
  if (isOwner(caller)) return true;
  const message = `only the owner or a lead in development mode activates the queues or turns the reader switch; this call is ${describeCaller(caller)}`;
  const lift = devModeOwnerLiftAtCwd(io, { command: 'queues', gate: verb, refusal: message, home: sources.home, ...(sources.now ? { now: sources.now() } : {}) });
  if (lift !== null && lift.lifted) {
    out.stderr(`${lift.warning}\n`);
    return true;
  }
  out.stderr(`team queues: ${message}\n`);
  return false;
}

function invocation(io: Io, message: string): number {
  io.stderr(`team queues: ${message}\n${USAGE}`);
  // exit: queues.invocation
  return 2;
}
