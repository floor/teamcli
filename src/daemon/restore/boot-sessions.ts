// The registered team sessions a machine restart took down, brought back by the daemon.
//
// The terminal host resumes only the sessions the owner attaches, so after a restart every other
// team's session stays stopped until he opens it: its seats get no restore and no mail.
//
// Two records, kept apart:
// - `sessions-running.json`, the observation: every few seconds the daemon writes which of its
//   hosted, registered team routes (root, team, session) have their session running, stamped
//   with this boot's id (macOS `kern.bootsessionuuid`, a fresh id each boot; never a clock).
// - `boot-restore.json`, the work: when a daemon starts and the observation carries another
//   boot's id, the machine restarted since it was written. Its routes become this boot's queue,
//   written durably before anything is started or observed again. A daemon restarted later in
//   the same boot resumes that queue; it never re-derives one from a newer observation.
//
// Each queued route is started only after a fresh check, right before the start, that it is
// still a hosted route with the same root, team and session, that the registered team is not
// stopped (`team down` invalidates it), and that its session reads stopped (not deleted, not
// already running). A start that fails for a passing reason stays queued; a route that fails
// the check is settled as invalidated. What the observation cannot know is a session stopped by
// hand in the few seconds between its last sample and the power-off: that window is the sample
// interval, and it is stated, not hidden.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execText } from '../../child.ts';
import { renameSync, writeFileSync } from '../../host/guarded-fs.ts';
import { machineConfigDir } from '../paths.ts';

export const SESSIONS_RUNNING_FILE = 'sessions-running.json';
export const BOOT_RESTORE_FILE = 'boot-restore.json';

/** One hosted, registered team route, as the daemon routes it. */
export type BootRoute = { root: string; team: string; session: string };
/** The observation: this boot's id, when, and the routes whose session read running. */
export type SessionsRunning = { boot: string; at: number; running: BootRoute[] };
/** The work for one boot: routes still to start, and those settled (started or invalidated). */
export type BootQueue = { boot: string; pending: BootRoute[]; settled: { route: BootRoute; outcome: string }[] };

const sameRoute = (a: BootRoute, b: BootRoute): boolean => a.root === b.root && a.team === b.team && a.session === b.session;

function isRoute(value: unknown): value is BootRoute {
  if (typeof value !== 'object' || value === null) return false;
  const { root, team, session } = value as Record<string, unknown>;
  return typeof root === 'string' && root.startsWith('/') && typeof team === 'string' && team !== ''
    && typeof session === 'string' && /^[A-Za-z0-9._-]+$/.test(session) && session !== '.' && session !== '..';
}

function uniqueRoutes(routes: readonly BootRoute[]): BootRoute[] {
  const out: BootRoute[] = [];
  for (const route of routes) if (!out.some((one) => sameRoute(one, route))) out.push({ root: route.root, team: route.team, session: route.session });
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Writes a record whole (temp file, then rename). False when it could not be written. */
function writeJson(path: string, value: unknown): boolean {
  const temp = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

export const sessionsRunningPath = (home: string): string => join(machineConfigDir(home), SESSIONS_RUNNING_FILE);
export const bootQueuePath = (home: string): string => join(machineConfigDir(home), BOOT_RESTORE_FILE);

/** The observation, or null when it is absent or not one this version wrote. */
export function readSessionsRunning(home: string): SessionsRunning | null {
  const value = readJson(sessionsRunningPath(home));
  if (typeof value !== 'object' || value === null) return null;
  const { boot, at, running } = value as Record<string, unknown>;
  if (typeof boot !== 'string' || boot === '' || typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (!Array.isArray(running) || !running.every(isRoute)) return null;
  return { boot, at, running: uniqueRoutes(running) };
}

export function writeSessionsRunning(home: string, record: SessionsRunning): boolean {
  return writeJson(sessionsRunningPath(home), { boot: record.boot, at: record.at, running: uniqueRoutes(record.running) });
}

/** The queue, or null when it is absent or not one this version wrote. */
export function readBootQueue(home: string): BootQueue | null {
  const value = readJson(bootQueuePath(home));
  if (typeof value !== 'object' || value === null) return null;
  const { boot, pending, settled } = value as Record<string, unknown>;
  if (typeof boot !== 'string' || boot === '' || !Array.isArray(pending) || !pending.every(isRoute)) return null;
  if (!Array.isArray(settled)) return null;
  const settledOk = settled.every((one) => typeof one === 'object' && one !== null
    && isRoute((one as Record<string, unknown>).route) && typeof (one as Record<string, unknown>).outcome === 'string');
  if (!settledOk) return null;
  return { boot, pending: uniqueRoutes(pending), settled: settled as BootQueue['settled'] };
}

export function writeBootQueue(home: string, queue: BootQueue): boolean {
  return writeJson(bootQueuePath(home), queue);
}

/** Settles one route of the queue (in place) and says whether the queue was written. */
export function settleRoute(home: string, queue: BootQueue, route: BootRoute, outcome: string): boolean {
  queue.pending = queue.pending.filter((one) => !sameRoute(one, route));
  queue.settled.push({ route: { root: route.root, team: route.team, session: route.session }, outcome });
  return writeBootQueue(home, queue);
}

/** This boot's id: `kern.bootsessionuuid`, fresh on every boot and independent of the clock.
 *  Null when it cannot be read (then no boot work is derived and nothing is started). */
export async function bootId(read: () => Promise<string> = () => execText('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeoutMs: 5_000 })): Promise<string | null> {
  let text: string;
  try {
    text = await read();
  } catch {
    return null;
  }
  const id = text.trim();
  return /^[0-9A-Fa-f-]{16,64}$/.test(id) ? id.toUpperCase() : null;
}

/**
 * The queue this daemon works on:
 * - the stored queue when it is this boot's (a daemon restarted in the same boot resumes it);
 * - a new queue from the observation when the observation is another boot's (the machine
 *   restarted since); its `isNew` tells the caller to write it before anything else;
 * - null otherwise: no boot id, no observation, or the observation is already this boot's and
 *   no queue was kept (nothing restarted, or the queue could not be written: fail closed).
 */
export function planBootQueue(
  observed: SessionsRunning | null,
  stored: BootQueue | null,
  boot: string | null,
): { queue: BootQueue; isNew: boolean } | null {
  if (boot === null) return null;
  if (stored !== null && stored.boot === boot) return { queue: stored, isNew: false };
  if (observed === null || observed.boot === boot) return null;
  return { queue: { boot, pending: uniqueRoutes(observed.running), settled: [] }, isNew: true };
}

/** Why a queued route may not be started now, or null when it may: it must still be a hosted
 *  route with the same root, team and session, and its registered team must not be stopped. */
export function bootRouteProblem(
  route: BootRoute,
  hosted: readonly BootRoute[],
  lifecycleProblem: (root: string, team: string) => string | null,
): string | null {
  const now = hosted.find((one) => one.root === route.root);
  if (now === undefined) return 'the root is no longer hosted';
  if (now.team !== route.team) return `the root now hosts team "${now.team}", not "${route.team}"`;
  if (now.session !== route.session) return `the team's session is now "${now.session}", not "${route.session}"`;
  return lifecycleProblem(route.root, route.team);
}
