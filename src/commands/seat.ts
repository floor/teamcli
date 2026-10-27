// `team seat <seat>` — one seat as an object: the settings it holds and where each value comes
// from, the row `team seats` reads for it (status, state, pane, last active), the newest CLI
// session TeamCLI recorded for it in this session (its conversation and cost) and the CLI hook's
// last turn boundary when the launch keeps one. The composition writes nothing. The seat's
// lifecycle is grouped under the same word — `team seat add|remove|restart|rename` run the
// top-level commands, which stay as aliases — and dispatch first.

import { watchInForceOf } from '../approve/approval.ts';
import { runAdd } from './add.ts';
import { readArgs } from '../args.ts';
import { homedir } from 'node:os';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, verifyClientForm } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { readSeatSettings } from '../config/read.ts';
import { sayApply, sayConfigOrigin, sayConfigValue } from '../config/text.ts';
import { currentTeam } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import type { Problem } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { readCliHook } from '../launch/cli-hook.ts';
import { presenceChannelHealthy, presenceSeatsOf } from '../labels/presence.ts';
import {
  CLI_HOOK_FRESH_SECONDS,
  CLI_HOOK_FUTURE_SKEW_SECONDS,
  type CliHookReading,
} from '../labels/state.ts';
import { hasJsonFlag, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';
import { supportsCliHook } from '../profiles/profile.ts';
import { mayReadTeam } from '../read-gate.ts';
import { continuityIdsOf } from '../registry/resume.ts';
import { runRemove } from './remove.ts';
import { runRename } from './rename.ts';
import { runRestart } from './restart.ts';
import { readAllSessions, type SessionRecord } from '../sessions/registry.ts';
import { emptySession, liveHold, readState } from '../state.ts';
import { compare } from '../status/compare.ts';
import { costText, shortStamp } from './sessions.ts';
import {
  realSeatsSources,
  seatRegistryRows,
  type SeatsSources,
  type SeatRegistryRow,
} from './seats.ts';

export const USAGE = `Usage: team seat <seat> [--session <name>] [--file <path>] [--json]
       team seat <seat> --client <grant-file> --key <client-key> [--team <team>] [--json]
       team seat add <seat> [--session <name>] [--file <path>] [--json]
       team seat remove <seat> [--session <name>] [--file <path>] [--json]
       team seat restart <seat> [--session <name>] [--file <path>] [--json]
       team seat rename <seat> <name> [--session <name>] [--file <path>] [--json]

Shows one seat as an object: its settings and where each value comes from, its status and state as \`team seats\` reads them, and the newest CLI session TeamCLI recorded for it in this session — the conversation, when it started and ended, and its cost when one was measured. Reads the team file, the state and the session registry; changes nothing. The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying seat for: it reads that one team, as signed, and nothing else (--file and --session are the owner's and take no --client). The lifecycle verbs group the commands of the same names — \`team seat add\` runs \`team add\`, and so on — and take that command's own options; the top-level commands stay. A common option may come before the verb: \`team seat --json restart <seat>\` runs \`team restart <seat> --json\`.

Exits 0 when the seat is shown, 1 when an owner-only flag is refused, the seat is not declared, or a session registry can't be read, and 2 when the invocation, the team file, or herdr can't be read.
`;

export type SeatSources = SeatsSources;

export const seat: Command = (argv, io) => runSeat(argv, io, realSeatsSources);
export default seat;

type Turn = { state: CliHookReading['state']; since: string };

/** The options `team seat` and every grouped verb share; the valued ones by name. */
const COMMON_VALUED = new Set(['session', 'file']);

/** The words in dispatch order. A common option written ahead of the verb reaches that verb's
 *  handler unchanged, so `team seat --json restart <seat>` is `team restart <seat> --json`; the
 *  scan consumes an option's value, so a value spelled like a verb (a session called `restart`)
 *  is never read as one. A first word that is not a verb is left exactly as the caller wrote it,
 *  and stays the seat to read. */
function verbFirst(argv: string[]): string[] {
  const ahead: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const word = argv[index] as string;
    if (word === '--json') {
      ahead.push(word);
      index += 1;
      continue;
    }
    const [name, inline] = word.startsWith('--')
      ? word.slice(2).split(/=(.*)/s) as [string, string | undefined]
      : ['', undefined];
    if (!COMMON_VALUED.has(name)) break;
    if (inline !== undefined) {
      ahead.push(word);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) break;
    ahead.push(word, value);
    index += 2;
  }
  const verb = argv[index];
  if (verb !== 'add' && verb !== 'remove' && verb !== 'restart' && verb !== 'rename') return argv;
  return [verb, ...ahead, ...argv.slice(index + 1)];
}

