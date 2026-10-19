// Fail-closed scenes at the bridge (src/permissions/who.ts) and the resolver
// (src/permissions/resolve.ts): (a) a registry that cannot be read refuses every seat, naming
// "the registry cannot be read", and never falls back to the file's own declaration; (b) a
// caller the registry records nothing for, and a caller placement does not put where its record
// says, are refused on EVERY seat-record gate of the map; (c) a grant used outside its scope is
// refused, the rule named, while the same grant inside its scope admits.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, SeatStanding } from '../../src/caller.ts';
import { writeGrant, type GrantRecord } from '../../src/permissions/grants.ts';
import { COMMAND_GATES } from '../../src/permissions/map.ts';
import { resolvePermission, type CallerRecord } from '../../src/permissions/resolve.ts';
import { gateVerdict, resolveCaller, type BridgeTeam } from '../../src/permissions/who.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';

const AGENT = 'agt_0123456789ab';
const OTHER_AGENT = 'agt_ffffffffffff';
const TEAM = 'cccccccccccc';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const ROOT = '/Users/x/Code/acme';
const OTHER_ROOT = '/Users/x/Code/other';

/** The map's seat-record rows: the read surfaces that admit a caller by a registry record alone. */
const SEAT_RECORDS = Object.entries(COMMAND_GATES)
  .filter(([, gate]) => gate.kind === 'seat-record')
  .map(([command]) => command);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project root and the home beside it: the root is real, so the team id is the registry's
 *  own hash of it and grants resolve against the same paths the bridge reads. */
function world(): { root: string; home: string; id: string; otherRoot: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fail-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const root = join(base, 'acme');
  mkdirSync(root);
  const otherRoot = join(base, 'other');
  mkdirSync(otherRoot);
  return { root, home, id: teamIdOf(root), otherRoot };
}

/** The file's own side of the bridge: a team whose coordinator is `lead`, beside a plain seat. */
function fileTeam(id: string): BridgeTeam {
  return {
    id,
    orchestrator: 'lead',
    operator: 'operator',
    seats: [
      { name: 'lead', role: 'coordinator' },
      { name: 'worker', role: 'implementer' },
    ],
  };
}

/** The registry's side: the team registered for `root`, its roster the lines given. */
function register(root: string, home: string, roster: { agent: string; seat: string; role: string; leads?: boolean }[]): void {
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, roster });
}

function seatCaller(name: string, over: Partial<Extract<Caller, { kind: 'seat' }>> = {}): Caller {
  return { kind: 'seat', name, pane: 'w0:p1', session: 'acme', ...over };
}

/** The placement a seat's own state record holds: session `acme`, pane `w0:p1`, and ready. */
function placement(over: Partial<SeatStanding> = {}): SeatStanding {
  return { session: 'acme', recordedPane: 'w0:p1', stage: 'ready', ...over };
}

const SEAT: Extract<CallerRecord, { kind: 'seat' }> = {
  kind: 'seat',
  agent: AGENT,
  seat: 'worker',
  team: TEAM,
  role: 'implementer',
  bundle: [],
};

/** A seat grant naming AGENT for `merge`, scoped to `scope`. */
function seatGrant(scope: string[]): GrantRecord {
  return {
    name: 'flag-gate',
    grantor: 'owner',
    grantee: AGENT,
    kind: 'seat',
    capabilities: ['merge'],
    scope,
    issued: '2026-10-17T00:00:00.000Z',
    expires: null,
    generation: 1,
    vocabulary: 1,
  };
}

/** The team envelope carrying `merge`, scoped to `scope`. */
function envelope(scope: string[]): GrantRecord {
  return { ...seatGrant(scope), name: 'team-envelope', kind: 'team', grantee: TEAM };
}

