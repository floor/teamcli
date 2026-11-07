// A wildcard general grant reaches every op, including ops that shipped after it was signed —
// without a new owner approval. `team check` and `team doctor` name each such grant once, as
// information: never a difference, never a failure. What counts as "after" is measured from the
// release tags in this repository (each op's route in the dispatcher table at each tag, by tag
// date), not remembered; the table below is that measurement. A dated, untagged package
// release also counts as shipped while its real release row is prepared before tagging.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commands } from '../src/cli.ts';
import { releaseHeadingOf } from '../scripts/check-release-date.ts';
import {
  GENERAL_GRANT_DOMAIN,
  GENERAL_OPS,
  GENERAL_REFUSED_COMMANDS,
  OP_FIRST_SHIPPED,
  OP_RELEASE_GROUPS,
  generalGrantPath,
  issueOwnerGeneralGrant,
  widenedGrantNote,
  widenedGrantNotes,
  wildcardGrantsWidened,
  type GeneralOp,
  type GrantOp,
} from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { installKey, keyOf, signDomain, type Json } from '../src/store/keys.ts';
import { fixtureBase } from './helpers.ts';

const NOW = new Date('2026-11-08T00:00:00Z');
// A grant outlives every date this file signs at, so only the signing time decides the note.
const EXPIRES = new Date('2027-01-01T00:00:00Z');
// Ops whose route the dispatcher has but no release row measures yet. A release that first
// ships one adds its row and takes the op out of this list; a route that is neither measured
// nor named here fails the check below, so a new op cannot slip past unmeasured. The 0.5.12
// row measures `fallback`, `order`, `trace` and `waits`; the 0.5.16 tag measures analyse,
// checkpoint and show, so every current route has a release row.
const UNRELEASED_OPS: readonly string[] = [];

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function world(): { home: string; publicKey: string } {
  const home = fixtureBase('.gg-widened-');
  homes.push(home);
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'a'), pair);
  if (!written.ok) throw new Error(written.why);
  return { home, publicKey: pair.publicKey };
}

/** One owner-signed grant, signed at `signed` and expiring well after every read in this file. */
function issue(home: string, publicKey: string, ops: GrantOp[], signed: string) {
  const made = issueOwnerGeneralGrant(
    home,
    { clientId: 'a', publicKey, entities: ['*'], ops, mayIssue: false, expires: EXPIRES },
    new Date(signed),
  );
  if (!made.ok) throw new Error(made.why);
  return made.grant;
}

test('the release table measures every op at most once, and every release date reads', () => {
  // Every op of today's vocabulary is either measured or known to be unshipped; an op added
  // without a measured release has no date, and the note says nothing false about it.
  expect(Object.keys(OP_FIRST_SHIPPED).sort()).toEqual([...GENERAL_OPS].sort());
  for (const row of OP_RELEASE_GROUPS) {
    expect(row.tag).toMatch(/^v\d+\.\d+\.\d+/);
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    expect(row.ops.length).toBeGreaterThan(0);
  }
  for (const op of GENERAL_OPS) {
    const rows = OP_RELEASE_GROUPS.filter((row) => row.ops.includes(op));
    expect(rows.length).toBeLessThanOrEqual(1);
    const first = OP_FIRST_SHIPPED[op];
    if (first === null) expect(rows.length).toBe(0);
    else expect(first.tag).toBe(rows[0]?.tag ?? 'none');
  }
});

test('no dispatcher route is unmeasured: each has a release row or is declared unshipped', () => {
  // A route added without a measured release would otherwise pass the check above: an op with
  // no row is consistent with the table. This is the check that fails instead. The routes are
  // the dispatcher's own table, and every one of them is an op of the general door.
  const routes = Object.keys(commands).filter((name) => !GENERAL_REFUSED_COMMANDS.has(name));
  for (const name of routes) expect(GENERAL_OPS as readonly string[]).toContain(name);
  const unmeasured = routes.filter(
    (name) => OP_FIRST_SHIPPED[name as GeneralOp] === null && !UNRELEASED_OPS.includes(name),
  );
  expect(unmeasured).toEqual([]);
  // The declaration cannot rot: it is exactly the ops with no measured row, so a release that
  // ships one makes this fail until the row is added and the op leaves the list, and a name
  // that is no op fails here too.
  expect([...UNRELEASED_OPS].sort()).toEqual(
    GENERAL_OPS.filter((op) => OP_FIRST_SHIPPED[op] === null).sort(),
  );
});

