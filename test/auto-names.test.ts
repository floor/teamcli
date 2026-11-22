// Seats are named automatically. A seat with no nickname takes the first free name of its
// entity's `names.pool` (a built-in pool, `greek-myth` by default, or the entity's own list) at
// `team add` and `team up` while `names.auto` is on, and `team names fill` names every such seat
// at once. The name is written as a manual one is: the record's `nickname:` and its label's
// persona, `<Nickname> · <role>`. A seat that has a name keeps it, and the `names.unique` scope
// holds handed-out names apart as it holds manual ones. Every scene is a synthetic registry under
// a scratch root: no live registry is read.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import { runNames } from '../src/commands/names.ts';
import { seatNickname, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { autoNamedText, autoNamePlan, claimNames, unnamedSeatNotes, withAutoNames, withNamingLock } from '../src/registry/names.ts';
import { generationPath } from '../src/store/keys.ts';
import { withApprovalLock } from '../src/store/store.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import { NAME_POOLS } from '../src/registry/name-pools.ts';
import { readStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { setTeamLifecycle, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { intoRegistry } from './helpers/registry-team.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEAT = (role: string, name: string, lines: string[] = []): string =>
  `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${lines.join('')}`;

const LEAD = SEAT('orchestrator', 'lead', ['    label: lead\n', '    leads: true\n']);
const NAMED = (role: string, name: string, persona: string): string =>
  SEAT(role, name, [`    nickname: ${persona}\n`, `    label: ${persona} · ${role}\n`]);

function teamText(project: string, entity: string, seats: string[]): string {
  return `format: 1\nproject: ${project}\nin_project: ${project}-web\nentity: ${entity}\noperator: lead\nworkspace:\n  mode: shared\nseats:\n${seats.join('')}`;
}

type World = { home: string; roots: Record<string, string>; store: FakeStore };

/** One machine: an entities file with the scene's `names:` words on `acme`, and each team moved
 *  into the home's registry with the roster `team up` records. */
function place(teams: Record<string, string>, names = ''): World {
  const base = fixtureBase('.auto-names-');
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), `acme:\n  roots:\n    - ${base}\n${names === '' ? '' : `  names:\n${names}`}globex:\n  roots:\n    - ${base}\n`);
  const roots: Record<string, string> = {};
  for (const [folder, text] of Object.entries(teams)) {
    const root = join(base, folder);
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    intoRegistry(root, home);
    const parsed = validateTeamFile(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    upsertTeam(home, teamIdOf(root), {
      project: parsed.team.project,
      session: parsed.team.session,
      root,
      entity: parsed.team.entity ?? null,
      roster: parsed.team.seats.map((seat, at) => ({ agent: `agt_${String(at + 1).padStart(12, '0')}`, seat: seat.name, role: seat.role })),
      at: NOW.toISOString(),
    });
    roots[folder] = root;
  }
  return { home, roots, store: seatOwner(home) };
}

function sourcesOf(world: World): ConfigSources {
  return { home: world.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: world.store };
}

function stored(world: World, folder: string): string {
  return readStoredTeamConfig(world.home, teamIdOf(world.roots[folder]!))?.text ?? '';
}

function planFor(world: World, folder: string, text = stored(world, folder)) {
  const parsed = validateTeamFile(text, { home: world.home, root: world.roots[folder]! });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return autoNamePlan({ home: world.home, root: world.roots[folder]!, team: parsed.team });
}

const POOL = NAME_POOLS['greek-myth']!;

/** One team's record with its unnamed seats named, and the parsed team before and after. */
function withAutoNamesFor(world: World, folder: string) {
  const text = stored(world, folder);
  const root = world.roots[folder]!;
  const before = validateTeamFile(text, { home: world.home, root });
  if (!before.ok) throw new Error(JSON.stringify(before.errors));
  const plan = autoNamePlan({ home: world.home, root, team: before.team });
  const named = withAutoNames(text, plan.assignments);
  const after = validateTeamFile(named, { home: world.home, root });
  if (!after.ok) throw new Error(JSON.stringify(after.errors));
  return { text: named, before: before.team, after: after.team };
}

describe('the greek-myth pool', () => {
  test('ships about 150 distinct names, each one a nickname can be', () => {
    expect(POOL.length).toBeGreaterThanOrEqual(150);
    expect(new Set(POOL.map((name) => name.toLowerCase())).size).toBe(POOL.length);
    for (const name of POOL) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });
});

describe('autoNamePlan', () => {
  test('names unnamed seats in file order, from the pool in order, keeping the label\'s role part', () => {
    const world = place({
      a: teamText('alpha', 'acme', [LEAD, SEAT('implementer', 'builder'), SEAT('tester', 'checker', ['    label: checker · qa\n'])]),
    });
    const plan = planFor(world, 'a');
    expect(plan.problem).toBeNull();
    expect(plan.assignments).toEqual([
      { seat: 'lead', nickname: POOL[0]!, label: `${POOL[0]!} · orchestrator` },
      { seat: 'builder', nickname: POOL[1]!, label: `${POOL[1]!} · implementer` },
      { seat: 'checker', nickname: POOL[2]!, label: `${POOL[2]!} · qa` },
    ]);
  });

  test('never renames a seat with a nickname or a label naming someone, and names no human or counted seat', () => {
    const world = place({
      a: teamText('alpha', 'acme', [
        NAMED('orchestrator', 'lead', 'Quill').replace('    nickname: Quill\n', '    nickname: Quill\n    leads: true\n'),
        SEAT('implementer', 'writer', ['    label: Jane Doe · implementer\n']),
        SEAT('implementer', 'person', ['    human: true\n']),
        SEAT('implementer', 'row', ['    count: 2\n']),
        SEAT('implementer', 'builder'),
      ]),
    });
    expect(planFor(world, 'a').assignments).toEqual([{ seat: 'builder', nickname: POOL[0]!, label: `${POOL[0]!} · implementer` }]);
  });

  test('a label with no middle dot is a description: the seat is named and the label kept after the dot', () => {
    const world = place({
      a: teamText('alpha', 'acme', [
        NAMED('orchestrator', 'lead', 'Quill').replace('    nickname: Quill\n', '    nickname: Quill\n    leads: true\n'),
        SEAT('tester', 'tester-gemini', ['    label: Gemini tester\n']),
        SEAT('tester', 'tester-grok', ['    label: Grok tester (via Cursor)\n']),
        SEAT('implementer', 'builder', ['    label: builder\n']),
      ]),
    });
    expect(planFor(world, 'a').assignments).toEqual([
      { seat: 'tester-gemini', nickname: POOL[0]!, label: `${POOL[0]!} · Gemini tester` },
      { seat: 'tester-grok', nickname: POOL[1]!, label: `${POOL[1]!} · Grok tester (via Cursor)` },
      { seat: 'builder', nickname: POOL[2]!, label: `${POOL[2]!} · implementer` },
    ]);
  });

  test('passes over a name another team carries, inside the entity and beyond it', () => {
    const world = place({
      a: teamText('alpha', 'acme', [LEAD, NAMED('implementer', 'worker', POOL[0]!)]),
      b: teamText('beta', 'globex', [LEAD, NAMED('implementer', 'worker', POOL[1]!)]),
      c: teamText('gamma', 'acme', [NAMED('orchestrator', 'lead', POOL[2]!).replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
    });
    expect(planFor(world, 'c').assignments).toEqual([{ seat: 'checker', nickname: POOL[3]!, label: `${POOL[3]!} · tester` }]);
  });

  test('an explicit list is read in its order; past it, the names.unique scope is the rule', () => {
    const teams = {
      a: teamText('alpha', 'acme', [NAMED('orchestrator', 'lead', 'Zed').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
      b: teamText('beta', 'globex', [NAMED('orchestrator', 'lead', 'Ada').replace('    label:', '    leads: true\n    label:')]),
    };
    // Zed is this team's own; Ada is another entity's, so it is taken only once the list has no
    // name nobody carries — and the default scope (the entity) allows it.
    const entity = place(teams, '    pool: [Zed, Ada]\n');
    expect(planFor(entity, 'a')).toEqual({ assignments: [{ seat: 'checker', nickname: 'Ada', label: 'Ada · tester' }], problem: null });
    const later = place(teams, '    pool: [Zed, Ada, Mae]\n');
    expect(planFor(later, 'a').assignments.map((one) => one.nickname)).toEqual(['Mae']);
  });

  test('a list with no free name in scope names the seat it stopped at, and an unknown pool word plans nothing', () => {
    const teams = {
      a: teamText('alpha', 'acme', [LEAD, NAMED('implementer', 'worker', 'Ada')]),
      c: teamText('gamma', 'acme', [NAMED('orchestrator', 'lead', 'Zed').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
    };
    const full = place(teams, '    pool: [Zed, Ada]\n');
    expect(planFor(full, 'c')).toEqual({ assignments: [], problem: 'the name pool has no free name left for seat "checker"' });
    // With names.unique: team, a name another team of the entity carries is allowed.
    const relaxed = place(teams, '    unique: team\n    pool: [Zed, Ada]\n');
    expect(planFor(relaxed, 'c').assignments.map((one) => one.nickname)).toEqual(['Ada']);
    const unknown = place(teams, '    pool: roman\n');
    expect(planFor(unknown, 'c').problem).toContain('names.pool "roman" is no built-in pool (greek-myth)');
    // A word an object inherits names no pool either: a warning, never a throw.
    for (const word of ['constructor', 'toString', '__proto__']) {
      const inherited = place(teams, `    pool: ${word}\n`);
      expect(planFor(inherited, 'c')).toEqual({ assignments: [], problem: expect.stringContaining(`names.pool "${word}" is no built-in pool`) });
      const text = stored(inherited, 'c');
      expect(autoNamedText({ home: inherited.home, root: inherited.roots.c!, text })).toEqual({ text, assignments: [], problem: expect.stringContaining('is no built-in pool') });
    }
  });
});

describe('the launch step and the doctor note', () => {
  const text = teamText('alpha', 'acme', [LEAD, SEAT('implementer', 'builder', ['    label: builder\n'])]);

  test('names the seat in the record text: nickname and label, read back as the seat\'s name', () => {
    const world = place({ a: text });
    const named = autoNamedText({ home: world.home, root: world.roots.a!, text, only: ['builder'] });
    expect(named.assignments).toEqual([{ seat: 'builder', nickname: POOL[0]!, label: `${POOL[0]!} · implementer` }]);
    expect(named.text).toContain(`    label: "${POOL[0]!} · implementer"\n`);
    expect(named.text).toContain(`    nickname: ${POOL[0]!}\n`);
    const parsed = validateTeamFile(named.text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const builder = parsed.team.seats.find((seat) => seat.name === 'builder')!;
    expect(seatNickname(parsed.team.seats, builder)).toBe(POOL[0]!);
    expect(workspaceLabel(builder)).toBe(`${POOL[0]!} · implementer`);
    expect(unnamedSeatNotes(parsed.team, world.home)).toEqual([]);
  });

  test('names.auto: off names nobody at a launch, and the doctor notes each unnamed seat', () => {
    const world = place({ a: text }, '    auto: off\n');
    expect(autoNamedText({ home: world.home, root: world.roots.a!, text })).toEqual({ text, assignments: [], problem: null });
    const parsed = validateTeamFile(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(unnamedSeatNotes(parsed.team, world.home)).toEqual([
      'seat "lead" has no name, and names.auto is off: team names fill names it, or team config set seats.lead.nickname <name>',
      'seat "builder" has no name, and names.auto is off: team names fill names it, or team config set seats.builder.nickname <name>',
    ]);
  });

  test('a team with no entity is named by no launch', () => {
    const world = place({ a: text });
    const bare = text.replace('entity: acme\n', '');
    expect(autoNamedText({ home: world.home, root: world.roots.a!, text: bare }).assignments).toEqual([]);
  });
});

describe('the naming lock', () => {
  test('a pick and its write run under the registry\'s teams lock, which another run waits on', () => {
    const world = place({ a: teamText('alpha', 'acme', [LEAD]) });
    const lock = join(world.home, '.config', 'team', 'teams.yaml.lock');
    expect(existsSync(lock)).toBe(false);
    const inside = withNamingLock(world.home, () => existsSync(lock));
    expect(inside).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('name claims', () => {
  test('a name claimed by a team the registry holds no row for yet is passed over by the next pick', () => {
    const world = place({ c: teamText('gamma', 'acme', [NAMED('orchestrator', 'lead', 'Quill').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]) });
    // A first run in another checkout: its record names a seat, and no registry row exists yet.
    const first = validateTeamFile(teamText('delta', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), NAMED('tester', 'checker', POOL[0]!)]));
    if (!first.ok) throw new Error(JSON.stringify(first.errors));
    const elsewhere = join(world.roots.c!, '..', 'delta');
    mkdirSync(join(elsewhere, '.agents'), { recursive: true });
    writeFileSync(join(elsewhere, '.agents', 'team.yaml'), teamText('delta', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), NAMED('tester', 'checker', POOL[0]!)]));
    claimNames({ home: world.home, root: elsewhere, before: null, after: first.team, now: new Date() });
    expect(planFor(world, 'c').assignments.map((one) => one.nickname)).toEqual([POOL[1]!]);
  });

  test('a claim older than a day no longer counts', () => {
    const world = place({ c: teamText('gamma', 'acme', [NAMED('orchestrator', 'lead', 'Quill').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]) });
    const first = validateTeamFile(teamText('delta', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), NAMED('tester', 'checker', POOL[0]!)]));
    if (!first.ok) throw new Error(JSON.stringify(first.errors));
    claimNames({ home: world.home, root: join(world.roots.c!, '..', 'delta'), before: null, after: first.team, now: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    expect(planFor(world, 'c').assignments.map((one) => one.nickname)).toEqual([POOL[0]!]);
  });

  test('a file-backed team whose stored copy lags holds its name through its team file, past any claim\'s expiry', () => {
    const world = place({
      a: teamText('alpha', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
      c: teamText('gamma', 'acme', [NAMED('orchestrator', 'lead', 'Quill').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
    });
    const root = world.roots.a!;
    const named = withAutoNamesFor(world, 'a');
    // The file-backed write, as production makes it: the team file only; the stored registry
    // copy keeps the old text.
    const wrote = writeTeamText(join(root, '.agents', 'team.yaml'), named.text, { home: world.home, env: { TEAM_CONFIG_SOURCE: 'file' } });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.errors));
    expect(stored(world, 'a')).not.toContain(`nickname: ${POOL[0]!}`);
    // A claim long expired: the name is still held, by the team file the union reads.
    claimNames({ home: world.home, root, before: named.before, after: named.after, now: new Date(Date.now() - 48 * 60 * 60 * 1000) });
    expect(planFor(world, 'c').assignments.map((one) => one.nickname)).toEqual([POOL[1]!]);
  });

  test('the ledger retires a claim once the view shows the name, or its team or seat is gone', () => {
    const world = place({
      a: teamText('alpha', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
    });
    const ledger = () => readFileSync(join(world.home, '.config', 'team', 'name-claims.json'), 'utf8');
    const lead = NAMED('orchestrator', 'lead', 'Quill').replace('    label:', '    leads: true\n    label:');
    // A first run elsewhere: no row, its team file declares the seat — the claim is in force.
    const elsewhere = join(world.roots.a!, '..', 'delta');
    mkdirSync(join(elsewhere, '.agents'), { recursive: true });
    const firstText = teamText('delta', 'acme', [lead, NAMED('tester', 'checker', 'Mae')]);
    writeFileSync(join(elsewhere, '.agents', 'team.yaml'), firstText);
    const first = validateTeamFile(firstText);
    if (!first.ok) throw new Error(JSON.stringify(first.errors));
    claimNames({ home: world.home, root: elsewhere, before: null, after: first.team, now: new Date() });
    withNamingLock(world.home, () => {});
    expect(ledger()).toContain('"nickname": "Mae"');
    // Its seat is dropped from every copy: the next naming lock retires the claim from the file.
    writeFileSync(join(elsewhere, '.agents', 'team.yaml'), teamText('delta', 'acme', [lead]));
    withNamingLock(world.home, () => {});
    expect(ledger()).not.toContain('"nickname": "Mae"');
    // A claim of a team whose row shows the name is retired as well.
    const named = withAutoNamesFor(world, 'a');
    writeTeamText(join(world.roots.a!, '.agents', 'team.yaml'), named.text, { home: world.home, env: { TEAM_CONFIG_SOURCE: 'file' } });
    claimNames({ home: world.home, root: world.roots.a!, before: named.before, after: named.after, now: new Date() });
    withNamingLock(world.home, () => {});
    expect(ledger()).not.toContain(`"nickname": "${POOL[0]!}"`);
  });

  test('a claim of an archived team no longer counts', () => {
    const world = place({
      a: teamText('alpha', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
      c: teamText('gamma', 'acme', [NAMED('orchestrator', 'lead', 'Quill').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
    });
    const a = validateTeamFile(stored(world, 'a'));
    if (!a.ok) throw new Error(JSON.stringify(a.errors));
    const after = { ...a.team, seats: a.team.seats.map((seat) => seat.name === 'checker' ? { ...seat, nickname: POOL[0]! } : seat) };
    claimNames({ home: world.home, root: world.roots.a!, before: a.team, after, now: new Date() });
    expect(planFor(world, 'c').assignments.map((one) => one.nickname)).toEqual([POOL[1]!]);
    setTeamLifecycle(world.home, teamIdOf(world.roots.a!), 'archived');
    expect(planFor(world, 'c').assignments.map((one) => one.nickname)).toEqual([POOL[0]!]);
  });
});

describe('the approval lock', () => {
  test('is keyed by the checkout root, as the generation is, whichever store a signing writes', () => {
    const world = place({ a: teamText('alpha', 'acme', [LEAD]) });
    const root = world.roots.a!;
    const folder = join(world.home, '.config', 'team', 'approval-locks', basename(generationPath(root, world.home), '.json'));
    expect(withApprovalLock(root, world.home, () => existsSync(join(folder, 'team.lock')))).toBe(true);
    // Another root is another lock.
    const other = join(root, '..', 'renamed');
    expect(withApprovalLock(other, world.home, () => existsSync(join(folder, 'team.lock')))).toBe(false);
    expect(existsSync(join(folder, 'team.lock'))).toBe(false);
  });
});

describe('team config edit under the naming lock', () => {
  test('a record that changed while the editor was open is not overwritten, and the draft is kept', async () => {
    const world = place({ a: teamText('alpha', 'acme', [LEAD, SEAT('implementer', 'builder')]) });
    const root = world.roots.a!;
    const other = stored(world, 'a').replace('    name: builder\n', '    name: builder\n    nickname: Wren\n');
    const io = testIo(root, { kind: 'owner' });
    const code = await runConfig(['edit'], io, {
      ...sourcesOf(world),
      editor: (draft) => {
        // Another writer lands first, then the draft is saved.
        const wrote = writeTeamText(join(root, '.agents', 'team.yaml'), other, { home: world.home, env: { TEAM_CONFIG_SOURCE: 'registry' } });
        if (!wrote.ok) throw new Error(JSON.stringify(wrote.errors));
        writeFileSync(draft, readFileSync(draft, 'utf8').replace('    name: builder\n', '    name: builder\n    effort: high\n'));
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('changed while this edit was open, and nothing was written; your edit is kept at ');
    expect(stored(world, 'a')).toBe(other);
  });
});

describe('team names fill', () => {
  test('--dry-run prints the plan and writes nothing; the real run writes it; a second run has nothing to do', async () => {
    const world = place({ a: teamText('alpha', 'acme', [LEAD, SEAT('implementer', 'builder')]) }, '    auto: off\n');
    const before = stored(world, 'a');
    const dry = testIo(world.roots.a!, { kind: 'owner' });
    expect(await runNames(['fill', '--dry-run'], dry, sourcesOf(world)), dry.err).toBe(0);
    expect(dry.out).toBe(`dry run: nothing was written\nalpha: lead → ${POOL[0]!}\nalpha: builder → ${POOL[1]!}\n`);
    expect(stored(world, 'a')).toBe(before);

    const real = testIo(world.roots.a!, { kind: 'owner' });
    expect(await runNames(['fill'], real, sourcesOf(world)), real.err).toBe(0);
    expect(real.out).toBe(`alpha: lead → ${POOL[0]!}\nalpha: builder → ${POOL[1]!}\n`);
    const after = stored(world, 'a');
    expect(after).toContain(`    nickname: ${POOL[1]!}\n`);
    expect(after).toContain(`    label: "${POOL[1]!} · implementer"\n`);
    expect(after).toContain(`    label: "${POOL[0]!} · orchestrator"\n`);

    const again = testIo(world.roots.a!, { kind: 'owner' });
    expect(await runNames(['fill', '--json'], again, sourcesOf(world)), again.err).toBe(0);
    const doc = JSON.parse(again.out) as { dry_run: boolean; teams: Array<{ team: string; written: boolean; assignments: unknown[]; problem: string | null }> };
    expect(doc.dry_run).toBe(false);
    expect(doc.teams).toEqual([{ team: 'alpha', written: false, assignments: [], problem: null }]);
  });

  test('--entity fills every team of the entity in turn, so no two take one name', async () => {
    const world = place({
      a: teamText('alpha', 'acme', [NAMED('orchestrator', 'lead', 'Quill').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
      b: teamText('beta', 'acme', [NAMED('orchestrator', 'lead', 'Wren').replace('    label:', '    leads: true\n    label:'), SEAT('tester', 'checker')]),
    });
    const io = testIo(world.roots.a!, { kind: 'owner' });
    expect(await runNames(['fill', '--entity', 'acme', '--dry-run'], io, sourcesOf(world)), io.err).toBe(0);
    expect(io.out).toBe(`dry run: nothing was written\nalpha: checker → ${POOL[0]!}\nbeta: checker → ${POOL[1]!}\n`);
    // A registered team whose folder is gone is said and skipped, never an error.
    rmSync(world.roots.b!, { recursive: true, force: true });
    const gone = testIo(world.roots.a!, { kind: 'owner' });
    expect(await runNames(['fill', '--entity', 'acme', '--dry-run'], gone, sourcesOf(world)), gone.err).toBe(0);
    expect(gone.out).toBe(`dry run: nothing was written\nalpha: checker → ${POOL[0]!}\nbeta: its record is gone; skipped\n`);
    const none = testIo(world.roots.a!, { kind: 'owner' });
    expect(await runNames(['fill', '--entity', 'nobody'], none, sourcesOf(world))).toBe(1);
    expect(none.err).toBe('team names: entity "nobody" has no registered team\n');
  });

  test('a caller who is not the owner is refused, and nothing is written', async () => {
    const world = place({ a: teamText('alpha', 'acme', [LEAD, SEAT('implementer', 'builder')]) });
    const before = stored(world, 'a');
    const io = testIo(world.roots.a!);
    expect(await runNames(['fill'], io, sourcesOf(world))).toBe(1);
    // The refusal is the owner door's: from a seat, or from a run with no terminal (as in CI).
    expect(io.err).toMatch(/^team names: alpha: only the owner (edits the team's record|runs this, from a terminal outside herdr)/);
    expect(stored(world, 'a')).toBe(before);
  });

  test('an unknown subcommand is a usage refusal', async () => {
    const io = testIo('/');
    expect(await runNames(['list'], io, {})).toBe(2);
    expect(io.err).toStartWith('team names: unknown subcommand "list"\nUsage: team names fill');
  });
});

describe('the entity words', () => {
  test('team config sets and reads names.auto and names.pool, and refuses a word it does not take', async () => {
    const world = place({ a: teamText('alpha', 'acme', [LEAD]) }, '    unique: entity\n');
    const sources = sourcesOf(world);
    const owner = () => testIo(world.roots.a!, { kind: 'owner' });
    const off = owner();
    expect(await runConfig(['set', 'acme.names.auto', 'off'], off, sources), off.err).toBe(0);
    expect(off.out).toContain('set acme.names.auto: off');
    const list = owner();
    expect(await runConfig(['set', 'acme.names.pool', '[Ada, Zed]'], list, sources), list.err).toBe(0);
    expect(list.out).toContain('set acme.names.pool: 2 names');
    const got = owner();
    expect(await runConfig(['get', 'acme.names.auto'], got, sources)).toBe(0);
    expect(got.out).toBe('off\n');
    const bad = owner();
    expect(await runConfig(['set', 'acme.names.auto', 'sometimes'], bad, sources)).toBe(1);
    expect(bad.err).toContain('"sometimes" is not a names.auto word: use on or off; nothing was written');
    const pool = owner();
    expect(await runConfig(['set', 'acme.names.pool', 'roman'], pool, sources)).toBe(1);
    expect(pool.err).toContain('"roman" is no built-in pool: use greek-myth, or a YAML list of names');
    const parsed = validateTeamFile(teamText('alpha', 'acme', [LEAD]));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const plan = autoNamePlan({ home: world.home, root: world.roots.a!, team: parsed.team });
    expect(plan.assignments.map((one) => one.nickname)).toEqual(['Ada']);
  });
});
