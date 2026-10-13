// Per-entity lobby resolution: a team that sets `entity` or `lobby` operates on its own lobby,
// while a team that sets neither keeps the machine-global `~/.config/team/lobby` exactly as before
// — so a second team on the machine no longer waits behind the first team's lobby.
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OWNER_SECTIONS, fingerprints } from '../../src/approve/fingerprint.ts';
import { placedProblems } from '../../src/file/load.ts';
import { migrationTrust } from '../../src/file/migrate.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { lobbyDir, lobbyTrustEntry, resolveLobby, verifyLobby } from '../../src/lobby/gate.ts';
import { seatStart } from '../../src/worktree/place.ts';

let base: string;
let home: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'per-entity-lobby-')));
  home = join(base, 'home');
  root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveLobby', () => {
  test('neither entity nor lobby: the machine-global lobby, unchanged', () => {
    expect(resolveLobby(home)).toBe(lobbyDir(home));
    expect(resolveLobby(home, {})).toBe(join(home, '.config', 'team', 'lobby'));
    expect(resolveLobby(home, { entity: null, lobby: null })).toBe(lobbyDir(home));
  });

  test('entity: a lobby of its own under lobbies/<slug>', () => {
    expect(resolveLobby(home, { entity: 'floor' })).toBe(join(home, '.config', 'team', 'lobbies', 'floor'));
    // The slug lower-cases the name; the section holds it to the project-name shape.
    expect(resolveLobby(home, { entity: 'Floor-IO' })).toBe(join(home, '.config', 'team', 'lobbies', 'floor-io'));
  });

  test('explicit lobby wins over entity; a ~ prefix is the home', () => {
    expect(resolveLobby(home, { lobby: '~/work/lobby' })).toBe(join(home, 'work', 'lobby'));
    expect(resolveLobby(home, { entity: 'floor', lobby: '~/elsewhere' })).toBe(join(home, 'elsewhere'));
    expect(resolveLobby(home, { lobby: '/var/team/lobby' })).toBe('/var/team/lobby');
  });
});

describe('lobbyTrustEntry', () => {
  test('default is the familiar ~/.config/team/lobby', () => {
    expect(lobbyTrustEntry(home)).toBe('~/.config/team/lobby');
  });

  test('entity names a ~ path under lobbies', () => {
    expect(lobbyTrustEntry(home, { entity: 'floor' })).toBe('~/.config/team/lobbies/floor');
  });

  test('a lobby outside the home is written absolute', () => {
    expect(lobbyTrustEntry(home, { lobby: '/var/team/lobby' })).toBe('/var/team/lobby');
  });
});

describe('the gate verifies and creates the resolved lobby', () => {
  test('create makes ~/.config/team/lobbies/<slug> at mode 0700, leaving the global lobby absent', () => {
    const entityLobby = resolveLobby(home, { entity: 'floor' });
    const gate = verifyLobby(home, { create: true, lobby: entityLobby });
    expect(gate.ok).toBe(true);
    if (gate.ok && 'path' in gate) expect(gate.path).toBe(entityLobby);
    expect(statSync(entityLobby).mode & 0o777).toBe(0o700);
    // The machine-global lobby a different team uses was not touched.
    expect(() => lstatSync(lobbyDir(home))).toThrow();
  });

  test('the not-empty check is scoped: a busy global lobby does not block a per-entity team', () => {
    // One team already holds the machine-global lobby with a seat folder in it.
    const global = lobbyDir(home);
    mkdirSync(global, { recursive: true, mode: 0o700 });
    mkdirSync(join(global, 'some-seat'));

    // A second team on its own entity lobby still comes up clean.
    const entityLobby = resolveLobby(home, { entity: 'floor' });
    const gate = verifyLobby(home, { create: true, lobby: entityLobby });
    expect(gate.ok).toBe(true);
  });

  test('the not-empty check still fires on the resolved lobby itself', () => {
    const entityLobby = resolveLobby(home, { entity: 'floor' });
    mkdirSync(entityLobby, { recursive: true, mode: 0o700 });
    mkdirSync(join(entityLobby, 'stray'));
    const gate = verifyLobby(home, { create: false, lobby: entityLobby });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain('is not empty');
  });
});

