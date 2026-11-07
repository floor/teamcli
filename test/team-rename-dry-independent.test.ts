// A dry team rename refuses every case the live rename refuses, and a dry
// run that is allowed writes nothing. A later live run of that same world
// must be allowed too.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { runRename } from '../src/commands/rename.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { writeSendGrant } from '../src/send/grants.ts';
import { emptySession, updateState } from '../src/state.ts';
import { keyFolder } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const PANE = 'fixture-pane-one';
const TEAM = `format: 1
project: home-team
entity: floor
session: home-session
operator: keeper
trust: []
workspace:
  mode: shared
seats:
  - role: coordinator
    name: keeper
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(): string {
  const base = fixtureBase('rename-dry-');
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

function world() {
  const base = scratch();
  const root = join(base, 'home-team');
  const home = join(base, 'h');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEAM, { mode: 0o600 });
  const parsed = validateTeamFile(TEAM, { home, root });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const store = storePath(parsed.team.project, root, home);
  writeApproval(store, { approval: approvalOf(parsed.team, root, NOW), file: TEAM }, [], home);
  updateState(dir, (state) => {
    state.sessions[parsed.team.session] = {
      ...emptySession(),
      seats: { keeper: { stage: 'ready', pane: PANE, workspace: 'floor' } },
    };
  });
  const launched = registerLaunch(
    { home, team: parsed.team, root, by: 'owner', owner: true },
    parsed.team.seats[0]!,
    PANE,
  );
  if ('note' in launched) throw new Error(launched.note);
  const lobby = join(home, '.config', 'team', 'lobbies', 'home-team');
  mkdirSync(lobby, { recursive: true });
  writeFileSync(join(lobby, 'pending.txt'), 'pending\n', { mode: 0o600 });
  upsertTeam(home, teamIdOf(root), { lobby, lobbies: { 'home-session': lobby } });
  if (approvalStanding(root, home).kind !== 'verified') throw new Error('the fixture approval is not verified');
  return { base, root, home, store, lobby };
}

type World = ReturnType<typeof world>;

function tree(base: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const name = relative(base, path) || '.';
    const meta = { mode: stat.mode, modified: stat.mtimeMs };
    if (stat.isSymbolicLink()) entries[name] = { ...meta, link: readlinkSync(path) };
    else if (stat.isDirectory()) {
      entries[name] = { ...meta, directory: true };
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else entries[name] = { ...meta, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  };
  visit(base);
  return entries;
}

async function bothRefuse(fx: World, reason: string): Promise<void> {
  const before = tree(fx.base);
  const dry = testIo(fx.root, { kind: 'owner' });
  const dryCode = await runRename(['--team', 'home-next', '--dry-run'], dry, { home: fx.home, now: () => NOW });
  const afterDry = tree(fx.base);
  const live = testIo(fx.root, { kind: 'owner' });
  const liveCode = await runRename(['--team', 'home-next'], live, { home: fx.home, now: () => NOW });
  expect(dryCode).toBe(1);
  expect(liveCode).toBe(1);
  expect(dry.err).toContain(reason);
  expect(live.err).toBe(dry.err);
  expect(dry.out).toBe('');
  expect(live.out).toBe('');
  expect(afterDry).toEqual(before);
  expect(tree(fx.base)).toEqual(before);
}

describe('team rename dry-run parity', () => {
  test('a missing signing key refuses both modes and writes nothing', async () => {
    const fx = world();
    const written = writeSendGrant(fx.home, {
      name: 'grant-a',
      from: 'keeper@home-team',
      to: 'keeper@home-next',
      expires: '2026-11-06T12:00:00.000Z',
    }, { now: NOW });
    if (!written.ok) throw new Error(written.why);
    renameSync(join(keyFolder(fx.home), 'key.json'), join(fx.base, 'saved-key.json'));
    await bothRefuse(fx, 'owner signing key');
  });

  test('a lobby another team claims refuses both modes and writes nothing', async () => {
    const fx = world();
    const other = join(fx.base, 'other-team');
    mkdirSync(other);
    upsertTeam(fx.home, teamIdOf(other), {
      project: 'other-team',
      entity: 'floor',
      root: other,
      session: 'other-session',
      lobby: fx.lobby,
      lobbies: { 'other-session': fx.lobby },
    });
    await bothRefuse(fx, 'lobby is used by another team');
  });

  test('an unverified approval refuses both modes and writes nothing', async () => {
    const fx = world();
    const approvalPath = join(fx.store, 'approval.json');
    const record = JSON.parse(readFileSync(approvalPath, 'utf8')) as { signature?: string };
    record.signature = '0'.repeat(128);
    writeFileSync(approvalPath, JSON.stringify(record), { mode: 0o600 });
    await bothRefuse(fx, 'approval must be verified');
  });

  test('a missing state folder refuses both modes and writes nothing', async () => {
    const fx = world();
    renameSync(fx.store, join(fx.base, 'saved-store'));
    await bothRefuse(fx, 'state folder');
  });

  test('a dry run that passes writes nothing, and the live run then passes', async () => {
    const fx = world();
    const before = tree(fx.base);
    const dry = testIo(fx.root, { kind: 'seat', name: 'keeper', pane: PANE, session: 'home-session' });
    dry.env.TEAMCLI_DEV_MODE = '1';
    const dryCode = await runRename(['--team', 'home-next', '--dry-run'], dry, { home: fx.home, now: () => NOW });
    expect(dryCode, dry.err).toBe(0);
    expect(dry.out).toContain('home-team -> home-next (dry run)');
    expect(tree(fx.base)).toEqual(before);
    const live = testIo(fx.root, { kind: 'seat', name: 'keeper', pane: PANE, session: 'home-session' });
    live.env.TEAMCLI_DEV_MODE = '1';
    const liveCode = await runRename(['--team', 'home-next'], live, { home: fx.home, now: () => NOW });
    expect(liveCode, live.err).toBe(0);
    expect(tree(fx.base)).not.toEqual(before);
  });
});
