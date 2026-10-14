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
import { appendHistory } from '../send/history.ts';
import { dropMessage, submitTrigger, triggerLine, TRIGGER_MAX, type NativePane } from '../send/native.ts';
import { openReplyListener, readReply } from '../send/reply.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../send/uds.ts';
import { classify } from '../watch/screen.ts';

export const USAGE = `Usage: team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
       team send --list [--json]

Writes one message to one seat. A plain send writes the body whole to a drop file
(mode 0600, atomic rename) and types one short trigger line, for every seat. The body
is never typed and never split across several writes. delivered means herdr reported
the seat working — or done or blocked, changed from the status read before Enter —
after that line and Enter, and the pane is not a dialog this command already classifies
(question, permission, trust, vendor notice, provider error, rate limit). A screen that
is one of those is not reached: the kind and the drop path are named, and nothing
further is pressed. Only the owner, or the orchestrator from its own seat, may call
it; a worker seat may not. --list sends nothing: it prints the file's seats and needs
no caller check. --dry-run resolves the seat and the channel, writes no drop file, and
types nothing. It appends one line to the team log.

The outcome is one of five, and none of them is silent:
  delivered    the drop path (exit 0): herdr reported the seat working — or done or
               blocked, changed from the status read before Enter — and the pane was
               not one of the dialogs listed above
  answered     --wait to a Claude Code seat: the reply came back; the reply follows
               on stdout (exit 0)
  timeout      --wait to a Claude Code seat: the frame was sent on the socket, and no
               reply came within the window (exit 1). A seat which does not accept
               messages from other sessions holds the frame until a person lets it
               through
  unreachable  the channel did not confirm (exit 1): the session is not running, no
               live agent carries the seat's name, the pane is one of those dialogs,
               no socket took a waited frame, or the seat did not move to working
               after the trigger
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

  // The caller check mirrors `answer`'s: the owner, or the orchestrator from its own seat on
  // the pane the state records — never an arbitrary seat. It runs before the message is read
  // and before any seat is probed.
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logWho(caller, team);
  const from = caller.kind === 'seat' ? caller.name : 'owner';
  const callerProblem = callerProblemOf(caller, team, standingOf(dir, judged.session, caller));
  if (callerProblem) return refuse(io, dir, who, callerProblem, host, report);

  const configured = team.seats.find((seat) => seat.name === seatName);
  if (!configured) {
    return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host, report);
  }
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

  const dry = args.flags.has('dry-run');
  // --wait needs the socket frame, and only a Claude Code seat has that listener. Any other
  // seat is refused before a write. A dry run of that refusal still names the drop channel,
  // because nothing is written either way.
  if (wait && configured.cli !== 'claude-code' && !dry) {
    return refuse(io, dir, who, `${seatName} runs ${configured.cli}: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent`, host, report);
  }
  if (wait && configured.cli === 'claude-code') {
    return deliverSocket(io, dir, root, who, from, team, seatName, body, dry, timeoutS, host, report);
  }

  // A plain send, every seat: the body is never typed. It is written whole to a 0600 drop
  // file, and the pane gets one trigger line.
  const msgId = randomUUID();
  const dropDir = join(dir, 'send-drops', team.session, seatName);
  const dropPath = join(dropDir, msgId);
  const trigger = triggerLine(dropPath);
  if (trigger === null) {
    return refuse(io, dir, who, `${seatName}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was sent`, host, report);
  }
  if (dry) {
    return dryRun(io, dir, who, seatName, `${configured.cli} via a 0600 drop file and one trigger line; nothing was written`, host, report);
  }
  const found = findAgent(host, team.session, seatName);
  if (!found.ok) {
    if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
    appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, seatName, found.reason, host, report);
  }
  report.sent = msgId;
  return deliverNative(io, dir, root, who, from, team.project, team.session, seatName, configured.cli, found.pane, dropDir, msgId, body, trigger, host, report);
}

/**
 * `--wait` to a Claude Code seat. The frame is what the reply listener needs. A successful
 * write says the frame was sent on the socket: the write is not an acknowledgement that the
 * seat read it.
 */
async function deliverSocket(
  io: Io,
  dir: string,
  root: string,
  who: string,
  from: string,
  team: { project: string; session: string },
  seatName: string,
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
    return refuse(io, dir, who, `${seatName}: the message is too large for this channel: the frame is ${String(frame.length)} characters and the socket's measured limit is ${String(FRAME_LIMIT)}; nothing was sent`, host, report);
  }
  if (dry) {
    return dryRun(io, dir, who, seatName, 'claude-code via the cross-session socket; nothing was sent', host, report);
  }

  const found = findAgent(host, team.session, seatName);
  if (!found.ok) {
    if (found.kind === 'refused') return refuse(io, dir, who, found.reason, host, report);
    appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, seatName, found.reason, host, report);
  }
  const pane = found.pane;
  const processes = host.processInfo(team.session, pane);
  if (processes === null) {
    appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, seatName, "the pane's processes could not be read", host, report);
  }
  const socketPath = socketOf(host, processes);
  if (socketPath === null) {
    appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
    return unreachable(io, dir, who, seatName, `no cross-session socket was found for its pane's processes (looked in ${host.socketsDir})`, host, report);
  }

  // One send per seat at a time, the same lock `answer` and the launch that resumes a seat
  // take: two commands never reach one seat at once. A `--wait` send holds it until the reply
  // or the timeout — the outstanding request is the thing the lock serializes.
  const lock = acquireSeatLock(dir, team.session, seatName);
  if (!('release' in lock)) {
    return refuse(io, dir, who, `${seatName}: another command holds it (pid ${String(lock.held)}); nothing was sent`, host, report);
  }
  try {
    // The reply listener is opened before the frame is written: a seat that answers at once
    // must find it standing. A listener that cannot be opened is a refusal — nothing sent.
    const opened = await openReplyListener(host.socketsDir, process.pid);
    if (!opened.ok) {
      return refuse(io, dir, who, `${seatName}: ${opened.reason}`, host, report);
    }
    const listener = opened.listener;
    try {
      const taken = await host.deliver(socketPath, frame);
      if (!taken.ok) {
        appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
        return unreachable(io, dir, who, seatName, taken.reason, host, report);
      }
      // The log keeps the seat and the frame's size; never the message's text, and never
      // the word delivered: the socket accepted the write, which is all this run knows.
      logLine(dir, 'send', who, `${seatName}: sent on the socket (${String(frame.length)} characters)`, host.now());
      const outcome = await listener.wait(timeoutS * 1000);
      if (outcome.kind === 'answered') {
        const read = readReply(outcome.line);
        logLine(dir, 'send', who, `${seatName}: answered (reply ${String(read.reply.length)} characters)`, host.now());
        appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'answered' });
        return answered(io, seatName, read, report);
      }
      logLine(dir, 'send', who, `${seatName}: timeout (sent, no reply within ${String(timeoutS)}s)`, host.now());
      appendHistory(team.project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'timeout' });
      return timedOut(io, seatName, timeoutS, report);
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

