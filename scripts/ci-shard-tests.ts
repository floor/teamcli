#!/usr/bin/env bun
// Splits the test files over shards by recorded duration, so one shard no longer gets most of the
// time (round-robin by position put exit-codes and broker on the same shard as hundreds of others).
//
//   bun scripts/ci-shard-tests.ts --shard 1 --shards 4 [tests...]   one shard's units, space-separated
//     (a unit is a test file, or `<file>#<i>/<n>`: part i of n of a SPLIT file)
//   bun scripts/ci-shard-tests.ts --plan --shards 4 [tests...]      every shard with its estimate (stderr)
//   bun scripts/ci-shard-tests.ts --assigned --shard 1 --shards 4   one shard of the checked-in assignment
//   bun scripts/ci-shard-tests.ts --assigned --plan                 the checked-in assignment with estimates
//   bun scripts/ci-shard-tests.ts --check                           fail unless every tracked test is assigned once
//   bun scripts/ci-shard-tests.ts --write                           drop deleted units, append new ones, move none
//   bun scripts/ci-shard-tests.ts --rebalance [--shards 4]          rewrite the assignment by recorded duration
//   bun scripts/ci-shard-tests.ts --run 1/4                         run one shard locally, files then parts
//   bun scripts/ci-shard-tests.ts --record <log> [log...]           merge timings from shard job logs of one system
//   bun scripts/ci-shard-tests.ts --junit <report.xml> [--label <unit>]  print a run's unit times for --record
//
// With no test arguments, the list is read from $TESTS; `full` (or MODE=full) means every
// tracked test file. The PR job packs the selected tests at run time; the whole suite uses the
// checked-in assignment (scripts/ci-shard-assignment.json), so adding a test file appends it to the
// lightest shard and moves no existing unit. Weights come from scripts/ci-test-timings.json
// (milliseconds of wall time per file, from a `full` job log); a file with no recorded time weighs
// its size in bytes times the suite's median milliseconds-per-byte, so a new file still lands
// somewhere sensible. The assignment paths instead weigh an untimed unit at UNTIMED_MS, the
// measured average of the units that had no recorded time when the suite was measured: the size
// fallback alone would leave 45% of the suite's time out of the balance.
//
// Packing is longest-processing-time first: files sorted by weight (ties by path), each to the
// shard with the least total so far (ties by index). Deterministic: every shard computes the same
// plan from the same list, so no file is run twice or skipped.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TIMINGS = join(ROOT, 'scripts', 'ci-test-timings.json');
const ASSIGNMENT = join(ROOT, 'scripts', 'ci-shard-assignment.json');

export type Plan = { files: string[]; ms: number }[];

export type Assignment = { shards: number; units: Record<string, number> };

/**
 * Files run as several parts, each in its own process with `TEAM_EXIT_PART=<i>/<n>` (see
 * test/exit-filter.ts): one unit `<file>#<i>/<n>` per part, weighing its own recorded time when
 * the timings have one, else 1/n of the file.
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
      // A part's own recorded time first (part 0 carries the whole-repo checks), else 1/n of the file.
      return [u, timings[u] ?? (part ? Math.round(one(f) / Number(part.split('/')[1])) : one(f))];
    }),
  );
}

/**
 * What a unit with neither its own nor its file's recorded time weighs when the assignment is
 * made: the measured average of the 233 units that had no recorded time when the suite was
 * measured (897.5 s over 233 units, 2026-10-31). Size alone weighs those units at ~0.06 s each
 * together, leaving 45% of the suite's time out of the balance. `--record` replaces this with
 * measured times as the sharded runs arrive; after that it covers only test files added since.
 */
export const UNTIMED_MS = 3850;

