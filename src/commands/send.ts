import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, detachedRefusal, judgeCallerIn, logTag, noPaneRefusal, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { agentList, agentStatus, paneForegroundCwd, paneProcesses, paneRead, pressEnter, sendKey, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { rulesOf } from '../launch/rules.ts';
import { acquireSeatLock, seatLockPath } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { contextLine, hasJsonFlag, pluralCount, renderTable, writeJson, writeJsonError, type PlanStep } from '../output/index.ts';
import { profileFor } from '../profiles/index.ts';
import { readAgents, type Agent } from '../registry/agents.ts';
import * as projectRegistry from '../registry/projects.ts';
import { readTeams, teamIdOf, type TeamRecord } from '../registry/teams.ts';
import { realSources as realProjectSources, type ProjectSources } from './projects.ts';
import { liveSocketOf } from '../send/address.ts';
import { admitSend, RULE_SUMMARY, sendGrantFor, senderHeader, teamOf, type AdmitContext, type AdmitTeam, type AdmitTeams, type DeclaredSender, type SendSide } from '../send/admit.ts';
import { deliverCompose } from '../send/compose.ts';
import { readSendGrants } from '../send/grants.ts';
import { appendHistory } from '../send/history.ts';
import { NATIVE_BODY_MARKER, NATIVE_CHANNEL } from '../send/routes.ts';
import { daemonSocketPath, isBareShellPane, requestDaemon, type DaemonSendResponse } from '../send/daemon.ts';
import { deliveryChainOf } from '../send/delivery.ts';
import { bindPane, deliverTrigger, showsHeldFrameDialog, TAKEN_REASON, type DeliverResult } from '../send/deliver.ts';
import { dropMessage, POLL_MS, triggerLine, TRIGGER_MAX, type NativePane } from '../send/native.ts';
import { markPending } from '../send/pending.ts';
import { markTaken } from '../send/taken.ts';
import { openReplyListener, readReply } from '../send/reply.ts';
import { isRegistrySpec, parseSpec, resolveTarget, type Target } from '../send/resolve.ts';
import { FRAME_LIMIT, SOCKET_SEND, sendFrame, type SendOutcome } from '../send/uds.ts';
import { type DeliveryLeg, type SettingLevel } from '../settings/inherit.ts';
import { deliveryOrder } from '../settings/resolve.ts';

export const USAGE = `Usage: team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
       team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
       team send --list [--json]

Writes one message to one seat. A plain send writes the body whole to a drop file
(mode 0600, atomic rename) and types one short trigger line, for every seat. The
body is never split across several writes. A seat whose CLI builds its own work
item from its screens — a profile with a compose module — still gets the drop
file, but the body is typed through those screens and never becomes a trigger
line; delivered there means the CLI printed the line that creates the item.
delivered means herdr reported
the seat working — or done or blocked, changed from the status read before Enter —
after that line and Enter, or the transcript shows the drop being read, and the line has
left the seat's input box, and the pane is not a dialog this command already classifies
(question, permission, trust, vendor notice, provider error, rate limit). A screen that
is one of those is not reached: the kind and the drop path are named, and nothing
further is pressed. Who may call it is the registry's decision, default deny: the
owner; an orchestrator to an orchestrator of its own team or entity; an assistant
seat to its entity's coordinator; any seat to its own team's orchestrator; or an
owner-signed grant naming send. The drop file's first line
names the sender and the rule that admitted it. --list sends nothing: it prints
the file's seats and the seats of the other teams of the same entity, each
with the project its team sits in — another team's seat reads <seat>@<team> —
and needs no caller check. --dry-run resolves the seat and the
legs the run would walk, writes no drop file, and types nothing. It appends one
line to the team log.

A send walks the receiving seat's delivery order — native, mcp-inbox, typed by
default. A level of that seat's own chain, entity, project, team, seat, may drop
legs from the order or put the legs it keeps in a different order, and may never
add one: a word naming a leg the order does not have, or naming one twice, is set
aside and the order in force stands. Each leg in turn either takes the send, which
ends the walk, or definitely cannot take it, which hands the send to the next leg
and is recorded as a failure; mcp-inbox is not in this build, so a walk that
reaches it skips it and records it unavailable; the typed leg is terminal, taking
the send or ending the walk unreachable. The history line names the channel the
send went by and the legs that failed before it.

The outcome is one of seven, and none of them is silent:
  delivered    the drop path (exit 0): herdr reported the seat working — or done or
               blocked, changed from the status read before Enter — or the transcript
               showed the drop read, the line had left the input box, and the pane
               was not one of the dialogs listed above
  answered     --wait to a Claude Code seat: the reply came back; the reply follows
               on stdout (exit 0)
  held         the message is safe — on disk, or in the frame a Claude Code seat's
               held-message dialog keeps, printed held (socket) — and the pane was
               left untouched because the seat remained busy, locked, in a dialog,
               or holding an unsent draft (exit 1)
  not-submitted the line was typed and the seat never took it (exit 1): Enter was
               pressed up to three times, and only to a box still holding exactly the
               trigger; the message names what the box holds, faint suggestions not
               counted, and the drop path. A compose seat's brief that was typed and
               never confirmed is also not-submitted: its message names the screen
               that never came and the one line that repairs it
  timeout      --wait to a Claude Code seat: the frame was sent on the socket, and no
               reply came within the window (exit 1). A seat which does not accept
               messages from other sessions holds the frame until a person lets it
               through
  unreachable  the channel did not confirm (exit 1): the session is not running, no
               live agent carries the seat's name, the pane is one of those dialogs,
               no socket took a waited frame, or the pane would not take the trigger.
               A compose seat refuses here, naming the repair, when the module
               stopped before typing anything
  refused      nothing was sent (exit 1): not a declared seat, --wait (the frame
               needs the native leg — the team route and the caller's own
               SendMessage — which this build does not carry), a --wait whose
               delivery order does not lead with the native leg, a socket frame over
               the measured limit, a trigger that would exceed the measured line
               length, a reply listener that could not be opened, or a caller that
               may not send

--wait needs the frame the reply listener reads, and that frame is a socket write
this build does not make: a --wait to a Claude Code seat is refused, naming the
native leg (the team route and the caller's own SendMessage) that carries a waited
send once it ships; --wait to any other seat is refused too, and so is a --wait
whose delivery order does not lead with the native leg — the frame the reply
listener needs is that leg. Nothing is written in any of these.

--json prints one document instead of the lines: the action surface and the
outcome in one — {format, dry_run, status, action_summary, project, session, seat,
channel, ids, reply?, plan?} — and --list prints its own: {format, project,
session, seats, summary}. A run that exits 1 or 2 writes the structured error
document instead — {error: {id, message, repair}} — and stderr stays empty.
--file reads the body from a file instead of the one <message> argument.

--record writes no drop file, sends no frame and touches no pane: the sender
delivered with its own tool (a Claude Code seat's cross-session message), and this
writes down that delivery — one history line, outcome delivered, via native, with
the span the sender measured in --ms (a whole number of milliseconds). --channel
takes native, the one channel this half exists for, and is required beside --record;
--wait and --timeout are refused there, because nothing is delivered here. The
recipient's record and admission are judged exactly as a plain send's — a recorded
delivery is never a way around the rules — and the body is optional: given, it is
recorded verbatim, and without it the line says the text did not pass through this
CLI. \`team route <seat>\` answers the address such a delivery uses.

Not in this build: broadcast, a reply from a seat that is not Claude Code, and a
waited send — the native leg carries it.

Exits 0 when delivered, answered, listed, recorded, or resolved by --dry-run,
1 when held, not-submitted, timed out, unreachable, stopped, or refused, 2 when
the invocation or team file can't be read.
`;

export type SendHost = {
  /** The live agents of a session; null when herdr can't be reached. `cli` is the agent herdr
   *  reads on the pane (`claude`, `codex`, …), the process name a CLI profile names — null or
   *  absent when herdr reported none. */
  agents(session: string): { name: string; pane: string; cli?: string | null }[] | null;
  /** A pane's process pids, or null when the pane can't be read. */
  processInfo(session: string, pane: string): PaneProcesses | null;
  /** The folder the session sockets live in; the real one is the runtime temp folder's. */
  socketsDir: string;
  /** Where else a session's own sockets have been found: this Mac's Claude Code wrote them
   *  at /tmp/cc-socks while `tmpdir()` answered the per-user runtime folder, so discovery
   *  tries this one after socketsDir. The real host only; tests fake one folder. */
  socketsDirAlt?: string;
  deliver(socketPath: string, frame: string): Promise<SendOutcome>;
  /** Types a native seat's trigger and reads herdr's status. Tests pass a fake. */
  native: NativePane;
  now(): Date;
  home: string;
  /** The project registry, for the project each seat's team sits in. The real one when absent;
   *  a test stands in for it. */
  projects?: ProjectSources;
  /** Optional override for the per-project send daemon socket path. */
  daemonSocket?: string;
  /** The receiving seat's own chain for the delivery order — entity, project, team, seat. Left
   *  out (the real host does), the chain is read from the files: the receiving team file's own
   *  key and the seat's, and the registry project's (`src/send/delivery.ts`). A test hands in a
   *  chain to decide the order without a file to write. */
  delivery?: Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>;
};

export const realHost: SendHost = {
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane, cli: agent.agent })) ?? null,
  processInfo: (session, pane) => paneProcesses(pane, session),
  // The probe's path shape: `<tmp>/cc-socks/<pid>.sock`, the runtime temp folder's own
  // (observed on this Mac as /tmp/cc-socks; a version-specific observation, not a public
  // API contract).
  socketsDir: join(tmpdir(), 'cc-socks'),
  socketsDirAlt: '/tmp/cc-socks',
  deliver: (socketPath, frame) => sendFrame(socketPath, frame),
  native: {
    typeText: (session, pane, text) => typeText(pane, text, session),
    pressEnter: (session, pane) => pressEnter(pane, session),
    status: (session, pane) => agentStatus(pane, session),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    paneText: (session, pane) => paneRead(pane, 40, session),
    sendKey: (session, pane, key) => sendKey(pane, key, session),
    foregroundCwd: (session, pane) => paneForegroundCwd(pane, session),
  },
  now: () => new Date(),
  home: homedir(),
  projects: realProjectSources,
};

const send: Command = (argv, io) => runSend(argv, io, realHost);
export default send;

/** The wait's default window, in seconds. */
export const DEFAULT_WAIT_S = 120;

/** The longest a wait may run, in seconds — a day. */
export const MAX_WAIT_S = 86_400;

/** What the run reports besides its streams: the caller chose the document, the seat it
 *  names, the id of the frame it composed (null until one is built), and the team and session
 *  the send addresses, read from the receiving team file once it names one. */
type Report = {
  json: boolean;
  seat: string | null;
  sent: string | null;
  project: string | null;
  session: string | null;
};

