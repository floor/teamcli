import { ALWAYS_ON, CHECK_NAMES } from '../../watch/check.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { TeamFile } from '../types.ts';
import { measureSchema, DURATION } from './units.ts';
import type { Section } from './section.ts';

/** What the watch section hands the rest of the file: its value, and whether the old marks key was set. */
export interface Watched {
  watch: TeamFile['watch'];
  /** `watch.quota_marks` was written: `budgets.marks` warns that it replaces it. */
  legacyMarks: boolean;
}

export const watch: Section = {
  name: 'watch',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return readWatch(entry, ctx.check);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      interval: measureSchema(DURATION),
      idle_first: {
        ...measureSchema(DURATION),
        description: 'how long an idle seat waits before its lead is told; a team may tighten it, never loosen it',
      },
      idle_owner: {
        ...measureSchema(DURATION),
        description: 'how long after that the owner is told, once per idle period; a team may tighten it, never loosen it',
      },
      blind_after: {
        ...measureSchema(DURATION),
        description: 'how long a seat no source has heard from reads unknown before it is blind; a team may tighten it, never loosen it',
      },
      idle_repeat: {
        ...measureSchema(DURATION),
        description: 'how often to repeat an idle report while a seat stays idle; off unless set',
      },
      team_idle: measureSchema(DURATION),
      nudge_wait: measureSchema(DURATION),
      unsent_after: measureSchema(DURATION),
      unread_after: {
        ...measureSchema(DURATION),
        description: 'how long a message may go without the seat\'s read receipt before the watch retries it once; the report to the sender and the lead follows at twice this window',
      },
      nudge: {
        type: 'string',
        minLength: 1,
        description: 'text the work drop asks each idle worker to read after idle_first; the fixed watch line when omitted',
      },
      queue_dir: {
        type: 'string',
        minLength: 1,
        description: 'directory containing <seat>.md queues; relative to the project root, absolute, or ~/…',
      },
      quota_marks: {
        type: 'array',
        items: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
        deprecated: true,
        $comment: 'now budgets.marks, and still read',
      },
      checks: {
        type: 'object',
        propertyNames: { enum: CHECK_NAMES.filter((name) => !ALWAYS_ON.includes(name)) },
        additionalProperties: { const: 'off' },
        $comment: 'the six that always run (attention, missing, model-drift, model-rule, prompt-escalation, approval) are refused here too',
      },
    },
  },
};

/**
 * The watch values a file that sets none runs with — and, since the section is the owner's, the
 * values a file runs with until the owner approves what it sets instead.
 */
export function defaultWatch(): TeamFile['watch'] {
  return {
    interval: 120,
    idleFirst: 300,
    idleOwner: 900,
    blindAfter: 300,
    teamIdle: 600,
    nudgeWait: 600,
    unsentAfter: 60,
    unreadAfter: 600,
    quotaMarks: [50, 75, 90],
    checks: [],
  };
}

function readWatch(entry: YamlEntry | undefined, check: Check): Watched {
  const fields = check.fields(entry?.value, 'watch', [
    'interval', 'idle_first', 'idle_owner', 'blind_after', 'idle_repeat', 'team_idle', 'nudge_wait', 'unsent_after', 'unread_after', 'nudge', 'queue_dir', 'quota_marks', 'checks',
  ]);
  const time = (name: string, fallback: number) =>
    check.measure(fields.get(name), `watch.${name}`, DURATION, '120s or 10m') ?? fallback;
  const repeatField = fields.get('idle_repeat');
  const idleRepeat = repeatField
    ? check.measure(repeatField, 'watch.idle_repeat', DURATION, '120s or 10m')
    : undefined;
  const nudge = check.text(fields.get('nudge'), 'watch.nudge');
  const queueDir = check.text(fields.get('queue_dir'), 'watch.queue_dir');
  const base = defaultWatch();
  let quotaMarks = base.quotaMarks;
  const marks = fields.get('quota_marks');
  if (marks) {
    const node = marks.value;
    const numbers = node.kind === 'seq' ? node.items.map((item) => (item.kind === 'scalar' ? item.value : null)) : null;
    if (numbers && numbers.every((n): n is number => typeof n === 'number' && n > 0 && n <= 100)) quotaMarks = numbers;
    else check.fail(node.line, 'watch.quota_marks must be a list of percentages, such as [50, 75, 90]');
    check.warnings.push({ line: node.line, message: 'watch.quota_marks is now budgets.marks, and is still read' });
  }
  return {
    legacyMarks: Boolean(marks),
    watch: {
      interval: time('interval', base.interval),
      idleFirst: time('idle_first', base.idleFirst),
      idleOwner: time('idle_owner', base.idleOwner),
      blindAfter: time('blind_after', base.blindAfter),
      ...(idleRepeat !== undefined ? { idleRepeat } : {}),
      teamIdle: time('team_idle', base.teamIdle),
      nudgeWait: time('nudge_wait', base.nudgeWait),
      unsentAfter: time('unsent_after', base.unsentAfter),
      unreadAfter: time('unread_after', base.unreadAfter),
      quotaMarks,
      checks: readChecks(fields.get('checks'), check),
      ...(nudge !== undefined ? { nudge } : {}),
      ...(queueDir !== undefined ? { queueDir } : {}),
    },
  };
}

// The checks a file turns off: a map of check name to `off`. A name that doesn't exist is refused
// with its line, and so is one of the six that always run (RFC 0002 § 4.2) — the schema refuses
// them, and `team approve` validates before it fingerprints, so neither can approve them either.
function readChecks(entry: YamlEntry | undefined, check: Check): string[] {
  const off: string[] = [];
  if (!entry) return off;
  const node = entry.value;
  if (node.kind !== 'map') {
    if (!(node.kind === 'scalar' && node.value === null)) {
      check.fail(node.line, 'watch.checks must be a map: a check named, and set off');
    }
    return off;
  }
  for (const item of node.entries) {
    if (!(CHECK_NAMES as readonly string[]).includes(item.key)) {
      check.fail(item.line, `unknown check "${item.key}" in watch.checks: the checks are ${CHECK_NAMES.join(', ')}`);
      continue;
    }
    if (ALWAYS_ON.includes(item.key)) {
      check.fail(item.line, `watch.checks can't turn off ${item.key}: ${ALWAYS_ON.join(', ')} always run`);
      continue;
    }
    if (item.value.kind === 'scalar' && item.value.value === 'off') off.push(item.key);
    else check.fail(item.line, `watch.checks.${item.key} must be off: the only setting is off`);
  }
  return off;
}
