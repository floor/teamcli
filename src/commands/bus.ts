// `team bus`: the foreground process that owns the project's event log (`events.jsonl`), runs the
// periodic reconciliation pass, and serves `publish` and `subscribe` over `.agents/bus.sock`
// (RFC 002 Amendment 01 §4.1–§4.4). The owner runs it from a terminal outside herdr, and so does
// a seat the team marks `leads`, from that seat's own pane. One per clone — shaped after
// `team broker`. The daemon's heartbeat and `team up` start it again when the socket is dead
// (src/bus/supervise.ts); when no bus is running, `team watch` and `team send` fall back cleanly
// to their record-polling and direct paths.
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { startBus } from '../bus/server.ts';
import { ownerSeatRuleAdmits, ownerSeatStep } from '../client/owner-action-step.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { anotherPaneRefusal, callerOf, describeCaller, detachedRefusal, isOwner, noPaneRefusal, standingOf } from '../caller.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { eventThresholdsInForce } from '../policy/index.ts';
import { gateVerdict } from '../permissions/who.ts';
import { stopped } from './broker.ts';

export const USAGE = `Usage: team bus
       team bus --request
       team bus --approval <request-id>

Runs the event bus for this clone over \`.agents/bus.sock\`, appending signed event records to the
project's event log and reconciling durable message and seat records. The owner runs it from a
terminal outside herdr, and a seat the team marks \`leads\` runs it from that seat's own pane.
Ctrl-C stops it.

The owner-seat form needs no owner terminal: --request records this start (repository, team, HEAD;
fifteen minutes) and sends it to the owner seat, where the owner answers on the owner page with a
passkey or Touch ID; --approval <request-id> then runs it, once, as signed. A signed always rule
for team-bus covering this folder admits the run with no request. The daemon restarts a dead bus
on its own, and so does team up.

Exits 0 when it started and stopped cleanly, or when a request was recorded, 1 when it refused to
start or could not bind its socket, 2 when the invocation or team configuration can't be read.
`;

export type BusCommandSources = {
  home?: string;
  now?: () => Date;
  ownerSeatStore?: OwnerSeatKeyStore;
  reconcileIntervalMs?: number;
  stop?: (end: () => void) => () => void;
};

export const bus: Command = (argv, io) => runBus(argv, io);
export default bus;