/** The address as the caller wrote it, kept on the history line beside the resolved seat: the
 *  spec and the registry id it resolved to (`agt_…`). Absent when the spec was the seat's own
 *  name, which `to` already carries. */
type SentAs = { spec: string; resolved: string };

/** Where one send goes: the registry's answer for the spec, or the declared seat of the
 *  caller's own file. */
type Aim = {
  seat: string;
  session: string;
  cli: string;
  /** The cross-session address the registry recorded for the target; null when none. */
  address: string | null;
  /** The address as written, when it was a form rather than the seat's name; null otherwise. */
  sentAs: SentAs | null;
  /** The team file's folder this send belongs to: the receiving team's, across teams. */
  dir: string;
  project: string;
  root: string;
  /** True when the target's team is not the caller's. */
  cross: boolean;
};

type TeamLoad = ReturnType<typeof loadTeamFile>;
type LoadedTeam = Extract<TeamLoad, { ok: true }>;

/** Both halves of `team send` share these before a message exists: the team file, the caller's
 *  placement, the registry's answer and the refusals a spec gets, and — for a full address
 *  written from outside any team's folder — the receiving team's own file, read in the file's
 *  place. */
type Prologue = {
  team: TeamFile;
  root: string;
  dir: string;
  fileTeamId: string;
  loaded: LoadedTeam;
  caller: Caller;
  who: string;
  from: string;
  standing: SeatStanding;
  hit: Target | null;
};

/** A run the prologue ended before a message existed: the question is which refusal, not the
 *  sentence — the call site writes it with the same helper the rest of `send` uses, so the run
 *  reads exactly as it did when the prologue wrote it itself. */
type Ended =
  | { ended: 'configuration'; message: string }
  | { ended: 'refused'; dir: string | null; who: string; reason: string };

/** A folder that is no team at all: not inside a repository, or inside one that holds no team
 *  file. A link has its own refusal, and a file that exists but does not load still reads. */
function noTeamFolder(errors: ReadonlyArray<{ message: string }>): boolean {
  return errors.length > 0
    && errors.every((problem) => problem.message === NOT_A_REPO || problem.message.startsWith('no team file here'));
}

/** The one sentence a bare name from outside a team's folder gets: it has no team to resolve in,
 *  and the forms that need none. Never a `team init` suggestion. */
function needsTeam(spec: string): string {
  return `${spec} needs a team: run it inside a team's folder, or write ${spec}@<team> (team send --list shows the addresses)`;
}

/**
 * The steps both halves of `team send` walk before a message exists. Inside a team's folder the
 * caller's own file is the reading. Outside one, a full address — an agent id, a `@<nickname>`,
 * or a `<seat|nickname>@<team>` — is still the registry's to answer, the records name their
 * teams' roots, and the receiving team's file is loaded and read in its place; a bare name has
 * no team to resolve in and is refused with `needsTeam`'s sentence.
 */
function prologue(io: Io, host: SendHost, seatName: string): Prologue | Ended {
  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    if (noTeamFolder(loaded.errors)) {
      const parsed = parseSpec(seatName);
      if ('error' in parsed) return { ended: 'configuration', message: parsed.error };
      if (parsed.kind === 'seat') return { ended: 'configuration', message: needsTeam(seatName) };
      return homeless(io, host, seatName);
    }
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return { ended: 'configuration', message: message || 'the team file cannot be read' };
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  // The id the registry writes for this team: the live file's own identity, the team a sender
  // the store holds no record for is judged in.
  const fileTeamId = teamIdOf(root);
  // The address is resolved first: the registry answers an agent id, a `seat@team` (team spelled
  // by id, project or session), a `@nickname`, or a plain seat it holds an agent for, and the
  // live herdr read is the fallback for a record that carries no pane. A spec that names nobody
  // is refused by its own answer; a plain seat the registry cannot answer keeps the
  // declared-seat path below. The live read the resolution may fall back to is the host's, one
  // reader for the session's agents, so a fake host answers it in tests.
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logTag(caller);
  const from = caller.kind === 'seat' ? caller.name : 'owner';
  const resolved = resolveTarget(host.home, seatName, io, (session) => host.agents(session));
  // An ambiguous spec is refused wherever it is written, not only when it looks like a registry
  // spec: the declared-seat path below must never pick one of the two seats the registry named.
  if ('error' in resolved && (resolved.kind === 'ambiguous' || isRegistrySpec(seatName))) {
    return { ended: 'refused', dir, who, reason: resolved.error };
  }
  const hit = 'error' in resolved ? null : resolved;
  const standing = standingOf(dir, judged.session, caller);
  return { team, root, dir, fileTeamId, loaded, caller, who, from, standing, hit };
}

/**
 * A full address from a folder that is no team: the registry names the receiving team's root, so
 * its own file is loaded and the caller — the owner, the only caller this path admits, since
 * every other caller is judged by its team's file and there is none here — stands in it for the
 * read. Every refusal this path writes has no team log to write to: it is reported, not logged.
 */
