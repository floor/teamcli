#!/usr/bin/env bun
// Picks the tests a pull request's diff can affect, so PR CI runs in minutes instead of
// the full serial suite. Push to main, the nightly schedule and workflow_dispatch still run
// everything; this only narrows pull requests.
//
//   bun scripts/ci-select-tests.ts --base origin/main [--github-output FILE]
//   git diff --name-only origin/main...HEAD | bun scripts/ci-select-tests.ts --stdin
//
// Output: a human report on stderr, and on stdout one line `full` or the selected test
// paths separated by spaces (empty when nothing needs to run). With --github-output it also
// writes `mode=full|selected|none` and `tests=...` for the workflow.
//
// Selection:
//  1. changed test files run directly;
//  2. a reverse import graph over src/, test/ and scripts/ (static imports, dynamic imports
//     and any string literal naming a repo .ts/.js file, which catches spawned
//     `src/cli.ts` and `at('src/...')`) walks every changed module up to the tests reaching it;
//  3. docs/contract/schema/coverage files map to their check scripts, which PR CI runs anyway;
//  4. a toolchain change (FULL_TRIGGERS) runs the full suite; shared test infrastructure
//     (ALL_LIGHT_TRIGGERS) or a selection over THRESHOLD runs every test but the heavy ones;
//  5. heavy stress files (HEAVY) only run when they or their own files changed directly.
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const THRESHOLD = 150;
/**
 * How many src hops the walk follows from a changed module toward a test. The full
 * transitive closure is honest but useless for PRs: core modules (state, registry, records)
 * reach ~580 of ~630 tests through chains like teams.ts <- file/load.ts <- commands/doctor.ts.
 * The default follows the full closure; past THRESHOLD the PR runs every light test instead
 * (the three heavy files are ~80% of the suite's time). SELECT_DEPTH=2 narrows to tests that
 * import the module or a direct importer of it.
 */
const DEPTH = Number(process.env.SELECT_DEPTH ?? 99);

/** Changes that can move any test, heavy ones included: the toolchain and the runner. */
const FULL_TRIGGERS: RegExp[] = [
  /^package\.json$/,
  /^bun\.lockb?$/,
  /^bunfig\.toml$/,
  /^tsconfig.*\.json$/,
];
/** Changes that can move many tests but not the heavy stress files: run every light test. */
const ALL_LIGHT_TRIGGERS: RegExp[] = [
  /^\.github\/workflows\//,
  /^test\/fixtures\//,
  /^test\/helpers\//,
  /^scripts\/ci-select-tests\.ts$/,
  /^scripts\/build\.ts$/,
];

/** Stress tests too slow for a PR unless their own files changed. */
const HEAVY: Record<string, RegExp[]> = {
  'test/exit-codes.test.ts': [/^test\/exit-codes\.test\.ts$/, /^scripts\/exit-codes\.ts$/, /^src\/exit-codes?\b/],
  'test/broker.test.ts': [/^test\/broker\.test\.ts$/, /^test\/broker-run\.ts$/, /^src\/broker\//],
  'test/exit-filter.test.ts': [/^test\/exit-filter(\.test)?\.ts$/, /^src\/.*exit-filter/],
};

/** Files whose only guard is a check script that PR CI already runs. */
const CHECK_ONLY: [RegExp, string][] = [
  [/^docs\/.*contract|^contract\//, 'contract:check'],
  [/schema/, 'schema:check'],
  [/coverage/, 'coverage:check'],
  [/brief/, 'brief:check'],
  [/(^|\/)README\.md$/, 'readme:check'],
  [/^docs\//, 'readme:check / public-names:check'],
  [/\.md$/, 'readme:check / public-names:check'],
];

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return { base: get('--base'), stdin: a.includes('--stdin'), out: get('--github-output') };
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'fixtures') continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|mts|js|mjs)$/.test(e) && !e.endsWith('.d.ts')) acc.push(relative(ROOT, p));
  }
  return acc;
}

const SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const LITERAL = /['"`]((?:\.{1,2}\/)*(?:src|test|scripts|packages)\/[\w./-]+\.(?:ts|mts|js|mjs))['"`]/g;

function resolveSpec(from: string, spec: string): string | undefined {
  let cand: string;
  if (spec.startsWith('.')) cand = normalize(join(dirname(from), spec));
  else if (/^(src|test|scripts|packages)\//.test(spec)) cand = spec;
  else return undefined;
  for (const c of [cand, cand + '.ts', cand.replace(/\.js$/, '.ts'), join(cand, 'index.ts')]) {
    if (existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()) return c;
  }
  // A root-relative literal written from inside test/ like '../src/x.ts'
  const alt = spec.replace(/^(\.\.\/)+/, '');
  if (alt !== spec && existsSync(join(ROOT, alt))) return alt;
  return undefined;
}

function buildReverseGraph(files: string[]): Map<string, Set<string>> {
  const rev = new Map<string, Set<string>>();
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    const deps = new Set<string>();
    for (const re of [SPEC, LITERAL]) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(text)); ) { const r = resolveSpec(f, m[1] ?? ""); if (r && r !== f) deps.add(r); }
    }
    for (const d of deps) { if (!rev.has(d)) rev.set(d, new Set()); rev.get(d)!.add(f); }
  }
  return rev;
}

/**
 * The CLI entry imports every command, and hundreds of tests spawn it, so walking through it
 * would select the whole suite for any command change. The walk stops there; instead the
 * tests reaching the entry are kept only when they name the changed module's command
 * (e.g. 'reply' for src/commands/reply.ts), plus the CLI smoke test.
 */
const HUBS = new Set(['src/cli.ts']);
/**
 * Shared test helpers import a handful of core modules for fixtures, which would make every
 * test that imports them "reach" those modules. The walk does not pass through them for a
 * src change; a change to the helper itself still selects its importers (and usually trips
 * the threshold). API breaks the walk skips are caught by typecheck; behaviour reaches the
 * tests on main and nightly.
 */
const PASSIVE = new Set(['test/helpers.ts']);
const CLI_SMOKE = ['test/cli-smoke.test.ts'];

const isTest = (f: string) => /^test\/.*\.test\.ts$/.test(f);

