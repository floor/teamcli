// Synthetic teams, claims, folders and a fake pane host. No CLI-home reads or live launches.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig } from '../src/file/team-config.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { lobbyPretrustLine } from '../src/launch/pretrust.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { readListener, writeListener } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { selfRunner } from '../src/mcp/register.ts';
import { upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import { seatStart } from '../src/worktree/place.ts';
import { testIo } from './helpers.ts';

const FLAG = '--dangerously-load-development-channels server:team-inbox';
const FIRST = 'run_0123456789ab';
const NEXT = 'run_ba9876543210';
const SESSION = 'synthetic-session';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'channel-config-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'project');
  const lobby = join(home, 'lobby');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(lobby, { mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents/team.yaml');
  writeFileSync(file, `format: 1
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
${['alpha', 'beta', 'plain'].map((name) => `  - name: ${name}
    role: ${name === 'alpha' ? 'coordinator' : 'worker'}
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: claude${name === 'plain' ? '' : ` ${FLAG}`}`).join('\n')}
`);
  upsertTeam(home, teamIdOf(root), { root, project: 'synthetic-project', session: SESSION, lobby,
    roster: ['alpha', 'beta', 'plain'].map((seat, i) => ({ agent: `agt_${String(i + 1).padStart(12, '0')}`, seat, role: 'worker' })) });
  const state = join(root, '.agents/team.state.json');
  const claim = (epoch: string | null) => {
    writeFileSync(state, JSON.stringify({ format: 1, sessions: { [SESSION]: {
      seats: { alpha: { stage: 'launched', pane: 'pane-alpha' }, beta: { stage: 'launched', pane: 'pane-beta' } },
      worktrees: {}, briefs: epoch === null ? {} : Object.fromEntries(['alpha', 'beta'].map((seat) => [seat, {
        id: '01234567-0000-4000-8000-000000000001', incarnation: 'inc_0123456789ab', epoch,
        at: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64), stage: 'ready',
      }])),
    } } }));
  };
  claim(FIRST);
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error('synthetic team fixture could not load');
  const input = (seat = 'alpha', epoch: string | undefined = FIRST) => ({ root, home, seat, session: SESSION, cwd: join(lobby, seat), epoch });
  const config = (seat = 'alpha') => join(lobby, seat, '.mcp.json');
  const approval = (seat = 'alpha') => join(lobby, seat, '.claude/settings.local.json');
  return { base, home, root, lobby, file, claim, team: loaded.team, input, config, approval };
}
type World = ReturnType<typeof world>;

function prepare(w: World, seat = 'alpha', epoch = FIRST) {
  const read = prepareChannelConfig(w.input(seat, epoch));
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(read.reason);
  return read.lease;
}
function entry(w: World, seat = 'alpha') {
  return JSON.parse(readFileSync(w.config(seat), 'utf8')).mcpServers['team-inbox'];
}
function plan(w: World, epoch = FIRST, seats = ['alpha']): Step[] {
  const planned: UpSeat[] = seats.map((name) => ({ name, cli: 'claude-code',
    launch: `claude ${FLAG}`, cwd: w.lobby, lobby: true, label: name, displayAgent: 'Synthetic',
    repairLine: 'restart this synthetic seat', rules: 'Synthetic rules.', stopped: false }));
  return upPlan({ root: w.root, session: SESSION, sessionRunning: true, seats: planned,
    team: w.team, home: w.home, briefEpochs: Object.fromEntries(seats.map((seat) => [seat, epoch])),
    startWatch: false, watchLabel: 'Synthetic watch' });
}
function host(w: World, onRun: () => boolean = () => true) {
  const calls: string[] = [];
  const patches: Parameters<Host['record']>[] = [];
  const out: string[] = [];
  const fake: Host = {
    startServer: () => true, sessionUp: () => true,
    createWorkspace: (_session, cwd) => {
      calls.push('create');
      expect(cwd).toBe(join(w.lobby, 'alpha'));
      expect(entry(w).args.at(-1)).toBe(FIRST);
      expect(JSON.parse(readFileSync(w.approval(), 'utf8')).enabledMcpjsonServers).toContain('team-inbox');
      return { pane: 'pane-alpha', workspace: 'workspace-alpha' };
    },
    paneRun: () => {
      calls.push('spawn');
      expect(entry(w).args.at(-1)).toBe(FIRST);
      expect(JSON.parse(readFileSync(w.approval(), 'utf8')).enabledMcpjsonServers).toContain('team-inbox');
      return onRun();
    },
    registerInbox: () => { calls.push('register'); return null; },
    typeLine: () => false, renameAgent: () => true, closeWorkspace: () => true, stopSession: () => true,
    kill: () => true, agentPanes: () => [], classify: () => 'idle', sleep: async () => {}, now: () => 0,
    allow: () => null, record: (...args) => { patches.push(args); }, running: () => {}, drop: () => {},
    say: (line) => { out.push(line); }, log: () => {},
  };
  return { fake, calls, patches, out };
}

describe('launch-scoped channel config', () => {
  test('each seat owns an isolated project config with the current runner and explicit epoch', () => {
    const w = world();
    prepare(w).release();
    prepare(w, 'beta').release();
    for (const seat of ['alpha', 'beta']) {
      const actual = entry(w, seat);
      expect(actual.command).toBe(selfRunner().command);
      expect(actual.args).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', seat, '--session', SESSION, '--epoch', FIRST]);
      expect(actual.args).not.toContain('--file');
      expect(statSync(w.config(seat)).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(w.lobby, '.mcp.json'))).toBe(false);
    expect(existsSync(join(w.home, '.claude.json'))).toBe(false);
  });

  test('relaunch replaces only the owned entry with its fresh epoch and preserves unrelated keys', () => {
    const w = world();
    mkdirSync(join(w.lobby, 'alpha'), { mode: 0o700 });
    writeFileSync(w.config(), JSON.stringify({ unrelated: { keep: true }, mcpServers: { other: { command: 'synthetic' } } }));
    prepare(w).release();
    w.claim(NEXT);
    prepare(w, 'alpha', NEXT).release();
    const config = JSON.parse(readFileSync(w.config(), 'utf8'));
    expect(config.unrelated).toEqual({ keep: true });
    expect(config.mcpServers.other).toEqual({ command: 'synthetic' });
    expect(config.mcpServers['team-inbox'].args.at(-1)).toBe(NEXT);
    const saved = readFileSync(w.config(), 'utf8');
    expect(prepareChannelConfig(w.input()).ok).toBe(false);
    expect(readFileSync(w.config(), 'utf8')).toBe(saved);
  });

  test('no claim, omitted epoch and stale epoch fail before folder/config creation', () => {
    const w = world();
    w.claim(null);
    expect(prepareChannelConfig(w.input()).ok).toBe(false);
    expect(existsSync(join(w.lobby, 'alpha'))).toBe(false);
    w.claim(NEXT);
    expect(prepareChannelConfig({ ...w.input(), epoch: undefined }).ok).toBe(false);
    expect(prepareChannelConfig(w.input()).ok).toBe(false);
    expect(existsSync(join(w.lobby, 'alpha'))).toBe(false);
  });

  test('claim replacement revokes an existing config lease before spawn', () => {
    const w = world();
    const lease = prepare(w);
    w.claim(NEXT);
    expect(() => lease.check()).toThrow('epoch');
    lease.release();
    expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
  });

  test('an in-place config edit revokes the pre-spawn lease without deleting the edit', () => {
    const w = world();
    const lease = prepare(w);
    writeFileSync(w.config(), '{"unrelated":"edit"}');
    expect(() => lease.check()).toThrow('config changed');
    lease.release();
    expect(JSON.parse(readFileSync(w.config(), 'utf8')).unrelated).toBe('edit');
  });

  test('competing config writer refuses without changing the held config or lock', () => {
    const w = world();
    const first = prepare(w);
    const saved = readFileSync(w.config(), 'utf8');
    const approval = readFileSync(w.approval(), 'utf8');
    expect(prepareChannelConfig(w.input()).ok).toBe(false);
    expect(readFileSync(w.config(), 'utf8')).toBe(saved);
    expect(readFileSync(w.approval(), 'utf8')).toBe(approval);
    expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(true);
    first.release();
    prepare(w).release();
  });

  test('release never removes a replacement lock', () => {
    const w = world();
    const lease = prepare(w);
    const lock = join(w.lobby, 'alpha/.team-channel.lock');
    renameSync(lock, `${lock}-old`);
    mkdirSync(lock, { mode: 0o700 });
    lease.release();
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(`${lock}-old`)).toBe(true);
  });

  test('another process cannot publish while the first config lease is held', () => {
    const w = world();
    const lease = prepare(w);
    const saved = readFileSync(w.config(), 'utf8');
    const approval = readFileSync(w.approval(), 'utf8');
    const script = `import { prepareChannelConfig } from ${JSON.stringify(join(import.meta.dir, '../src/mcp/launch-config.ts'))};
      const read = prepareChannelConfig(${JSON.stringify(w.input())});
      if (read.ok) read.lease.release();
      process.exit(read.ok ? 0 : 3);`;
    const other = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8' });
    expect(other.status).toBe(3);
    expect(readFileSync(w.config(), 'utf8')).toBe(saved);
    expect(readFileSync(w.approval(), 'utf8')).toBe(approval);
    lease.check();
    lease.release();
  });

  test('a dead config writer leaves a closed claim that a later launch never reclaims', () => {
    const w = world();
    const script = `import { prepareChannelConfig } from ${JSON.stringify(join(import.meta.dir, '../src/mcp/launch-config.ts'))};
      const read = prepareChannelConfig(${JSON.stringify(w.input())});
      process.exit(read.ok ? 0 : 3);`;
    const dead = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8' });
    expect(dead.status).toBe(0);
    const saved = readFileSync(w.config(), 'utf8');
    expect(prepareChannelConfig(w.input()).ok).toBe(false);
    expect(readFileSync(w.config(), 'utf8')).toBe(saved);
    expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(true);
  });

  for (const shape of ['foreign-server', 'edited-owned-server', 'array', 'invalid-json', 'invalid-servers', 'hardlink', 'config-link', 'folder-link']) {
    test(`a ${shape} conflict is left untouched`, () => {
      const w = world();
      const folder = join(w.lobby, 'alpha');
      const elsewhere = join(w.base, 'unrelated');
      mkdirSync(elsewhere, { mode: 0o700 });
      const marker = join(elsewhere, 'keep.json');
      writeFileSync(marker, 'unrelated data');
      if (shape === 'folder-link') symlinkSync(elsewhere, folder);
      else {
        mkdirSync(folder, { mode: 0o700 });
        if (shape === 'config-link') symlinkSync(marker, w.config());
        else if (shape === 'hardlink') linkSync(marker, w.config());
        else if (shape === 'edited-owned-server') {
          prepare(w).release();
          const config = JSON.parse(readFileSync(w.config(), 'utf8'));
          config.mcpServers['team-inbox'].extra = 'keep';
          writeFileSync(w.config(), JSON.stringify(config));
        } else writeFileSync(w.config(), shape === 'array' ? '[]' : shape === 'invalid-json' ? '{'
          : shape === 'invalid-servers' ? '{"mcpServers":null}'
          : '{"mcpServers":{"team-inbox":{"command":"unrelated"}}}');
      }
      const before = existsSync(w.config()) ? readFileSync(w.config(), 'utf8') : undefined;
      expect(prepareChannelConfig(w.input()).ok).toBe(false);
      if (before !== undefined) expect(readFileSync(w.config(), 'utf8')).toBe(before);
      expect(readFileSync(marker, 'utf8')).toBe('unrelated data');
    });
  }

  test('wrong registry root, untrusted lobby and another start folder are refused', () => {
    const w = world();
    expect(prepareChannelConfig({ ...w.input(), root: w.base }).ok).toBe(false);
    expect(prepareChannelConfig({ ...w.input(), cwd: w.base }).ok).toBe(false);
    writeFileSync(w.file, readFileSync(w.file, 'utf8').replace(`  - ${w.lobby}\n`, ''));
    expect(prepareChannelConfig(w.input()).ok).toBe(false);
    expect(existsSync(join(w.lobby, 'alpha'))).toBe(false);
  });

  test('channel seat placement includes leads; ordinary seats and trust stores stay unchanged', () => {
    const w = world();
    for (const name of ['alpha', 'beta']) {
      const seat = w.team.seats.find((one) => one.name === name)!;
      const start = seatStart(w.team, seat, w.root, w.home);
      expect(start).toEqual({ cwd: join(w.lobby, name), lobby: true });
      expect(lobbyPretrustLine({ ...seat, cwd: join(w.lobby, name), lobby: true }, w.home, { write: true, now: new Date() })).toBeNull();
    }
    const ordinary = w.team.seats.find((one) => one.name === 'plain')!;
    expect(seatStart(w.team, ordinary, w.root, w.home)).toEqual({ cwd: w.lobby, lobby: true });
    expect(existsSync(join(w.home, '.claude.json'))).toBe(false);
  });

  test('an old config started after a new claim is refused by the existing explicit-epoch guard', async () => {
    const w = world();
    prepare(w).release();
    const oldEpoch = entry(w).args.at(-1) as string;
    w.claim(NEXT);
    const io = testIo(join(w.lobby, 'alpha'), { kind: 'seat', name: 'alpha', pane: 'pane-alpha', session: SESSION });
    const code = await runMcpServe({ seat: 'alpha', session: SESSION, epoch: oldEpoch }, io,
      { lines: (async function* () {})(), write: () => {} }, { home: w.home });
    expect(code).toBe(2);
    expect(io.err).toContain('not the seat\'s current launch epoch');
    expect(existsSync(join(w.root, '.agents/send-drops', SESSION, 'alpha/listener.json'))).toBe(false);
  });
});

