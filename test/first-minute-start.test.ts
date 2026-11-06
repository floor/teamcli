import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart } from '../src/commands/start.ts';
import { testIo } from './helpers.ts';

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function world(): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fm-start-')));
  bases.push(base);
  const home = join(base, 'home');
  const root = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'project\n');
  return { home, root };
}

describe('team start without the admission door', () => {
  test('an empty account is a bootstrap miss and writes nothing', async () => {
    const { home, root } = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runStart(['--json'], io, { home, loggedIn: () => true });
    expect(code).toBe(1);
    const proof = JSON.parse(io.out) as { daemonRunning: boolean; roots: number; teamFile: boolean };
    expect(proof.daemonRunning).toBe(false);
    expect(proof.roots).toBe(0);
    expect(proof.teamFile).toBe(false);
    expect(existsSync(join(home, '.config', 'team', 'teams.yaml'))).toBe(false);
    expect(existsSync(join(home, '.config', 'team', 'owner-seat.json'))).toBe(false);
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
    expect(io.err).not.toContain('unknown command');
  });

  test('a caller who is not the owner does not get a new door', async () => {
    const { home, root } = world();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'teams.yaml'), 'teams: {}\n');
    const io = testIo(root, { kind: 'owner-no-tty' });
    const code = await runStart(['--json'], io, { home, loggedIn: () => true });
    expect(code).toBe(1);
    expect(io.err).toContain('only the owner');
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
  });

  test('an admitted owner gets the preset, the running root, and the lead send on the ordinary map', async () => {
    const { home, root } = world();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'teams.yaml'), 'teams: {}\n');
    const noticed: string[] = [];
    let inits = 0;
    let sends = 0;
    const sources = {
      home,
      loggedIn: (cli: string) => cli === 'grok' || cli === 'cursor',
      notifyRoot: (path: string) => noticed.push(path),
      daemonRunning: () => true,
      init: async () => {
        inits += 1;
        return 0;
      },
      up: async () => 0,
      check: () => true,
      ready: () => ({ lead: true, builder: true }),
      send: async (input: { lead: string; builder: string; body: string }) => {
        sends += 1;
        expect(input).toEqual({
          lead: 'lead',
          builder: 'builder',
          body: 'send the builder its first task now',
        });
        return {
          ok: true,
          id: 'msg-1',
          arrived: true,
          read: true,
          working: true,
          claimedTask: null,
        };
      },
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runStart(['--json'], io, sources);
    expect(code).toBe(0);
    const proof = JSON.parse(io.out) as { roots: number; exchangeId: string; claimedTask: string; working: boolean };
    expect(proof.roots).toBe(1);
    expect(proof.exchangeId).toBe('msg-1');
    expect(proof.claimedTask).toBe('msg-1');
    expect(proof.working).toBe(true);
    expect(noticed).toEqual([root]);
    const team = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    const launches = team.split('\n').filter((line) => line.trim().startsWith('launch:'));
    expect(launches).toEqual(['    launch: grok', '    launch: cursor']);
    expect(team).not.toContain('/');
    expect(inits).toBe(1);

    const again = testIo(root, { kind: 'owner' });
    expect(await runStart(['--json'], again, sources)).toBe(0);
    expect(inits).toBe(1);
    expect(sends).toBe(1);
    expect(noticed).toEqual([root]);
  });

  test('a folder that already holds a team is left as it is', async () => {
    const { home, root } = world();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const registry = 'teams: {}\n';
    writeFileSync(join(home, '.config', 'team', 'teams.yaml'), registry);
    mkdirSync(join(root, '.agents'), { recursive: true });
    const held = 'format: 1\nproject: real-team\n';
    writeFileSync(join(root, '.agents', 'team.yaml'), held);
    const noticed: string[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runStart(['--json'], io, {
      home,
      loggedIn: (cli: string) => cli === 'grok' || cli === 'cursor',
      notifyRoot: (path: string) => noticed.push(path),
      daemonRunning: () => true,
      init: async () => 0,
      up: async () => 0,
      check: () => true,
      ready: () => ({ lead: true, builder: true }),
      send: async () => ({ ok: true, id: 'msg-1', arrived: true, read: true, working: true, claimedTask: null }),
    });
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(held);
    expect(readFileSync(join(home, '.config', 'team', 'teams.yaml'), 'utf8')).toBe(registry);
    expect(existsSync(join(root, '.agents', 'start.json'))).toBe(false);
    expect(io.err).toContain('this folder already holds a team; run team up');
    expect(code).toBe(1);
    expect(noticed).toEqual([]);
  });
});