function homeless(io: Io, host: SendHost, seatName: string): Prologue | Ended {
  const caller = callerOf(io);
  if (caller.kind !== 'owner') {
    return { ended: 'refused', dir: null, who: describeCaller(caller), reason: 'a send from outside a team\'s folder is the owner\'s; run it inside a team\'s folder' };
  }
  const resolved = resolveTarget(host.home, seatName, io, (session) => host.agents(session));
  if ('error' in resolved) return { ended: 'refused', dir: null, who: 'owner', reason: resolved.error };
  const loaded = loadTeamFile(resolved.team.root, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    const why = `${seatName}: the team "${resolved.team.project}" has a registry record, but its team file cannot be read (${resolved.team.root})`;
    return { ended: 'configuration', message: message === '' ? why : `${why}: ${message}` };
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const fileTeamId = teamIdOf(root);
  const judged = judgeCallerIn(io, dir, team);
  return {
    team,
    root,
    dir,
    fileTeamId,
    loaded,
    caller: judged.caller,
    who: logTag(judged.caller),
    from: 'owner',
    standing: standingOf(dir, judged.session, judged.caller),
    hit: resolved,
  };
}

export async function runSend(argv: string[], io: Io, host: SendHost): Promise<number> {
  const args = readArgs(argv, ['file', 'timeout', 'record', 'channel', 'ms'], ['wait', 'json', 'list', 'dry-run']);
  const seatName = args.rest[0];
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  const report: Report = { json, seat: seatName ?? null, sent: null, project: null, session: null };
  if (args.error) return usage(io, args.error, report);
  const detached = detachedRefusal(callerOf(io), { who: 'the owner or a seat the send admission admits', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) {
    if (report.json) writeJsonError(io, 'send.detached', detached, 'run team send from a terminal outside herdr');
    else io.stderr(`team send: ${detached}\n`);
    // exit: send.detached
    return 1;
  }
  if (args.flags.has('list')) return listSeats(io, host, report);
  // The native half of the channel: nothing is delivered here, so the seat is named by
  // `--record` and the rest of the line is the record's own options, judged on their own.
  if (args.values.record !== undefined) return recordRun(args, io, host, json);
  // Send to outcome is measured from here, past the refusals that read nothing (a refused run
  // reads no clock): this command's own handling, the same span the daemon measures from its
  // handler. The host's clock, not the wall clock: a fixed clock in a test or the docs runner
  // then reads a fixed millisecond count.
  const startedAt = host.now().getTime();

  const words = args.rest.slice(1);
  const file = args.values.file;
  if (!seatName) {
    return usage(io, 'a seat and a message are required', report);
  }
  if (file !== undefined && words.length > 0) {
    return usage(io, 'a message and --file cannot both be given', report);
  }
  if (file === undefined && words.length === 0) {
    return usage(io, 'a message or --file is required', report);
  }
  const wait = args.flags.has('wait');
  let timeoutS = DEFAULT_WAIT_S;
  if (args.values.timeout !== undefined) {
    if (!wait) return usage(io, '--timeout is only meaningful with --wait', report);
    const raw = args.values.timeout;
    const seconds = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (seconds < 1 || seconds > MAX_WAIT_S) {
      return usage(io, `--timeout takes a whole number of seconds, 1 to ${String(MAX_WAIT_S)} (got "${raw}")`, report);
    }
    timeoutS = seconds;
  }

  const pro = prologue(io, host, seatName);
  if ('ended' in pro) {
    if (pro.ended === 'configuration') return configuration(io, pro.message, report);
    return refuse(io, pro.dir, pro.who, pro.reason, host, report);
  }
  const { team, root, dir, fileTeamId, loaded, caller, who, from, standing, hit } = pro;

  // The authority rule, `admitSend` over the registry's records, default deny, judging the
  // resolved target when there is one. A sender the store holds no record for is judged as the
  // seat the live file declares for it: this team's rules alone reach it — a target in another
  // team, and the grant store, both wait for the record `team up` writes. That declared judgement
  // asks placement first, whatever the spec resolved to — the owner, or a seat on the pane the
  // state records for it, in the session judged, the same verdict `answer` asks, with the two
  // repairable refusals it can name — so the seat is judged only where the state records it
  // standing. A sender the store does hold a record for is bound to that record only where the
  // call stands as it — the record's own seat, running, on the pane it records, in its session,
  // and on the pane the state records for that seat (`admissionOf`'s identity check) — never by
  // session and seat name alone. All of it runs before the message is read and before any seat
  // is probed.
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standing);
    if (placement) return refuse(io, dir, who, placement, host, report);
    // A bare nickname the registry cannot answer is still a declared seat's nickname: the local
    // file maps it, and the rules judge the seat it names, never the human name the caller wrote.
    const configured =
      team.seats.find((seat) => seat.name === seatName) ??
      team.seats.find((seat) => seat.nickname !== undefined && seat.nickname === seatName);
    const seat = configured === undefined ? seatName : configured.name;
    admission = admissionOf(caller, team, null, seat, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    if (!configured) {
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat, session: team.session, cli: configured.cli, address: null, sentAs: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    // A resolved spec is addressed by its record: its session and its CLI, under the receiving
    // team's own folder; across teams this run's daemon is skipped, so the send is reached
    // directly. The pane is the live read's, by the seat's name (`findAgent`), never the
    // record's alone.
    const cross = hit.team.root !== root;
    to = {
      seat: hit.agent.reach.seat,
      session: hit.agent.reach.session,
      cli: hit.agent.cli,
      address: hit.agent.reach.address,
      // The form the caller wrote, kept beside the seat it resolved to: a `@<nickname>`, a seat
      // or nickname at a team, `lead@<team>`, or an agent id. A plain seat names itself and adds nothing.
      sentAs: seatName === hit.agent.reach.seat ? null : { spec: seatName, resolved: hit.agent.id },
      dir: cross ? join(hit.team.root, '.agents') : dir,
      project: hit.team.project,
      root: hit.team.root,
      cross,
    };
  }
  report.seat = to.seat;
  // The team and session the send addresses, for the context line and the document: the
  // receiving team's own, read from the file that names it.
  report.project = to.project;
  report.session = to.session;
  // What every history line this run writes keeps of the address: the form as written and the
  // registry id it resolved to, when the caller wrote a form rather than the seat's own name.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  // A seat the receiving team file marks `stopped: true` is not addressed at all: no leg is
  // walked, nothing is typed and nothing is written down. The dry run reports the real run's
  // refusal, and the check stands above every other delivery refusal, since none of them can
  // make a stopped seat take a message.
  const receiving = to.cross ? loadTeamFile(to.root, { home: host.home }) : loaded;
  const declared = receiving.ok ? receiving.team.seats.find((seat) => seat.name === to.seat) : undefined;
  if (declared?.stopped === true) return stoppedSeat(io, dir, who, to.seat, host, report);
  let body: string;
  if (file !== undefined) {
    try {
      body = readFileSync(resolve(io.cwd, file), 'utf8');
    } catch {
      return configuration(io, `the message file cannot be read: ${file}`, report);
    }
  } else {
    body = words.join(' ');
  }
  if (body.trim() === '') return usage(io, 'the message is empty', report);
  // The receiver sees the sender before the message: the drop file, the frame and the daemon's
  // own write all carry the same first lines.
  body = `${senderHeader(admission.sender, admission.rule)}\n${body}`;
  // A seat whose profile carries its rules in every brief has no standing session to keep
  // them: `rules: prepend` puts the same text a launch would deliver in front of each brief,
  // on every leg — the drop file, the socket frame and a compose seat's typed box all carry
  // this one body. `rulesOf` is the launch's own builder, so the file's rules, the seat's
  // signature lines and the workspace lines are the ones its launch would have sent.
  if (declared !== undefined && receiving.ok && profileFor(declared.cli)?.rulesMode === 'prepend') {
    body = `${rulesOf(receiving.team, declared, to.root)}\n\n${body}`;
  }

  const dry = args.flags.has('dry-run');
  // The receiving seat's own chain — entity, project, team, seat — decides the order the send
  // walks; nothing declared leaves native, mcp-inbox, typed. The words are the receiving team
  // file's (its own key and the seat's) and the registry project's, read here; a host that hands
  // in a chain decides instead, which is how a test picks an order without a file to write.
  const order = deliveryOrder(host.delivery ?? deliveryChainOf({
    root: to.root,
    seat: to.seat,
    home: host.home,
    // Across teams the file loaded above is the caller's own: the receiving team's is loaded
    // from its root, and one that cannot be read declares nothing.
    ...(to.cross ? {} : { file: team }),
    projectOfTeam: (id) => (host.projects ? host.projects.ofTeam(id) : projectRegistry.ofTeam(host.home, id)),
  }));
  // --wait needs the socket frame, and only a Claude Code seat has that listener. Any other
  // seat is refused before a write, a dry run included: the refusal is unconditional and stands
  // whether or not anything would be written, so the dry run reports the real run's refusal and
  // its exit rather than a channel the run could never walk. A Claude Code --wait run is refused
  // as well when the order does not lead with the native leg — the frame the reply listener
  // stands beside is that leg — and while SOCKET_SEND is off (deliverSocket names that refusal);
  // those print a `dry-run:` line in a dry run, since nothing is written either way.
  if (wait && to.cli !== 'claude-code') {
    return refuse(io, dir, who, `${to.seat} runs ${to.cli}: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent`, host, report);
  }
  if (wait && to.cli === 'claude-code') {
    // The frame is the native leg, and --wait rides it: an order that leads elsewhere, or holds
    // no native leg at all, has no frame for the reply listener to stand beside.
    if (order[0] !== 'native') {
      const leads = order.length === 0 ? 'empty' : order.join(', ');
      const why = `--wait needs the native leg first, and its delivery order is ${leads}; nothing was sent`;
      if (dry) return dryRun(io, to.seat, `${to.cli} ${why}`, report);
      return refuse(io, dir, who, `${to.seat}: ${why}`, host, report);
    }
    return deliverSocket(io, dir, who, from, to, body, dry, timeoutS, host, report, startedAt);
  }

  // A plain send, every seat: the body is written whole to a 0600 drop file, and the pane
  // gets one trigger line. A compose seat (a CLI that builds its work item from its own
  // screens) gets the drop file too, but the body is typed through those screens instead of
  // a trigger line.
  const msgId = randomUUID();
  const dropDir = join(to.dir, 'send-drops', to.session, to.seat);
  const dropPath = join(dropDir, msgId);
  if (dry) {
    return dryRun(io, to.seat, `${to.cli} via ${walkPhrase(order, to.cli)}; nothing was written`, report);
  }

  // The delivery walk, in the order the receiving seat's chain resolves to. A leg that takes
  // the send ends the walk; a leg that definitely cannot take it hands the send to the next
  // one and its reason joins `failures`, which every history line this walk writes carries;
  // the typed leg is terminal, taking the send or ending the walk unreachable. mcp-inbox is
  // not in this build: the walk skips it and records it unavailable. So is the native leg
  // while SOCKET_SEND is off — the frame path is a socket write this build does not make —
  // and a walk that reaches it records the skip exactly as mcp-inbox's.
  const failures: string[] = [];
  let socketNote: string | null = null;
  for (const [at, leg] of order.entries()) {
    if (leg === 'mcp-inbox') {
      failures.push(`mcp-inbox: ${MCP_INBOX_UNAVAILABLE}`);
      continue;
    }
    if (leg === 'native') {
      // A seat whose CLI has no cross-session socket has no native leg to walk: the leg is
      // skipped without a failure, since no send of this seat's could ever leave by it.
      if (to.cli !== 'claude-code') continue;
      if (!SOCKET_SEND) {
        failures.push(`native: ${NATIVE_LEG_UNAVAILABLE}`);
        continue;
      }
      const attempt = await deliverSocketFrame(dir, who, from, to, body, msgId, failures, host, report, startedAt);
      if (attempt.kind === 'delivered') return delivered(io, to.seat, report, 'socket');
      if (attempt.kind === 'held') return held(io, dir, who, to.seat, attempt.reason, host, report, 'socket');
      failures.push(`native: ${attempt.reason}`);
      socketNote = `typed, socket ${attempt.reason}`;
      // The fallback's own line, only where the typed leg is still ahead to take the send.
      if (order.slice(at + 1).includes('typed')) {
        logLine(dir, 'send', who, `${to.seat}: the socket was not taken (${attempt.reason}); falling back to the typed trigger`, host.now());
      }
      continue;
    }
    // The typed leg. The trigger is built here, so an order that reaches this leg is refused a
    // trigger past the measured line before anything is written. A compose seat's typed leg is
    // its CLI's own screens instead: there is no drop-file trigger to build, and the walk is
    // run in this process (below), not handed to the daemon.
    const compose = profileFor(to.cli)?.compose ?? null;
    const trigger = triggerLine(dropPath);
    if (trigger === null && compose === null) {
      return refuse(io, dir, who, `${to.seat}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was sent`, host, report);
    }
    // The daemon serves seats of the caller's own team; a seat in another team's record is
    // reached directly, under that team's folder. A compose seat is reached directly too: the
    // screen walk and the seat lock belong to one process.
    const daemonSock = host.daemonSocket ?? daemonSocketPath(to.project, to.root, host.home);
    const viaDaemon = to.cross || compose !== null
      ? null
      : await requestDaemon(daemonSock, { v: 1, op: 'send', id: msgId, from, to: to.seat, ...sentAs, body, ...(failures.length > 0 ? { failed: [...failures] } : {}) });
    if (viaDaemon && !('pong' in viaDaemon) && !('shutdown' in viaDaemon)) {
      return finishDaemonSend(io, dir, who, to.seat, timeoutS, host, report, viaDaemon, socketNote ?? undefined);
    }
    // The pane is read live, by the seat's name: a record's recorded pane may have been closed or
    // reused since it was written, and a trigger typed into a pane another seat now holds would
    // reach that seat. A name the session does not list is unreachable, never typed into.
    const found: Found = findAgent(host, to.session, to.seat);
    if (!found.ok) {
      if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
      const entry = { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) };
      appendHistory(to.project, to.root, host.home, entry);
      return unreachable(io, dir, who, to.seat, found.reason, host, report);
    }
    if (isBareShellPane(to.dir, to.session, to.seat, host.processInfo(to.session, found.pane))) {
      const entry = { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) };
      appendHistory(to.project, to.root, host.home, entry);
      return unreachable(io, dir, who, to.seat, 'the seat is back at its shell; nothing was typed', host, report);
    }
    report.sent = msgId;
    if (compose !== null) {
      // The seat's own folder: the record's `cwd` under the receiving team's root, else the
      // folder this send already writes to.
      const seatCwd = declared === undefined ? to.dir : resolve(to.root, declared.cwd);
      return deliverComposeSeat(io, to.dir, to.root, who, from, to.project, to.session, to.seat, to.cli, found.pane, dropDir, msgId, body, seatCwd, host, report, startedAt, failures, to.sentAs);
    }
    if (trigger === null) {
      return refuse(io, dir, who, `${to.seat}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was sent`, host, report);
    }
    return deliverNative(io, to.dir, to.root, who, from, to.project, to.session, to.seat, to.cli, found.pane, dropDir, msgId, body, trigger, host, report, startedAt, socketNote ?? undefined, failures, to.sentAs);
  }

  // No leg took the send: the walk ran out of legs with nothing written — the drop file is
  // only written by the typed leg — and every leg that fell is named.
  const why = `no leg of its delivery order took the send${failures.length === 0 ? '' : ` (${failures.join('; ')})`}`;
  appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) });
  return unreachable(io, dir, who, to.seat, why, host, report);
}

/** The channel a dry run names: the legs of the order this build can actually walk, in words.
 *  A leg this build does not carry — mcp-inbox always, native while SOCKET_SEND
 *  (src/send/uds.ts) is off — is not a channel a run would take, and a seat whose CLI has no
 *  cross-session socket has no native leg at all; none of them is named. What is left is the
 *  native channel when it leads, with the typed channel behind it, or the typed channel alone.
 *  The where-nothing-is-carried phrase is unreachable by the default order of a codex seat —
 *  mcp-inbox out, native out, typed left — and only an order that drops the typed leg too
 *  prints it. */
function walkPhrase(order: readonly DeliveryLeg[], cli: string): string {
  const walkable = order.filter((leg) => (leg === 'native' ? cli === 'claude-code' && SOCKET_SEND : leg === 'typed'));
  if (walkable.length === 0) return 'no leg of its delivery order this build can walk';
  // A compose seat's brief is not a drop-file trigger: it is typed through the CLI's screens.
  if (profileFor(cli)?.compose != null) return 'a typed brief through its own screens';
  if (walkable[0] !== 'native') return 'a 0600 drop file and one trigger line';
  return walkable.includes('typed')
    ? 'its cross-session socket, falling back to a 0600 drop file and one trigger line'
    : 'its cross-session socket';
}

