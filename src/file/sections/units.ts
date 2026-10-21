import type { JsonSchema } from './section.ts';

export const DURATION = { s: 1, m: 60, h: 3600 };
export const PERCENT = { '%': 1 };
export const SIZE = { MB: 1e6, GB: 1e9, TB: 1e12 };

/** The schema of a measure, its unit tables deciding the pattern the text must fit. */
export function measureSchema(units: Record<string, number>): JsonSchema {
  const unit = Object.keys(units).join('|');
  return { type: 'string', pattern: `^[0-9]+(?:\\.[0-9]+)?(${unit})$` };
}

/** A measure's text — a number and its unit, such as `120s`, `25%` or `10GB` — in the unit
 *  table's own unit, or null when the text fits no entry. */
export function parseMeasure(text: string, units: Record<string, number>): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z%]+)$/.exec(text);
  const unit = match?.[2];
  if (match === null || unit === undefined || !(unit in units)) return null;
  return Number(match[1]) * (units[unit] as number);
}