describe('named project channel approval', () => {
  function settings(w: World, text: string) {
    mkdirSync(join(w.lobby, 'alpha'), { mode: 0o700 });
    mkdirSync(join(w.lobby, 'alpha/.claude'), { mode: 0o755 });
    writeFileSync(w.approval(), text);
  }

  test('fresh isolated folders approve only the named server without private settings metadata', () => {
    const w = world();
    for (const seat of ['alpha', 'beta']) {
      prepare(w, seat).release();
      expect(JSON.parse(readFileSync(w.approval(seat), 'utf8'))).toEqual({ enabledMcpjsonServers: ['team-inbox'] });
      expect(statSync(w.approval(seat)).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(w.lobby, '.claude'))).toBe(false);
    expect(existsSync(join(w.lobby, 'plain'))).toBe(false);
    expect(existsSync(join(w.home, '.claude'))).toBe(false);
  });

  for (const broad of [undefined, false, true]) {
    test(`preserves existing settings and names without changing an existing ${String(broad)} approval switch`, () => {
      const w = world();
      const original = { enabledMcpjsonServers: ['other', 'another'], disabledMcpjsonServers: ['rejected'],
        disabledMcpServers: ['unavailable'], nested: { keep: ['value'] }, enableAllProjectMcpServers: broad };
      settings(w, JSON.stringify(original));
      const mode = statSync(join(w.lobby, 'alpha/.claude')).mode;
      prepare(w).release();
      expect(JSON.parse(readFileSync(w.approval(), 'utf8'))).toEqual({ ...JSON.parse(JSON.stringify(original)),
        enabledMcpjsonServers: ['other', 'another', 'team-inbox'] });
      expect(statSync(join(w.lobby, 'alpha/.claude')).mode).toBe(mode);
      const saved = readFileSync(w.approval(), 'utf8');
      const inode = statSync(w.approval()).ino;
      w.claim(NEXT);
      prepare(w, 'alpha', NEXT).release();
      expect(readFileSync(w.approval(), 'utf8')).toBe(saved);
      expect(statSync(w.approval()).ino).toBe(inode);
      expect(entry(w).args.at(-1)).toBe(NEXT);
    });
  }

  test('already-approved settings retain their exact bytes and existing duplicate names', () => {
    const w = world();
    const saved = '{ "enabledMcpjsonServers": ["team-inbox", "other", "team-inbox"], "keep": true }\n';
    settings(w, saved);
    prepare(w).release();
    expect(readFileSync(w.approval(), 'utf8')).toBe(saved);
  });

  for (const text of ['{', '[]', 'null', '{"enabledMcpjsonServers":true}', '{"enabledMcpjsonServers":[3]}',
    '{"disabledMcpjsonServers":null}', '{"disabledMcpServers":{}}', '{"enableAllProjectMcpServers":"yes"}',
    '{"enabledMcpjsonServers":["team-inbox"],"disabledMcpjsonServers":["team-inbox"]}',
    '{"disabledMcpServers":["team-inbox"]}']) {
    test(`refuses invalid or denied local settings unchanged: ${text}`, async () => {
      const w = world();
      settings(w, text);
      writeFileSync(w.config(), '{"keep":"unchanged"}');
      const h = host(w);
      const report = await executePlan(plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
      expect(report.dropped).toEqual(['alpha']);
      expect(h.calls).toEqual([]);
      expect(readFileSync(w.approval(), 'utf8')).toBe(text);
      expect(readFileSync(w.config(), 'utf8')).toBe('{"keep":"unchanged"}');
      expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
    });
  }

  for (const shape of ['folder-link', 'dangling-folder-link', 'folder-file', 'settings-link', 'settings-hardlink']) {
    test(`refuses unsafe approval path ${shape} without changing unrelated data`, () => {
      const w = world();
      mkdirSync(join(w.lobby, 'alpha'), { mode: 0o700 });
      const elsewhere = join(w.base, 'unrelated');
      mkdirSync(elsewhere, { mode: 0o700 });
      const marker = join(elsewhere, 'settings.local.json');
      writeFileSync(marker, '{"keep":true}');
      const folder = join(w.lobby, 'alpha/.claude');
      if (shape === 'folder-link') symlinkSync(elsewhere, folder);
      else if (shape === 'dangling-folder-link') symlinkSync(join(w.base, 'absent'), folder);
      else if (shape === 'folder-file') writeFileSync(folder, 'keep');
      else {
        mkdirSync(folder, { mode: 0o700 });
        if (shape === 'settings-link') symlinkSync(marker, w.approval());
        else linkSync(marker, w.approval());
      }
      expect(prepareChannelConfig(w.input()).ok).toBe(false);
      expect(existsSync(w.config())).toBe(false);
      expect(readFileSync(marker, 'utf8')).toBe('{"keep":true}');
    });
  }

  for (const unsafe of ['foreign-folder', 'foreign-file', 'writable-folder', 'special-folder']) {
    test(`synthetic metadata refuses ${unsafe} before publishing either file`, () => {
      const w = world();
      settings(w, '{"keep":true}');
      const target = unsafe === 'foreign-file' ? w.approval() : join(w.lobby, 'alpha/.claude');
      const original = fs.lstatSync;
      const metadata = spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
        if (args[0] !== target) return Reflect.apply(original, fs, args);
        const actual = original(target);
        return Object.assign(Object.create(actual), unsafe.startsWith('foreign-')
          ? { uid: (process.getuid?.() ?? 0) + 1 }
          : { mode: actual.mode | (unsafe === 'writable-folder' ? 0o022 : 0o2000) });
      }) as never);
      try {
        expect(prepareChannelConfig(w.input()).ok).toBe(false);
        expect(existsSync(w.config())).toBe(false);
        expect(readFileSync(w.approval(), 'utf8')).toBe('{"keep":true}');
      } finally { metadata.mockRestore(); }
    });
  }

  for (const change of ['edit', 'replace', 'parent']) {
    test(`a settings ${change} revokes the two-file lease without deleting the changed data`, () => {
      const w = world();
      const lease = prepare(w);
      const mcp = readFileSync(w.config(), 'utf8');
      if (change === 'replace') renameSync(w.approval(), `${w.approval()}.old`);
      if (change === 'parent') {
        renameSync(join(w.lobby, 'alpha/.claude'), join(w.lobby, 'alpha/.claude-old'));
        mkdirSync(join(w.lobby, 'alpha/.claude'), { mode: 0o700 });
      }
      writeFileSync(w.approval(), '{"keep":"changed"}');
      expect(() => lease.check()).toThrow();
      lease.release();
      expect(readFileSync(w.approval(), 'utf8')).toBe('{"keep":"changed"}');
      expect(readFileSync(w.config(), 'utf8')).toBe(mcp);
      expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
    });
  }

  test('a failed second publication never creates a workspace and leaves only bounded files', async () => {
    const w = world();
    const h = host(w);
    const rename = fs.renameSync;
    let rejected = 0;
    const fail = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === w.approval()) { rejected += 1; throw new Error('synthetic second-write failure'); }
      return rename(from, to);
    });
    try {
      const report = await executePlan(plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
      expect(rejected).toBe(1);
      expect(report.dropped).toEqual(['alpha']);
      expect(h.calls).toEqual([]);
      expect(entry(w).args.at(-1)).toBe(FIRST);
      expect(existsSync(w.approval())).toBe(false);
      expect(readdirSync(join(w.lobby, 'alpha/.claude'))).toEqual([]);
      expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
    } finally { fail.mockRestore(); }
    prepare(w).release();
  });
});

