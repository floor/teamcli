#!/usr/bin/env bun
// Splits a PR's selected tests over the pr-tests shards by recorded duration, so one shard no
// longer gets most of the time (round-robin by position put exit-codes and broker on the same
// shard as hundreds of others).
//
//   bun scripts/ci-shard-tests.ts --shard 1 --shards 4 [tests...]   one shard's units, space-separated
//     (a unit is a test file, or `<file>#<i>/<n>`: part i of n of a SPLIT file)
//   bun scripts/ci-shard-tests.ts --plan --shards 4 [tests...]      every shard with its estimate (stderr)
//   bun scripts/ci-shard-tests.ts --record <github-job-log>          rewrite scripts/ci-test-timings.json
//
// With no test arguments, the list is read from $TESTS; `full` (or MODE=full) means every
// tracked test/*.test.ts. Weights come from scripts/ci-test-timings.json (milliseconds of wall time
// per file, from a `full` job log); a file with no recorded time weighs its size in bytes times the
// suite's median milliseconds-per-byte, so a new file still lands somewhere sensible.
//
// Packing is longest-processing-time first: files sorted by weight (ties by path), each to the
// shard with the least total so far (ties by index). Deterministic: every shard computes the same
// plan from the same list, so no file is run twice or skipped.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TIMINGS = join(ROOT, 'scripts', 'ci-test-timings.json');

export type Plan = { files: string[]; ms: number }[];

/**
 * Files run as several parts, each in its own process with `TEAM_EXIT_PART=<i>/<n>` (see
 * test/exit-filter.ts): one unit `<file>#<i>/<n>` per part, each weighing 1/n of the file.
 * exit-codes alone is ~44% of the suite; whole, it would set every PR's wall time.
 */
export const SPLIT: Record<string, number> = { 'test/exit-codes.test.ts': 4 };

/** The units to pack: every file, with a split file replaced by its parts. */
export function units(files: string[]): string[] {
  return [...new Set(files)].flatMap((f) =>
    SPLIT[f] ? Array.from({ length: SPLIT[f]! }, (_, i) => `${f}#${i}/${SPLIT[f]}`) : [f],
  );
}

export function readTimings(path = TIMINGS): Record<string, number> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>) : {};
}

function sizeOf(file: string): number {
  try {
    return statSync(join(ROOT, file)).size;
  } catch {
    return 0;
  }
}

/** Each file's weight in ms: its recorded time, or its size times the median ms-per-byte. */
export function weights(files: string[], timings: Record<string, number>, size: (f: string) => number = sizeOf): Map<string, number> {
  const rates = Object.entries(timings)
    .map(([f, ms]) => { const s = size(f); return s > 0 ? ms / s : NaN; })
    .filter((r) => Number.isFinite(r))
    .sort((a, b) => a - b);
  const rate = rates.length ? rates[Math.floor(rates.length / 2)]! : 0.1;
  const one = (f: string) => timings[f] ?? Math.max(1, Math.round(size(f) * rate));
  return new Map(
    files.map((u) => {
      const [f, part] = u.split('#') as [string, string | undefined];
      return [u, part ? Math.round(one(f) / Number(part.split('/')[1])) : one(f)];
    }),
  );
}

/** Longest-processing-time-first packing into `shards` bins. */
export function plan(files: string[], shards: number, weight: Map<string, number>): Plan {
  const bins: Plan = Array.from({ length: shards }, () => ({ files: [], ms: 0 }));
  const unique = [...new Set(files)];
  unique.sort((a, b) => (weight.get(b)! - weight.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of unique) {
    let best = 0;
    for (let i = 1; i < shards; i++) if (bins[i]!.ms < bins[best]!.ms) best = i;
    bins[best]!.files.push(f);
    bins[best]!.ms += weight.get(f)!;
  }
  for (const bin of bins) bin.files.sort();
  return bins;
}

/** Per-file wall time from a GitHub Actions log of `bun test`: one `##[group]<file>:` per file. */
export function timingsFromLog(log: string): Record<string, number> {
  const marks: { at: number; file: string | null }[] = [];
  for (const line of log.split('\n')) {
    const m = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z (?:##\[group\](test\/\S+\.test\.ts):|.*\bRan \d+ tests)/.exec(line);
    if (m) marks.push({ at: Date.parse(`${m[1]!.slice(0, 23)}Z`), file: m[2] ?? null });
  }
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < marks.length; i++) {
    const f = marks[i]!.file;
    if (f) out[f] = (out[f] ?? 0) + Math.max(0, marks[i + 1]!.at - marks[i]!.at);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function allTests(): string[] {
  const r = spawnSync('git', ['ls-files', '--', 'test/*.test.ts'], { cwd: ROOT, encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean);
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const record = get('--record');
  if (record !== undefined) {
    const t = timingsFromLog(readFileSync(record, 'utf8'));
    writeFileSync(TIMINGS, `${JSON.stringify(t, null, 0).replace(/,"/g, ',\n"').replace(/^\{/, '{\n').replace(/\}$/, '\n}')}\n`);
    console.error(`recorded ${Object.keys(t).length} files`);
    process.exit(0);
  }
  const shards = Number(get('--shards') ?? 4);
  const shard = get('--shard');
  const rest = a.filter((x, i) => !x.startsWith('--') && !['--shards', '--shard', '--record'].includes(a[i - 1] ?? ''));
  let tests = rest.length ? rest : (process.env.TESTS ?? '').split(/\s+/).filter(Boolean);
  if (process.env.MODE === 'full' || (tests.length === 1 && tests[0] === 'full')) tests = allTests();
  const all = units(tests);
  const bins = plan(all, shards, weights(all, readTimings()));
  if (a.includes('--plan') || shard === undefined) {
    bins.forEach((b, i) => console.error(`shard ${i}: ${b.files.length} files, ~${(b.ms / 1000).toFixed(1)}s`));
  }
  if (shard !== undefined) console.log(bins[Number(shard)]?.files.join(' ') ?? '');
}