/**
 * `team send --record <seat> --channel native --ms <N>`: the sender delivered with its own tool
 * — a Claude Code seat's cross-session message — and this writes the one history line every
 * other outcome gets, with the span the sender measured. Nothing is delivered here: no drop
 * file, no frame, no pane, and no socket is ever opened. The seat is named by the option, so
 * the positionals are the body, not the seat.
 *
 * Everything the record claims is judged first, and judged exactly as a plain send's target is:
 * the caller and its placement, the recipient's registry record, admission over the same
 * records with the grant store last (the prologue below is `runSend`'s own, step for step). A
 * native delivery must not become a way around the rules — only around the transport.
 */
function recordRun(args: Args, io: Io, host: SendHost, json: boolean): number {
  const seatName = args.values.record as string;
  const report: Report = { json, seat: seatName, sent: null, project: null, session: null };
  const channel = args.values.channel;
  const msRaw = args.values.ms;
  const file = args.values.file;
  if (args.flags.has('wait') || args.values.timeout !== undefined) {
    return usage(io, '--wait and --timeout are not meaningful with --record: nothing is delivered here', report);
  }
  if (channel === undefined) return usage(io, `--record needs --channel ${NATIVE_CHANNEL}`, report);
  if (channel !== NATIVE_CHANNEL) {
    return usage(io, `--channel takes ${NATIVE_CHANNEL} (got "${channel}"): the other channels send themselves`, report);
  }
  if (msRaw === undefined) {
    return usage(io, '--record needs --ms <N>: the span the sender measured, in whole milliseconds', report);
  }
  const ms = /^\d+$/.test(msRaw) ? Number(msRaw) : -1;
  if (ms < 0 || !Number.isSafeInteger(ms)) {
    return usage(io, `--ms takes a whole number of milliseconds (got "${msRaw}")`, report);
  }
  if (file !== undefined && args.rest.length > 0) {
    return usage(io, 'a message and --file cannot both be given', report);
  }
  let body: string;
  if (file !== undefined) {
    try {
      body = readFileSync(resolve(io.cwd, file), 'utf8');
    } catch {
      return configuration(io, `the message file cannot be read: ${file}`, report);
    }
  } else if (args.rest.length > 0) {
    body = args.rest.join(' ');
  } else {
    // The sender's text travelled in its own tool's call; the record says so rather than
    // inventing one.
    body = NATIVE_BODY_MARKER;
  }
  if (body.trim() === '') return usage(io, 'the message is empty', report);

  const pro = prologue(io, host, seatName);
  if ('ended' in pro) {
    if (pro.ended === 'configuration') return configuration(io, pro.message, report);
    return refuse(io, pro.dir, pro.who, pro.reason, host, report);
  }
  const { team, root, dir, fileTeamId, loaded, caller, who, from, standing, hit } = pro;
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standing);
    if (placement) return refuse(io, dir, who, placement, host, report);
    // A bare nickname the registry cannot answer is still a declared seat's nickname: the local
    // file maps it, and the rules judge the seat it names, never the human name the caller wrote.
    const configured =
      team.seats.find((seat) => seat.name === seatName) ??
      team.seats.find((seat) => seat.nickname !== undefined && seat.nickname === seatName);
    const seat = configured === undefined ? seatName : configured.name;
    admission = admissionOf(caller, team, null, seat, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    if (!configured) {
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat, session: team.session, cli: configured.cli, address: null, sentAs: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    // A resolved spec is addressed by its record: its session and its CLI, under the receiving
    // team's own folder. Nothing is delivered here, so no pane is read.
    const cross = hit.team.root !== root;
    to = {
      seat: hit.agent.reach.seat,
      session: hit.agent.reach.session,
      cli: hit.agent.cli,
      address: hit.agent.reach.address,
      // The form the caller wrote, kept beside the seat it resolved to: a `@<nickname>`, a seat
      // or nickname at a team, `lead@<team>`, or an agent id. A plain seat names itself and adds nothing.
      sentAs: seatName === hit.agent.reach.seat ? null : { spec: seatName, resolved: hit.agent.id },
      dir: cross ? join(hit.team.root, '.agents') : dir,
      project: hit.team.project,
      root: hit.team.root,
      cross,
    };
  }
  report.seat = to.seat;
  report.project = to.project;
  report.session = to.session;
  // What every history line this run writes keeps of the address: the form as written and the
  // registry id it resolved to, when the caller wrote a form rather than the seat's own name.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  // A stopped seat takes no record either: the same file read and the same refusal as a real
  // send, before a dry run or a history line exists. `--record` reaches here before the
  // delivery path's own check.
  const receiving = to.cross ? loadTeamFile(to.root, { home: host.home }) : loaded;
  const declared = receiving.ok ? receiving.team.seats.find((seat) => seat.name === to.seat) : undefined;
  if (declared?.stopped === true) return stoppedSeat(io, dir, who, to.seat, host, report);
  const msgId = randomUUID();
  if (args.flags.has('dry-run')) return recordDryRun(io, to.seat, ms, report);
  const written = appendHistory(to.project, to.root, host.home, {
    ts: host.now().toISOString(),
    from,
    to: to.seat,
    ...sentAs,
    body,
    id: msgId,
    outcome: 'delivered',
    ms,
    via: NATIVE_CHANNEL,
  });
  if (!written.ok) return refuse(io, dir, who, `the delivery could not be recorded: ${written.reason}`, host, report);
  logLine(to.dir, 'send', who, `${to.seat}: recorded (native, ${String(ms)} ms)`, host.now());
  return recorded(io, to.seat, ms, msgId, report);
}

/** The native delivery is in the history: one line, `via: native`, the sender's own span. Exit
 *  0, always. */
function recorded(io: Io, seat: string, ms: number, id: string, report: Report): number {
  report.sent = id;
  const summary = `${seat}: recorded (native, ${String(ms)} ms)`;
  if (report.json) {
    writeAction(io, report, { status: 'recorded', summary, channel: 'native' });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.recorded
}

/** What --record would write, with nothing written and nothing read: the run's own wording.
 *  Exit 0, always. */
function recordDryRun(io: Io, seat: string, ms: number, report: Report): number {
  const summary = `${seat}: would record (native, ${String(ms)} ms); nothing was written`;
  const plan: PlanStep[] = [{ step: 'record', seat, detail: `native delivery, ${String(ms)} ms; nothing was written`, prefix: '+' }];
  if (report.json) {
    writeAction(io, report, { status: 'dry-run', summary, dryRun: true, channel: null, plan });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.record-dry-run
}

function finishDaemonSend(
  io: Io,
  dir: string,
  who: string,
  seatName: string,
  timeoutS: number,
  host: SendHost,
  report: Report,
  res: DaemonSendResponse,
  /** How the send reached the seat, for the outcome line (the fallback's own reason). */
  note?: string,
): number {
  report.sent = res.id;
  if (res.outcome === 'delivered') {
    const taken = res.evidence === 'taken' ? TAKEN_REASON : undefined;
    return delivered(io, seatName, report, taken === undefined ? note : note === undefined ? taken : `${taken}; ${note}`);
  }
  if (res.outcome === 'answered') return answered(io, seatName, { reply: res.reply, msg_id: res.reply_id }, report);
  if (res.outcome === 'timeout') return timedOut(io, seatName, timeoutS, report);
  if (res.outcome === 'held') return held(io, dir, who, seatName, res.detail, host, report);
  if (res.outcome === 'unreachable') return unreachable(io, dir, who, seatName, res.detail, host, report);
  if (res.outcome === 'not-submitted') {
    const result: DeliverResult = { outcome: 'not-submitted', tries: res.tries, ...(res.box === null ? {} : { box: res.box }) };
    // The daemon keeps no pending record in the folder a watch scans, so this line promises no
    // retry: it names the drop and stops there.
    return notSubmitted(io, dir, who, seatName, result, `the drop file is at ${res.drop_path}`, host, report);
  }
  return refuse(io, dir, who, res.detail, host, report);
}

/**
 * `--wait` to a Claude Code seat. The frame is what the reply listener needs, and while
 * SOCKET_SEND is off this build writes no frame: the run is refused, naming the leg that
 * would carry it, and nothing dials. With the constant on, a successful write says the frame
 * was sent on the socket: the write is not an acknowledgement that the seat read it.
 */
async function deliverSocket(
  io: Io,
  dir: string,
  who: string,
  from: string,
  to: Aim,
  body: string,
  dry: boolean,
  timeoutS: number,
  host: SendHost,
  report: Report,
  /** When this run started: the ms the outcome's history entry carries is measured from it. */
  startedAt: number,
): Promise<number> {
  // The address as written, when it was a form: every history line carries it beside the seat.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  // No socket, no waited frame: the frame the reply listener needs is one this build does not
  // write, so the run is refused rather than carried by a channel the reply cannot come back
  // on. The dry run prints the same sentence; nothing dials either way.
  if (!SOCKET_SEND) {
    const reason = '--wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent';
    if (dry) return dryRun(io, to.seat, `${to.cli} ${reason}`, report);
    return refuse(io, dir, who, `${to.seat}: ${reason}`, host, report);
  }
  // One JSON line, exactly the frame the probe measured: `type:"user"`, the content, and a
  // msg_id for a reader's own correlation. No `from`: this process has no session socket, so
  // any sender address it claimed would be a claim, not a fact — the listener shows the
  // connection's verified pid instead, and a `--wait` run listens at that pid's measured path
  // (reply.ts), so the address the seat answers to is answered. JSON.stringify escapes
  // newlines and control characters, so multi-line text stays one frame; the frame is never
  // truncated.
  const msgId = randomUUID();
  const frame = frameFor(body, msgId);
  report.sent = msgId;
  if (frame.length > FRAME_LIMIT) {
    return refuse(io, dir, who, `${to.seat}: the message is too large for this channel: the frame is ${String(frame.length)} characters and the socket's measured limit is ${String(FRAME_LIMIT)}; nothing was sent`, host, report);
  }
  if (dry) {
    return dryRun(io, to.seat, 'claude-code via the cross-session socket; nothing was sent', report);
  }

  const daemonSock = host.daemonSocket ?? daemonSocketPath(to.project, to.root, host.home);
  const viaDaemon = to.cross
    ? null
    : await requestDaemon(
        daemonSock,
        { v: 1, op: 'send', id: msgId, from, to: to.seat, ...sentAs, body, wait: true, timeout_s: timeoutS },
        (timeoutS + 30) * 1000,
      );
  if (viaDaemon && !('pong' in viaDaemon) && !('shutdown' in viaDaemon)) {
    return finishDaemonSend(io, dir, who, to.seat, timeoutS, host, report, viaDaemon);
  }

  // The pane is read live, by the seat's name: a recorded pane may have been reused by another
  // seat since the record was written.
  const found: Found = findAgent(host, to.session, to.seat);
  if (!found.ok) {
    if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt });
    return unreachable(io, dir, who, to.seat, found.reason, host, report);
  }
  const pane = found.pane;
  const processes = host.processInfo(to.session, pane);
  if (processes === null) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt });
    return unreachable(io, dir, who, to.seat, "the pane's processes could not be read", host, report);
  }
  // The registry's recorded address while it is still live, else today's discovery, the pane's
  // own processes — which also covers the alternative sockets folder.
  const socketPath = liveSocketOf(to.address, processes, host.socketsDir) ?? socketOf(host, processes);
  if (socketPath === null) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt });
    return unreachable(io, dir, who, to.seat, `no cross-session socket was found for its pane's processes (looked in ${socketDirs(host)})`, host, report);
  }

  // One send per seat at a time, the same lock `answer` and the launch that resumes a seat
  // take: two commands never reach one seat at once. A `--wait` send holds it until the reply
  // or the timeout — the outstanding request is the thing the lock serializes.
  const lock = acquireSeatLock(to.dir, to.session, to.seat);
  if (!('release' in lock)) {
    return refuse(io, dir, who, `${to.seat}: another command holds it (pid ${String(lock.held)}); nothing was sent`, host, report);
  }
  try {
    // The reply listener is opened before the frame is written: a seat that answers at once
    // must find it standing. A listener that cannot be opened is a refusal — nothing sent.
    // The listener stands next to the socket the frame goes to: the answering session looks for
    // the sender's pid at the sockets folder of the channel, and this is that one.
    const opened = await openReplyListener(dirname(socketPath), process.pid);
    if (!opened.ok) {
      return refuse(io, dir, who, `${to.seat}: ${opened.reason}`, host, report);
    }
    const listener = opened.listener;
    try {
      const taken = await host.deliver(socketPath, frame);
      if (!taken.ok) {
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'socket' });
        return unreachable(io, dir, who, to.seat, taken.reason, host, report);
      }
      // The log keeps the seat and the frame's size; never the message's text, and never
      // the word delivered: the socket accepted the write, which is all this run knows.
      logLine(to.dir, 'send', who, `${to.seat}: sent on the socket (${String(frame.length)} characters)`, host.now());
      // The frame can land at the receiving session's held-message dialog: the seat shows it
      // when it was busy, the box is blocked while it is up, and no typed line gets through it.
      // Read the pane for about a second after the write; the dialog, not the reply window, is
      // the outcome then.
      if (await heldAtDialog(to.session, pane, host)) {
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'socket' });
        return held(io, dir, who, to.seat, HELD_FRAME_REASON, host, report, 'socket');
      }
      const outcome = await listener.wait(timeoutS * 1000);
      if (outcome.kind === 'answered') {
        const read = readReply(outcome.line);
        logLine(to.dir, 'send', who, `${to.seat}: answered (reply ${String(read.reply.length)} characters)`, host.now());
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'answered', ms: host.now().getTime() - startedAt, via: 'socket' });
        return answered(io, to.seat, read, report);
      }
      logLine(to.dir, 'send', who, `${to.seat}: timeout (sent, no reply within ${String(timeoutS)}s)`, host.now());
      appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'timeout', ms: host.now().getTime() - startedAt, via: 'socket' });
      return timedOut(io, to.seat, timeoutS, report);
    } finally {
      listener.close();
    }
  } finally {
    lock.release();
  }
}

