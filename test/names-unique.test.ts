// Seat nicknames are one name across an entity. The owner's `names.unique` word in the entity
// config (src/entities.ts) says how far apart those names stay: the whole entity (the default),
// a project of it, a team, or nowhere. A nickname is the persona a seat's written label names,
// compared case-insensitively, and the check runs only where a nickname is newly set — team
// config set (a seat's label or a whole seat map) and team init — so a team that
// already carries a duplicate keeps running; `team check` names the pair as a note instead.
// Every scene is a synthetic registry under a scratch root: homes, checkouts and registries are
// the scene's own, and no live registry is read.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import { writeArchive } from '../src/commands/archive.ts';
import { runInit } from '../src/commands/init.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, seatNickname, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import { nicknameChangeGate } from '../src/registry/names.ts';
import { readStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { intoRegistry } from './helpers/registry-team.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';
import { CLAUDE_IDLE, deliverBriefs, fixtureBase, gitEnv, notesOtherThanSocket, testIo } from './helpers.ts';

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

/** A seat whose written label names a person: the nickname `names.unique` holds apart. */
const NAMED = (role: string, name: string, persona: string): string =>
  SEAT(role, name, [`    nickname: ${persona}\n`, `    label: ${persona} · ${role}\n`]);

function teamText(input: { project: string; inProject: string; entity?: string; seats: string[] }): string {
  const head = [
    'format: 1',
    `project: ${input.project}`,
    `in_project: ${input.inProject}`,
    ...(input.entity !== undefined ? [`entity: ${input.entity}`] : []),
    'operator: lead',
    'workspace:',
    '  mode: shared',
    'seats:',
  ].join('\n');
  return `${head}\n${input.seats.join('')}`;
}

/** Three teams in one entity across two projects, and one in another entity. */
const ACA = teamText({ project: 'acme', inProject: 'acme-web', entity: 'floor', seats: [LEAD, NAMED('implementer', 'worker', 'Cicero')] });
const SITE = teamText({ project: 'site', inProject: 'acme-web', entity: 'floor', seats: [LEAD, NAMED('reviewer', 'reviewer', 'Joan')] });
const API = teamText({ project: 'api', inProject: 'acme-api', entity: 'floor', seats: [LEAD, NAMED('reviewer', 'reviewer', 'Damon')] });
const OTHER = teamText({ project: 'other', inProject: 'other-web', entity: 'material', seats: [LEAD, NAMED('implementer', 'worker', 'Cicero')] });

type World = { base: string; home: string; roots: Record<string, string>; store: FakeStore };

/** The owner's entities file, with or without a `names.unique` word on the `floor` entity. */
function entitiesText(base: string, unique?: string): string {
  const named = unique === undefined ? '' : `\n  names:\n    unique: ${unique}`;
  return `floor:\n  roots:\n    - ${base}${named}\nmaterial:\n  roots:\n    - ${base}\n`;
}

/** One machine: a home with its entities file, each team's checkout moved into that home's
 *  registry, and the owner seat the config door answers to. */
function place(teams: Record<string, string>, unique?: string): World {
  const base = fixtureBase('.names-unique-');
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), entitiesText(base, unique));
  const roots: Record<string, string> = {};
  for (const [folder, text] of Object.entries(teams)) {
    const root = join(base, folder);
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    intoRegistry(root, home);
    const parsed = validateTeamFile(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    // The record `team up` writes: the index the nickname scan and the check read, beside the
    // stored text intoRegistry leaves.
    upsertTeam(home, teamIdOf(root), {
      project: parsed.team.project,
      session: parsed.team.session,
      root,
      entity: parsed.team.entity ?? null,
      roster: parsed.team.seats.map((seat, at) => ({
        agent: `agt_${String(at + 1).padStart(12, '0')}`,
        seat: seat.name,
        role: seat.role,
      })),
      at: NOW.toISOString(),
    });
    roots[folder] = root;
  }
  return { base, home, roots, store: seatOwner(home) };
}

function sourcesOf(world: World): ConfigSources {
  return { home: world.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: world.store };
}

function stored(root: string, home: string): string {
  return readStoredTeamConfig(home, teamIdOf(root))?.text ?? '';
}

/** An owner's set through the owner seat: the request, the answer, the run. The gate this scene
 *  reads sits in the run — the request itself writes nothing. */
