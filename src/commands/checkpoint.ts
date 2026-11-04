import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  callerOf,
  callerVerdict,
  describeCaller,
  detachedRefusal,
  fileOwnerRefusal,
  isOwner,
  judgeCallerIn,
  judgeCallerOf,
  noPaneRefusal,
  sessionOwnerRefusal,
  standingOf,
  walkCaller,
  type Caller,
  type SeatStanding,
} from '../caller.ts';
import { askCheckpoint } from '../checkpoint/checkpoint.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { readLaunchedTeam } from '../file/team-text.ts';
import type { Problem } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { gateVerdict } from '../permissions/who.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
import type { CheckpointRecord } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';

export const USAGE = `Usage: team checkpoint <seat> [--session <name>] [--file <path>] [--json]

Records a standing checkpoint ask for <seat> in team state (.agents/team.state.json) with its
resolved handover file path (.agents/handovers/<seat>-<timestamp>.md) and 30-minute deadline.
Does not require <seat> to be running or idle at the moment the ask is recorded, and does not
send a message itself.

Exits 0 when the checkpoint ask is recorded, 1 when the caller is refused or the state cannot be
written, 2 when the invocation, seat name, or team file is invalid.
`;

export type CheckpointSources = {
  home: string;
  now(): Date;
  standing?: (root: string) => Standing;
};

export const realSources: CheckpointSources = {
  home: homedir(),
  now: () => new Date(),
};

export const checkpoint: Command = (argv, io) => runCheckpoint(argv, io, realSources);
export default checkpoint;

/**
 * `team checkpoint <seat>` — records a standing checkpoint ask in `.agents/team.state.json`
 * (`checkpoints[seat]`) so the next `team restart <seat>` or `team down` can consume the seat's
 * handover file and carry it across the session chain. Who may run it: the owner, a placed
 * `leads` seat of this team on its recorded pane, or the entity's main orchestrator on its own
 * recorded pane.
 */
