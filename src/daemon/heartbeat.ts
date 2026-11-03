// The daemon loop's heartbeat as a catalogue policy (`daemon.heartbeat`, ADR D6): how often the
// daemon refreshes its state record, probes its hosted endpoints and runs the fallback sweep that
// still rides the beat. The beat the 0.5.12 daemon ran hard-coded (5 s) is the release default,
// and the word lives in the chains of the checkouts the daemon hosts — the same place the backlog
// knobs live. One process serves every hosted checkout and one timer beats for them all, so the
// daemon runs the shortest effective word among its roots: every root's word is an upper bound on
// the beat, no hosted team loosens another's, and a longer beat must be declared at a level every
// hosted checkout shares. A root whose chain cannot be read keeps the release default as its word
// and names why, because the beat is liveness and never stops on a word no level could prove.
import { projectIdOfTeam } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { DAEMON_HEARTBEAT_SECONDS, loadAndResolvePolicyChain } from '../policy/index.ts';

/** A root the reader accepts: an already-validated pair, or a bare path validated here the way
 *  the daemon's own roots loop validates one. */
export type HeartbeatRootInput = { root: string; team: TeamFile } | string;

/** The heartbeat in force: whole seconds, and why a root's word could not be read when one could
 *  not. `unknown` never stops the beat; it is the daemon log's one line, nothing more. */
export type DaemonHeartbeatWord = { seconds: number; unknown: string | null };

function resolvedWord(root: string, team: TeamFile, home: string | undefined, now: Date): DaemonHeartbeatWord {
  const release = DAEMON_HEARTBEAT_SECONDS.release;
  try {
    const resolved = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity,
        projectId: home === undefined ? null : projectIdOfTeam(home, team, root),
        teamRoot: root,
        team,
      },
      { now, upToLevel: 'team' },
    );
    if (!resolved.ok) {
      const why = resolved.refusals.map((refusal) => refusal.message).join('; ');
      return { seconds: release, unknown: why === '' ? 'the policy chain could not be read' : why };
    }
    const value = resolved.policies['daemon.heartbeat']?.value;
    if (typeof value !== 'number') {
      return { seconds: release, unknown: 'daemon.heartbeat did not resolve to a number' };
    }
    return { seconds: value, unknown: null };
  } catch (error) {
    return { seconds: release, unknown: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The shortest heartbeat word the given roots declare, each read to the team level like the
 * daemon's other knobs. A bare path whose team cannot be read contributes nothing: the daemon's
 * own roots loop reports that root, and a word it could not carry a chain to is not a word.
 */
export function daemonHeartbeatSeconds(roots: HeartbeatRootInput[], home: string | undefined, now: Date): DaemonHeartbeatWord {
  const release = DAEMON_HEARTBEAT_SECONDS.release;
  const unknowns: string[] = [];
  let seconds: number | null = null;
  for (const entry of roots) {
    if (typeof entry === 'string') {
      const loaded = readTeamConfig(entry, { home });
      if (!loaded.ok) continue;
      const word = resolvedWord(loaded.root, loaded.team, home, now);
      if (word.unknown !== null) unknowns.push(`${entry}: ${word.unknown}`);
      if (seconds === null || word.seconds < seconds) seconds = word.seconds;
      continue;
    }
    const word = resolvedWord(entry.root, entry.team, home, now);
    if (word.unknown !== null) unknowns.push(`${entry.root}: ${word.unknown}`);
    if (seconds === null || word.seconds < seconds) seconds = word.seconds;
  }
  if (seconds === null) return { seconds: release, unknown: null };
  return { seconds, unknown: unknowns.length > 0 ? unknowns.join('; ') : null };
}

export type HeartbeatPolicyInput = {
  /** The injected test beat, in milliseconds. When set, no policy is read and no word is
   *  reported: the seam is the whole beat, exactly as before the word existed. */
  seamMs: number | null;
  /** The roots whose words decide the first resolution, at start: the bare paths the daemon was
   *  asked to host, before any of them is validated. */
  initialRoots: HeartbeatRootInput[];
  /** The roots whose words decide the beat on every refresh: the pairs the daemon validated,
   *  with a fallback to the start set while validation is still running. */
  roots: () => HeartbeatRootInput[];
  home: string | undefined;
  now: () => Date;
  log(text: string): void;
};

export type HeartbeatPolicy = {
  /** The beat the timer runs at, in milliseconds. */
  ms(): number;
  /** The policy word behind the beat, in whole seconds; null when the seam owns the beat. */
  seconds(): number | null;
  /** Re-reads the words and, when the beat changed, says so through the log. Called on the
   *  housekeeping pass, beside the sweep's own knob reads. */
  refresh(): void;
};

/**
 * The daemon's heartbeat word and its re-reads. The first resolution happens here, at start,
 * before any timer is armed; `refresh` is the reload — the daemon re-reads the words on its
 * housekeeping pass, so a signed word lands within that pass plus one beat and a change re-arms
 * the timer without a restart.
 */
export function createHeartbeatPolicy(input: HeartbeatPolicyInput): HeartbeatPolicy {
  const first = input.seamMs === null ? daemonHeartbeatSeconds(input.initialRoots, input.home, input.now()) : null;
  let seconds = first?.seconds ?? null;
  let ms = input.seamMs ?? (first?.seconds ?? DAEMON_HEARTBEAT_SECONDS.release) * 1000;
  if (first !== null && first.unknown !== null) input.log(`daemon heartbeat: kept ${String(first.seconds)}s; ${first.unknown}`);
  return {
    ms: () => ms,
    seconds: () => seconds,
    refresh(): void {
      if (input.seamMs !== null) return;
      const roots = input.roots();
      if (roots.length === 0) return;
      const word = daemonHeartbeatSeconds(roots, input.home, input.now());
      const next = word.seconds * 1000;
      if (next === ms) return;
      input.log(`daemon heartbeat: ${String(word.seconds)}s (was ${String(ms / 1000)}s)${word.unknown === null ? '' : `; ${word.unknown}`}`);
      seconds = word.seconds;
      ms = next;
    },
  };
}
