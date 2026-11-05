import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runRename } from '../src/commands/rename.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { writeSendGrant } from '../src/send/grants.ts';
import { emptySession, updateState } from '../src/state.ts';
import { keyFolder } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TEAM = `format: 1
project: team-a
entity: entity-a
session: session-a
operator: seat-a
trust: []
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: seat-a
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-preflight-')));
  bases.push(base);
  const root = join(base, 'root-a');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv() });
  writeFileSync(join(dir, 'team.yaml'), TEAM);
  const parsed = validateTeamFile(TEAM, { home, root });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const store = storePath(parsed.team.project, root, home);
  writeApproval(store, { approval: approvalOf(parsed.team, root, NOW), file: TEAM }, [], home);
  updateState(dir, (state) => {
    state.sessions[parsed.team.session] = {
      ...emptySession(),
      seats: { 'seat-a': { stage: 'ready', pane: 'pane-lead', workspace: 'workspace-a' } },
    };
  });
  registerLaunch({ home, team: parsed.team, root, by: 'owner', owner: true }, parsed.team.seats[0]!, 'pane-lead');
  const lobby = join(home, '.config', 'team', 'lobbies', 'team-a');
  mkdirSync(lobby, { recursive: true });
  writeFileSync(join(lobby, 'pending.txt'), 'pending work\n');
  upsertTeam(home, teamIdOf(root), { lobby, lobbies: { 'session-a': lobby } });
  expect(approvalStanding(root, home).kind).toBe('verified');
  return { base, root, home, store, lobby };
}

// Hash content rather than printing fixture key material on a failed assertion. Metadata and
// directories catch rewrites of equal bytes, new logs, and create/remove attempts as well.
function snapshot(base: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  function visit(path: string) {
    const stat = lstatSync(path);
    const metadata = { mode: stat.mode, inode: stat.ino, modified: stat.mtimeMs, changed: stat.ctimeMs };
    const name = relative(base, path) || '.';
    if (stat.isSymbolicLink()) entries[name] = { ...metadata, link: readlinkSync(path) };
    else if (stat.isDirectory()) {
      entries[name] = { ...metadata, directory: true };
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else entries[name] = { ...metadata, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }
  visit(base);
  return entries;
}

type Fixture = ReturnType<typeof fixture>;

async function refusedWithoutWrites(fx: Fixture, reason: string) {
  const before = snapshot(fx.base);
  const dry = testIo(fx.root, { kind: 'owner' });
  const dryCode = await runRename(['--team', 'team-next', '--dry-run'], dry, { home: fx.home, now: () => NOW });
  const afterDry = snapshot(fx.base);
  const live = testIo(fx.root, { kind: 'owner' });
  const liveCode = await runRename(['--team', 'team-next'], live, { home: fx.home, now: () => NOW });
  const afterLive = snapshot(fx.base);
  // Both use the existing rename.refused exit-code marker (exit 1).
  expect({ dry: dryCode, live: liveCode }).toEqual({ dry: 1, live: 1 });
  expect(dry.err).toContain(reason);
  expect(live.err).toBe(dry.err);
  expect(dry.out).toBe('');
  expect(live.out).toBe('');
  expect(afterDry).toEqual(before);
  expect(afterLive).toEqual(before);
}

describe('team rename preflight parity', () => {
  test('grant re-sign without the owner key is rename.refused in both modes, with no writes', async () => {
    const fx = fixture();
    const written = writeSendGrant(fx.home, {
      name: 'grant-a', from: 'seat-a@team-a', to: 'seat-b@team-b', expires: '2026-11-06T12:00:00.000Z',
    }, { now: NOW });
    if (!written.ok) throw new Error(written.why);
    renameSync(join(keyFolder(fx.home), 'key.json'), join(fx.base, 'saved-key.json'));
    await refusedWithoutWrites(fx, 'owner signing key');
  });

  test('a foreign lobby is rename.refused in both modes, with no writes', async () => {
    const fx = fixture();
    const otherRoot = join(fx.base, 'root-b');
    mkdirSync(otherRoot);
    upsertTeam(fx.home, teamIdOf(otherRoot), {
      project: 'team-b', entity: 'entity-a', root: otherRoot, session: 'session-b',
      lobby: fx.lobby, lobbies: { 'session-b': fx.lobby },
    });
    await refusedWithoutWrites(fx, 'lobby is used by another team');
  });

  test('an unverified approval is rename.refused in both modes, with no writes', async () => {
    const fx = fixture();
    const approvalPath = join(fx.store, 'approval.json');
    const record = JSON.parse(readFileSync(approvalPath, 'utf8'));
    record.signature = '0'.repeat(128);
    writeFileSync(approvalPath, JSON.stringify(record));
    await refusedWithoutWrites(fx, 'approval must be verified');
  });

  test('a missing state folder is rename.refused in both modes, with no writes', async () => {
    const fx = fixture();
    renameSync(fx.store, join(fx.base, 'saved-store'));
    await refusedWithoutWrites(fx, 'state folder');
  });

  test('a valid lead dry run in development mode writes no audit log or other file', async () => {
    const fx = fixture();
    const before = snapshot(fx.base);
    const io = testIo(fx.root, { kind: 'seat', name: 'seat-a', pane: 'pane-lead', session: 'session-a' });
    io.env.TEAMCLI_DEV_MODE = '1';
    expect(await runRename(['--team', 'team-next', '--dry-run'], io, { home: fx.home, now: () => NOW }), io.err).toBe(0);
    expect(io.out).toContain('team-a -> team-next (dry run)');
    expect(snapshot(fx.base)).toEqual(before);
  });
});
