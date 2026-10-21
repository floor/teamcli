// The machine-scoped development mode. One signed record under
// the home governs both halves: the everyday caller gates of `resolveDevMode` and the
// owner-gate admission of `devModeState`. `local-fast` lifts exactly what the legacy variable
// lifted, `pr-per-change` and `off` lift nothing, and an absent record leaves the chain and the
// variable exactly as they were. The record that cannot be verified — tampered, rolled back,
// stale against its generation, or missing after a set — lifts nothing. The owner's switch is
// the terminal path or the existing out-of-band token, bound to the exact mode and prior
// generation; a replayed token finds the generation moved and is refused. Every fixture below
// is synthetic: temporary homes, temporary keys and fake herdr sources.
import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CallerSources, Process } from '../src/caller.ts';
import { runDevelopmentMode } from '../src/commands/development-mode.ts';
import { DEV_MODE_OPERATIONS, writePolicySet } from '../src/policy/index.ts';
import {
  devModeActive,
  devModeOwnerLift,
  devModeState,
  resolveDevMode,
  type DevModeCommand,
} from '../src/dev_mode.ts';
import {
  developmentModeFingerprint,
  developmentModeGeneration,
  developmentModeNote,
  developmentModePath,
  readDevelopmentMode,
  writeDevelopmentMode,
} from '../src/development_mode.ts';
import { ownerAuthorized } from '../src/approve/owner-token.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
let made: string[] = [];

afterEach(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
  made = [];
});

/** A synthetic home, with the owner key this machine would already hold. */
function homeDir(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-machine-mode-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  keyOf(home);
  return home;
}

/** The owner's switch, written the way the command writes it. */
function seed(home: string, mode: 'local-fast' | 'pr-per-change' | 'off'): void {
  const written = writeDevelopmentMode({ home, mode, now: NOW, caller: 'test' });
  if (!written.ok) throw new Error(written.why);
}

test('a machine with no record keeps today\'s behaviour: the chain, then the variable', () => {
  const home = homeDir();
  expect(readDevelopmentMode(home).kind).toBe('absent');
  expect(resolveDevMode('add', { env: {} }, { home })).toMatchObject({ on: false, governed: false });
  expect(resolveDevMode('add', { env: { TEAMCLI_DEV_MODE: '1' } }, { home })).toMatchObject({
    on: true,
    by: 'env',
    governed: false,
  });
  expect(devModeActive({ env: {} }, { home })).toBe(false);
});

test('local-fast lifts every operation of the one list, and only those, without the variable', () => {
  const home = homeDir();
  seed(home, 'local-fast');
  for (const operation of DEV_MODE_OPERATIONS) {
    expect(resolveDevMode(operation, { env: {} }, { home })).toMatchObject({
      on: true,
      by: 'machine',
      governed: true,
      ignored: false,
    });
  }
  expect(resolveDevMode('grant' as DevModeCommand, { env: {} }, { home }).on).toBe(false);
  // The owner-gate half is on too: the same state the cross-team admission reads.
  expect(devModeState({ env: {} }, { home }).on).toBe(true);
  expect(devModeActive({ env: {} }, { home })).toBe(true);
  // The variable set beside it changes nothing and is not reported as ignored.
  expect(resolveDevMode('add', { env: { TEAMCLI_DEV_MODE: '1' } }, { home })).toMatchObject({
    on: true,
    by: 'machine',
    ignored: false,
  });
});

test('pr-per-change keeps the process half and lifts no caller gate', () => {
  const home = homeDir();
  seed(home, 'pr-per-change');
  expect(resolveDevMode('add', { env: {} }, { home })).toMatchObject({ on: false, governed: true });
  expect(devModeState({ env: {} }, { home }).on).toBe(false);
  expect(devModeActive({ env: {} }, { home })).toBe(false);
  expect(resolveDevMode('add', { env: { TEAMCLI_DEV_MODE: '1' } }, { home })).toMatchObject({
    on: false,
    ignored: true,
  });
});

test('explicit off beats the variable and the per-team word, and local-fast beats a per-team off', () => {
  const home = homeDir();
  const root = join(dirname(home), 'team');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'team.yaml'),
    `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
trust:
  - ${root}
  - ${home}/.config/team/lobby
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
`,
  );
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(`the synthetic team file did not load: ${JSON.stringify(loaded.errors)}`);
  const chain = { home, team: loaded.team, root, now: NOW };

  const on = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW });
  if (!on.ok) throw new Error(on.why);
  seed(home, 'off');
  expect(resolveDevMode('add', { env: { TEAMCLI_DEV_MODE: '1' } }, chain)).toMatchObject({
    on: false,
    by: null,
    governed: true,
  });
  expect(devModeState({ env: { TEAMCLI_DEV_MODE: '1' } }, chain).on).toBe(false);

  const off = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'off' }, { now: NOW });
  if (!off.ok) throw new Error(off.why);
  seed(home, 'local-fast');
  expect(resolveDevMode('add', { env: {} }, chain)).toMatchObject({ on: true, by: 'machine' });
  expect(devModeState({ env: {} }, chain).on).toBe(true);
});

