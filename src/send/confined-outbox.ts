// A seat its sandbox confines (src/placement/confined.ts) can read and acknowledge its own mail,
// but a send or a reply writes outside its own folders: the recipient's drop folder and seat
// lock. Its sandbox refuses those writes, and widening the sandbox would give the seat other
// seats' mail. So the confined seat's `team send` and `team reply` write the request into an
// outbox inside its own seat-state folder, which only its own sandbox grants, and the team's
// watch, which runs outside every sandbox, runs that same command for it, as that seat, and
// writes the result back beside the request. The seat's command waits for the result and prints
// it, so the seat sees what it would have seen.
//
// What stands for the seat's identity on the watch's side:
//   - the request sits in that seat's own outbox, a real folder (no link) under the real
//     `.agents`, created by this user, a regular file of this user, not a link, at most 256 KiB;
//   - the request names the seat, session and pane its outbox belongs to, and the team's state
//     records the seat at that pane; when the terminal host answers, the pane is not listed
//     under another seat's name and the seat is not listed on another pane;
//   - the request is younger than ten minutes.
// The run is the ordinary command with its ordinary admission: the relay changes who wrote the
// files, never what the seat may send. This guards against a mistaken agent, as placement does:
// every seat runs as the owner's user.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerAncestors, callerOf } from '../caller.ts';
import { REPLY_FLAG_OPTIONS } from '../commands/reply.ts';
import { SEND_FLAG_OPTIONS, SEND_VALUED_OPTIONS } from '../commands/send.ts';
import type { Io } from '../io.ts';
import { cliHookStatePath } from '../launch/cli-hook.ts';
import { confinedSeatAt } from '../placement/confined.ts';

export type OutboxCommand = 'send' | 'reply';

export type OutboxRequest = {
  v: 1;
  id: string;
  command: OutboxCommand;
  argv: string[];
  cwd: string;
  seat: string;
  session: string;
  pane: string;
  at: string;
};

export type OutboxResult = { id: string; code: number; out: string; err: string; at: string };

const REQUEST_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.request\.json$/;
const RESULT_SUFFIX = '.result.json';
const MAX_REQUEST_BYTES = 256 * 1024;
export const REQUEST_MAX_AGE_MS = 10 * 60_000;
/** How long the seat's own command waits for the watch to run its request. */
export const RELAY_WAIT_MS = 45_000;
/** Results nobody collected are removed after a day. */
const RESULT_KEEP_MS = 24 * 60 * 60_000;

/** The seat's outbox: `outbox/` in the seat-state folder its launch grants. Null when the session
 *  or seat name names no grant. */
export function outboxFolder(dir: string, session: string, seat: string): string | null {
  const state = cliHookStatePath(dir, session, seat);
  return state === null ? null : join(dirname(state), 'outbox');
}

/** What a relayed run may carry beyond its words: for a send, a subject, a channel, `--json`,
 *  `--dry-run` and `--list`; for a reply, `--close` and `--json`. Every other option names another
 *  principal's authority (a client grant, a key, an owner approval or request, a handoff record),
 *  a file the relay would read with more reach than the seat's own sandbox, or a wait that would
 *  hold the watch. The line is parsed with the command's own grammar, so a value that looks like
 *  an option is read exactly as the command would read it. */
const RELAY_ALLOWED: Record<OutboxCommand, { valued: readonly string[]; flags: readonly string[] }> = {
  send: { valued: ['subject', 'channel'], flags: ['json', 'dry-run', 'list'] },
  reply: { valued: [], flags: ['close', 'json'] },
};

/** Why a relayed command may not run, or null. */
export function relayRefusal(command: OutboxCommand, argv: readonly string[]): string | null {
  const grammar = command === 'send'
    ? { valued: [...SEND_VALUED_OPTIONS] as string[], flags: [...SEND_FLAG_OPTIONS] as string[] }
    : { valued: [] as string[], flags: [...REPLY_FLAG_OPTIONS] as string[] };
  const args = readArgs([...argv], grammar.valued, grammar.flags);
  if (args.error !== undefined) return `its line does not read (${args.error})`;
  const allowed = RELAY_ALLOWED[command];
  for (const name of Object.keys(args.values)) {
    if (!allowed.valued.includes(name)) return `--${name} is not taken from a sandboxed seat's ${command}; put the text on the command line`;
  }
  for (const name of args.flags) {
    if (!allowed.flags.includes(name)) return `--${name} is not taken from a sandboxed seat's ${command}`;
  }
  return null;
}

