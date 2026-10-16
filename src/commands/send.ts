import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, detachedRefusal, judgeCallerIn, noPaneRefusal, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { agentList, agentStatus, paneProcesses, paneRead, pressEnter, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { readAgents, type Agent } from '../registry/agents.ts';
import { readTeams } from '../registry/teams.ts';
import { admitSend, RULE_SUMMARY, senderHeader, type AdmitTeam, type AdmitTeams, type SendSide } from '../send/admit.ts';
import { appendHistory } from '../send/history.ts';
import { daemonSocketPath, isBareShellPane, requestDaemon, type DaemonSendResponse } from '../send/daemon.ts';
import { bindPane, deliverTrigger, type DeliverResult } from '../send/deliver.ts';
import { dropMessage, triggerLine, TRIGGER_MAX, type NativePane } from '../send/native.ts';
import { openReplyListener, readReply } from '../send/reply.ts';
import { isRegistrySpec, resolveTarget, type Target } from '../send/resolve.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../send/uds.ts';

export const USAGE = `Usage: team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send --list [--json]

Writes one message to one seat. A plain send writes the body whole to a drop file
(mode 0600, atomic rename) and types one short trigger line, for every seat. The body
is never typed and never split across several writes. delivered means herdr reported
the seat working — or done or blocked, changed from the status read before Enter —
after that line and Enter and the line has left the seat's input box, and the pane is
not a dialog this command already classifies
(question, permission, trust, vendor notice, provider error, rate limit). A screen that
is one of those is not reached: the kind and the drop path are named, and nothing
further is pressed. Who may call it is the registry's decision, default deny: the
owner; an orchestrator to any seat of its own team or to an orchestrator in any
teams; an assistant seat to its entity's coordinator; any seat to its own team's
orchestrator; or an owner-signed grant naming send. The drop file's first line
names the sender and the rule that admitted it. --list sends nothing: it prints
the file's seats and needs no caller check. --dry-run resolves the seat and the
channel, writes no drop file, and types nothing. It appends one line to the team
log.

The outcome is one of seven, and none of them is silent:
  delivered    the drop path (exit 0): herdr reported the seat working — or done or
               blocked, changed from the status read before Enter — the line had left
               the input box, and the pane was not one of the dialogs listed above
  answered     --wait to a Claude Code seat: the reply came back; the reply follows
               on stdout (exit 0)
  held         the message is safely on disk, and the pane was left untouched because
               the seat remained busy, locked, in a dialog, or holding an unsent draft
               (exit 1)
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
  refused      nothing was sent (exit 1): not a declared seat, --wait to a seat that
               is not Claude Code, a socket frame over the measured limit, a trigger
               that would exceed the measured line length, a reply listener that
               could not be opened, or a caller that may not send

--wait to a Claude Code seat writes one frame on the cross-session socket, because
the reply listener needs that frame, and blocks for the reply at this process's own
<sockets dir>/<pid>.sock, for --timeout seconds (default 120; --timeout is only
meaningful with --wait). A successful write says the frame was sent on the socket,
not that it was delivered. --wait to any other seat is refused and nothing is
written. --json prints one result document instead of the lines:
{seat, status, exit, reply?, error?, ids}. --file reads the body from a file instead
of the one <message> argument.

Not in this build: broadcast, and a reply from a seat that is not Claude Code.
`;

export type SendHost = {
  /** The live agents of a session; null when herdr can't be reached. */
  agents(session: string): { name: string; pane: string }[] | null;
  /** A pane's process pids, or null when the pane can't be read. */
  processInfo(session: string, pane: string): PaneProcesses | null;
  /** The folder the session sockets live in; the real one is the runtime temp folder's. */
  socketsDir: string;
  deliver(socketPath: string, frame: string): Promise<SendOutcome>;
  /** Types a native seat's trigger and reads herdr's status. Tests pass a fake. */
  native: NativePane;
  now(): Date;
  home: string;
  /** Optional override for the per-project send daemon socket path. */
  daemonSocket?: string;
};

export const realHost: SendHost = {
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane })) ?? null,
  processInfo: (session, pane) => paneProcesses(pane, session),
  // The probe's path shape: `<tmp>/cc-socks/<pid>.sock`, the runtime temp folder's own
  // (observed on this Mac as /tmp/cc-socks; a version-specific observation, not a public
  // API contract).
  socketsDir: join(tmpdir(), 'cc-socks'),
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
  /** The team file's folder this send belongs to: the receiving team's, across teams. */
  dir: string;
  project: string;
  root: string;
  /** True when the target's team is not the caller's. */
  cross: boolean;
};

