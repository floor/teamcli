import type { TeamFile } from '../types.ts';
import type { Section } from './section.ts';

export const TEMPOS = ['relaxed', 'normal', 'urgent'] as const;
export type Tempo = (typeof TEMPOS)[number];

/** The six waits a tempo scales. `interval` is the pass rate and stays as written. */
const SCALED = ['idleFirst', 'idleRepeat', 'teamIdle', 'nudgeWait', 'unsentAfter', 'unreadAfter'] as const;

export const tempo: Section = {
  name: 'tempo',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return ctx.check.oneOf(entry, 'tempo', [...TEMPOS]) ?? 'normal';
  },
  schema: { enum: [...TEMPOS] },
};

/**
 * The watch a tempo runs with. `normal` is the file as written. `relaxed` doubles the six
 * waits and `urgent` halves them, to the nearest second and never below one. An omitted
 * `idleRepeat` stays off, and `interval` is left as written.
 */
export function applyTempo(watch: TeamFile['watch'], word: Tempo): TeamFile['watch'] {
  if (word === 'normal') return watch;
  const factor = word === 'relaxed' ? 2 : 0.5;
  const next: TeamFile['watch'] = { ...watch };
  for (const key of SCALED) {
    const value = watch[key];
    if (value === undefined) continue;
    next[key] = Math.max(1, Math.round(value * factor));
  }
  return next;
}