const NEEDS_RELEASE_TAGS = 'this test needs the release tags (git fetch --tags)';

/** The table's newest release: the row whose `at` is latest. Its tag may not exist yet — the
 *  release commit lands before the owner tags it — so it is the one table tag a clone may lack. */
const NEWEST_ROW = OP_RELEASE_GROUPS.reduce((late, row) => (Date.parse(row.at) > Date.parse(late.at) ? row : late));

/** The reason the release walk cannot measure this clone, or null when it can. The release
 *  table's own tags are the yardstick: a clone that fetched no tags, or only some, would
 *  otherwise read as "no release ships the op", and the walk would pass without measuring
 *  anything. A plain refusal names the missing tags, never a silent pass. The newest table row
 *  names the release being cut, so its tag may lag the table, and local `-hotfix.` tags are
 *  covered by their release tag on the remote; every other published release tag is required. */
function tagSetProblem(tags: readonly string[]): string | null {
  if (tags.length === 0) return NEEDS_RELEASE_TAGS;
  const missing = OP_RELEASE_GROUPS.map((row) => row.tag).filter(
    (tag) => tag !== NEWEST_ROW.tag && !tag.includes('-hotfix.') && !tags.includes(tag),
  );
  return missing.length === 0 ? null : `${NEEDS_RELEASE_TAGS}; it reads no ${missing.join(', ')}`;
}

test('a tag set the release walk cannot use fails loudly, never passes empty', () => {
  expect(tagSetProblem([])).toBe(NEEDS_RELEASE_TAGS);
  const tableTags = OP_RELEASE_GROUPS.map((row) => row.tag);
  // Every tag the table names measures. The newest release's tag may not exist yet (it is
  // created after the release commit), so the set without it measures too — the same state the
  // walk runs in before the owner tags the release.
  expect(tagSetProblem(tableTags)).toBeNull();
  expect(tagSetProblem(tableTags.filter((tag) => tag !== NEWEST_ROW.tag))).toBeNull();
  // A set missing an older tag is caught even with every other tag present, and the refusal
  // names it.
  expect(tagSetProblem(tableTags.slice(1))).toBe(`${NEEDS_RELEASE_TAGS}; it reads no v0.1.0`);
});

/** Read the same dispatcher spelling at a release tag and in the candidate tree. */
function dispatcherRoutes(source: string, release: string): string[] {
  const routes = [...source.matchAll(/^  '?([a-z][a-z0-9-]*)'?: \(\) => import\('\.\/commands\/[^']+'\)/gm)].map(
    (match) => match[1]!,
  );
  if (routes.length === 0) throw new Error(`${release} does not read a dispatcher`);
  return routes;
}

function readReleaseTags(repo: string): string[] | null {
  try {
    return execFileSync('git', ['tag', '--list', '--sort=v:refname', 'v*'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').filter((tag) => tag !== '' && !tag.includes('-rc.'));
  } catch {
    return null;
  }
}

function releaseOpProblems(
  repo: string,
  unshipped: readonly string[],
  firstShipped: Readonly<Record<string, { tag: string; at: string } | null | undefined>>,
  refused: ReadonlySet<string> = GENERAL_REFUSED_COMMANDS,
): string[] {
  const tags = readReleaseTags(repo);
  if (tags === null || tags.length === 0) return [NEEDS_RELEASE_TAGS];
  const problems: string[] = [];
  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('the package release needs a readable version');
  }
  const release = `v${version}`;
  const date = releaseHeadingOf(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'), version)?.date ?? null;
  // Only a dated, untagged candidate is being prepared for release. An already tagged package
  // version can remain in the tree while later routes are still declared unshipped.
  if (date !== null && !tags.includes(release)) {
    const candidate = `${release} (package.json)`;
    const routes = dispatcherRoutes(readFileSync(join(repo, 'src', 'cli.ts'), 'utf8'), candidate);
    for (const op of routes) {
      if (refused.has(op)) continue;
      const row = firstShipped[op];
      if (row == null) problems.push(`${candidate} ships unmeasured op ${op}`);
      else if (row.tag === release && Date.parse(row.at) !== Date.parse(`${date}T23:59:59Z`)) {
        problems.push(`${candidate} first-shipped row for ${op} must use release boundary ${date}T23:59:59Z`);
      }
    }
  }
  for (const tag of tags) {
    const source = execFileSync('git', ['show', `${tag}:src/cli.ts`], { cwd: repo, encoding: 'utf8' });
    const routes = dispatcherRoutes(source, tag);
    for (const op of unshipped.filter((op) => routes.includes(op))) problems.push(`${tag} ships declared-unshipped op ${op}`);
  }
  return problems;
}

/** A prior release has only config; the working tree adds pending without shipping it yet. */
function candidateRepo(withTag = true): { repo: string; rows: { config: { tag: string; at: string }; pending: null } } {
  const repo = fixtureBase('.op-release-');
  homes.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(repo, 'src', 'cli.ts'), `const commands = {
  config: () => import('./commands/config.ts'),
};\n`);
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'prior fixture release'], { cwd: repo });
  if (withTag) execFileSync('git', ['tag', 'v1.0.0'], { cwd: repo });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  writeFileSync(join(repo, 'src', 'cli.ts'), `const commands = {
  config: () => import('./commands/config.ts'),
  pending: () => import('./commands/pending.ts'),
};\n`);
  return { repo, rows: { config: { tag: 'v1.0.0', at: '2026-11-01T12:00:00Z' }, pending: null } };
}

