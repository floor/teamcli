// Independent door scenes for `team launchers migrate`, new in install 2 (1341B/map). The
// command is runLaunchers in src/commands/launchers.ts; the grant door is generalDoor in
// src/client/general-door.ts. Homes, panes, scripts, keys and grants are synthetic; no real
// launcher, credential, env value, CLI or pane is read.
//
// The door this file pins, measured at the base and unchanged by the bookkeeping fix:
// the owner, and a placed lead of this team, migrate; a plain seat, another team's lead, a
// lead off its recorded pane, a no-terminal owner, and every general-grant shape are refused.
// The map rows (src/permissions/map.ts) are `owner-or-leads` with a terminal route, and the
// resolver's record gives the orchestrator `leads` by name (src/permissions/who.ts,
// callerRecordOf), so the orchestrator holds the row whatever `leads.authority` says; the
// operator seat rides the release default (`own-team`), which `owner-asks` turns off.
//
// Two worlds, both under the fixture scratch root (a client key refuses to sit under the OS
// temp directory): the command world carries a script launch line and places every seat in
// one state write (an updateState that names the session again replaces it); the door world
// is lean — no registered seats, so the client-key placement check has no unresolved start
// folder to walk — because the scenes here judge the door's grant answer, not the command.
//
// Base note, recorded 2026-11-10 at 926697e32: the wildcard, delegated-child and bogus-path
// scenes are RED at the base — `launchers` is in neither GENERAL_OPS nor
// GENERAL_REFUSED_COMMANDS, and the door's wildcard covers a command the day it ships, so a
// wildcard grant (and a child of one) runs `team launchers` as the owner there, and a bogus
// grant path answers `cannot be read`, not the door's refusal. They go green when `launchers`
// joins the refused set (fix/launchers-command-bookkeeping, 06a03ce68). The refusal sentence
// differs between the base (`does not cover launchers`) and the launchers-specific door text
// that fix adds, so the grant scenes assert the refusal names launchers, not its wording.
// A grant naming `launchers` cannot be issued even at the base: the op vocabulary refuses it.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generalDoor } from '../src/client/general-door.ts';
import { issueHeldGeneralGrant, issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runLaunchers } from '../src/commands/launchers.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import type { Caller } from '../src/caller.ts';
import type { Io } from '../src/io.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-10T03:30:00Z');
const MARKER = '# synthetic\n';
const SESSION = 'acme';
const LEAD = 'lead-acme';
const OPERATOR = 'operator-acme';
const WORKER = 'worker-acme';
const FAR_LEAD = 'far-lead';
const WHY = 'only the owner, or a lead of this team, migrates its launchers';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: gitEnv() });
}

type CommandWorld = {
  home: string;
  root: string;
  teamFile: string;
  repoScript: string;
};

type DoorWorld = {
  home: string;
  root: string;
  keyA: string;
  keyB: string;
  publicKeyA: string;
  publicKeyB: string;
  wildcard: string;
};

function seat(role: string, name: string, launch: string): string {
  return `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: ${JSON.stringify(launch)}
    mode: shared
`;
}

function baseFolders(prefix: string): { base: string; home: string; root: string } {
  const base = fixtureBase(prefix);
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobbyDir(home), { mode: 0o700 });
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  git(root, 'init', '-q', '-b', 'main');
  return { base, home, root };
}

