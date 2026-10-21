// The twelve transition signals (draft 6 §2.1) and the record selector each one reads.
// A bus event kind is never a signal; the daemon's translation is out of slices 0-1.

export const SIGNALS = [
  'pr-opened',
  'pr-merged',
  'sha-verified',
  'gate-passed',
  'approved',
  'tag-outcome',
  'publish-outcome',
  'deploy-outcome',
  'time-reached',
  'goals-set',
  'diverged',
  'accepted',
] as const;

export type SignalName = (typeof SIGNALS)[number];

/**
 * What a signal (or a guard's `reads`) selects among evidence. `operation` narrows a generic
 * `outcome` record; `result: 'done'` is the success requirement an outcome signal carries.
 */
export type RecordSelector = { type: string; operation?: string; result?: 'done' };

/**
 * The frozen signal → selector table (B5 §6.3). `approved` names an approval record
 * provisionally (U9: the type's name goes to Kernel amendment 04); dry never verifies it.
 */
export const SIGNAL_RECORD_TYPES: Readonly<Record<SignalName, RecordSelector>> = {
  'pr-opened': { type: 'step' },
  'pr-merged': { type: 'outcome', operation: 'merge', result: 'done' },
  'sha-verified': { type: 'outcome', operation: 'verify', result: 'done' },
  'gate-passed': { type: 'gate' },
  'approved': { type: 'approval' },
  'tag-outcome': { type: 'outcome', operation: 'release-tag', result: 'done' },
  'publish-outcome': { type: 'outcome', operation: 'release-publish', result: 'done' },
  'deploy-outcome': { type: 'outcome', operation: 'site-deploy', result: 'done' },
  'time-reached': { type: 'timer' },
  'goals-set': { type: 'outcome', operation: 'goals-session', result: 'done' },
  'diverged': { type: 'review' },
  'accepted': { type: 'review' },
};

const SIGNAL_SET: ReadonlySet<string> = new Set<string>(SIGNALS);

export function isSignalName(value: unknown): value is SignalName {
  return typeof value === 'string' && SIGNAL_SET.has(value);
}
