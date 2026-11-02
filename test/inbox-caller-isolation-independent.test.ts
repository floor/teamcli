// Synthetic homes, messages and process ancestry only; never herdr, an owner's CLI or signals.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.ts';
import type { ServeOptions, ServeStreams } from '../src/mcp/serve.ts';
// HOME-sensitive modules are imported only after this file has made its own home.
const priorHome = process.env.HOME;
const suiteHome = realpathSync(mkdtempSync(join(tmpdir(), 'inbox-proof-home-')));
process.env.HOME = suiteHome;
const { registerInbox } = await import('../src/mcp/register.ts');
const { profileFor } = await import('../src/profiles/index.ts');
const { launchCommand } = await import('../src/profiles/profile.ts');
const { runMcpServe, restartSelf } = await import('../src/mcp/serve.ts');
const { signRecord } = await import('../src/send/record.ts');
const { upsertTeam, teamIdOf } = await import('../src/registry/teams.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { buildIdentity } = await import('../src/version.ts');
const build = buildIdentity();
const oldEpoch = 'run_111111111111', newEpoch = 'run_222222222222';
const id = '719be44c-6e2f-4821-8766-c4493f74c09c';
let base: string, home: string, rootA: string, rootB: string, lobby: string, file: string, dir: string, drop: string;
let kills: ReturnType<typeof spyOn<typeof process, 'kill'>>;
beforeEach(() => {
  kills = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error(`blocked signal ${pid} ${String(signal)}`);
    return true;
  });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'inbox-proof-'))); home = join(base, 'home');
  rootA = join(base, 'team-a'); rootB = join(base, 'team-b'); lobby = join(base, 'lobby');
  dir = join(rootB, '.agents'); file = join(dir, 'team.yaml'); drop = join(dir, 'send-drops', 'session-b', 'reader');
  for (const p of [home, rootA, lobby, dir, drop]) mkdirSync(p, { recursive: true });
  writeFileSync(file, `format: 1\nproject: fixture-b\nsession: session-b\ncoordinator: reader\noperator: reader\nworkspace:\n  mode: shared\nseats:\n  - name: reader\n    role: coordinator\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n`);
  upsertTeam(home, teamIdOf(rootB), { project: 'fixture-b', session: 'session-b', root: rootB,
    roster: [{ agent: 'agt_111111111111', seat: 'reader', role: 'coordinator' }] });
  updateState(dir, state => {
    const s = state.sessions['session-b'] ??= emptySession();
    s.seats.reader = { stage: 'launched', pane: 'pane-b', workspace: 'workspace-b' };
  });
  epoch(oldEpoch);
});
afterEach(() => { kills.mockRestore(); execFileSync('/usr/bin/trash', [base]); });
afterAll(() => {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  execFileSync('/usr/bin/trash', [suiteHome]);
});
function epoch(value: string) {
  updateState(dir, state => {
    const s = state.sessions['session-b']!;
    (s.briefs ??= {}).reader = { id: '36f8f09e-2eb5-4814-a905-e8a9dfc702e8', at: '2026-11-02T09:00:00Z',
      incarnation: 'inc_111111111111', epoch: value, sha256: 'a'.repeat(64), stage: 'ready', attempt: 0 };
  });
}
function message() {
  writeFileSync(join(drop, id), JSON.stringify(signRecord({ kind: 'message', id, to: 'reader', to_id: null,
    root: rootB, session: 'session-b', at: '2026-11-02T09:00:00Z', body: 'private synthetic body',
    from: 'sender', from_id: null, rule: 'the owner', thread: id }, home)));
}
function snapshot(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const key = prefix + entry.name, next = join(at, entry.name);
      if (entry.isDirectory()) { out[key] = 'directory'; walk(next, key + '/'); }
      else out[key] = createHash('sha256').update(readFileSync(next)).digest('hex');
    }
  }; walk(path, ''); return out;
}
// The proof is produced by placeCaller; these fixtures never supply Io.caller directly.
function ioFor(kind: 'own' | 'foreign' | 'managed' | 'external' | 'forged' = 'own', cli = 'claude', cwd = lobby) {
  let err = '';
  const io: Io = { cwd, env: {}, stdinIsTTY: false, stdout: () => {}, stderr: s => { err += s; },
    callerSources: session => ({
      ancestors: () => kind === 'external' ? [{ pid: 81, name: 'bun' }, { pid: 1, name: 'launchd' }]
        : kind === 'managed' ? [{ pid: 82, name: 'codex' }, { pid: 1, name: 'launchd' }]
        : [{ pid: 80, name: cli }, { pid: 83, name: 'zsh' }, { pid: 84, name: 'herdr' }, { pid: 1, name: 'launchd' }],
      agents: () => session === 'session-b' ? [{ name: 'reader', agent: cli, pane: 'pane-b', workspace: 'workspace-b', status: 'idle', cwd: lobby }] : [],
      paneRootPid: () => kind === 'foreign' || kind === 'forged' ? 999 : 83,
      managedEndpointSeat: pid => pid === 82 ? { session: 'session-b', seat: 'reader', pane: 'pane-b' } : null,
      env: kind === 'forged' ? { HERDR_PANE_ID: 'pane-b', TEAM_SEAT: 'reader', TEAM_SESSION: 'session-b' } : {}, stdinIsTTY: false,
    }),
  };
  return { io, error: () => err };
}
const call = (name = 'inbox_read', args: unknown = { id }) => JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
async function serve(options: ServeOptions, io: Io, lines: AsyncIterable<string> = (async function* () { yield call(); })()) {
  const replies: Array<any> = [];
  const streams: ServeStreams = { lines, write: text => { replies.push(JSON.parse(text)); } };
  const code = await runMcpServe(options, io, streams, { home, build });
  return { code, replies };
}
const ownOptions = (e = oldEpoch): ServeOptions => ({ seat: 'reader', session: 'session-b', file, epoch: e });
for (const route of ['file', 'registry', 'seat-only'] as const) for (const stale of [false, true]) {
  test(`foreign process cannot use saved ${route} arguments${stale ? ' at an old epoch with a removed seat' : ''}`, async () => {
    message(); if (stale) { epoch(newEpoch); updateState(dir, state => { delete state.sessions['session-b']!.seats.reader; }); }
    const before = snapshot(rootB), caller = ioFor('foreign', 'cursor', rootA);
    const options = route === 'file' ? ownOptions() : { seat: 'reader', ...(route === 'registry' ? { session: 'session-b' } : {}), epoch: oldEpoch };
    const result = await serve(options, caller.io);
    expect(result.code).toBe(2); expect(result.replies).toEqual([]); expect(snapshot(rootB)).toEqual(before);
    expect(caller.error()).not.toContain('private synthetic body');
  });
}
test('environment hints and correct arguments cannot replace process ancestry', async () => {
  message(); const before = snapshot(rootB);
  expect((await serve(ownOptions(), ioFor('forged').io)).code).toBe(2);
  expect(snapshot(rootB)).toEqual(before);
});
function registeredOptions(cli: string): ServeOptions {
  let args: string[] = [];
  if (cli === 'codex') {
    const profile = profileFor(cli); if (!profile) throw new Error('missing profile');
    const line = launchCommand(profile, "printf '%s\\n'", '', undefined,
      { seat: 'reader', session: 'session-b', file, epoch: oldEpoch, command: process.execPath, entry: '/synthetic/entry.ts' });
    const printed = execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8', env: { HOME: suiteHome, PATH: process.env.PATH } }).trimEnd().split('\n');
    const encoded = printed.find(word => word.startsWith('mcp_servers.team_inbox.args='));
    if (!encoded) throw new Error('launch did not register inbox');
    args = JSON.parse(encoded.slice(encoded.indexOf('=') + 1));
  } else {
    const targets: Record<string, string> = { gemini: '.gemini/settings.json', grok: '.grok/config.toml' };
    const result = registerInbox({ cli, seat: 'reader', cwd: lobby, file, home, run: (_command, argv) => {
      args = [...argv];
      const target = targets[cli]; if (!target) throw new Error('unexpected CLI runner');
      const parts = target.split('/'); mkdirSync(join(lobby, parts[0]!), { recursive: true });
      writeFileSync(join(lobby, target), 'synthetic CLI output'); return { code: 0 };
    } });
    expect(result).toEqual({ ok: true });
    if (cli === 'cursor') args = JSON.parse(readFileSync(join(lobby, '.cursor/mcp.json'), 'utf8')).mcpServers['team-inbox'].args;
  }
  const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  expect(args).toContain('serve'); expect(flag('--seat')).toBe('reader'); expect(flag('--session')).toBe('session-b');
  expect(flag('--file')).toBe(file); expect(flag('--epoch')).toBe(oldEpoch);
  return { seat: flag('--seat'), session: flag('--session'), file: flag('--file'), epoch: flag('--epoch') };
}
for (const cli of ['codex', 'cursor', 'gemini', 'grok']) test(`${cli} generated registration serves its own pane from a lobby cwd`, async () => {
  message(); const caller = ioFor('own', cli);
  const result = await serve(registeredOptions(cli), caller.io);
  expect(result.code, caller.error()).toBe(0); expect(result.replies[0]?.result?.isError).not.toBe(true);
  expect(JSON.stringify(result.replies)).toContain('private synthetic body'); expect(existsSync(join(drop, id + '.read.json'))).toBe(true);
});
test('managed Codex app-server ancestry outside herdr still proves the seat', async () => {
  message(); const caller = ioFor('managed'); const result = await serve(ownOptions(), caller.io);
  expect(result.code, caller.error()).toBe(0); expect(JSON.stringify(result.replies)).toContain('private synthetic body');
  expect(existsSync(join(drop, id + '.read.json'))).toBe(true);
});
test('correct placement with a stale epoch refuses before opening or writing', async () => {
  message(); epoch(newEpoch); const before = snapshot(rootB);
  expect((await serve(ownOptions(), ioFor().io)).code).toBe(2); expect(snapshot(rootB)).toEqual(before);
});
test('a correctly placed server cannot omit the current claim epoch', async () => {
  message(); const before = snapshot(rootB);
  expect((await serve({ seat: 'reader', session: 'session-b', file }, ioFor().io)).code).toBe(2);
  expect(snapshot(rootB)).toEqual(before);
});
test('a saved epoch whose claim was removed cannot start serving ordinary mail', async () => {
  message(); updateState(dir, state => { delete state.sessions['session-b']!.briefs!.reader; });
  const before = snapshot(rootB);
  expect((await serve(ownOptions(), ioFor().io)).code).toBe(2); expect(snapshot(rootB)).toEqual(before);
});
test('an unreadable state refuses without repeating synthetic secret-like content', async () => {
  message(); const secret = 'synthetic-state-secret-keep-hidden';
  writeFileSync(join(dir, 'team.state.json'), '{' + secret);
  const before = snapshot(rootB), caller = ioFor();
  const result = await serve(ownOptions(), caller.io);
  expect(result.code).toBe(2); expect(result.replies).toEqual([]);
  expect(caller.error()).not.toContain(secret); expect(caller.error()).not.toContain('private synthetic body');
  expect(snapshot(rootB)).toEqual(before);
});
test('an external process with no placement cannot gain a seat through its arguments', async () => {
  message(); const before = snapshot(rootB);
  expect((await serve(ownOptions(), ioFor('external').io)).code).toBe(2); expect(snapshot(rootB)).toEqual(before);
});
for (const damage of ['epoch', 'pane', 'removed-seat'] as const) test(`each tool call re-proves the ${damage} and a new epoch reader works`, async () => {
  message(); const caller = ioFor();
  const lines = (async function* () {
    yield call('inbox_check', {});
    if (damage === 'epoch') epoch(newEpoch);
    else updateState(dir, state => {
      if (damage === 'pane') state.sessions['session-b']!.seats.reader!.pane = 'replacement-pane';
      else delete state.sessions['session-b']!.seats.reader;
    });
    yield call('inbox_check', {}); yield call(); yield call('ack', { id });
  })();
  const result = await serve(ownOptions(), caller.io, lines);
  expect(result.code).toBe(0); expect(result.replies[0]?.result?.isError).not.toBe(true);
  for (const reply of result.replies.slice(1)) expect(reply.result.isError).toBe(true);
  expect(existsSync(join(drop, id + '.read.json'))).toBe(false);
  if (damage === 'epoch') {
    const next = await serve(ownOptions(newEpoch), ioFor().io);
    expect(next.code).toBe(0); expect(JSON.stringify(next.replies)).toContain('private synthetic body');
    expect(existsSync(join(drop, id + '.read.json'))).toBe(true);
  }
});
test('channel push re-proves an epoch changed after startup before publishing a new ordinary message', async () => {
  writeFileSync(file, readFileSync(file, 'utf8').replace('    launch: claude', '    launch: claude --dangerously-load-development-channels server:team-inbox'));
  const lines = (async function* () {
    yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    epoch(newEpoch); message();
    await Bun.sleep(600);
  })();
  const result = await serve(ownOptions(), ioFor().io, lines);
  expect(result.code).toBe(0);
  expect(result.replies.filter(r => r.method === 'notifications/claude/channel')).toEqual([]);
  expect(existsSync(join(drop, id + '.channel-push.json'))).toBe(false);
  expect(existsSync(join(drop, id + '.read.json'))).toBe(false);
});

test('an install handoff preserves the replacement server own-seat route', async () => {
  message(); let oldServerAlive = true;
  const child = new EventEmitter() as ChildProcess;
  child.unref = () => {};
  restartSelf({ spawnChild: (() => child) as never, exit: () => { oldServerAlive = false; }, say: () => {} });
  // spawn is the production handoff seam. The new process stays alive after the old parent
  // exits; on Unix it is reparented, so the former CLI/herdr ancestors are no longer ancestors.
  child.emit('spawn');
  const caller = ioFor(); const placedSources = caller.io.callerSources!;
  caller.io.callerSources = session => {
    const source = placedSources(session);
    return { ...source, ancestors: () => oldServerAlive ? source.ancestors() : [{ pid: 90, name: 'bun' }, { pid: 1, name: 'launchd' }] };
  };
  const result = await serve(ownOptions(), caller.io);
  expect(result.code, caller.error()).toBe(0);
  expect(JSON.stringify(result.replies)).toContain('private synthetic body');
  expect(existsSync(join(drop, id + '.read.json'))).toBe(true);
});
