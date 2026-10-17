import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, detachedRefusal, judgeCallerIn, noPaneRefusal, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { agentList, agentStatus, paneProcesses, paneRead, pressEnter, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { acquireSeatLock, seatLockPath } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { readAgents, type Agent } from '../registry/agents.ts';
import * as projectRegistry from '../registry/projects.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
import { realSources as realProjectSources, type ProjectSources } from './projects.ts';
import { liveSocketOf } from '../send/address.ts';
import { admitSend, RULE_SUMMARY, sendGrantFor, senderHeader, teamOf, type AdmitContext, type AdmitTeam, type AdmitTeams, type DeclaredSender, type SendSide } from '../send/admit.ts';
import { readSendGrants } from '../send/grants.ts';
import { appendHistory } from '../send/history.ts';
import { NATIVE_BODY_MARKER, NATIVE_CHANNEL } from '../send/routes.ts';
import { daemonSocketPath, isBareShellPane, requestDaemon, type DaemonSendResponse } from '../send/daemon.ts';
import { deliveryChainOf } from '../send/delivery.ts';
import { bindPane, deliverTrigger, showsHeldFrameDialog, type DeliverResult } from '../send/deliver.ts';
import { dropMessage, POLL_MS, triggerLine, TRIGGER_MAX, type NativePane } from '../send/native.ts';
import { openReplyListener, readReply } from '../send/reply.ts';
import { isRegistrySpec, resolveTarget, type Target } from '../send/resolve.ts';
import { FRAME_LIMIT, SOCKET_SEND, sendFrame, type SendOutcome } from '../send/uds.ts';
import { deliveryOrder, type DeliveryLeg, type SettingLevel } from '../settings/inherit.ts';

export const USAGE = `Usage: team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
       team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
       team send --list [--json]

Writes one message to one seat. A plain send writes the body whole to a drop file
(mode 0600, atomic rename) and types one short trigger line, for every seat. The body
is never typed and never split across several writes. delivered means herdr reported
the seat working — or done or blocked, changed from the status read before Enter —
after that line and Enter, or the transcript shows the drop being read, and the line has
left the seat's input box, and the pane is not a dialog this command already classifies
(question, permission, trust, vendor notice, provider error, rate limit). A screen that
is one of those is not reached: the kind and the drop path are named, and nothing
further is pressed. Who may call it is the registry's decision, default deny: the
owner; an orchestrator to an orchestrator, in any teams; an assistant seat to its
entity's coordinator; any seat to its own team's orchestrator; or an owner-signed
grant naming send. The drop file's first line
names the sender and the rule that admitted it. --list sends nothing: it prints
the file's seats, each with the project its team sits in, and needs no caller
check. --dry-run resolves the seat and the
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
               counted, and the drop path
  timeout      --wait to a Claude Code seat: the frame was sent on the socket, and no
               reply came within the window (exit 1). A seat which does not accept
               messages from other sessions holds the frame until a person lets it
               through
  unreachable  the channel did not confirm (exit 1): the session is not running, no
               live agent carries the seat's name, the pane is one of those dialogs,
               no socket took a waited frame, or the pane would not take the trigger
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
listener needs is that leg. Nothing is written in any of these. --json prints one
result document instead of the lines:
{seat, status, exit, reply?, error?, ids}. --file reads the body from a file instead
of the one <message> argument.

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
`;

export type SendHost = {
  /** The live agents of a session; null when herdr can't be reached. */
  agents(session: string): { name: string; pane: string }[] | null;
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
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane })) ?? null,
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
 *  names, and the id of the frame it composed (null until one is built). */
type Report = { json: boolean; seat: string | null; sent: string | null };

/** Where one send goes: the registry's answer for the spec, or the declared seat of the
 *  caller's own file. */
type Aim = {
  seat: string;
  session: string;
  cli: string;
  /** The pane the target resolved to; null when the pane is read live, by name. */
  pane: string | null;
  /** The cross-session address the registry recorded for the target; null when none. */
  address: string | null;
  /** The team file's folder this send belongs to: the receiving team's, across teams. */
  dir: string;
  project: string;
  root: string;
  /** True when the target's team is not the caller's. */
  cross: boolean;
};