function changedFiles(base?: string, stdin?: boolean): string[] {
  let raw: string;
  if (stdin) raw = readFileSync(0, 'utf8');
  else {
    const r = spawnSync('git', ['diff', '--name-only', `${base ?? 'origin/main'}...HEAD`], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) { console.error(`select: git diff failed: ${r.stderr}`); return ['<git diff failed>']; }
    raw = r.stdout;
  }
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
  const { base, stdin, out } = args();
  const changed = changedFiles(base, stdin);
  const log = (s: string) => console.error(s);
  const emit = (mode: 'full' | 'selected' | 'none', tests: string[], why: string) => {
    log(`\nselect: mode=${mode} (${why})`);
    if (mode === 'selected') log(`select: ${tests.length} test file(s)`);
    process.stdout.write((mode === 'full' ? 'full' : tests.join(' ')) + '\n');
    if (out) appendFileSync(out, `mode=${mode}\ntests=${tests.join(' ')}\n`);
  };

  log(`select: ${changed.length} changed file(s)`);
  if (changed.includes('<git diff failed>')) return emit('full', [], 'diff unavailable');
  const trigger = changed.find((f) => FULL_TRIGGERS.some((re) => re.test(f)));
  if (trigger) return emit('full', [], `toolchain changed: ${trigger}`);

  const all = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'test')), walk(join(ROOT, 'scripts')), walk(join(ROOT, 'packages')));
  const rev = buildReverseGraph(all);
  const reason = new Map<string, string>();
  const heavyOwnChanged = (h: string) => changed.some((f) => (HEAVY[h] ?? []).some((re) => re.test(f)));
  /** Every test except the heavy ones whose own files did not change. */
  const allLight = (why: string) => {
    const tests = all.filter(isTest).filter((t) => !(t in HEAVY) || heavyOwnChanged(t)).sort();
    for (const h of Object.keys(HEAVY)) log(`  ${heavyOwnChanged(h) ? 'keep' : 'skip'} heavy ${h}`);
    return emit('selected', tests, `all light tests: ${why}`);
  };
  const lightTrigger = changed.find((f) => ALL_LIGHT_TRIGGERS.some((re) => re.test(f)));
  if (lightTrigger) return allLight(`shared test infrastructure changed: ${lightTrigger}`);
  let hubCache: string[] | undefined;
  const hubTests = () => {
    if (hubCache) return hubCache;
    const seen = new Set<string>([...HUBS]); const q = [...HUBS];
    while (q.length) for (const up of rev.get(q.shift()!) ?? []) if (!seen.has(up)) { seen.add(up); q.push(up); }
    return (hubCache = [...seen].filter(isTest));
  };
  const directlyChanged = new Set(changed);

  for (const f of changed) {
    const deleted = !existsSync(join(ROOT, f));
    if (isTest(f)) { if (!deleted) reason.set(f, 'changed'); continue; }
    if (/\.(ts|mts|js|mjs)$/.test(f) || rev.has(f)) {
      // BFS up the reverse graph to every test that reaches f.
      const seen = new Set([f]); const queue = [f]; let hits = 0; let viaHub = false; const parent = new Map<string, string>(); const depth = new Map<string, number>([[f, 0]]);
      while (queue.length) {
        const cur = queue.shift()!;
        if (HUBS.has(cur) && cur !== f) { viaHub = true; continue; }
        if (PASSIVE.has(cur) && cur !== f) continue;
        const d = depth.get(cur)!;
        for (const up of rev.get(cur) ?? []) {
          if (seen.has(up)) continue;
          // Test-side support files (fixtures, *-run.ts) do not count as a hop.
          const nd = up.startsWith('test/') ? d : d + 1;
          if (!isTest(up) && nd >= DEPTH) continue;
          seen.add(up); queue.push(up); parent.set(up, cur); depth.set(up, nd);
          if (isTest(up)) { hits++; if (!reason.has(up)) reason.set(up, `reaches ${f}`); }
        }
      }
      if (viaHub) {
        const stem = f.split('/').pop()!.replace(/\.(ts|mts|js|mjs)$/, '');
        const named = new RegExp(`['"\`]${stem}['"\`]`);
        for (const t of hubTests()) {
          if (reason.has(t)) continue;
          if (named.test(readFileSync(join(ROOT, t), 'utf8'))) { reason.set(t, `spawns the CLI naming '${stem}' (${f})`); hits++; }
        }
        for (const t of CLI_SMOKE) if (existsSync(join(ROOT, t)) && !reason.has(t)) { reason.set(t, 'CLI smoke'); hits++; }
      }
      const why = process.env.SELECT_WHY;
      if (why !== undefined && parent.has(why)) {
        const chain: string[] = [why];
        for (let at = parent.get(why); at !== undefined; at = parent.get(at)) chain.unshift(at);
        log(`    why: ${chain.join(' <- ')}`);
      }
      log(`  ${f}: ${hits} test(s) reach it${viaHub ? ' (CLI entry: name-matched only)' : ''}${deleted ? ' (deleted)' : ''}`);
      if (deleted && hits === 0) log(`  ${f}: deleted; typecheck covers dangling imports`);
      continue;
    }
    const check = CHECK_ONLY.find(([re]) => re.test(f));
    if (check) { log(`  ${f}: covered by ${check[1]}`); continue; }
    // Non-code files a test reads by name (fixtures, templates, json).
    const readers = all.filter((t) => isTest(t) && readFileSync(join(ROOT, t), 'utf8').includes(f));
    if (readers.length) { for (const t of readers) if (!reason.has(t)) reason.set(t, `mentions ${f}`); log(`  ${f}: named by ${readers.length} test(s)`); }
    else log(`  ${f}: no test reaches it`);
  }

  for (const [heavy, own] of Object.entries(HEAVY)) {
    void own;
    if (reason.has(heavy) && !heavyOwnChanged(heavy)) {
      log(`  skip heavy ${heavy} (${reason.get(heavy)}); runs on main and nightly`);
      reason.delete(heavy);
    }
  }
  const tests = [...reason.keys()].sort();
  if (tests.length > THRESHOLD) return allLight(`${tests.length} tests selected > threshold ${THRESHOLD}`);
  for (const t of tests) log(`  + ${t}  [${reason.get(t)}]`);
  void directlyChanged;
  emit(tests.length ? 'selected' : 'none', tests, tests.length ? 'diff-targeted' : 'no test reaches the diff');
}

main();
