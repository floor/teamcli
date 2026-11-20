// `team ping`: the comms test as a command. One message to the seat named (or, with `--all`, to
// every seat of the caller's own team), each asking the seat to answer it with `team reply`, then
// one row per seat with the stage times: how long the send took and which leg took it, when a
// carrier's signed delivered receipt landed (its transport took the body), when the seat's own
// signed read receipt landed (the seat saw the body), when the seat sent its
// reply (the agent acted on it) and when that reply landed in the caller's folder.
//
// Every message is an ordinary `team send`, run as this same program in the caller's own folder
// and environment, with the caller's own standard input (its terminal, when it has one: the
// owner's identity at a terminal is that terminal, and a send without it is refused): admission,
// signing and delivery are exactly the ones a send has, and a refused send is a row with its
// refusal, never a route around it. A seat of another team is named as `<seat>@<team>`; the rules
// decide whether this caller may reach it. The answer is a `team reply` on the message's own
// thread, admitted by the reply's own rule, never by this command; a seat that answers with an
// ordinary `team send` to the sender instead is counted too, the same checks without the thread.
//
// Nothing is counted that does not verify. The sent record is found by its id and verified with
// the machine's message key; its signed fields (root, session, recipient, sender and their agent
// ids) are where the receipt and the reply are looked for, not the folder the command runs in. A
// receipt counts only when its signature verifies and it names that id, recipient, root and
// session; an answer only when its record verifies, comes from the recipient to the sender (by
// name and agent id) and carries this run's token, and is a reply on that thread or a send. A
// message the owner sent is answered where `team reply` answers it: the entity's
// `owner-reply-to` endpoint.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { resolveOwnerReplyTo } from '../policy/owner-reply.ts';
import { teamBinding } from '../registry/binding.ts';
import { readTeams, type TeamRecord } from '../registry/teams.ts';
import { COPY_READ_BY, isLeadAckReadBy, sameFolder, signedReceiptOf, verifiedRecordAt, verifyReceipt, type RecordPayload } from '../send/record.ts';
import { resolveTarget } from '../send/resolve.ts';
import { messageKeyState } from '../store/keys.ts';
import { hostedCommit } from '../host/request-scope.ts';
import { seatDropDir, stampedListing } from '../queue/mail-tree.ts';
import { liveRecordPath, seatFolderOf } from '../send/drop-folder.ts';

export const USAGE = `Usage: team ping <seat> [--wait <seconds>] [--json]
       team ping --all [--wait <seconds>] [--json]

Sends the seat named (<seat>, or <seat>@<team> for a seat of another team), or
with --all every seat of the caller's own team, one message asking it to answer
with team reply on the message's id (an answer by team send counts too), then
waits up to --wait seconds (default 120). One row per
seat: the leg that took the send and how long the send took, when a carrier
delivered the body, when the seat's own read receipt landed, when its reply was
sent and when it landed; or why the send was
refused. Each message is an ordinary team send from this folder: the same
admission, signing and delivery.

Exits 0 when every seat replied, 1 when one did not or its send was refused,
2 when the invocation can't be read.
`;

export type PingRow = {
  seat: string;
  team: string | null;
  id: string | null;
  /** The send's outcome line, as `team send` printed it. */
  outcome: string;
  /** The leg the send names: socket, channel, typed wake, read, inbox; or null. */
  leg: string | null;
  send_ms: number;
  /** Milliseconds from the start of this seat's send to its carrier's verified `delivered`
   *  receipt; null when none came. A delivery is not a read. */
  delivered_ms: number | null;
  /** Milliseconds from the start of this seat's send to the read receipt the seat itself wrote;
   *  null when none came. */
  read_ms: number | null;
  /** From the same start to the verified reply's own signed `at`: when the seat sent it. */
  reply_sent_ms: number | null;
  /** From the same start to the verified reply landing in the sender's folder. */
  reply_landed_ms: number | null;
  /** How the answer came: a `team reply` on the ping's thread, or an ordinary `team send`. */
  reply_by: 'reply' | 'send' | null;
  status: 'replied' | 'read' | 'delivered' | 'not read' | 'refused';
};

