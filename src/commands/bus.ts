// `team bus`: the foreground process that owns the project's event log (`events.jsonl`), runs the
// periodic reconciliation pass, and serves `publish` and `subscribe` over `.agents/bus.sock`
// (RFC 002 Amendment 01 §4.1–§4.4). Only the owner runs it, from a terminal outside herdr, one
// per clone — shaped after `team broker`. No supervisor starts it in 0.5.1; when no bus is
// running, `team watch` and `team send` fall back cleanly to their record-polling and direct paths.
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { startBus } from '../bus/server.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { eventThresholdsInForce } from '../policy/index.ts';
import { stopped } from './broker.ts';

export const USAGE = `Usage: team bus

Runs the event bus for this clone over \`.agents/bus.sock\`, appending signed event records to the
project's event log and reconciling durable message and seat records. Only the owner runs it, from
a terminal outside herdr. Ctrl-C stops it.

Exits 0 when it started and stopped cleanly, 1 when it refused to start or could not bind its
socket, 2 when the invocation or team configuration can't be read.
`;

export type BusCommandSources = {
  home?: string;
  reconcileIntervalMs?: number;
  stop?: (end: () => void) => () => void;
};

export const bus: Command = (argv, io) => runBus(argv, io);
export default bus;

export async function runBus(argv: string[], io: Io, sources: BusCommandSources = {}): Promise<number> {
  const args = readArgs(argv, [], []);
  if (args.error || args.rest.length) {
    io.stderr(`team bus: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: bus.usage
    return 2;
  }

  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) return refuse(io, detached);

  if (!isOwner(caller)) {
    return refuse(
      io,
      `only the owner runs \`bus\`, from a terminal outside herdr; this call is ${describeCaller(caller)}`,
    );
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