describe('read-only listener startup epoch', () => {
  test('listener records the explicit startup epoch and never follows a newer claim', async () => {
    const w = world();
    const drop = join(w.root, '.agents/send-drops', SESSION, 'alpha');
    let startup: string | undefined;
    let after: string | undefined;
    const io = testIo(join(w.lobby, 'alpha'), { kind: 'seat', name: 'alpha', pane: 'pane-alpha', session: SESSION });
    const code = await runMcpServe({ seat: 'alpha', session: SESSION, epoch: FIRST }, io, {
      lines: (async function* () {
        startup = readListener(drop)?.epoch;
        w.claim(NEXT);
        after = readListener(drop)?.epoch;
      })(), write: () => {},
    }, { home: w.home });
    expect(code).toBe(0);
    expect(startup).toBe(FIRST);
    expect(after).toBe(FIRST);
  });

  test('an unbound compatible server omits metadata when no claim exists', async () => {
    const w = world();
    w.claim(null);
    const drop = join(w.root, '.agents/send-drops', SESSION, 'alpha');
    let observed = false;
    const io = testIo(w.root, { kind: 'seat', name: 'alpha', pane: 'pane-alpha', session: SESSION });
    expect(await runMcpServe({ seat: 'alpha', session: SESSION }, io, {
      lines: (async function* () {
        const marker = readListener(drop);
        expect(marker).not.toBeNull();
        expect(marker?.epoch).toBeUndefined();
        observed = true;
      })(), write: () => {},
    }, { home: w.home })).toBe(0);
    expect(observed).toBe(true);
  });

  test('legacy listeners remain readable and malformed optional metadata confers no epoch', () => {
    const w = world();
    const drop = join(w.base, 'synthetic-inbox');
    mkdirSync(drop, { mode: 0o700 });
    const marker = { v: 1 as const, seat: 'alpha', session: SESSION, root: w.root,
      cli: 'claude-code', pid: process.pid, ts: '2026-01-01T00:00:00Z' };
    expect(writeListener(drop, marker)).toBe(true);
    expect(readListener(drop)).toEqual(marker);
    expect(writeListener(drop, { ...marker, epoch: FIRST })).toBe(true);
    expect(readListener(drop)?.epoch).toBe(FIRST);
    expect(writeListener(drop, { ...marker, epoch: 'synthetic-invalid' })).toBe(true);
    expect(readListener(drop)).toEqual(marker);
  });
});

