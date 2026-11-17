// `team ping`: the comms test as a command. One message to the seat named (or, with `--all`, to
// every seat of the caller's own team), each asking the seat to answer it with `team reply`, then
// one row per seat with the stage times: how long the send took and which leg took it, when the
// seat's signed read receipt landed (the message reached its session), when the seat sent its
// reply (the agent acted on it) and when that reply landed in the caller's folder.
//
// Every message is an ordinary `team send`, run as this same program in the caller's own folder
// and environment: admission, signing and delivery are exactly the ones a send has, and a refused
// send is a row with its refusal, never a route around it. A seat of another team is named as
// `<seat>@<team>`; the rules decide whether this caller may reach it. The answer is a
// `team reply` on the message's own thread, admitted by the reply's own rule, never by this
// command.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { readTeams } from '../registry/teams.ts';

export const USAGE = `Usage: team ping <seat> [--wait <seconds>] [--json]
       team ping --all [--wait <seconds>] [--json]

Sends the seat named (<seat>, or <seat>@<team> for a seat of another team), or
with --all every seat of the caller's own team, one message asking it to answer
with team reply, then waits up to --wait seconds (default 120). One row per
seat: the leg that took the send and how long the send took, when its read
receipt landed, when its reply was sent and when it landed; or why the send was
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
  /** Milliseconds from the start of this seat's send to its read receipt; null when none came. */
  read_ms: number | null;
  /** From the same start to the reply's own signed `at`: when the seat sent it. */
  reply_sent_ms: number | null;
  /** From the same start to the reply record landing in the caller's folder. */
  reply_landed_ms: number | null;
  status: 'replied' | 'read' | 'not read' | 'refused';
};

export type PingHost = {
  home: string;
  now: () => number;
  /** Runs `team <args>` in `cwd` and answers its exit code and output. */
  team: (args: string[], io: Io) => Promise<{ code: number; out: string }>;
  wait: (ms: number) => Promise<void>;
};

function runSelf(args: string[], io: Io): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1]!, ...args], {
      cwd: io.cwd,
      env: io.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
    child.on('error', (error) => resolve({ code: 1, out: error.message }));
  });
}

export const realHost: PingHost = {
  home: homedir(),
  now: () => Date.now(),
  team: runSelf,
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

/** The folder holding `.agents/team.yaml`, from `cwd` up; null when none does. */
function teamRootOf(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.agents', 'team.yaml'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Where the target's records land: its team's root and session. `seat@team` names the team by
 *  its session, its name or its id; a plain seat is the caller's own team. */
function placeOf(home: string, target: string, own: { root: string; session: string } | null): { seat: string; team: string | null; root: string; session: string } | null {
  const at = target.lastIndexOf('@');
  if (at < 0) return own === null ? null : { seat: target, team: null, ...own };
  const seat = target.slice(0, at);
  const name = target.slice(at + 1);
  let teams;
  try {
    teams = readTeams(home);
  } catch {
    return null;
  }
  const hits = Object.entries(teams).filter(([id, team]) => id === name || team.session === name || team.project === name);
  if (hits.length !== 1) return null;
  const [, team] = hits[0]!;
  return { seat, team: name, root: team.root, session: team.session };
}

/** When the seat's read receipt for `id` was written (its signed `at`, else the file's time), in
 *  epoch milliseconds; null while there is none. */
export function receiptAt(root: string, session: string, seat: string, id: string): number | null {
  const path = join(root, '.agents', 'send-drops', session, seat, `${id}.read.json`);
  try {
    const at = (JSON.parse(readFileSync(path, 'utf8')) as { payload?: { at?: unknown } }).payload?.at;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return Date.parse(at);
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Replies on the thread of each id, found among the records in `<root>/.agents/send-drops/
 *  <session>/*` newer than `since`: the reply's signed `at` (sent) and the file's time (landed). */