type Found = { ok: true; pane: string } | { ok: false; kind: 'unreachable' | 'refused'; reason: string };

/** The one live agent of this name, or why the send cannot use a pane. */
function findAgent(host: SendHost, session: string, seatName: string): Found {
  const agents = host.agents(session);
  if (agents === null) return { ok: false, kind: 'unreachable', reason: `the session "${session}" could not be read` };
  const named = agents.filter((agent) => agent.name === seatName);
  if (named.length === 0) return { ok: false, kind: 'unreachable', reason: 'no live agent carries that name in the session' };
  if (named.length > 1) return { ok: false, kind: 'refused', reason: `${seatName}: herdr lists more than one agent of this name; nothing was sent` };
  return { ok: true, pane: (named[0] as { pane: string }).pane };
}

/**
 * Writes the drop file under the seat lock, types the one trigger, and reports delivered only
 * when the seat is verified to have taken it: the trigger left the box and herdr reports the seat
 * working (`deliverTrigger`). A line that was typed but not taken is `not-submitted`, never a
 * success. A line that left the box with no status or transcript evidence inside the window is
 * delivered as `taken, not yet confirmed`: the seat took it, and the watch confirms it later — it
 * is never typed again, and no pending record is left beside the drop. The lock is held across the
 * typing so a second send cannot append into the same composer.
 */
async function deliverNative(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  project: string,
  session: string,
  seatName: string,
  cli: string,
  pane: string,
  dropDir: string,
  msgId: string,
  body: string,
  trigger: string,
  host: SendHost,
  report: Report,
  startedAt: number,
  /** How the send reached the seat, for the outcome line (the fallback's own reason). */
  note?: string,
  /** The reasons the legs before this one did not take the send: every history line carries them. */
  failures: readonly string[] = [],
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: SentAs | null = null,
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) {
    return refuse(io, dir, who, `${seatName}: another command holds it (pid ${String(lock.held)}); nothing was sent`, host, report);
  }
  try {
    let path: string;
    try {
      sealDropTree(dir, session, seatName);
      path = dropMessage(dropDir, msgId, body);
    } catch {
      return refuse(io, dir, who, `${seatName}: the drop file could not be written; nothing was typed`, host, report);
    }
    const result = await deliverTrigger(bindPane(host.native, session), pane, trigger, cli);
    const where = `the drop file is at ${path}`;
    // A held drop gets a record beside it, for the watch to deliver once the seat is free. The
    // line names that retry, so a sender does not have to guess whether the drop still travels.
    const retry = 'a running watch retries it when the seat is idle';
    const entry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId };
    if (result.outcome === 'held') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      markPending(dropDir, entry);
      return held(io, dir, who, seatName, `${result.reason ?? 'the composer holds text'}; ${where}; ${retry}`, host, report);
    }
    if (result.outcome === 'unreachable') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      // A dialog is not a missing channel: the drop is on disk and the seat will be free once the
      // prompt is answered, so the watch gets the same record a held send leaves.
      if (result.dialog !== undefined) {
        markPending(dropDir, entry);
        return unreachable(io, dir, who, seatName, `${retry}; ${where}`, host, report, result.dialog);
      }
      return unreachable(io, dir, who, seatName, `${result.reason ?? 'the seat was not reached'}; ${where}`, host, report);
    }
    if (result.outcome === 'not-submitted') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'not-submitted', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      markPending(dropDir, entry);
      return notSubmitted(io, dir, who, seatName, result, `${where}; ${retry}`, host, report);
    }
    const taken = result.evidence === 'taken';
    logLine(dir, 'send', who, `${seatName}: delivered (drop ${String(body.length)} characters, ${evidenceOf(result)})`, host.now());
    // A taken send is a delivery with its confirmation still to come: the history says so, and a
    // record beside the drop lets a running watch look for the later sign. It is never a retry
    // record — a taken line is never typed again.
    appendHistory(project, root, host.home, {
      ...entry,
      outcome: 'delivered',
      ...(taken ? { note: TAKEN_REASON } : {}),
      ms: host.now().getTime() - startedAt,
      via: 'typed',
      ...failed,
    });
    if (taken) {
      markTaken(dropDir, {
        id: msgId,
        from,
        to: seatName,
        body,
        ts: entry.ts,
        before: result.prior ?? 'unknown',
      });
    }
    return delivered(io, seatName, report, taken ? (note === undefined ? TAKEN_REASON : `${TAKEN_REASON}; ${note}`) : note);
  } finally {
    lock.release();
  }
}

/**
 * A compose seat's typed leg: the drop file is written, then the profile's module walks the
 * CLI's own screens and types the brief there. Delivered means the CLI printed its proof line
 * (a created session); a module refusal after it typed is `not-submitted` — the box may hold
 * the text — and one before it typed is `unreachable`. The drop file stays the message's copy
 * when the walk fails, and every ending names it.
 */
async function deliverComposeSeat(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  project: string,
  session: string,
  seatName: string,
  cli: string,
  pane: string,
  dropDir: string,
  msgId: string,
  body: string,
  seatCwd: string,
  host: SendHost,
  report: Report,
  startedAt: number,
  failures: readonly string[] = [],
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: SentAs | null = null,
): Promise<number> {
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const profile = profileFor(cli);
  const compose = profile?.compose ?? null;
  if (profile === null || compose === null) {
    return refuse(io, dir, who, `${seatName}: its profile carries no compose module; nothing was sent`, host, report);
  }
  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) {
    return refuse(io, dir, who, `${seatName}: another command holds it (pid ${String(lock.held)}); nothing was sent`, host, report);
  }
  try {
    let path: string;
    try {
      sealDropTree(dir, session, seatName);
      path = dropMessage(dropDir, msgId, body);
    } catch {
      return refuse(io, dir, who, `${seatName}: the drop file could not be written; nothing was typed`, host, report);
    }
    const result = await deliverCompose(host.native, {
      profile: compose,
      binary: profile.binary,
      session,
      pane,
      seatCwd,
      idleTimeout: profile.idleTimeout,
      message: body,
    });
    const where = `the drop file is at ${path}`;
    const entry = { ts: host.now().toISOString(), from, to: seatName, ...(sentAs === null ? {} : sentAs), body, id: msgId };
    if (result.outcome === 'unreachable') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      return unreachable(io, dir, who, seatName, `${result.reason}; ${where}`, host, report);
    }
    if (result.outcome === 'not-submitted') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'not-submitted', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      return typedBriefNotSubmitted(io, dir, who, seatName, `${result.reason}; ${where}`, host, report);
    }
    logLine(dir, 'send', who, `${seatName}: delivered (typed brief, ${result.evidence})`, host.now());
    appendHistory(project, root, host.home, { ...entry, outcome: 'delivered', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
    return delivered(io, seatName, report, 'typed brief');
  } finally {
    lock.release();
  }
}

/** The brief was typed into a compose seat's own box and the CLI never confirmed it. The
 *  message is on disk, and the one team.log line is the orchestrator's notice. Exit 1. */
function typedBriefNotSubmitted(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report): number {
  return notSubmittedAt(io, dir, who, seat, reason, host, report);
}

/** A send that typed its line and was never taken: the trigger line of a drop-file send, or a
 *  compose seat's brief. One site, one exit id: both are the same outcome to a caller. */
