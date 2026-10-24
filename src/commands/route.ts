// `team route <seat>`: may this caller address this seat at all, and where does that seat
// listen? The answer is the native channel's first half — a sender that delivers with its own
// tool asks here first — and it is one record before it is one answer.
//
// The judgement is `team send`'s own, in its own order: the caller and its placement, the
// recipient resolved through the registry, admission over the same records (`admitSend`,
// default deny, the grant store last). A spec the registry holds no record for is refused
// here rather than resolved to a declared seat: a route answers an address *from the
// registry*, and a seat without a record has none to hand out.
//
// The recipient is resolved live before any address is read: herdr must name the seat on a pane
// of its session, on the CLI its record names. A recorded pane is never trusted — panes close
// and are reused, and an address read from a pane another seat now stands on would be that
// seat's, not this one's. A seat herdr does not name there is refused, and no address answered.
//
// This process never touches another session's socket. The address is read — the record's own
// path, the live pane's process list, the socket folders' file names — and named; whether to
// dial it is the sender's own decision, in its own process.

import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, detachedRefusal, judgeCallerIn, logTag, standingOf } from '../caller.ts';
import { PROFILES, processNameMatches } from '../clis.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import type { Agent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { contextLine, displayPath, hasJsonFlag, renderDryRunPlan, writeJson, writeJsonError, type PlanStep } from '../output/index.ts';
import { resolveTarget } from '../send/resolve.ts';
import { appendRoute, readRouteAddress, ROUTES_FILE, type RouteAddress, type RouteRecord } from '../send/routes.ts';
import { storePath } from '../store/store.ts';
import { admissionOf, realHost, type SendHost } from './send.ts';

export const USAGE = `Usage: team route <seat> [--json] [--dry-run]

Answers one seat's address for the native channel: the recipient's agent id, session, CLI and
pane, and the socket path its session listens on — the recorded address while its process still
runs in the pane, else the socket the pane carries now. The recipient is resolved live: herdr
must name the seat on a pane of its session, on the CLI its record names, and that pane is the
one read — never the pane the record carries. A seat herdr does not name there is refused, and
no address is answered. Access is decided exactly as a send's is, by the registry's own rules,
default deny: only an admitted pair is answered, and the rule that admitted it is named. A seat
the registry holds no record for is refused: a route hands out a recorded address, and
\`team up\` or \`team register\` writes the record.

The route is one record before it is one answer: a line is appended to the receiving project's
routes.jsonl (beside its messages.jsonl) naming the pair, the rule and the address, and a
record that cannot be written is a refusal — an address this CLI handed out is accountable.
--dry-run answers the same, prints its one plan step and writes nothing. The answer opens
on the team's context line and closes on the resolved address. --json prints one document
instead of the lines: {seat, agent, recipient_session, cli, pane, address, socket_state,
native, rule, action_summary}.

This process never opens, dials or writes to another session's socket: the address is read
from the registry, the pane's process list and the socket folders, and named. The session line
is the herdr session the seat runs in, never a cross-session SendMessage target: \`team send
<seat> <message>\` prints the exact to: line a native handoff makes, and \`team send --record
<seat> --channel native --ms <N>\` writes down a delivery made without one. It appends one line
to the team log.

Exits 0 when the address is answered, 1 when the route is refused or cannot be recorded, 2 when
the invocation or team file cannot be read.
`;

/** What the run reports besides its streams: the caller chose the document. */
type Report = { json: boolean };