/** Dialogs the classifier already names. A screen of one of these was not reached, and nothing further is pressed. */
const DIALOG = new Set(['question', 'permission', 'trust', 'vendor notice', 'provider error', 'rate limit']);

/** The dialog kind on this screen, or null. A missing read is not a dialog. One classification, of the last lines the classifier keeps. */
function dialogKind(cli: string, screen: string | null): string | null {
  if (screen === null) return null;
  const kind = classify(cli, screen.split('\n')).kind;
  return DIALOG.has(kind) ? kind : null;
}

/**
 * Writes the drop file under the seat lock, types the one trigger, and reports delivered only
 * when herdr's status says the seat took it and the pane is not a dialog this command already
 * classifies. The lock is held across the typing so a second send cannot append into the same
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
    // One read of the pane. It is asked before a second Enter, and again only when that
    // second Enter was never reached, so a dialog is never given another key.
    let looked = false;
    let kind: string | null = null;
    const look = (): string | null => {
      if (looked) return kind;
      looked = true;
      kind = dialogKind(cli, host.native.paneText?.(session, pane) ?? null);
      return kind;
    };
    const outcome = await submitTrigger(host.native, session, pane, trigger, () => look() !== null);
    const shown = look();
    if (shown !== null) {
      appendHistory(project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
      return unreachable(io, dir, who, seatName, `not reached; the screen reads ${shown}; the drop file is at ${path}`, host, report);
    }
    if (!outcome.ok) {
      appendHistory(project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'unreachable' });
      return unreachable(io, dir, who, seatName, `${outcome.reason}; the drop file is at ${path}`, host, report);
    }
    logLine(dir, 'send', who, `${seatName}: delivered (drop ${String(body.length)} characters, herdr status ${outcome.status})`, host.now());
    appendHistory(project, root, host.home, { ts: host.now().toISOString(), from, to: seatName, body, id: msgId, outcome: 'delivered' });
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
 * Why the caller may not send, or null. The owner; the orchestrator's seat, in the session
 * judged and on its recorded pane — the same verdict `answer` asks before it acts, with
 * `answer`'s refusal texts for the two placements it can name, and the authority rule named
 * in the rest.
 */
function callerProblemOf(caller: Caller, team: TeamFile, at?: SeatStanding): string | null {
  if (caller.kind === 'owner') return null;
  const verdict = callerVerdict(caller, team.orchestrator, at);
  if (verdict.kind === 'ok') return null;
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (caller.kind === 'unplaced') return caller.reason;
  if (caller.kind === 'pane') return `${describeCaller(caller)}: only the owner, or the orchestrator from its own seat, can send`;
  return `a seat may not send (${describeCaller(caller)}): only the owner, or the orchestrator from its own seat, can send`;
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
  ids: { sent: string | null; reply: string | null };
  seats?: SeatLine[];
}): string {
  const out: Record<string, unknown> = { seat: fields.seat, status: fields.status, exit: fields.exit };
  if (fields.reply !== undefined) out.reply = fields.reply;
  if (fields.error !== undefined) out.error = fields.error;
  out.ids = fields.ids;
  if (fields.seats !== undefined) out.seats = fields.seats;
  return `${JSON.stringify(out)}\n`;
}