async function ownerSet(world: World, folder: string, path: string, value: string): Promise<{ code: number; out: string; err: string }> {
  const root = world.roots[folder]!;
  const sources = sourcesOf(world);
  const ask = testIo(root, { kind: 'owner' });
  const asked = await runConfig(['set', path, value, '--request'], ask, sources);
  if (asked !== 0) throw new Error(`the request was refused: ${ask.err}${ask.out}`);
  const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
  if (id === '') throw new Error(`no request id in: ${ask.out}${ask.err}`);
  const answered = approveOwnerAction(world.home, id, 'oui', world.store, NOW);
  if (!answered.ok) throw new Error(`the owner seat did not answer: ${answered.why}`);
  const ran = testIo(root, { kind: 'owner' });
  const code = await runConfig(['set', path, value, '--approval', id], ran, sources);
  return { code, out: ran.out, err: ran.err };
}

/** A placed team walked to the clean state a check reads: every seat ready on its own pane, a
 *  brief dropped and read, and a watch pass recent enough that the run itself is no difference —
 *  so the only note left is the one a scene is about. */
function settle(world: World, folder: string, text: string): string {
  const root = world.roots[folder]!;
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.team.seats.forEach((seat, index) => {
      session.seats[seat.name] = { stage: 'ready', pane: `pane${String(index + 1)}`, workspace: `pane${String(index + 1)}` };
    });
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: parsed.team.seats.map((seat) => seat.name),
    home: world.home,
    at: NOW.toISOString(),
  });
  return root;
}

describe('a nickname is one name across the entity', () => {
  test('a label naming another team’s seat is refused, the other team and seat named, with the word that allows it', async () => {
    const world = place({ acme: ACA, site: SITE, api: API, other: OTHER });
    const before = stored(world.roots.site!, world.home);
    // Case-insensitively: `cicero` is the name the acme team's worker holds.
    const ran = await ownerSet(world, 'site', 'seats.reviewer.label', 'cicero · reviewer');
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('team config: the nickname "Cicero" is already held by seat "worker" of team "acme"');
    expect(ran.err).toContain('seat nicknames are unique across entity "floor"');
    // The two teams sit in one project, so only a team-wide word would allow this pair.
    expect(ran.err).toContain('names.unique: team or off in the entity\'s names entry in entities.yaml would allow it');
    expect(stored(world.roots.site!, world.home)).toBe(before);
  });

  test('a name no team of the entity holds is written, the label and the nickname together', async () => {
    const world = place({ acme: ACA, site: SITE });
    const ran = await ownerSet(world, 'site', 'seats.reviewer.label', 'Marlowe · reviewer');
    expect(ran.code, ran.err).toBe(0);
    const text = stored(world.roots.site!, world.home);
    expect(text).toContain('label: "Marlowe · reviewer"');
    expect(text).toContain('nickname: Marlowe');
  });

  test('another project’s name is allowed under `project`, and the same project’s refused', async () => {
    const world = place({ acme: ACA, site: SITE, api: API, other: OTHER }, 'project');
    // Damon is the api team's, in acme-api: the site team may take it in acme-web.
    const across = await ownerSet(world, 'site', 'seats.reviewer.label', 'Damon · reviewer');
    expect(across.code, across.err).toBe(0);
    expect(stored(world.roots.site!, world.home)).toContain('nickname: Damon');
    // Cicero is the worker's in this same project, so the project word does not allow it.
    const within = await ownerSet(world, 'site', 'seats.reviewer.label', 'Cicero · reviewer');
    expect(within.code).toBe(1);
    expect(within.err).toContain('seat nicknames are unique within project "acme-web"');
    expect(within.err).toContain('names.unique: team or off');
  });

  test('another entity’s name is never this entity’s: the other entity holds Cicero and site writes it', async () => {
    const world = place({ acme: ACA, site: SITE, other: OTHER });
    const ran = await ownerSet(world, 'site', 'seats.reviewer.label', 'Cicero · reviewer');
    expect(ran.code, ran.err).toBe(1);
    // …and the material team's worker is not the one named: the refusal names this entity's.
    expect(ran.err).toContain('of team "acme"');
    expect(ran.err).not.toContain('of team "other"');
  });

  test('`team` and `off` write the name another team holds', async () => {
    for (const unique of ['team', 'off']) {
      const world = place({ acme: ACA, site: SITE }, unique);
      const ran = await ownerSet(world, 'site', 'seats.reviewer.label', 'Cicero · reviewer');
      expect(ran.code, `${unique}: ${ran.err}`).toBe(0);
      expect(stored(world.roots.site!, world.home)).toContain('nickname: Cicero');
    }
  });

  test('a word the file does not spell leaves the default in force', async () => {
    const world = place({ acme: ACA, site: SITE }, 'everywhere');
    const ran = await ownerSet(world, 'site', 'seats.reviewer.label', 'Cicero · reviewer');
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('seat nicknames are unique across entity "floor"');
  });

  test('a whole seat map set is held to the same rule, and nothing is written', async () => {
    const world = place({ acme: ACA, site: SITE });
    const before = stored(world.roots.site!, world.home);
    const map = '{role: reviewer, name: reviewer, cli: claude-code, vendor: anthropic, model: Claude Opus, version: "5.5", launch: claude --model claude-opus-5-5, nickname: Cicero, label: "Cicero · reviewer"}';
    const ran = await ownerSet(world, 'site', 'seats.reviewer', map);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('the nickname "Cicero" is already held by seat "worker" of team "acme"');
    expect(stored(world.roots.site!, world.home)).toBe(before);
  });
});

