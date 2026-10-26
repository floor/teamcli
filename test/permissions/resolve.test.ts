// The resolver over the map (src/permissions/resolve.ts, src/permissions/map.ts): what one
// caller may do, decided from records — the owner's rows, the leads and own-team rows, the
// read surfaces, and the capability rows' own-list ∩ envelope intersection. The behaviours the
// decision record's tests demand are pinned here: the same inputs give the same answer, deny
// beats allow, absent is deny, a caller with no registry record is refused and the refusal
// names the rule, a team grant gives a seat nothing its role does not name, and a seat grant
// cannot widen the team envelope. The store scenes write real owner-signed records into a
// temporary home and resolve through `resolveFromHome` — the fresh read every gate makes.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantsDir } from '../../src/grant.ts';
import {
  activeGrants,
  GRANT_CAPABILITIES,
  GRANT_DOMAIN,
  writeGrant,
  writeRevocation,
  type GrantRecord,
  type GrantRequest,
} from '../../src/permissions/grants.ts';
import { COMMAND_GATES, type Capability } from '../../src/permissions/map.ts';
import { resolveFromHome, resolvePermission, type CallerRecord } from '../../src/permissions/resolve.ts';
import { bumpGeneration, keyOf, signDomain } from '../../src/store/keys.ts';

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
function envelope(capabilities: readonly string[], over: Partial<GrantRecord> = {}): GrantRecord {
  return record({ name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: [...capabilities], ...over });
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-resolve-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  return home;
}

function granted(home: string, request: Omit<GrantRequest, 'roots'> & { roots?: readonly string[] }): GrantRecord {
  const result = writeGrant(home, { roots: ROOTS, ...request }, { now: NOW });
  if (!result.ok) throw new Error(`the scene's grant was refused: ${result.why}`);
  return result.record;
}

describe('the owner and the rows the map does not decide', () => {
  test('the owner may act on every row the map decides, capability rows included', () => {
    for (const command of ['init', 'up', 'down', 'restart', 'add', 'remove', 'register', 'grant', 'revoke', 'delegate', ...GRANT_CAPABILITIES]) {
      const decision = resolvePermission(OWNER, { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'allow', rule: 'owner' });
      expect(decision.why).toStartWith('the owner: ');
    }
    // The two rows whose gates live elsewhere admit no one through this map — the owner's own
    // word there is those gates' to weigh, not the map's.
    const send = resolvePermission(OWNER, { id: TEAM }, 'send', [], TARGET);
    expect(send).toMatchObject({ effect: 'deny', rule: 'admission' });
    expect(send.why).toContain('chain position and the pair\'s setting');
    const answer = resolvePermission(OWNER, { id: TEAM }, 'answer', [], TARGET);
    expect(answer).toMatchObject({ effect: 'deny', rule: 'pane-authority' });
    expect(answer.why).toContain('pane\'s lead, a seat above it, or the owner\'s word');
  });

  test('an owner-only row refuses a seat, the rule named — `leads` is not `grant`', () => {
    for (const command of ['init', 'add', 'grant', 'revoke', 'delegate']) {
      const decision = resolvePermission(seat({ leads: true }), { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'owner-only' });
      expect(decision.why).toContain(`\`${command}\` is not builder-2's`);
    }
  });
});

