// What the watch decides about swaps by itself (Policies rule 11, OD-20261019-02): the rule's
// own breaching seats are queued without a caller, and the wait a record is given is the
// `swap-wait-seconds` chain resolved for that seat. `team swap queue` reads the same wait, so a
// record the owner queues and one the watch queues are the same record.

import { join } from 'node:path';
import { resolveProjectIdForTeam } from '../commands/policy.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { logLine } from '../log.ts';
import { loadAndResolvePolicyChain, logExpiredPoliciesOnce } from '../policy/index.ts';
import { findAgent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readState, type QueuedSwap } from '../state.ts';
import type { ModelRulePass } from '../watch/check.ts';
import { enqueueSwap, queuedSwap, swapModelOf } from './queue.ts';

/** What `status` and the queue print as the wait: the boundary the watch observes. */
export const WAIT_FOR = "the seat's boundary (quiet, no turn, no dialog, no lease, no work drop)";

/** The wait in force for this seat: the resolved `swap-wait-seconds` chain, in seconds. */
export function waitSecondsFor(
  home: string,
  root: string,
  team: TeamFile,
  seat: Seat,
  now: Date,
): { seconds: number } | { why: string } {
  const agent = findAgent(home, { team: teamIdOf(root), seat: seat.name });
  const resolved = loadAndResolvePolicyChain(
    {
      home,
      entity: team.entity,
      projectId: resolveProjectIdForTeam(home, root, team),
      teamRoot: root,
      team,
      agentId: agent?.id ?? null,
      seat,
    },
    { now, upToLevel: 'seat' },
  );
  logExpiredPoliciesOnce(join(root, '.agents'), resolved.expired, now);
  if (!resolved.ok) return { why: resolved.refusals.map((refusal) => refusal.message).join('; ') };
  const value = resolved.policies['swap-wait-seconds']?.value;
  return typeof value === 'number' ? { seconds: value } : { why: 'swap-wait-seconds did not resolve to a number' };
}

export type RuleQueueInput = {
  dir: string;
  root: string;
  home: string;
  team: TeamFile;
  /** The rule as this pass read it; `null` when the team declares no entity. */
  rule: ModelRulePass;
  /** The words the log carries as the caller: `the watch`. */
  by: string;
  now(): Date;
};

/**
 * Queues the rule's breaching seats that have no record yet, one record per seat. A seat with a
 * queued swap is left alone — the record's wait is not restarted every pass, and a target the
 * owner or a lead chose is not replaced by the rule's proposal. A breach with no proposal is
 * reported by the check, never queued: nothing is invented. A signed-off or human seat is left
 * where the file put it. Returns the seats this pass queued, for the caller's own line.
 */
export function queueRuleBreaches(input: RuleQueueInput): Array<[string, QueuedSwap]> {
  if (input.rule === null || !input.rule.ok || input.rule.rule === '') return [];
  const state = readState(input.dir);
  const queued: Array<[string, QueuedSwap]> = [];
  const names = [...input.rule.breaches.keys()].sort();
  for (const name of names) {
    const breach = input.rule.breaches.get(name);
    if (breach === undefined || breach.recipe === undefined) continue;
    if (queuedSwap(state, name)) continue;
    const seat = input.team.seats.find((candidate) => candidate.name === name);
    if (seat === undefined || seat.stopped || seat.human) continue;
    const now = input.now();
    const wait = waitSecondsFor(input.home, input.root, input.team, seat, now);
    if ('why' in wait) {
      logLine(input.dir, 'swap', input.by, `${name}: the model rule's swap was not queued (${wait.why})`, now);
      continue;
    }
    const record = enqueueSwap(input.dir, {
      seat: name,
      from: swapModelOf(seat),
      to: {
        cli: breach.recipe.recipe.cli,
        vendor: breach.recipe.recipe.vendor,
        model: breach.recipe.recipe.model,
        version: breach.recipe.recipe.version,
        display: breach.recipe.recipe.display,
        launch: breach.recipe.recipe.launch,
        ...(breach.recipe.recipe.modelFrom ? { modelFrom: breach.recipe.recipe.modelFrom } : {}),
        ...(breach.recipe.recipe.effort ? { effort: breach.recipe.recipe.effort } : {}),
        ...(breach.recipe.recipe.account ? { account: breach.recipe.recipe.account } : {}),
      },
      reason: 'model-rule',
      waitSeconds: wait.seconds,
      waitFor: WAIT_FOR,
      rule: input.rule.rule,
      now,
    });
    logLine(
      input.dir,
      'swap',
      input.by,
      `${name}: queued by the model rule ${input.rule.rule}: ${record.from.vendor} ${record.from.model} -> ${record.to.vendor} ${record.to.model} (runs by ${record.deadline})`,
      now,
    );
    queued.push([name, record]);
  }
  return queued;
}
