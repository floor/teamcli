// The transition signals and the record selector each one reads. The first twelve are draft 6
// §2.1's accepted set; the last eleven are the workflow MVP's seat interactions
// (workflow-mvp-spec-draft-4 §2.1.1, docs b0f48b3). A bus event kind is never a signal; the
// daemon's translation is out of slices 0-1.

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
  'task-ready',
  'acknowledged',
  'step-done',
  'step-blocked',
  'seat-down',
  'merge-observed',
  'install-recorded',
  'redispatch',
  'lead-word',
  'step-failed',
  'lead-stop',
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
  'task-ready': { type: 'task' },
  'acknowledged': { type: 'message' },
  'step-done': { type: 'step' },
  'step-blocked': { type: 'step' },
  'seat-down': { type: 'seat-state' },
  'merge-observed': { type: 'outcome', operation: 'merge', result: 'done' },
  'install-recorded': { type: 'outcome', operation: 'install', result: 'done' },
  'redispatch': { type: 'dispatch' },
  'lead-word': { type: 'message' },
  'step-failed': { type: 'refusal' },
  'lead-stop': { type: 'message' },
};

const SIGNAL_SET: ReadonlySet<string> = new Set<string>(SIGNALS);

export function isSignalName(value: unknown): value is SignalName {
  return typeof value === 'string' && SIGNAL_SET.has(value);
}
