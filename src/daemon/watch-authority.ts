// The private hosted wrapper: the daemon does not run a route's watch until that route's own
// state records the watchdog file binding `up` wrote, and the watch holds the session's frozen
// authority record for as long as it runs. This module is wiring; the store and the lifecycle are
// `watch/epoch-store.ts` and `watch/authority-lifecycle.ts`, and the loop is the shared
// `hostedWatchRun`, unchanged.
//
// The binding and the authority are read from the state folder beside the team file the daemon
// itself resolved. Root and session come from the route; the epoch comes from the lifecycle's
// acquire. No actor value is ever read from argv, JSON or the environment, and this module never
// writes a watchdog record: a missing or mismatched binding stands the watch down as blocked and
// says so, and the run never starts.
//
// The authority is renewed on the daemon's existing fixed heartbeat, not on the sweep's own wait:
// the build exposes `tick`, the host calls it on every daemon beat before any due waiter settles,
// and the wrapper pulses the lifecycle host there. Renewal therefore runs every five seconds
// through a long sweep, a long pass or a long wait, with no second timer and no shortened wait. A
// beat that finds the captured epoch lost or the record unreadable closes the push and aborts the
// loop at once. Every effect additionally passes the shared verifier for the captured
// root/session/epoch immediately before the sender runs; neither a fresh report nor a renew result
// alone admits an effect.
//
// Outbound effects stay blocked until both a sender factory and the shared verifier are injected.
// This wrapper makes no exactly-once handoff claim and adds no queue, identity or WorkPush
// request change: drain holds ambiguous work for explicit recovery.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WatchSources } from '../commands/watch.ts';
import { readState } from '../state.ts';
import { createWatchHost, type WatchHostReport } from '../watch/authority-lifecycle.ts';
import type { WorkPush } from '../watch/dispatch.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import type { HostedWatchBuild } from './host.ts';
import type { HostedRoute } from './routes.ts';
import { hostedWatchRun } from './watch-run.ts';

/** The daemon's existing heartbeat: a busy acquire is retried on the next tick, never parked. */
export const HOSTED_AUTHORITY_TICK_MS = 5_000;

/** What the shared verifier judges: the captured route identity and this host's own epoch. */
export type WatchAuthorityCheck = { root: string; session: string; epoch: string };

export type WatchAuthorityVerdict = { ok: true } | { ok: false; why: string };

/** The shared verifier (`verifyWatchAuthority`) once that export is on this base. It reads the
 *  state under its own lock and re-judges the record for this exact host; this wrapper never
 *  substitutes a lifecycle report or a renew result for it. */
export type WatchAuthorityVerifier = (input: WatchAuthorityCheck) => WatchAuthorityVerdict;

/** What an injected sender factory is given once this host has captured its epoch. */
export type WatchSenderFactoryInput = {
  route: HostedRoute;
  /** The state folder the authority record lives in: dirname of the resolved team file. */
  stateDir: string;
  /** The epoch captured by this host at acquire; never read from a flag, JSON or the environment. */
  epoch: string;
  /** Per-effect verifier: renews and answers true only for an authoritative, fresh record. */
  verify(): boolean;
  log(text: string): void;
};

/** Builds the route's outbound sender. Absent, the watch runs with outbound effects closed.
 *  Present, it is called once after acquire and its push is wrapped for per-effect verification. */
export type WatchSenderFactory = (input: WatchSenderFactoryInput) => WorkPush | undefined;

export type HostedWatchAuthorityInput = {
  route: HostedRoute;
  /** The team file the daemon loaded for this route; the only file the hosted watch may read. */
  teamFile: string;
  log(text: string): void;
  /** Injected until the direct sender's actual export lands. Absent keeps effects blocked. */
  sender?: WatchSenderFactory;
  /** The shared verifier for the captured root/session/epoch. Absent keeps effects blocked. */
  verifyAuthority?: WatchAuthorityVerifier;
  /** Test seams: the host's clock and liveness, and the loop's read sources. */
  now?: () => Date;
  alive?: (pid: number) => boolean;
  base?: WatchSources;
};

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** The route's binding, or why there is none. The state's watchdog record is the one `up` wrote;
 *  a hosted watch runs only for exactly that file and never stands in for an absent record. */