describe('leads and the seat\'s own team', () => {
  test('an operation row admits a lead of its own team, and no one else', () => {
    for (const command of ['up', 'down', 'restart', 'remove']) {
      expect(resolvePermission(seat({ leads: true }), { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'allow',
        rule: 'leads',
      });
      const plain = resolvePermission(seat(), { id: TEAM }, command, [], TARGET);
      expect(plain).toMatchObject({ effect: 'deny', rule: 'owner-or-leads' });
      expect(plain.why).toContain('holds no `leads`');
      const elsewhere = resolvePermission(seat({ leads: true, team: OTHER_TEAM }), { id: TEAM }, command, [], TARGET);
      expect(elsewhere).toMatchObject({ effect: 'deny', rule: 'owner-or-leads' });
      expect(elsewhere.why).toContain(`leads a team, and not ${TEAM}'s`);
    }
  });

  test('register is a report: the seat\'s own team, never another\'s', () => {
    expect(resolvePermission(seat(), { id: TEAM }, 'register', [], TARGET)).toMatchObject({
      effect: 'allow',
      rule: 'own-team',
    });
    const elsewhere = resolvePermission(seat({ team: OTHER_TEAM }), { id: TEAM }, 'register', [], TARGET);
    expect(elsewhere).toMatchObject({ effect: 'deny', rule: 'owner-or-own-team' });
    expect(elsewhere.why).toContain(`belongs to ${OTHER_TEAM}, not ${TEAM}`);
  });
});

describe('the read surfaces', () => {
  test('any seat with a registry record is admitted to each of the nine', () => {
    for (const command of ['messages', 'feed', 'status', 'list', 'check', 'usage', 'available', 'next', 'waits']) {
      const decision = resolvePermission(seat(), { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'allow', rule: 'record' });
      expect(decision.why).toContain('registry record stands');
    }
  });

  test('a caller with no registry record is refused, and the refusal names the rule', () => {
    const up = resolvePermission(null, { id: TEAM }, 'up', [], TARGET);
    expect(up).toMatchObject({ effect: 'deny', rule: 'no-record' });
    expect(up.why).toContain('admits the owner or `leads` for its own team');
    const read = resolvePermission(null, { id: TEAM }, 'status', [], TARGET);
    expect(read.rule).toBe('no-record');
    expect(read.why).toContain('admits any seat with a registry record');
    const capability = resolvePermission(null, { id: TEAM }, 'merge', [], TARGET);
    expect(capability.rule).toBe('no-record');
    expect(capability.why).toContain('admitted by the seat holding it, within its scope');
  });
});

describe('the capability rows: the own list intersected with the envelope', () => {
  test('absent is deny: nothing names the capability', () => {
    const decision = resolvePermission(seat(), { id: TEAM }, 'merge', [], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
    expect(decision.why).toContain('absent is deny');
  });

  test("the role's resolved bundle inside the envelope admits, under `role-bundle`", () => {
    const decision = resolvePermission(seat({ bundle: ['merge'] }), { id: TEAM }, 'merge', [envelope(['merge'])], TARGET);
    expect(decision).toMatchObject({ effect: 'allow', rule: 'role-bundle' });
    expect(decision.why).toContain("`implementer`'s resolved bundle names `merge`");
  });

  test('a seat grant adds to the own list, and the most specific admitting rule is recorded', () => {
    const grant = record({ capabilities: ['merge'] });
    const alone = resolvePermission(seat(), { id: TEAM }, 'merge', [grant, envelope(['merge'])], TARGET);
    expect(alone).toMatchObject({ effect: 'allow', rule: 'seat-grant' });
    expect(alone.why).toContain('seat grant `flag-gate` names `merge`');
    // The bundle names it too: the written record is the more specific admitting rule.
    const both = resolvePermission(seat({ bundle: ['merge'] }), { id: TEAM }, 'merge', [grant, envelope(['merge'])], TARGET);
    expect(both).toMatchObject({ effect: 'allow', rule: 'seat-grant' });
  });

  test('a team grant gives a seat nothing its role does not name', () => {
    const decision = resolvePermission(seat(), { id: TEAM }, 'merge', [envelope(['merge'])], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
    expect(decision.why).toContain('a team grant gives no seat a capability its role does not hold');
  });

  test('a seat grant cannot widen the team envelope', () => {
    const decision = resolvePermission(seat(), { id: TEAM }, 'merge', [record({ capabilities: ['merge'] })], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'outside-envelope' });
    expect(decision.why).toContain('never a union');
    // The same denial stands when it is the bundle that names it.
    const byBundle = resolvePermission(seat({ bundle: ['merge'] }), { id: TEAM }, 'merge', [], TARGET);
    expect(byBundle).toMatchObject({ effect: 'deny', rule: 'outside-envelope' });
    expect(byBundle.why).toContain("by `implementer`'s resolved bundle");
  });

  test('the same inputs give the same answer, in any record order', () => {
    const grant = record({ capabilities: ['merge'] });
    const grants = [grant, envelope(['merge'])];
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', grants, TARGET)).toEqual(
      resolvePermission(seat(), { id: TEAM }, 'merge', grants, TARGET),
    );
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', [...grants].reverse(), TARGET)).toEqual(
      resolvePermission(seat(), { id: TEAM }, 'merge', grants, TARGET),
    );
  });

  test('a grant to another agent admits nothing for this one', () => {
    const decision = resolvePermission(seat(), { id: TEAM }, 'merge', [
      record({ grantee: OTHER_AGENT, capabilities: ['merge'] }),
      envelope(['merge']),
    ], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
  });

  test("a seat resolves within its own team's envelope, never another team's", () => {
    const decision = resolvePermission(seat({ bundle: ['merge'] }), { id: OTHER_TEAM }, 'merge', [
      envelope(['merge'], { grantee: OTHER_TEAM }),
    ], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'other-team' });
    expect(decision.why).toContain(`belongs to ${TEAM}, not ${OTHER_TEAM}`);
  });

  test("nothing resolves by a role's name: a role called `gate` holds nothing by it", () => {
    const decision = resolvePermission(seat({ role: 'gate' }), { id: TEAM }, 'gate', [envelope(['gate'])], TARGET);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'absent' });
  });

  test('every grantable word is a row of the map', () => {
    for (const capability of GRANT_CAPABILITIES) {
      const decision = resolvePermission(
        seat({ bundle: [capability as Capability] }),
        { id: TEAM },
        capability,
        [envelope([capability])],
        TARGET,
      );
      expect(decision).toMatchObject({ effect: 'allow', rule: 'role-bundle' });
    }
  });
});

