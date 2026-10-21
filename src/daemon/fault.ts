// The one scoped hosted-watch fault diagnostic. `team daemon fault-watch` writes a single
// request file into the daemon's own machine folder; the daemon's existing heartbeat consumes
// it, matches the one route it names, and calls that watch's `fault(why)`. Nothing here signals
// a process or reads another route's watch: the request names one route id, the daemon refuses
// every request it cannot match exactly, and a fault ends only the run the named host owns.
//
// The request is one-shot, 0600 inside the daemon's 0700 machine folder, and bound to the
// daemon run that was asked: its resolved home, its pid and its start instant must all agree
// with the consuming daemon. A request for an earlier incarnation is answered `refused` and
// unlinked, never replayed. The result file is written when the faulted run leaves its seam —
// or `refused` when nothing was faulted — and a request still pending at close is answered
// `not reached`, so a reader never waits past the daemon it asked.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { HostedWatchState } from '../watch/hosted.ts';
import { machineConfigDir } from './paths.ts';

/** The reason a faulted run records. It is the fixed diagnostic sentence, not caller text. */
export const FAULT_WHY = 'watch fault injected by the fault-watch diagnostic';

/** How long `fault-watch` waits for the daemon's result: two beats of its fixed 5 s heartbeat. */
export const FAULT_WAIT_MS = 10_000;

/** How often `fault-watch` looks for the result file. */
export const FAULT_POLL_MS = 100;

const REQUEST_FILE = 'daemon.fault-request.json';
const RESULT_FILE = 'daemon.fault-result.json';

/** A route id is the digest `routeId()` records: 32 lowercase hex characters, matched exactly. */
const ROUTE_ID = /^[0-9a-f]{32}$/;

export type FaultRequest = {
  format: 1;
  /** The daemon home this request was resolved for; the consuming daemon must agree. */
  home: string;
  routeId: string;
  /** The daemon run the request was written for, so a later incarnation never replays it. */
  daemonPid: number;
  daemonSince: string;
  why: string;
  requestedAt: string;
  nonce: string;
};

export type FaultOutcome = 'faulted' | 'refused' | 'not reached';

export type FaultResult = {
  format: 1;
  home: string;
  routeId: string;
  nonce: string;
  outcome: FaultOutcome;
  why: string;
  at: string;
};

export function faultRequestPath(home: string): string {
  return join(machineConfigDir(home), REQUEST_FILE);
}

export function faultResultPath(home: string): string {
  return join(machineConfigDir(home), RESULT_FILE);
}

function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A request another reader already took is consumed; there is nothing left to do.
  }
}

/**
 * Writes the one pending request. A request already waiting is never overwritten: the previous
 * one has not been consumed yet, and replacing it would hide that from its writer.
 */
export function writeFaultRequest(home: string, request: FaultRequest): { ok: true } | { ok: false; why: string } {
  mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
  if (existsSync(faultRequestPath(home))) {
    return { ok: false, why: 'a fault request is already waiting for the daemon' };
  }
  writePrivate(faultRequestPath(home), `${JSON.stringify(request, null, 2)}\n`);
  return { ok: true };
}

/** The last result the daemon wrote, or null when it is missing or not the promised shape. */
export function readFaultResult(home: string): FaultResult | null {
  const path = faultResultPath(home);
  if (!existsSync(path)) return null;
  try {
    return resultOf(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function requestOf(raw: unknown): FaultRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.format !== 1) return null;
  for (const key of ['home', 'daemonSince', 'why', 'requestedAt', 'nonce'] as const) {
    if (typeof entry[key] !== 'string' || entry[key] === '') return null;
  }
  if (typeof entry.routeId !== 'string' || !ROUTE_ID.test(entry.routeId)) return null;
  if (typeof entry.daemonPid !== 'number' || !Number.isInteger(entry.daemonPid) || entry.daemonPid <= 0) return null;
  if ((entry.why as string).length > 200) return null;
  if ((entry.nonce as string).length > 100) return null;
  return {
    format: 1,
    home: entry.home as string,
    routeId: entry.routeId,
    daemonPid: entry.daemonPid,
    daemonSince: entry.daemonSince as string,
    why: entry.why as string,
    requestedAt: entry.requestedAt as string,
    nonce: entry.nonce as string,
  };
}

function resultOf(raw: unknown): FaultResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.format !== 1) return null;
  for (const key of ['home', 'nonce', 'why', 'at'] as const) {
    if (typeof entry[key] !== 'string') return null;
  }
  if (typeof entry.routeId !== 'string' || (entry.routeId !== '' && !ROUTE_ID.test(entry.routeId))) return null;
  if (!['faulted', 'refused', 'not reached'].includes(entry.outcome as string)) return null;
  return {
    format: 1,
    home: entry.home as string,
    routeId: entry.routeId,
    nonce: entry.nonce as string,
    outcome: entry.outcome as FaultOutcome,
    why: entry.why as string,
    at: entry.at as string,
  };
}