function notSubmittedAt(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report): number {
  const message = `${seat}: not-submitted: ${reason}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeJsonError(io, 'send.not-submitted', message);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.not-submitted
}

/** `send-drops`, the session directory, and the seat directory are each mode 0700.
 *  The leaf alone would leave the parents at the umask, so other users could list
 *  session ids and seat names. `.agents` itself is not changed. */
function sealDropTree(dir: string, session: string, seat: string): void {
  const root = join(dir, 'send-drops');
  const sessionDir = join(root, session);
  const leaf = join(sessionDir, seat);
  mkdirSync(leaf, { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(sessionDir, 0o700);
  chmodSync(leaf, 0o700);
}

/** The seat and channel. No drop file, nothing typed and no team.log line: a dry run writes
 *  nothing, and the log records writes. Exit 0, always. */
function dryRun(io: Io, seat: string, what: string, report: Report): number {
  report.sent = null;
  const summary = `${seat}: dry-run: ${what}`;
  const plan: PlanStep[] = [{ step: 'send', seat, detail: what, prefix: '+' }];
  if (report.json) {
    writeAction(io, report, { status: 'dry-run', summary, dryRun: true, channel: null, plan });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.dry-run
}

/** One `--list` row: the name to type, the seat's human name as an address (`@<nickname>` in its
 *  own team, `<nickname>@<team>` in another), its CLI, its role, the project its team sits in,
 *  and whether its seat is stopped. A seat of another team reads `<seat>@<team>` in the name; a
 *  nickname reads `@<nickname>` in its own team and `<nickname>@<team>` in another, so every human
 *  name the listing prints is an address too. */
type SeatRow = { name: string; nickname: string | null; cli: string; role: string; stopped: boolean; project: string; reach: 'socket' | 'typed' };

/** `--list`: the file's seats and its entity's other teams' seats, nothing sent and no caller
 *  check. Exit 0, always. */
function listSeats(io: Io, host: SendHost, report: Report): number {
  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  report.project = loaded.team.project;
  report.session = loaded.team.session;
  // Phase 0b: every row carries the project its team sits in — the registry project whose teams
  // name this team, else the team's own project name (a team the registry places in none is its
  // own project). An injected registry answers for itself; with none, the registry the host's home
  // holds is the reading, bound to that home rather than to wherever the process runs.
  const teamId = teamIdOf(loaded.root);
  const found = host.projects ? host.projects.ofTeam(teamId) : projectRegistry.ofTeam(host.home, teamId);
  const project = found?.name ?? loaded.team.project;
  // The reach a send would take, judged from the declared CLI alone: a Claude Code seat carries
  // the cross-session channel, every other CLI the typed trigger. `--list` reads no pane and
  // dials nothing, so it claims no live address; a stopped seat renders `stopped` in its place.
  const seats: SeatRow[] = loaded.team.seats.map((seat) => ({
    name: seat.name,
    // The `@<nickname>` form: every row the listing prints is a spec the resolver takes as it
    // stands, and a bare nickname would not be one outside the caller's team.
    nickname: seat.nickname === undefined ? null : `@${seat.nickname}`,
    cli: seat.cli,
    role: seat.role,
    project,
    reach: seat.cli === 'claude-code' ? 'socket' : 'typed',
    stopped: seat.stopped === true,
  }));
  // The caller's entity reaches past its own file: the machine's team registry holds every other
  // team of the same entity, and each of their seats is addressable as `<seat>@<team>` — the
  // team's own project name is the scope. A registry the home cannot read is reported as the
  // team file's own read is; a team whose record names another entity, or none, adds no row.
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(host.home);
  } catch (error) {
    return configuration(io, (error as Error).message, report);
  }
  const entity = teams[teamId]?.entity ?? loaded.team.entity ?? null;
  if (entity !== null) seats.push(...crossTeamRows(host, teams, teamId, entity));
  const summary = pluralCount(seats.length, 'seat');
  if (report.json) {
    writeJson(io, 'team.send.list', {
      format: 1 as const,
      project: loaded.team.project,
      session: loaded.team.session,
      seats,
      summary,
    });
  } else {
    io.stdout(`${contextLine(loaded.team.project, loaded.team.session)}\n`);
    const rows = seats.map((seat) => [seat.name, seat.nickname ?? '-', seat.role, seat.project, seat.stopped ? 'stopped' : seat.reach]);
    for (const line of renderTable({ headers: ['SEAT', 'NICKNAME', 'ROLE', 'PROJECT', 'REACH'], rows })) io.stdout(`${line}\n`);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.listed
}

/**
 * The seats of the other teams of one entity, as `--list` rows: each roster line's seat and role,
 * the CLI and lifecycle the agent record carries, and the project its team sits in. A roster line
 * whose agent record is gone or retired is skipped — no address reaches it. A team record that is
 * stopped or archived marks every seat it carries as stopped, as a stopped seat's own file does.
 * Teams are ordered by their own name, so the rows a person reads do not follow the registry's
 * key order.
 */
function crossTeamRows(host: SendHost, teams: Record<string, TeamRecord>, ownId: string, entity: string): SeatRow[] {
  const agents = new Map(readAgents(host.home).map((agent) => [agent.id, agent]));
  const rows: SeatRow[] = [];
  const others = Object.entries(teams)
    .filter(([id, record]) => id !== ownId && record.entity === entity)
    .sort(([, left], [, right]) => left.project.localeCompare(right.project));
  for (const [id, record] of others) {
    const found = host.projects ? host.projects.ofTeam(id) : projectRegistry.ofTeam(host.home, id);
    const project = found?.name ?? record.project;
    for (const entry of record.roster) {
      const agent = agents.get(entry.agent);
      if (!agent || agent.lifecycle === 'retired') continue;
      rows.push({
        name: `${entry.seat}@${record.project}`,
        nickname: entry.nickname === undefined ? null : `${entry.nickname}@${record.project}`,
        cli: agent.cli,
        role: entry.role,
        stopped: agent.lifecycle === 'stopped' || record.lifecycle === 'stopped' || record.lifecycle === 'archived',
        project,
        reach: agent.cli === 'claude-code' ? 'socket' : 'typed',
      });
    }
  }
  return rows;
}

/**
 * The first of the pane's processes with a socket in the sockets folders: the foreground
 * processes first (the running CLI is one of them), then the shell; each pid's folders in
 * order — `socketsDir`, then the alt folder when the real host has one. The probe's socket
 * is derived from one process — the session — so more than one match is not resolved here:
 * the first is used, in that order.
 */
function socketOf(host: SendHost, processes: PaneProcesses): string | null {
  const dirs = host.socketsDirAlt === undefined ? [host.socketsDir] : [host.socketsDir, host.socketsDirAlt];
  const pids = [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
  for (const pid of pids) {
    for (const dir of dirs) {
      const path = join(dir, `${String(pid)}.sock`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The folders discovery looked in, as one phrase for a refusal's text. */
function socketDirs(host: SendHost): string {
  return host.socketsDirAlt === undefined ? host.socketsDir : `${host.socketsDir}, ${host.socketsDirAlt}`;
}

/** The one frame this channel carries: `type:"user"`, the whole body, the id. `JSON.stringify`
 *  keeps multi-line text one line. */
function frameFor(body: string, msgId: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: body }, msg_id: msgId })}\n`;
}

type SocketAttempt = { kind: 'delivered' } | { kind: 'held'; reason: string } | { kind: 'fallback'; reason: string };

/** The one sentence a held socket frame reports: the pane, the frame's state, and why nothing
 *  further is typed. */
const HELD_FRAME_REASON =
  'the session holds the socket frame at its held-message dialog ("Held message from another session"): the box is blocked while it is up, and nothing further is typed';

/** What the walk records for the mcp-inbox leg: the leg is not in this build, so a walk that
 *  reaches it skips the leg, records it unavailable, and hands the send to the next leg. */
const MCP_INBOX_UNAVAILABLE = 'unavailable; this build carries no mcp-inbox leg';

/** What the walk records for the native leg while SOCKET_SEND (src/send/uds.ts) is off: the
 *  frame path is a socket write this build does not make, so the leg cannot take a send, and the
 *  walk skips and records it exactly as it records the mcp-inbox leg's skip. */
const NATIVE_LEG_UNAVAILABLE = 'unavailable; the frame path is a socket write this build does not make';

/** How long a socket write's pane is read for the held-message dialog, in all. */
const HELD_READ_MS = 1000;

/** Reads the target pane until the held-message dialog shows, or ~1s passes: the dialog renders
 *  right after the write lands, and a write the session holds is not a delivery. A host with no
 *  pane reader keeps the write's own answer — there is nothing to look at. */
async function heldAtDialog(session: string, pane: string, host: SendHost): Promise<boolean> {
  const reader = host.native.paneText;
  if (reader === undefined) return false;
  if (showsHeldFrameDialog(reader(session, pane))) return true;
  for (let waited = 0; waited < HELD_READ_MS; waited += POLL_MS) {
    await host.native.wait(POLL_MS);
    if (showsHeldFrameDialog(reader(session, pane))) return true;
  }
  return false;
}

/**
 * The default path's first leg: one frame on the target's cross-session socket, nothing typed.
 * The address is resolved first — the registry's recorded one while it is still live, else the pane's
 * own processes — and a write the socket takes is the send: this channel has no
 * acknowledgement, so a taken frame is all this run can know. Every other ending comes back as
 * a reason for the caller to fall back to the typed trigger: no pane, no socket, a socket gone
 * or refusing, a frame past the measured limit. A recorded address whose write refuses gets one
 * live re-resolution first: a pid the registry has not caught up with must not cost the fast
 * path, while the record itself remains the registry's to refresh.
 */
async function deliverSocketFrame(
  dir: string,
  who: string,
  from: string,
  to: Aim,
  body: string,
  msgId: string,
  /** The reasons the legs before this one did not take the send: the history line carries them. */
  failures: readonly string[],
  host: SendHost,
  report: Report,
  startedAt: number,
): Promise<SocketAttempt> {
  report.sent = msgId;
  // The address as written, when it was a form: every history line carries it beside the seat.
  const sentAs = to.sentAs === null ? {} : to.sentAs;
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const frame = frameFor(body, msgId);
  if (frame.length > FRAME_LIMIT) {
    return { kind: 'fallback', reason: `the frame is ${String(frame.length)} characters, past the socket's measured limit of ${String(FRAME_LIMIT)}` };
  }
  // The pane is read live, by the seat's name: a recorded pane may have been reused by another
  // seat since the record was written, and its socket is not this seat's.
  const found: Found = findAgent(host, to.session, to.seat);
  if (!found.ok) return { kind: 'fallback', reason: found.reason };
  // The seat lock stays the gate: a command that holds it — a send typing a trigger, an `up`,
  // an outstanding --wait — keeps this fast path out, and the typed path below answers the
  // refusal exactly as it always has. The lock file is read here, never taken: the fallback's
  // own delivery takes it for real.
  if (existsSync(seatLockPath(to.dir, to.session, to.seat))) {
    return { kind: 'fallback', reason: 'another command holds the seat' };
  }
  const first = socketPathFor(host, to, found.pane);
  if (first === null) {
    return { kind: 'fallback', reason: `no socket was found for its pane's processes (looked in ${socketDirs(host)})` };
  }
  let taken = await host.deliver(first.path, frame);
  if (!taken.ok && first.recorded) {
    const processes = host.processInfo(to.session, found.pane);
    const live = processes === null ? null : socketOf(host, processes);
    if (live !== null && live !== first.path) taken = await host.deliver(live, frame);
  }
  if (!taken.ok) return { kind: 'fallback', reason: taken.reason };
  logLine(to.dir, 'send', who, `${to.seat}: sent on the socket (${String(frame.length)} characters)`, host.now());
  if (await heldAtDialog(to.session, found.pane, host)) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'socket', ...failed });
    return { kind: 'held', reason: HELD_FRAME_REASON };
  }
  appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, ...sentAs, body, id: msgId, outcome: 'delivered', ms: host.now().getTime() - startedAt, via: 'socket', ...failed });
  return { kind: 'delivered' };
}