export async function runCheckpoint(
  argv: string[],
  io: Io,
  sources: Partial<CheckpointSources> = realSources,
): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv, ['session', 'file']);
  const args = readArgs(argv, ['session', 'file'], ['json']);
  if (args.error || args.rest.length !== 1) {
    const reason =
      args.error ??
      (args.rest.length > 1
        ? `unexpected "${plainLine(args.rest[1] ?? '')}"`
        : 'a seat name is required');
    return invocationRefused(out, json, reason, USAGE);
  }
  const name = args.rest[0] ?? '';

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, {
    who: 'the owner or a `leads` seat',
    where: 'a terminal outside the pane host or its own pane',
  });
  if (detached !== undefined) return callerRefused(out, json, detached);

  const flagRefusal =
    fileOwnerRefusal(io, args.values.file) ??
    (args.values.session !== undefined && !isOwner(walked)
      ? sessionOwnerRefusal(walked)
      : undefined);
  if (flagRefusal !== undefined) return callerRefused(out, json, flagRefusal, 'owner-only');

  const home = sources.home ?? homedir();
  const nowFn = sources.now ?? realSources.now;
  const now = nowFn();
  const launched = args.values.file ? undefined : launchedTeamFile(io, home);
  const readOptions = {
    home,
    ...(args.values.session !== undefined ? { session: args.values.session } : {}),
  };
  const loaded = args.values.file
    ? readTeamConfig(io.cwd, { ...readOptions, file: args.values.file })
    : launched !== undefined
      ? readLaunchedTeam(launched, readOptions)
      : readTeamConfig(io.cwd, readOptions);
  if (!loaded.ok) {
    return invocationRefused(
      out,
      json,
      loaded.errors.map((problem) => `${where(problem)}${plainText(problem.message)}`).join('\n'),
    );
  }
  const { team, root, path } = loaded;
  const dir = dirname(path);

  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, home, 'checkpoint', at, nowFn);
  const judged =
    args.values.session !== undefined
      ? {
          ...judgeCallerOf(
            io,
            args.values.session === 'default' ? undefined : args.values.session,
          ),
          session: args.values.session,
        }
      : judgeCallerIn(io, dir, team, verdictOf);
  const { caller, shown, session } = judged;
  if (session === 'default') {
    return callerRefused(out, json, 'session can\'t be "default", the terminal host\'s own session');
  }

  const standing = sources.standing?.(root) ?? approvalStanding(root, home);
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    return callerRefused(out, json, notInForce(standing));
  }

  const mayCheckpoint = verdictOf(caller, standingOf(dir, session, caller));
  const mainOrchestrator = entityMainOrchestrator(io, { home, root, entity: team.entity });
  if (mayCheckpoint.kind !== 'ok' && mainOrchestrator === null) {
    const refusal =
      mayCheckpoint.kind === 'no-pane'
        ? noPaneRefusal(mayCheckpoint.name)
        : mayCheckpoint.kind === 'another-pane'
          ? anotherPaneRefusal(mayCheckpoint.name, mayCheckpoint.recordedPane)
          : `only the owner or \`leads\` records a checkpoint ask; this call is ${plainLine(describeCaller(shown))}`;
    return callerRefused(out, json, refusal, 'owner-or-leads');
  }

  const declared = team.seats.find((seat) => seat.name === name);
  if (!declared) {
    return invocationRefused(
      out,
      json,
      `${plainLine(name)} is not a signed declared seat`,
      undefined,
      'team seats lists the seats the file declares',
    );
  }

  const who = describeCaller(mainOrchestrator ?? caller);
  let record: CheckpointRecord;
  try {
    record = askCheckpoint(dir, declared.name, session, who, now);
  } catch (error) {
    return ioRefused(
      out,
      json,
      `the state cannot be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logLine(dir, 'checkpoint', who, `asked ${declared.name} -> ${record.path}`, now);
  return recordedExit(out, json, declared.name, record);
}

/**
 * The entity's main orchestrator, when this run is it: the lead seat of the team whose project
 * is the entity itself, placed in that team's own session on the pane its state records.
 */
function entityMainOrchestrator(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  options: { home: string; root: string; entity: string | null },
): Caller | null {
  if (options.entity === null) return null;
  let records: ReturnType<typeof readTeams>;
  try {
    records = readTeams(options.home);
  } catch {
    return null;
  }
  const targetId = teamIdOf(options.root);
  const target = records[targetId];
  if (target === undefined || target.entity === null || target.entity !== options.entity) return null;
  for (const [id, record] of Object.entries(records)) {
    if (id === targetId) continue;
    if (record.entity !== options.entity || record.project !== options.entity) continue;
    const placed = callerOf(io, record.session);
    if (placed.kind !== 'seat' || placed.session !== record.session) continue;
    let loaded: ReturnType<typeof readTeamConfig>;
    try {
      loaded = readTeamConfig(record.root, { home: options.home });
    } catch {
      continue;
    }
    if (!loaded.ok) continue;
    if (loaded.team.entity !== options.entity || placed.name !== loaded.team.orchestrator) continue;
    const at = standingOf(dirname(loaded.path), record.session, placed);
    if (callerVerdict(placed, placed.name, at).kind !== 'ok') continue;
    return placed;
  }
  return null;
}

function where(problem: Problem): string {
  return problem.line ? `line ${problem.line}: ` : '';
}

function invocationRefused(
  out: Io,
  json: boolean,
  message: string,
  usage?: string,
  repair: string | null = null,
): number {
  refuse(out, json, 'checkpoint', {
    id: 'checkpoint.invocation',
    message,
    repair,
    ...(usage !== undefined ? { usage } : {}),
  });
  // exit: checkpoint.invocation
  return 2;
}

function callerRefused(out: Io, json: boolean, message: string, rule?: string): number {
  refuse(out, json, 'checkpoint', {
    id: 'checkpoint.caller',
    message,
    repair: null,
    ...(rule !== undefined ? { rule } : {}),
  });
  // exit: checkpoint.caller
  return 1;
}

function ioRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'checkpoint', {
    id: 'checkpoint.io',
    message,
    repair: null,
  });
  // exit: checkpoint.io
  return 1;
}

function recordedExit(out: Io, json: boolean, seat: string, record: CheckpointRecord): number {
  const summary = `team checkpoint: recorded ${plainLine(seat)} -> ${plainLine(record.path)} (by ${plainLine(record.deadline)})`;
  if (json) {
    writeJson(out, 'team.checkpoint', {
      format: 1 as const,
      dry_run: false,
      status: 'recorded',
      action_summary: summary,
      seat,
      path: record.path,
      at: record.at,
      deadline: record.deadline,
      by: record.by,
    });
  } else {
    out.stdout(`${summary}\n`);
  }
  // exit: checkpoint.recorded
  return 0;
}
