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
// Outbound effects stay blocked until both a sender factory and the shared verifier are injected,
// and the recorded effects state says blocked until the run has actually built its sender under
// the captured epoch; loss, standby and the end of the run close it again. This wrapper makes no
// exactly-once handoff claim and adds no queue, identity or WorkPush request change: drain holds
// ambiguous work for explicit recovery.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WatchSources } from '../commands/watch.ts';
import type { PaneProcesses } from '../herdr.ts';
import type { BrokerWorkSource } from '../idle_work.ts';
import { pidAlive, readState } from '../state.ts';
import { createWatchHost, type WatchHostReport } from '../watch/authority-lifecycle.ts';
import type { WorkPush } from '../watch/dispatch.ts';
import type { WatchAuthorityHolder } from '../watch/epoch-store.ts';
import { clearWatchHandover, readWatchHandover, writeWatchHandover } from '../watch/handover.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import { watchIdentity } from '../watch/pane.ts';
import type { HostedWatchBuild } from './host.ts';
import type { HostedRoute } from './routes.ts';
import type { HostedEffects } from './watch.ts';
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

/** Builds the route's outbound sender. When both the factory and the shared verifier are
 *  injected, the factory's result is required; absent either, effects stay blocked. */
export type WatchSenderFactory = (input: WatchSenderFactoryInput) => WorkPush;

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
  /** Reads the processes in one pane of this route's session, for proving that a recorded pane
   *  watch is the process in the pane its own record names (`watchIdentity`). Absent, or a pane
   *  this reader cannot read, is `unproven`: the holder is left to the ordinary stand-by and is
   *  never asked to hand over. No process is signalled by this transfer in any case. */
  processInfo?: (pane: string) => PaneProcesses | null;
  /**
   * The owning daemon's fresh per-seat liveness for this route's presence channels, keyed by
   * declared seat name. Absent (presence hosting off, or a test without one) means not known, so
   * that seat's native projection is held rather than believed.
   */
  presenceChannelHealthy?: (seat: string) => boolean;
  /**
   * The owning daemon's broker reader, when it hosts the broker. The watch counts a tracker
   * team's takeable work from the snapshot it returns; absent (broker hosting off, the default),
   * the reading stays explicitly unknown and no socket is opened.
   */
  brokerWork?: BrokerWorkSource;
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

/** What the standing holder is, when the session's record is a pane watch: a watch proven to be
 *  the process in its own recorded pane, or a pid that has just gone (the next beat acquires). */
type PaneHolder =
  | { kind: 'pane'; pid: number; heartbeat: string }
  | { kind: 'gone' };

/** The session's pane watch record when it is exactly the standing holder and its identity is
 *  proven: the state reader marks a pane watch record by the absence of an epoch
 *  (`src/state.ts`), and `watchIdentity` adds that the recorded pid is the process the record's
 *  own pane lists. An epoch record, a pid-less record, an unreadable pane and another process in
 *  the pane are all `undefined` and left to the ordinary stand-by: an unproven holder is never
 *  asked to hand over, and nothing is signalled in any case. A pid proven gone is the store's own
 *  dead-pid give-way racing this read, so the caller retries on the fixed beat. */
