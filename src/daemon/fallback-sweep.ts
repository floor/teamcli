// The daemon's fallback sweep: one pass over every checkout the machine daemon hosts, firing the
// main escalation for episodes whose durable `dueAt` has passed. It adds no timer, process or
// socket of its own — the existing heartbeat calls it — and keeps no state: the marker's
// `dueAt`, its `escalatedAt` and a delivery's cancellation stay authoritative, and `escalateDue`
// remains the one reader of the signed delay and the one writer of the event.
//
// A pass is non-blocking by design (`lockWaitMs: 0`): the key lock of a message another live
// holder is working is deferred to the next existing heartbeat tick, never waited on, so one busy
// message can neither stall the daemon's event loop — and with it health and delivery — nor emit a
// refusal or a repeated event. The other roots and keys in the same pass keep moving.
//
// A pass runs on a caller-free `EscalationContext`. A daemon fires markers a host already
// recorded, so it has no verified seat to pass and must not invent one: the event's sender is the
// tag fixed in the marker at its first fact, and `noteTransport` — the transport path — still
// requires a full context with the verified caller.
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { escalateDue, type EscalationReport } from '../send/fallback-events.ts';

/** A hosted checkout and the team file the daemon validated when it started. */
export type SweepRoot = { root: string; team: TeamFile };

/** A root given to a pass: an already-validated pair, or a bare path this module validates. */
export type SweepRootInput = SweepRoot | string;

export type SweepRootResult = {
  root: string;
  /** The pass over this root, or null when the root was not swept. */
  report: EscalationReport | null;
  /** Why the root was skipped; null when the pass ran. */
  why: string | null;
};

export type FallbackSweepResult = {
  at: string;
  roots: SweepRootResult[];
};

/**
 * Sweep every hosted root once at `input.now()`. A bare root whose team file does not validate
 * is refused by name and swept not at all — a root the daemon never validated contributes
 * nothing. A throw inside one root's pass is reported for that root and never stops another root
 * or the heartbeat that called this. Each pass hands `escalateDue` that root's validated team, so
 * the delay reader resolves that root's chain, and no `Caller`, so no identity is fabricated. The
 * key lock is taken with `waitMs: 0`, so a busy episode is deferred to the next tick, not waited on.
 */
export function sweepFallbackEscalations(input: {
  home: string;
  roots: readonly SweepRootInput[];
  now: () => Date;
}): FallbackSweepResult {
  const at = input.now();
  const roots: SweepRootResult[] = [];
  for (const given of input.roots) {
    let entry: SweepRoot;
    if (typeof given === 'string') {
      const loaded = readTeamConfig(given, { home: input.home });
      if (!loaded.ok) {
        roots.push({
          root: given,
          report: null,
          why: loaded.errors[0]?.message ?? 'the team file cannot be read',
        });
        continue;
      }
      entry = { root: loaded.root, team: loaded.team };
    } else {
      entry = given;
    }
    try {
      const report = escalateDue(
        { team: entry.team, root: entry.root, home: input.home, now: input.now },
        { at, lockWaitMs: 0 },
      );
      roots.push({ root: entry.root, report, why: null });
    } catch (error) {
      roots.push({
        root: entry.root,
        report: null,
        why: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { at: at.toISOString(), roots };
}