test('a tampered record is refused and lifts nothing, even with the variable set', () => {
  const home = homeDir();
  seed(home, 'local-fast');
  const path = developmentModePath(home);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  doc.mode = 'off';
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  const read = readDevelopmentMode(home);
  expect(read.kind).toBe('refused');
  expect(resolveDevMode('add', { env: { TEAMCLI_DEV_MODE: '1' } }, { home })).toMatchObject({
    on: false,
    ignored: true,
  });
  expect(devModeState({ env: { TEAMCLI_DEV_MODE: '1' } }, { home }).on).toBe(false);
  expect(devModeActive({ env: { TEAMCLI_DEV_MODE: '1' } }, { home })).toBe(false);
});

test('a rolled-back record is stale against its generation and lifts nothing', () => {
  const home = homeDir();
  seed(home, 'local-fast');
  const first = readFileSync(developmentModePath(home), 'utf8');
  seed(home, 'off');
  writeFileSync(developmentModePath(home), first);
  const read = readDevelopmentMode(home);
  expect(read.kind).toBe('refused');
  if (read.kind === 'refused') expect(read.why).toContain('stale');
  expect(resolveDevMode('add', { env: {} }, { home }).on).toBe(false);
});

test('a record removed after a set is refused, not read as an untouched machine', () => {
  const home = homeDir();
  seed(home, 'off');
  unlinkSync(developmentModePath(home));
  const read = readDevelopmentMode(home);
  expect(read.kind).toBe('refused');
  if (read.kind === 'refused') expect(read.why).toContain('missing');
  expect(resolveDevMode('add', { env: { TEAMCLI_DEV_MODE: '1' } }, { home }).on).toBe(false);
});

test('the fingerprint binds the exact mode and prior generation; a replay refuses', () => {
  const home = homeDir();
  const prior = developmentModeGeneration(home);
  const fast = developmentModeFingerprint(home, 'local-fast', prior);
  const off = developmentModeFingerprint(home, 'off', prior);
  expect(fast).not.toBe(off);
  expect(ownerAuthorized({ TEAM_OWNER_APPROVAL: fast }, fast)).toBe(true);
  expect(ownerAuthorized({ TEAM_OWNER_APPROVAL: 'not-the-fingerprint' }, fast)).toBe(false);
  expect(ownerAuthorized({}, fast)).toBe(false);

  const first = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'test', expectGeneration: prior });
  expect(first.ok).toBe(true);
  const replay = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'test', expectGeneration: prior });
  expect(replay.ok).toBe(false);
  if (!replay.ok) expect(replay.why).toContain('moved');
});

test('the command reads, shows and switches; the owner token is the non-terminal path', async () => {
  const home = homeDir();
  const owner = testIo(home, { kind: 'owner' });
  expect(await runDevelopmentMode(['set', 'local-fast'], owner, { home, now: NOW })).toBe(0);
  expect(owner.out).toContain(`dev mode: local-fast, since ${NOW.toISOString()}, set by the owner`);
  expect(developmentModeNote(readDevelopmentMode(home))).toBe(
    `dev mode: local-fast, since ${NOW.toISOString()}, set by the owner`,
  );

  const view = testIo(home);
  expect(await runDevelopmentMode([], view, { home })).toBe(0);
  expect(view.out).toContain(`dev mode: local-fast, since ${NOW.toISOString()}, set by the owner`);

  const refused = testIo(home);
  expect(await runDevelopmentMode(['set', 'off'], refused, { home })).toBe(1);
  expect(refused.err).toContain('only the owner switches the machine development mode');

  const showing = testIo(home);
  expect(await runDevelopmentMode(['set', 'off', '--show'], showing, { home })).toBe(0);
  const prior = developmentModeGeneration(home);
  const fingerprint = developmentModeFingerprint(home, 'off', prior);
  expect(showing.out).toContain(`Owner-authorization fingerprint: ${fingerprint}`);
  expect(readDevelopmentMode(home)).toMatchObject({ kind: 'set', record: { mode: 'local-fast' } });

  const token = testIo(home);
  token.env = { TEAM_OWNER_APPROVAL: fingerprint };
  expect(await runDevelopmentMode(['set', 'off'], token, { home, now: NOW })).toBe(0);
  expect(token.out).toContain('owner-token-authorized');
  expect(readDevelopmentMode(home)).toMatchObject({ kind: 'set', record: { mode: 'off' } });

  // The old token names the mode at the generation now spent; the switched record refuses it.
  const replay = testIo(home);
  replay.env = { TEAM_OWNER_APPROVAL: fingerprint };
  expect(await runDevelopmentMode(['set', 'off'], replay, { home })).toBe(1);
  expect(readDevelopmentMode(home)).toMatchObject({ kind: 'set', record: { mode: 'off' } });
});

