// The nightly harness writes one result, `pingpong-legs.json`, in the team's state directory
// (the same directory as the team state). `team check` reads that file and nothing else: it
// does not start a run. A missing file is a team that has not run, and draws no finding.
//
// A class is over when its staged-to-read p50 or p95 is past the send-to-read target: channel
// 3 s / 6 s, webhook 2 s / 5 s, typed 12 s / 20 s. Mailbox has no target. A message the run
// recorded as lost is its own finding. A result older than 36 hours is stale: its misses are
// still named, with the run's date, and one more finding says the result is older than a day.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Difference } from '../status/compare.ts';

export const PINGPONG_LEGS_FILE = 'pingpong-legs.json';

/** A nightly that slips past the next morning is still the latest run. Past this, it is stale. */
export const NIGHTLY_FRESH_MS = 36 * 60 * 60 * 1000;

const TARGETS = {
  channel: { p50: 3_000, p95: 6_000 },
  webhook: { p50: 2_000, p95: 5_000 },
  typed: { p50: 12_000, p95: 20_000 },
} as const;

const JUDGED = ['channel', 'webhook', 'typed'] as const;

export type PingpongLeg = {
  class: string;
  n: number;
  p50: number | null;
  p95: number | null;
};

export type PingpongLegsDocument = {
  schema: 'team.pingpong-legs';
  version: 1;
  ranAt: string;
  lost: number;
  legs: PingpongLeg[];
};

const LEAD = "the team's lead" as const;

function unreadable(): Difference {
  return {
    what: 'the nightly run result cannot be read',
    repair: 'the next nightly rewrites the result',
    who: LEAD,
  };
}

function seconds(ms: number): string {
  const whole = ms / 1000;
  return Number.isInteger(whole) ? `${String(whole)}s` : `${whole.toFixed(1)}s`;
}

function dateOf(ranAt: string): string {
  return new Date(ranAt).toISOString().slice(0, 10);
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/** The document, or null when the value is not one this check can judge. */
export function documentOf(value: unknown): PingpongLegsDocument | null {
  if (typeof value !== 'object' || value === null) return null;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== 'team.pingpong-legs' || doc.version !== 1) return null;
  if (typeof doc.ranAt !== 'string' || !Number.isFinite(Date.parse(doc.ranAt))) return null;
  if (typeof doc.lost !== 'number' || !Number.isInteger(doc.lost) || doc.lost < 0) return null;
  if (!Array.isArray(doc.legs)) return null;
  const legs: PingpongLeg[] = [];
  for (const raw of doc.legs) {
    if (typeof raw !== 'object' || raw === null) return null;
    const leg = raw as Record<string, unknown>;
    if (typeof leg.class !== 'string') return null;
    if (typeof leg.n !== 'number' || !Number.isInteger(leg.n) || leg.n < 0) return null;
    const p50 = finiteOrNull(leg.p50);
    const p95 = finiteOrNull(leg.p95);
    if (p50 === undefined || p95 === undefined) return null;
    legs.push({ class: leg.class, n: leg.n, p50, p95 });
  }
  return { schema: 'team.pingpong-legs', version: 1, ranAt: doc.ranAt, lost: doc.lost, legs };
}

/** One finding per missed class, one for a lost message, and one when the run is stale. */
export function findingsOf(doc: PingpongLegsDocument, now: Date): Difference[] {
  const date = dateOf(doc.ranAt);
  const findings: Difference[] = [];
  if (now.getTime() - Date.parse(doc.ranAt) > NIGHTLY_FRESH_MS) {
    findings.push({
      what: `nightly run ${date} is older than a day`,
      repair: 'run the nightly again',
      who: LEAD,
    });
  }
  for (const name of JUDGED) {
    const leg = doc.legs.find((item) => item.class === name);
    if (leg === undefined || leg.n === 0) continue;
    const target = TARGETS[name];
    const parts: string[] = [];
    if (leg.p50 !== null && leg.p50 > target.p50) parts.push(`p50 ${seconds(leg.p50)} is over ${seconds(target.p50)}`);
    if (leg.p95 !== null && leg.p95 > target.p95) parts.push(`p95 ${seconds(leg.p95)} is over ${seconds(target.p95)}`);
    if (parts.length === 0) continue;
    findings.push({
      what: `nightly run ${date}: ${name} ${parts.join(' and ')}`,
      repair: "read that nightly run's per-leg table",
      who: LEAD,
    });
  }
  if (doc.lost > 0) {
    const count = String(doc.lost);
    findings.push({
      what: `nightly run ${date}: ${count} ${doc.lost === 1 ? 'message was' : 'messages were'} lost`,
      repair: "read that nightly run's lost table",
      who: LEAD,
    });
  }
  return findings;
}

/** The findings for the result in this state directory. No file means no finding. */
export function pingpongLegDifferences(dir: string, now: Date): Difference[] {
  let text: string;
  try {
    text = readFileSync(join(dir, PINGPONG_LEGS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [unreadable()];
  }
  try {
    const doc = documentOf(JSON.parse(text) as unknown);
    if (doc === null) return [unreadable()];
    return findingsOf(doc, now);
  } catch {
    return [unreadable()];
  }
}
