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
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { readNoFollow } from './history.ts';
import { readOwn, writeAll } from '../queue/append.ts';
import { mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from '../host/guarded-fs.ts';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerAncestors, callerOf } from '../caller.ts';
import { ACK_FLAG_OPTIONS, DROPS_FLAG_OPTIONS, DROPS_VALUED_OPTIONS, REPLY_FLAG_OPTIONS, SEND_FLAG_OPTIONS, SEND_VALUED_OPTIONS } from './command-grammar.ts';
import type { Io } from '../io.ts';
import { cliHookStatePath } from '../launch/cli-hook.ts';
import { confinedSeatAt } from '../placement/confined.ts';
import { isRecordSidecarName, recordNameOk } from './record.ts';
import { claimsOwnedBy, relayClaimOwner, settleOwnedClaim } from './read-claim.ts';

export type OutboxCommand = 'send' | 'reply' | 'ack' | 'drops';

const OUTBOX_COMMANDS: readonly OutboxCommand[] = ['send', 'reply', 'ack', 'drops'];

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
  // One message, by its id, as `team ack <id>` reads it (E5). The scoped form clears other
  // records by age and is the owner's and the lead's, never a confined seat's.
  ack: { valued: [], flags: ['json'] },
  // The seat's own mail, read and receipted: `team drops --read --seat <self>` (E5).
  drops: { valued: ['seat', 'session', 'epoch', 'id'], flags: ['read'] },
};

const GRAMMAR: Record<OutboxCommand, { valued: readonly string[]; flags: readonly string[] }> = {
  send: { valued: SEND_VALUED_OPTIONS, flags: SEND_FLAG_OPTIONS },
  reply: { valued: [], flags: REPLY_FLAG_OPTIONS },
  // `--seat` and `--older-than` are read as valued here so the scoped form is named, then refused.
  ack: { valued: ['seat', 'older-than'], flags: [...ACK_FLAG_OPTIONS, 'dry-run'] },
  drops: { valued: DROPS_VALUED_OPTIONS, flags: DROPS_FLAG_OPTIONS },
};

/** Why a relayed command may not run, or null. */
export function relayRefusal(command: OutboxCommand, argv: readonly string[]): string | null {
  const grammar = GRAMMAR[command];
  const args = readArgs([...argv], [...grammar.valued], [...grammar.flags]);
  if (args.error !== undefined) return `its line does not read (${args.error})`;
  const allowed = RELAY_ALLOWED[command];
  for (const name of Object.keys(args.values)) {
    if (!allowed.valued.includes(name)) return `--${name} is not taken from a sandboxed seat's ${command}; put the text on the command line`;
  }
  for (const name of args.flags) {
    if (!allowed.flags.includes(name)) return `--${name} is not taken from a sandboxed seat's ${command}`;
  }
  if (command === 'ack' && args.rest.length !== 1) return 'a sandboxed seat acknowledges one message, by its id';
  if (command === 'drops' && (!args.flags.has('read') || args.values.seat === undefined)) {
    return 'a sandboxed seat relays only its own `team drops --read --seat <seat>`';
  }
  return null;
}

/**
 * What binds a relayed read or acknowledgement to the seat that asked (E5): `drops --read` names
 * that seat and, when it names one, that session; `ack <id>` names exactly one record in that
 * seat's own drop folder. The run that follows is the ordinary command with its ordinary checks;
 * this refuses a request that names another seat's mail before anything runs. Null when bound.
 */
export function relayBindingRefusal(
  dir: string,
  request: { command: OutboxCommand; argv: readonly string[]; seat: string; session: string },
): string | null {
  const bound = relayBinding(dir, request);
  return 'refused' in bound ? bound.refused : null;
}

/**
 * The run a relayed read or acknowledgement is bound to (E5): the outbox's own team — its root,
 * never the folder the request names — and, for an acknowledgement, the one full record id the
 * check resolved in that seat's own folder, so the command acts on exactly what was proven.
 * A send or a reply keeps its request's words and folder, as before.
 */