test('a prepared untagged package release needs a row with its real heading date', () => {
  const { repo, rows } = candidateRepo();
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [9.8.7] - 2026-11-07\n');
  expect(execFileSync('git', ['tag', '--list', 'v9.8.7'], { cwd: repo, encoding: 'utf8' })).toBe('');
  expect(releaseOpProblems(repo, ['pending'], rows)).toEqual(['v9.8.7 (package.json) ships unmeasured op pending']);
  expect(releaseOpProblems(repo, [], { config: rows.config })).toEqual(['v9.8.7 (package.json) ships unmeasured op pending']);
  const row = { tag: 'v9.8.7', at: '2026-11-07T23:59:59Z' };
  expect(releaseOpProblems(repo, [], { ...rows, pending: row })).toEqual([]);
  expect(releaseOpProblems(repo, [], { ...rows, pending: { ...row, at: '2026-11-06T09:00:00+01:00' } })).toEqual([
    'v9.8.7 (package.json) first-shipped row for pending must use release boundary 2026-11-07T23:59:59Z',
  ]);
  expect(releaseOpProblems(repo, [], { config: rows.config }, new Set(['pending']))).toEqual([]);
});

test('a prepared row uses the conservative end-of-day instant', () => {
  const { repo, rows } = candidateRepo();
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [9.8.7] - 2026-11-07\n');
  const row = { tag: 'v9.8.7', at: '2026-11-07T06:00:00Z' };
  expect(releaseOpProblems(repo, [], { ...rows, pending: row })).toEqual([
    'v9.8.7 (package.json) first-shipped row for pending must use release boundary 2026-11-07T23:59:59Z',
  ]);
  expect(releaseOpProblems(repo, [], { ...rows, pending: { ...row, at: '2026-11-07T23:59:59Z' } })).toEqual([]);
});

test('an unprepared package may keep its new route declared unshipped', () => {
  const { repo, rows } = candidateRepo();
  for (const changelog of ['## [Unreleased]\n', '## [9.8.7] - YYYY-MM-DD\n', '## [9.8.7] - 2026-02-30\n']) {
    writeFileSync(join(repo, 'CHANGELOG.md'), changelog);
    expect(releaseOpProblems(repo, ['pending'], rows)).toEqual([]);
  }
});

test('a previously tagged package version permits a later unshipped head route', () => {
  const { repo, rows } = candidateRepo();
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [1.0.0] - 2026-11-01\n');
  expect(releaseOpProblems(repo, ['pending'], rows)).toEqual([]);
});

test('an empty or unreadable release-tag set refuses a dated candidate', () => {
  const { repo, rows } = candidateRepo(false);
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [9.8.7] - 2026-11-07\n');
  const complete = { ...rows, pending: { tag: 'v9.8.7', at: '2026-11-07T09:00:00Z' } };
  expect(releaseOpProblems(repo, [], complete)).toEqual([NEEDS_RELEASE_TAGS]);
  const notRepo = fixtureBase('.op-release-no-git-'); homes.push(notRepo);
  expect(releaseOpProblems(notRepo, [], complete)).toEqual([NEEDS_RELEASE_TAGS]);
});

test('release tags and the package release ship no unmeasured op', () => {
  const repo = join(import.meta.dir, '..');
  const tags = readReleaseTags(repo) ?? [];
  expect(tagSetProblem(tags)).toBeNull();
  expect(releaseOpProblems(repo, UNRELEASED_OPS, OP_FIRST_SHIPPED)).toEqual([]);
});