/** A command's first step: a caller its sandbox confines hands the command to its outbox and
 *  answers with the relayed result; null for every other caller, which runs the command itself.
 *  A caller a test or a relay hands in (`io.caller`) is never relayed. */
export async function relayIfConfined(command: OutboxCommand, argv: string[], io: Io): Promise<number | null> {
  if (io.caller !== undefined) return null;
  // Only a caller whose parent walk cannot be read can be confined: every other caller keeps the
  // placement its command makes, read once, by the command itself.
  const ancestors = callerAncestors(io);
  if (ancestors !== null && ancestors.length > 0) return null;
  const caller = callerOf(io);
  if (caller.kind !== 'seat' || caller.confined !== true) return null;
  const seat = confinedSeatAt(io.cwd, caller.pane, caller.session);
  if (seat === null) return null;
  const refused = relayRefusal(command, argv);
  if (refused !== null) {
    io.stderr(`team ${command}: ${refused}; nothing was sent\n`);
    return 2;
  }
  return relayThroughOutbox({
    command,
    argv,
    cwd: io.cwd,
    dir: seat.dir,
    seat: seat.name,
    session: seat.session,
    pane: caller.pane,
    stdout: io.stdout,
    stderr: io.stderr,
  });
}

/** The confined seat's side: writes the request, waits for its result, prints it. */
export async function relayThroughOutbox(input: {
  command: OutboxCommand;
  argv: string[];
  cwd: string;
  dir: string;
  seat: string;
  session: string;
  pane: string;
  stdout(text: string): void;
  stderr(text: string): void;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): Promise<number> {
  const folder = outboxFolder(input.dir, input.session, input.seat);
  const say = (text: string) => input.stderr(`team ${input.command}: ${text}\n`);
  if (folder === null) {
    say(`${input.seat} runs in a sandbox and its outbox can't be named; nothing was sent`);
    return 1;
  }
  const now = input.now ?? (() => new Date());
  const id = randomUUID();
  const request: OutboxRequest = {
    v: 1, id, command: input.command, argv: input.argv, cwd: input.cwd,
    seat: input.seat, session: input.session, pane: input.pane, at: now().toISOString(),
  };
  const text = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
    say('the message is larger than 256 KiB, more than a sandboxed seat may relay; nothing was sent');
    return 1;
  }
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temp = join(folder, `.${id}.tmp`);
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, join(folder, `${id}.request.json`));
  } catch (error) {
    say(`${input.seat} runs in a sandbox and its outbox could not be written (${(error as Error).message}); nothing was sent`);
    return 1;
  }
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (input.waitMs ?? RELAY_WAIT_MS);
  const resultPath = join(folder, `${id}${RESULT_SUFFIX}`);
  for (;;) {
    const result = readResult(resultPath, id);
    if (result !== null) {
      if (result.out !== '') input.stdout(result.out);
      if (result.err !== '') input.stderr(result.err);
      try { unlinkSync(resultPath); } catch { /* the watch removes it after a day */ }
      return result.code;
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  say(`queued in ${input.seat}'s outbox (id ${id}): the team's watch runs it on its next pass; its result is written to ${resultPath}`);
  return 0;
}

function readResult(path: string, id: string): OutboxResult | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OutboxResult>;
    if (parsed.id !== id || typeof parsed.code !== 'number') return null;
    return { id, code: parsed.code, out: String(parsed.out ?? ''), err: String(parsed.err ?? ''), at: String(parsed.at ?? '') };
  } catch {
    return null;
  }
}

export type RelayCaller = { kind: 'seat'; name: string; pane: string; session: string };