export async function runSend(argv: string[], io: Io, host: SendHost): Promise<number> {
  const args = readArgs(argv, ['file', 'timeout', 'record', 'channel', 'ms'], ['wait', 'json', 'list', 'dry-run']);
  const seatName = args.rest[0];
  const report: Report = { json: args.flags.has('json'), seat: seatName ?? null, sent: null };
  if (args.error) return usage(io, args.error, report);
  const detached = detachedRefusal(callerOf(io));
  if (detached !== undefined) {
    io.stderr(`team send: ${detached}\n`);
    // exit: send.detached
    return 1;
  }
  if (args.flags.has('list')) return listSeats(io, host, report);
  // The native half of the channel: nothing is delivered here, so the seat is named by
  // `--record` and the rest of the line is the record's own options, judged on their own.
  if (args.values.record !== undefined) return recordRun(args, io, host);
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

  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  // The id the registry writes for this team: the live file's own identity, the team a sender
  // the store holds no record for is judged in.
  const fileTeamId = teamIdOf(root);

  // The address is resolved first: the registry answers an agent id, a `seat@team` (team spelled
  // by id, project or session) or a plain seat it holds an agent for, and the live herdr read is
  // the fallback for a record that carries no pane. A spec that names nobody is refused by its
  // own answer; a plain seat the registry cannot answer keeps the declared-seat path below.
  // The live read the resolution may fall back to is the host's, one reader for the session's
  // agents, so a fake host answers it in tests.
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logWho(caller, team);
  const from = caller.kind === 'seat' ? caller.name : 'owner';
  const resolved = resolveTarget(host.home, seatName, io, (session) => host.agents(session));
  if ('error' in resolved && isRegistrySpec(seatName)) return refuse(io, dir, who, resolved.error, host, report);
  const hit = 'error' in resolved ? null : resolved;

  // The authority rule, `admitSend` over the registry's records, default deny, judging the
  // resolved target when there is one. A sender the store holds no record for is judged as the
  // seat the live file declares for it: this team's rules alone reach it — a target in another
  // team, and the grant store, both wait for the record `team up` writes. That declared judgement
  // asks placement first, whatever the spec resolved to — the owner, or a seat on the pane the
  // state records for it, in the session judged, the same verdict `answer` asks, with the two
  // repairable refusals it can name — so the seat is judged only where the state records it
  // standing; a registry-resolved send by a sender the store does hold a record for is bound to
  // that record instead, and needs no pane in the state. All of it runs before the message is
  // read and before any seat is probed.
  const standing = standingOf(dir, judged.session, caller);
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standing);
    if (placement) return refuse(io, dir, who, placement, host, report);
    admission = admissionOf(caller, team, null, seatName, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    const configured = team.seats.find((seat) => seat.name === seatName);
    if (!configured) {
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat: seatName, session: team.session, cli: configured.cli, pane: null, address: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    // A resolved spec is addressed by its record: its pane, its session and its CLI, under the
    // receiving team's own folder; across teams this run's daemon is skipped, so the send is
    // reached directly.
    const cross = hit.team.root !== root;
    to = {
      seat: hit.agent.reach.seat,
      session: hit.agent.reach.session,
      cli: hit.agent.cli,
      pane: hit.pane,
      address: hit.agent.reach.address,
      dir: cross ? join(hit.team.root, '.agents') : dir,
      project: hit.team.project,
      root: hit.team.root,
      cross,
    };
  }
  report.seat = to.seat;
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
  // seat is refused before a write. A Claude Code --wait run is refused as well when the order
  // does not lead with the native leg — the frame the reply listener stands beside is that leg —
  // and while SOCKET_SEND is off (deliverSocket names that refusal). A dry run prints a refusal
  // the same way wherever the real run would refuse, and names the channel otherwise, since
  // nothing is written either way.
  if (wait && to.cli !== 'claude-code' && !dry) {
    return refuse(io, dir, who, `${to.seat} runs ${to.cli}: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent`, host, report);
  }
  if (wait && to.cli === 'claude-code') {
    // The frame is the native leg, and --wait rides it: an order that leads elsewhere, or holds
    // no native leg at all, has no frame for the reply listener to stand beside.
    if (order[0] !== 'native') {
      const leads = order.length === 0 ? 'empty' : order.join(', ');
      const why = `--wait needs the native leg first, and its delivery order is ${leads}; nothing was sent`;
      if (dry) return dryRun(io, dir, who, to.seat, `${to.cli} ${why}`, host, report);
      return refuse(io, dir, who, `${to.seat}: ${why}`, host, report);
    }
    return deliverSocket(io, dir, who, from, to, body, dry, timeoutS, host, report, startedAt);
  }

  // A plain send, every seat: the body is never typed. It is written whole to a 0600 drop
  // file, and the pane gets one trigger line.
  const msgId = randomUUID();
  const dropDir = join(to.dir, 'send-drops', to.session, to.seat);
  const dropPath = join(dropDir, msgId);
  if (dry) {
    return dryRun(io, dir, who, to.seat, `${to.cli} via ${walkPhrase(order, to.cli)}; nothing was written`, host, report);
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
    // trigger past the measured line before anything is written.
    const trigger = triggerLine(dropPath);
    if (trigger === null) {
      return refuse(io, dir, who, `${to.seat}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was sent`, host, report);
    }
    // The daemon serves seats of the caller's own team; a seat in another team's record is
    // reached directly, under that team's folder.
    const daemonSock = host.daemonSocket ?? daemonSocketPath(to.project, to.root, host.home);
    const viaDaemon = to.cross
      ? null
      : await requestDaemon(daemonSock, { v: 1, op: 'send', id: msgId, from, to: to.seat, body, ...(failures.length > 0 ? { failed: [...failures] } : {}) });
    if (viaDaemon && !('pong' in viaDaemon) && !('shutdown' in viaDaemon)) {
      return finishDaemonSend(io, dir, who, to.seat, timeoutS, host, report, viaDaemon, socketNote ?? undefined);
    }
    // A resolved record carries the pane the send goes to; the plain path reads the pane live,
    // by the seat's name.
    const found: Found = to.pane !== null ? { ok: true, pane: to.pane } : findAgent(host, to.session, to.seat);
    if (!found.ok) {
      if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
      const entry = { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) };
      appendHistory(to.project, to.root, host.home, entry);
      return unreachable(io, dir, who, to.seat, found.reason, host, report);
    }
    if (isBareShellPane(to.dir, to.session, to.seat, host.processInfo(to.session, found.pane))) {
      const entry = { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) };
      appendHistory(to.project, to.root, host.home, entry);
      return unreachable(io, dir, who, to.seat, 'the seat is back at its shell; nothing was typed', host, report);
    }
    report.sent = msgId;
    return deliverNative(io, to.dir, to.root, who, from, to.project, to.session, to.seat, to.cli, found.pane, dropDir, msgId, body, trigger, host, report, startedAt, socketNote ?? undefined, failures);
  }

  // No leg took the send: the walk ran out of legs with nothing written — the drop file is
  // only written by the typed leg — and every leg that fell is named.
  const why = `no leg of its delivery order took the send${failures.length === 0 ? '' : ` (${failures.join('; ')})`}`;
  appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, ...(failures.length > 0 ? { failed: [...failures] } : {}) });
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
function recordRun(args: Args, io: Io, host: SendHost): number {
  const seatName = args.values.record as string;
  const report: Report = { json: args.flags.has('json'), seat: seatName, sent: null };
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

  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const fileTeamId = teamIdOf(root);
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logWho(caller, team);
  const from = caller.kind === 'seat' ? caller.name : 'owner';
  const resolved = resolveTarget(host.home, seatName, io, (session) => host.agents(session));
  if ('error' in resolved && isRegistrySpec(seatName)) return refuse(io, dir, who, resolved.error, host, report);
  const hit = 'error' in resolved ? null : resolved;
  const standing = standingOf(dir, judged.session, caller);
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standing);
    if (placement) return refuse(io, dir, who, placement, host, report);
    admission = admissionOf(caller, team, null, seatName, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    const configured = team.seats.find((seat) => seat.name === seatName);
    if (!configured) {
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat: seatName, session: team.session, cli: configured.cli, pane: null, address: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home, fileTeamId, () => host.now(), standing);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    const cross = hit.team.root !== root;
    to = {
      seat: hit.agent.reach.seat,
      session: hit.agent.reach.session,
      cli: hit.agent.cli,
      pane: hit.pane,
      address: hit.agent.reach.address,
      dir: cross ? join(hit.team.root, '.agents') : dir,
      project: hit.team.project,
      root: hit.team.root,
      cross,
    };
  }
  report.seat = to.seat;
  const msgId = randomUUID();
  if (args.flags.has('dry-run')) return recordDryRun(io, to.seat, ms, report);
  const written = appendHistory(to.project, to.root, host.home, {
    ts: host.now().toISOString(),
    from,
    to: to.seat,
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
  if (report.json) {
    io.stdout(document({ seat, status: 'recorded', exit: 0, ids: { sent: id, reply: null } }));
  } else {
    io.stdout(`${seat}: recorded (native, ${String(ms)} ms)\n`);
  }
  return 0; // exit: send.recorded
}

/** What --record would write, with nothing written and nothing read: the run's own wording.
 *  Exit 0, always. */
function recordDryRun(io: Io, seat: string, ms: number, report: Report): number {
  if (report.json) {
    io.stdout(document({ seat, status: 'dry-run', exit: 0, ids: { sent: null, reply: null } }));
  } else {
    io.stdout(`${seat}: would record (native, ${String(ms)} ms); nothing was written\n`);
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
  if (res.outcome === 'delivered') return delivered(io, seatName, report, note);
  if (res.outcome === 'answered') return answered(io, seatName, { reply: res.reply, msg_id: res.reply_id }, report);
  if (res.outcome === 'timeout') return timedOut(io, seatName, timeoutS, report);
  if (res.outcome === 'held') return held(io, dir, who, seatName, res.detail, host, report);
  if (res.outcome === 'unreachable') return unreachable(io, dir, who, seatName, res.detail, host, report);
  if (res.outcome === 'not-submitted') {
    const result: DeliverResult = { outcome: 'not-submitted', tries: res.tries, ...(res.box === null ? {} : { box: res.box }) };
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
  // No socket, no waited frame: the frame the reply listener needs is one this build does not
  // write, so the run is refused rather than carried by a channel the reply cannot come back
  // on. The dry run prints the same sentence; nothing dials either way.
  if (!SOCKET_SEND) {
    const reason = '--wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent';
    if (dry) return dryRun(io, dir, who, to.seat, `${to.cli} ${reason}`, host, report);
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
    return dryRun(io, dir, who, to.seat, 'claude-code via the cross-session socket; nothing was sent', host, report);
  }

  const daemonSock = host.daemonSocket ?? daemonSocketPath(to.project, to.root, host.home);
  const viaDaemon = to.cross
    ? null
    : await requestDaemon(
        daemonSock,
        { v: 1, op: 'send', id: msgId, from, to: to.seat, body, wait: true, timeout_s: timeoutS },
        (timeoutS + 30) * 1000,
      );
  if (viaDaemon && !('pong' in viaDaemon) && !('shutdown' in viaDaemon)) {
    return finishDaemonSend(io, dir, who, to.seat, timeoutS, host, report, viaDaemon);
  }

  const found: Found = to.pane !== null ? { ok: true, pane: to.pane } : findAgent(host, to.session, to.seat);
  if (!found.ok) {
    if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt });
    return unreachable(io, dir, who, to.seat, found.reason, host, report);
  }
  const pane = found.pane;
  const processes = host.processInfo(to.session, pane);
  if (processes === null) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt });
    return unreachable(io, dir, who, to.seat, "the pane's processes could not be read", host, report);
  }
  // The registry's recorded address while it is still live, else today's discovery, the pane's
  // own processes — which also covers the alternative sockets folder.
  const socketPath = liveSocketOf(to.address, processes, host.socketsDir) ?? socketOf(host, processes);
  if (socketPath === null) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt });
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
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'socket' });
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
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'socket' });
        return held(io, dir, who, to.seat, HELD_FRAME_REASON, host, report, 'socket');
      }
      const outcome = await listener.wait(timeoutS * 1000);
      if (outcome.kind === 'answered') {
        const read = readReply(outcome.line);
        logLine(to.dir, 'send', who, `${to.seat}: answered (reply ${String(read.reply.length)} characters)`, host.now());
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'answered', ms: host.now().getTime() - startedAt, via: 'socket' });
        return answered(io, to.seat, read, report);
      }
      logLine(to.dir, 'send', who, `${to.seat}: timeout (sent, no reply within ${String(timeoutS)}s)`, host.now());
      appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'timeout', ms: host.now().getTime() - startedAt, via: 'socket' });
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
 * success. The lock is held across the typing so a second send cannot append into the same
 * composer.
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
    const entry = { ts: host.now().toISOString(), from, to: seatName, body, id: msgId };
    if (result.outcome === 'held') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      return held(io, dir, who, seatName, `${result.reason ?? 'the composer holds text'}; ${where}`, host, report);
    }
    if (result.outcome === 'unreachable') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'unreachable', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      return unreachable(io, dir, who, seatName, `${result.reason ?? 'the seat was not reached'}; ${where}`, host, report);
    }
    if (result.outcome === 'not-submitted') {
      appendHistory(project, root, host.home, { ...entry, outcome: 'not-submitted', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
      return notSubmitted(io, dir, who, seatName, result, where, host, report);
    }
    logLine(dir, 'send', who, `${seatName}: delivered (drop ${String(body.length)} characters, ${evidenceOf(result)})`, host.now());
    appendHistory(project, root, host.home, { ...entry, outcome: 'delivered', ms: host.now().getTime() - startedAt, via: 'typed', ...failed });
    return delivered(io, seatName, report, note);
  } finally {
    lock.release();
  }
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

/** The seat and channel. No drop file and nothing typed. One team.log line. Exit 0, always. */
function dryRun(io: Io, dir: string, who: string, seat: string, what: string, host: SendHost, report: Report): number {
  report.sent = null;
  logLine(dir, 'send', who, `${seat}: dry-run: ${what}`, host.now());
  if (report.json) {
    io.stdout(document({ seat, status: 'dry-run', exit: 0, ids: { sent: null, reply: null } }));
  } else {
    io.stdout(`${seat}: dry-run: ${what}\n`);
  }
  return 0; // exit: send.dry-run
}

/** `--list`: the file's seats, nothing sent and no caller check. Exit 0, always. */
function listSeats(io: Io, host: SendHost, report: Report): number {
  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read', report);
  }
  // Phase 0b: every row carries the project its team sits in — the registry project whose teams
  // name this team, else the team's own project name (a team the registry places in none is its
  // own project). An injected registry answers for itself; with none, the registry the host's home
  // holds is the reading, bound to that home rather than to wherever the process runs.
  const teamId = teamIdOf(loaded.root);
  const found = host.projects ? host.projects.ofTeam(teamId) : projectRegistry.ofTeam(host.home, teamId);
  const project = found?.name ?? loaded.team.project;
  const seats = loaded.team.seats.map((seat) => ({
    name: seat.name,
    cli: seat.cli,
    role: seat.role,
    stopped: seat.stopped === true,
    project,
  }));
  if (report.json) {
    io.stdout(document({ seat: null, status: 'listed', exit: 0, ids: { sent: null, reply: null }, seats }));
  } else if (seats.length === 0) {
    io.stdout('(no seats)\n');
  } else {
    for (const seat of seats) {
      io.stdout(`${seat.name}  ${seat.cli}  ${seat.role}  ${seat.project}${seat.stopped ? '  (stopped)' : ''}\n`);
    }
  }
  return 0; // exit: send.listed
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
  const failed = failures.length > 0 ? { failed: [...failures] } : {};
  const frame = frameFor(body, msgId);
  if (frame.length > FRAME_LIMIT) {
    return { kind: 'fallback', reason: `the frame is ${String(frame.length)} characters, past the socket's measured limit of ${String(FRAME_LIMIT)}` };
  }
  const found: Found = to.pane !== null ? { ok: true, pane: to.pane } : findAgent(host, to.session, to.seat);
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
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'held', ms: host.now().getTime() - startedAt, via: 'socket', ...failed });
    return { kind: 'held', reason: HELD_FRAME_REASON };
  }
  appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'delivered', ms: host.now().getTime() - startedAt, via: 'socket', ...failed });
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

