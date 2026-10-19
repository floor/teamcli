// Acceptance, at the decision record's own test list (decided-grants-minimum-2026-10-17, "Tests
// that make it true"), written independently of the resolver's own tests
// (test/permissions/resolve.test.ts): the resolver is deterministic — the same inputs give the
// same answer, deny beats allow, absent is deny; a caller with no registry record is refused and
// the refusal names the rule; an unknown capability name is refused; a team grant gives a seat
// nothing its role does not name; a seat grant cannot widen the team envelope; every grant and
// revocation leaves a record with its provenance. These scenes stand on grants.ts and resolve.ts
// alone — the record layer, the map, and the resolver.
//
// Three halves of the list land elsewhere and are not claimed here:
//   - the launch-time half of "an unknown capability name is refused at launch": no launch reads
//     a capability list on this base; the map and the write refuse the name today, and the
//     launch gate joins this file when the gates land;
//   - the `team check`/`up` half of the second-`leads` cardinality: that refusal is the file
//     layer's today, pinned in test/leads-at-most-one.test.ts, and the command-surface scenes
//     join with the wired round;
//   - the notice-to-the-owner half of "every grant and revocation leaves a record with its
//     provenance": 0.5.0 has no notice machinery yet. The record half is pinned below.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantsDir } from '../../src/grant.ts';
import {
  DIALOGS_TRUST,
  GRANT_CAPABILITIES,
  activeGrants,
  readGrants,
  writeGrant,
  writeRevocation,
  type GrantRecord,
  type GrantRequest,
} from '../../src/permissions/grants.ts';
import { COMMAND_GATES, isCapability } from '../../src/permissions/map.ts';
import { resolveFromHome, resolvePermission, type CallerRecord } from '../../src/permissions/resolve.ts';

const TEAM = 'aaaaaaaaaaaa';
const OTHER_TEAM = 'bbbbbbbbbbbb';
const AGENT = 'agt_0123456789ab';
const OTHER_AGENT = 'agt_ffffffffffff';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const ROOTS = ['/Users/x/Code/acme'];
const TARGET = { root: ROOTS[0] as string };

type Seat = Extract<CallerRecord, { kind: 'seat' }>;

const OWNER: CallerRecord = { kind: 'owner' };

function seat(over: Partial<Seat> = {}): CallerRecord {
  return { kind: 'seat', agent: AGENT, seat: 'builder-2', team: TEAM, role: 'implementer', bundle: [], ...over };
}

/** One record with the scene's defaults; tests override what they are about. */
function record(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    name: 'flag-gate',
    grantor: 'owner',
    grantee: AGENT,
    kind: 'seat',
    capabilities: [],
    scope: ROOTS,
    issued: '2026-10-17T00:00:00.000Z',
    expires: null,
    generation: 1,
    vocabulary: 1,
    ...over,
  };
}

/** The team-level grant — the envelope — naming a team id. */
function envelope(capabilities: readonly string[]): GrantRecord {
  return record({ name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: [...capabilities] });
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-record-acceptance-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  return home;
}

function granted(home: string, request: Omit<GrantRequest, 'roots'>): GrantRecord {
  const result = writeGrant(home, { roots: ROOTS, ...request }, { now: NOW });
  if (!result.ok) throw new Error(`the scene's grant was refused: ${result.why}`);
  return result.record;
}

describe('the resolver is deterministic — the same inputs give the same answer', () => {
  test('the same records answer the same, in whatever order a fresh read hands them over', () => {
    const grants = [
      record({ capabilities: ['merge'] }),
      envelope(['merge']),
      record({ name: 'other-agent', grantee: OTHER_AGENT, capabilities: ['gate'] }),
    ];
    const expected = resolvePermission(seat(), { id: TEAM }, 'merge', grants, TARGET);
    expect(expected).toMatchObject({ effect: 'allow', rule: 'seat-grant' });
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', grants, TARGET)).toEqual(expected);
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', [...grants].reverse(), TARGET)).toEqual(expected);
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', [...grants.slice(1), grants[0]!], TARGET)).toEqual(expected);
  });

  test('two fresh reads of one store answer the same, and an unrelated record changes nothing', () => {
    const home = makeHome();
    granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    const first = resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET);
    expect(first).toMatchObject({ effect: 'allow', rule: 'seat-grant' });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toEqual(first);
    // A record that names neither this agent nor this team is not an input to this answer.
    granted(home, { name: 'elsewhere', kind: 'team', grantee: OTHER_TEAM, capabilities: ['deploy'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toEqual(first);
  });

  test('deny beats allow: a revoked record is history, and history never admits again', () => {
    const home = makeHome();
    const grant = granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'allow' });

    const revoked = writeRevocation(home, { name: 'revoke-flag-gate', grant: grant.name, generation: grant.generation }, { now: NOW });
    expect(revoked.ok).toBe(true);
    const after = resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET);
    expect(after).toMatchObject({ effect: 'deny', rule: 'absent' });
    // The envelope still carries `merge`; only the seat's own grant ended, and it gave the
    // empty-bundle seat nothing beyond its role to begin with.
    expect(after.why).toContain('a team grant gives no seat a capability its role does not hold');
  });

  test('an expired record is history too: it admits before the hour and never at it', () => {
    const home = makeHome();
    granted(home, {
      name: 'flag-gate',
      kind: 'seat',
      grantee: AGENT,
      capabilities: ['merge'],
      expires: '2026-10-17T13:00:00.000Z',
    });
    granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', new Date('2026-10-17T12:59:59.000Z'), TARGET)).toMatchObject({ effect: 'allow' });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', new Date('2026-10-17T13:00:00.000Z'), TARGET)).toMatchObject({ effect: 'deny' });
  });

  test('absent is deny: with no records at all, every capability word is refused and said so', () => {
    for (const capability of GRANT_CAPABILITIES) {
      const decision = resolvePermission(seat(), { id: TEAM }, capability, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
      expect(decision.why).toContain('absent is deny');
    }
  });
});

