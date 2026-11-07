import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart } from '../src/commands/start.ts';
import { StartFiles } from '../src/start/files.ts';
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


describe('team start file boundaries', () => {
  function admitted() {
    const place = world();
    mkdirSync(join(place.home, '.config', 'team'), { recursive: true });
    writeFileSync(join(place.home, '.config', 'team', 'teams.yaml'), 'teams: {}\n');
    const calls: string[] = [];
    const sources = {
      home: place.home,
      loggedIn: (cli: string) => cli === 'grok' || cli === 'cursor',
      notifyRoot: () => { calls.push('notify'); },
      daemonRunning: () => true,
      init: async () => { calls.push('init'); return 0; },
      up: async () => { calls.push('up'); return 0; },
      check: () => true,
      ready: () => ({ lead: true, builder: true }),
      send: async () => { calls.push('send'); return { ok: true, id: 'message', arrived: true, read: true, working: true, claimedTask: 'message' }; },
    };
    return { ...place, calls, sources };
  }

  for (const variant of ['state-link', 'state-dangling', 'state-folder', 'state-hardlink', 'parent-link', 'parent-file', 'team-link', 'team-dangling', 'team-hardlink'] as const) {
    test(`refuses ${variant} before writes or command callbacks`, async () => {
      const { home, root, calls, sources } = admitted();
      const outside = join(home, 'outside');
      mkdirSync(outside);
      const target = join(outside, 'kept.txt');
      const bytes = 'synthetic outside data\n';
      writeFileSync(target, bytes);
      const agents = join(root, '.agents');
      if (variant === 'parent-link') symlinkSync(outside, agents);
      else if (variant === 'parent-file') writeFileSync(agents, bytes);
      else {
        mkdirSync(agents);
        const leaf = join(agents, variant.startsWith('team-') ? 'team.yaml' : 'start.json');
        if (variant.endsWith('-link')) symlinkSync(target, leaf);
        if (variant.endsWith('-dangling')) symlinkSync(join(outside, 'absent'), leaf);
        if (variant.endsWith('-folder')) mkdirSync(leaf);
        if (variant.endsWith('-hardlink')) linkSync(target, leaf);
      }
      const before = readdirSync(outside);
      const io = testIo(root, { kind: 'owner' });
      expect(await runStart(['--json'], io, sources)).toBe(1);
      expect(io.err).toContain('setup files');
      expect(calls).toEqual([]);
      expect(readFileSync(target, 'utf8')).toBe(bytes);
      expect(readdirSync(outside)).toEqual(before);
      expect(readFileSync(join(home, '.config', 'team', 'teams.yaml'), 'utf8')).toBe('teams: {}\n');
      if (variant === 'parent-file') expect(readFileSync(agents, 'utf8')).toBe(bytes);
      else if (variant !== 'parent-link') {
        expect(readdirSync(agents)).toEqual([variant.startsWith('team-') ? 'team.yaml' : 'start.json']);
      }
    });
  }

  test('refuses linked resume state even when its JSON says preset is complete', async () => {
    const { home, root, calls, sources } = admitted();
    const agents = join(root, '.agents');
    mkdirSync(agents);
    const target = join(home, 'resume.json');
    const bytes = JSON.stringify({ detect: true, preset: true, clis: ['grok', 'cursor'] });
    writeFileSync(target, bytes);
    symlinkSync(target, join(agents, 'start.json'));
    writeFileSync(join(agents, 'team.yaml'), 'held team\n');
    const io = testIo(root, { kind: 'owner' });
    expect(await runStart([], io, sources)).toBe(1);
    expect(io.err).toContain('setup files');
    expect(calls).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(bytes);
    expect(readFileSync(join(agents, 'team.yaml'), 'utf8')).toBe('held team\n');
  });

  for (const variant of ['parent', 'state', 'team'] as const) {
    test(`refuses a ${variant} swap during init before a later write or callback`, async () => {
      const { home, root, calls, sources } = admitted();
      const agents = join(root, '.agents');
      const outside = join(home, 'outside');
      mkdirSync(outside);
      const target = join(outside, 'kept');
      writeFileSync(target, 'kept\n');
      let before = '';
      sources.init = async () => {
        calls.push('init');
        before = readFileSync(join(agents, 'start.json'), 'utf8');
        if (variant === 'parent') {
          renameSync(agents, join(root, 'saved-agents'));
          symlinkSync(outside, agents);
        } else {
          const leaf = join(agents, variant === 'state' ? 'start.json' : 'team.yaml');
          renameSync(leaf, `${leaf}.saved`);
          symlinkSync(target, leaf);
        }
        return 0;
      };
      const io = testIo(root, { kind: 'owner' });
      expect(await runStart([], io, sources)).toBe(1);
      expect(io.err).toContain('setup files');
      expect(calls).toEqual(['notify', 'init']);
      expect(readFileSync(target, 'utf8')).toBe('kept\n');
      expect(readdirSync(outside)).toEqual(['kept']);
      if (variant === 'parent') expect(readFileSync(join(root, 'saved-agents', 'start.json'), 'utf8')).toBe(before);
      else expect(lstatSync(join(agents, variant === 'state' ? 'start.json' : 'team.yaml')).isSymbolicLink()).toBe(true);
    });
  }
});


describe('setup file writer', () => {
  test('the setup writer works on plain Node without runtime feature flags', () => {
    const { home, root } = world();
    const module = new URL('../src/start/files.ts', import.meta.url).href;
    const script = `import { StartFiles } from ${JSON.stringify(module)}; const files = new StartFiles(process.argv[1]); try { files.write('start.json', '{}\\n'); files.write('team.yaml', 'team\\n', true); } finally { files.close(); }`;
    const child = spawnSync('node', ['--input-type=module', '-e', script, root], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      encoding: 'utf8', timeout: 10_000,
    });
    expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
    expect(readFileSync(join(root, '.agents', 'start.json'), 'utf8')).toBe('{}\n');
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe('team\n');
  });

  test('new files have private modes and a failed create never replaces the team file', () => {
    const { root } = world();
    const files = new StartFiles(root);
    try {
      files.write('start.json', '{}\n');
      files.write('team.yaml', 'kept\n', true);
      expect(() => files.write('team.yaml', 'replaced\n', true)).toThrow('already exists');
      expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe('kept\n');
      expect(lstatSync(join(root, '.agents')).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(root, '.agents', 'start.json')).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(root, '.agents', 'team.yaml')).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(root, '.agents'))).toEqual(['start.json', 'team.yaml']);
    } finally { files.close(); }
  });
});
