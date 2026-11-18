import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import { listUnread } from '../mcp/inbox.ts';
import { activate, floorState, seatDropFoldersStrict } from '../queue/floor.ts';
import { liveFloorActors } from '../queue/floor-actors.ts';
import { readerSwitch, seatQueueCheck, setReaderSwitch, type SeatBinding } from '../queue/reader.ts';
import { buildIdentity } from '../version.ts';

export const USAGE = `Usage: team queues status
       team queues activate
       team queues reader on|off

The per-seat delivery queues of this checkout (rfc-event-comms, steps E6-E7).
status    the root's floor state, the reader switch, and each seat queue's check.
activate  proves every live actor at the floor and activates the root (the fences go live).
reader    turns the reader switch on (seats read their mail in queue order, once every seat
          queue is complete) or off (every reader is back on the legacy listing at once).

Exits 0 on success, 1 when the change is refused or fails, 2 when the invocation or project can't be read.
`;

export type QueuesSources = { home: string; now?: () => Date };

export const queues: Command = (argv, io) => runQueues(argv, io, { home: homedir() });
export default queues;

/** One seat folder's binding and unread ids, read exactly as the seat's own inbox reads them (the
 *  lead binding included, so a lead's clearance settles a message here too). Null when the folder
 *  cannot be listed: an unreadable inbox is never certified as an empty one. */
export function unreadOf(root: string, home: string, lead: string | undefined, dropDir: string): { binding: SeatBinding; ids: string[] } | null {
  const parts = dropDir.split('/');
  const seat = parts[parts.length - 1];
  const session = parts[parts.length - 2];
  if (!seat || !session || join(root, '.agents', 'send-drops', session, seat) !== dropDir) return null;
  let listedOk = false;
  const ids = listUnread(dropDir, { to: seat, root, session, ...(lead === undefined ? {} : { lead }) }, home, undefined, () => { listedOk = true; }).map(message => message.id);
  if (!listedOk) return null;
  return { binding: { root, session, seat }, ids };
}

export async function runQueues(argv: string[], io: Io, sources: QueuesSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], []);
  if (args.error) return invocation(out, args.error);
  const [verb, value, extra] = args.rest;
  if (verb === undefined || extra !== undefined) return invocation(out, verb === undefined ? 'a verb is required' : `unexpected "${extra}"`);
  if (verb !== 'status' && verb !== 'activate' && verb !== 'reader') return invocation(out, `unknown verb "${verb}"`);
  if (verb === 'reader' && value !== 'on' && value !== 'off') return invocation(out, 'reader takes on or off');
  if (verb !== 'reader' && value !== undefined) return invocation(out, `unexpected "${value}"`);
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
      const unread = unreadOf(root, home, lead, dropDir);
      if (unread === null) {
        out.stdout(`${dropDir}: the inbox cannot be listed\n`);
        continue;
      }
      // Read-only: status drains nothing, signs nothing and moves nothing.
      const check = seatQueueCheck(dropDir, unread.binding, unread.ids, home, { drain: false });
      out.stdout(`${unread.binding.session}/${unread.binding.seat}: ${check.kind === 'complete' ? `complete (${String(check.committed)} unread placed)` : `incomplete — ${check.why}`}\n`);
    }
    // exit: queues.status
    return 0;
  }
  if (!allowed(io, out, sources, verb)) {
    // exit: queues.not-owner
    return 1;
  }
  if (verb === 'activate') {
    const outcome = activate(root, {
      home,
      build: buildIdentity().build,
      actors: () => liveFloorActors(root, home),
      ...(sources.now ? { now: sources.now } : {}),
      launchBoundary: true,
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