export async function runSeat(argv: string[], rawIo: Io, sources: SeatSources = realSeatsSources): Promise<number> {
  // The verb is read before the option parser: a grouped verb carries the top-level command's
  // own options, which this command's `readArgs` would refuse.
  const args = { rest: verbFirst(argv) };
  const verb = args.rest[0];
  if (verb === 'add') return runAdd(args.rest.slice(1), rawIo);
  if (verb === 'remove') return runRemove(args.rest.slice(1), rawIo);
  if (verb === 'restart') return runRestart(args.rest.slice(1), rawIo);
  if (verb === 'rename') return runRename(args.rest.slice(1), rawIo);

  let io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const read = readArgs(argv, ['session', 'file', 'client', 'key', 'team'], ['json']);
  const clientProblem = read.error === undefined && read.rest.length === 1
    ? clientFormProblem(read.values, 'team seat <seat> --client <grant-file> --key <client-key-file>')
      ?? (read.values.client !== undefined && (read.values.file !== undefined || read.values.session !== undefined)
        ? "--client reads the one team its grant names: --file and --session are the owner's and take no --client"
        : null)
    : null;
  if (read.error !== undefined || read.rest.length !== 1 || clientProblem !== null) {
    const why = read.error
      ?? (read.rest.length === 0 ? 'a seat name is required' : read.rest.length > 1 ? `unexpected "${read.rest[1]}"` : clientProblem ?? 'the invocation cannot be read');
    if (json) {
      writeJsonError(io, 'seat.invocation', why, null);
    } else {
      io.stderr(`team seat: ${why}\n${USAGE}`);
    }
    // exit: seat.invocation
    return 2;
  }
  const seatName = read.rest[0] as string;

  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before any file is read; the read gate's second door, never a second gate.
  let clientRead = false;
  if (read.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const home = sources.home ?? homedir();
    const verified = verifyClientForm({ home, now: at, io }, { op: 'seat', values: read.values, cwd: io.cwd });
    const stood = verified.ok ? authorizeClientRun(home, verified.run, 'seat', at) : null;
    if (!verified.ok || stood !== null) {
      const why = verified.ok ? stood! : verified.why;
      auditClientRefusal('seat', verified.ok ? verified.run.grant : verified.named, why, at);
      if (json) writeJsonError(io, 'seat.client-refused', why, null);
      else io.stderr(`team seat: ${why}\n`);
      // exit: seat.client-refused
      return 1;
    }
    clientRead = true;
    // The folder is the grant's, whatever the caller's: from here every read is of that team.
    io = { ...io, cwd: verified.run.root };
    if (!json) io.stderr(`client grant ${verified.run.grant.grantId}: ${verified.run.grant.clientId} for team ${verified.run.grant.up.project} at ${verified.run.root}, until ${verified.run.grant.expires}\n`);
  }
  const walked = walkCaller(io);
  // A client run is never the owner's, whatever terminal it stands in.
  const owner = !clientRead && isOwner(walked);
  if (read.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, read.values.file);
    if (refusal !== undefined) {
      if (json) {
        writeJsonError(io, 'seat.file-owner', refusal, 'the owner runs `team seat <seat> --file <path>` from a terminal outside herdr', 1, 'owner-only');
      } else {
        io.stderr(`team seat: ${refusal}\n`);
      }
      // exit: seat.file-owner
      return 1;
    }
  }
  if (read.values.session !== undefined && !owner) {
    const refusal = sessionOwnerRefusal(walked);
    if (json) {
      writeJsonError(io, 'seat.session-owner', refusal, 'the owner runs `team seat <seat> --session <name>` from a terminal outside herdr', 1, 'owner-only');
    } else {
      io.stderr(`team seat: ${refusal}\n`);
    }
    // exit: seat.session-owner
    return 1;
  }

  const now = sources.now();
  const current = currentTeam(io.cwd, owner ? read.values.file : undefined, now, sources.home, owner);
  if (!owner) {
    if (!current.ok || !(clientRead || mayReadTeam(current, io, sources))) {
      if (json) {
        writeJsonError(io, 'seat.not-yours', 'this team is not yours to read', null);
      } else {
        io.stderr('team seat: this team is not yours to read\n');
      }
      // exit: seat.not-yours
      return 2;
    }
  } else if (!current.ok) {
    const id = current.errors[0]?.message.includes('not inside a git repository')
      ? 'seat.not-a-repo'
      : current.errors.some(isParseError)
        ? 'seat.file-invalid'
        : 'seat.file';
    if (json) {
      const msg = current.errors.map((p) => `${p.line ? `team config line ${p.line}: ` : ''}${p.message}`).join('; ');
      writeJsonError(io, id, msg, null);
    } else {
      printProblems(io, current.errors);
    }
    // exit: seat.not-a-repo
    // exit: seat.file
    // exit: seat.file-invalid
    return 2;
  }

  const { team, root, dir } = current;
  const declared = team.seats.find((one) => one.name === seatName);
  if (declared === undefined) {
    return refuseNoSeat(io, json, seatName, team.project);
  }
  if (!json && current.notice !== undefined) io.stdout(`${current.notice}\n`);

  const session = read.values.session ?? team.session;
  const whole = readState(dir);
  const state = whole.sessions[session] ?? emptySession();
  const live = sources.live(session, team, state);
  if (live === null) {
    if (json) {
      writeJsonError(
        io,
        'seat.herdr',
        "herdr doesn't answer; is it installed and running?",
        'start herdr and run `team seat <seat>` again',
      );
    } else {
      io.stderr("team seat: herdr doesn't answer; is it installed and running?\n");
    }
    // exit: seat.herdr
    return 2;
  }
  const continuityIds = sources.home === undefined ? undefined : continuityIdsOf({
    home: sources.home,
    root,
    herdrSession: session,
    seats: team.seats,
    states: state.seats,
  });
  const comparison = compare(team, session, state, live, now, watchInForceOf(sources.standing(root), team), undefined, false, undefined, continuityIds);
  // One fresh daemon health probe for this display: its route verdict is the only thing that
  // makes a projection live. Default closed, never a persisted status word.
  const health = sources.daemonHealth === undefined || sources.home === undefined
    ? null
    : await sources.daemonHealth(sources.home);
  const presenceHealthy = health !== null && presenceChannelHealthy(health, root, session, now);
  // The same fresh answer's per-seat verdicts: a seat carried by the route's seat list is live
  // only by its own serving entry and the binding that entry sampled.
  const presenceSeats = health === null ? undefined : presenceSeatsOf(health, root, session, now);
  const row = seatRegistryRows(team, state, live, comparison, now, true, liveHold(whole, now) !== null, {
    project: team.project,
    root,
    home: sources.home,
    stateDir: dir,
    session,
    presenceChannelHealthy: presenceHealthy,
    ...(presenceSeats === undefined ? {} : { presenceSeats }),
  }).find((candidate) => candidate.name === seatName);
  if (row === undefined) {
    // A declared seat always has a comparison row; this is the file and the state disagreeing
    // in a way no other command sees. Refuse rather than print half an object.
    return refuseNoSeat(io, json, seatName, team.project);
  }

  let conversation: SessionRecord | null = null;
  if (sources.home !== undefined) {
    const read = readAllSessions(sources.home);
    if (!read.ok) {
      if (json) {
        writeJsonError(io, 'seat.sessions', read.reason, null);
      } else {
        io.stderr(`team seat: ${read.reason}\n`);
      }
      // exit: seat.sessions
      return 1;
    }
    const matching = read.sessions.filter((record) =>
      record.team === team.project && record.seat === seatName && record.herdr_session === session);
    conversation = matching.length === 0 ? null : matching[matching.length - 1] as SessionRecord;
  }

  const turn = turnOf(row, dir, session, now);
  const settingsRead = readSeatSettings({
    home: sources.home ?? null,
    root,
    project: team.project,
    seat: declared,
    teamDeliveryOrder: team.deliveryOrder,
    entity: team.entity,
  });
  if (!settingsRead.ok) {
    if (json) {
      writeJsonError(io, 'seat.source', settingsRead.refusals.map((one) => one.why).join('; '), null);
    } else {
      for (const refusal of settingsRead.refusals) io.stderr(`team seat: ${refusal.why}\n`);
    }
    // exit: seat.source
    return 2;
  }
  const settings = settingsRead.rows;

  if (json) {
    writeJson(io, 'team.seat', {
      format: 1,
      project: team.project,
      session,
      seat: seatName,
      settings: settings.map((entry) => ({
        key: entry.key,
        value: entry.value,
        source: entry.origin,
        applies: entry.applies,
        ...(entry.sourceFile !== undefined ? { source_file: entry.sourceFile } : {}),
      })),
      status: statusJson(row),
      turn,
      conversation: conversation === null ? null : conversationJson(conversation),
      ...(conversation?.cost !== undefined ? { cost: conversation.cost } : {}),
      ...(conversation?.tokens !== undefined ? { tokens: conversation.tokens } : {}),
    });
  } else {
    const style = ttyStyle(io, { json });
    const settingsLines = renderTable({
      headers: ['KEY', 'VALUE', 'SOURCE', 'APPLIES'],
      rows: settings.map((entry) => [entry.key, sayConfigValue(entry.value), sayConfigOrigin(entry.origin), sayApply(entry.applies)]),
      style,
    });
    const objectLines = renderTable({
      headers: ['FIELD', 'VALUE'],
      rows: [
        ['project', team.project],
        ['session', session],
        ['role', row.role],
        ['id', row.id ?? '-'],
        ['status', row.stored ?? row.status],
        ['state', row.blind ? `${row.state} (blind)` : row.state],
        ['source', row.state_source],
        ['pane', row.pane ?? '-'],
        ['last active', row.last_active_display],
        ['turn', turn === null ? '-' : `${turn.state} since ${shortStamp(turn.since)}`],
        ['conversation', conversation?.id ?? '-'],
        ['cli session', conversation?.cli_session ?? '-'],
        ['resumable', conversation?.resumable === undefined ? '-' : conversation.resumable ? 'yes' : 'no'],
        ['started', conversation === null ? '-' : shortStamp(conversation.ts)],
        ['ended', conversation?.ended === undefined ? '-' : shortStamp(conversation.ended)],
        ['cost', costText(conversation?.cost)],
      ],
      style,
    });
    io.stdout(`${settingsLines.join('\n')}\n\n${objectLines.join('\n')}\n`);
  }
  // exit: seat.shown
  return 0;
}