function agent(home: string, team: string, name: string, session: string, pane: string, launch: string): void {
  registerAgent(home, {
    name,
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch,
    reach: { team, seat: name, session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'the test',
  });
}

/** The command world: a script launch line to find, three placed seats, another team's lead. */
function open(): CommandWorld {
  const { home, root } = baseFolders('.launchers-door-');
  mkdirSync(join(root, 'tools'), { recursive: true });
  const declHome = join(home, '.config', 'team', 'launchers');
  mkdirSync(declHome, { recursive: true });
  writeFileSync(
    join(declHome, 'wrapper-repo.json'),
    `${JSON.stringify({ name: 'wrapper-repo', harness: 'claude-code', argv: ['claude', '--model', 'claude-opus-5-5'] }, null, 2)}\n`,
  );
  const repoScript = join(root, 'tools', 'wrapper-repo');
  writeFileSync(repoScript, MARKER);
  writeFileSync(
    join(home, '.config', 'team', 'launcher-migrations.json'),
    `${JSON.stringify({ format: 1, scripts: { [repoScript]: 'wrapper-repo' } }, null, 2)}\n`,
  );
  const teamFile = join(root, '.agents', 'team.yaml');
  const yaml = `format: 1
project: acme
session: ${SESSION}
coordinator: ${LEAD}
operator: ${OPERATOR}
workspace:
  mode: shared
trust:
  - ${root}
  - ${lobbyDir(home)}
seats:
${seat('coordinator', LEAD, 'claude --model claude-opus-5-5')}${seat('operator', OPERATOR, 'claude')}${seat('implementer', WORKER, repoScript)}`;
  writeFileSync(teamFile, yaml);
  const parsed = validateTeamFile(yaml, { root, home });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  const team = teamIdOf(root);
  upsertTeam(home, team, { project: 'acme', session: SESSION, root, at: NOW.toISOString() });
  upsertTeam(home, 'other-acme', { project: 'other', session: 'other', root: join(root, '..', 'other'), at: NOW.toISOString() });
  agent(home, team, LEAD, SESSION, 'pane-lead', 'claude --model claude-opus-5-5');
  agent(home, team, OPERATOR, SESSION, 'pane-operator', 'claude');
  agent(home, team, WORKER, SESSION, 'pane-worker', repoScript);
  agent(home, 'other-acme', FAR_LEAD, 'other', 'pane-far', 'claude');
  // One state write placing every seat: an updateState that names the session again replaces it.
  updateState(join(root, '.agents'), (state) => {
    state.sessions[SESSION] = {
      seats: {
        [LEAD]: { stage: 'ready' as const, pane: 'pane-lead' },
        [OPERATOR]: { stage: 'ready' as const, pane: 'pane-operator' },
        [WORKER]: { stage: 'ready' as const, pane: 'pane-worker' },
      },
    } as never;
  });
  return { home, root, teamFile, repoScript };
}

/** The lean door world: no registered seats, so the client-key placement check walks nothing. */
function openDoor(): DoorWorld {
  const { home, root } = baseFolders('.launchers-door-grant-');
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const teamFile = join(root, '.agents', 'team.yaml');
  const yaml = `format: 1
project: acme
entity: acme
session: ${SESSION}
coordinator: ${LEAD}
operator: ${LEAD}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  writeFileSync(teamFile, yaml);
  const parsed = validateTeamFile(yaml, { root, home });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  upsertTeam(home, teamIdOf(root), { project: 'acme', entity: 'acme', session: SESSION, root, roster: [], lifecycle: 'running', by: 'owner', at: NOW.toISOString() });
  const pairA = newClientKeyPair();
  const writtenA = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-a'), pairA);
  if (!writtenA.ok) throw new Error(writtenA.why);
  const pairB = newClientKeyPair();
  const writtenB = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-b'), pairB);
  if (!writtenB.ok) throw new Error(writtenB.why);
  const wildcard = issueOwnerGeneralGrant(
    home,
    { clientId: 'client-a', publicKey: pairA.publicKey, entities: ['*'], ops: ['*'], mayIssue: true, expires: new Date('2027-06-01T00:00:00Z') },
    new Date('2026-11-04T00:00:00Z'),
  );
  if (!wildcard.ok) throw new Error(wildcard.why);
  return {
    home,
    root,
    keyA: writtenA.keyPath,
    keyB: writtenB.keyPath,
    publicKeyA: pairA.publicKey,
    publicKeyB: pairB.publicKey,
    wildcard: wildcard.path,
  };
}

async function migrate(
  world: CommandWorld,
  caller: Caller,
  argv: string[] = ['migrate', '--dry-run'],
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(world.root, caller);
  const code = await runLaunchers(argv, io, world.home);
  return { code, out: io.out, err: io.err };
}

/** The door's io: a cwd inside the team and a HOME that is the synthetic home. */
function doorIo(world: DoorWorld): Io {
  const state = {
    out: '',
    err: '',
    stdout: (text: string) => {
      state.out += text;
    },
    stderr: (text: string) => {
      state.err += text;
    },
    cwd: world.root,
    env: { HOME: world.home },
    stdinIsTTY: false,
  };
  return state as unknown as Io;
}

function door(world: DoorWorld, rest: string[], grant: string, key: string): ReturnType<typeof generalDoor> {
  return generalDoor('launchers', [...rest, '--general', grant, '--key', key], doorIo(world));
}

test('the owner migrates: the dry run lists the line and writes nothing', async () => {
  const world = open();
  const before = `${readFileSync(world.teamFile, 'utf8')}|${readFileSync(world.repoScript, 'utf8')}`;
  const run = await migrate(world, { kind: 'owner' });
  expect(run.code).toBe(0);
  expect(`${run.out}${run.err}`).toContain('wrapper-repo');
  expect(`${readFileSync(world.teamFile, 'utf8')}|${readFileSync(world.repoScript, 'utf8')}`).toBe(before);
});

test('a placed lead of this team migrates under the release default (own-team)', async () => {
  const world = open();
  const run = await migrate(world, { kind: 'seat', name: LEAD, pane: 'pane-lead', session: SESSION });
  expect(run.code).toBe(0);
  expect(`${run.out}${run.err}`).toContain('wrapper-repo');
});

test('a placed operator seat migrates under the release default (the operator seat stays the lead)', async () => {
  const world = open();
  const run = await migrate(world, { kind: 'seat', name: OPERATOR, pane: 'pane-operator', session: SESSION });
  expect(run.code).toBe(0);
  expect(`${run.out}${run.err}`).toContain('wrapper-repo');
});

test('a plain seat of the team is refused with the door sentence', async () => {
  const world = open();
  const run = await migrate(world, { kind: 'seat', name: WORKER, pane: 'pane-worker', session: SESSION });
  expect(run.code).toBe(1);
  expect(run.err).toContain(WHY);
  expect(run.err).toContain(WORKER);
});

test('a lead of another team proves nothing here', async () => {
  const world = open();
  const run = await migrate(world, { kind: 'seat', name: FAR_LEAD, pane: 'pane-far', session: 'other' });
  expect(run.code).toBe(1);
  expect(run.err).toContain(WHY);
  expect(run.err).toContain(FAR_LEAD);
});

test('placement is the proof: the lead on a pane the state does not record is refused', async () => {
  const world = open();
  const run = await migrate(world, { kind: 'seat', name: LEAD, pane: 'pane-wander', session: SESSION });
  expect(run.code).toBe(1);
  expect(run.err).toContain(WHY);
});

test('owner-asks closes the lead door: the orchestrator and the operator are both refused, the owner still migrates', async () => {
  const world = open();
  const asked = writePolicySet(
    world.home,
    { level: 'team', target: world.root, teamRoot: world.root, name: 'leads.authority', value: 'owner-asks' },
    { now: NOW },
  );
  if (!asked.ok) throw new Error(asked.why);
  // Measured: the own-team admission the default rule gives every lead's seat is the only seat
  // route in, and owner-asks turns it off for the orchestrator and the operator alike — the
  // map row's "a lead of this team" rides the same policy-gated mechanism, not the roster name.
  const lead = await migrate(world, { kind: 'seat', name: LEAD, pane: 'pane-lead', session: SESSION });
  expect(lead.code).toBe(1);
  expect(lead.err).toContain(WHY);
  const operator = await migrate(world, { kind: 'seat', name: OPERATOR, pane: 'pane-operator', session: SESSION });
  expect(operator.code).toBe(1);
  expect(operator.err).toContain(WHY);
  const owner = await migrate(world, { kind: 'owner' });
  expect(owner.code).toBe(0);
  expect(`${owner.out}${owner.err}`).toContain('wrapper-repo');
});

test('the map row carries a terminal: a no-terminal owner is refused', async () => {
  const world = open();
  const run = await migrate(world, { kind: 'owner-no-tty' });
  expect(run.code).toBe(1);
  expect(run.err).toContain(WHY);
});

test('a wildcard general grant is refused for launchers migrate (RED at 926697e32: it is admitted as the owner there)', () => {
  const world = openDoor();
  const answer = door(world, ['migrate', '--dry-run'], world.wildcard, world.keyA);
  expect(answer.kind).toBe('refused');
  if (answer.kind === 'refused') expect(answer.why).toContain('launchers');
});

test('a wildcard general grant is refused for bare launchers too (RED at 926697e32)', () => {
  const world = openDoor();
  const answer = door(world, [], world.wildcard, world.keyA);
  expect(answer.kind).toBe('refused');
  if (answer.kind === 'refused') expect(answer.why).toContain('launchers');
});

test('a delegated child of a wildcard grant is refused as well (RED at 926697e32)', () => {
  const world = openDoor();
  const child = issueHeldGeneralGrant(world.home, world.wildcard, world.keyA, {
    clientId: 'client-b',
    publicKey: world.publicKeyB,
    entities: ['*'],
    ops: ['*'],
    mayIssue: false,
    expires: new Date('2027-05-01T00:00:00Z'),
  });
  expect(child.ok).toBe(true);
  if (child.ok) {
    const answer = door(world, ['migrate', '--dry-run'], child.path, world.keyB);
    expect(answer.kind).toBe('refused');
    if (answer.kind === 'refused') expect(answer.why).toContain('launchers');
  }
});

test('a general grant naming launchers cannot be issued at all: the op vocabulary refuses it', () => {
  const world = openDoor();
  const issued = issueOwnerGeneralGrant(
    world.home,
    { clientId: 'client-a', publicKey: world.publicKeyA, entities: ['*'], ops: ['launchers' as never], mayIssue: false, expires: new Date('2027-06-01T00:00:00Z') },
    new Date('2026-11-04T00:00:00Z'),
  );
  expect(issued.ok).toBe(false);
  if (!issued.ok) expect(issued.why).toContain('launchers');
});

test('a named general grant for other ops is refused for launchers (the refusal names launchers, whatever its wording)', () => {
  const world = openDoor();
  const issued = issueOwnerGeneralGrant(
    world.home,
    { clientId: 'client-a', publicKey: world.publicKeyA, entities: ['*'], ops: ['status', 'send'], mayIssue: true, expires: new Date('2027-06-01T00:00:00Z') },
    new Date('2026-11-04T00:00:00Z'),
  );
  if (!issued.ok) throw new Error(issued.why);
  const answer = door(world, ['migrate', '--dry-run'], issued.path, world.keyA);
  expect(answer.kind).toBe('refused');
  if (answer.kind === 'refused') expect(answer.why).toContain('launchers');
});

test('the refusal comes before any read: a grant path that does not exist still gets the door answer, not a read error (RED at 926697e32)', () => {
  const world = openDoor();
  const answer = door(world, ['migrate', '--dry-run'], join(world.home, 'no-such-grant.json'), world.keyA);
  expect(answer.kind).toBe('refused');
  if (answer.kind === 'refused') {
    expect(answer.why).toContain('launchers');
    expect(answer.why).not.toContain('cannot be read');
  }
});