describe('the nickname a write brings, and the one a team already carries', () => {
  test('a label’s word is the seat’s name only when the nickname field could hold it', () => {
    const seatsOf = (text: string): Array<{ name: string; nickname?: string; label: string; labelWritten?: boolean }> => {
      const parsed = validateTeamFile(text);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      return parsed.team.seats;
    };
    const of = (text: string, name: string) => {
      const seats = seatsOf(text);
      const seat = seats.find((candidate) => candidate.name === name)!;
      return seatNickname(seats, seat);
    };
    // One answer for the roster line, the launch name and the header.
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    label: Cicero · implementer\n'])}`, 'worker-2')).toBe('Cicero');
    // A space or an accent is not a nickname; the field (here none) stands.
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    label: Jane Doe · implementer\n'])}`, 'worker-2')).toBeNull();
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    label: Inès · implementer\n'])}`, 'worker-2')).toBeNull();
    // A word another seat's field already carries is not taken from it.
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    label: Joan · implementer\n'])}`, 'worker-2')).toBeNull();
    // A word no seat of the file carries is the seat's name, whoever holds it elsewhere.
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    label: Damon · implementer\n'])}`, 'worker-2')).toBe('Damon');
    // The field stands behind a word it cannot hold, and a bare label is the seat's own name.
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    nickname: Cicero\n', '    label: Jane Doe · implementer\n'])}`, 'worker-2')).toBe('Cicero');
    expect(of(`${SITE.trimEnd()}\n${SEAT('implementer', 'worker-2', ['    label: worker-2\n'])}`, 'worker-2')).toBe('worker-2');
  });

  test('the gate reads a new seat against the registry and a name the team already carried is not re-checked', async () => {
    const world = place({ acme: ACA, site: SITE });
    const site = validateTeamFile(SITE);
    if (!site.ok) throw new Error(JSON.stringify(site.errors));
    const added = validateTeamFile(`${SITE.trimEnd()}\n${NAMED('reviewer', 'reviewer-2', 'Cicero')}`);
    if (!added.ok) throw new Error(JSON.stringify(added.errors));
    const root = world.roots.site!;
    // A new seat whose written label names a persona another team holds: refused.
    const clash = nicknameChangeGate({ home: world.home, teamId: teamIdOf(root), root, before: site.team, after: added.team });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.message).toContain('of team "acme"');
    // A new seat whose label is its own name: no nickname, no check.
    const plain = validateTeamFile(`${SITE.trimEnd()}\n${SEAT('reviewer', 'reviewer-2', ['    label: reviewer-2\n'])}`);
    if (!plain.ok) throw new Error(JSON.stringify(plain.errors));
    expect(nicknameChangeGate({ home: world.home, teamId: teamIdOf(root), root, before: site.team, after: plain.team })).toEqual({ ok: true });
  });

  test('team check names an existing duplicate as a note, exit unchanged', () => {
    // Both teams were imported carrying Cicero: the duplicate predates any check, and a running
    // team is never refused for it.
    const world = place({ acme: ACA, site: ACA.replace('project: acme', 'project: site') });
    const root = settle(world, 'acme', ACA);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      home: world.home,
      live: () => live(ACA),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, join(root, 'nowhere')),
      now: () => NOW,
    });
    const out = `${io.out}${io.err}`;
    expect(notesOtherThanSocket(out)).toContain(
      'note: seat "worker": its nickname "Cicero" is also held by seat "worker" of team "site" — seat nicknames are unique across entity "floor"; existing duplicates keep running, and only a nickname newly set is refused',
    );
    expect(out).not.toContain('difference:');
    expect(code).toBe(0);
  });

  test('the same teams under `team` draw no such note', () => {
    const world = place({ acme: ACA, site: ACA.replace('project: acme', 'project: site') }, 'team');
    const root = settle(world, 'acme', ACA);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      home: world.home,
      live: () => live(ACA),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, join(root, 'nowhere')),
      now: () => NOW,
    });
    expect(notesOtherThanSocket(`${io.out}${io.err}`)).toEqual([]);
    expect(code).toBe(0);
  });
});