export async function runBus(argv: string[], io: Io, sources: BusCommandSources = {}): Promise<number> {
  const args = readArgs(argv, ['approval', 'inherited'], ['request']);
  if (args.error || args.rest.length) {
    io.stderr(`team bus: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: bus.usage
    return 2;
  }

  const caller = callerOf(io);
  const home = sources.home ?? homedir();
  const seatSources = { home, ...(sources.now ? { now: sources.now } : {}), ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) };
  // The owner-seat door, before any terminal check: `--request` records the start and returns;
  // `--approval` runs the start the owner seat signed. A spawned restart carries `--inherited`
  // and is not an owner-seat request.
  let seatApproved = false;
  if (args.values.inherited === undefined) {
    const seat = ownerSeatStep('bus', 'team-bus', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json: false }, io, seatSources);
    if (seat.kind === 'requested') {
      // exit: bus.approval-requested
      return 0;
    }
    if (seat.kind === 'refused') {
      // exit: bus.approval-refused
      return 1;
    }
    seatApproved = seat.kind === 'admitted';
  }
  if (!seatApproved && args.values.inherited === undefined && !isOwner(caller)) {
    seatApproved = ownerSeatRuleAdmits('team-bus', io.cwd, false, seatSources);
  }

  // `--inherited` is how `team up` starts a bus with no owner terminal. The token is a one-use
  // file this checkout's `.agents` holds, mode 0600, and it is consumed here. It starts the
  // reconciler only: it grants no send and no other owner right. Anyone who can write `.agents`
  // can start the bus, which is the same directory the bus itself serves from.
  let inherited = false;
  if (args.values.inherited !== undefined) {
    const peeked = readTeamConfig(io.cwd, { home });
    if (!peeked.ok) {
      const problem = peeked.errors[0];
      if (problem !== undefined && isNoRepository(problem)) return badConfig(io, withoutFileOffer(problem.message));
      return badConfig(io, problem?.message ?? "the team file can't be read");
    }
    if (!consumeInherit(peeked.root, args.values.inherited)) {
      return refuse(io, 'the bus inheritance token does not match this checkout');
    }
    inherited = true;
  }

  if (!inherited && !seatApproved) {
    const detached = detachedRefusal(caller, { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
    if (detached !== undefined) return refuse(io, detached);
  }

  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team bus` takes no
  // `--file`, so the shared sentence must not offer one. The refusal's own exit is unchanged:
  // `bus.configuration` is the id a configuration that cannot be read has always answered with.
  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const problem = loaded.errors[0];
    if (problem !== undefined && isNoRepository(problem)) {
      return badConfig(io, withoutFileOffer(problem.message));
    }
    return badConfig(io, problem?.message ?? "the team file can't be read");
  }

  // The owner's event thresholds, resolved once for this bus: a chain that will not load is the
  // configuration refusal (`bus.configuration`), never a silent run on the release defaults.
  const thresholds = eventThresholdsInForce({
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    entity: loaded.team.entity,
    projectId: projectIdOfTeam(sources.home ?? homedir(), loaded.team, loaded.root),
    root: loaded.root,
    team: loaded.team,
    upToLevel: 'team',
  });
  if (!thresholds.ok) {
    return badConfig(io, thresholds.refusals.map((refusal) => refusal.message).join('; '));
  }

  if (!inherited && !seatApproved && !isOwner(caller)) {
    const standing = standingOf(dirname(loaded.path), loaded.team.session, caller);
    const verdict = gateVerdict(caller, loaded.team, loaded.root, home, 'bus', standing, sources.now ?? (() => new Date()));
    if (verdict.kind === 'no-pane') return refuse(io, noPaneRefusal(verdict.name));
    if (verdict.kind === 'another-pane') return refuse(io, anotherPaneRefusal(verdict.name, verdict.recordedPane));
    if (verdict.kind !== 'ok') {
      return refuse(
        io,
        `only the owner or a \`leads\` seat runs \`bus\`, from a terminal outside herdr or its own pane; this call is ${describeCaller(caller)}`,
      );
    }
  }

  const started = await startBus({
    root: loaded.root,
    team: loaded.team,
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    ...(sources.reconcileIntervalMs !== undefined
      ? { reconcileIntervalMs: sources.reconcileIntervalMs }
      : { reconcileIntervalMs: thresholds.thresholds.reconcile_interval_seconds * 1000 }),
    retentionSeconds: thresholds.thresholds.retention_days * 86_400,
    heldThresholdSeconds: thresholds.thresholds.held_threshold_seconds,
    stderr: (text) => io.stderr(text),
  });

  if (started.kind === 'busy') {
    return refuse(io, `a bus is already answering on ${relativeBusSocket()}`);
  }
  if (started.kind === 'locked') {
    return refuse(io, `another start is binding ${relativeBusSocket()}; try again`);
  }
  if (started.kind === 'bind-failed') {
    return refuse(
      io,
      `the socket could not be bound${started.code === undefined ? '' : `: ${started.code}`}`,
    );
  }

  if (started.cleared) io.stderr('team bus: cleared a stale socket file\n');
  io.stderr(`team bus: answering on ${relativeBusSocket()}\n`);
  await stopped(sources.stop ?? signals);
  await started.handle.close();
  io.stderr('team bus: stopped\n');
  // exit: bus.started
  // exit: bus.stopped
  return 0;
}

function relativeBusSocket(): string {
  return '.agents/bus.sock';
}

/** Reads and unlinks the one-use token `team up` wrote. A link, a loose mode, or a mismatch is no. */
function consumeInherit(root: string, nonce: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  const path = join(root, '.agents', 'bus.inherit');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const held = readFileSync(path, 'utf8').trim();
    unlinkSync(path);
    return held === nonce;
  } catch {
    return false;
  }
}

function signals(end: () => void): () => void {
  const handler = () => end();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

function refuse(io: Io, message: string): number {
  io.stderr(`team bus: ${message}\n`);
  // exit: bus.refused
  return 1;
}

function badConfig(io: Io, message: string): number {
  io.stderr(`team bus: ${message}\n`);
  // exit: bus.configuration
  return 2;
}
