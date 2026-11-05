// A wildcard general grant reaches every op, including ops that shipped after it was signed —
// without a new owner approval. `team check` and `team doctor` name each such grant once, as
// information: never a difference, never a failure. What counts as "after" is measured from the
// release tags in this repository (each op's route in the dispatcher table at each tag, by tag
// date), not remembered; the table below is that measurement.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commands } from '../src/cli.ts';
import {
  GENERAL_GRANT_DOMAIN,
  GENERAL_OPS,
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

const NOW = new Date('2026-11-06T00:00:00Z');
// A grant outlives every date this file signs at, so only the signing time decides the note.
const EXPIRES = new Date('2027-01-01T00:00:00Z');
// Ops whose route the dispatcher has but no release row measures yet. A release that first
// ships one adds its row and takes the op out of this list; a route that is neither measured
// nor named here fails the check below, so a new op cannot slip past unmeasured. The 0.5.12
// row measures `fallback`, `order`, `trace` and `waits`, while checkpoint and show remain unreleased.
const UNRELEASED_OPS: readonly string[] = ['checkpoint', 'show'];

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
  const routes = Object.keys(commands);
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

test('an op declared unshipped is a route at no release tag', () => {
  // The declaration can rot in the one way the equality above cannot see: the op ships in a
  // release while its row and this list are both left untouched, so the null entry and the
  // declaration still agree. Measure the declaration against the releases themselves: an op
  // declared unshipped is a route at no release tag. Once a tag carries it, this fails until
  // the row is added, which also takes the op out of the declaration. Each tag's dispatcher
  // table is read the way the table above was measured (every non-rc tag yields one, 11 at
  // v0.1.0 through 68 at v0.5.10), so a tag this reader cannot parse fails here too.
  const repo = join(import.meta.dir, '..');
  let listed = '';
  try {
    listed = execFileSync('git', ['tag', '--list', '--sort=v:refname', 'v*'], { cwd: repo, encoding: 'utf8' });
  } catch {
    // No git, or no repository here: the guard below names what the walk needs.
  }
  const tags = listed
    .split('\n')
    .filter((tag) => tag !== '' && !tag.includes('-rc.'));
  expect(tagSetProblem(tags)).toBeNull();
  for (const tag of tags) {
    const source = execFileSync('git', ['show', `${tag}:src/cli.ts`], { cwd: repo, encoding: 'utf8' });
    const routes = [...source.matchAll(/^  '?([a-z][a-z0-9-]*)'?: \(\) => import\('\.\/commands\/[^']+'\)/gm)].map(
      (match) => match[1]!,
    );
    expect(routes.length, `${tag} reads its dispatcher`).toBeGreaterThan(0);
    expect(UNRELEASED_OPS.filter((op) => routes.includes(op)), `${tag} ships no declared-unshipped op`).toEqual([]);
  }
});

test('a wildcard grant signed before a release reaches the ops that release shipped', () => {
  const w = world();
  // Signed after v0.5.5 and before v0.5.6: it reaches v0.5.6's four ops, then v0.5.10's one,
  // v0.5.11's one and v0.5.12's four.
  const grant = issue(w.home, w.publicKey, ['*'], '2026-10-27T12:00:00Z');
  const widened = wildcardGrantsWidened(w.home, NOW);
  expect(widened.length).toBe(1);
  expect(widened[0]?.grant.grant_id).toBe(grant.grant_id);
  expect(widened[0]?.signed).toBe('2026-10-27T12:00:00.000Z');
  expect(widened[0]?.ops).toEqual([
    'agents', 'approvals', 'batch', 'fallback', 'forget', 'order', 'peek', 'setup', 'trace', 'waits',
  ]);
  const note = widenedGrantNote(widened[0]!);
  expect(note).toContain(grant.grant_id);
  expect(note).toContain('signed 2026-10-27');
  expect(note).toContain('agents, approvals, batch, fallback, forget, order, peek, setup, trace, waits');
  expect(note).toContain('re-sign the grant to stop this note');
  expect(widenedGrantNotes(w.home, NOW)).toEqual([note]);
});

test('a grant signed on a release reaches nothing of it; signed after the last release, nothing', () => {
  const w = world();
  // The v0.5.6 release time exactly: the release's own ops are not "later", only v0.5.10's,
  // v0.5.11's and v0.5.12's are.
  const on = issue(w.home, w.publicKey, ['*'], '2026-10-30T23:56:10Z');
  expect(wildcardGrantsWidened(w.home, NOW)[0]?.ops).toEqual([
    'agents', 'fallback', 'order', 'peek', 'trace', 'waits',
  ]);
  // Signed at v0.5.12's own time, the last release this table knows: nothing is later.
  const after = issue(w.home, w.publicKey, ['*'], '2026-11-05T22:50:33Z');
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
