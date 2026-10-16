import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTeam, type FoundTeam } from '../../src/list/find.ts';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
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
trust:
  - /srv/lobby
`;

function teamYaml(project: string, session: string | null = project): string {
  const text = TEAM.replaceAll('acme', project);
  if (session === null) return text.replace(`session: ${project}\n`, '');
  if (session === project) return text;
  return text.replace(`session: ${project}`, `session: ${session}`);
}

/** The file with an `entity` line, for the default session's other half. */
function withEntity(text: string, project: string, entity: string): string {
  return text.replace(`project: ${project}\n`, `project: ${project}\nentity: ${entity}\n`);
}

function writeTeam(dir: string, text: string): void {
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'team.yaml'), text);
}

function sessionAt(base: string, name: string, workspaces: unknown): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ workspaces }));
  return dir;
}

function bury(root: string, levels: number): string {
  const deep = join(root, ...Array.from({ length: levels }, () => 'd'));
  mkdirSync(deep, { recursive: true });
  return deep;
}

function writeStore(home: string, folder: string, approval: string): string {
  const store = join(home, '.config', 'team', folder);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'approval.json'), approval);
  return store;
}

function withFixture(run: (base: string) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-list-find-')));
  try {
    run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function found(project: string, root: string): FoundTeam {
  return { project, root, seats: 1, unreadable: false };
}

test('an omitted session is the project name when the file names no entity, and an empty session names it without validating', () => {
  withFixture((base) => {
    const omitted = join(base, 'omitted');
    writeTeam(omitted, teamYaml('acme', null));
    const empty = join(base, 'empty-session');
    writeTeam(empty, teamYaml('acme').replace('session: acme', 'session: ""'));
    expect(findTeam('acme', sessionAt(base, 'omitted-reg', [{ identity_cwd: omitted }]), base)).toEqual(found('acme', omitted));
    expect(findTeam('acme', sessionAt(base, 'empty-reg', [{ identity_cwd: empty }]), base)).toEqual({
      project: 'acme',
      root: empty,
      seats: null,
      unreadable: true,
    });

    // Forty levels so a session the file does not name ends inside the fixture.
    const hole = join(base, 'hole');
    mkdirSync(hole);
    const deep = bury(hole, 40);
    writeTeam(deep, teamYaml('acme'));
    expect(findTeam('other', sessionAt(base, 'other-reg', [{ identity_cwd: deep }]), base)).toBeNull();
  });
});

test('an omitted session with an entity is the entity and the project name joined, and the bare project name steps past', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    writeTeam(proj, withEntity(teamYaml('acme', null), 'acme', 'floor'));
    const reg = sessionAt(base, 'reg', [{ identity_cwd: proj }]);
    expect(findTeam('floor-acme', reg, base)).toEqual(found('acme', proj));
    expect(findTeam('acme', reg, base)).toBeNull();
  });
});

test('a renamed project moves the default session with it: the new name claims the file, the old one steps past', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    writeTeam(proj, withEntity(teamYaml('acme', null), 'acme', 'floor'));
    const before = sessionAt(base, 'before', [{ identity_cwd: proj }]);
    expect(findTeam('floor-acme', before, base)).toEqual(found('acme', proj));

    writeTeam(proj, withEntity(teamYaml('renamed', null), 'renamed', 'floor'));
    const after = sessionAt(base, 'after', [{ identity_cwd: proj }]);
    expect(findTeam('floor-renamed', after, base)).toEqual(found('renamed', proj));
    expect(findTeam('floor-acme', after, base)).toBeNull();
  });
});

test('a team file that names another session is stepped past', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    const child = join(proj, 'child');
    writeTeam(proj, teamYaml('acme'));
    writeTeam(child, teamYaml('other'));
    const reg = sessionAt(base, 'reg', [{ identity_cwd: child }]);
    expect(findTeam('acme', reg, base)).toEqual(found('acme', proj));
    expect(findTeam('other', reg, base)).toEqual(found('other', child));
  });
});

test('a later workspace is used when the earlier one has no team file within the walk', () => {
  withFixture((base) => {
    const hole = join(base, 'hole');
    mkdirSync(hole);
    const deep = bury(hole, 40);
    const proj = join(base, 'proj');
    writeTeam(proj, teamYaml('acme'));
    const reg = sessionAt(base, 'reg', [{ identity_cwd: deep }, { identity_cwd: proj }]);
    expect(findTeam('acme', reg, base)).toEqual(found('acme', proj));
  });
});

test('unusable registry entries are skipped, and a registry that cannot be read finds nothing', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    writeTeam(proj, teamYaml('acme'));
    const messy = sessionAt(base, 'messy', [
      null,
      'skip-me',
      { identity_cwd: '' },
      { identity_cwd: 4 },
      { nope: true },
      { identity_cwd: proj },
    ]);
    expect(findTeam('acme', messy, base)).toEqual(found('acme', proj));

    const broken = join(base, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'session.json'), '{');
    const notArray = sessionAt(base, 'not-array', 'nope');
    const empty = sessionAt(base, 'empty', []);
    expect(findTeam('acme', broken, base)).toBeNull();
    expect(findTeam('acme', notArray, base)).toBeNull();
    expect(findTeam('acme', empty, base)).toBeNull();
  });
});

test('a symlinked project directory resolves to the real directory', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    writeTeam(proj, teamYaml('acme'));
    const link = join(base, 'link');
    symlinkSync(proj, link);
    const viaReal = findTeam('acme', sessionAt(base, 'real', [{ identity_cwd: proj }]), base);
    const viaLink = findTeam('acme', sessionAt(base, 'via', [{ identity_cwd: link }]), base);
    expect(viaReal).toEqual(found('acme', proj));
    expect(viaLink).toEqual(found('acme', proj));
  });
});

test('the registry directory wins over a store that names the same session', () => {
  withFixture((base) => {
    const live = join(base, 'live');
    const stored = join(base, 'stored');
    writeTeam(live, teamYaml('from-cwd', 'acme'));
    writeTeam(stored, teamYaml('from-store', 'acme'));
    writeStore(base, 'acme-0123456789ab', JSON.stringify({ root: stored }));
    const reg = sessionAt(base, 'reg', [{ identity_cwd: live }]);
    expect(findTeam('acme', reg, base)).toEqual(found('from-cwd', live));
  });
});

test('only a regular live file supplies a session, despite any stored copy', () => {
  withFixture((base) => {
    const fallbackRoot = join(base, 'fallback');
    mkdirSync(fallbackRoot);
    const fallback = writeStore(base, 'fallback-000000000001', JSON.stringify({ root: fallbackRoot }));
    writeFileSync(join(fallback, 'approved.yaml'), teamYaml('from-approved', 'kept'));
    expect(findTeam('kept', null, base)).toBeNull();

    const liveRoot = join(base, 'live');
    writeTeam(liveRoot, teamYaml('from-live', 'shown'));
    const live = writeStore(base, 'live-000000000002', JSON.stringify({ root: liveRoot }));
    writeFileSync(join(live, 'approved.yaml'), teamYaml('from-approved', 'shown'));
    expect(findTeam('shown', null, base)).toEqual(found('from-live', liveRoot));

    const linkedRoot = join(base, 'linked');
    mkdirSync(join(linkedRoot, '.agents'), { recursive: true });
    const target = join(base, 'target.yaml');
    writeFileSync(target, teamYaml('from-link', 'linked'));
    symlinkSync(target, join(linkedRoot, '.agents', 'team.yaml'));
    const linked = writeStore(base, 'linked-000000000003', JSON.stringify({ root: linkedRoot }));
    writeFileSync(join(linked, 'approved.yaml'), teamYaml('from-approved', 'linked'));
    expect(findTeam('linked', null, base)).toBeNull();

    const otherRoot = join(base, 'other');
    writeTeam(otherRoot, teamYaml('someone-else', 'someone'));
    const other = writeStore(base, 'other-000000000004', JSON.stringify({ root: otherRoot }));
    writeFileSync(join(other, 'approved.yaml'), teamYaml('from-approved', 'wanted'));
    expect(findTeam('wanted', null, base)).toBeNull();
    expect(findTeam('someone', null, base)).toEqual(found('someone-else', otherRoot));

    const linkOnly = join(base, 'link-only');
    mkdirSync(linkOnly);
    const linkStore = writeStore(base, 'zz-000000000005', JSON.stringify({ root: linkOnly }));
    const realApproved = join(base, 'real-approved.yaml');
    writeFileSync(realApproved, teamYaml('from-link', 'linked-approved'));
    symlinkSync(realApproved, join(linkStore, 'approved.yaml'));
    expect(findTeam('linked-approved', null, base)).toBeNull();
  });
});

test('stores are tried in name order, and a folder that is not a store is ignored', () => {
  withFixture((base) => {
    const decoy = join(base, 'decoy');
    const bad = join(base, 'bad');
    const empty = join(base, 'empty');
    const good = join(base, 'good');
    const later = join(base, 'later');
    writeTeam(decoy, teamYaml('from-decoy', 'acme'));
    writeTeam(good, teamYaml('from-good', 'acme'));
    writeTeam(later, teamYaml('from-later', 'acme'));
    mkdirSync(bad);
    mkdirSync(empty);
    writeStore(base, 'a-0123456789a', JSON.stringify({ root: decoy }));
    writeStore(base, 'badjson-000000000001', '{');
    writeStore(base, 'emptyroot-000000000002', JSON.stringify({ root: '' }));
    writeStore(base, 'good-000000000003', JSON.stringify({ root: good }));
    writeStore(base, 'later-000000000004', JSON.stringify({ root: later }));
    expect(findTeam('acme', null, base)).toEqual(found('from-good', good));
  });
});

test('an uppercase store suffix is not a store', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    writeTeam(proj, teamYaml('acme'));
    writeStore(base, 'acme-0123456789AB', JSON.stringify({ root: proj }));
    expect(findTeam('acme', null, base)).toBeNull();
  });
});

test('a stores path that is a file finds nothing', () => {
  withFixture((base) => {
    mkdirSync(join(base, '.config'));
    writeFileSync(join(base, '.config', 'team'), 'not a folder\n');
    expect(findTeam('acme', null, base)).toBeNull();
  });
});

test('a file that does not parse, or whose project is not a string, is not that session', () => {
  withFixture((base) => {
    const cases = ['', 'project: 1\nsession: acme\n', 'project:\n  name: acme\nsession: acme\n'];
    for (const [index, text] of cases.entries()) {
      const hole = join(base, `hole-${index}`);
      mkdirSync(hole);
      const deep = bury(hole, 40);
      writeTeam(deep, text);
      expect(findTeam('acme', sessionAt(base, `reg-${index}`, [{ identity_cwd: deep }]), base)).toBeNull();
    }
  });
});

test('the walk checks forty directories and stops', () => {
  withFixture((base) => {
    const miss = join(base, 'miss');
    const hit = join(base, 'hit');
    mkdirSync(miss);
    mkdirSync(hit);
    writeTeam(miss, teamYaml('acme'));
    writeTeam(hit, teamYaml('acme'));
    const tooDeep = sessionAt(base, 'too-deep', [{ identity_cwd: bury(miss, 40) }]);
    const deepEnough = sessionAt(base, 'deep-enough', [{ identity_cwd: bury(hit, 39) }]);
    expect(findTeam('acme', tooDeep, base)).toBeNull();
    expect(findTeam('acme', deepEnough, base)).toEqual(found('acme', hit));
  });
});

test('a linked .agents directory is not opened', () => {
  withFixture((base) => {
    const hole = join(base, 'hole');
    mkdirSync(hole);
    const deep = bury(hole, 40);
    const real = join(base, 'real-agents');
    mkdirSync(real);
    writeFileSync(join(real, 'team.yaml'), teamYaml('acme'));
    symlinkSync(real, join(deep, '.agents'));
    expect(findTeam('acme', sessionAt(base, 'reg', [{ identity_cwd: deep }]), base)).toBeNull();

    const fileHole = join(base, 'file-hole');
    mkdirSync(fileHole);
    const fileDeep = bury(fileHole, 40);
    writeFileSync(join(fileDeep, '.agents'), 'not a directory\n');
    expect(findTeam('acme', sessionAt(base, 'file-reg', [{ identity_cwd: fileDeep }]), base)).toBeNull();
  });
});