/** Assignment weights: recorded time first, the untimed estimate for a unit with none, size as the floor. */
export function assignmentWeights(files: string[], timings: Record<string, number>, size: (f: string) => number = sizeOf): Map<string, number> {
  const w = weights(files, timings, size);
  for (const u of new Set(files)) {
    const [file, part] = u.split('#') as [string, string | undefined];
    if (timings[u] !== undefined || timings[file] !== undefined) continue;
    const share = part ? UNTIMED_MS / Number(part.split('/')[1]) : UNTIMED_MS;
    w.set(u, Math.max(w.get(u) ?? 0, Math.round(share)));
  }
  return w;
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

function sortedUnits(units: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(units).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A packed plan as the checked-in map: unit to shard. */
export function assignmentOf(bins: Plan): Assignment {
  const units: Record<string, number> = {};
  bins.forEach((bin, i) => { for (const u of bin.files) units[u] = i; });
  return { shards: bins.length, units: sortedUnits(units) };
}

/**
 * `--write`: every unit the file already names keeps its shard, a unit whose file is gone is
 * dropped, and each newcomer joins the lightest shard (longest first, so a batch of new files is
 * packed as well as a fresh plan). One added test file therefore moves nothing already placed.
 */
export function appendUnits(base: Assignment, want: string[], weight: Map<string, number>, shards = base.shards): Assignment {
  const units: Record<string, number> = {};
  const totals = Array.from({ length: shards }, () => 0);
  for (const u of want) {
    const held = base.units[u];
    if (held !== undefined) {
      units[u] = held;
      totals[held] = (totals[held] ?? 0) + (weight.get(u) ?? 0);
    }
  }
  const fresh = want.filter((u) => base.units[u] === undefined);
  fresh.sort((a, b) => (weight.get(b)! - weight.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
  for (const u of fresh) {
    let best = 0;
    for (let i = 1; i < shards; i++) if (totals[i]! < totals[best]!) best = i;
    units[u] = best;
    totals[best] = (totals[best] ?? 0) + (weight.get(u) ?? 0);
  }
  return { shards, units: sortedUnits(units) };
}

/**
 * What `--check` refuses: a tracked test file the assignment does not reach, a unit whose file is
 * not a tracked test, a split file placed whole or split into the wrong number of parts, a shard
 * number outside the count, an empty shard, and a unit named twice in the file (the JSON parser
 * keeps only the last, so the duplicate would silently drop an assignment).
 */
export function assignmentProblems(assignment: Assignment, tracked: string[], raw?: string): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(assignment.shards) || assignment.shards < 1) {
    return [`the shard count ${assignment.shards} is not a positive integer`];
  }
  const trackedSet = new Set(tracked);
  for (const [unit, shard] of Object.entries(assignment.units)) {
    const [file, part] = unit.split('#') as [string, string | undefined];
    if (!trackedSet.has(file)) problems.push(`${unit}: its file is not a tracked test; run --write to drop it`);
    if (part !== undefined) {
      const m = /^(\d+)\/(\d+)$/.exec(part);
      const count = SPLIT[file];
      if (!m) problems.push(`${unit}: a part is written <i>/<n>`);
      else if (!trackedSet.has(file)) { /* named above: the file is not a tracked test */ }
      else if (count === undefined) problems.push(`${unit}: the file is not split, so it cannot be assigned as a part`);
      else if (count !== Number(m[2])) problems.push(`${unit}: the file is split into ${count} part(s), not ${m[2]}`);
      else if (Number(m[1]) >= count) problems.push(`${unit}: part ${m[1]} is outside 0..${count - 1}`);
    } else if (SPLIT[file]) {
      problems.push(`${unit}: the file is split into ${SPLIT[file]} parts and cannot be assigned whole`);
    }
    if (!Number.isInteger(shard) || shard < 0 || shard >= assignment.shards) {
      problems.push(`${unit}: shard ${shard} is outside 0..${assignment.shards - 1}`);
    }
  }
  if (raw) {
    const named = new Map<string, number>();
    for (const m of raw.matchAll(/"([^"]+\.(?:test|spec)\.ts(?:#\d+\/\d+)?)":/g)) named.set(m[1]!, (named.get(m[1]!) ?? 0) + 1);
    for (const [unit, count] of named) {
      if (count > 1) problems.push(`${unit}: named ${count} times in the file, so all but one assignment is silently dropped`);
    }
  }
  const placed = new Set(Object.values(assignment.units));
  for (const file of tracked) {
    for (const unit of units([file])) {
      if (assignment.units[unit] === undefined) {
        problems.push(`${unit}: the test file is not assigned to any shard; run --write`);
      }
    }
  }
  for (let i = 0; i < assignment.shards; i++) {
    if (!placed.has(i)) problems.push(`shard ${i}: no units; run --rebalance`);
  }
  return [...new Set(problems)].sort();
}

export function readAssignment(path = ASSIGNMENT): Assignment {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { shards?: unknown; units?: unknown };
  const units: Record<string, number> = {};
  for (const [unit, shard] of Object.entries((raw.units ?? {}) as Record<string, unknown>)) {
    units[unit] = Number(shard);
  }
  return { shards: Number(raw.shards ?? 4), units: sortedUnits(units) };
}

function writeAssignment(assignment: Assignment): void {
  writeFileSync(ASSIGNMENT, `${JSON.stringify({ shards: assignment.shards, units: sortedUnits(assignment.units) }, null, 2)}\n`);
}

/** Shard i's units, sorted, from the checked-in assignment. */
export function shardUnits(assignment: Assignment, shard: number): string[] {
  return Object.entries(assignment.units)
    .filter(([, s]) => s === shard)
    .map(([unit]) => unit)
    .sort();
}

/**
 * Per-unit wall time from a CI job log of `bun test`, in two forms:
 * - `##[unit]<unit> <ms>`, printed by --junit from a run's JUnit report. A shard log carries one
 *   per file it ran, and one per split part (`<file>#<i>/<n>` when --label names it).
 * - one `##[group]<file>:` per file, closed by `Ran N tests`; a `Part <i>/<n> of <file>` line
 *   before a group names a split unit. This is the older instrumented-run form.
 * Several logs merge by summing, so pass the shard logs of one system, not both.
 */
export function timingsFromLog(log: string): Record<string, number> {
  const direct: Record<string, number> = {};
  const marks: { at: number; unit: string | null }[] = [];
  let part: { file: string; at: string } | null = null;
  for (const line of log.split('\n')) {
    const d = /##\[unit\](test\/\S+?\.(?:test|spec)\.ts(?:#\d+\/\d+)?) (\d+)/.exec(line);
    if (d) { direct[d[1]!] = (direct[d[1]!] ?? 0) + Number(d[2]); continue; }
    const p = /Part (\d+\/\d+) of (\S+?\.(?:test|spec)\.ts)/.exec(line);
    if (p) { part = { file: p[2]!, at: p[1]! }; continue; }
    const m = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z (?:##\[group\](test\/\S+?\.(?:test|spec)\.ts):|.*\bRan \d+ tests)/.exec(line);
    if (m) {
      let unit = m[2] ?? null;
      if (unit !== null && part !== null && part.file === unit) { unit = `${unit}#${part.at}`; part = null; }
      marks.push({ at: Date.parse(`${m[1]!.slice(0, 23)}Z`), unit });
    }
  }
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < marks.length; i++) {
    const unit = marks[i]!.unit;
    if (unit) out[unit] = (out[unit] ?? 0) + Math.max(0, marks[i + 1]!.at - marks[i]!.at);
  }
  return Object.fromEntries(Object.entries({ ...out, ...direct }).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A unit's measured time in a JUnit report: each `<testsuite>` names its file and its seconds. */
export function unitTimesFromJunit(xml: string, label?: string): Record<string, number> {
  const times: Record<string, number> = {};
  let sum = 0;
  for (const m of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const tag = m[0];
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    const seconds = /\btime="([0-9.]+)"/.exec(tag)?.[1];
    if (name === undefined || seconds === undefined) continue;
    const ms = Math.round(Number(seconds) * 1000);
    if (label === undefined) times[name] = (times[name] ?? 0) + ms;
    else sum += ms;
  }
  if (label !== undefined) times[label] = sum;
  return times;
}

/** Every tracked file `bun test` would discover: a test or spec file anywhere in the tree. */
function allTests(): string[] {
  const r = spawnSync('git', ['ls-files', '--', '*.test.ts', '*.spec.ts'], { cwd: ROOT, encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean);
}

function loadAssignment(): { assignment: Assignment; raw: string } {
  if (!existsSync(ASSIGNMENT)) {
    console.error('ci:shard: scripts/ci-shard-assignment.json is missing; run bun scripts/ci-shard-tests.ts --write');
    process.exit(1);
  }
  const raw = readFileSync(ASSIGNMENT, 'utf8');
  try {
    return { assignment: readAssignment(), raw };
  } catch {
    console.error('ci:shard: scripts/ci-shard-assignment.json is not valid JSON');
    process.exit(1);
  }
}

function report(problems: string[]): void {
  if (!problems.length) return;
  for (const problem of problems) console.error(`ci:shard: ${problem}`);
  console.error(`ci:shard: ${problems.length} problem(s); nothing ran`);
  process.exit(1);
}

function usage(): never {
  console.error('usage: bun scripts/ci-shard-tests.ts --shard <i> --shards <n> [tests...] | --plan --shards <n> [tests...]');
  console.error('       bun scripts/ci-shard-tests.ts --assigned --shard <i> [--shards <n>] | --assigned --plan');
  console.error('       bun scripts/ci-shard-tests.ts --check | --write | --rebalance [--shards <n>]');
  console.error('       bun scripts/ci-shard-tests.ts --run <i>/<n>');
  console.error('       bun scripts/ci-shard-tests.ts --record <log> [log...]');
  console.error('       bun scripts/ci-shard-tests.ts --junit <report.xml> [--label <unit>]');
  process.exit(2);
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const has = (k: string) => a.includes(k);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };

  const junitAt = a.indexOf('--junit');
  if (junitAt >= 0) {
    const path = a[junitAt + 1];
    if (path === undefined || path.startsWith('--')) usage();
    const label = get('--label');
    const times = unitTimesFromJunit(readFileSync(path, 'utf8'), label);
    for (const [unit, ms] of Object.entries(times)) {
      if (!/^test\/\S+?\.(?:test|spec)\.ts(?:#\d+\/\d+)?$/.test(unit)) {
        console.error(`ci:shard: --junit read '${unit}', which is not a unit path`);
        process.exit(1);
      }
      console.log(`##[unit]${unit} ${ms}`);
    }
    process.exit(0);
  }

  const recordAt = a.indexOf('--record');
  if (recordAt >= 0) {
    const logs = a.slice(recordAt + 1).filter((x) => !x.startsWith('--'));
    if (!logs.length) usage();
    const fromLogs: Record<string, number> = {};
    for (const log of logs) {
      for (const [unit, ms] of Object.entries(timingsFromLog(readFileSync(log, 'utf8')))) {
        fromLogs[unit] = (fromLogs[unit] ?? 0) + ms;
      }
    }
    // A unit these logs did not mention keeps its previous time; one they measured takes the new
    // value, never the sum of old and new. Pass one system's shard logs: two systems' times for
    // the same unit would add.
    const t = Object.fromEntries(Object.entries({ ...readTimings(), ...fromLogs }).sort(([x], [y]) => (x < y ? -1 : 1)));
    writeFileSync(TIMINGS, `${JSON.stringify(t, null, 0).replace(/,"/g, ',\n"').replace(/^\{/, '{\n').replace(/\}$/, '\n}')}\n`);
    console.error(`recorded ${Object.keys(t).length} units from ${logs.length} log(s)`);
    process.exit(0);
  }

  if (has('--check')) {
    const { assignment, raw } = loadAssignment();
    const problems = assignmentProblems(assignment, allTests(), raw);
    if (problems.length) {
      for (const problem of problems) console.error(`ci:shard: ${problem}`);
      console.error(`ci:shard: ${problems.length} problem(s); repair with \`bun run ci:shard --write\``);
      process.exit(1);
    }
    console.error(`ci:shard: ${Object.keys(assignment.units).length} units over ${assignment.shards} shards, every tracked test assigned once`);
    process.exit(0);
  }

  if (has('--write')) {
    const tracked = allTests();
    const want = units(tracked);
    const base = existsSync(ASSIGNMENT) ? readAssignment() : null;
    const shards = Number(get('--shards') ?? base?.shards ?? 4);
    if (!Number.isInteger(shards) || shards < 1) usage();
    if (base && base.shards !== shards && Object.keys(base.units).length) {
      console.error(`ci:shard: --write never moves a unit, so it cannot take the file from ${base.shards} shards to ${shards}; run --rebalance`);
      process.exit(2);
    }
    const weight = assignmentWeights(want, readTimings());
    const next = appendUnits(base ?? { shards, units: {} }, want, weight, shards);
    writeAssignment(next);
    const added = want.filter((u) => base === null || base.units[u] === undefined).length;
    const dropped = base === null ? 0 : Object.keys(base.units).filter((u) => !want.includes(u)).length;
    console.error(`ci:shard: wrote ${Object.keys(next.units).length} units over ${next.shards} shards (${added} new, ${dropped} dropped)`);
    process.exit(0);
  }

  if (has('--rebalance')) {
    const tracked = allTests();
    const want = units(tracked);
    const base = existsSync(ASSIGNMENT) ? readAssignment() : null;
    const shards = Number(get('--shards') ?? base?.shards ?? 4);
    if (!Number.isInteger(shards) || shards < 1) usage();
    const next = assignmentOf(plan(want, shards, assignmentWeights(want, readTimings())));
    writeAssignment(next);
    console.error(`ci:shard: rebalanced ${Object.keys(next.units).length} units over ${next.shards} shards`);
    process.exit(0);
  }

  const run = get('--run');
  if (run !== undefined) {
    const m = /^(\d+)\/(\d+)$/.exec(run);
    if (!m) usage();
    const index = Number(m[1]);
    const shards = Number(m[2]);
    const { assignment, raw } = loadAssignment();
    const problems = assignmentProblems(assignment, allTests(), raw);
    if (assignment.shards !== shards) problems.push(`the assignment has ${assignment.shards} shards, and --run names ${shards}`);
    if (index >= shards) problems.push(`shard ${index} is outside 0..${shards - 1}`);
    report(problems);
    const mine = shardUnits(assignment, index);
    const weight = assignmentWeights(mine, readTimings());
    const ms = mine.reduce((sum, unit) => sum + (weight.get(unit) ?? 0), 0);
    console.error(`shard ${index} of ${shards}: ${mine.length} units, ~${(ms / 1000).toFixed(1)}s (estimate from scripts/ci-test-timings.json)`);
    const files = mine.filter((unit) => !unit.includes('#'));
    const parts = mine.filter((unit) => unit.includes('#'));
    let status = 0;
    if (files.length) {
      const ran = spawnSync('bun', ['test', ...files], { cwd: ROOT, stdio: 'inherit' });
      if (ran.status !== 0) status = 1;
    }
    for (const part of parts) {
      const [file, at] = part.split('#') as [string, string];
      console.error(`Part ${at} of ${file}`);
      const ran = spawnSync('bun', ['test', `./${file}`], {
        cwd: ROOT, stdio: 'inherit', env: { ...process.env, TEAM_EXIT_PART: at },
      });
      if (ran.status !== 0) status = 1;
    }
    process.exit(status);
  }

  if (has('--assigned')) {
    const { assignment, raw } = loadAssignment();
    const problems = assignmentProblems(assignment, allTests(), raw);
    const wanted = get('--shards');
    if (wanted !== undefined && Number(wanted) !== assignment.shards) {
      problems.push(`the assignment has ${assignment.shards} shards, and --shards names ${wanted}`);
    }
    report(problems);
    if (has('--plan')) {
      const weight = assignmentWeights(Object.keys(assignment.units), readTimings());
      for (let i = 0; i < assignment.shards; i++) {
        const mine = shardUnits(assignment, i);
        const ms = mine.reduce((sum, unit) => sum + (weight.get(unit) ?? 0), 0);
        console.error(`shard ${i}: ${mine.length} units, ~${(ms / 1000).toFixed(1)}s`);
      }
      process.exit(0);
    }
    const shard = get('--shard');
    if (shard === undefined || !/^\d+$/.test(shard) || Number(shard) >= assignment.shards) usage();
    console.log(shardUnits(assignment, Number(shard)).join(' '));
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