/** The address a send tries: the registry's recorded one while it is still live — its pid among
 *  the pane's, its socket present — else the pane's own processes (`socketOf`). `recorded` marks
 *  the difference — only the recorded address gets the live re-resolution after its write
 *  refuses. A pane that cannot be read leaves a recorded address as the only thing this run has;
 *  a write that refuses still falls back to the typed trigger. */
function socketPathFor(host: SendHost, to: Aim, pane: string): { path: string; recorded: boolean } | null {
  const processes = host.processInfo(to.session, pane);
  if (to.address !== null) {
    const live = liveSocketOf(to.address, processes, host.socketsDir);
    if (live !== null) return { path: live, recorded: live === to.address };
    if (processes === null) return { path: to.address, recorded: true };
  }
  if (processes === null) return null;
  const path = socketOf(host, processes);
  return path === null ? null : { path, recorded: false };
}

/**
 * Why the caller is not placed to send, or null — placement alone, never authority. The owner
 * always is; an unplaced caller is refused with its own reason; a seat must be the seat it names
 * in the session judged, on the pane the state records for it, exactly as `answer` judges, and
 * the two refusals it can name carry the repair.
 */
function placementProblemOf(caller: Caller, at: SeatStanding): string | null {
  if (caller.kind === 'unplaced') return caller.reason;
  if (caller.kind !== 'seat') return null;
  const verdict = callerVerdict(caller, caller.name, at);
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  return null;
}

/**
 * Why a caller judged as the file's declared seat does not pass the placement check: the two pane
 * reasons above, and the session — a call placed in another session than the one the seat is
 * judged in, or carrying none, is not that seat. The placement check is a precondition of the
 * declared judgement, so it is asked wherever that judgement is reached, and this is the one
 * place the refusal for a session the caller is not placed in is written.
 */
function declaredPlacementProblem(caller: Caller, name: string, at: SeatStanding): string | null {
  const verdict = callerVerdict(caller, name, at);
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (verdict.kind === 'refused') {
    return `seat ${name} stands in session ${at.session}, and this call is not placed in it: a caller of another session is not that seat`;
  }
  return null;
}

/** Why the send is admitted, and the rule that admitted it — or why it is not. */
export type Admission = { ok: true; rule: string; sender: Agent | DeclaredSender | 'owner' } | { ok: false; why: string };

/**
 * The authority rule for this send: `admitSend`, over the registry's own records, default deny.
 * The sender's record is its identity — the agent id the drop file's header names — and the
 * target is the agent the spec resolved to, or, on the declared-seat path, the seat this run
 * judged against the caller's own team. The team's record comes from the live file this run
 * judged, which is the seed the registry projects; a registered team's own record joins it when
 * addressing crosses teams.
 *
 * A caller the store holds no record for is judged as the seat the live file declares, when the
 * file declares it and the caller stands where the state records that seat — its pane, in the
 * session judged: the bootstrap case, where a team that has never been registered talks to itself
 * before any record exists. A caller the file declares but the state does not record standing is
 * refused by the placement check, with the two repairs the state can name. That judgement reaches
 * only its own team — the declared seat has no id to carry across teams — and it is never
 * granted: a grant names a record's identity. A caller the file does not declare, and any send
 * that would leave the file's team, stays refused with the commands that write the record.
 *
 * A record names a sender only where the call stands as it — the record's own seat, running, on
 * the pane the record holds, in its session, and on the pane the state records for that seat
 * (`recordIdentityProblem`; the same verdict `who.ts` asks of a seat). A call whose name matches a
 * record but does not stand as it is refused, never bound: a pane renamed to a registered seat's
 * name, and a caller of that name in another session, are not that seat, and must not send with
 * its id. A registry-resolved target does not skip this: the sender's identity is judged the same
 * way on every path, before any rule is asked.
 *
 * The last rule is read only once the registry's own rules have refused: the owner's send-grants
 * folder, and, only when it holds a record, the clock that decides expiry — the same order `up`
 * and `init` ask the grants in. A record the folder returns still has to name this caller's own
 * record and this receiver (`sendGrantFor`); a grant for another pair is not a grant here, so
 * nothing looser than the pair reaches `admitSend`.
 */
export function admissionOf(
  caller: Caller,
  team: TeamFile,
  target: Target | null,
  seatName: string,
  home: string,
  fileTeamId: string,
  now: () => Date,
  at: SeatStanding,
): Admission {
  if (caller.kind === 'owner') return { ok: true, rule: 'the owner', sender: 'owner' };
  const record = recordFor(home, team.session, caller.kind === 'seat' ? caller.name : '');
  // A record is bound to a call only where the call stands as it: the record's own seat, running,
  // on the pane the record holds, in its session, and on the pane the state records for that seat
  // (`callerVerdict`). Session and seat name bind no one — a pane renamed to a registered seat's
  // name is not that seat, and a caller of the same name in another session is not either — so a
  // record the call does not stand as refuses instead of acting for it. Nobody is judged by it.
  if (record !== null) {
    const identity = recordIdentityProblem(caller, record, at);
    if (identity !== null) return { ok: false, why: identity };
  }
  const declared = record === null ? declaredSenderOf(caller, team, fileTeamId) : null;
  const sender = record ?? declared;
  if (sender === null) return { ok: false, why: noAgentRecord(caller, declared) };
  // The declared seat is a reading of the caller, not a record: it is judged as that seat only
  // where the state records the seat standing. The declared-target path asks this up front; asked
  // here too, a resolved spec asks it whatever the target's record state.
  if (declared !== null) {
    const placement = declaredPlacementProblem(caller, declared.seat, at);
    if (placement !== null) return { ok: false, why: placement };
  }
  // The team the sender's own rules are read in: the record's own team, or, for a declared
  // sender, the live file's.
  const ownTeam = record === null ? fileTeamId : record.reach.team;
  // The target the rules judge: the resolved agent's own record when the registry answered the
  // spec — it names the team a cross-team send lands in — else the seat the caller's team was
  // asked for, as the declared-seat path always had it.
  const judged: SendSide = target === null ? { seat: seatName, team: ownTeam } : target.agent;
  // A declared sender's judgement stops at its own team: with no record there is no identity for
  // a rule that crosses teams to read, so a send that would leave stays refused.
  if (record === null && teamOf(judged) !== fileTeamId) return { ok: false, why: noAgentRecord(caller, declared) };
  const records = admitRecordsOf(home, team, ownTeam, target);
  // The project level `admitSend` reads: the registered projects, which decide the pairs a
  // project's own rules admit, and the asker's `seats_cross_teams` chain, entity → project →
  // team → seat, which `admitSend` resolves itself (`seatsCrossTeams`). No level's record
  // carries a declaration of that setting yet, so the chain is empty here and the setting
  // stands at its own default, off.
  const context: AdmitContext = { projects: projectRegistry.readProjects(home), crossTeams: {} };
  const verdict = admitSend(sender, judged, records, undefined, context);
  if (verdict.ok) return { ok: true, rule: verdict.rule, sender };
  // The grant folder is asked for a recorded sender alone: a grant names an identity, and the
  // declared one has none yet. So the header it would write never claims a grant.
  if (record !== null) {
    const grants = readSendGrants(home);
    if (grants.length > 0) {
      const grant = sendGrantFor(record, judged, grants, records, now());
      if (grant !== undefined) {
        const granted = admitSend(record, judged, records, grant, context);
        if (granted.ok) return { ok: true, rule: granted.rule, sender: record };
      }
    }
  }
  return { ok: false, why: verdict.why };
}

/** Why a caller with no registry record is refused, with the commands that write the record: a
 *  seat the live file declares is recorded where it already runs by `register`, and `up` registers
 *  every seat its run leaves standing, so the seat is judged by its own row afterwards either way.
 *  A caller the file does not declare is named `up` alone: `register` reads the same file, and it
 *  would refuse a name that file does not hold. */
function noAgentRecord(caller: Caller, declared: DeclaredSender | null): string {
  const register = declared === null ? '' : `\`team register ${declared.seat}\` records the seat where it already runs, or `;
  return `${describeCaller(caller)}: no agent record on this machine, so no rule admits the send (${RULE_SUMMARY}); ${register}\`team up\` registers a seat it leaves standing`;
}

/** Why a call may not act as the agent record its name found: null when it may — the call is a
 *  seat standing as the record holds it, on the pane the record names, in the record's session,
 *  with the record running, and the state recording that seat on that same pane (`callerVerdict`,
 *  the pane proof every admitted seat meets). Session and seat name alone bind nobody: a pane
 *  renamed to a registered seat's name is not that seat, and a caller of that name in another
 *  session is not it either. */
function recordIdentityProblem(caller: Caller, record: Agent, at: SeatStanding): string | null {
  const name = record.reach.seat;
  if (caller.kind !== 'seat') {
    return `the registry holds agent ${record.id} for seat ${name}, and this call is ${describeCaller(caller)}: a record is its own seat's, never a placement beside it`;
  }
  if (record.lifecycle !== 'running') {
    return `the registry's record for seat ${name} is ${record.lifecycle}, not running: only a running seat acts as its own record`;
  }
  if (record.reach.session !== caller.session) {
    return `seat ${name} stands in session ${record.reach.session}, and this call is not placed in it: a caller of another session is not that seat`;
  }
  if (record.reach.pane !== caller.pane) {
    const on = record.reach.pane === null ? 'no pane' : `pane ${record.reach.pane}`;
    return `the registry records ${on} for seat ${name} in session ${record.reach.session}, and this call is on pane ${caller.pane}: a pane renamed to a seat's name is not that seat`;
  }
  const verdict = callerVerdict(caller, name, at);
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (verdict.kind === 'refused') {
    return `seat ${name} stands in session ${at.session}, and this call is not placed in it: a caller of another session is not that seat`;
  }
  return null;
}

/** The seat the live file declares for a caller the store holds no record for: its own name, the
 *  file's team id, and the role the file gives it. Null for a caller that is not a seat, or a
 *  name the file does not declare; whether the caller stands where the state records that seat is
 *  asked beside this judgement, never read from the name alone. */
function declaredSenderOf(caller: Caller, team: TeamFile, fileTeamId: string): DeclaredSender | null {
  if (caller.kind !== 'seat') return null;
  const seat = team.seats.find((one) => one.name === caller.name);
  if (!seat) return null;
  return { seat: seat.name, team: fileTeamId, role: seat.role, declared: true };
}

