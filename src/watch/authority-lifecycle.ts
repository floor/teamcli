// The host lifecycle on top of the authority store: standby, authoritative, draining and the
// honest release-pending state. The store owns compare-and-set; this module owns only what the
// host does with the answers, and it never schedules, sleeps, sends or wires itself into a
// command. The caller drives a fixed heartbeat tick.
//
// Acquire is one attempt: `held` stands for the run unless the caller explicitly restarts the
// host, `busy` is lock contention retried on the next fixed tick, and a refused read is reported
// and never retried silently. Acquire never writes except on `acquired`.
//
// Renew is one compare-and-set per tick against the captured epoch. A renewed tick advances the
// reported heartbeat. A busy tick changes nothing and is re-checked against the same fixed window
// with the captured heartbeat: while the proof is fresh the host stays authoritative, and the
// moment it lapses the host drains instead of staying authoritative indefinitely. Busy is never
// permission to keep acting, and an unexpected renew, read or clock error drains with the reason
// rather than leaving the host authoritative or throwing out of the tick. A lost renew drains the
// host at once, and the run never acquires again. Per-effect verification is still required above
// this module; the host report is not proof.
//
// Release compares the same captured epoch and pid. A busy or unreadable release is reported as
// `releasing`, never as done: the record is not claimed to age out and a same-pid stale record is
// still refused by the store, so an old process that lives on cannot be replaced as dead. A
// later tick retries the SAME epoch release only — never acquire, renew or send. A whole-daemon
// shutdown may leave that pending record standing, and the report says so for restart recovery.
//
// Drain does not claim exactly-once. Owned in-flight work may finish under its own fencing;
// ambiguous work is held for explicit recovery, and a new host never resends it without
// persistent episode evidence of its own.

import {
  acquireWatchAuthority,
  releaseWatchAuthority,
  renewWatchAuthority,
  type WatchAuthorityHolder,
} from './epoch-store.ts';
import { watchEpochCurrent } from './epoch.ts';

export type WatchHostPhase = 'standby' | 'acquiring' | 'authoritative' | 'draining' | 'releasing' | 'released';

export type WatchHostReport =
  | { phase: 'standby'; why: 'not-started' }
  | { phase: 'standby'; why: 'held'; holder: WatchAuthorityHolder }
  | { phase: 'standby'; why: 'busy' }
  | { phase: 'standby'; why: 'refused'; error: string }
  | { phase: 'authoritative'; epoch: string; renewedAt: string }
  | { phase: 'draining'; epoch: string; why: 'lost'; error?: string }
  | { phase: 'releasing'; epoch: string; why: 'busy' | 'refused'; error?: string }
  | { phase: 'released'; epoch: string; why: 'released' | 'lost' };

export type WatchHostOptions = { now: () => Date; alive?: (pid: number) => boolean };

export type WatchHost = {
  /** One acquire attempt from standby; an explicit restart for a held record. */
  start(): WatchHostReport;
  /** One fixed-heartbeat step: renew, retry a busy acquire, or retry a pending release. */
  tick(): WatchHostReport;
  /** One release attempt for the captured epoch, or the terminal report for a lost host. */
  stop(): WatchHostReport;
  /** This host's own last report; no store call. */
  report(): WatchHostReport;
  phase(): WatchHostPhase;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWatchHost(dir: string, session: string, options: WatchHostOptions): WatchHost {
  let phase: WatchHostPhase = 'standby';
  let epoch: string | undefined;
  let renewedAt: string | undefined;
  let current: WatchHostReport = { phase: 'standby', why: 'not-started' };

  const settle = (report: WatchHostReport): WatchHostReport => {
    phase = report.phase;
    current = report;
    return report;
  };

  const acquire = (): WatchHostReport => {
    let result;
    try {
      result = acquireWatchAuthority(dir, session, {
        now: options.now(),
        ...(options.alive ? { alive: options.alive } : {}),
      });
    } catch (error) {
      return { phase: 'standby', why: 'refused', error: errorText(error) };
    }
    if (result.kind === 'acquired') {
      epoch = result.authority.epoch;
      renewedAt = result.authority.heartbeat;
      return { phase: 'authoritative', epoch, renewedAt };
    }
    if (result.kind === 'held') return { phase: 'standby', why: 'held', holder: result.holder };
    return { phase: 'standby', why: 'busy' };
  };

  const release = (captured: string): WatchHostReport => {
    let result;
    try {
      result = releaseWatchAuthority(dir, session, captured);
    } catch (error) {
      return { phase: 'releasing', epoch: captured, why: 'refused', error: errorText(error) };
    }
    if (result.kind === 'released') return { phase: 'released', epoch: captured, why: 'released' };
    if (result.kind === 'busy') return { phase: 'releasing', epoch: captured, why: 'busy' };
    return { phase: 'released', epoch: captured, why: 'lost' };
  };

  return {
    start(): WatchHostReport {
      if (phase !== 'standby') return current;
      return settle(acquire());
    },

    tick(): WatchHostReport {
      if (phase === 'authoritative' && epoch !== undefined && renewedAt !== undefined) {
        let result;
        let now: Date;
        try {
          now = options.now();
          result = renewWatchAuthority(dir, session, epoch, { now });
        } catch (error) {
          // The record or the clock cannot be read, so the captured proof cannot be verified.
          // Draining is the only safe report: no external effect continues on unproven authority.
          return settle({ phase: 'draining', epoch, why: 'lost', error: errorText(error) });
        }
        if (result.kind === 'renewed') {
          renewedAt = result.authority.heartbeat;
          return settle({ phase: 'authoritative', epoch, renewedAt });
        }
        if (result.kind === 'busy') {
          // The busy attempt wrote nothing, so the captured heartbeat is still the proof. It is
          // judged against the same fixed window: fresh keeps the host authoritative, lapsed
          // drains it now instead of leaving it authoritative indefinitely.
          const proof = { pid: process.pid, epoch, heartbeat: renewedAt };
          if (watchEpochCurrent(proof, now.getTime())) return current;
          return settle({ phase: 'draining', epoch, why: 'lost' });
        }
        return settle({ phase: 'draining', epoch, why: 'lost' });
      }
      if (phase === 'releasing' && epoch !== undefined) return settle(release(epoch));
      if (phase === 'standby' && current.phase === 'standby' && current.why === 'busy') return settle(acquire());
      return current;
    },

    stop(): WatchHostReport {
      if ((phase === 'authoritative' || phase === 'releasing') && epoch !== undefined) {
        return settle(release(epoch));
      }
      if (phase === 'draining' && epoch !== undefined) return settle({ phase: 'released', epoch, why: 'lost' });
      return current;
    },

    report(): WatchHostReport {
      return current;
    },

    phase(): WatchHostPhase {
      return phase;
    },
  };
}