/** The one seat refusal: the name the caller asked for is not a seat this team file declares. */
function refuseNoSeat(io: Io, json: boolean, seatName: string, project: string): number {
  const message = `no seat "${seatName}" is declared in ${project}`;
  if (json) {
    writeJsonError(io, 'seat.no-seat', message, null);
  } else {
    io.stderr(`team seat: ${message}\n`);
  }
  // exit: seat.no-seat
  return 1;
}

/** The newest hook reading inside the day, and only the seat's own: a pane `team` did not launch
 *  is read by `seatRegistryRows` the same way, and its hook file is not this seat's record. */
function turnOf(row: SeatRegistryRow, dir: string, session: string, now: Date): Turn | null {
  if (row.status === 'restored, not launched by team' || !supportsCliHook(row.cli)) return null;
  const hook = readCliHook(dir, session, row.name);
  if (hook === null) return null;
  const wrote = Date.parse(hook.since);
  if (!Number.isFinite(wrote)) return null;
  if (wrote - now.getTime() > CLI_HOOK_FUTURE_SKEW_SECONDS * 1000) return null;
  if (now.getTime() - wrote > CLI_HOOK_FRESH_SECONDS * 1000) return null;
  return { state: hook.state, since: hook.since };
}

function statusJson(row: SeatRegistryRow): Record<string, unknown> {
  return {
    name: row.name,
    nickname: row.nickname ?? null,
    id: row.id,
    role: row.role,
    cli: row.cli,
    model: row.model,
    effort: row.effort,
    status: row.stored ?? row.status,
    state: row.state,
    state_source: row.state_source,
    ...(row.blind ? { blind: true as const } : {}),
    last_active: row.last_active,
    pane: row.pane,
    launch_line: row.launch_line,
    ...(row.presence !== undefined ? { presence: row.presence } : {}),
    ...(row.presence_unreadable === true ? { presence_unreadable: true as const } : {}),
  };
}

function conversationJson(record: SessionRecord): Record<string, unknown> {
  return {
    id: record.id,
    ...(record.cli_session === undefined ? {} : { cli_session: record.cli_session }),
    ...(record.resumable === undefined ? {} : { resumable: record.resumable }),
    ...(record.resume_until === undefined ? {} : { resume_until: record.resume_until }),
    ...(record.handover === undefined ? {} : { handover: record.handover }),
    ...(record.previous === undefined ? {} : { previous: record.previous }),
    started: record.ts,
    ended: record.ended ?? null,
    reason: record.reason ?? null,
  };
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team seat: ${problem.line ? `team config line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}