function bindingRefusal(stateDir: string, session: string, teamFile: string): string | undefined {
  let recorded: { file: string; pane?: string } | undefined;
  try {
    recorded = readState(stateDir).sessions[session]?.watchdog;
  } catch (error) {
    return `the session state cannot be read: ${textOf(error)}`;
  }
  if (!recorded) {
    return `the session "${session}" records no watchdog file binding; a hosted watch does not claim one`;
  }
  if (!sameFile(recorded.file, teamFile)) {
    return `the recorded watchdog file "${recorded.file}" is not this route's team file "${teamFile}"`;
  }
  return undefined;
}

function reportText(report: WatchHostReport): string {
  switch (report.phase) {
    case 'standby':
      if (report.why === 'held') {
        const holder = [
          report.holder.pid === undefined ? undefined : `pid ${String(report.holder.pid)}`,
          report.holder.epoch === undefined ? undefined : report.holder.epoch,
        ].filter((part) => part !== undefined).join(', ');
        return `standby, held${holder === '' ? '' : ` by ${holder}`}`;
      }
      if (report.why === 'refused') return `standby, refused: ${report.error}`;
      return `standby (${report.why})`;
    case 'draining':
      return `draining (${report.why}${report.error === undefined ? '' : `: ${report.error}`})`;
    case 'releasing':
      return `releasing (${report.why}${report.error === undefined ? '' : `: ${report.error}`})`;
    case 'released':
      return `released (${report.why})`;
    case 'authoritative':
      return 'authoritative';
  }
}

async function runAuthoritativeHost(
  input: HostedWatchAuthorityInput,
  stateDir: string,
  loop: HostedLoop,
  setPulse: (pulse: ((at: Date) => boolean) | undefined) => void,
): Promise<number> {
  const host = createWatchHost(stateDir, input.route.session, {
    now: input.now ?? (() => new Date()),
    ...(input.alive === undefined ? {} : { alive: input.alive }),
  });
  const loss = new AbortController();
  let lost = false;
  let epoch: string | undefined;

  const markLost = (why: string): void => {
    if (lost) return;
    lost = true;
    input.log(`root ${input.route.root}: the hosted watch's authority was lost: ${why}`);
    loss.abort();
  };

  // A pulse renews the captured record. Before acquire completes there is no authority to lose:
  // the beat only drives the same acquisition the acquire loop would, and the loop reads the
  // report itself. After acquire, any non-authoritative report is a loss, at once. The boolean
  // tells the host whether effects are still live, so it never settles a wait true after a loss.
  const pulse = (_at: Date): boolean => {
    if (lost) return false;
    try {
      if (epoch === undefined) {
        host.tick();
        return true;
      }
      const report = host.tick();
      if (report.phase !== 'authoritative') {
        markLost(reportText(report));
        return false;
      }
      return true;
    } catch (error) {
      if (epoch === undefined) {
        input.log(`root ${input.route.root}: the authority pulse failed before acquire: ${textOf(error)}`);
        return true;
      }
      markLost(`the authority pulse failed: ${textOf(error)}`);
      return false;
    }
  };

  // The per-effect gate: renew first, then the shared verifier for the captured identity.
  const verifyEffect = (): boolean => {
    if (lost) return false;
    let report: WatchHostReport;
    try {
      report = host.tick();
    } catch (error) {
      markLost(`the authority check failed: ${textOf(error)}`);
      return false;
    }
    if (report.phase !== 'authoritative') {
      markLost(reportText(report));
      return false;
    }
    if (epoch === undefined) {
      markLost('the captured epoch is not readable');
      return false;
    }
    let verdict: WatchAuthorityVerdict | undefined;
    try {
      verdict = input.verifyAuthority?.({ root: input.route.root, session: input.route.session, epoch });
    } catch (error) {
      markLost(`the shared watch authority verifier failed: ${textOf(error)}`);
      return false;
    }
    if (verdict === undefined) {
      markLost('no shared watch authority verifier is wired');
      return false;
    }
    if (!verdict.ok) {
      markLost(`the shared watch authority verifier refused: ${verdict.why}`);
      return false;
    }
    return true;
  };

  setPulse(pulse);
  try {
    // Acquire before the first pass. Only lock contention is retried, on the existing fixed tick.
    for (;;) {
      const report = host.start();
      if (report.phase === 'authoritative') {
        epoch = report.epoch;
        break;
      }
      if (report.phase === 'standby' && report.why === 'busy') {
        if (!(await loop.wait(HOSTED_AUTHORITY_TICK_MS))) return 0;
        continue;
      }
      if (report.phase === 'standby') {
        loop.standby(
          report.why === 'held'
            ? `a watch authority stands for the session "${input.route.session}" (${reportText(report)})`
            : `the watch authority was refused (${reportText(report)})`,
        );
        return 0;
      }
      return 0;
    }
    if (epoch === undefined) return 0;

    const proxy: HostedLoop = {
      signal: loss.signal,
      async wait(ms) {
        // A loss that happened during the pass must end the loop now: an aborted signal alone
        // never settles a wait registered after the abort.
        if (loss.signal.aborted) return false;
        const ok = await loop.wait(ms);
        if (!ok) return false;
        // Second gate before the next cycle: the beat that released this wait has already run,
        // and the captured authority must still be the record's.
        return verifyEffect();
      },
      cycled(at) {
        loop.cycled(at);
      },
      standby(why) {
        loop.standby(why);
      },
    };

    // Effects need both halves: the sender and the shared verifier. With either absent the watch
    // still reads and cycles, but no effect leaves this host.
    const canSend = input.sender !== undefined && input.verifyAuthority !== undefined;
    if (input.sender !== undefined && !canSend) {
      input.log(`root ${input.route.root}: the shared watch authority verifier is not wired; outbound effects stay closed`);
    }
    const built = canSend ? input.sender?.({ route: input.route, stateDir, epoch, verify: verifyEffect, log: input.log }) : undefined;
    if (canSend && built === undefined) {
      input.log(`root ${input.route.root}: the watch sender factory built no sender; outbound effects stay closed`);
    }
    const sender = built;
    const pushWork: WorkPush | undefined = sender === undefined ? undefined : async (request) => {
      if (!verifyEffect()) return { ok: false, refused: 'the watch authority is not current' };
      return sender(request);
    };

    const run = hostedWatchRun({
      route: input.route,
      log: input.log,
      ...(pushWork === undefined ? {} : { pushWork }),
      ...(input.base === undefined ? {} : { base: input.base }),
      // The record carries this runtime's pid; the shared loop must read it as its own.
      pid: process.pid,
    });
    return await run(proxy);
  } finally {
    setPulse(undefined);
    const stopped = host.stop();
    if (stopped.phase === 'releasing') {
      // Honest cleanup: busy or unreadable is not released, and the record does not age out
      // while this process lives. Say it once for the daemon's log and explicit recovery.
      input.log(
        `root ${input.route.root}: the watch authority release is pending (${reportText(stopped)}); `
          + 'the record is still present and is left for explicit recovery',
      );
      // The run is over but this daemon lives: retry ONLY the same epoch's release on the
      // existing fixed beat, never acquire, renew or send. Released or lost clears the pulse.
      setPulse(() => {
        let next: WatchHostReport;
        try {
          next = host.stop();
        } catch (error) {
          input.log(`root ${input.route.root}: the pending watch authority release failed: ${textOf(error)}`);
          return true;
        }
        if (next.phase !== 'releasing') setPulse(undefined);
        return next.phase !== 'releasing';
      });
    }
  }
}