export type RelaySources = {
  /** The pane the team's state records for a seat in this session, or undefined. */
  recordedPane(seat: string): string | undefined;
  /** The terminal host's agent list for the session, or null when it does not answer. */
  agents(): { name: string | null; pane: string }[] | null;
  /** Runs the seat's command as that seat; returns what it said. */
  run(command: OutboxCommand, argv: string[], cwd: string, caller: RelayCaller): Promise<{ code: number; out: string; err: string }>;
  now(): Date;
  log(line: string): void;
};

/** The most requests one pass runs, across every seat: the rest wait for the next pass. */
export const RELAY_PER_PASS = 3;

/** A request taken and neither answered nor finished within this long was cut off: its outcome
 *  is unknown, and the seat is told so rather than left waiting. */
const TAKEN_STALE_MS = 5 * 60_000;

/** The watch's side: runs up to `RELAY_PER_PASS` waiting requests of the named seats, oldest
 *  first. Every request ends in exactly one result: run, refused, or cut off. */
export async function relayOutboxes(dir: string, session: string, seats: readonly string[], sources: RelaySources): Promise<number> {
  let ran = 0;
  const realDir = realFolderOf(dir);
  if (realDir === null) return 0;
  for (const seat of seats) {
    const folder = outboxFolder(dir, session, seat);
    if (folder === null || !existsSync(folder)) continue;
    // The outbox must be itself, below the real `.agents`: a link cannot lend another seat's.
    if (realFolderOf(folder) !== realDir + folder.slice(dir.length)) {
      sources.log(`${seat}: the outbox is not a folder of its own; nothing was relayed`);
      continue;
    }
    const folderId = identityOf(folder);
    let names: string[];
    try {
      names = readdirSync(folder).sort();
    } catch {
      continue;
    }
    const nowMs = sources.now().getTime();
    sweepResults(folder, names, nowMs);
    recoverTaken(folder, names, nowMs, sources);
    for (const name of names) {
      if (ran >= RELAY_PER_PASS) return ran;
      const match = REQUEST_NAME.exec(name);
      if (match === null) continue;
      const id = match[1]!;
      const path = join(folder, name);
      const taking = join(folder, `${id}.taking`);
      // Taken once: a rename either moves it or another pass already has it.
      let plain: boolean;
      try {
        plain = ownRegularFile(path);
        renameSync(path, taking);
      } catch {
        continue;
      }
      const result = plain
        ? await runRequest(taking, id, seat, session, sources)
        : refusal(id, seat, sources, 'it is not a plain file of this user of at most 256 KiB');
      // The outbox must still be the folder that was checked before the run.
      if (identityOf(folder) !== folderId) {
        sources.log(`${seat}: the outbox changed while request ${id} ran; its result was not written`);
        return ran + 1;
      }
      publishResult(folder, id, result, seat, sources);
      try { unlinkSync(taking); } catch { /* removed with the results */ }
      ran += 1;
    }
  }
  return ran;
}

function refusal(id: string, seat: string, sources: Pick<RelaySources, 'log' | 'now'>, why: string): OutboxResult {
  sources.log(`${seat}: outbox request ${id} refused: ${why}`);
  return { id, code: 1, out: '', err: `team: the relay refused this request: ${why}\n`, at: sources.now().toISOString() };
}

/** Writes a result beside its request: a new temporary file (never one already there, never
 *  through a link), then a rename into place. */
