// Per-entity lobby resolution: a team that sets `entity` or `lobby` operates on its own lobby,
// while a team that sets neither keeps the machine-global `~/.config/team/lobby` exactly as before
// — so a second team on the machine no longer waits behind the first team's lobby.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OWNER_SECTIONS, fingerprints } from '../../src/approve/fingerprint.ts';
import { placedProblems } from '../../src/file/load.ts';
import { migrationTrust } from '../../src/file/migrate.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { lobbyDir, lobbyTrustEntry, resolveLobby, verifyLobby } from '../../src/lobby/gate.ts';
import { lobbyOf } from '../../src/lobby/recorded.ts';
import { shippedStartupReads } from '../../src/profiles/index.ts';
import { registerLaunch } from '../../src/registry/sync.ts';
import { getTeam, noteTeam, teamIdOf } from '../../src/registry/teams.ts';
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

  test('a stray directory on the entity lobby passes, and a file a CLI reads at start is refused', () => {
    const entityLobby = resolveLobby(home, { entity: 'floor' });
    mkdirSync(entityLobby, { recursive: true, mode: 0o700 });
    mkdirSync(join(entityLobby, 'stray'));
    const stray = verifyLobby(home, { create: false, reads: shippedStartupReads(), lobby: entityLobby });
    expect(stray.ok).toBe(true);
    writeFileSync(join(entityLobby, 'CLAUDE.md'), 'plant\n');
    const gate = verifyLobby(home, { create: false, reads: shippedStartupReads(), lobby: entityLobby });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain('CLAUDE.md is read at start by claude-code, cursor and grok');
  });
});