describe('a registry that cannot be read (a)', () => {
  const SPOILERS: [string, (path: string) => void][] = [
    ['a registry file that does not parse', (path) => writeFileSync(path, 'not: [a, registry\n')],
    ['a registry path that cannot be read as a file', (path) => mkdirSync(path)],
  ];

  for (const [label, spoil] of SPOILERS) {
    test(`${label}: every seat is refused, naming the registry, never judged from the file`, () => {
      const { root, home, id } = world();
      mkdirSync(join(home, '.config', 'team'), { recursive: true });
      spoil(join(home, '.config', 'team', 'teams.yaml'));
      // The file declares `lead` the coordinator, which would admit this caller to `remove`
      // through the file fallback: the scene fails closed only if the refusal comes first.
      const decision = resolveCaller(seatCaller('lead'), fileTeam(id), root, home, 'remove', placement(), NOW);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'unreadable' });
      expect(decision.why).toContain('the registry cannot be read');
      // Every row a seat could reach is refused the same way, at the verdict shape the commands
      // branch on: `refused`, never `ok`.
      for (const command of ['remove', 'up', 'down', 'restart', 'register', ...SEAT_RECORDS]) {
        expect(gateVerdict(seatCaller('lead'), fileTeam(id), root, home, command, placement(), () => NOW))
          .toEqual({ kind: 'refused' });
      }
    });
  }
});

describe('a caller no registry record stands for (b)', () => {
  test('the map carries the nine seat-record rows this scene walks', () => {
    expect(SEAT_RECORDS).toHaveLength(9);
  });

  test('every seat-record gate refuses a record-less caller, whatever the file declares', () => {
    const { root, home, id } = world();
    const team = fileTeam(id);
    // The registry holds no record of the team, so the file's declaration supplies the record —
    // carrying no agent id, which is exactly what a seat-record row requires. The file names
    // `worker`; the row still refuses it.
    for (const command of SEAT_RECORDS) {
      const decision = resolveCaller(seatCaller('worker'), team, root, home, command, placement(), NOW);
      expect(decision).toMatchObject({ effect: 'deny', rule: 'no-record' });
      expect(gateVerdict(seatCaller('worker'), team, root, home, command, placement(), () => NOW))
        .toEqual({ kind: 'refused' });
      // No record at all is the same rule.
      expect(resolvePermission(null, { id }, command, [], { root })).toMatchObject({ effect: 'deny', rule: 'no-record' });
    }
    // The registry holds the team, and its roster does not list `lead`: the registry is the
    // record, so the file's coordinator key stands for nothing.
    const listed = world();
    register(listed.root, listed.home, [{ agent: AGENT, seat: 'worker', role: 'implementer' }]);
    for (const command of SEAT_RECORDS) {
      expect(resolveCaller(seatCaller('lead'), fileTeam(listed.id), listed.root, listed.home, command, placement(), NOW))
        .toMatchObject({ effect: 'deny', rule: 'no-record' });
    }
  });

  test('every seat-record gate refuses an unplaced caller: another pane, another session', () => {
    const { root, home, id } = world();
    register(root, home, [{ agent: AGENT, seat: 'worker', role: 'implementer' }]);
    const team = fileTeam(id);
    const scenes: [string, Caller, SeatStanding, string][] = [
      ['a pane the state does not record for the seat', seatCaller('worker', { pane: 'w9:p9' }), placement(), 'not the pane this call is on'],
      ['a caller of another session', seatCaller('worker', { session: 'other' }), placement(), 'not placed as worker in session acme'],
    ];
    for (const command of SEAT_RECORDS) {
      for (const [label, caller, at, needle] of scenes) {
        const decision = resolveCaller(caller, team, root, home, command, at, NOW);
        expect({ label, command, ...decision }).toMatchObject({ effect: 'deny', rule: 'unplaced' });
        expect(decision.why).toContain(needle);
        // The verdict shape the commands branch on refuses them too — never `ok`.
        expect(gateVerdict(caller, team, root, home, command, at, () => NOW)).not.toEqual({ kind: 'ok' });
      }
    }
    // The control: the same caller, placed where its record says, is admitted by every one of
    // the nine — the refusals above are the placement's, not the rows'. A stage short of ready
    // is still the seat: the launcher owns the stage, the gate owns the pane and the session.
    for (const command of SEAT_RECORDS) {
      expect(resolveCaller(seatCaller('worker'), team, root, home, command, placement(), NOW))
        .toMatchObject({ effect: 'allow', rule: 'record' });
      expect(resolveCaller(seatCaller('worker'), team, root, home, command, placement({ stage: 'launched' }), NOW))
        .toMatchObject({ effect: 'allow', rule: 'record' });
    }
  });
});

