// A wildcard general grant reaches every op, including ops that shipped after it was signed —
// without a new owner approval. `team check` and `team doctor` name each such grant once, as
// information: never a difference, never a failure. What counts as "after" is measured from the
// release tags in this repository (each op's route in the dispatcher table at each tag, by tag
// date), not remembered; the table below is that measurement.
import { afterAll, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  type GrantOp,
} from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { installKey, keyOf, signDomain, type Json } from '../src/store/keys.ts';
import { fixtureBase } from './helpers.ts';

const NOW = new Date('2026-11-01T20:00:00Z');
// A grant outlives every date this file signs at, so only the signing time decides the note.
const EXPIRES = new Date('2027-01-01T00:00:00Z');

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

test('a wildcard grant signed before a release reaches the ops that release shipped', () => {
  const w = world();
  // Signed after v0.5.5 and before v0.5.6: it reaches v0.5.6's four ops and v0.5.10's one.
  const grant = issue(w.home, w.publicKey, ['*'], '2026-10-27T12:00:00Z');
  const widened = wildcardGrantsWidened(w.home, NOW);
  expect(widened.length).toBe(1);
  expect(widened[0]?.grant.grant_id).toBe(grant.grant_id);
  expect(widened[0]?.signed).toBe('2026-10-27T12:00:00.000Z');
  expect(widened[0]?.ops).toEqual(['agents', 'approvals', 'batch', 'forget', 'setup']);
  const note = widenedGrantNote(widened[0]!);
  expect(note).toContain(grant.grant_id);
  expect(note).toContain('signed 2026-10-27');
  expect(note).toContain('agents, approvals, batch, forget, setup');
  expect(note).toContain('re-sign the grant to stop this note');
  expect(widenedGrantNotes(w.home, NOW)).toEqual([note]);
});

test('a grant signed on a release reaches nothing of it; signed after the last release, nothing', () => {
  const w = world();
  // The v0.5.6 release time exactly: the release's own ops are not "later", only v0.5.10's is.
  const on = issue(w.home, w.publicKey, ['*'], '2026-10-30T23:56:10Z');
  expect(wildcardGrantsWidened(w.home, NOW)[0]?.ops).toEqual(['agents']);
  // Signed at v0.5.10's own time, the last release this table knows: nothing is later.
  const after = issue(w.home, w.publicKey, ['*'], '2026-11-01T14:22:48Z');
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