describe('a caller with no registry record is refused, and the refusal names the rule', () => {
  test('every row but `any-caller` refuses a record-less caller under `no-record`', () => {
    for (const [command, gate] of Object.entries(COMMAND_GATES)) {
      if (gate.kind === 'any-caller') continue;
      const decision = resolvePermission(null, { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'no-record' });
      expect(decision.why).toContain('no registry record stands for this caller');
      expect(decision.why).toContain('and a caller with no record is refused');
    }
  });

  test('the refusal says what that row admits, so the rule is nameable from it alone', () => {
    const said: Record<string, string> = {
      grant: "`grant` is the owner's act alone in 0.5.0",
      up: '`up` admits the owner or `leads` for its own team',
      register: "`register` admits the owner or the seat's own team",
      status: '`status` admits any seat with a registry record',
      merge: '`merge` is admitted by the seat holding it, within its scope',
      send: "admission is chain position and the pair's setting, decided by the send admission",
      answer: "a pane key is the pane's lead's, a seat above's, or the owner's word",
      drops: '`drops` admits a declared seat of the team on the pane its state records, and not the owner',
      raise: '`raise` admits a seat the team marks `leads`, on its recorded pane, and not the owner',
    };
    for (const [command, phrase] of Object.entries(said)) {
      expect(resolvePermission(null, { id: TEAM }, command, [], TARGET).why).toContain(phrase);
    }
  });

  test('no store changes it: with grants written for its ids, the record-less caller is refused still', () => {
    const home = makeHome();
    granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    granted(home, { name: 'other-agent', kind: 'seat', grantee: OTHER_AGENT, capabilities: ['gate'] });
    for (const command of ['merge', 'up']) {
      expect(resolveFromHome(home, null, { id: TEAM }, command, NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'no-record' });
    }
  });
});

describe('an unknown capability name is refused, never judged', () => {
  test('the resolvable vocabulary is exactly the closed eight, and a word outside it has no row', () => {
    for (const word of GRANT_CAPABILITIES) {
      expect(isCapability(word)).toBe(true);
      expect(COMMAND_GATES[word]).toMatchObject({ kind: 'capability' });
    }
    for (const word of ['architect', 'deploy-all', 'sudo', 'create']) {
      expect(isCapability(word)).toBe(false);
      expect(COMMAND_GATES[word]).toBeUndefined();
      // The refusal comes before any caller is read, and it is the same for all of them.
      for (const caller of [OWNER, seat(), null] as const) {
        const decision = resolvePermission(caller, { id: TEAM }, word, [], TARGET);
        expect(decision).toMatchObject({ effect: 'deny', rule: 'not-in-map' });
        expect(decision.why).toContain("gates no command the Kernel's table does not name");
      }
    }
  });

  test('the owner setting is a record word, not a command: no row admits anyone to it', () => {
    expect(isCapability(DIALOGS_TRUST)).toBe(false);
    expect(COMMAND_GATES[DIALOGS_TRUST]).toBeUndefined();
    for (const caller of [OWNER, seat(), null] as const) {
      const decision = resolvePermission(caller, { id: TEAM }, DIALOGS_TRUST, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'not-in-map' });
    }
  });

  test('the write refuses the name too, naming the vocabulary, and leaves no record', () => {
    const home = makeHome();
    const refused = writeGrant(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['deploy-all'], roots: ROOTS }, { now: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.why).toContain('deploy-all');
      expect(refused.why).toContain('the vocabulary is closed');
    }
    expect(readGrants(home).grants).toEqual([]);
  });
});