test('a wildcard grant signed before a release reaches the ops that release shipped', () => {
  const w = world();
  // Signed after v0.5.5 and before v0.5.6: it reaches v0.5.6's four ops, then v0.5.10's one,
  // v0.5.11's one, v0.5.12's four and v0.5.16's three.
  const grant = issue(w.home, w.publicKey, ['*'], '2026-10-27T12:00:00Z');
  const widened = wildcardGrantsWidened(w.home, NOW);
  expect(widened.length).toBe(1);
  expect(widened[0]?.grant.grant_id).toBe(grant.grant_id);
  expect(widened[0]?.signed).toBe('2026-10-27T12:00:00.000Z');
  expect(widened[0]?.ops).toEqual([
    'agents', 'analyse', 'approvals', 'batch', 'checkpoint', 'fallback', 'order', 'peek', 'setup', 'show', 'trace', 'waits',
  ]);
  const note = widenedGrantNote(widened[0]!);
  expect(note).toContain(grant.grant_id);
  expect(note).toContain('signed 2026-10-27');
  expect(note).toContain('agents, analyse, approvals, batch, checkpoint, fallback, order, peek, setup, show, trace, waits');
  expect(note).toContain('re-sign the grant to stop this note');
  expect(widenedGrantNotes(w.home, NOW)).toEqual([note]);
});

test('a grant signed on a release reaches nothing of it; signed after the last release, nothing', () => {
  const w = world();
  // The v0.5.6 release time exactly: the release's own ops are not "later", only v0.5.10's,
  // v0.5.11's, v0.5.12's and v0.5.16's are.
  const on = issue(w.home, w.publicKey, ['*'], '2026-10-30T23:56:10Z');
  expect(wildcardGrantsWidened(w.home, NOW)[0]?.ops).toEqual([
    'agents', 'analyse', 'checkpoint', 'fallback', 'order', 'peek', 'show', 'trace', 'waits',
  ]);
  // Signed at v0.5.16's own tag time, the last release this table knows: nothing is later.
  const after = issue(w.home, w.publicKey, ['*'], '2026-11-07T05:08:57Z');
  const ids = wildcardGrantsWidened(w.home, NOW).map((entry) => entry.grant.grant_id);
  expect(ids).toEqual([on.grant_id]);
  expect(ids).not.toContain(after.grant_id);
});

test('a listed grant never widens, and a grant that does not verify is not named', () => {
  const w = world();
  issue(w.home, w.publicKey, ['config', 'up'], '2026-10-01T00:00:00Z');
  expect(wildcardGrantsWidened(w.home, NOW)).toEqual([]);
  // A wildcard grant whose record was edited after signing is refused by every door, so it is
  // not reported: the note reads the same records the doors read.
  const tampered = issue(w.home, w.publicKey, ['*'], '2026-10-01T00:00:00Z');
  const path = generalGrantPath(w.home, tampered.grant_id);
  const disk = JSON.parse(readFileSync(path, 'utf8')) as { general_grant: { issued: string } };
  disk.general_grant.issued = '2026-01-01T00:00:00Z';
  writeFileSync(path, JSON.stringify(disk));
  expect(wildcardGrantsWidened(w.home, NOW)).toEqual([]);
});

test('a grant with no readable signing time reads unknown, never new', () => {
  const w = world();
  const grant = issue(w.home, w.publicKey, ['*'], '2026-10-01T00:00:00Z');
  // A validly signed record whose `issued` no reader can parse: the signature covers the field,
  // so only the owner key can produce this — a foreign writer or an older shape, not a tamper.
  const path = generalGrantPath(w.home, grant.grant_id);
  const disk = JSON.parse(readFileSync(path, 'utf8')) as {
    general_grant: { entities: string[]; ops: string[]; issued: string };
    signature: string;
  };
  disk.general_grant.issued = 'signed-at-some-point';
  const body = {
    general_grant: {
      ...disk.general_grant,
      entities: [...disk.general_grant.entities].sort(),
      ops: [...disk.general_grant.ops].sort(),
    },
  };
  disk.signature = signDomain(GENERAL_GRANT_DOMAIN, body as unknown as Json, keyOf(w.home));
  writeFileSync(path, JSON.stringify(disk));

  const widened = wildcardGrantsWidened(w.home, NOW);
  expect(widened.length).toBe(1);
  expect(widened[0]?.signed).toBeNull();
  const note = widenedGrantNote(widened[0]!);
  expect(note).toContain('has no readable signing time (unknown)');
  expect(note).not.toContain('now reaches');
});