describe('claim, config, create and spawn ordering', () => {
  test('plan carries the exact epoch and config exists before create, registration and spawn', async () => {
    const w = world();
    const steps = plan(w);
    const launch = steps.find((step) => step.do?.do === 'launch')!.do;
    if (launch?.do !== 'launch') throw new Error('synthetic launch absent');
    expect(launch.channel?.epoch).toBe(FIRST);
    expect(launch.cwd).toBe(join(w.lobby, 'alpha'));
    const h = host(w);
    const report = await executePlan(steps.filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
    expect(report.dropped).toEqual([]);
    expect(h.calls).toEqual(['create', 'register', 'spawn']);
    expect(h.patches.some(([, patch]) => patch.start_cwd === join(w.lobby, 'alpha'))).toBe(true);
    expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
  });

  test('claim changes between create and spawn stop the old plan instead of rebinding', async () => {
    const w = world();
    const h = host(w);
    const create = h.fake.createWorkspace;
    h.fake.createWorkspace = (...args) => { const made = create(...args); w.claim(NEXT); return made; };
    const steps = plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch');
    const report = await executePlan(steps, SESSION, h.fake);
    expect(report.dropped).toEqual(['alpha']);
    expect(h.calls).toEqual(['create']);
    expect(entry(w).args.at(-1)).toBe(FIRST);
  });

  test('failed spawn releases only its claim and preserves unrelated files/config', async () => {
    const w = world();
    mkdirSync(join(w.lobby, 'alpha'), { mode: 0o700 });
    const keep = join(w.lobby, 'alpha/keep.txt');
    writeFileSync(keep, 'keep');
    writeFileSync(w.config(), '{"unrelated":true}');
    const h = host(w, () => false);
    const report = await executePlan(plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
    expect(report.dropped).toEqual(['alpha']);
    expect(readFileSync(keep, 'utf8')).toBe('keep');
    expect(JSON.parse(readFileSync(w.config(), 'utf8')).unrelated).toBe(true);
    expect(JSON.parse(readFileSync(w.approval(), 'utf8'))).toEqual({ enabledMcpjsonServers: ['team-inbox'] });
    expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
  });

  for (const path of ['config', 'approval'] as const) {
    test(`a ${path} edit during registration prevents spawn with an unverified pair`, async () => {
      const w = world();
      const h = host(w);
      h.fake.registerInbox = () => { h.calls.push('register'); writeFileSync(w[path](), '{"keep":"edited"}'); return null; };
      const report = await executePlan(plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
      expect(report.dropped).toEqual(['alpha']);
      expect(h.calls).toEqual(['create', 'register']);
      expect(readFileSync(w[path](), 'utf8')).toBe('{"keep":"edited"}');
      expect(existsSync(join(w.lobby, 'alpha/.team-channel.lock'))).toBe(false);
    });
  }

  test('config conflict or failed workspace creation never spawns', async () => {
    const w = world();
    const h = host(w);
    h.fake.createWorkspace = () => { h.calls.push('create'); return null; };
    let report = await executePlan(plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
    expect(report.dropped).toEqual(['alpha']);
    expect(h.calls).toEqual(['create']);
    writeFileSync(w.config(), '{"mcpServers":{"team-inbox":{"command":"other"}}}');
    h.calls.length = 0;
    report = await executePlan(plan(w).filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'), SESSION, h.fake);
    expect(report.dropped).toEqual(['alpha']);
    expect(h.calls).toEqual([]);
  });
});
