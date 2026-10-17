// The owner's standing grant records, over the real files: writing them (refusals included),
// reading them back verified, and the four behaviours the grants minimum demands —
//   a team grant covers a seat added after it;
//   a seat grant survives a CLI or runner change of the same agent id;
//   a scope outside the declared roots is refused at grant time, with the path and roots named;
//   a revoked grant stops admitting at the next gate check, and the revocation never edits it.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantsDir } from '../../src/grant.ts';
import { activeGrants, covers, planRevocation, readGrants, writeGrant, writeRevocation, type GrantRequest } from '../../src/permissions/grants.ts';
import { registerAgent, updateAgent } from '../../src/registry/agents.ts';

const TEAM = 'aaaaaaaaaaaa';
const OTHER_TEAM = 'bbbbbbbbbbbb';

type World = { base: string; home: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-permissions-grants-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return { base, home };
}

function agentOf(world: World, seat: string, team: string = TEAM): string {
  return registerAgent(world.home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team, seat, session: 'teamcli', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  }).id;
}

/** A grant request with the scene's defaults; tests override what they are about. */
function request(world: World, over: Partial<GrantRequest> = {}): GrantRequest {
  return {
    name: 'flag-gate',
    kind: 'seat',
    grantee: 'agt_0123456789ab',
    capabilities: ['gate'],
    scope: ['~/Code/acme'],
    roots: ['~/Code/acme'],
    ...over,
  };
}

function granted(world: World, over: Partial<GrantRequest> = {}, now?: Date) {
  const result = writeGrant(world.home, request(world, over), now ? { now } : {});
  if (!result.ok) throw new Error(`the scene's grant was refused: ${result.why}`);
  return result.record;
}

const NOON = new Date('2026-10-17T12:00:00.000Z');