describe('a team grant gives a seat nothing its role does not name', () => {
  test('the envelope carries the word and the seat holds none of it: refused, the reason said', () => {
    const decision = resolvePermission(seat(), { id: TEAM }, 'merge', [envelope(['merge'])], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
    expect(decision.why).toContain('a team grant gives no seat a capability its role does not hold');
  });

  test('all eight words enveloped: only the word the role names admits, the other seven stand refused', () => {
    const all = envelope([...GRANT_CAPABILITIES]);
    for (const capability of GRANT_CAPABILITIES) {
      expect(resolvePermission(seat(), { id: TEAM }, capability, [all], TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
    }
    expect(resolvePermission(seat({ bundle: ['merge'] }), { id: TEAM }, 'merge', [all], TARGET)).toMatchObject({ effect: 'allow', rule: 'role-bundle' });
    expect(resolvePermission(seat({ bundle: ['merge'] }), { id: TEAM }, 'gate', [all], TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
  });

  test('through the real store: the envelope admits the role that names the word, and no other seat', () => {
    const home = makeHome();
    granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat({ bundle: ['merge'] }), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'allow', rule: 'role-bundle' });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
  });
});

describe('a seat grant cannot widen the team envelope', () => {
  test('named by a grant the envelope does not carry: refused, and the intersection said', () => {
    const decision = resolvePermission(seat(), { id: TEAM }, 'merge', [
      record({ capabilities: ['merge'] }),
      envelope(['gate']),
    ], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'outside-envelope' });
    expect(decision.why).toContain('`flag-gate`');
    expect(decision.why).toContain('never a union');
  });

  test("with no envelope at all, the role's own bundle is outside it too", () => {
    const decision = resolvePermission(seat({ bundle: ['merge'] }), { id: TEAM }, 'merge', [], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'outside-envelope' });
  });

  test('inside the envelope the grant stands: widening is refused, standing is not', () => {
    const grants = [record({ capabilities: ['merge'] }), envelope(['merge', 'gate'])];
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', grants, TARGET)).toMatchObject({ effect: 'allow', rule: 'seat-grant' });
    // The envelope's second word is not thereby the seat's: only the grant's own word is.
    expect(resolvePermission(seat(), { id: TEAM }, 'gate', grants, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
  });

  test('through the real store: without an envelope the written seat grant still admits nothing', () => {
    const home = makeHome();
    granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'outside-envelope' });
  });
});

describe('every grant and revocation leaves a record with its provenance', () => {
  test('a grant: one signed file, the owner the grantor, the issue time and the generation on it', () => {
    const home = makeHome();
    const written = granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    expect(written).toMatchObject({ grantor: 'owner', issued: NOW.toISOString(), generation: 1, vocabulary: 1 });
    // The record is verified on the way back in: the provenance is signed, not annotated.
    expect(readGrants(home).grants).toEqual([written]);
    const onDisk = JSON.parse(readFileSync(join(grantsDir(home), 'flag-gate.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(['grant', 'signature']);
    expect(typeof onDisk.signature).toBe('string');
  });

  test('a revocation: its own appended record, naming the grant, its generation, the owner and the hour', () => {
    const home = makeHome();
    const grant = granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    const before = readFileSync(join(grantsDir(home), 'flag-gate.json'));
    const revoked = writeRevocation(home, { name: 'revoke-flag-gate', grant: grant.name, generation: grant.generation }, { now: NOW });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.record).toMatchObject({
      name: 'revoke-flag-gate',
      grant: 'flag-gate',
      grantGeneration: grant.generation,
      by: 'owner',
      at: NOW.toISOString(),
    });
    expect(revoked.record.generation).toBeGreaterThan(grant.generation);
    // The grant is untouched — both records' provenance is whole — and the pair decides.
    expect(readFileSync(join(grantsDir(home), 'flag-gate.json')).equals(before)).toBe(true);
    expect(readGrants(home).revocations).toEqual([revoked.record]);
    expect(activeGrants(home, NOW)).toEqual([]);
  });

  test('provenance cannot be detached: an edited copy of a record is not a record', () => {
    const home = makeHome();
    granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    const edited = JSON.parse(readFileSync(join(grantsDir(home), 'flag-gate.json'), 'utf8')) as { grant: { capabilities: string[] } };
    edited.grant.capabilities = ['merge', 'deploy'];
    writeFileSync(join(grantsDir(home), 'edited.json'), `${JSON.stringify(edited, null, 2)}\n`);
    // The stem is signed with the mapping: the edited copy is another name, and no record.
    expect(readGrants(home).grants.map((entry) => entry.name)).toEqual(['flag-gate']);
  });
});