export type PingHost = {
  home: string;
  now: () => number;
  /** Runs `team <args>` in the caller's folder and answers its exit code and output. */
  team: (args: string[], io: Io) => Promise<{ code: number; out: string }>;
  wait: (ms: number) => Promise<void>;
  /** This run's own random part of the token: two runs in the same millisecond never share one.
   *  The real host draws it; a test pins it. */
  nonce?: () => string;
};

/** Runs `program args` with the caller's folder, environment and standard input, its output
 *  captured. Standard input is inherited, never replaced: a terminal stays the terminal it is. */
export function runChild(program: readonly string[], args: string[], io: Io): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    hostedCommit('node:child_process.spawn');
    const child = spawn(program[0]!, [...program.slice(1), ...args], {
      cwd: io.cwd,
      env: io.env as NodeJS.ProcessEnv,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
    child.on('error', (error) => resolve({ code: 1, out: error.message }));
  });
}

export const realHost: PingHost = {
  home: homedir(),
  now: () => Date.now(),
  team: (args, io) => runChild([process.execPath, process.argv[1]!], args, io),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const ping: Command = (argv, io) => runPing(argv, io, realHost);
export default ping;

/** The leg a send's outcome line names, or null. */
export function legOf(outcome: string): string | null {
  const match = /: delivered \(([^);,]+)/.exec(outcome);
  if (match) return match[1]!.replace(/ \d+ ms$/, '').trim();
  if (/kept in [^ ]+ inbox/.test(outcome)) return 'inbox';
  return null;
}

/** The record id a send's outcome line names, or null. */
export function idOf(outcome: string): string | null {
  return /\bid ([0-9a-f-]{36})\b/.exec(outcome)?.[1] ?? null;
}

type Place = { root: string; session: string };

/** Every place a record of this machine can sit: the registered teams, and the team the caller's
 *  folder resolves to through the configuration seam a send uses (registry first, the team file
 *  only when the registry holds none). */
function placesOf(home: string, io: Io): { places: Place[]; teams: TeamRecord[] } {
  let teams: TeamRecord[] = [];
  try {
    teams = Object.values(readTeams(home));
  } catch {
    teams = [];
  }
  const places: Place[] = teams.map((team) => ({ root: team.root, session: team.session }));
  try {
    const loaded = readTeamConfig(io.cwd, { home });
    if (loaded.ok) places.push({ root: loaded.root, session: loaded.team.session });
  } catch {
    // A folder that is no team adds no place.
  }
  return { places, teams };
}

/** The sent record `id` for `seat`, found among the places and verified with the message key:
 *  its own signed fields must name that id, that recipient and the folder it sits in. */
export function sentRecordOf(places: readonly Place[], seat: string, id: string, key: KeyObject): RecordPayload | null {
  for (const place of places) {
    const payload = verifiedRecordAt(liveRecordPath(seatDropDir(place.root, place.session, seat), id), id, key);
    if (payload === null) continue;
    if (payload.id !== id || payload.to !== seat || payload.session !== place.session || !sameFolder(payload.root, place.root)) continue;
    return payload;
  }
  return null;
}

/** When the recipient's verified receipt of `status` for `sent` was written, in epoch
 *  milliseconds; null while there is none that verifies and names that record, recipient, root
 *  and session. */
function signedReceiptAt(sent: RecordPayload, key: KeyObject, status: 'read' | 'delivered'): { at: number; readBy: string | undefined; status: string } | null {
  const path = join(seatFolderOf(seatDropDir(sent.root, sent.session, sent.to), sent.id), `${sent.id}.${status}.json`);
  let receipt;
  try {
    receipt = signedReceiptOf(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
  if (receipt === null || !verifyReceipt(receipt, key)) return null;
  const at = receipt.payload;
  if (at.id !== sent.id || at.to !== sent.to || at.session !== sent.session || !sameFolder(at.root, sent.root)) return null;
  const when = Date.parse(at.at);
  return Number.isNaN(when) ? null : { at: when, readBy: at.read_by, status: at.status };
}

/** When the recipient's verified read receipt for `sent` was written, in epoch milliseconds;
 *  null while there is none that verifies and names that record, recipient, root and session.
 *  Only a read the seat made counts: a writer-side copy (`read_by: copy`) and a lead's or the
 *  owner's clearance (`lead-ack:`) are not the seat seeing the body. */
export function receiptAt(sent: RecordPayload, key: KeyObject): number | null {
  const read = signedReceiptAt(sent, key, 'read');
  if (read === null || (read.status !== 'read' && read.status !== 'replied')) return null;
  if (read.readBy === COPY_READ_BY || isLeadAckReadBy(read.readBy)) return null;
  return read.at;
}

/** When a carrier handed the body over (the signed `delivered` receipt a socket, a runtime queue,
 *  a typed wake or a channel push writes), in epoch milliseconds; null when none verifies. A
 *  delivery is not a read: the seat may be mid-turn, or its runtime may hold the body unseen. */
export function deliveredAt(sent: RecordPayload, key: KeyObject): number | null {
  const delivered = signedReceiptAt(sent, key, 'delivered');
  return delivered === null || delivered.status !== 'delivered' ? null : delivered.at;
}

/** Where the recipient's reply to `sent` lands and whom it must name: the folder and the
 *  recipient identity (seat and agent id) a `team reply` writes it for. */
export type ReplyDestination = { folder: string; to: string; to_id: string | null };

/** The reply destination of `sent`, resolved the way `team reply` resolves it. A record the owner
 *  sent is answered at the entity's `owner-reply-to` endpoint (read from the recipient team's
 *  entity, resolved through the registry, across teams): that seat's folder, that seat and its
 *  agent id. A seat's record is answered in its own folder: its team found by the sender's
 *  signed agent id in a registered roster, else the team the caller's folder binds to, else the
 *  folder's own configuration. Null when none places it. */
export function replyDestinationOf(home: string, io: Io, sent: RecordPayload, teams: readonly TeamRecord[]): ReplyDestination | null {
  if (sent.from === 'owner') {
    // The recipient team's entity: its configuration's, else its registry record's (a team the
    // registry alone defines has no file to name it).
    let entity: string | null = null;
    try {
      const loaded = readTeamConfig(sent.root, { home });
      if (loaded.ok) entity = loaded.team.entity ?? null;
    } catch {
      entity = null;
    }
    if (entity === null) {
      const held = teams.filter((team) => sameFolder(team.root, sent.root) && team.session === sent.session);
      if (held.length === 1) entity = held[0]!.entity ?? null;
    }
    const replyTo = resolveOwnerReplyTo(sent.root, home, entity);
    if (!replyTo.ok) return null;
    const endpoint = resolveTarget(home, replyTo.target, io);
    if ('error' in endpoint) return null;
    const seat = endpoint.agent.reach.seat;
    return { folder: seatDropDir(endpoint.team.root, endpoint.agent.reach.session, seat), to: seat, to_id: endpoint.agent.id };
  }
  const byId = sent.from_id === null ? [] : teams.filter((team) => team.roster.some((entry) => entry.agent === sent.from_id));
  let place: Place | null = byId.length === 1 ? { root: byId[0]!.root, session: byId[0]!.session } : null;
  if (place === null) {
    const bound = teamBinding(home, io.cwd, sent.from, io);
    if (bound.kind === 'bound') place = { root: bound.team.root, session: bound.team.session };
  }
  if (place === null) {
    try {
      const loaded = readTeamConfig(io.cwd, { home });
      if (loaded.ok) place = { root: loaded.root, session: loaded.team.session };
    } catch {
      place = null;
    }
  }
  return place === null ? null : { folder: seatDropDir(place.root, place.session, sent.from), to: sent.from, to_id: sent.from_id };
}

/** The recipient's verified answer to `sent` at its destination, newer than `since`: a record
 *  that verifies, comes from its recipient (name and agent id) to the destination's recipient
 *  (name and agent id) and carries `pong <token>`. On the sent record's thread it is a reply;
 *  a standalone record on a thread of its own, an ordinary send (a seat that answered with `team
 *  send`); a reply on another thread does not count. Either answer is
 *  the seat acting on the ping, and its identity checks are the same. In one look a reply wins.
 *  Its signed `at` (sent), the file's time (landed) and how it came, or null. */
export function replyTo(destination: ReplyDestination, sent: RecordPayload, token: string, since: number, key: KeyObject): { sent: number; landed: number; by: 'reply' | 'send' } | null {
  const folder = destination.folder;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return null;
  }
  let bySend: { sent: number; landed: number; by: 'send' } | null = null;
  // E7b revision 3: the seat's stamped folder is read with it (src/queue/mail-tree.ts).
  const stamped = stampedListing(folder);
  const seatFolders = [{ folder: folder, names: names }, ...(stamped === null || stamped === 'unreadable' ? [] : [stamped])];
  for (const { folder: folder, names: names } of seatFolders) {
    for (const name of names) {
      if (name.includes('.') || name === sent.id) continue;
      const path = join(folder, name);
      let landed: number;
      try {
        landed = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (landed < since) continue;
      const reply = verifiedRecordAt(path, name, key);
      if (reply === null) continue;
      if (reply.from !== sent.to || reply.to !== destination.to) continue;
      if (sent.to_id !== null && reply.from_id !== sent.to_id) continue;
      if (destination.to_id !== null && reply.to_id !== destination.to_id) continue;
      if (!reply.body.includes(`pong ${token}`)) continue;
      const at = Date.parse(reply.at);
      const answer = { sent: Number.isNaN(at) ? landed : at, landed };
      if (reply.thread === sent.thread) return { ...answer, by: 'reply' };
      // Off the thread, only a standalone send counts: a record that opens its own thread and
      // answers no record. A reply on some other thread is an answer to that thread, not this ping.
      if (bySend === null && reply.thread === reply.id && reply.in_reply_to === undefined) bySend = { ...answer, by: 'send' };
    }
  }
  return bySend;
}

export async function runPing(argv: string[], io: Io, host: PingHost): Promise<number> {
  const json = hasJsonFlag(argv, ['wait']);
  const args = readArgs(argv, ['wait'], ['all', 'json']);
  if (args.error !== undefined) {
    refuse(io, json, 'ping', { id: 'ping.usage', message: args.error, repair: null, usage: USAGE });
    return 2; // exit: ping.usage
  }
  const all = args.flags.has('all');
  if (all === (args.rest.length > 0) || args.rest.length > 1) {
    refuse(io, json, 'ping', { id: 'ping.usage', message: 'name one seat to ping, or --all', repair: null, usage: USAGE });
    return 2; // exit: ping.usage
  }
  const waitText = args.values.wait ?? '120';
  const waitSeconds = Number(waitText);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
    refuse(io, json, 'ping', { id: 'ping.usage', message: `--wait takes 0 to 3600 seconds, not ${waitText}`, repair: null, usage: USAGE });
    return 2; // exit: ping.usage
  }

  let targets = args.rest;
  if (all) {
    const seats = await host.team(['seats', '--json'], io);
    try {
      const doc = JSON.parse(seats.out) as { seats?: { name?: unknown }[] };
      targets = (doc.seats ?? []).map((seat) => seat.name).filter((name): name is string => typeof name === 'string');
    } catch {
      refuse(io, json, 'ping', { id: 'ping.usage', message: 'the seats of this team could not be read (team seats --json)', repair: 'run team ping from a team folder', usage: USAGE });
      return 2; // exit: ping.usage
    }
  }
  // The key is read when there is something to verify: the sends this run makes may be the
  // first to sign on this machine, and the key exists only after the first signature.
  let key: KeyObject | null = null;
  const keyNow = (): KeyObject | null => {
    if (key === null) {
      const state = messageKeyState(host.home);
      if (state.kind === 'key') key = state.key;
    }
    return key;
  };
  const { places, teams } = placesOf(host.home, io);

  // The token is this run's own: the clock alone repeats when two runs start in the same
  // millisecond, and an answer to one would then count for the other.
  const token = `P${host.now().toString(36)}${host.nonce?.() ?? randomBytes(6).toString('hex')}`;
  type Tracked = PingRow & { started: number; sent: RecordPayload | null; destination: ReplyDestination | null };
  const rows: Tracked[] = await Promise.all(targets.map(async (target): Promise<Tracked> => {
    const at = target.lastIndexOf('@');
    const seat = at < 0 ? target : target.slice(0, at);
    const started = host.now();
    // The token is not the record's id: the answer names the id from the reader line the
    // message ends with (`↩ team reply <id> …`), never the token, which no record is named by.
    const body = `ping ${token}: answer now with: team reply <id> "pong ${token}" — <id> is this message's id, from the ↩ team reply line under it (not ${token}). Nothing else.`;
    const result = await host.team(['send', target, body], io);
    const outcome = result.out.trim().split('\n').filter(Boolean).pop() ?? '';
    const id = idOf(outcome);
    return {
      seat,
      team: at < 0 ? null : target.slice(at + 1),
      id,
      outcome,
      leg: id === null ? null : legOf(outcome),
      send_ms: host.now() - started,
      delivered_ms: null,
      read_ms: null,
      reply_sent_ms: null,
      reply_landed_ms: null,
      reply_by: null,
      status: id === null ? 'refused' : 'not read',
      started,
      sent: null,
      destination: null,
    };
  }));

  const deadline = host.now() + waitSeconds * 1000;
  const since = Math.min(...rows.map((row) => row.started), host.now()) - 1000;
  for (;;) {
    const key = keyNow();
    for (const row of rows) {
      if (row.id === null || key === null || row.status === 'replied') continue;
      if (row.sent === null) {
        row.sent = sentRecordOf(places, row.seat, row.id, key);
        if (row.sent === null) continue;
        row.destination = replyDestinationOf(host.home, io, row.sent, teams);
      }
      if (row.delivered_ms === null) {
        const delivered = deliveredAt(row.sent, key);
        if (delivered !== null) {
          row.delivered_ms = Math.max(0, delivered - row.started);
          if (row.status === 'not read') row.status = 'delivered';
        }
      }
      if (row.read_ms === null) {
        const read = receiptAt(row.sent, key);
        if (read !== null) {
          row.read_ms = Math.max(0, read - row.started);
          row.status = 'read';
        }
      }
      const reply = row.destination === null ? null : replyTo(row.destination, row.sent, token, since, key);
      if (reply !== null) {
        row.reply_sent_ms = Math.max(0, reply.sent - row.started);
        row.reply_landed_ms = Math.max(0, reply.landed - row.started);
        row.reply_by = reply.by;
        row.status = 'replied';
      }
    }
    if (rows.every((row) => row.status === 'replied' || row.status === 'refused') || host.now() >= deadline) break;
    await host.wait(250);
  }

  const out: PingRow[] = rows.map(({ started: _started, sent: _sent, destination: _destination, ...row }) => row);
  const ok = out.length > 0 && out.every((row) => row.status === 'replied');
  if (json) {
    writeJson(io, 'team.ping', { token, wait_seconds: waitSeconds, rows: out, all_replied: ok });
  } else {
    for (const row of out) {
      const name = row.team === null ? row.seat : `${row.seat}@${row.team}`;
      const sent = `send ${(row.send_ms / 1000).toFixed(1)} s${row.leg === null ? '' : ` (${row.leg})`}`;
      const secs = (ms: number | null) => `${((ms ?? 0) / 1000).toFixed(1)} s`;
      const read = row.read_ms !== null
        ? `read ${secs(row.read_ms)}`
        : row.delivered_ms !== null
          ? `delivered ${secs(row.delivered_ms)}, not read by the seat`
          : 'no read receipt';
      const tail = row.status === 'replied'
        ? `${read}; ${row.reply_by === 'send' ? 'answer (team send, not on the thread)' : 'reply'} sent ${secs(row.reply_sent_ms)}, landed ${secs(row.reply_landed_ms)}`
        : row.status === 'refused'
          ? `refused: ${row.outcome.replace(/^team send: /, '')}`
          : `${read}; no reply within ${String(waitSeconds)} s (${row.outcome})`;
      io.stdout(`${name}: ${sent}; ${tail}\n`);
    }
  }
  if (ok) return 0; // exit: ping.replied
  return 1; // exit: ping.unanswered
}