export async function runSend(argv: string[], io: Io, host: SendHost): Promise<number> {
  const args = readArgs(argv, ['file', 'timeout'], ['wait', 'json', 'list', 'dry-run']);
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
  // resolved target when there is one. The declared-seat path checks placement first — the
  // owner, or a seat on the pane the state records for it, the same verdict `answer` asks,
  // with the two repairable refusals it can name — and judges the seat the caller's team was
  // asked for; a registry-resolved send is bound to its caller's agent record instead, and
  // needs no pane in the state. All of it runs before the message is read and before any seat
  // is probed.
  let to: Aim;
  let admission: Admission;
  if (hit === null) {
    const placement = placementProblemOf(caller, standingOf(dir, judged.session, caller));
    if (placement) return refuse(io, dir, who, placement, host, report);
    admission = admissionOf(caller, team, null, seatName, host.home);
    if (!admission.ok) return refuse(io, dir, who, admission.why, host, report);
    const configured = team.seats.find((seat) => seat.name === seatName);
    if (!configured) {
      return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
    }
    to = { seat: seatName, session: team.session, cli: configured.cli, pane: null, dir, project: team.project, root, cross: false };
  } else {
    admission = admissionOf(caller, team, hit, seatName, host.home);
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
  // --wait needs the socket frame, and only a Claude Code seat has that listener. Any other
  // seat is refused before a write. A dry run of that refusal still names the drop channel,
  // because nothing is written either way.
  if (wait && to.cli !== 'claude-code' && !dry) {
    return refuse(io, dir, who, `${to.seat} runs ${to.cli}: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent`, host, report);
  }
  if (wait && to.cli === 'claude-code') {
    return deliverSocket(io, dir, who, from, to, body, dry, timeoutS, host, report);
  }

  // A plain send, every seat: the body is never typed. It is written whole to a 0600 drop
  // file, and the pane gets one trigger line.
  const msgId = randomUUID();
  const dropDir = join(to.dir, 'send-drops', to.session, to.seat);
  const dropPath = join(dropDir, msgId);
  const trigger = triggerLine(dropPath);
  if (trigger === null) {
    return refuse(io, dir, who, `${to.seat}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was sent`, host, report);
  }
  if (dry) {
    return dryRun(io, dir, who, to.seat, `${to.cli} via a 0600 drop file and one trigger line; nothing was written`, host, report);
  }

  // The daemon serves seats of the caller's own team; a seat in another team's record is
  // reached directly, under that team's folder.
  const daemonSock = host.daemonSocket ?? daemonSocketPath(to.project, to.root, host.home);
  const viaDaemon = to.cross ? null : await requestDaemon(daemonSock, { v: 1, op: 'send', id: msgId, from, to: to.seat, body });
  if (viaDaemon && !('pong' in viaDaemon) && !('shutdown' in viaDaemon)) {
    return finishDaemonSend(io, dir, who, to.seat, timeoutS, host, report, viaDaemon);
  }

  // A resolved record carries the pane the send goes to; the plain path reads the pane live,
  // by the seat's name.
  const found: Found = to.pane !== null ? { ok: true, pane: to.pane } : findAgent(host, to.session, to.seat);
  if (!found.ok) {
    if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, to.seat, found.reason, host, report);
  }
  if (isBareShellPane(to.dir, to.session, to.seat, host.processInfo(to.session, found.pane))) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, to.seat, 'the seat is back at its shell; nothing was typed', host, report);
  }
  report.sent = msgId;
  return deliverNative(io, to.dir, to.root, who, from, to.project, to.session, to.seat, to.cli, found.pane, dropDir, msgId, body, trigger, host, report);
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
): number {
  report.sent = res.id;
  if (res.outcome === 'delivered') return delivered(io, seatName, report);
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
 * `--wait` to a Claude Code seat. The frame is what the reply listener needs. A successful
 * write says the frame was sent on the socket: the write is not an acknowledgement that the
 * seat read it.
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
): Promise<number> {
  // One JSON line, exactly the frame the probe measured: `type:"user"`, the content, and a
  // msg_id for a reader's own correlation. No `from`: this process has no session socket, so
  // any sender address it claimed would be a claim, not a fact — the listener shows the
  // connection's verified pid instead, and a `--wait` run listens at that pid's measured path
  // (reply.ts), so the address the seat answers to is answered. JSON.stringify escapes
  // newlines and control characters, so multi-line text stays one frame; the frame is never
  // truncated.
  const msgId = randomUUID();
  const frame = `${JSON.stringify({ type: 'user', message: { role: 'user', content: body }, msg_id: msgId })}\n`;
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
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, to.seat, found.reason, host, report);
  }
  const pane = found.pane;
  const processes = host.processInfo(to.session, pane);
  if (processes === null) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, to.seat, "the pane's processes could not be read", host, report);
  }
  const socketPath = socketOf(host, processes);
  if (socketPath === null) {
    appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, to.seat, `no cross-session socket was found for its pane's processes (looked in ${host.socketsDir})`, host, report);
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
    const opened = await openReplyListener(host.socketsDir, process.pid);
    if (!opened.ok) {
      return refuse(io, dir, who, `${to.seat}: ${opened.reason}`, host, report);
    }
    const listener = opened.listener;
    try {
      const taken = await host.deliver(socketPath, frame);
      if (!taken.ok) {
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'unreachable' });
        return unreachable(io, dir, who, to.seat, taken.reason, host, report);
      }
      // The log keeps the seat and the frame's size; never the message's text, and never
      // the word delivered: the socket accepted the write, which is all this run knows.
      logLine(to.dir, 'send', who, `${to.seat}: sent on the socket (${String(frame.length)} characters)`, host.now());
      const outcome = await listener.wait(timeoutS * 1000);
      if (outcome.kind === 'answered') {
        const read = readReply(outcome.line);
        logLine(to.dir, 'send', who, `${to.seat}: answered (reply ${String(read.reply.length)} characters)`, host.now());
        appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'answered' });
        return answered(io, to.seat, read, report);
      }
      logLine(to.dir, 'send', who, `${to.seat}: timeout (sent, no reply within ${String(timeoutS)}s)`, host.now());
      appendHistory(to.project, to.root, host.home, { ts: host.now().toISOString(), from, to: to.seat, body, id: msgId, outcome: 'timeout' });
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
): Promise<number> {
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
    const record = (outcome: string): void => {
      appendHistory(project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome });
    };
    if (result.outcome === 'held') {
      record('held');
      return held(io, dir, who, seatName, `${result.reason ?? 'the composer holds text'}; ${where}`, host, report);
    }
    if (result.outcome === 'unreachable') {
      record('unreachable');
      return unreachable(io, dir, who, seatName, `${result.reason ?? 'the seat was not reached'}; ${where}`, host, report);
    }
    if (result.outcome === 'not-submitted') {
      record('not-submitted');
      return notSubmitted(io, dir, who, seatName, result, where, host, report);
    }
    logLine(dir, 'send', who, `${seatName}: delivered (drop ${String(body.length)} characters, herdr status ${result.status ?? 'working'})`, host.now());
    record('delivered');
    return delivered(io, seatName, report);
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
  const seats = loaded.team.seats.map((seat) => ({ name: seat.name, cli: seat.cli, role: seat.role, stopped: seat.stopped === true }));
  if (report.json) {
    io.stdout(document({ seat: null, status: 'listed', exit: 0, ids: { sent: null, reply: null }, seats }));
  } else if (seats.length === 0) {
    io.stdout('(no seats)\n');
  } else {
    for (const seat of seats) {
      io.stdout(`${seat.name}  ${seat.cli}  ${seat.role}${seat.stopped ? '  (stopped)' : ''}\n`);
    }
  }
  return 0; // exit: send.listed
}