const UNDER_HERDR: Process[] = [
  { pid: 501, name: 'zsh' },
  { pid: 500, name: 'herdr' },
];

/** The main folder holding a project checkout, its registry entries, and the panes each team's
 *  own state records. The main orchestrator stands on a pane only the main session lists. */
function place(): { floorRoot: string; targetRoot: string; home: string; target: ReturnType<typeof loadTeamFile> } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-machine-cross-')));
  made.push(base);
  const floorRoot = join(base, 'floor');
  const targetRoot = join(floorRoot, 'material');
  const home = join(base, 'home');
  for (const root of [floorRoot, targetRoot]) mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  keyOf(home);
  const file = (project: string, session: string, lead: string): string => `format: 1
project: ${project}
entity: floor
session: ${session}
coordinator: ${lead}
operator: ${lead}
trust:
  - __ROOT__
  - __LOBBY__
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${lead}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  const lobby = join(home, '.config', 'team', 'lobbies', 'floor');
  const written = (project: string, session: string, lead: string, root: string): string =>
    file(project, session, lead).replace('__ROOT__', root).replace('__LOBBY__', lobby);
  writeFileSync(join(floorRoot, '.agents', 'team.yaml'), written('floor', 'main', 'atlas', floorRoot));
  writeFileSync(join(targetRoot, '.agents', 'team.yaml'), written('material', 'material', 'mill', targetRoot));
  writeFileSync(
    join(floorRoot, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { main: { seats: { atlas: { stage: 'ready', pane: 'w5:p1' } }, worktrees: {} } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(targetRoot, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { material: { seats: { mill: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} } } }, null, 2)}\n`,
  );
  upsertTeam(home, teamIdOf(floorRoot), { project: 'floor', entity: 'floor', session: 'main', root: floorRoot, roster: [], by: 'test' });
  upsertTeam(home, teamIdOf(targetRoot), { project: 'material', entity: 'floor', session: 'material', root: targetRoot, roster: [], by: 'test' });
  return { floorRoot, targetRoot, home, target: loadTeamFile(targetRoot, { home }) };
}

test('the machine record governs the verified cross-team owner-gate lift: on admits, off denies', () => {
  const at = place();
  const target = at.target;
  if (!target.ok) throw new Error('the synthetic target team file did not load');
  const sources = (asked?: string): CallerSources => {
    const agents = asked === 'main' ? [{ name: 'atlas', pane: 'w5:p1' }] : [];
    return {
      ancestors: () => UNDER_HERDR,
      agents: () =>
        agents.map((agent) => ({
          name: agent.name,
          agent: 'claude',
          pane: agent.pane,
          workspace: 'w5',
          status: 'idle',
          cwd: null,
        })),
      paneRootPid: (pane: string) => (agents.some((agent) => agent.pane === pane) ? 501 : null),
      env: {},
      stdinIsTTY: false,
    };
  };
  const io = testIo(at.targetRoot);
  io.callerSources = sources;

  const lift = (): ReturnType<typeof devModeOwnerLift> =>
    devModeOwnerLift(io, {
      command: 'check',
      refusal: "--repair is the owner's",
      home: at.home,
      team: target.team,
      root: at.targetRoot,
      dir: join(at.targetRoot, '.agents'),
      now: NOW,
    });

  seed(at.home, 'local-fast');
  const on = lift();
  expect(on.lifted).toBe(true);
  expect(on.warning).toBe("warning: --repair is the owner's; dev mode continues (dev-mode on at machine level)");
  expect(readFileSync(join(at.targetRoot, '.agents', 'team.log'), 'utf8')).toContain('admitted as orchestrator');

  seed(at.home, 'off');
  expect(lift().lifted).toBe(false);
  seed(at.home, 'pr-per-change');
  expect(lift().lifted).toBe(false);
});