describe('the map names every word the contract exposes, and no more', () => {
  test('a word the map does not name is refused, not judged', () => {
    for (const command of ['sudo', 'create', 'approve', 'teleport']) {
      const decision = resolvePermission(OWNER, { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'not-in-map' });
      expect(decision.why).toContain("gates no command the Kernel's table does not name");
    }
  });

  test('the map holds the table\'s rows and every contract word, and nothing else', () => {
    const reads = ['messages', 'feed', 'status', 'list', 'check', 'usage', 'available', 'next', 'waits'];
    const table = ['init', 'up', 'down', 'restart', 'reload', 'add', 'remove', 'rename', 'register', 'grant', 'revoke', 'delegate', 'send', 'answer', ...reads, ...GRANT_CAPABILITIES];
    const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'contract', 'cli.json'), 'utf8')) as {
      commands: { name: string; subcommands?: { name: string }[] }[];
    };
    const exposed = contract.commands.flatMap((command) => [
      command.name,
      ...(command.subcommands ?? []).map((sub) => `${command.name}:${sub.name}`),
    ]);
    expect(Object.keys(COMMAND_GATES).sort()).toEqual([...new Set([...table, ...exposed])].sort());
  });

  test('`any-caller` admits a caller with no record at all', () => {
    for (const command of ['help', 'doctor']) {
      expect(resolvePermission(null, { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'allow',
        rule: 'any-caller',
      });
    }
  });

  test('a row carrying a terminal requirement refuses here without the bridge\'s proof', () => {
    for (const command of ['watch', 'proc', 'proc:add', 'proc:done', 'bus', 'approvals:revoke', 'forget']) {
      for (const caller of [null, OWNER, seat({ leads: true })]) {
        const decision = resolvePermission(caller, { id: TEAM }, command, [], TARGET);
        expect(decision, `${command} should refuse without the proof`).toMatchObject({ effect: 'deny', rule: 'terminal' });
        expect(decision.why).toContain('only ');
      }
    }
    // The proof is the module's `detachedRefusal` answer, both undefined where it permits:
    // the row then decides as it stands, never by a record alone.
    expect(resolvePermission(null, { id: TEAM }, 'watch', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'allow',
      rule: 'any-caller',
    });
    expect(resolvePermission(seat(), { id: TEAM }, 'proc', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'allow',
      rule: 'own-team',
    });
    expect(resolvePermission(OWNER, { id: TEAM }, 'proc', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'allow',
      rule: 'owner',
    });
    // `bus` is the owner or a lead, and only once a terminal is shown. A plain seat stays out.
    expect(resolvePermission(OWNER, { id: TEAM }, 'bus', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'allow',
      rule: 'owner',
    });
    expect(resolvePermission(seat({ leads: true }), { id: TEAM }, 'bus', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'allow',
      rule: 'leads',
    });
    expect(resolvePermission(seat(), { id: TEAM }, 'bus', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'deny',
      rule: 'owner-or-leads',
    });
    expect(resolvePermission(OWNER, { id: TEAM }, 'forget', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'allow',
      rule: 'owner',
    });
    expect(resolvePermission(seat(), { id: TEAM }, 'approvals:revoke', [], TARGET, { terminal: true })).toMatchObject({
      effect: 'deny',
      rule: 'owner-only',
    });
  });

  test('a `team-change` row is the verdict function\'s, and a record alone refuses it', () => {
    for (const command of ['hold', 'worktree', 'worktree:list', 'worktree:new', 'worktree:remove']) {
      expect(COMMAND_GATES[command]?.kind).toBe('team-change');
      // A `leads` seat is not one of the three callers the function admits, and membership is
      // not placement: the record-only resolver says so and names the function.
      const decision = resolvePermission(seat({ leads: true }), { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'team-change' });
      expect(decision.why).toContain('mayChangeTeamVerdict');
      // The owner is one of the three, and the resolver says the row is the owner's.
      expect(resolvePermission(OWNER, { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'allow',
        rule: 'owner',
      });
    }
  });

  test('a `team-read` row is the read gate\'s, and a record alone refuses it', () => {
    for (const command of ['policy', 'proc:list', 'seats']) {
      expect(COMMAND_GATES[command]?.kind).toBe('team-read');
      // Membership is not placement and is no delegate evidence: the resolver refuses, and
      // says the read gate decides.
      const decision = resolvePermission(seat(), { id: TEAM }, command, [], TARGET);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'team-read' });
      expect(decision.why).toContain('mayReadTeam');
      // The owner is admitted before the read gate runs, and the resolver agrees.
      expect(resolvePermission(OWNER, { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'allow',
        rule: 'owner',
      });
    }
  });

  test('`seat-only` admits a seat of the team, and neither the owner nor another team\'s seat', () => {
    for (const command of ['drops', 'plan']) {
      expect(resolvePermission(seat(), { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'allow',
        rule: 'own-team',
      });
      expect(resolvePermission(OWNER, { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'deny',
        rule: 'seat-only',
      });
      expect(resolvePermission(seat({ team: OTHER_TEAM }), { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'deny',
        rule: 'seat-only',
      });
    }
  });

  test('`leads-only` admits a lead of the team, and neither the owner nor a seat without `leads`', () => {
    expect(resolvePermission(seat({ leads: true }), { id: TEAM }, 'raise', [], TARGET)).toMatchObject({
      effect: 'allow',
      rule: 'leads',
    });
    expect(resolvePermission(seat(), { id: TEAM }, 'raise', [], TARGET)).toMatchObject({
      effect: 'deny',
      rule: 'leads-only',
    });
    expect(resolvePermission(OWNER, { id: TEAM }, 'raise', [], TARGET)).toMatchObject({
      effect: 'deny',
      rule: 'leads-only',
    });
    expect(resolvePermission(seat({ leads: true, team: OTHER_TEAM }), { id: TEAM }, 'raise', [], TARGET)).toMatchObject({
      effect: 'deny',
      rule: 'leads-only',
    });
  });

  test('the words whose modules refuse non-owners outright say `owner-only`', () => {
    for (const command of ['broker', 'tempo']) {
      expect(resolvePermission(OWNER, { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'allow',
        rule: 'owner',
      });
      expect(resolvePermission(seat(), { id: TEAM }, command, [], TARGET)).toMatchObject({
        effect: 'deny',
        rule: 'owner-only',
      });
    }
  });
});

describe('records: the fresh read every gate makes', () => {
  test('a live seat grant admits through the real store, and its revocation stops it at the next read', () => {
    const home = makeHome();
    const written = granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
    // Deny beats allow: the revoked record is not among the active set, so only the envelope
    // stands — and it gives the seat nothing its role does not name.
    const revoked = writeRevocation(home, { name: 'revoke-flag-gate', grant: 'flag-gate', generation: written.generation }, { now: NOW });
    expect(revoked.ok).toBe(true);
    const after = resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET);
    expect(after).toMatchObject({ effect: 'deny', rule: 'absent' });
  });

  test('revoking the team envelope ends every seat grant inside it', () => {
    const home = makeHome();
    granted(home, { name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    const firstEnvelope = granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    const secondEnvelope = granted(home, { name: 'team-envelope-overlap', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'allow', rule: 'seat-grant' });

    // Revoking one of two overlapping envelopes already ends the covered seat grant durably.
    expect(writeRevocation(home, { name: 'revoke-envelope', grant: 'team-envelope', generation: firstEnvelope.generation }, { now: NOW }).ok).toBe(true);
    expect(activeGrants(home, NOW).filter((grant) => grant.kind === 'seat')).toEqual([]);
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });

    // Revoking the remaining covering envelope leaves no active envelope at all.
    const revoked = writeRevocation(
      home,
      { name: 'revoke-envelope-overlap', grant: 'team-envelope-overlap', generation: secondEnvelope.generation },
      { now: NOW },
    );
    expect(revoked.ok).toBe(true);
    const after = resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET);
    expect(after).toMatchObject({ effect: 'deny', rule: 'outside-envelope' });

    // A replacement covering envelope does not revive the pre-revocation seat grant; only a fresh
    // explicit seat grant issued after the envelope revocation admits again.
    granted(home, { name: 'team-envelope-next', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({
      effect: 'deny',
      rule: 'absent',
    });
    granted(home, { name: 'flag-gate-next', kind: 'seat', grantee: AGENT, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
  });

  test('envelope revocation stays durable across envelope overwrite, removal, replay, and exact-generation legacy records', () => {
    const home = makeHome();
    const otherRoot = '/Users/x/Code/other';
    granted(home, { name: 'seat-gate', kind: 'seat', grantee: AGENT, capabilities: ['gate'] });
    granted(
      home,
      { name: 'seat-merge-other', kind: 'seat', grantee: AGENT, capabilities: ['merge'], scope: [otherRoot], roots: [otherRoot] },
    );
    const envA = granted(home, { name: 'env-a', kind: 'team', grantee: TEAM, capabilities: ['gate'] });
    const envAPath = join(grantsDir(home), 'env-a.json');
    const envAOldBytes = readFileSync(envAPath);
    granted(home, { name: 'env-b', kind: 'team', grantee: TEAM, capabilities: ['gate'] });

    expect(writeRevocation(home, { name: 'revoke-env-a', grant: 'env-a', generation: envA.generation }, { now: NOW }).ok).toBe(true);
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });

    // Overwriting env-a.json under the same stem with a new generation carrying different scope/capabilities
    // neither revives seat-gate nor falsely terminates seat-merge-other (which was issued before revoke-env-a).
    const envAReissued = writeGrant(
      home,
      { name: 'env-a', kind: 'team', grantee: TEAM, capabilities: ['merge'], scope: [otherRoot], roots: [otherRoot] },
      { now: NOW },
    );
    expect(envAReissued.ok).toBe(true);
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: otherRoot })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });

    // Removing env-a.json from disk still preserves seat-gate's durable termination via the signed revocation envelope.
    unlinkSync(envAPath);
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
    expect(activeGrants(home, NOW).filter((grant) => grant.kind === 'seat').map((grant) => grant.name)).toEqual([
      'seat-merge-other',
    ]);

    // Replaying the originally signed env-a@gen bytes onto disk neither activates env-a nor revives seat-gate.
    writeFileSync(envAPath, envAOldBytes);
    expect(activeGrants(home, NOW).filter((grant) => grant.kind === 'team').map((grant) => grant.name)).toEqual(['env-b']);
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });

    // A legacy revocation record (signed without an embedded `envelope` field) uses the exact
    // on-disk grant_generation while that envelope file is present, and fails closed for older
    // seat grants if the legacy revoked envelope file is removed or overwritten.
    const folder = grantsDir(home);
    granted(
      home,
      { name: 'env-merge-other', kind: 'team', grantee: TEAM, capabilities: ['merge'], scope: [otherRoot], roots: [otherRoot] },
    );
    const legacyEnv = granted(
      home,
      { name: 'env-legacy', kind: 'team', grantee: TEAM, capabilities: ['deploy'], scope: [otherRoot], roots: [otherRoot] },
    );
    const legacyRevGen = bumpGeneration(folder, home, NOW);
    const legacyDisk = {
      grant: 'env-legacy',
      grant_generation: legacyEnv.generation,
      by: 'owner',
      at: NOW.toISOString(),
      generation: legacyRevGen,
    };
    const legacySig = signDomain(GRANT_DOMAIN, { name: 'revoke-env-legacy', revocation: legacyDisk }, keyOf(home));
    writeFileSync(join(folder, 'revoke-env-legacy.json'), `${JSON.stringify({ revocation: legacyDisk, signature: legacySig }, null, 2)}\n`);
    // While env-legacy@gen is still on disk, its exact (`deploy`, otherRoot) boundary is known, so
    // `seat-merge-other` (`merge` at otherRoot) remains active.
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: otherRoot })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
    // If the legacy revoked envelope file is removed or overwritten (whether by a different team's
    // envelope or by a seat grant under the same stem) so its original boundary can no longer be
    // verified from disk, `activeGrants` never infers historical target identity/kind/scope from a
    // newer same-stem record and fails closed for pre-existing seat grants older than `legacyRevGen`.
    unlinkSync(join(folder, 'env-legacy.json'));
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: otherRoot })).toMatchObject({
      effect: 'deny',
      rule: 'absent',
    });
    granted(
      home,
      { name: 'env-legacy', kind: 'team', grantee: 'bbbbbbbbbbbb', capabilities: ['merge'], scope: [otherRoot], roots: [otherRoot] },
    );
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: otherRoot })).toMatchObject({
      effect: 'deny',
      rule: 'absent',
    });
    granted(
      home,
      { name: 'env-legacy', kind: 'seat', grantee: 'agt_999999999999', capabilities: ['merge'], scope: [otherRoot], roots: [otherRoot] },
    );
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: otherRoot })).toMatchObject({
      effect: 'deny',
      rule: 'absent',
    });
    granted(
      home,
      { name: 'seat-merge-other-fresh', kind: 'seat', grantee: AGENT, capabilities: ['merge'], scope: [otherRoot], roots: [otherRoot] },
    );
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: otherRoot })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
  });

  test('revoking an envelope that covers part of a multi-scope, multi-capability seat grant preserves its uncovered capabilities and scopes', () => {
    const home = makeHome();
    const rootA = '/Users/x/Code/acme';
    const rootB = '/Users/x/Code/beta';
    granted(home, {
      name: 'seat-multi',
      kind: 'seat',
      grantee: AGENT,
      capabilities: ['gate', 'merge'],
      scope: [rootA, rootB],
      roots: [rootA, rootB],
    });
    const envGateA = granted(home, {
      name: 'env-gate-a',
      kind: 'team',
      grantee: TEAM,
      capabilities: ['gate'],
      scope: [rootA],
      roots: [rootA],
    });
    const envGateB = granted(home, {
      name: 'env-gate-b',
      kind: 'team',
      grantee: TEAM,
      capabilities: ['gate'],
      scope: [rootB],
      roots: [rootB],
    });
    granted(home, {
      name: 'env-merge-both',
      kind: 'team',
      grantee: TEAM,
      capabilities: ['merge'],
      scope: [rootA, rootB],
      roots: [rootA, rootB],
    });

    // Revoke only the envelope covering (`gate`, rootA) and even issue a replacement envelope for (`gate`, rootA).
    expect(writeRevocation(home, { name: 'revoke-gate-a', grant: 'env-gate-a', generation: envGateA.generation }, { now: NOW }).ok).toBe(true);
    granted(home, {
      name: 'env-gate-a-next',
      kind: 'team',
      grantee: TEAM,
      capabilities: ['gate'],
      scope: [rootA],
      roots: [rootA],
    });

    // (`gate`, rootA) is durably ended, while (`gate`, rootB) and (`merge`, rootA/rootB) remain active.
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, { root: rootA })).toMatchObject({
      effect: 'deny',
      rule: 'outside-scope',
    });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, { root: rootB })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: rootA })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: rootB })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });

    // Direct `resolvePermission` over `activeGrants(home, NOW)` (without teamId) and over shallow
    // object-spread clones of those records reaches the exact same answers.
    const active = activeGrants(home, NOW);
    expect(resolvePermission(seat(), { id: TEAM }, 'gate', active, { root: rootA }).effect).toBe('deny');
    expect(resolvePermission(seat(), { id: TEAM }, 'gate', active, { root: rootB })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
    expect(resolvePermission(seat(), { id: TEAM }, 'merge', active, { root: rootA })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
    const cloned = active.map((entry) => ({ ...entry }));
    expect(resolvePermission(seat(), { id: TEAM }, 'gate', cloned, { root: rootA }).effect).toBe('deny');
    expect(resolvePermission(seat(), { id: TEAM }, 'gate', cloned, { root: rootB })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });

    // Revoking (`gate`, rootB) as well ends `gate` across all scopes on `seat-multi`, narrowing its
    // active capabilities to `['merge']` while still preserving `merge` at both roots.
    expect(writeRevocation(home, { name: 'revoke-gate-b', grant: 'env-gate-b', generation: envGateB.generation }, { now: NOW }).ok).toBe(true);
    const activeAfterBothGateRevoked = activeGrants(home, NOW).filter((grant) => grant.kind === 'seat');
    expect(activeAfterBothGateRevoked).toHaveLength(1);
    expect(activeAfterBothGateRevoked[0]?.capabilities).toEqual(['merge']);
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, { root: rootA })).toMatchObject({
      effect: 'deny',
      rule: 'absent',
    });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, { root: rootA })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });

    // A fresh explicit seat grant issued after the revocations recovers (`gate`, rootA).
    granted(home, {
      name: 'seat-gate-fresh',
      kind: 'seat',
      grantee: AGENT,
      capabilities: ['gate'],
      scope: [rootA],
      roots: [rootA],
    });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'gate', NOW, { root: rootA })).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
  });

  test('an expired grant is not among the active set either', () => {
    const home = makeHome();
    granted(home, {
      name: 'flag-gate',
      kind: 'seat',
      grantee: AGENT,
      capabilities: ['merge'],
      expires: '2026-10-17T11:00:00.000Z',
    });
    granted(home, { name: 'team-envelope', kind: 'team', grantee: TEAM, capabilities: ['merge'] });
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', NOW, TARGET)).toMatchObject({ effect: 'deny', rule: 'absent' });
    // Before the expiry, the same records admit.
    expect(resolveFromHome(home, seat(), { id: TEAM }, 'merge', new Date('2026-10-17T10:00:00.000Z'), TARGET)).toMatchObject({
      effect: 'allow',
      rule: 'seat-grant',
    });
  });
});