/**
 * The first of the pane's processes with a socket in the sockets folder: the foreground
 * processes first (the running CLI is one of them), then the shell. The probe's socket is
 * derived from one process — the session — so more than one match is not resolved here:
 * the first is used, in that order.
 */
function socketOf(host: SendHost, processes: PaneProcesses): string | null {
  const pids = [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
  for (const pid of pids) {
    const path = join(host.socketsDir, `${String(pid)}.sock`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The caller class the caller check returned, as the log's bracket: `answer`'s own. */
function logWho(caller: Caller, team: TeamFile): string {
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

/** Why the send is admitted, and the rule that admitted it — or why it is not. */
type Admission = { ok: true; rule: string; sender: Agent | 'owner' } | { ok: false; why: string };

/**
 * The authority rule for this send: `admitSend`, over the registry's own records, default deny.
 * The sender's record is its identity — the agent id the drop file's header names — and the
 * target is the agent the spec resolved to, or, on the declared-seat path, the seat this run
 * judged against the caller's own team. A side the store holds no record for has no identity to
 * admit by and is refused; `up` and `add` register a seat the first time they launch it. The
 * team's record comes from the live file this run judged, which is the seed the registry
 * projects; a registered team's own record joins it when addressing crosses teams.
 */
function admissionOf(caller: Caller, team: TeamFile, target: Target | null, seatName: string, home: string): Admission {
  if (caller.kind === 'owner') return { ok: true, rule: 'the owner', sender: 'owner' };
  const sender = recordFor(home, team.session, caller.kind === 'seat' ? caller.name : '');
  if (sender === null) {
    return {
      ok: false,
      why: `${describeCaller(caller)}: no agent record on this machine, so no rule admits the send (${RULE_SUMMARY})`,
    };
  }
  // The target the rules judge: the resolved agent's own record when the registry answered the
  // spec — it names the team a cross-team send lands in — else the seat the caller's team was
  // asked for, as the declared-seat path always had it.
  const judged: SendSide = target === null ? { seat: seatName, team: sender.reach.team } : target.agent;
  const verdict = admitSend(sender, judged, admitRecordsOf(home, team, sender.reach.team));
  if (!verdict.ok) return { ok: false, why: verdict.why };
  return { ok: true, rule: verdict.rule, sender };
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
 *  which is the seed the registry projects. The file's project, entity and lead, with the roster
 *  the store holds for that team and the file's own seats behind it. */
function admitRecordsOf(home: string, team: TeamFile, teamId: string): AdmitTeams {
  const roster: AdmitTeam['roster'] = [];
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired' || agent.reach.team !== teamId) continue;
    roster.push({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role });
  }
  for (const seat of team.seats) {
    if (!roster.some((entry) => entry.seat === seat.name)) roster.push({ agent: '', seat: seat.name, role: seat.role });
  }
  return {
    ...readTeams(home),
    [teamId]: { project: team.project, entity: team.entity, orchestrator: team.orchestrator, roster },
  };
}

function seatList(team: TeamFile): string {
  const names = team.seats.map((seat) => seat.name);
  return names.length === 0 ? '(none)' : names.join(', ');
}

/** Herdr reported the seat took the trigger, and the pane was not a known dialog. Exit 0, always. */
function delivered(io: Io, seat: string, report: Report): number {
  if (report.json) {
    io.stdout(document({ seat, status: 'delivered', exit: 0, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stdout(`${seat}: delivered\n`);
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

/** The message is on disk, and the pane was left untouched. Exit 1, always. */
function held(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost, report: Report): number {
  logLine(dir, 'send', who, `${seat}: held: ${reason}`, host.now());
  if (report.json) {
    io.stdout(document({ seat, status: 'held', exit: 1, error: reason, ids: { sent: report.sent, reply: null } }));
  } else {
    io.stderr(`team send: ${seat}: held: ${reason}\n`);
  }
  return 1; // exit: send.held
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
