// A seat's restart of itself (`team restart <own-seat> --self`).
//
// A restart run from inside a seat's own pane would close the process running it, so the seat
// does not restart itself: it records one signed request here and returns at once. The daemon's
// heartbeat reads the requests of each hosted route and runs the ordinary `team restart <seat>
// --resume <conversation>` for a request only once herdr reads the seat idle or done at an empty
// prompt (no turn, no unsent text, no dialog), re-read right before, and only while the load
// guard lets a launch through. The heartbeat is the retry: a seat still working waits for a later
// beat. A request older than `SELF_RESTART_BOUND_MS` is given up and said to the team's lead.
//
// The request is the seat's own: `team restart --self` writes it only for a caller proven on
// the seat's recorded pane, and the daemon acts on it only while its signature verifies under the
// machine's message key and the seat's recorded launch, pane and conversation are still the ones
// the request names. A request that describes an earlier launch is dropped unrun.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import { readStateFile, writeStateFile } from '../file-write.ts';
import { mkdirSync, unlinkSync } from '../host/guarded-fs.ts';
import type { Io } from '../io.ts';
import { readState } from '../state.ts';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain } from '../store/keys.ts';
import { launchLimit } from '../watch/machine.ts';
import type { UpSources } from '../commands/up.ts';
import { idleNow } from './restore-relaunch.ts';

/** How long a queued self-restart waits for its seat to come idle before it is given up. */
export const SELF_RESTART_BOUND_MS = 30 * 60_000;

const DOMAIN = 'team-self-restart-v1\n';

export type SelfRestartRequest = {
  format: 1;
  seat: string;
  session: string;
  /** The seat's recorded conversation, resumed by the restart. */
  conversation: string;
  /** The pane and launch identity the request was made from: a later launch drops it. */
  pane: string;
  launched: string;
  requested_at: string;
  signature: string;
};

type Signed = Omit<SelfRestartRequest, 'signature'>;

const folderOf = (dir: string, session: string): string => join(dir, 'self-restart', session);
export const selfRestartPath = (dir: string, session: string, seat: string): string => join(folderOf(dir, session), `${seat}.json`);

const identity = (launched: unknown): string => JSON.stringify(launched ?? null);