/** The caller class the caller check returned, as the log's bracket: `answer`'s own. */
export function logWho(caller: Caller, team: TeamFile): string {
  if (caller.kind === 'owner' || caller.kind === 'owner-no-tty') return 'owner';
  if (caller.kind === 'unplaced') return 'unplaced';
  if (caller.kind === 'pane') return caller.session === undefined ? caller.pane : `${caller.session}/${caller.pane}`;
  return caller.name === team.orchestrator ? 'orchestrator' : 'seat';
}

/**
 * Why the caller is not placed to send, or null — placement alone, never authority. The owner
 * always is; an unplaced caller is refused with its own reason; a seat must be the seat it names
 * in the session judged, on the pane the state records for it, exactly as `answer` judges, and
 * the two refusals it can name carry the repair.
 */
function placementProblemOf(caller: Caller, at?: SeatStanding): string | null {
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
  const records = admitRecordsOf(home, team, ownTeam);
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

/** The registry's record for a seat of this session: the most recently updated one, retired
 *  records left out. Null when the store holds none. */
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
 *  team is judged by that team's own record — and, over it, this run's team from the live file,
 *  which is the seed the registry projects. The file's project, entity, lead and operator, with
 *  the roster the store holds for that team and the file's own seats behind it; a file seat the
 *  file names as its coordinator carries the `leads` capability there, so the project rules read
 *  the file's own lead off the line the file declares it on. */
function admitRecordsOf(home: string, team: TeamFile, teamId: string): AdmitTeams {
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
  return {
    ...readTeams(home),
    [teamId]: { project: team.project, entity: team.entity, orchestrator: team.orchestrator, operator: team.operator, roster },
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
  if (report.json) {
    io.stdout(document({ seat, status: 'delivered', exit: 0, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stdout(`${seat}: delivered${note === undefined ? '' : ` (${note})`}\n`);
  }
  return 0; // exit: send.delivered
}

/** The reply came back: printed, and the send is over. Exit 0, always. */
function answered(io: Io, seat: string, read: { reply: string; msg_id: string | null }, report: Report): number {
  if (report.json) {
    io.stdout(document({ seat, status: 'answered', exit: 0, reply: read.reply, ids: { sent: report.sent, reply: read.msg_id } }));
  } else {
    io.stdout(`${seat}: answered\n${read.reply}\n`);
  }
  return 0; // exit: send.answered
}

/** The frame was sent on the socket, and the window closed with no reply. Exit 1, always. */
function timedOut(io: Io, seat: string, seconds: number, report: Report): number {
  const why = `sent, no reply within ${String(seconds)}s; a seat which does not accept messages from other sessions holds the frame until a person lets it through`;
  if (report.json) {
    io.stdout(document({ seat, status: 'timeout', exit: 1, error: why, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stderr(`team send: ${seat}: timeout: ${why}\n`);
  }
  return 1; // exit: send.timeout
}

/** The message is on disk — or, on the socket's path, in the frame the session's own
 *  held-message dialog keeps — and the pane was left untouched. Exit 1, always. The note names
 *  the path, in the delivery lines' own shape (`socket`). */
function held(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report, note?: string): number {
  const label = note === undefined ? 'held' : `held (${note})`;
  logLine(dir, 'send', who, `${seat}: ${label}: ${reason}`, host.now());
  if (report.json) {
    io.stdout(document({ seat, status: 'held', exit: 1, error: reason, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stderr(`team send: ${seat}: ${label}: ${reason}\n`);
  }
  return 1; // exit: send.held
}

/** What showed a delivered seat took the line, as the log words it. */
function evidenceOf(result: DeliverResult): string {
  return result.evidence === 'transcript' ? 'the transcript shows the drop read' : `herdr status ${result.status ?? 'working'}`;
}

/** The trigger was typed and never taken: the seat did not begin processing it. The message is on
 *  disk, and the one team.log line is the orchestrator's notice. Exit 1, always. */
function notSubmitted(io: Io, dir: string, who: string, seat: string, result: DeliverResult, where: string, host: SendHost, report: Report): number {
  const box = result.box === undefined ? 'the box could not be read' : result.box === '' ? 'the box is empty' : `the box holds ${JSON.stringify(result.box)}`;
  const reason = `the seat did not take the trigger after ${String(result.tries)} Enter${result.tries === 1 ? '' : 's'}; ${box}; ${where}`;
  logLine(dir, 'send', who, `${seat}: not-submitted: ${reason}`, host.now());
  if (report.json) {
    io.stdout(document({ seat, status: 'not-submitted', exit: 1, error: reason, box: result.box ?? null, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stderr(`team send: ${seat}: not-submitted: ${reason}\n`);
  }
  return 1; // exit: send.not-submitted
}

/** A refusal: the message was not written, and the reason says why. Exit 1, always. */
function refuse(io: Io, dir: string, who: string, reason: string, host: SendHost, report: Report): number {
  logLine(dir, 'send', who, `refused: ${reason}`, host.now());
  if (report.json) {
    io.stdout(document({ seat: report.seat, status: 'refused', exit: 1, error: reason, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stderr(`team send: refused: ${reason}\n`);
  }
  return 1; // exit: send.refused
}

/** The seat's channel was not open, and nothing was sent. Exit 1, always. */
function unreachable(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report): number {
  logLine(dir, 'send', who, `${seat}: unreachable: ${reason}`, host.now());
  if (report.json) {
    io.stdout(document({ seat, status: 'unreachable', exit: 1, error: reason, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stderr(`team send: ${seat}: unreachable: ${reason}\n`);
  }
  return 1; // exit: send.unreachable
}

function usage(io: Io, message: string, report: Report): number {
  if (report.json) io.stdout(document({ seat: report.seat, status: 'usage', exit: 2, error: message, ids: { sent: report.sent, reply: null } }));
  else io.stderr(`team send: ${message}\n${USAGE}`);
  return 2; // exit: send.usage
}

function configuration(io: Io, message: string, report: Report): number {
  if (report.json) io.stdout(document({ seat: report.seat, status: 'configuration', exit: 2, error: message, ids: { sent: report.sent, reply: null } }));
  else io.stderr(`team send: ${message}\n`);
  return 2; // exit: send.configuration
}

type SeatLine = { name: string; cli: string; role: string; stopped: boolean };

/** The one machine-readable result, in a fixed key order: seat, status, exit, reply?,
 *  error?, ids, seats?. With --json it is the run's whole stdout, every outcome. */
function document(fields: {
  seat: string | null;
  status: string;
  exit: number;
  reply?: string;
  error?: string;
  /** What a `not-submitted` seat's box held, not counting faint text; null when it could not be read. */
  box?: string | null;
  ids: { sent: string | null; reply: string | null };
  seats?: SeatLine[];
}): string {
  const out: Record<string, unknown> = { seat: fields.seat, status: fields.status, exit: fields.exit };
  if (fields.reply !== undefined) out.reply = fields.reply;
  if (fields.error !== undefined) out.error = fields.error;
  if (fields.box !== undefined) out.box = fields.box;
  out.ids = fields.ids;
  if (fields.seats !== undefined) out.seats = fields.seats;
  return `${JSON.stringify(out)}\n`;
}