// A migrated team file with optional entity/lobby lines and the trust a migration would suggest.
function teamYaml(opts: { entity?: string; lobby?: string; lobbyTrust?: string } = {}): string {
  const lobbyTrust = opts.lobbyTrust ?? '~/.config/team/lobby';
  return `format: 1
project: acme
${opts.entity ? `entity: ${opts.entity}\n` : ''}${opts.lobby ? `lobby: "${opts.lobby}"\n` : ''}coordinator: lead
operator: lead
trust:
  - ${lobbyTrust}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

describe('parsing entity/lobby', () => {
  test('set values reach the team; absence is null', () => {
    const withEntity = validateTeamFile(teamYaml({ entity: 'floor' }));
    if (!withEntity.ok) throw new Error(`entity fixture did not validate: ${JSON.stringify(withEntity.errors)}`);
    expect(withEntity.team.entity).toBe('floor');
    expect(withEntity.team.lobby).toBeNull();

    const withLobby = validateTeamFile(teamYaml({ lobby: '~/work/lobby' }));
    if (!withLobby.ok) throw new Error('lobby fixture did not validate');
    expect(withLobby.team.lobby).toBe('~/work/lobby');

    const plain = validateTeamFile(teamYaml());
    if (!plain.ok) throw new Error('plain fixture did not validate');
    expect(plain.team.entity).toBeNull();
    expect(plain.team.lobby).toBeNull();
  });

  test('entity refuses a name that is not one path segment', () => {
    const bad = validateTeamFile(teamYaml({ entity: 'a/b' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.message.includes('entity must be'))).toBe(true);
  });
});

describe('backward compatibility of the approval digest', () => {
  test('entity and lobby are not owner sections', () => {
    expect(OWNER_SECTIONS).not.toContain('entity');
    expect(OWNER_SECTIONS).not.toContain('lobby');
  });

  test('adding entity leaves every owner-section fingerprint unchanged', () => {
    const plain = validateTeamFile(teamYaml());
    const withEntity = validateTeamFile(teamYaml({ entity: 'floor', lobbyTrust: '~/.config/team/lobbies/floor' }));
    if (!plain.ok || !withEntity.ok) throw new Error('fixtures did not validate');
    const before = fingerprints(plain.team).sections;
    const after = fingerprints(withEntity.team).sections;
    // `trust` is an owner section and the two files list different lobbies there, so it differs;
    // nothing else does, and no `entity`/`lobby` section is fingerprinted at all.
    for (const name of OWNER_SECTIONS) {
      if (name === 'trust') continue;
      expect(after[name]).toBe(before[name]);
    }
    expect(after).not.toHaveProperty('entity');
    expect(after).not.toHaveProperty('lobby');
  });
});

describe('migrate suggests the resolved lobby', () => {
  test('default team suggests ~/.config/team/lobby', () => {
    const team = validateTeamFile(teamYaml());
    if (!team.ok) throw new Error('fixture did not validate');
    const { suggestions } = migrationTrust(team.team, root, home);
    expect(suggestions[0]?.entry).toBe('~/.config/team/lobby');
  });

  test('an entity team suggests its own per-entity lobby first', () => {
    const team = validateTeamFile(teamYaml({ entity: 'floor' }));
    if (!team.ok) throw new Error('fixture did not validate');
    const { suggestions } = migrationTrust(team.team, root, home);
    expect(suggestions[0]?.entry).toBe('~/.config/team/lobbies/floor');
  });
});

describe('trust must list the resolved lobby (the owner-gated interlock)', () => {
  test('an entity team whose trust still lists only the global lobby is refused', () => {
    const team = validateTeamFile(teamYaml({ entity: 'floor' }), { home, root });
    if (!team.ok) throw new Error('fixture did not validate');
    const problems = placedProblems(team.team, root, home);
    expect(problems.some((p) => p.message.includes('must list the lobby') && p.message.includes('lobbies/floor'))).toBe(true);
  });

  test('an entity team whose trust lists its per-entity lobby passes', () => {
    const team = validateTeamFile(teamYaml({ entity: 'floor', lobbyTrust: '~/.config/team/lobbies/floor' }), { home, root });
    if (!team.ok) throw new Error('fixture did not validate');
    const problems = placedProblems(team.team, root, home);
    expect(problems.some((p) => p.message.includes('must list the lobby'))).toBe(false);
  });

  test('an explicit lobby: redirect not listed in trust is refused', () => {
    const team = validateTeamFile(teamYaml({ lobby: '~/work/floor-lobby' }), { home, root });
    if (!team.ok) throw new Error('fixture did not validate');
    const problems = placedProblems(team.team, root, home);
    expect(problems.some((p) => p.message.includes('must list the lobby') && p.message.includes('work/floor-lobby'))).toBe(true);
  });

  test('an explicit lobby: redirect listed in trust passes', () => {
    const team = validateTeamFile(teamYaml({ lobby: '~/work/floor-lobby', lobbyTrust: '~/work/floor-lobby' }), { home, root });
    if (!team.ok) throw new Error('fixture did not validate');
    const problems = placedProblems(team.team, root, home);
    expect(problems.some((p) => p.message.includes('must list the lobby'))).toBe(false);
  });
});

describe('the lobby field validator rejects a cwd-dependent or traversing value', () => {
  test('a relative lobby is refused with a clear message', () => {
    const bad = validateTeamFile(teamYaml({ lobby: 'work/lobby' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.message.includes('lobby must be an absolute path or start with "~/"'))).toBe(true);
  });

  test('a bare ~ (the home, not a folder of its own) is refused', () => {
    const bad = validateTeamFile(teamYaml({ lobby: '~' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.message.includes('lobby must be an absolute path or start with "~/"'))).toBe(true);
  });

  test('a ".." traversal in the lobby is refused', () => {
    const relTraversal = validateTeamFile(teamYaml({ lobby: '~/work/../../etc' }));
    expect(relTraversal.ok).toBe(false);
    if (!relTraversal.ok) expect(relTraversal.errors.some((e) => e.message.includes('lobby must not contain a ".." segment'))).toBe(true);

    const absTraversal = validateTeamFile(teamYaml({ lobby: '/var/team/../lobby' }));
    expect(absTraversal.ok).toBe(false);
    if (!absTraversal.ok) expect(absTraversal.errors.some((e) => e.message.includes('lobby must not contain a ".." segment'))).toBe(true);
  });

  test('an absolute and a ~/ lobby are accepted', () => {
    const abs = validateTeamFile(teamYaml({ lobby: '/var/team/lobby' }));
    expect(abs.ok).toBe(true);
    if (abs.ok) expect(abs.team.lobby).toBe('/var/team/lobby');
    const tilde = validateTeamFile(teamYaml({ lobby: '~/work/lobby' }));
    expect(tilde.ok).toBe(true);
    if (tilde.ok) expect(tilde.team.lobby).toBe('~/work/lobby');
  });
});

describe('seatStart waits in the resolved lobby', () => {
  test('a worktree seat that is not a lead starts in the per-entity lobby, and the lead starts in the project', () => {
    const team = validateTeamFile(teamYaml({ entity: 'floor', lobbyTrust: '~/.config/team/lobbies/floor' }));
    if (!team.ok) throw new Error('fixture did not validate');
    const lead = team.team.seats[0]!;
    const worker = { ...lead, name: 'worker', mode: 'worktree' as const, cwd: '.' };
    expect(seatStart(team.team, lead, root, home)).toEqual({ cwd: root });
    const start = seatStart(team.team, worker, root, home);
    expect('cwd' in start && start.cwd).toBe(resolveLobby(home, { entity: 'floor' }));
  });
});