/** The registry's record whose name this session holds for a seat: the most recently updated one,
 *  retired records left out. Null when the store holds none. A candidate only — the call is bound
 *  to it by `recordIdentityProblem`, which asks that the call stands as the record holds it. */
function recordFor(home: string, session: string, seat: string): Agent | null {
  if (seat === '') return null;
  let found: Agent | null = null;
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired') continue;
    if (agent.reach.session !== session || agent.reach.seat !== seat) continue;
    if (!found || agent.provenance.updated_at >= found.provenance.updated_at) found = agent;
  }
  return found;
}

/** The admission records a send is judged against: every registered team — so a target in another
 *  team is judged by that team's own record — and, over it, the live file of each team of the pair,
 *  which is the seed the registry projects. The file's project, entity, lead and operator, with the
 *  roster the store holds for that team and the file's own seats behind it; a file seat the file
 *  names as its lead carries the `leads` capability there, so the rules read the file's own lead off
 *  the line the file declares it on, whichever spelling — the `leads` mark, or the legacy
 *  `coordinator:` key a 0.3.5/0.4 file still uses — named it. The receiving team's file is read for
 *  the same reason: its registry roster may have been written before the `leads` capability existed,
 *  so the record alone cannot say who leads it, and a send keyed on the record would refuse a lead
 *  whose file names one. The role is never read on either side.
 */
function admitRecordsOf(home: string, team: TeamFile, teamId: string, target: Target | null): AdmitTeams {
  const records = readTeams(home);
  overlayTeam(home, records, team, teamId);
  if (target !== null) {
    // The key is the spelling the target's own record uses, exactly as `teamOf` reads it — that is
    // the record `admitSend` asks for. The caller's team is overlaid above already.
    const receivingId = target.agent.reach.team;
    if (receivingId !== teamId) {
      const receiving = loadTeamFile(target.team.root, { home });
      if (receiving.ok) overlayTeam(home, records, receiving.team, receivingId);
    }
  }
  return records;
}

/** One team's live file, laid over the registry's record: the file's project, entity, lead and
 *  operator, and the roster — the store's agent lines for the team, with the file's own seats
 *  behind them. A file seat carries `leads` where the file resolved it as the lead (from the
 *  `leads` mark or the legacy `coordinator:` key alike), so the project rules and the lead rule
 *  read the file's own place in the chain, never a role's word. An `entity:` the file names wins;
 *  a file that names none keeps the entity the registry recorded, the precedence the listing and
 *  the nickname scope read — a key left out of the seed never erases a recorded entity. */
function overlayTeam(home: string, records: AdmitTeams, team: TeamFile, teamId: string): void {
  // The file's own assistant, by the place the file gives it: the capability rides the seat's
  // line, whether the line comes from the registry or from the file's seats below it.
  const assistantSeat = team.seats.find((seat) => seat.assistant === true)?.name;
  const roster: AdmitTeam['roster'] = [];
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired' || agent.reach.team !== teamId) continue;
    roster.push({
      agent: agent.id, seat: agent.reach.seat, role: agent.signing.role,
      ...(agent.reach.seat === assistantSeat ? { assistant: true } : {}),
    });
  }
  for (const seat of team.seats) {
    if (!roster.some((entry) => entry.seat === seat.name)) {
      roster.push({
        agent: '', seat: seat.name, role: seat.role, leads: seat.name === team.orchestrator,
        ...(seat.assistant === true ? { assistant: true } : {}),
      });
    }
  }
  records[teamId] = {
    project: team.project,
    entity: team.entity ?? records[teamId]?.entity ?? null,
    orchestrator: team.orchestrator,
    operator: team.operator,
    roster,
  };
}

function seatList(team: TeamFile): string {
  const names = team.seats.map((seat) => seat.name);
  return names.length === 0 ? '(none)' : names.join(', ');
}

/** Herdr reported the seat took the trigger, and the pane was not a known dialog. Exit 0, always.
 *  The note names the path the send went by — `socket`, or `typed, socket <reason>` after the
 *  frame was not taken — and is left off where the seat has one channel only. */
function delivered(io: Io, seat: string, report: Report, note?: string): number {
  const summary = `${seat}: delivered${note === undefined ? '' : ` (${note})`}`;
  if (report.json) {
    writeAction(io, report, { status: 'delivered', summary, channel: note === 'socket' ? 'socket' : 'typed' });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n`);
  }
  return 0; // exit: send.delivered
}

/** The reply came back: printed, and the send is over. Exit 0, always. */
function answered(io: Io, seat: string, read: { reply: string; msg_id: string | null }, report: Report): number {
  const summary = `${seat}: answered`;
  if (report.json) {
    writeAction(io, report, { status: 'answered', summary, channel: 'socket', reply: read.reply, replyId: read.msg_id });
  } else {
    openText(io, report);
    io.stdout(`${summary}\n${read.reply}\n`);
  }
  return 0; // exit: send.answered
}

/** The frame was sent on the socket, and the window closed with no reply. Exit 1, always. */
function timedOut(io: Io, seat: string, seconds: number, report: Report): number {
  const why = `sent, no reply within ${String(seconds)}s; a seat which does not accept messages from other sessions holds the frame until a person lets it through`;
  const message = `${seat}: timeout: ${why}`;
  if (report.json) writeJsonError(io, 'send.timeout', message);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.timeout
}

/** The message is on disk — or, on the socket's path, in the frame the session's own
 *  held-message dialog keeps — and the pane was left untouched. Exit 1, always. The note names
 *  the path, in the delivery lines' own shape (`socket`). */
function held(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report, note?: string): number {
  const label = note === undefined ? 'held' : `held (${note})`;
  const message = `${seat}: ${label}: ${reason}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeJsonError(io, 'send.held', message);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.held
}

/** What showed a delivered seat took the line, as the log words it. A box that cleared with no
 *  status or transcript evidence is `taken, not yet confirmed`: a delivery, with its confirmation
 *  still to come. */
function evidenceOf(result: DeliverResult): string {
  if (result.evidence === 'taken') return TAKEN_REASON;
  return result.evidence === 'transcript' ? 'the transcript shows the drop read' : `herdr status ${result.status ?? 'working'}`;
}

/** The trigger was typed and never taken: the seat did not begin processing it. The message is on
 *  disk, and the one team.log line is the orchestrator's notice. Exit 1, always. */
function notSubmitted(io: Io, dir: string, who: string, seat: string, result: DeliverResult, where: string, host: SendHost, report: Report): number {
  const box = result.box === undefined ? 'the box could not be read' : result.box === '' ? 'the box is empty' : `the box holds ${JSON.stringify(result.box)}`;
  const reason = `the seat did not take the trigger after ${String(result.tries)} Enter${result.tries === 1 ? '' : 's'}; ${box}; ${where}`;
  return notSubmittedAt(io, dir, who, seat, reason, host, report);
}

/** A refusal: the message was not written, and the reason says why. Exit 1, always. Outside a
 *  team's folder there is no team log to append to (`dir` is null), so the refusal is reported
 *  and not written down. */
function refuse(io: Io, dir: string | null, who: string, reason: string, host: SendHost, report: Report): number {
  if (dir !== null) logLine(dir, 'send', who, `refused: ${reason}`, host.now());
  if (report.json) writeJsonError(io, 'send.refused', `refused: ${reason}`);
  else io.stderr(`team send: refused: ${reason}\n`);
  return 1; // exit: send.refused
}

/** The seat's channel was not open, and nothing was sent. A dialog is the one unreachable the
 *  watch can still deliver: the drop's record says so, and the line says when. Exit 1, always. */
function unreachable(
  io: Io,
  dir: string,
  who: string,
  seat: string,
  reason: string,
  host: SendHost,
  report: Report,
  /** The dialog in the way, when the send was stopped by one rather than by a missing channel. */
  dialog?: string,
): number {
  const words = dialog === undefined ? `unreachable: ${reason}` : `unreachable now (the screen reads ${dialog}); ${reason}`;
  const message = `${seat}: ${words}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeJsonError(io, 'send.unreachable', message);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.unreachable
}

/** The receiving team file marks the seat `stopped: true`: the seat is not addressed, so the
 *  send is refused before a drop file, a leg or a history line exists. The line wears the
 *  unreachable outcome's words, and its own exit id tells a stopped seat apart from a channel
 *  that merely failed. Exit 1, always. */
function stoppedSeat(io: Io, dir: string, who: string, seat: string, host: SendHost, report: Report): number {
  const reason = `${seat} is stopped`;
  const message = `${seat}: unreachable: ${reason}`;
  logLine(dir, 'send', who, message, host.now());
  if (report.json) writeJsonError(io, 'send.stopped', message);
  else io.stderr(`team send: ${message}\n`);
  return 1; // exit: send.stopped
}

function usage(io: Io, message: string, report: Report): number {
  if (report.json) writeJsonError(io, 'send.usage', message);
  else io.stderr(`team send: ${message}\n${USAGE}`);
  return 2; // exit: send.usage
}

function configuration(io: Io, message: string, report: Report): number {
  if (report.json) writeJsonError(io, 'send.configuration', message);
  else io.stderr(`team send: ${message}\n`);
  return 2; // exit: send.configuration
}

/** The one action document's own fields: the frame is `writeAction`'s. `summary` is the closing
 *  line the plain run prints last, so the two faces say the same thing once. */
type ActionFields = {
  status: 'delivered' | 'answered' | 'recorded' | 'dry-run';
  summary: string;
  dryRun?: boolean;
  /** The leg that carried the send: `socket`, `typed`, or `native` for a record. */
  channel?: 'socket' | 'typed' | 'native' | null;
  /** The reply's text, on an answered wait. */
  reply?: string;
  /** The reply frame's own id, on an answered wait. */
  replyId?: string | null;
  plan?: readonly PlanStep[];
};

/** Writes the `team.send` action document (the envelope's tag first, then the action surface,
 *  then the command's own fields) — the frame every exit-0 outcome shares. */
function writeAction(io: Io, report: Report, fields: ActionFields): void {
  writeJson(io, 'team.send', {
    format: 1 as const,
    dry_run: fields.dryRun === true,
    status: fields.status,
    action_summary: fields.summary,
    project: report.project,
    session: report.session,
    seat: report.seat,
    ...(fields.channel !== undefined ? { channel: fields.channel } : {}),
    ids: { sent: report.sent, reply: fields.replyId ?? null },
    ...(fields.reply !== undefined ? { reply: fields.reply } : {}),
    ...(fields.plan !== undefined ? { plan: [...fields.plan] } : {}),
  });
}

/** The context line every exit-0 run opens on, when the receiving team file names the team:
 *  `team <project>, session "<session>"`. A run refused before the file was read has none. */
function openText(io: Io, report: Report): void {
  if (report.project !== null && report.session !== null) {
    io.stdout(`${contextLine(report.project, report.session)}\n`);
  }
}
