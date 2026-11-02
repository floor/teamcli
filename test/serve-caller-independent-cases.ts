// Independent stream and process scenes: no live CLI, host, bridge, or credential store.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { restartSelf, runMcpServe, type ServeOptions } from '../src/mcp/serve.ts';
import { receiptPath, listenerPath } from '../src/mcp/inbox.ts';
import { registerInbox } from '../src/mcp/register.ts';
import { launchCommand, profileFor, shellQuote } from '../src/profiles/profile.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, verifyReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './serve-caller-home-fixture.ts';

const NOW = '2026-10-21T10:30:00.000Z';
const EPOCH = 'run_42a1bc08d357';
const OLD = 'run_86310b49a2cd';
const owned: string[] = [];
afterEach(() => { for (const p of owned.splice(0)) releaseIndependentFixture(p); });
test('all product imports follow synthetic HOME startup', assertIndependentHome);

type Team = { root: string; file: string; dir: string; session: string; seat: string; pane: string; drop: string; id: string; body: string; cli: string };
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'serve-caller-scene-')));
  owned.push(base);
  const home = join(base, 'keys-and-registry');
  mkdirSync(home, { mode: 0o700 });
  function team(tag: string, cli = 'codex'): Team {
    const root = join(base, tag), dir = join(root, '.agents');
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv() });
    const seat = 'reader', session = `inbox-${tag}`, pane = `owned-${tag}`;
    const file = join(dir, 'team.yaml');
    writeFileSync(file, `format: 1
project: scene-${tag}
session: ${session}
operator: captain
workspace:
  mode: shared
delivery_order: [mcp-inbox, drop]
seats:
  - name: captain
    role: orchestrator
    leads: true
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1.0"
    launch: codex
  - name: ${seat}
    role: worker
    cli: ${cli}
    vendor: fixture
    model: Fixture
    version: "1.0"
    launch: ${cli === 'cursor' ? 'cursor-agent' : cli === 'claude-code' ? 'claude' : cli}
`);
    expect(readTeamConfig(root, { home }).ok).toBe(true);
    const one = { seats: { [seat]: { stage: 'ready', pane, start_cwd: root } }, worktrees: {}, briefs: { [seat]: { id: randomUUID(), at: NOW, incarnation: 'inc_039bca7210fe', epoch: EPOCH, sha256: 'd'.repeat(64), stage: 'claimed' } } };
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify({ format: 1, sessions: { [session]: one } }) + '\n');
    upsertTeam(home, teamIdOf(root), { root, session, project: `scene-${tag}`, roster: [{ agent: `agt_${tag === 'alpha' ? '0142ac8e09b5' : '9cab108ef472'}`, seat, role: 'worker' }] });
    const drop = join(dir, 'send-drops', session, seat), id = randomUUID(), body = `synthetic private inbox body ${tag} ${randomUUID()}`;
    mkdirSync(drop, { recursive: true, mode: 0o700 });
    writeFileSync(join(drop, id), JSON.stringify(signRecord({ kind: 'message', id, to: seat, to_id: null, from: 'fixture-sender', from_id: null, root, session, at: NOW, body, rule: 'synthetic admitted sender', thread: id }, home)) + '\n', { mode: 0o600 });
    return { root, file, dir, session, seat, pane, drop, id, body, cli };
  }
  function folder(name: string) { const path = join(base, name); mkdirSync(path); return path; }
  return { base, home, team, folder };
}
function change(t: Team, edit: (one: any) => void) {
  const path = join(t.dir, 'team.state.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  edit(data.sessions[t.session]);
  writeFileSync(path, JSON.stringify(data) + '\n');
}
function opts(t: Team, file = true): ServeOptions {
  return { seat: t.seat, session: t.session, epoch: EPOCH, ...(file ? { file: t.file } : {}) };
}
function tool(id: string, name: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}
function parented(from: string, actual: Team, cli = 'codex', bridge = false) {
  const io = testIo(from);
  const reads: (string | undefined)[] = [];
  const pids = bridge ? [{ pid: 8201, name: 'node' }, { pid: 8200, name: 'external-chat-bridge' }, { pid: 1, name: 'init' }] : [{ pid: 8103, name: 'node' }, { pid: 8102, name: cli === 'cursor' ? 'cursor-agent' : cli }, ...(cli === 'grok' ? [{ pid: 8105, name: 'fixture-lobby-wrapper-shell' }] : []), { pid: 8101, name: 'fixture-pane-shell' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }];
  io.env = { HERDR_PANE_ID: actual.pane, TEAM_SEAT: actual.seat, TEAM_SESSION: actual.session };
  io.callerSources = (asked): CallerSources => {
    reads.push(asked);
    return {
      ancestors: () => pids,
      agents: () => asked === actual.session ? [{ name: actual.seat, pane: actual.pane, agent: cli, workspace: 'owned-workspace', cwd: from, status: 'idle' }] : [],
      paneRootPid: pane => pane === actual.pane && asked === actual.session && !bridge ? 8101 : null,
      env: io.env,
      stdinIsTTY: false,
    };
  };
  return { io, reads };
}
type Request = string | (() => void);
async function serve(home: string, io: ReturnType<typeof testIo>, options: ServeOptions, requests: Request[]) {
  const replies: any[] = [];
  const code = await runMcpServe(options, io, {
    lines: (async function* () {
      for (const line of requests) {
        if (typeof line === 'function') line();
        else yield line;
      }
    })(),
    write: line => {
      const msg = JSON.parse(line); replies.push(msg);
    },
  }, { home, build: { version: '0.0.0-fixture', build: 'fixture', builtAt: 0, head: null }, restart: () => { throw new Error('unexpected install restart'); } });
  return { code, replies, err: io.err };
}
function readReceipt(t: Team, home: string) {
  const key = messageKeyState(home);
  expect(key.kind).toBe('key');
  if (key.kind !== 'key') throw new Error('synthetic key missing');
  const receipt = JSON.parse(readFileSync(receiptPath(t.drop, t.id), 'utf8')) as SignedReceipt;
  expect(verifyReceipt(receipt, key.key)).toBe(true);
  expect(receipt.payload).toMatchObject({ id: t.id, to: t.seat, status: 'read', root: t.root, session: t.session });
}
async function legitimate(w: ReturnType<typeof world>, t: Team, options: ServeOptions, placement: ReturnType<typeof parented>) {
  const out = await serve(w.home, placement.io, options, [tool('list', 'inbox_check'), () => {
    expect(JSON.parse(readFileSync(listenerPath(t.drop), 'utf8'))).toMatchObject({ root: t.root, session: t.session, seat: t.seat, cli: t.cli });
    expect(existsSync(receiptPath(t.drop, t.id))).toBe(false);
  }, tool('read', 'inbox_read', { id: t.id }), () => readReceipt(t, w.home)]);
  expect(out.code, out.err).toBe(0);
  expect(out.err).toBe('');
  expect(out.replies).toHaveLength(2);
  expect(out.replies.every(r => r.result?.isError !== true)).toBe(true);
  expect(JSON.stringify(out.replies[0])).toContain(t.id);
  expect(JSON.stringify(out.replies[1])).toContain(t.body);
  expect(existsSync(listenerPath(t.drop))).toBe(false);
  readReceipt(t, w.home);
}

for (const withFile of [false, true]) {
  for (const target of ['current', 'old epoch', 'runtime removed', 'declared stopped'] as const) {
    test(`another team's arguments refuse ${target}, file=${withFile}, without touching its inbox`, async () => {
      const w = world(), a = w.team('alpha'), b = w.team('beta');
      if (target === 'runtime removed') change(b, s => { delete s.seats[b.seat]; });
      if (target === 'declared stopped') writeFileSync(b.file, readFileSync(b.file, 'utf8').replace('    role: worker', '    role: worker\n    stopped: true'));
      expect(readTeamConfig(b.root, { home: w.home }).ok).toBe(true);
      const options = { ...opts(b, withFile), ...(target === 'old epoch' ? { epoch: OLD } : {}) };
      const before = readdirSync(b.drop).sort(), bytes = readFileSync(join(b.drop, b.id));
      const placement = parented(a.root, a);
      // Even persuasive environment hints naming B cannot replace the process ancestry of A.
      placement.io.env = { HERDR_PANE_ID: b.pane, TEAM_SEAT: b.seat, TEAM_SESSION: b.session };
      const out = await serve(w.home, placement.io, options, [tool('read', 'inbox_read', { id: b.id })]);
      expect({ code: out.code, replies: out.replies.length, receipted: existsSync(receiptPath(b.drop, b.id)), leaked: JSON.stringify(out.replies).includes(b.body) }).toEqual({ code: 2, replies: 0, receipted: false, leaked: false });
      expect(readdirSync(b.drop).sort()).toEqual(before);
      expect(readFileSync(join(b.drop, b.id))).toEqual(bytes);
      expect(out.err + JSON.stringify(out.replies)).not.toContain(b.body);
      expect(existsSync(receiptPath(a.drop, a.id))).toBe(false);
    });
  }
}
for (const withFile of [false, true]) test(`an own placed child with an obsolete epoch refuses, file=${withFile}`, async () => {
  const w = world(), t = w.team('alpha'), p = parented(t.root, t);
  const out = await serve(w.home, p.io, { ...opts(t, withFile), epoch: OLD }, [tool('read', 'inbox_read', { id: t.id })]);
  expect(out.code).toBe(2);
  expect(out.replies).toEqual([]);
  expect(existsSync(receiptPath(t.drop, t.id))).toBe(false);
  expect(out.err).not.toContain(t.body);
});
for (const changed of ['epoch', 'runtime removed', 'pane'] as const) test(`a live server re-proves ${changed} before the next read`, async () => {
  const w = world(), t = w.team('alpha'), p = parented(t.root, t);
  const out = await serve(w.home, p.io, opts(t), [tool('before', 'inbox_check'), () => {
    change(t, s => { if (changed === 'epoch') s.briefs[t.seat].epoch = OLD; else if (changed === 'runtime removed') delete s.seats[t.seat]; else s.seats[t.seat].pane = 'replacement-pane'; });
  }, tool('after', 'inbox_read', { id: t.id })]);
  expect(out.code).toBe(0);
  expect(out.replies[0]?.result?.isError).not.toBe(true);
  expect(out.replies[1]?.result?.isError).toBe(true);
  expect(JSON.stringify(out.replies[1])).not.toContain(t.body);
  expect(existsSync(receiptPath(t.drop, t.id))).toBe(false);
});

for (const withFile of [false, true]) test(`a generated Codex launch-line child serves its own inbox, file=${withFile}`, async () => {
  const w = world(), t = w.team('alpha');
  const profile = profileFor('codex')!;
  const recorder = join(w.base, 'record-argv.py'), recorded = join(w.base, 'argv.json');
  writeFileSync(recorder, 'import json,sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(json.dumps(sys.argv[2:]))\n');
  const line = launchCommand(profile, 'codex', join(w.base, 'rules.md'), undefined, { command: 'synthetic-runner', entry: 'synthetic-entry', seat: t.seat, session: t.session, epoch: EPOCH, ...(withFile ? { file: t.file } : {}) });
  const code = `codex() { /usr/bin/python3 ${shellQuote(recorder)} ${shellQuote(recorded)} "$@"; }\n${line}`;
  execFileSync('/bin/sh', ['-c', code], { cwd: t.root, env: { ...gitEnv(), HOME: process.env.HOME } });
  const argv = JSON.parse(readFileSync(recorded, 'utf8')) as string[];
  const encoded = argv.find(x => x.startsWith('mcp_servers.team_inbox.args='));
  expect(encoded).toBeDefined();
  const args = JSON.parse(encoded!.slice(encoded!.indexOf('=') + 1)) as string[];
  expect(args.slice(0, 3)).toEqual(['synthetic-entry', 'mcp', 'serve']);
  const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  await legitimate(w, t, { seat: flag('--seat'), session: flag('--session'), file: flag('--file'), epoch: flag('--epoch') }, parented(t.root, t));
});
for (const withFile of [false, true]) test(`Cursor's actual written project config starts a serving child, file=${withFile}`, async () => {
  const w = world(), t = w.team('alpha', 'cursor'), project = w.folder('seat-project');
  expect(registerInbox({ cli: 'cursor', seat: t.seat, cwd: project, session: t.session, home: w.home, ...(withFile ? { file: t.file } : {}), run: () => { throw new Error('no real CLI may be called'); } })).toEqual({ ok: true });
  const args = JSON.parse(readFileSync(join(project, '.cursor', 'mcp.json'), 'utf8')).mcpServers['team-inbox'].args as string[];
  expect(args.slice(1, 3)).toEqual(['mcp', 'serve']);
  const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  await legitimate(w, t, { seat: flag('--seat'), session: flag('--session'), file: flag('--file'), epoch: flag('--epoch') }, parented(project, t, 'cursor'));
});
test('a pane-backed lobby child needs no team file in its starting folder', async () => {
  const w = world(), t = w.team('alpha'), lobby = w.folder('lobby');
  await legitimate(w, t, opts(t, false), parented(lobby, t));
  expect(existsSync(join(lobby, '.agents'))).toBe(false);
});
for (const withFile of [false, true]) test(`a pane-less external bridge cannot claim a serving seat, file=${withFile}`, async () => {
  const w = world(), t = w.team('alpha', 'claude-code'), lobby = w.folder('external-lobby');
  // The corrected brief says the bridge never starts serve; arguments and a roster do not place it.
  change(t, s => { delete s.seats[t.seat].pane; s.seats[t.seat].start_cwd = lobby; });
  const p = parented(lobby, t, 'node', true);
  const out = await serve(w.home, p.io, opts(t, withFile), [tool('read', 'inbox_read', { id: t.id })]);
  expect({ code: out.code, replies: out.replies.length, receipted: existsSync(receiptPath(t.drop, t.id)), leaked: JSON.stringify(out.replies).includes(t.body) }).toEqual({ code: 2, replies: 0, receipted: false, leaked: false });
  expect(existsSync(join(lobby, '.agents'))).toBe(false);
});

for (const withFile of [false, true]) test(`Grok's lobby file route serves through its wrapper and pane, file=${withFile}`, async () => {
  const w = world(), t = w.team('alpha', 'grok'), lobby = w.folder('grok-lobby');
  change(t, one => { one.seats[t.seat].start_cwd = lobby; });
  // Fake the CLI's file writer, using the argv the actual registration passed it.
  const runs: { command: string; args: readonly string[]; cwd: string }[] = [];
  expect(registerInbox({ cli: 'grok', seat: t.seat, cwd: lobby, session: t.session, home: w.home, ...(withFile ? { file: t.file } : {}), run: (command, args, cwd) => {
    runs.push({ command, args, cwd });
    const split = args.indexOf('--');
    expect(split).toBeGreaterThan(0);
    mkdirSync(join(cwd, '.grok'));
    writeFileSync(join(cwd, '.grok', 'config.toml'), `[mcp_servers.team-inbox]\ncommand = ${JSON.stringify(args[split - 1])}\nargs = ${JSON.stringify(args.slice(split + 1))}\n`);
    return { code: 0 };
  } })).toEqual({ ok: true });
  expect(runs).toHaveLength(1);
  expect(runs[0]!.command).toBe('grok');
  expect(runs[0]!.cwd).toBe(lobby);
  const config = readFileSync(join(lobby, '.grok', 'config.toml'), 'utf8');
  const args = JSON.parse(config.match(/^args = (.+)$/m)![1]!) as string[];
  expect(args.slice(1, 3)).toEqual(['mcp', 'serve']);
  const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const placement = parented(lobby, t, 'grok');
  await legitimate(w, t, { seat: flag('--seat'), session: flag('--session'), file: flag('--file'), epoch: flag('--epoch') }, placement);
  expect(existsSync(join(lobby, '.agents'))).toBe(false);
});

function markStopped(t: Team, home: string) {
  writeFileSync(t.file, readFileSync(t.file, 'utf8').replace('    role: worker', '    role: worker\n    stopped: true'));
  const loaded = readTeamConfig(t.root, { home });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error('stopped worker fixture must remain valid');
  expect(loaded.team.seats.find(seat => seat.name === t.seat)?.stopped).toBe(true);
}
test('an own stopped seat with retained pane and current claim refuses before serving', async () => {
  const w = world(), t = w.team('alpha'), p = parented(t.root, t);
  const state = readFileSync(join(t.dir, 'team.state.json'));
  markStopped(t, w.home);
  const out = await serve(w.home, p.io, opts(t), [tool('read', 'inbox_read', { id: t.id })]);
  expect(readFileSync(join(t.dir, 'team.state.json'))).toEqual(state);
  expect({ code: out.code, replies: out.replies.length, receipted: existsSync(receiptPath(t.drop, t.id)), leaked: JSON.stringify(out.replies).includes(t.body) }).toEqual({ code: 2, replies: 0, receipted: false, leaked: false });
});
test('marking its own seat stopped between check and read revokes a live server despite retained pane and claim', async () => {
  const w = world(), t = w.team('alpha'), p = parented(t.root, t);
  const state = readFileSync(join(t.dir, 'team.state.json'));
  const out = await serve(w.home, p.io, opts(t, false), [tool('before', 'inbox_check'), () => {
    markStopped(t, w.home);
    expect(readFileSync(join(t.dir, 'team.state.json'))).toEqual(state);
  }, tool('after', 'inbox_read', { id: t.id })]);
  expect(out.code).toBe(0);
  expect(out.replies[0]?.result?.isError).not.toBe(true);
  expect(JSON.stringify(out.replies[0])).toContain(t.id);
  expect(readFileSync(join(t.dir, 'team.state.json'))).toEqual(state);
  expect({ isError: out.replies[1]?.result?.isError === true, receipted: existsSync(receiptPath(t.drop, t.id)), leaked: JSON.stringify(out.replies[1]).includes(t.body) }).toEqual({ isError: true, receipted: false, leaked: false });
});

for (const code of [0, 7, null]) test(`a restart keeps its parent until the fake child exits and then reports ${String(code)}`, () => {
  const child = new EventEmitter() as ChildProcess;
  const exits: number[] = [], said: string[] = [];
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  restartSelf({ spawnChild: (() => child) as never, exit: result => { exits.push(result); }, say: line => { said.push(line); } });
  expect(exits).toEqual([]);
  child.emit('spawn');
  expect(exits).toEqual([]); expect(unrefs).toBe(0);
  child.emit('exit', code, code === null ? 'SIGTERM' : null);
  expect(exits).toEqual([code ?? 1]); expect(said).toEqual([]);
});