export async function runRoute(argv: string[], io: Io, host: SendHost): Promise<number> {
  const args = readArgs(argv, [], ['json', 'dry-run']);
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const report: Report = { json: hasJsonFlag(argv) };
  if (args.error) return usage(io, args.error, report);
  const detached = detachedRefusal(callerOf(io), { who: 'the owner or a seat the send admission admits', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) {
    if (report.json) writeJsonError(io, 'route.detached', detached, 'run team route from a terminal outside herdr');
    else io.stderr(`team route: ${detached}\n`);
    return 1; // exit: route.detached
  }
  const spec = args.rest[0];
  if (!spec) return usage(io, 'a seat, a seat@team or an agent id is required', report);
  if (args.rest.length > 1) return usage(io, 'route names one seat and takes nothing else', report);

  const loaded = readTeamConfig(io.cwd, { home: host.home });
  if (!loaded.ok) {
    // `team route` takes no `--file`, so the no-repository refusal must not offer one.
    const message = loaded.errors
      .map((problem) => (problem.line ? `line ${problem.line}: ${withoutFileOffer(problem.message)}` : withoutFileOffer(problem.message)))
      .join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  const { team, root } = loaded;
  const context: TeamContext = { project: team.project, session: team.session };
  const dir = dirname(loaded.path);
  const fileTeamId = teamIdOf(root);
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logTag(caller);

  // The registry's own answer, and only it: a spec the store holds no record for is refused
  // with the reading's own words (which name the commands that write the record), never
  // resolved to a declared seat — this command hands out addresses, and a declared seat has
  // none to hand out.
  const resolved = resolveTarget(host.home, spec, io, (session) => host.agents(session));
  if ('error' in resolved) return refused(io, dir, who, resolved.error, host, report);

  const standing = standingOf(dir, judged.session, caller);
  const admission = admissionOf(caller, team, resolved, spec, host.home, fileTeamId, () => host.now(), standing);
  if (!admission.ok) return refused(io, dir, who, admission.why, host, report);

  const recipient = resolved.agent;
  // A seat the receiving team file marks `stopped: true` has no address to hand out: no route
  // is planned, nothing is recorded, and the answer names the seat's own state rather than the
  // pane herdr no longer shows. The file is the caller's own for a same-team route, and the
  // receiving team's for a cross-team one.
  const receiving = resolved.team.root === root ? loaded : readTeamConfig(resolved.team.root, { home: host.home });
  const declared = receiving.ok ? receiving.team.seats.find((seat) => seat.name === recipient.reach.seat) : undefined;
  if (declared?.stopped === true) return refused(io, dir, who, `${recipient.reach.seat} is stopped`, host, report);
  // The placement the answer is built on: herdr's live reading of the seat, never the record's
  // pane. A pane reused by another seat is not this seat's address, and is never read for one.
  const placement = livePlacement(host, recipient);
  if ('error' in placement) return refused(io, dir, who, placement.error, host, report);
  const pane = placement.pane;
  const processes = host.processInfo(recipient.reach.session, pane);
  const address = readRouteAddress(recipient.reach.address, processes, socketFolders(host));
  const native = recipient.cli === 'claude-code';
  const fromId = typeof admission.sender === 'object' && 'id' in admission.sender ? admission.sender.id : null;
  const record: RouteRecord = {
    ts: host.now().toISOString(),
    from: who,
    from_id: fromId,
    to: recipient.reach.seat,
    to_id: recipient.id,
    team: recipient.reach.team,
    session: recipient.reach.session,
    pane,
    socket: address.socket,
    socket_state: address.state,
    native,
    rule: admission.rule,
  };

  const cross = resolved.team.root !== root;
  const toDir = cross ? join(resolved.team.root, '.agents') : dir;
  const at: Routed = {
    name: recipient.name,
    seat: recipient.reach.seat,
    id: recipient.id,
    session: recipient.reach.session,
    cli: recipient.cli,
    pane,
  };
  if (args.flags.has('dry-run')) {
    const target = join(storePath(resolved.team.project, resolved.team.root, host.home), ROUTES_FILE);
    const plan: PlanStep[] = [{ step: 'record', seat: at.seat, detail: `append the route to ${target}`, prefix: '+' }];
    return routeDry(io, context, at, address, native, admission.rule, plan, host.home, report);
  }
  const written = appendRoute(resolved.team.project, resolved.team.root, host.home, record);
  if (!written.ok) return unrecorded(io, dir, who, written.reason, host, report);
  // A lookup, not a delivery: the line says what was read — the address's state and whether the
  // recipient carries the native channel — never a word a seat reads as a message arriving.
  logLine(toDir, 'route', who, `looked up ${at.seat}: ${socketStateText(address)}, native ${native ? 'yes' : 'no'}`, host.now());
  return routed(io, context, at, address, native, admission.rule, report);
}

/** Where the recipient stands now, as herdr reads it: the one pane the session names its seat on,
 *  and only where the CLI herdr reports there is the CLI the record names. The record's own pane
 *  is not a fallback — a pane that closed and was reused belongs to whatever seat stands on it,
 *  and its socket would be that seat's. A seat herdr does not name, names twice, or names on
 *  another CLI gets no address: the reading says the record and the pane no longer agree. */
function livePlacement(host: SendHost, agent: Agent): { pane: string } | { error: string } {
  const session = agent.reach.session;
  const agents = host.agents(session);
  if (agents === null) {
    return { error: `${agent.id}: the session "${session}" could not be read, so no address was answered` };
  }
  const named = agents.filter((one) => one.name === agent.reach.seat);
  if (named.length === 0) {
    return { error: `${agent.id}: herdr names no seat "${agent.reach.seat}" in the session "${session}", so no address was answered` };
  }
  if (named.length > 1) {
    return { error: `${agent.id}: herdr lists more than one agent named "${agent.reach.seat}"; no address was answered` };
  }
  const live = named[0] as { pane: string; cli?: string | null };
  const cli = live.cli ?? null;
  if (cli === null) {
    return { error: `${agent.id}: herdr does not report the CLI of "${agent.reach.seat}", so no address was answered` };
  }
  const profile = PROFILES.find((one) => one.cli === agent.cli);
  // herdr's `agent` field names the CLI it detected. Most CLIs it names by process (`claude`
  // for claude-code), which is what a profile's `processes` list holds; a cursor session it
  // names `cursor` while the profile's process name is the launch binary `cursor-agent`. The
  // record and the live pane agree when herdr's name is the recorded CLI itself, so that is a
  // match on its own; the profile's process names remain the reading for the CLIs herdr names
  // by process.
  const same = cli === agent.cli || (profile !== undefined && processNameMatches(cli, profile.processes));
  if (!same) {
    return { error: `${agent.id}: herdr names "${agent.reach.seat}" running "${cli}", not the recorded CLI "${agent.cli}"; no address was answered` };
  }
  return { pane: live.pane };
}

/** The team context every answer opens on: the caller's own file. */
type TeamContext = { project: string; session: string };

/** Who was routed where: the recipient as the registry named it and herdr placed it. */
type Routed = { name: string; seat: string; id: string; session: string; cli: string; pane: string };

/** The address was answered and recorded. Exit 0, always. */
function routed(
  io: Io,
  context: TeamContext,
  at: Routed,
  address: RouteAddress,
  native: boolean,
  rule: string,
  report: Report,
): number {
  const summary = addressSummary(at, address);
  if (report.json) {
    writeJson(io, 'team.route', document(context, at, address, native, rule, false, 'routed', summary));
  } else {
    io.stdout(`${contextLine(context.project, context.session)}\n`);
    answerLines(io, at, address, native, rule);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: route.routed
}

/** The answer --dry-run gives: the same address, plus the one step a real run would take. */
function routeDry(
  io: Io,
  context: TeamContext,
  at: Routed,
  address: RouteAddress,
  native: boolean,
  rule: string,
  plan: readonly PlanStep[],
  home: string,
  report: Report,
): number {
  if (report.json) {
    writeJson(io, 'team.route', {
      ...document(context, at, address, native, rule, true, 'dry-run', 'dry run: nothing was run'),
      plan: [...plan],
    });
  } else {
    io.stdout(`${contextLine(context.project, context.session)}\n`);
    answerLines(io, at, address, native, rule);
    io.stdout(renderDryRunPlan(null, plan).map((line) => `${displayPath(line, home)}\n`).join(''));
  }
  return 0; // exit: route.dry-run
}

/** The resolved address, said once: the closing summary line, and `action_summary` under --json. */
function addressSummary(at: Routed, address: RouteAddress): string {
  return `${at.seat}: routed at ${address.socket ?? 'no socket'} (${address.state})`;
}

/** The one document both endings write: the action surface, then the answer's own fields.
 *  `session` is the envelope's — the caller's team session; the recipient's is `recipient_session`. */
function document(
  context: TeamContext,
  at: Routed,
  address: RouteAddress,
  native: boolean,
  rule: string,
  dryRun: boolean,
  status: string,
  summary: string,
): Record<string, unknown> {
  return {
    format: 1 as const,
    dry_run: dryRun,
    status,
    action_summary: summary,
    project: context.project,
    session: context.session,
    seat: at.seat,
    agent: at.id,
    recipient_session: at.session,
    cli: at.cli,
    pane: at.pane,
    address: address.socket,
    socket_state: address.state,
    native,
    rule,
  };
}

/** The plain answer: the recipient, where it listens, and the rule that admitted the pair. */
function answerLines(io: Io, at: Routed, address: RouteAddress, native: boolean, rule: string): void {
  io.stdout(`${at.seat}  ${at.id}  (${at.name})\n`);
  io.stdout(`session ${at.session}\n`);
  io.stdout(`cli ${at.cli}\n`);
  io.stdout(`pane ${at.pane}\n`);
  io.stdout(`socket ${address.socket ?? 'none'} (${socketStateText(address)})\n`);
  io.stdout(`native ${native ? 'yes' : 'no'}\n`);
  io.stdout(`admitted by: ${rule}\n`);
}

/** Where the address stands, as the lines word it. */
function socketStateText(address: RouteAddress): string {
  if (address.state === 'live') return 'live';
  if (address.state === 'stale') return 'stale; do not dial it';
  if (address.state === 'pane') return 'found on the pane';
  if (address.state === 'unread') return 'recorded; the pane could not be read';
  return 'none';
}

/** The address's folders: the host's own, in discovery order — `send`'s rule. */
function socketFolders(host: SendHost): string[] {
  return host.socketsDirAlt === undefined ? [host.socketsDir] : [host.socketsDir, host.socketsDirAlt];
}

/** A refusal: no address was answered, and the reason says why. Exit 1, always. */
function refused(io: Io, dir: string, who: string, reason: string, host: SendHost, report: Report): number {
  logLine(dir, 'route', who, `refused: ${reason}`, host.now());
  if (report.json) writeJsonError(io, 'route.refused', `refused: ${reason}`, null);
  else io.stderr(`team route: refused: ${reason}\n`);
  return 1; // exit: route.refused
}

/** The pair was admitted, and the record could not be written: nothing is answered. Exit 1,
 *  always — an address this CLI hands out is accountable, or it is not handed out. */
function unrecorded(io: Io, dir: string, who: string, reason: string, host: SendHost, report: Report): number {
  const why = `the route record could not be written: ${reason}`;
  logLine(dir, 'route', who, `refused: ${why}`, host.now());
  if (report.json) writeJsonError(io, 'route.unrecorded', `refused: ${why}`, null);
  else io.stderr(`team route: refused: ${why}\n`);
  return 1; // exit: route.unrecorded
}

function usage(io: Io, message: string, report: Report): number {
  if (report.json) writeJsonError(io, 'route.usage', message, null);
  else io.stderr(`team route: ${message}\n${USAGE}`);
  return 2; // exit: route.usage
}

function configuration(io: Io, message: string, report: Report): number {
  if (report.json) writeJsonError(io, 'route.configuration', message, null);
  else io.stderr(`team route: ${message}\n`);
  return 2; // exit: route.configuration
}

const route: Command = (argv, io) => runRoute(argv, io, realHost);
export default route;