export function relayBinding(
  dir: string,
  request: { command: OutboxCommand; argv: readonly string[]; seat: string; session: string; cwd?: string },
): { refused: string } | { argv: string[]; cwd: string | undefined } {
  if (request.command !== 'ack' && request.command !== 'drops') return { argv: [...request.argv], cwd: request.cwd };
  const refused = relayBindingCheck(dir, request);
  if (typeof refused === 'string') return { refused };
  return { argv: refused.argv, cwd: dirname(dir) };
}

function relayBindingCheck(
  dir: string,
  request: { command: OutboxCommand; argv: readonly string[]; seat: string; session: string },
): string | { argv: string[] } {
  const grammar = GRAMMAR[request.command];
  const args = readArgs([...request.argv], [...grammar.valued], [...grammar.flags]);
  if (request.command === 'drops') {
    if (args.values.seat !== request.seat) return 'it reads another seat\'s mail than its outbox';
    if (args.values.session !== undefined && args.values.session !== request.session) return 'it reads another session than its outbox';
    return { argv: [...request.argv] };
  }
  const id = args.rest[0] ?? '';
  if (!recordNameOk(id)) return 'its id is not a record id';
  const folder = join(dir, 'send-drops', request.session, request.seat);
  let names: string[];
  try {
    if (!lstatSync(folder).isDirectory()) return 'the seat has no drop folder';
    names = readdirSync(folder);
  } catch {
    return 'the seat has no drop folder';
  }
  const records = names.filter((name) => name.startsWith(id) && !name.startsWith('.') && !isRecordSidecarName(name));
  if (records.length === 0) return 'no message of that id waits in the seat\'s own folder';
  if (records.length > 1) return 'that id prefix names more than one message in the seat\'s own folder';
  return { argv: [records[0]!, ...(args.flags.has('json') ? ['--json'] : [])] };
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
  /** Runs the seat's command as that seat; returns what it said. `persist` is the command's stdout
   *  made durable in the seat's outbox as it is written: a read hands its bodies over through it
   *  before it seals their receipts, so a run cut off after the hand-over still answers with them. */
  run(command: OutboxCommand, argv: string[], cwd: string, caller: RelayCaller, persist: (text: string, ids?: readonly string[]) => void, owner: string): Promise<{ code: number; out: string; err: string }>;
  /** Seals the seat's read receipts for ids a cut-off relayed read already handed over (its saved
   *  output holds their bodies), as the live read would have: the seat's reader, adopting the
   *  claim `owner` left, brief binding included. True once every one is read, false when any
   *  cannot be sealed now. */
  seal(seat: string, ids: readonly string[], owner: string): boolean;
  now(): Date;
  log(line: string): void;
  /** Test seam: the metadata read of saved output. */
  stat?: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean };
  /** Test seam: each durability point of the hand-over, in order. */
  trace?: (point: 'partial-fsync' | 'partial-folder-fsync' | 'result-fsync' | 'result-folder-fsync' | 'partial-removed') => void;
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
    // Unanswered takes are answered first: the sweep only removes what has its result.
    recoverTaken(join(dir, 'send-drops', session, seat), seat, folder, names, nowMs, sources);
    sweepResults(folder, readdirSafe(folder), nowMs);
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
      let result: OutboxResult;
      try {
        result = plain
          ? await runRequest(dir, taking, id, seat, session, sources)
          : refusal(id, seat, sources, 'it is not a plain file of this user of at most 256 KiB');
      } catch (error) {
        if (!(error instanceof SavedOutputUnreadable)) throw error;
        sources.log(`${seat}: outbox request ${id} stopped and its saved output cannot be read now; it is kept for a later pass`);
        ran += 1;
        continue;
      }
      // The outbox must still be the folder that was checked before the run.
      if (identityOf(folder) !== folderId) {
        sources.log(`${seat}: the outbox changed while request ${id} ran; its result was not written`);
        return ran + 1;
      }
      // The take is released only once its result stands: a failed publication leaves the
      // marker, and a later pass answers it as cut off.
      if (publishResult(folder, id, result, seat, sources)) {
        // A read whose seal could not be made left its claims standing: the saved output and the
        // take stay, and the recovery pass seals them from it (the result already stands).
        const left = claimsOwnedBy(join(dir, 'send-drops', session, seat), relayClaimOwner(folder, id));
        if (left === null || left.length > 0) {
          sources.log(`${seat}: outbox request ${id} left read claims unsealed; its saved output is kept for recovery`);
        } else {
          dropPartial(folder, id, sources.trace);
          try { unlinkSync(taking); } catch { /* removed with the results */ }
        }
      }
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
function publishResult(folder: string, id: string, result: OutboxResult, seat: string, sources: Pick<RelaySources, 'log' | 'trace'>): boolean {
  // A fresh temporary name per attempt: one a crashed attempt left behind never blocks this one.
  const temp = join(folder, `.${id}.result.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      writeAll(fd, `${JSON.stringify(result)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    sources.trace?.('result-fsync');
    renameSync(temp, join(folder, `${id}${RESULT_SUFFIX}`));
    // The result's name is durable before the saved output it replaces may be removed.
    fsyncFolder(folder);
    sources.trace?.('result-folder-fsync');
    return true;
  } catch (error) {
    sources.log(`${seat}: the result of outbox request ${id} could not be written (${(error as Error).message})`);
    try { unlinkSync(temp); } catch { /* not created */ }
    return false;
  }
}

function readdirSafe(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/** A request taken by a pass that never finished it: the seat gets a result that says so. A read
 *  the run had claimed (src/send/read-claim.ts) is settled here and nowhere else: when its saved
 *  output holds the bodies, their receipts are sealed and that output is the result; when nothing
 *  was saved, the claim is voided, the messages stay unread, and no body is published. */
function recoverTaken(dropDir: string, seat: string, folder: string, names: readonly string[], nowMs: number, sources: RelaySources): void {
  for (const name of names) {
    if (!name.endsWith('.taking')) continue;
    const id = name.slice(0, -'.taking'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const path = join(folder, name);
    const owner = relayClaimOwner(folder, id);
    // A take whose result already stands is finished: its claims are settled by what that result
    // published, and then only its marker is left to remove.
    if (names.includes(`${id}${RESULT_SUFFIX}`)) {
      if (settleClaims(dropDir, seat, owner, () => readPartial(folder, id, sources.stat), sources) === false) continue;
      dropPartial(folder, id, sources.trace);
      try { unlinkSync(path); } catch { /* gone already */ }
      continue;
    }
    try {
      if (nowMs - lstatSync(path).mtimeMs < TAKEN_STALE_MS) continue;
    } catch {
      continue;
    }
    sources.log(`outbox request ${id} was cut off while it ran; its outcome is unknown`);
    // What the run had already handed over is answered with it, never replaced by an empty result.
    const handed = readPartial(folder, id, sources.stat);
    if (handed === null) {
      sources.log(`outbox request ${id}: its saved output cannot be read now; kept for a later pass`);
      continue;
    }
    // Bodies saved whole are sealed before they are published, so the result that carries them
    // is their one exposure; a claim whose body was not saved whole is voided first, and its
    // message stays unread for the next reader.
    const settled = settleClaims(dropDir, seat, owner, () => handed, sources);
    if (settled === false) continue;
    // An earlier build's unframed output proves no body whole: beside claims of this request it is
    // withheld, so a voided claim's body is never published. The decision is made durable before
    // the first publish attempt by discarding that file (folder fsynced): a retry after a failed
    // publish finds no legacy output to bring back.
    const withhold = settled === 'claims' && handed.legacy !== '';
    if (withhold && !discardLegacy(folder, id)) {
      sources.log(`outbox request ${id}: its unframed saved output could not be discarded; kept for a later pass`);
      continue;
    }
    const out = withhold ? handed.text.slice(handed.legacy.length) : handed.text;
    if (publishResult(folder, id, {
      id,
      code: 1,
      out,
      err: out === ''
        ? 'team: the relay stopped while running this request; whether it was sent is unknown — check before sending again\n'
        : 'team: the relay stopped after this output was handed over; what it read is above\n',
      at: new Date(nowMs).toISOString(),
    }, id, sources) === false) continue;
    dropPartial(folder, id, sources.trace);
    try { unlinkSync(path); } catch { /* the sweep removes it */ }
  }
}

/** Settles the read claims `owner` still holds. An id whose body the saved output holds whole
 *  has its receipt sealed (it goes out in the result); every other owned id is voided, so its
 *  message stays unread and no part of its body is published. 'none' when it held no claims,
 *  'claims' when it settled some; false keeps everything for a later pass: claims or saved output
 *  that cannot be read now, or a seal that could not be made. */
function settleClaims(dropDir: string, seat: string, owner: string, output: () => Saved | null, sources: RelaySources): false | 'none' | 'claims' {
  const owned = claimsOwnedBy(dropDir, owner);
  if (owned === null) {
    sources.log(`${seat}: the read claims cannot be read now; the cut-off request is kept for a later pass`);
    return false;
  }
  if (owned.length === 0) return 'none';
  const saved = output();
  if (saved === null) {
    sources.log(`${seat}: a cut-off read's output cannot be read now; its claims are kept for a later pass`);
    return false;
  }
  const handed = owned.filter((one) => saved.ids.includes(one));
  if (handed.length > 0 && !sources.seal(seat, handed, owner)) {
    sources.log(`${seat}: a cut-off read's receipts could not be sealed now; its claims are kept for a later pass`);
    return false;
  }
  for (const one of owned) settleOwnedClaim(dropDir, one, owner);
  return 'claims';
}

function identityOf(folder: string): string | null {
  try {
    const stat = lstatSync(folder);
    return stat.isDirectory() ? `${String(stat.dev)}:${String(stat.ino)}` : null;
  } catch {
    return null;
  }
}

async function runRequest(dir: string, path: string, id: string, seat: string, session: string, sources: RelaySources): Promise<OutboxResult> {
  try {
    return await checkedRun(dir, path, id, seat, session, sources);
  } catch (error) {
    // What the command already handed over stays the seat's: its durable output is the result's.
    const handed = readPartial(dirname(path), id, sources.stat);
    // Saved output that cannot be read now is kept, never replaced: the take stays for recovery.
    if (handed === null) throw new SavedOutputUnreadable();
    const result = refusal(id, seat, sources, `it could not be run (${(error as Error).message})`);
    return handed.text === '' ? result : { ...result, out: handed.text };
  }
}

const PARTIAL_SUFFIX = '.partial';
const CHUNK = /^(.+)\.partial\.(\d{6})$/;

class SavedOutputUnreadable extends Error {}
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** What a run handed over and saved: the text, and the ids of the messages whose bodies that text
 *  holds whole. A chunk is published only whole (a temp file renamed into place), and carries the
 *  sha256 and length of its text, so a body cut short is never counted as handed over. */
type Saved = { text: string; ids: string[]; legacy: string };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Saves one stdout write of a run as the next numbered chunk `<id>.partial.<nnnnnn>`: a private
 *  temp file with a header line ({ids, sha256, length}) and the text, fsynced, renamed into place,
 *  and the folder fsynced, before it returns. A write that fails throws into the command's own
 *  stdout, which then keeps its messages unread. */
function appendPartial(folder: string, id: string, text: string, ids: readonly string[], trace?: RelaySources['trace']): void {
  const seq = chunkNames(folder, id).length;
  const name = `${id}${PARTIAL_SUFFIX}.${String(seq).padStart(6, '0')}`;
  const temp = join(folder, `.${name}.${String(process.pid)}.tmp`);
  const header = `${JSON.stringify({ v: 1, ids: [...ids], sha256: sha256(text), length: Buffer.byteLength(text, 'utf8') })}\n`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('the outbox output is not a plain file');
    writeAll(fd, header + text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  trace?.('partial-fsync');
  renameSync(temp, join(folder, name));
  // Its name is durable too before the command goes on to seal anything.
  fsyncFolder(folder);
  trace?.('partial-folder-fsync');
}

function chunkNames(folder: string, id: string): string[] {
  return readdirSync(folder)
    .filter((name) => { const match = CHUNK.exec(name); return match !== null && match[1] === id; })
    .sort();
}

function fsyncFolder(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The saved output: empty when none was saved, null when any of it exists and cannot be read
 *  now. A chunk whose text does not match its header is not counted, its text not published and
 *  its ids not taken as handed over. An earlier build's single `<id>.partial` file is read as text
 *  that proves no id handed over. */
function readPartial(folder: string, id: string, stat?: RelaySources['stat']): Saved | null {
  const legacy = readOwn(join(folder, `${id}${PARTIAL_SUFFIX}`), stat);
  if (legacy === null) return null;
  let names: string[];
  try {
    names = chunkNames(folder, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    names = [];
  }
  const saved: Saved = { text: legacy, ids: [], legacy };
  for (const name of names) {
    const raw = readOwn(join(folder, name), stat);
    if (raw === null) return null;
    const cut = raw.indexOf('\n');
    if (cut < 0) continue;
    let header: { v?: unknown; ids?: unknown; sha256?: unknown; length?: unknown };
    try {
      header = JSON.parse(raw.slice(0, cut)) as typeof header;
    } catch {
      continue;
    }
    const text = raw.slice(cut + 1);
    if (header.v !== 1 || !Array.isArray(header.ids) || !header.ids.every((one) => typeof one === 'string')) continue;
    if (header.length !== Buffer.byteLength(text, 'utf8') || header.sha256 !== sha256(text)) continue;
    saved.text += text;
    saved.ids.push(...(header.ids as string[]));
  }
  return saved;
}

/** Discards an earlier build's unframed saved output, durably: false keeps it for a later pass. */
function discardLegacy(folder: string, id: string): boolean {
  try {
    unlinkSync(join(folder, `${id}${PARTIAL_SUFFIX}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    fsyncFolder(folder);
    return true;
  } catch {
    return false;
  }
}

function dropPartial(folder: string, id: string, trace?: RelaySources['trace']): void {
  try { unlinkSync(join(folder, `${id}${PARTIAL_SUFFIX}`)); } catch { /* none was written */ }
  let names: string[] = [];
  try { names = chunkNames(folder, id); } catch { /* none */ }
  for (const name of names) {
    try { unlinkSync(join(folder, name)); } catch { /* gone */ }
  }
  trace?.('partial-removed');
}

async function checkedRun(dir: string, path: string, id: string, seat: string, session: string, sources: RelaySources): Promise<OutboxResult> {
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
  if (!OUTBOX_COMMANDS.includes(request.command)) return refuse('it names no send, reply, ack or read');
  if (!Array.isArray(request.argv) || !request.argv.every((word) => typeof word === 'string')) return refuse('its words are not text');
  const optionRefusal = relayRefusal(request.command, request.argv);
  if (optionRefusal !== null) return refuse(optionRefusal);
  if (request.seat !== seat || request.session !== session) return refuse('it names another seat or session than its outbox');
  const bound = relayBinding(dir, request);
  if ('refused' in bound) return refuse(bound.refused);
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
  let cwd = typeof bound.cwd === 'string' ? bound.cwd : '';
  try {
    if (cwd === '' || !lstatSync(cwd).isDirectory()) cwd = '';
  } catch {
    cwd = '';
  }
  if (cwd === '') return refuse('its working folder is not a folder');
  const persist = (text: string, ids: readonly string[] = []): void => appendPartial(dirname(path), id, text, ids, sources.trace);
  const ran = await sources.run(request.command, bound.argv, cwd, { kind: 'seat', name: seat, pane: request.pane, session }, persist, relayClaimOwner(dirname(path), id));
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
    const tempFile = name.startsWith('.') && name.endsWith('.tmp');
    if (!name.endsWith(RESULT_SUFFIX) && !tempFile) continue;
    const path = join(folder, name);
    try {
      if (nowMs - lstatSync(path).mtimeMs > RESULT_KEEP_MS) unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
}