/** What one hosted watch exposes to the diagnostic: its identity and the one fault seam. */
export type FaultTarget = {
  state(): Pick<HostedWatchState, 'routeId' | 'phase' | 'required'>;
  fault(why: string, left: (recorded: string) => void): boolean;
};

export type FaultInbox = {
  /** Consumes at most the one pending request; safe to call on every heartbeat beat. */
  consume(targets: readonly FaultTarget[]): void;
  /** Answers every fault that has not reached its seam; called once, as the daemon closes. */
  close(): void;
};

/**
 * The daemon half of the diagnostic. It is created with the daemon's already resolved home,
 * pid and start instant — the same values its state record carries — and every request must
 * match all three before it can fault anything.
 */
export function createFaultInbox(input: {
  home: string;
  pid: number;
  since: string;
  now?: () => Date;
  log?: (text: string) => void;
}): FaultInbox {
  const now = input.now ?? (() => new Date());
  // One entry per faulted route whose run has not left its seam yet. The key is the route id,
  // so a second request for the same route can never stack a second result.
  const pending = new Map<string, FaultResult>();

  const writeResult = (result: FaultResult): void => {
    try {
      mkdirSync(machineConfigDir(input.home), { recursive: true, mode: 0o700 });
      writePrivate(faultResultPath(input.home), `${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      input.log?.(`fault result: ${error instanceof Error ? error.message : 'the result could not be written'}`);
    }
  };

  const refuse = (nonce: string, routeId: string, why: string): void => {
    writeResult({
      format: 1,
      home: input.home,
      routeId,
      nonce,
      outcome: 'refused',
      why,
      at: now().toISOString(),
    });
  };

  const consume = (targets: readonly FaultTarget[]): void => {
    const path = faultRequestPath(input.home);
    if (!existsSync(path)) return;
    let text: string;
    let mode: number;
    try {
      mode = statSync(path).mode & 0o777;
      text = readFileSync(path, 'utf8');
    } catch {
      // A request that vanished or cannot be read is left for a later beat; nothing is acted on.
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      raw = null;
    }
    const request = requestOf(raw);
    // Consumed whether or not it is accepted: a one-shot request is never replayed by a later
    // beat, and a malformed one leaves only its refusal behind.
    unlinkQuietly(path);
    if (mode !== 0o600) {
      // The shape still names the writer's nonce, so the writer learns its request was refused.
      refuse(request?.nonce ?? '', request?.routeId ?? '', 'the fault request is not a private 0600 file');
      return;
    }
    if (request === null) {
      refuse('', '', 'the fault request is not a valid diagnostic request');
      return;
    }
    if (resolve(request.home) !== resolve(input.home)) {
      refuse(request.nonce, request.routeId, 'the fault request names another daemon home');
      return;
    }
    if (request.daemonPid !== input.pid || request.daemonSince !== input.since) {
      refuse(request.nonce, request.routeId, 'the fault request was written for another daemon run');
      return;
    }
    const target = targets.find((one) => one.state().routeId === request.routeId);
    if (target === undefined) {
      refuse(request.nonce, request.routeId, 'no hosted watch serves this route');
      return;
    }
    const state = target.state();
    if (!state.required) {
      refuse(request.nonce, request.routeId, 'the route was not started with a hosted watch');
      return;
    }
    if (state.phase === 'standby') {
      refuse(request.nonce, request.routeId, 'the route stands down to a live pane watch');
      return;
    }
    if (state.phase === 'stopped') {
      refuse(request.nonce, request.routeId, 'the hosted watch has stopped');
      return;
    }
    // A fault already accepted for this route has not left its seam yet. A second one would
    // replace the first writer's answer, so the request that came second is refused.
    if (pending.has(request.routeId)) {
      refuse(request.nonce, request.routeId, 'a fault for this route is still leaving its seam');
      return;
    }
    const accepted = target.fault(request.why, (recorded) => {
      pending.delete(request.routeId);
      writeResult({
        format: 1,
        home: input.home,
        routeId: request.routeId,
        nonce: request.nonce,
        outcome: 'faulted',
        why: recorded,
        at: now().toISOString(),
      });
    });
    if (!accepted) {
      refuse(request.nonce, request.routeId, 'no hosted run is in flight to fault');
      return;
    }
    pending.set(request.routeId, {
      format: 1,
      home: input.home,
      routeId: request.routeId,
      nonce: request.nonce,
      outcome: 'not reached',
      why: 'the daemon closed before the run left its seam',
      at: now().toISOString(),
    });
  };

  const close = (): void => {
    for (const result of pending.values()) {
      writeResult({ ...result, at: now().toISOString() });
    }
    pending.clear();
  };

  return { consume, close };
}