/**
 * The daemon's route-bound hosted watch. With no recorded binding that names the route's own team
 * file, the watch is blocked: it starts standing down with the reason and runs nothing. Otherwise
 * it acquires the session's authority, renews it on every daemon beat, verifies every effect
 * against it, and releases only the captured epoch. Closing outbound effects and draining are its
 * loss behaviour; it never re-acquires, never hands off live, and never claims exactly-once.
 */
export function hostedWatchAuthority(input: HostedWatchAuthorityInput): HostedWatchBuild {
  const stateDir = dirname(input.teamFile);
  const refusal = bindingRefusal(stateDir, input.route.session, input.teamFile);
  if (refusal !== undefined) {
    input.log(`root ${input.route.root}: the hosted watch is blocked: ${refusal}`);
    return { run: async () => 0, effects: 'blocked', standby: refusal };
  }
  // The daemon's fixed tick reaches the lifecycle host through this seam; the run installs it
  // when it starts and clears it when it leaves.
  let pulse: ((at: Date) => boolean) | undefined;
  const canSend = input.sender !== undefined && input.verifyAuthority !== undefined;
  return {
    effects: canSend ? 'open' : 'blocked',
    tick: (at) => pulse?.(at),
    run: (loop) => runAuthoritativeHost(input, stateDir, loop, (next) => {
      pulse = next;
    }),
  };
}