// A team file with optional entity/lobby lines, the trust a migration would suggest, and the
// legacy shape (no trust at all) a migration block is printed for.
function teamYaml(opts: { entity?: string; lobby?: string; lobbyTrust?: string; legacy?: boolean } = {}): string {
  const lobbyTrust = opts.lobbyTrust ?? '~/.config/team/lobby';
  const trust = opts.legacy ? '' : `trust:\n  - ${lobbyTrust}\n  - ${root}\n`;
  return `format: 1
project: acme
${opts.entity ? `entity: ${opts.entity}\n` : ''}${opts.lobby ? `lobby: "${opts.lobby}"\n` : ''}coordinator: lead
operator: lead
session: acme
${trust}workspace:
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

  test('adding entity changes the lobby trust and the derived session, and no other owner section', () => {
    // Both fixtures omit `session`, so it is the default the entity moves.
    const plain = validateTeamFile(teamYaml().replace('session: acme\n', ''));
    const withEntity = validateTeamFile(teamYaml({ entity: 'floor', lobbyTrust: '~/.config/team/lobbies/floor' }).replace('session: acme\n', ''));
    if (!plain.ok || !withEntity.ok) throw new Error('fixtures did not validate');
    const before = fingerprints(plain.team).sections;
    const after = fingerprints(withEntity.team).sections;
    // Exactly two owner sections differ, and the two are the whole list. `trust` is the lobby the
    // migration writes. `session` is the entity-aware default: neither fixture writes the key, and
    // an omitted session is `<entity>-<project>`, so adding an entity moves the session — the file
    // is no longer the one the owner approved, and the digest has to say so. Every other owner
    // section is untouched, and no `entity`/`lobby` section is fingerprinted at all.
    const changed = OWNER_SECTIONS.filter((name) => after[name] !== before[name]);
    expect(changed.sort()).toEqual(['session', 'trust']);
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

describe('a legacy file\'s block is computed from the recorded lobby', () => {
  test('the block names the recorded lobby after an entity rename, and pasting it passes placement', () => {
    // The team registered under entity `acme`; its file is edited to `renew` before trust is
    // ever migrated. The block is what the owner pastes, so it must name the folder the team
    // actually starts in — the recorded one — not the renamed entity's derivation.
    noteTeam(home, root, { project: 'acme', entity: 'acme', session: 'acme', lobby: null }, 'defined', 'owner');
    const legacy = validateTeamFile(teamYaml({ entity: 'renew', legacy: true }), { home, root });
    if (!legacy.ok) throw new Error('fixture did not validate');
    const { suggestions } = migrationTrust(legacy.team, root, home);
    expect(suggestions[0]?.entry).toBe('~/.config/team/lobbies/acme');

    // Pasting that entry is accepted: the placement check resolves the same recorded lobby.
    const pasted = validateTeamFile(teamYaml({ entity: 'renew', lobbyTrust: suggestions[0]!.entry }), { home, root });
    if (!pasted.ok) throw new Error('pasted fixture did not validate');
    expect(placedProblems(pasted.team, root, home)).toEqual([]);
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

describe('the registry records the lobby once, and the record stands', () => {
  const seed = (entity: string) => ({ project: 'acme', entity, session: 'acme', lobby: null });
  const asFile = (entity: string) => ({ project: 'acme', session: 'acme', entity });

  test('a new team derives its lobby from its entity', () => {
    noteTeam(home, root, seed('Acme'), 'defined', 'owner');
    expect(getTeam(home, teamIdOf(root))?.lobby).toBe(join(home, '.config', 'team', 'lobbies', 'acme'));
    expect(lobbyOf(home, root, asFile('Acme'))).toBe(join(home, '.config', 'team', 'lobbies', 'acme'));
  });

  test('changing the entity leaves the recorded lobby in place', () => {
    noteTeam(home, root, seed('Acme'), 'defined', 'owner');
    noteTeam(home, root, seed('fleet'), 'running', 'owner');
    // The record keeps the folder the seats were trusted for, and the new entity's lobby is not
    // what the team operates on — nor created for it.
    expect(getTeam(home, teamIdOf(root))?.lobby).toBe(join(home, '.config', 'team', 'lobbies', 'acme'));
    expect(lobbyOf(home, root, asFile('fleet'))).toBe(join(home, '.config', 'team', 'lobbies', 'acme'));
    expect(existsSync(join(home, '.config', 'team', 'lobbies', 'fleet'))).toBe(false);
  });

  test('a team the registry holds no lobby for still derives from its entity', () => {
    expect(lobbyOf(home, root, asFile('Acme'))).toBe(join(home, '.config', 'team', 'lobbies', 'acme'));
  });

  test('another team in the same checkout derives from its own entity, not the record', () => {
    noteTeam(home, root, seed('Acme'), 'defined', 'owner');
    // The registry is keyed by the root; this file's session is its own, so the lobby noted for
    // the first team is not its lobby.
    expect(lobbyOf(home, root, { project: 'acme', session: 'beta', entity: 'zeta' })).toBe(join(home, '.config', 'team', 'lobbies', 'zeta'));
    noteTeam(home, root, { project: 'acme', session: 'beta', entity: 'zeta', lobby: null }, 'defined', 'owner');
    expect(getTeam(home, teamIdOf(root))?.lobby).toBe(join(home, '.config', 'team', 'lobbies', 'zeta'));
  });

  test('a second team in the same checkout leaves the first team\'s recorded lobby in place', () => {
    const first = join(home, '.config', 'team', 'lobbies', 'acme');
    noteTeam(home, root, { project: 'acme', session: 'alpha', entity: 'acme', lobby: null }, 'defined', 'owner');
    // The registry holds one record per root, and the second file registers under its own
    // session: it becomes the record's primary, but the first session's lobby is still noted.
    noteTeam(home, root, { project: 'acme', session: 'beta', entity: 'zeta', lobby: null }, 'defined', 'owner');
    const second = join(home, '.config', 'team', 'lobbies', 'zeta');
    expect(getTeam(home, teamIdOf(root))?.session).toBe('beta');
    expect(getTeam(home, teamIdOf(root))?.lobbies).toEqual({ alpha: first, beta: second });

    // File A is edited where it stands — its entity renamed — and still reads its own lobby.
    expect(lobbyOf(home, root, { project: 'acme', session: 'alpha', entity: 'renew' })).toBe(first);
    noteTeam(home, root, { project: 'acme', session: 'alpha', entity: 'renew', lobby: null }, 'running', 'owner');
    expect(getTeam(home, teamIdOf(root))?.lobbies).toEqual({ alpha: first, beta: second });
    expect(lobbyOf(home, root, { project: 'acme', session: 'alpha', entity: 'renew' })).toBe(first);
    // File B still reads the lobby its own session recorded.
    expect(lobbyOf(home, root, { project: 'acme', session: 'beta', entity: 'zeta' })).toBe(second);
  });

  test('up --session alt records alt and the file\'s own session; an entity edit moves neither', () => {
    const team = validateTeamFile(teamYaml({ entity: 'floor' }), { home, root });
    if (!team.ok) throw new Error('fixture did not validate');
    const recorded = join(home, '.config', 'team', 'lobbies', 'floor');
    // The launch the registry sees: the file's session is acme, the run addresses alt.
    expect('id' in registerLaunch({ home, team: team.team, root, by: 'owner', session: 'alt' }, team.team.seats[0]!, 'w1:p1')).toBe(true);
    const id = teamIdOf(root);
    expect(getTeam(home, id)?.session).toBe('alt');
    expect(getTeam(home, id)?.lobbies).toEqual({ alt: recorded, acme: recorded });

    // The file renames its entity. Under the file's own session — what `team check` reads — the
    // recorded lobby stands, and it stands under alt too: a rename moves no running fleet.
    const renamed = validateTeamFile(teamYaml({ entity: 'renew' }), { home, root });
    if (!renamed.ok) throw new Error('fixture did not validate');
    expect(lobbyOf(home, root, renamed.team)).toBe(recorded);
    expect(lobbyOf(home, root, { ...renamed.team, session: 'alt' })).toBe(recorded);
    // The next launch under alt records the same lobby again, not the renamed entity's.
    expect('id' in registerLaunch({ home, team: renamed.team, root, by: 'owner', session: 'alt' }, renamed.team.seats[0]!, 'w1:p1')).toBe(true);
    expect(getTeam(home, id)?.lobbies).toEqual({ alt: recorded, acme: recorded });
    expect(existsSync(join(home, '.config', 'team', 'lobbies', 'renew'))).toBe(false);
  });

  test('an explicit lobby is the owner\'s declaration: it wins, and the note records it', () => {
    const declared = join(base, 'own-lobby');
    noteTeam(home, root, seed('Acme'), 'defined', 'owner');
    noteTeam(home, root, { ...seed('Acme'), lobby: declared }, 'running', 'owner');
    expect(getTeam(home, teamIdOf(root))?.lobby).toBe(declared);
    expect(lobbyOf(home, root, { ...asFile('Acme'), lobby: declared })).toBe(declared);
  });
});