function paneHolderWatch(
  stateDir: string,
  session: string,
  holder: WatchAuthorityHolder,
  options: { alive(pid: number): boolean; processInfo(pane: string): PaneProcesses | null },
): PaneHolder | undefined {
  if (holder.pid === undefined || !Number.isInteger(holder.pid) || holder.pid <= 0) return undefined;
  let record: { pid?: number; heartbeat: string; pane?: string; epoch?: string } | undefined;
  try {
    record = readState(stateDir).sessions[session]?.watch;
  } catch {
    return undefined;
  }
  if (!record || record.epoch !== undefined) return undefined;
  const pid = record.pid;
  if (pid === undefined || pid !== holder.pid) return undefined;
  const identity = watchIdentity({ pid, ...(record.pane === undefined ? {} : { pane: record.pane }) }, options);
  if (identity.kind === 'gone') return { kind: 'gone' };
  if (identity.kind === 'unproven') return undefined;
  return { kind: 'pane', pid, heartbeat: record.heartbeat };
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
  setEffects: (effects: HostedEffects) => void,
): Promise<number> {
  const clock = input.now ?? (() => new Date());
  const alive = input.alive ?? pidAlive;
  const processInfo = input.processInfo
    ?? ((pane: string) => input.base?.processes?.(pane, input.route.session) ?? null);
  const host = createWatchHost(stateDir, input.route.session, { now: clock, alive });
  const loss = new AbortController();
  let lost = false;
  let epoch: string | undefined;
  // A live pane watch holds the route: the transfer's state. `beat` is the pane record's own
  // last heartbeat, and a change means that watch completed another pass after being asked.
  let handover: { requestedAt: string; beat: string; passes: number } | undefined;
  let wroteHandover = false;

  const fail = (why: string): void => {
    if (lost) return;
    lost = true;
    setEffects('blocked');
    input.log(`root ${input.route.root}: the hosted watch cannot continue: ${why}`);
    loss.abort();
  };

  const markLost = (why: string): void => {
    if (lost) return;
    lost = true;
    setEffects('blocked');
    input.log(`root ${input.route.root}: the hosted watch's authority was lost: ${why}`);
    loss.abort();
  };

  /** The route's own binding, re-read from state: a cleared, repointed or unreadable record
   *  ends the run. The binding is never rewritten here. */
  const bindingLoss = (): string | undefined =>
    bindingRefusal(stateDir, input.route.session, input.teamFile);

  // A pulse renews the captured record and rechecks the route's binding. Before acquire
  // completes there is no authority to lose: the beat only drives the same acquisition the
  // acquire loop would, and the loop reads the report itself; a binding that changed or a pulse
  // that failed there ends the run rather than retrying forever. After acquire, any
  // non-authoritative report or changed binding is a loss, at once. The boolean tells the host
  // whether effects are still live, so it never settles a wait true after a loss.
  const pulse = (_at: Date): boolean => {
    if (lost) return false;
    try {
      const changed = bindingLoss();
      if (changed !== undefined) {
        if (epoch === undefined) fail(`the watchdog file binding changed: ${changed}`);
        else markLost(`the watchdog file binding changed: ${changed}`);
        return false;
      }
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
      if (epoch === undefined) fail(`the authority pulse failed before acquire: ${textOf(error)}`);
      else markLost(`the authority pulse failed: ${textOf(error)}`);
      return false;
    }
  };

  // The lifecycle gate: renew the captured record and answer whether this host still holds a
  // fresh authority. It is enough to continue a quiet sweep; it admits no effect.
  const checkOwn = (): boolean => {
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
    return true;
  };

  // The per-effect gate: renew first, then the shared verifier for the captured identity. An
  // absent verifier keeps effects closed without draining the read-only loop.
  //
  // Availability limitation: the shared verifier reads the state under its own lock, and a busy
  // lock is reported as a refusal. This wrapper cannot tell that transient contention from a real
  // refusal, so it fails closed and drains rather than retrying or parsing the verifier's words.
  // A busy state folder at the moment of an effect therefore costs the watch its run; a typed
  // busy verdict in the verifier is the later fix, not a why-string heuristic here.
  const verifyEffect = (): boolean => {
    if (!checkOwn()) return false;
    if (epoch === undefined) return false;
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
    // A request left by a daemon that is not this process was never answered: this run either
    // writes its own or stands by. Leaving it would keep asking for a transfer nobody wants.
    const leftover = readWatchHandover(stateDir);
    if (leftover.kind === 'request' && leftover.request.pid !== process.pid) clearWatchHandover(stateDir);
    // Acquire before the first pass. Lock contention is retried on the existing fixed tick, and
    // so is a live pane watch once it has been asked to hand over; the route's binding is re-read
    // before every attempt so a record cleared or repointed while this host waited stands the
    // watch down instead of acquiring on a stale claim.
    for (;;) {
      const changed = bindingLoss();
      if (changed !== undefined) {
        fail(`the watchdog file binding changed: ${changed}`);
        return 0;
      }
      const report = host.start();
      if (report.phase === 'authoritative') {
        epoch = report.epoch;
        if (wroteHandover) {
          clearWatchHandover(stateDir);
          wroteHandover = false;
        }
        break;
      }
      if (report.phase === 'standby' && report.why === 'busy') {
        if (!(await loop.wait(HOSTED_AUTHORITY_TICK_MS))) return 0;
        continue;
      }
      if (report.phase === 'standby' && report.why === 'held') {
        // A live pane watch is the standing holder: ask it to leave through its own loop and
        // keep the fixed beat until it does. Two of its own completed passes while the request
        // stands mean it is not going to leave — an older watch that never reads the request, or
        // a record whose pid now names another process — and the host stands by honestly rather
        // than waiting forever. Nothing is signalled either way. Every other holder (an
        // authority epoch, a pid-less record, an unreadable one) stands exactly as before and is
        // never asked: an unreadable holder is not permission for a transfer.
        const pane = paneHolderWatch(stateDir, input.route.session, report.holder, { alive, processInfo });
        if (pane !== undefined && pane.kind === 'gone') {
          // The pid the store still named has gone between its own check and this read: the next
          // beat's acquire finds only a dead pid and takes the record.
          if (!(await loop.wait(HOSTED_AUTHORITY_TICK_MS))) return 0;
          continue;
        }
        if (pane !== undefined && pane.kind === 'pane') {
          const at = clock();
          if (handover === undefined) {
            handover = { requestedAt: at.toISOString(), beat: pane.heartbeat, passes: 0 };
          } else if (pane.heartbeat !== handover.beat) {
            handover.beat = pane.heartbeat;
            handover.passes += 1;
          }
          if (handover.passes >= 2) {
            clearWatchHandover(stateDir);
            wroteHandover = false;
            input.log(
              `root ${input.route.root}: the pane watch did not hand over after ${String(handover.passes)} passes; standing by`,
            );
            loop.standby(`a pane watch holds the session "${input.route.session}" and did not hand over`);
            return 0;
          }
          try {
            writeWatchHandover(stateDir, {
              root: input.route.root,
              session: input.route.session,
              pid: process.pid,
              now: at,
              requestedAt: handover.requestedAt,
            });
            if (!wroteHandover) {
              wroteHandover = true;
              input.log(`root ${input.route.root}: a live pane watch holds the session; asked it to hand over`);
            }
          } catch (error) {
            loop.standby(`the hand-over request could not be written (${textOf(error)})`);
            return 0;
          }
          if (!(await loop.wait(HOSTED_AUTHORITY_TICK_MS))) {
            clearWatchHandover(stateDir);
            return 0;
          }
          continue;
        }
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
        // and the captured authority must still be the record's. This is the liveness gate
        // only; admitting an effect needs the shared verifier as well.
        return checkOwn();
      },
      cycled(at) {
        loop.cycled(at);
      },
      standby(why) {
        // A standing-down watch emits nothing from here on.
        setEffects('blocked');
        loop.standby(why);
      },
    };

    // Effects need both halves: the sender and the shared verifier. With either absent the watch
    // still reads and cycles under its captured authority, but no effect leaves this host.
    const canSend = input.sender !== undefined && input.verifyAuthority !== undefined;
    if (input.sender !== undefined && !canSend) {
      input.log(`root ${input.route.root}: the shared watch authority verifier is not wired; outbound effects stay closed`);
    }
    let sender: WorkPush | undefined;
    if (canSend && input.sender !== undefined) {
      sender = input.sender({ route: input.route, stateDir, epoch, verify: verifyEffect, log: input.log });
    }
    const pushWork: WorkPush | undefined = sender === undefined ? undefined : async (request) => {
      if (!verifyEffect()) return { ok: false, refused: 'the watch authority is not current' };
      return sender(request);
    };
    // Open only now: the sender exists under this captured epoch. Until here the recorded state
    // said blocked, and it says blocked again the moment this host stops holding the authority.
    if (sender !== undefined) setEffects('open');

    const run = hostedWatchRun({
      route: input.route,
      log: input.log,
      ...(pushWork === undefined ? {} : { pushWork }),
      ...(input.base === undefined ? {} : { base: input.base }),
      ...(input.presenceChannelHealthy === undefined
        ? {}
        : { presenceChannelHealthy: input.presenceChannelHealthy }),
      ...(input.brokerWork === undefined ? {} : { brokerWork: input.brokerWork }),
      // The record carries this runtime's pid; the shared loop must read it as its own.
      pid: process.pid,
    });
    // Before the first pass: a binding that changed between acquire and this line drains now.
    const changed = bindingLoss();
    if (changed !== undefined) {
      markLost(`the watchdog file binding changed: ${changed}`);
      return 0;
    }
    return await run(proxy);
  } finally {
    setPulse(undefined);
    setEffects('blocked');
    // A request this run wrote is withdrawn with it: an ended run is no longer asking, and a
    // request left behind could stand a live pane watch down for a transfer nobody makes.
    if (wroteHandover) clearWatchHandover(stateDir);
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
  // Effects start closed and open only once the run has built its sender under the captured
  // epoch. The recorded state is read through this getter on every read, so it can never claim a
  // send this host cannot make: before acquire, on standby, on loss and after the run all read
  // blocked.
  let effects: HostedEffects = 'blocked';
  return {
    effects: () => effects,
    tick: (at) => pulse?.(at),
    run: (loop) => runAuthoritativeHost(input, stateDir, loop, (next) => {
      pulse = next;
    }, (next) => {
      effects = next;
    }),
  };
}