/** Writes the signed request for the seat's current launch; a second request replaces the first. */
export function writeSelfRestartRequest(input: {
  home: string; dir: string; session: string; seat: string; conversation: string; pane: string; launched: unknown; now: Date;
}): SelfRestartRequest {
  const body: Signed = {
    format: 1, seat: input.seat, session: input.session, conversation: input.conversation,
    pane: input.pane, launched: identity(input.launched), requested_at: input.now.toISOString(),
  };
  const request: SelfRestartRequest = { ...body, signature: signDomain(DOMAIN, body, messageKeyOf(input.home)) };
  mkdirSync(folderOf(input.dir, input.session), { recursive: true });
  writeStateFile(selfRestartPath(input.dir, input.session, input.seat), `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

/** The request at `path` when it parses and its signature verifies; null otherwise. */
function readRequest(home: string, path: string): SelfRestartRequest | null {
  try {
    const text = readStateFile(path);
    if (text === null) return null;
    const parsed = JSON.parse(text) as SelfRestartRequest;
    const { signature, ...body } = parsed;
    if (body.format !== 1 || typeof signature !== 'string' || typeof body.seat !== 'string' || typeof body.session !== 'string'
      || typeof body.conversation !== 'string' || typeof body.pane !== 'string' || typeof body.launched !== 'string'
      || typeof body.requested_at !== 'string' || Number.isNaN(Date.parse(body.requested_at))) return null;
    const key = messageKeyState(home);
    if (key.kind !== 'key' || !verifyDomain(DOMAIN, body, signature, key.key)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function drop(path: string): void {
  try { unlinkSync(path); } catch { /* already taken */ }
}

/** A UUID-shaped id, stable for one request: a retried notice finds the first. */
function noticeId(root: string, request: SelfRestartRequest): string {
  const hex = createHash('sha256').update(`self-restart\0${root}\0${request.session}\0${request.seat}\0${request.requested_at}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type SelfRestartDeps = {
  /** Runs `team restart` with these words; the exit code. */
  restart: (argv: string[], io: Io) => Promise<number>;
  /** Writes one signed notice to the lead; a second write with the same id finds the first. */
  notify: (input: { lead: string; body: string; id: string }) => boolean;
};

/** One pass over a route's queued self-restarts: what was done or said, one line each. */
export async function runSelfRestarts(input: {
  home: string; root: string; dir: string; team: TeamFile; sources: UpSources; caller: Caller;
  launchFile?: string; deps: SelfRestartDeps; boundMs?: number;
}): Promise<string[]> {
  const { home, root, dir, team, sources, deps } = input;
  const now = (): Date => sources.now?.() ?? new Date();
  const bound = input.boundMs ?? SELF_RESTART_BOUND_MS;
  const lines: string[] = [];
  let sessions: string[];
  try { sessions = readdirSync(join(dir, 'self-restart')); } catch { return lines; }
  const report = (request: SelfRestartRequest, body: string): void => {
    lines.push(body);
    if (team.orchestrator !== '') deps.notify({ lead: team.orchestrator, body, id: noticeId(root, request) });
  };
  for (const session of sessions) {
    let files: string[];
    try { files = readdirSync(folderOf(dir, session)).filter((one) => one.endsWith('.json')); } catch { continue; }
    for (const file of files) {
      const path = join(folderOf(dir, session), file);
      const request = readRequest(home, path);
      if (request === null || request.session !== session || `${request.seat}.json` !== file) {
        lines.push(`${session}/${file}: a self-restart request that does not verify; dropped unrun`);
        drop(path);
        continue;
      }
      const { seat, conversation } = request;
      const held = readState(dir).sessions[session]?.seats[seat];
      if (held?.pane !== request.pane || identity(held.launched) !== request.launched || held.agent_session !== conversation) {
        lines.push(`${seat}: its self-restart request names an earlier launch; dropped unrun`);
        drop(path);
        continue;
      }
      if (now().getTime() - Date.parse(request.requested_at) > bound) {
        report(request, `${seat}: self-restart given up: it did not come idle with an empty input line within ${String(Math.round(bound / 60_000))} min of ${request.requested_at}; \`team restart ${seat} --self\` queues it again`);
        drop(path);
        continue;
      }
      const machine = sources.machine?.(root);
      const load = machine === undefined ? null : launchLimit(machine, team.machine, [], now().getTime());
      if (load !== null) continue;
      const declared = team.seats.find((one) => one.name === seat);
      if (declared === undefined) {
        report(request, `${seat}: self-restart dropped: the seat is no longer declared`);
        drop(path);
        continue;
      }
      // Never while it works, holds unsent text or shows a dialog; read right before the restart.
      if (!idleNow(sources, session, request.pane, declared.cli)) continue;
      // One attempt per request: taken before the run, so a run that stops the seat and fails to
      // launch it is never tried again over the same request.
      drop(path);
      const said: string[] = [];
      const env = { ...process.env };
      delete env.HERDR_PANE_ID;
      const io: Io = {
        cwd: root, env, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, caller: input.caller,
        stdout: (text) => said.push(text), stderr: (text) => said.push(text),
      };
      const argv = [seat, '--resume', conversation, '--session', session, ...(input.launchFile === undefined ? [] : ['--file', input.launchFile])];
      const exit = await deps.restart(argv, io);
      if (exit === 0) {
        lines.push(`${seat}: restarted itself with its conversation ${conversation}`);
      } else {
        const last = said.join('').split('\n').map((one) => one.trim()).filter((one) => one !== '').at(-1) ?? `exit ${String(exit)}`;
        report(request, `${seat}: self-restart failed (${last})`);
      }
    }
  }
  return lines;
}

/** Whether the route's state folder holds any queued request: one folder read per session, so
 *  the daemon's beat starts a pass only when there is something to run. */
export function hasSelfRestartRequests(dir: string): boolean {
  try {
    return readdirSync(join(dir, 'self-restart')).some((session) => {
      try { return readdirSync(folderOf(dir, session)).some((one) => one.endsWith('.json')); } catch { return false; }
    });
  } catch {
    return false;
  }
}