export function repliesTo(root: string, session: string, ids: ReadonlySet<string>, since: number): Map<string, { sent: number; landed: number }> {
  const found = new Map<string, { sent: number; landed: number }>();
  const base = join(root, '.agents', 'send-drops', session);
  let seats: string[];
  try {
    seats = readdirSync(base);
  } catch {
    return found;
  }
  for (const seat of seats) {
    let names: string[];
    try {
      names = readdirSync(join(base, seat));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes('.')) continue;
      const path = join(base, seat, name);
      try {
        const landed = statSync(path).mtimeMs;
        if (landed < since) continue;
        const payload = (JSON.parse(readFileSync(path, 'utf8')) as { payload?: { thread?: unknown; id?: unknown; at?: unknown } }).payload;
        const thread = payload?.thread;
        if (typeof thread !== 'string' || !ids.has(thread) || payload?.id === thread || found.has(thread)) continue;
        const sent = typeof payload?.at === 'string' ? Date.parse(payload.at) : Number.NaN;
        found.set(thread, { sent: Number.isNaN(sent) ? landed : sent, landed });
      } catch {
        continue;
      }
    }
  }
  return found;
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

  const root = teamRootOf(io.cwd);
  let session: string | null = null;
  let targets = args.rest;
  const seats = await host.team(['seats', '--json'], io);
  try {
    const doc = JSON.parse(seats.out) as { session?: unknown; seats?: { name?: unknown }[] };
    if (typeof doc.session === 'string') session = doc.session;
    if (all) targets = (doc.seats ?? []).map((seat) => seat.name).filter((name): name is string => typeof name === 'string');
  } catch {
    if (all) {
      refuse(io, json, 'ping', { id: 'ping.usage', message: 'the seats of this team could not be read (team seats --json)', repair: 'run team ping from a team folder', usage: USAGE });
      return 2; // exit: ping.usage
    }
  }
  const own = root !== null && session !== null ? { root, session } : null;

  const token = `P${host.now().toString(36)}`;
  const rows = await Promise.all(targets.map(async (target): Promise<PingRow & { place: ReturnType<typeof placeOf>; started: number }> => {
    const place = placeOf(host.home, target, own);
    const started = host.now();
    const body = `ping ${token}: answer now with team reply and the id on this message's reader line, text: pong ${token}. Nothing else.`;
    const sent = await host.team(['send', target, body], io);
    const outcome = sent.out.trim().split('\n').filter(Boolean).pop() ?? '';
    const id = sent.code === 0 || idOf(outcome) !== null ? idOf(outcome) : null;
    return {
      seat: place?.seat ?? target,
      team: place?.team ?? null,
      id,
      outcome,
      leg: id === null ? null : legOf(outcome),
      send_ms: host.now() - started,
      read_ms: null,
      reply_sent_ms: null,
      reply_landed_ms: null,
      status: id === null ? 'refused' : 'not read',
      place,
      started,
    };
  }));

  const deadline = host.now() + waitSeconds * 1000;
  const since = Math.min(...rows.map((row) => row.started), host.now()) - 1000;
  for (;;) {
    for (const row of rows) {
      if (row.read_ms !== null || row.id === null || row.place === null) continue;
      const at = receiptAt(row.place.root, row.place.session, row.place.seat, row.id);
      if (at !== null) {
        row.read_ms = Math.max(0, at - row.started);
        if (row.status === 'not read') row.status = 'read';
      }
    }
    const waiting = new Set(rows.filter((row) => row.id !== null && row.status !== 'replied').map((row) => row.id!));
    if (own !== null && waiting.size > 0) {
      const replies = repliesTo(own.root, own.session, waiting, since);
      for (const row of rows) {
        const reply = row.id === null ? undefined : replies.get(row.id);
        if (reply === undefined) continue;
        row.reply_sent_ms = Math.max(0, reply.sent - row.started);
        row.reply_landed_ms = Math.max(0, reply.landed - row.started);
        row.status = 'replied';
      }
    }
    if (rows.every((row) => row.status === 'replied' || row.status === 'refused') || host.now() >= deadline) break;
    await host.wait(250);
  }

  const out: PingRow[] = rows.map(({ place: _place, started: _started, ...row }) => row);
  const ok = out.length > 0 && out.every((row) => row.status === 'replied');
  if (json) {
    writeJson(io, 'team.ping', { token, wait_seconds: waitSeconds, rows: out, all_replied: ok });
  } else {
    for (const row of out) {
      const name = row.team === null ? row.seat : `${row.seat}@${row.team}`;
      const sent = `send ${(row.send_ms / 1000).toFixed(1)} s${row.leg === null ? '' : ` (${row.leg})`}`;
      const secs = (ms: number | null) => `${((ms ?? 0) / 1000).toFixed(1)} s`;
      const read = row.read_ms === null ? 'no read receipt' : `read ${secs(row.read_ms)}`;
      const tail = row.status === 'replied'
        ? `${read}; reply sent ${secs(row.reply_sent_ms)}, landed ${secs(row.reply_landed_ms)}`
        : row.status === 'refused'
          ? `refused: ${row.outcome.replace(/^team send: /, '')}`
          : `${read}; no reply within ${String(waitSeconds)} s (${row.outcome})`;
      io.stdout(`${name}: ${sent}; ${tail}\n`);
    }
  }
  if (ok) return 0; // exit: ping.replied
  return 1; // exit: ping.unanswered
}
