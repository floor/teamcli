// A leftover channel lock stays for a hand cleanup, a retired lock name is kept
// by retention, and a flock-less reclaim tries a live holder once.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readTeamConfig } from '../src/file/team-config.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER, withChannelCommit } from '../src/mcp/channel.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { retireDropsSliced } from '../src/send/drop-retention.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const EPOCH = 'run_0123456789ab';
const SESSION = 'synthetic-session';
const REFUSAL = 'a leftover channel lock is in the seat folder; remove .team-channel.lock by hand and launch again';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(prefix: string): string {
  const base = fixtureBase(prefix);
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

function channelWorld() {
  const base = scratch('channel-follow-');
  const home = join(base, 'home');
  const root = join(base, 'project');
  const lobby = join(home, 'lobby');
  const launch = `claude ${CHANNEL_FLAG} server:${CHANNEL_SERVER}`;
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(lobby, { mode: 0o700 });
  mkdirSync(join(root, '.agents'), { mode: 0o700, recursive: true });
  writeFileSync(join(root, '.agents/team.yaml'), `format: 1
project: synthetic-project
session: ${SESSION}
coordinator: alpha
operator: alpha
lobby: ${lobby}
trust:
  - ${root}
  - ${lobby}
workspace:
  mode: shared
seats:
  - name: alpha
    role: coordinator
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: ${launch}
`, { mode: 0o600 });
  upsertTeam(home, teamIdOf(root), {
    root,
    project: 'synthetic-project',
    session: SESSION,
    lobby,
    roster: [{ agent: 'agt_000000000001', seat: 'alpha', role: 'worker' }],
  });
  writeFileSync(join(root, '.agents/team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      [SESSION]: {
        seats: { alpha: { stage: 'launched', pane: 'fixture-pane-one' } },
        worktrees: {},
        briefs: {
          alpha: {
            id: '01234567-0000-4000-8000-000000000001',
            incarnation: 'inc_0123456789ab',
            epoch: EPOCH,
            at: '2026-01-01T00:00:00Z',
            sha256: 'a'.repeat(64),
            stage: 'ready',
          },
        },
      },
    },
  })}\n`, { mode: 0o600 });
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error('synthetic team fixture could not load');
  return { home, root, lobby };
}

describe('channel follow-ups', () => {
  test('a leftover channel lock is left in place and the refusal names the hand cleanup', () => {
    const world = channelWorld();
    const folder = join(world.lobby, 'alpha');
    const lock = join(folder, '.team-channel.lock');
    mkdirSync(folder, { mode: 0o700 });
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'marker'), 'left\n', { mode: 0o600 });
    const read = prepareChannelConfig({
      root: world.root,
      home: world.home,
      seat: 'alpha',
      session: SESSION,
      cwd: folder,
      epoch: EPOCH,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe(REFUSAL);
    expect(readFileSync(join(lock, 'marker'), 'utf8')).toBe('left\n');
  });

  test('retention keeps a retired dead-lock name and a retired reclaim-aside name', async () => {
    const base = scratch('channel-retain-');
    const home = join(base, 'home');
    const root = join(base, 'project');
    const seat = join(root, '.agents/send-drops/synthetic/alpha');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(seat, { mode: 0o700, recursive: true });
    const dead = join(seat, 'note.channel-commit.dead-4');
    const aside = join(seat, 'note.channel-commit.reclaim-aside-4-ab12');
    writeFileSync(dead, 'kept-dead\n', { mode: 0o600 });
    writeFileSync(aside, 'kept-aside\n', { mode: 0o600 });
    messageKeyOf(home);
    const report = await retireDropsSliced({
      root,
      home,
      at: new Date('2026-11-06T12:00:00.000Z'),
      olderThanMs: 1000,
      slices: { sliceMs: 2_000, stopping: () => false, yield: async () => true },
    });
    expect(report.refused).toContain('unexpected file');
    expect(report.archived).toHaveLength(0);
    expect(report.reclaimed).toHaveLength(0);
    expect(readFileSync(dead, 'utf8')).toBe('kept-dead\n');
    expect(readFileSync(aside, 'utf8')).toBe('kept-aside\n');
  });

  test('a flock-less reclaim tries a live holder once', () => {
    const base = scratch('channel-reclaim-');
    const dir = join(base, 'drops');
    mkdirSync(dir, { mode: 0o700 });
    const holder = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = holder.pid;
      if (pid === undefined) throw new Error('the live holder has no pid');
      const id = 'channel-commit-one';
      const lock = join(dir, `${id}.channel-commit.lock`);
      const body = `${pid}\n`;
      writeFileSync(lock, body, { mode: 0o600 });
      const started = Date.now();
      const result = withChannelCommit(dir, id, () => 'ran', { skipFlock: true, helperWaitMs: 50 });
      const elapsed = Date.now() - started;
      expect(result).toBe('busy');
      expect(readFileSync(lock, 'utf8')).toBe(body);
      expect(existsSync(lock)).toBe(true);
      // Fifty live-holder pauses are 20ms each. One attempt does not take that pause.
      expect(elapsed).toBeLessThan(700);
    } finally {
      holder.kill();
    }
  });
});