function publishResult(folder: string, id: string, result: OutboxResult, seat: string, sources: Pick<RelaySources, 'log'>): void {
  const temp = join(folder, `.${id}.result.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, join(folder, `${id}${RESULT_SUFFIX}`));
  } catch (error) {
    sources.log(`${seat}: the result of outbox request ${id} could not be written (${(error as Error).message})`);
  }
}

/** A request taken by a pass that never finished it: the seat gets a result that says so. */
function recoverTaken(folder: string, names: readonly string[], nowMs: number, sources: RelaySources): void {
  for (const name of names) {
    if (!name.endsWith('.taking')) continue;
    const id = name.slice(0, -'.taking'.length);
    if (!/^[0-9a-f-]{36}$/.test(id) || names.includes(`${id}${RESULT_SUFFIX}`)) continue;
    const path = join(folder, name);
    try {
      if (nowMs - lstatSync(path).mtimeMs < TAKEN_STALE_MS) continue;
    } catch {
      continue;
    }
    sources.log(`outbox request ${id} was cut off while it ran; its outcome is unknown`);
    publishResult(folder, id, {
      id,
      code: 1,
      out: '',
      err: 'team: the relay stopped while running this request; whether it was sent is unknown — check before sending again\n',
      at: new Date(nowMs).toISOString(),
    }, id, sources);
    try { unlinkSync(path); } catch { /* the sweep removes it */ }
  }
}

function identityOf(folder: string): string | null {
  try {
    const stat = lstatSync(folder);
    return stat.isDirectory() ? `${String(stat.dev)}:${String(stat.ino)}` : null;
  } catch {
    return null;
  }
}

async function runRequest(path: string, id: string, seat: string, session: string, sources: RelaySources): Promise<OutboxResult> {
  try {
    return await checkedRun(path, id, seat, session, sources);
  } catch (error) {
    return refusal(id, seat, sources, `it could not be run (${(error as Error).message})`);
  }
}

async function checkedRun(path: string, id: string, seat: string, session: string, sources: RelaySources): Promise<OutboxResult> {
  const at = sources.now();
  const refuse = (why: string): OutboxResult => refusal(id, seat, sources, why);
  let request: OutboxRequest;
  try {
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return refuse('it is larger than 256 KiB');
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('it is not a request this build reads');
    request = parsed as OutboxRequest;
  } catch {
    return refuse('it is not a request this build reads');
  }
  if (request.v !== 1 || request.id !== id) return refuse('it is not a request this build reads');
  if (request.command !== 'send' && request.command !== 'reply') return refuse('it names no send or reply');
  if (!Array.isArray(request.argv) || !request.argv.every((word) => typeof word === 'string')) return refuse('its words are not text');
  const optionRefusal = relayRefusal(request.command, request.argv);
  if (optionRefusal !== null) return refuse(optionRefusal);
  if (request.seat !== seat || request.session !== session) return refuse('it names another seat or session than its outbox');
  const written = Date.parse(request.at);
  if (!Number.isFinite(written) || at.getTime() - written > REQUEST_MAX_AGE_MS || written - at.getTime() > 60_000) {
    return refuse('it is older than ten minutes');
  }
  if (typeof request.pane !== 'string' || request.pane === '' || sources.recordedPane(seat) !== request.pane) {
    return refuse('the team does not record the seat at the pane it names');
  }
  const agents = sources.agents();
  if (agents !== null) {
    const listed = agents.find((agent) => agent.pane === request.pane);
    if (listed !== undefined && listed.name && listed.name !== seat) return refuse('the pane belongs to another seat');
    if (agents.some((agent) => agent.name === seat && agent.pane !== request.pane)) return refuse('the seat runs in another pane');
  }
  let cwd = typeof request.cwd === 'string' ? request.cwd : '';
  try {
    if (cwd === '' || !lstatSync(cwd).isDirectory()) cwd = '';
  } catch {
    cwd = '';
  }
  if (cwd === '') return refuse('its working folder is not a folder');
  const ran = await sources.run(request.command, request.argv, cwd, { kind: 'seat', name: seat, pane: request.pane, session });
  sources.log(`${seat}: outbox request ${id} (${request.command}) ran, exit ${String(ran.code)}`);
  return { id, code: ran.code, out: ran.out, err: ran.err, at: at.toISOString() };
}

function ownRegularFile(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return false;
  const mine = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  return stat.isFile() && mine && stat.size <= MAX_REQUEST_BYTES;
}

function realFolderOf(folder: string): string | null {
  try {
    if (!lstatSync(folder).isDirectory()) return null;
    return realpathSync(folder);
  } catch {
    return null;
  }
}

function sweepResults(folder: string, names: readonly string[], nowMs: number): void {
  for (const name of names) {
    if (!name.endsWith(RESULT_SUFFIX) && !name.endsWith('.taking')) continue;
    const path = join(folder, name);
    try {
      if (nowMs - lstatSync(path).mtimeMs > RESULT_KEEP_MS) unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
}
