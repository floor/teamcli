// Synthetic registry, signed drops, and launch hosts; no agent executable is run.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runReload } from '../src/commands/reload.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { registerInbox, selfRunner } from '../src/mcp/register.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { profileFor, launchCommand } from '../src/profiles/profile.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { enqueueSwap, swapModelOf } from '../src/swap/queue.ts';
import { runOneSwap } from '../src/swap/run.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';
import { assertIndependentHome } from './independent-home-fixture.ts';

const NOW = new Date('2026-11-01T19:20:00.000Z');
const made: string[] = [];
const route = { cursor: ['.cursor', 'mcp.json'], gemini: ['.gemini', 'settings.json'], grok: ['.grok', 'config.toml'] } as const;
type Route = keyof typeof route;
function folder(path: string): void { const mask = process.umask(0); try { mkdirSync(path, { recursive: true, mode: 0o700 }); } finally { process.umask(mask); } }
function temp(): string { const base = realpathSync(mkdtempSync(join(tmpdir(), 'inbox-independent-'))); made.push(base); return base; }
afterEach(() => { for (const base of made.splice(0)) discardFixtures([base]); });
test('the suite starts with its own empty synthetic HOME', assertIndependentHome);

function text(session: string, cli = 'cursor', root = '', lobby = ''): string {
  const spec = cli === 'claude-code' ? ['anthropic', 'Claude Opus', '5.5', 'claude --model claude-opus-5-5'] : ['xai', 'Grok', '4.7', cli === 'cursor' ? 'cursor-agent' : cli];
  return `format: 1\nproject: inbox-fixture\ncoordinator: lead\noperator: lead\nsession: ${session}\nworkspace:\n  mode: shared\n${root ? `trust:\n  - ${root}\n  - ${lobby}\n  - ${join(process.env.HOME!, ".config", "team", "lobby")}\n` : ''}seats:\n  - name: lead\n    role: coordinator\n    human: true\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n  - name: worker\n    role: worker\n    cli: ${cli}\n    vendor: ${spec[0]}\n    model: ${spec[1]}\n    version: "${spec[2]}"\n    launch: ${spec[3]}\n`;
}
function world(cli = 'cursor', registry = true, session = 'north', sharedHome?: string) {
  const base = temp(), home = sharedHome ?? join(base, 'home'), root = join(base, 'checkout'), dir = join(root, '.agents'), lobby = join(home, '.config', 'team', 'lobby');
  folder(dir); folder(lobby); folder(join(process.env.HOME!, ".config", "team", "lobby"));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const path = join(dir, 'team.yaml'), yaml = text(session, cli, root, lobby);
  writeFileSync(path, yaml);
  // The state `team up` leaves: the server proves its caller stands on its seat's recorded pane.
  const seats = Object.fromEntries(['lead', 'worker'].map((name) => [name, { stage: 'ready', pane: `pane-${name}` }]));
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [session]: { seats, worktrees: {} } } })}\n`);
  const loaded = readTeamConfig(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, root, home), { approval: approvalOf(loaded.team, root, NOW), file: yaml }, loaded.team.seats, home);
  if (registry) {
    intoRegistry(root, home);
    discardFixtures([path]);
    upsertTeam(home, teamIdOf(root), { project: loaded.team.project, session, root, roster: [{ agent: 'agt_111111111111', seat: 'worker', role: 'worker' }] });
  }
  return { base, home, root, dir, lobby, path, yaml, team: loaded.team, session };
}
type World = ReturnType<typeof world>;
function messageId(label: string): string { const h = createHash('sha256').update(label).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; }
function signedDrop(w: World, label: string): void {
  const id = messageId(label);
  const dir = join(w.dir, 'send-drops', w.session, 'worker'); folder(dir);
  const record = signRecord({ kind: 'message', id, to: 'worker', to_id: null, root: w.root, session: w.session, at: NOW.toISOString(), body: `payload-${id}`, from: 'lead', from_id: null, rule: 'the owner', thread: id }, w.home);
  writeFileSync(join(dir, id), JSON.stringify(record) + '\n', { mode: 0o600 });
}
async function unread(w: World, args: readonly string[]) {
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const seat = value('--seat');
  const session = value('--session') ?? w.session;
  // The pane this launch's seat stands on is the one the state records now: `up` and the swap
  // path both write it before the launch line is started.
  const recorded = seat === undefined ? undefined : readState(w.dir).sessions[session]?.seats[seat]?.pane;
  const io = testIo(w.lobby, seat === undefined ? undefined : { kind: 'seat', name: seat, pane: recorded ?? `pane-${seat}`, session }), replies: string[] = [];
  const code = await runMcpServe({ seat: value('--seat'), session: value('--session'), ...(value('--file') === undefined ? {} : { file: value('--file') }), ...(value('--epoch') === undefined ? {} : { epoch: value('--epoch') }) }, io,
    { lines: (async function* () { yield JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'inbox_check', arguments: {} } }); })(), write: line => { replies.push(line); } }, { home: w.home });
  expect(code, io.err).toBe(0);
  const response = JSON.parse(replies[0]!);
  expect(response.error).toBeUndefined();
  return JSON.parse(response.result.content[0].text).unread.map((v: { id: string }) => v.id) as string[];
}
function registrar(w: World, cli: Route) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const run = (command: string, args: readonly string[], cwd: string) => {
    calls.push({ command, args: [...args], cwd });
    const target = join(cwd, ...route[cli]); folder(dirname(target));
    const argv = args.slice(args.indexOf('--') + 1);
    writeFileSync(target, cli === 'grok' ? '[mcp_servers.team-inbox]\n' : JSON.stringify({ mcpServers: { 'team-inbox': { command: selfRunner().command, args: argv } } }) + '\n');
    return { code: 0 };
  };
  const register = (options: { seat?: string; session?: string; file?: string } = {}) => registerInbox({ cli, seat: options.seat ?? 'worker', cwd: w.lobby, ...{ home: w.home, session: options.session ?? w.session }, ...(options.file === undefined ? {} : { file: options.file }), run });
  const args = () => cli === 'cursor' ? JSON.parse(readFileSync(join(w.lobby, ...route[cli]), 'utf8')).mcpServers['team-inbox'].args as string[] : calls.at(-1)!.args.slice(calls.at(-1)!.args.indexOf('--') + 1);
  return { calls, register, args };
}
for (const cli of Object.keys(route) as Route[]) test(`${cli}: registry lookup registers the actual inbox from a folder without a team file`, async () => underRegistry(async () => {
  const w = world(cli), reg = registrar(w, cli);
  expect(existsSync(w.path)).toBe(false); expect(existsSync(join(w.lobby, '.agents', 'team.yaml'))).toBe(false);
  expect(readTeamConfig(w.root, { home: w.home }).ok).toBe(true);
  expect(reg.register()).toEqual({ ok: true });
  const args = reg.args(); expect(args).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', 'worker', '--session', w.session]);
  expect(args).not.toContain('--file');
  if (cli !== 'cursor') expect(reg.calls[0]).toEqual({ command: cli, cwd: w.lobby, args: ['mcp', 'add', '-s', 'project', 'team-inbox', selfRunner().command, '--', ...args] });
  const before = readFileSync(join(w.lobby, ...route[cli]));
  expect(reg.register()).toEqual({ ok: true }); expect(readFileSync(join(w.lobby, ...route[cli]))).toEqual(before);
  signedDrop(w, 'target-message'); expect(await unread(w, args)).toEqual([messageId('target-message')]);
}));

test('the session selects between two registries holding the same seat name', async () => underRegistry(async () => {
  const north = world('cursor'), south = world('cursor', true, 'south', north.home);
  signedDrop(north, 'north-message'); signedDrop(south, 'south-message');
  for (const w of [north, south]) { const reg = registrar(w, 'cursor'); expect(reg.register()).toEqual({ ok: true }); expect(await unread(w, reg.args())).toEqual([messageId(`${w.session}-message`)]); }
}));
for (const refusal of ['wrong-session', 'undeclared-seat'] as const) test(`registration refuses ${refusal} before changing any CLI configuration`, async () => underRegistry(async () => {
  const w = world(), reg = registrar(w, 'cursor');
  if (refusal === 'undeclared-seat') upsertTeam(w.home, teamIdOf(w.root), { project: w.team.project, session: w.session, root: w.root, roster: [{ agent: 'agt_222222222222', seat: 'ghost', role: 'worker' }] });
  const target = join(w.lobby, ...route.cursor); folder(dirname(target)); const old = '{"keep":{"value":19}}\n'; writeFileSync(target, old);
  const answer = reg.register(refusal === 'wrong-session' ? { session: 'absent-session' } : { seat: 'ghost' });
  expect(answer?.ok).toBe(false);
  expect(answer && !answer.ok ? answer.reason : '').toContain(refusal === 'wrong-session' ? 'session' : 'declares no seat');
  expect(readFileSync(target, 'utf8')).toBe(old); expect(reg.calls).toEqual([]);
}));

function planHost(register: NonNullable<Host['registerInbox']>) {
  const events: string[] = [], logs: string[] = [];
  const host: Host = { startServer: () => true, sessionUp: () => true, createWorkspace: () => ({ pane: 'fixture-pane', workspace: 'fixture-workspace' }), paneRun: () => { events.push('launch'); return true; }, registerInbox: register, typeLine: () => false, renameAgent: () => true, closeWorkspace: () => true, stopSession: () => true, kill: () => { throw new Error('no signals'); }, agentPanes: () => [], classify: () => 'idle', sleep: async () => {}, now: () => 0, allow: () => null, record: () => { events.push('record'); }, running: () => { events.push('running'); }, drop: () => { events.push('drop'); }, say: line => { logs.push(line); }, log: (_who, line) => { logs.push(line); } };
  return { host, events, logs };
}
function steps(cwd: string): Step[] { return [{ kind: 'run', argv: [], do: { do: 'launch', seat: 'worker', label: 'worker', pane: 'fixture-pane', cli: 'cursor', cwd, command: 'owned-inert-command' } }, { kind: 'skip', text: 'ready', do: { do: 'record', seat: 'worker', record: { kind: 'ready' } } }]; }
for (const recovers of [false, true]) test(`registration retries once and ${recovers ? 'then launches' : 'leaves the seat out loudly'}`, async () => {
  const calls: unknown[][] = [];
  const w = world();
  const scene = planHost((...args) => { calls.push(args); return recovers && calls.length === 2 ? { ok: true } : { ok: false, reason: 'fixture registration refused' }; });
  const report = await executePlan(steps(w.lobby), w.session, scene.host);
  expect(calls).toEqual(Array.from({ length: 2 }, () => ['cursor', 'worker', w.lobby, w.session, undefined]));
  if (recovers) { expect(scene.events).toContain('launch'); expect(report.dropped).toEqual([]); }
  else { expect(scene.events).not.toContain('launch'); expect(scene.events).not.toContain('record'); expect(scene.events).not.toContain('running'); expect(report.dropped).toContain('worker'); expect(scene.logs.join('\n')).toContain('fixture registration refused'); expect(scene.logs.join('\n')).toContain('left out'); }
});

function codexArgs(file?: string): string[] {
  const profile = profileFor('codex')!;
  const line = launchCommand(profile, 'codex --model fixture-model', 'Fixture rules.', undefined, { seat: 'worker', session: 'north', ...selfRunner(), ...(file === undefined ? {} : { file }) });
  // A shell function records the line's words: no executable named codex is invoked.
  const raw = execFileSync('/bin/sh', ['-c', `codex() { printf '%s\\0' "$@"; }; ${line}`], { env: process.env });
  const words = raw.toString().split('\0');
  const config = words.find(word => word.startsWith('mcp_servers.team_inbox.args='));
  expect(config).toBeDefined();
  return JSON.parse(config!.slice(config!.indexOf('=') + 1));
}
test('the registry Codex launch line names its session and serves only that team', async () => underRegistry(async () => {
  const w = world('codex'), other = world('codex', true, 'south', w.home); signedDrop(w, 'codex-north'); signedDrop(other, 'codex-south');
  const args = codexArgs(); expect(args).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', 'worker', '--session', w.session]); expect(await unread(w, args)).toEqual([messageId('codex-north')]);
}));
for (const cli of Object.keys(route) as Route[]) test(`${cli}: named-file registration retains the exact old argv and unrelated configuration`, async () => {
  const w = world(cli, false), reg = registrar(w, cli);
  if (cli === 'cursor') { const target = join(w.lobby, ...route[cli]); folder(dirname(target)); writeFileSync(target, '{"other":17,"mcpServers":{"existing":{"command":"inert","args":["literal"]}}}\n'); }
  expect(reg.register({ file: w.path })).toEqual({ ok: true });
  expect(reg.args()).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', 'worker', '--session', w.session, '--file', w.path]);
  if (cli !== 'cursor') expect(reg.calls[0]?.args).toEqual(['mcp', 'add', '-s', 'project', 'team-inbox', selfRunner().command, '--', ...reg.args()]);
  else { const config = JSON.parse(readFileSync(join(w.lobby, ...route[cli]), 'utf8')); expect(config.other).toBe(17); expect(config.mcpServers.existing).toEqual({ command: 'inert', args: ['literal'] }); }
  signedDrop(w, 'file-message'); expect(await unread(w, reg.args())).toEqual([messageId('file-message')]);
});
test('the named-file Codex launch retains the exact old argument bytes', () => {
  const w = world('codex', false); expect(codexArgs(w.path)).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', 'worker', '--file', w.path]);
});

function remember(w: World, cli = 'cursor'): void {
  const seat = w.team.seats.find(s => s.name === 'worker')!;
  updateState(w.dir, state => { const session = state.sessions[w.session] ??= emptySession(); session.seats.worker = { stage: 'ready', pane: 'old-pane', workspace: 'old-workspace', cli, start_cwd: w.lobby, launched: { shell: 501, cli: [502] }, model: seat.model, version: seat.version, launch_line: seat.launch }; });
}
function live(w: World) { return [{ name: 'worker', agent: w.team.seats.find(s => s.name === 'worker')!.cli, pane: 'old-pane', workspace: 'old-workspace', status: 'idle', cwd: w.lobby }]; }
function launchFixture(w: World) {
  const registrations: unknown[][] = [], runs: string[] = [], closes: string[] = [];
  const launch: Launch = { sessionState: () => 'running', startServer: () => true, sessionUp: () => true, createWorkspace: () => ({ pane: 'new-pane', workspace: 'new-workspace' }), paneRun: (_s, _p, line) => { runs.push(line); return true; }, registerInbox: (...args) => { registrations.push(args); return { ok: true }; }, renameAgent: () => true, closeWorkspace: (_s, workspace) => { closes.push(workspace); return true; }, agentPanes: () => ['old-pane'], agents: () => live(w), paneText: () => CLAUDE_IDLE, foreground: () => ['claude'], processInfo: () => ({ shell: 501, foreground: [502] }), sleep: async () => {}, now: () => NOW };
  return { launch, registrations, runs, closes };
}
for (const registry of [true, false]) test(`${registry ? 'registry' : 'file'} reload no-op re-registers without closing or relaunching`, async () => underRegistry(async () => {
  const w = world('grok', registry); remember(w, 'grok'); const f = launchFixture(w), io = testIo(w.root, { kind: 'owner' });
  f.launch.foreground = () => ['grok']; f.launch.paneText = () => GROK_IDLE;
  const reg = registrar(w, 'grok');
  f.launch.registerInbox = (cli, seat, cwd, fourth?: string, fifth?: string) => { f.registrations.push([cli, seat, cwd, fourth, fifth]); return reg.register({ ...(fifth === undefined ? {} : { file: fifth }), session: fourth }); };
  const code = await runReload(['worker'], io, { launch: f.launch, home: w.home, now: () => NOW });
  expect(code, io.err + io.out).toBe(0); expect(io.out).toContain('already running');
  expect(f.registrations).toEqual([['grok', 'worker', w.lobby, w.session, registry ? undefined : w.path]]); expect(existsSync(join(w.lobby, ...route.grok))).toBe(true); expect(f.runs).toEqual([]); expect(f.closes).toEqual([]);
}));

test('check names a running seat whose project registration is missing, and clears after registration', async () => underRegistry(async () => {
  const w = world(); remember(w);
  const sources = { home: w.home, standing: () => approvalStanding(w.root, w.home), branch: () => 'main', now: () => NOW, alive: () => true, sockets: join(w.base, 'no-sockets'), live: () => ({ running: true, agents: live(w), workspaces: [{ id: 'old-workspace', label: 'worker' }], screens: {} }) };
  const missing = testIo(w.root, { kind: 'owner' }); runTeamCheck({}, missing, sources);
  expect(missing.out + missing.err).toContain('team reload worker'); expect(missing.out + missing.err).toContain('~/.config/team/lobby/.cursor/mcp.json holds none: sends wait');
  expect(registrar(w, 'cursor').register()).toEqual({ ok: true });
  const repaired = testIo(w.root, { kind: 'owner' }); runTeamCheck({}, repaired, sources); expect(repaired.out + repaired.err).not.toContain('holds none: sends wait');
}));

const GROK_IDLE = readFileSync(new URL('./fixtures/grok/1.0.52/idle.txt', import.meta.url), 'utf8');
const machine = () => ({ loadPerCore: 0.1, memoryFree: 80, diskFree: 1024 ** 4, swapTotal: 1024 ** 3, swapFree: 1024 ** 3, swapUsed: 0, pressure: 'normal' as const });
function doctor(w: World) { return { home: w.home, version: (binary: string) => binary === 'grok' ? '1.0.52' : '2.1.302', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => true, now: () => NOW, machine }; }

test('real registry up passes no invented team-file path to its registration', async () => underRegistry(async () => {
  const w = world('grok'), reg = registrar(w, 'grok'), f = launchFixture(w); let started = false, clock = NOW.getTime();
  f.launch.agents = () => started ? [{ name: 'worker', agent: 'grok', pane: 'new-pane', workspace: 'new-workspace', status: 'idle', cwd: w.lobby }] : [];
  f.launch.agentPanes = () => started ? ['new-pane'] : [];
  f.launch.createWorkspace = (_s, _cwd, label) => label.toLowerCase().includes('watch') ? { pane: 'watch-pane', workspace: 'watch-workspace' } : { pane: 'new-pane', workspace: 'new-workspace' };
  f.launch.paneRun = (_s, pane, line) => { if (pane === 'new-pane') { f.runs.push(line); started = true; } return true; };
  f.launch.foreground = () => ['grok']; f.launch.paneText = () => GROK_IDLE; f.launch.agentStatus = () => 'idle';
  f.launch.now = () => new Date(clock); f.launch.sleep = async ms => { clock += ms; };
  f.launch.registerInbox = (cli, seat, cwd, fourth?: string, fifth?: string) => { f.registrations.push([cli, seat, cwd, fourth, fifth]); return registerInbox({ cli, seat, cwd, ...{ home: w.home, session: fourth }, ...(fifth === undefined ? {} : { file: fifth }), run: (command, args, at) => { reg.calls.push({ command, args: [...args], cwd: at }); const target = join(at, ...route.grok); folder(dirname(target)); writeFileSync(target, '[mcp_servers.team-inbox]\n'); return { code: 0 }; } }); };
  const sources: UpSources = { home: w.home, sessionRunning: () => true, sessionState: () => 'running', agents: () => f.launch.agents(w.session), doctor: doctor(w), machine, alive: () => false, now: () => new Date(clock), sleep: async ms => { clock += ms; }, launch: f.launch };
  const io = testIo(w.root, { kind: 'owner' }); const code = await runUp([], io, sources);
  expect(code, io.err + io.out).toBe(0); expect(f.registrations).toEqual([['grok', 'worker', w.lobby, w.session, undefined]]); expect(f.runs).toHaveLength(1); expect(readState(w.dir).sessions[w.session]?.seats.worker?.stage).toBe('ready');
  signedDrop(w, 'up-message'); const add = reg.calls[0]!.args; expect(await unread(w, add.slice(add.indexOf('--') + 1))).toContain(messageId('up-message'));
}));

test('a file-team queued swap passes the same named file through the shared restart sequence', async () => {
  const w = world('claude-code', false); remember(w, 'claude-code'); const f = launchFixture(w);
  let old = true, started = false, named = false, shell = false, boxed = CLAUDE_IDLE, clock = NOW.getTime();
  const agents = () => [...(old ? live(w) : []), ...(started ? [{ name: named ? 'worker' : '', agent: 'grok', pane: 'new-pane', workspace: 'new-workspace', status: 'idle', cwd: w.lobby }] : [])];
  const sleep = async (ms: number) => { clock += ms; };
  f.launch.agents = agents; f.launch.agentPanes = () => agents().map(a => a.pane);
  f.launch.paneRun = (_s, _p, line) => { f.runs.push(line); started = true; return true; };
  f.launch.renameAgent = () => { named = true; return true; };
  f.launch.foreground = (_s, pane) => [pane === 'old-pane' ? (shell ? 'sh' : 'claude') : 'grok'];
  f.launch.paneText = (_s, pane) => pane === 'old-pane' ? boxed : GROK_IDLE;
  f.launch.processInfo = (_s, pane) => pane === 'old-pane' ? { shell: 501, foreground: shell ? [501] : [502] } : { shell: 503, foreground: [504] };
  f.launch.agentStatus = () => 'idle'; f.launch.sleep = sleep; f.launch.now = () => new Date(clock);
  const sources: RestartSources = { home: w.home, sessionRunning: () => true, sessionState: () => 'running', agents, workspaces: () => agents().map(a => ({ id: a.workspace })), alive: () => true, screen: () => ({ kind: 'idle' }), screenText: () => boxed, foreground: () => [shell ? 'sh' : 'claude'], status: () => 'idle', now: () => new Date(clock), sleep, doctor: doctor(w), upLaunch: f.launch,
    launch: { typeText: (_s, _p, line) => { boxed = claudeBox(line); return true; }, sendKey: () => true, pressEnter: () => { shell = true; return true; }, agentPanes: () => agents().map(a => a.pane), closeWorkspace: (_s, workspace) => { f.closes.push(workspace); old = false; return true; }, stopSession: () => true, deleteSession: () => true, kill: () => { throw new Error('no signals'); }, now: () => new Date(clock), sleep } };
  const from = swapModelOf(w.team.seats.find(s => s.name === 'worker')!);
  const swap = enqueueSwap(w.dir, { seat: 'worker', from, to: { cli: 'grok', vendor: 'xai', model: 'Grok', version: '4.7', display: 'Grok 4.7', launch: 'grok' }, reason: 'owner', waitSeconds: 0, waitFor: 'a boundary', now: NOW });
  const io = testIo(w.root, { kind: 'owner' });
  const result = await runOneSwap({ dir: w.dir, root: w.root, home: w.home, path: w.path, team: w.team, session: w.session, io, json: false, notes: [], sources, by: 'owner', owner: true, now: () => new Date(clock) }, 'worker', swap);
  expect(result, io.err + io.out).toMatchObject({ kind: 'ready', seat: 'worker' }); expect(f.closes).toEqual(['old-workspace']); expect(f.runs).toHaveLength(1);
  // Both the old four-word seam and new five-word seam carry identical binding bytes.
  const binding = f.registrations.map(call => call.length === 4 ? call[3] : call[4]); expect(binding).toEqual([w.path]);
  expect(readState(w.dir).sessions[w.session]?.seats.worker?.cli).toBe('grok'); expect(readState(w.dir).swaps?.worker).toBeUndefined();
});
