// The words a settings read prints. The registry and the composition carry machine values —
// `team default`, `restart-resume` — and these turn them into the phrases the tables show, so
// `team settings` and `team config keys` never disagree about a corner's name.

import type { ConfigOrigin } from './compose.ts';
import type { ApplyKind, ConfigValue } from './registry.ts';

/** A setting value in a cell: an order as its legs, a boolean as itself, an unset value as `-`. */
export function sayConfigValue(value: ConfigValue | null): string {
  if (value === null) return '-';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  return value.join(', ');
}

/** Where a value comes from, in the words of the read: a signed record names its level, the
 *  file's team order is the team's default, and no value at all is unset — the layer below (the
 *  profile, the launcher, the seat's name) decides. */
export function sayConfigOrigin(origin: ConfigOrigin): string {
  switch (origin) {
    case 'entity record': return 'entity record';
    case 'project record': return 'project record';
    case 'team record': return 'team record';
    case 'seat record': return 'seat record';
    case 'team file': return 'team file';
    case 'team default': return 'team order';
    case 'default': return 'default';
    case 'none': return 'unset';
  }
}

/** How a change applies, in the words of the decision: a runtime key waits for the restart that
 *  resumes the conversation; an identity or routing key applies at once. */
export function sayApply(applies: ApplyKind): string {
  return applies === 'restart-resume' ? 'restart that resumes' : 'at once';
}