describe('the other doors', () => {
  test('team init --from-archive refuses a persona another team holds, before anything is written', async () => {
    const world = place({ acme: ACA });
    const target = join(world.base, 'newteam');
    mkdirSync(target, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore', env: gitEnv() });
    const archived = teamText({ project: 'newteam', inProject: 'acme-web', entity: 'floor', seats: [LEAD, NAMED('implementer', 'worker', 'Cicero')] });
    const taken = join(world.base, 'archived');
    mkdirSync(join(taken, '.agents'), { recursive: true });
    writeFileSync(join(taken, '.agents', 'team.yaml'), archived);
    const written = writeArchive({
      file: join(taken, '.agents', 'team.yaml'),
      root: taken,
      project: 'newteam',
      session: 'newteam',
      home: world.home,
      out: join(world.home, '.config', 'team', 'archive'),
      caller: 'owner',
      now: NOW,
      dry: false,
    });
    if (!written.ok) throw new Error(written.reason);

    const io = testIo(target, { kind: 'owner' });
    const code = await runInit(['--from-archive', written.dir], io, world.home);
    expect(code).toBe(1);
    expect(io.err).toContain('team init: the nickname "Cicero" is already held by seat "worker" of team "acme"');
    expect(existsSync(join(target, '.agents', 'team.yaml'))).toBe(false);
  });

  test('a general grant is admitted and held to the same nickname rule', async () => {
    const world = place({ acme: ACA, site: SITE });
    const pair = newClientKeyPair();
    const keys = writeClientKeyFiles(join(world.home, '.config', 'team-client', 'iris'), pair);
    if (!keys.ok) throw new Error(keys.why);
    const grant = issueOwnerGeneralGrant(world.home, {
      clientId: 'iris',
      publicKey: pair.publicKey,
      entities: ['floor'],
      ops: ['config'],
      mayIssue: true,
      expires: new Date(NOW.getTime() + 86_400_000),
    });
    if (!grant.ok) throw new Error(grant.why);
    const root = world.roots.site!;
    const sources = sourcesOf(world);
    const run = async (persona: string) => {
      const io = testIo(root, { kind: 'seat', name: 'builder-9', pane: 'pane1' });
      const code = await runConfig(['set', 'seats.reviewer.label', `${persona} · reviewer`, '--general', grant.path, '--key', keys.keyPath], io, sources);
      return { code, out: io.out, err: io.err };
    };
    const refused = await run('Cicero');
    expect(refused.out + refused.err).toContain('admitted by general grant');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the nickname "Cicero" is already held by seat "worker" of team "acme"');
    const allowed = await run('Joan');
    expect(allowed.code, allowed.err).toBe(0);
    expect(stored(root, world.home)).toContain('nickname: Joan');
  });
});

/** The live session as the terminal host answers it for the file in force: each seat's pane
 *  idle and its sidebar line the file's own. */
function live(text: string): Live {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => ({
      name: seat.name,
      agent: 'claude',
      pane: `pane${String(index + 1)}`,
      workspace: `pane${String(index + 1)}`,
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `pane${String(index + 1)}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`pane${String(index + 1)}`, CLAUDE_IDLE])),
  };
}