describe('grant records', () => {
  test('a written seat grant is one signed mapping the reader verifies whole', () => {
    const world = makeWorld();
    const id = agentOf(world, 'worker');
    const record = granted(world, { grantee: id, capabilities: ['merge', 'gate'] }, NOON);

    expect(record).toMatchObject({
      name: 'flag-gate',
      grantor: 'owner',
      grantee: id,
      kind: 'seat',
      capabilities: ['gate', 'merge'],
      scope: [join(world.home, 'Code', 'acme')],
      issued: NOON.toISOString(),
      expires: null,
      generation: 1,
      vocabulary: 1,
    });

    // The file is the mapping and its signature, nothing else.
    const onDisk = JSON.parse(readFileSync(join(grantsDir(world.home), 'flag-gate.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(['grant', 'signature']);

    const read = readGrants(world.home);
    expect(read.grants).toEqual([record]);
    expect(read.revocations).toEqual([]);
    expect(activeGrants(world.home, NOON)).toEqual([record]);
    expect(covers(record, { agentId: id })).toBe(true);
    expect(covers(record, { agentId: 'agt_ffffffffffff' })).toBe(false);
  });

  test('with no key and no folder the reads answer empty, never a throw', () => {
    const world = makeWorld();
    expect(readGrants(world.home)).toEqual({ grants: [], revocations: [] });
    expect(activeGrants(world.home, NOON)).toEqual([]);
  });

  test('an edited, unsigned or renamed record is not a grant: the signature covers stem and mapping', () => {
    const world = makeWorld();
    const id = agentOf(world, 'worker');
    granted(world, { grantee: id, capabilities: ['gate'] }, NOON);
    const file = join(grantsDir(world.home), 'flag-gate.json');

    // An edit after signing — here a widened capability list — does not verify.
    const edited = JSON.parse(readFileSync(file, 'utf8')) as { grant: { capabilities: string[] } };
    edited.grant.capabilities = ['gate', 'deploy'];
    writeFileSync(join(grantsDir(world.home), 'edited.json'), `${JSON.stringify(edited, null, 2)}\n`);
    // A record renamed after signing is another name, and no grant: the payload names the stem.
    const renamed = file.replace('flag-gate.json', 'renamed.json');
    writeFileSync(renamed, readFileSync(file));
    // A hand-written record with no signature at all is not a grant either.
    writeFileSync(join(grantsDir(world.home), 'hand.json'), `${JSON.stringify({ grant: edited.grant }, null, 2)}\n`);
    // An unsigned field beside the signed mapping carries no meaning: the record is refused whole.
    const extra = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    extra.note = 'free text';
    writeFileSync(join(grantsDir(world.home), 'extra.json'), `${JSON.stringify(extra, null, 2)}\n`);

    const read = readGrants(world.home);
    expect(read.grants.map((grant) => grant.name)).toEqual(['flag-gate']);
  });

  test('expiry is on the record and checked at every use; an expired grant is history, not effect', () => {
    const world = makeWorld();
    granted(world, { expires: '2026-10-17T13:00:00.000Z' }, NOON);

    expect(activeGrants(world.home, NOON)).toHaveLength(1);
    expect(activeGrants(world.home, new Date('2026-10-17T12:59:59.000Z'))).toHaveLength(1);
    expect(activeGrants(world.home, new Date('2026-10-17T13:00:00.000Z'))).toHaveLength(0);
    // The record itself stays readable: expiry is effect, never deletion.
    expect(readGrants(world.home).grants).toHaveLength(1);
  });

  test('a team grant covers a seat added after it: the record names the team, never its seats', () => {
    const world = makeWorld();
    const record = granted(world, { name: 'team-gate', kind: 'team', grantee: TEAM, capabilities: ['gate'] }, NOON);

    // The seat exists only after the grant was written...
    const late = agentOf(world, 'late-arrival');
    // ...and is covered by the same record, with nothing about it in the grant.
    expect(covers(record, { agentId: late, teamId: TEAM })).toBe(true);
    expect(covers(record, { agentId: late, teamId: OTHER_TEAM })).toBe(false);
    expect(activeGrants(world.home, NOON)).toEqual([record]);
  });

  test('a seat grant survives a CLI or runner change of the same agent id, and follows the id alone', () => {
    const world = makeWorld();
    const id = agentOf(world, 'worker');
    const record = granted(world, { grantee: id, capabilities: ['gate'] }, NOON);

    // The same agent, later: another CLI, another launch line, another pane and session.
    updateAgent(world.home, id, { cli: 'codex', launch: 'codex exec', reach: { session: 'elsewhere', pane: 'w9:p9' } });

    expect(covers(record, { agentId: id })).toBe(true);
    expect(activeGrants(world.home, NOON)).toEqual([record]);
    // The grant follows the id, never a seat name or a pane: another agent is not it.
    expect(covers(record, { agentId: 'agt_ffffffffffff' })).toBe(false);
  });
});

describe('grant refusals: nothing is written and the reason names the field', () => {
  test('a scope path outside the declared roots is refused, with the path and the roots named', () => {
    const world = makeWorld();
    const refused = writeGrant(world.home, request(world, { scope: ['~/Code/other'], roots: ['~/Code/acme'] }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.why).toContain(join(world.home, 'Code', 'other'));
    expect(refused.why).toContain('outside the declared roots');
    expect(refused.why).toContain(join(world.home, 'Code', 'acme'));
    expect(readGrants(world.home).grants).toEqual([]);

    // A relative path and a `..` walk are refused for their own reasons, and the root itself or
    // a path inside it is what a granted scope carries.
    expect(writeGrant(world.home, request(world, { scope: ['Code/acme'] })).ok).toBe(false);
    const traversal = writeGrant(world.home, request(world, { scope: ['~/Code/acme/../other'] }));
    expect(traversal.ok).toBe(false);
    if (traversal.ok) return;
    expect(traversal.why).toContain('`..`');
    const inside = writeGrant(world.home, request(world, { scope: ['~/Code/acme', '~/Code/acme/sub'] }));
    expect(inside.ok).toBe(true);
  });

  test('a team grant never carries grant, create, agree or leads; the closed vocabulary holds for both kinds', () => {
    const world = makeWorld();
    for (const name of ['grant', 'create', 'agree', 'leads']) {
      const refused = writeGrant(world.home, request(world, { kind: 'team', grantee: TEAM, capabilities: [name] }));
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.why).toContain(`\`${name}\``);
      expect(refused.why).toContain('team grant');
    }
    // A seat grant may not carry them either: they are simply outside the grantable vocabulary.
    const seat = writeGrant(world.home, request(world, { capabilities: ['leads'] }));
    expect(seat.ok).toBe(false);
    if (!seat.ok) expect(seat.why).toContain('not a grantable capability');
    // An unknown name is refused naming it, and an empty list is refused.
    const unknown = writeGrant(world.home, request(world, { capabilities: ['deploy-all'] }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.why).toContain('deploy-all');
    expect(writeGrant(world.home, request(world, { capabilities: [] })).ok).toBe(false);
    expect(readGrants(world.home).grants).toEqual([]);
  });

  test('the grantee, the name and the expiry are checked for the shape the kind calls for', () => {
    const world = makeWorld();
    // A seat grant names an agent id; a team grant a team id.
    expect(writeGrant(world.home, request(world, { kind: 'seat', grantee: TEAM })).ok).toBe(false);
    expect(writeGrant(world.home, request(world, { kind: 'team', grantee: 'agt_0123456789ab' })).ok).toBe(false);
    // One safe file name, no separators.
    expect(writeGrant(world.home, request(world, { name: 'a/b' })).ok).toBe(false);
    expect(writeGrant(world.home, request(world, { name: '.hidden' })).ok).toBe(false);
    // An unreadable expiry, and a grant that declares no root at all.
    expect(writeGrant(world.home, request(world, { expires: 'soon' })).ok).toBe(false);
    expect(writeGrant(world.home, request(world, { roots: [] })).ok).toBe(false);
    expect(readGrants(world.home).grants).toEqual([]);
  });

  test('a revocation names a grant that is there: a typo is refused, not left as a record that ends nothing', () => {
    const world = makeWorld();
    const record = granted(world, {}, NOON);
    const refused = writeRevocation(world.home, { name: 'revoke-flag', grant: record.name, generation: record.generation + 1 }, { now: NOON });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain(`no grant ${record.name} at generation ${record.generation + 1}`);
    expect(readGrants(world.home).revocations).toEqual([]);
  });
});

describe('revocation: its own appended record', () => {
  test('a revoked grant stops admitting at the next gate check; the grant file is never edited', () => {
    const world = makeWorld();
    const record = granted(world, {}, NOON);
    const file = join(grantsDir(world.home), 'flag-gate.json');
    const before = readFileSync(file);
    expect(activeGrants(world.home, NOON)).toEqual([record]);

    const revoked = writeRevocation(world.home, { name: 'revoke-flag', grant: record.name, generation: record.generation }, { now: NOON });
    expect(revoked.ok).toBe(true);

    // The next gate's read is a fresh one: the pair no longer admits...
    expect(activeGrants(world.home, NOON)).toEqual([]);
    // ...and the grant itself is untouched — appended to, never edited — and still readable.
    expect(readFileSync(file).equals(before)).toBe(true);
    const read = readGrants(world.home);
    expect(read.grants).toEqual([record]);
    expect(read.revocations).toHaveLength(1);
    expect(read.revocations[0]).toMatchObject({ name: 'revoke-flag', grant: 'flag-gate', grantGeneration: record.generation });
  });

  test('a revocation names the record, not the name: a fresh grant under the same stem is a new record', () => {
    const world = makeWorld();
    const first = granted(world, {}, NOON);
    const revoked = writeRevocation(world.home, { name: 'revoke-flag', grant: first.name, generation: first.generation }, { now: NOON });
    expect(revoked.ok).toBe(true);

    const second = granted(world, {}, new Date('2026-10-17T12:05:00.000Z'));
    expect(second.generation).toBeGreaterThan(first.generation);
    // The old revocation ends the old record alone: the new one admits.
    expect(activeGrants(world.home, NOON)).toEqual([second]);
  });

  test('a revocation named like its grant is refused at plan time; the grant file is untouched', () => {
    const world = makeWorld();
    const record = granted(world, {}, NOON);
    const file = join(grantsDir(world.home), 'flag-gate.json');
    const before = readFileSync(file);

    const clash = { name: record.name, grant: record.name, generation: record.generation };
    const plan = planRevocation(world.home, clash);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.why).toContain(`"${record.name}" is its grant's own name`);
      expect(plan.why).toContain('a revocation is a separate record');
      expect(plan.why).toContain('never writes over');
    }
    // The write refuses on the same check: the grant's own file is exactly as it was, and still a grant.
    expect(writeRevocation(world.home, clash, { now: NOON }).ok).toBe(false);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readGrants(world.home).grants).toEqual([record]);
    expect(readGrants(world.home).revocations).toEqual([]);
    expect(activeGrants(world.home, NOON)).toEqual([record]);
  });

  test('a revocation whose record name another grant holds is refused at plan time; both files stay whole', () => {
    const world = makeWorld();
    const target = granted(world, {}, NOON);
    // Another grant's file already holds the name a revocation of `flag-gate` would take.
    const clash = granted(world, { name: 'revoke-flag-gate', capabilities: ['read'] }, NOON);
    const targetFile = join(grantsDir(world.home), 'flag-gate.json');
    const clashFile = join(grantsDir(world.home), 'revoke-flag-gate.json');
    const targetBefore = readFileSync(targetFile);
    const clashBefore = readFileSync(clashFile);

    const request = { name: 'revoke-flag-gate', grant: target.name, generation: target.generation };
    const plan = planRevocation(world.home, request);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.why).toContain('"revoke-flag-gate" is another grant\'s name');
      expect(plan.why).toContain('a revocation is a separate record');
    }
    expect(writeRevocation(world.home, request, { now: NOON }).ok).toBe(false);
    expect(readFileSync(targetFile).equals(targetBefore)).toBe(true);
    expect(readFileSync(clashFile).equals(clashBefore)).toBe(true);
    expect(readGrants(world.home).grants).toEqual([target, clash]);
    expect(readGrants(world.home).revocations).toEqual([]);
    // Neither grant was ended by the refused write: both still admit.
    expect(activeGrants(world.home, NOON)).toEqual([target, clash]);
  });
});