describe('a grant used outside its scope (c)', () => {
  test('a seat grant scoped elsewhere is refused, the rule and the grant named; inside its scope it admits', () => {
    // Control: the same records, the target inside both scopes — the seat grant admits.
    expect(resolvePermission(SEAT, { id: TEAM }, 'merge', [seatGrant([ROOT]), envelope([ROOT])], { root: ROOT }))
      .toMatchObject({ effect: 'allow', rule: 'seat-grant' });
    // The seat grant names the capability but not the target: refused under the rule, naming it.
    const outside = resolvePermission(SEAT, { id: TEAM }, 'merge', [seatGrant([OTHER_ROOT]), envelope([ROOT])], { root: ROOT });
    expect(outside).toMatchObject({ effect: 'deny', rule: 'outside-scope' });
    expect(outside.why).toContain('`flag-gate`');
    expect(outside.why).toContain('a grant is used within its scope');
    // The envelope is a scope too: the seat grant holds the target, the envelope does not.
    const unenveloped = resolvePermission(SEAT, { id: TEAM }, 'merge', [seatGrant([ROOT]), envelope([OTHER_ROOT])], { root: ROOT });
    expect(unenveloped).toMatchObject({ effect: 'deny', rule: 'outside-scope' });
    expect(unenveloped.why).toContain(`${OTHER_ROOT} does not hold`);
    expect(unenveloped.why).toContain('a grant is used within its scope');
    // A path within the root the grants do not hold is out of scope as well: the target is read
    // as it would act, never the root alone.
    const path = resolvePermission(
      SEAT,
      { id: TEAM },
      'merge',
      [seatGrant([ROOT]), envelope([ROOT])],
      { root: ROOT, path: join(OTHER_ROOT, 'inside') },
    );
    expect(path).toMatchObject({ effect: 'deny', rule: 'outside-scope' });
    // A path below a scoped root is inside it, sibling spellings included.
    expect(resolvePermission(SEAT, { id: TEAM }, 'merge', [seatGrant([ROOT]), envelope([ROOT])], { root: ROOT, path: join(ROOT, 'sub', 'dir') }))
      .toMatchObject({ effect: 'allow', rule: 'seat-grant' });
  });

  test('the bridge reads the same rule: a grant scoped elsewhere refuses the seat it names', () => {
    const { root, home, id, otherRoot } = world();
    register(root, home, [{ agent: AGENT, seat: 'worker', role: 'implementer' }]);
    writeGrant(home, { roots: [otherRoot], name: 'flag-gate', kind: 'seat', grantee: AGENT, capabilities: ['merge'] }, { now: NOW });
    writeGrant(home, { roots: [root], name: 'team-envelope', kind: 'team', grantee: id, capabilities: ['merge'] }, { now: NOW });
    const decision = resolveCaller(seatCaller('worker'), fileTeam(id), root, home, 'merge', placement(), NOW);
    expect(decision).toMatchObject({ effect: 'deny', rule: 'outside-scope' });
    expect(decision.why).toContain('a grant is used within its scope');
    expect(gateVerdict(seatCaller('worker'), fileTeam(id), root, home, 'merge', placement(), () => NOW))
      .toEqual({ kind: 'refused' });
  });
});
