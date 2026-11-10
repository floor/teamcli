// Synthetic homes, starting folders and terminal-host readings only; no live agent CLI.
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { afterEach, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync, linkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runMcp, realSources as mcpSources } from '../src/commands/mcp.ts';
import type { RegisterSources } from '../src/commands/register.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { placementAtStart } from '../src/mcp/serve.ts';
import type { Io } from '../src/io.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { selfRunner } from '../src/mcp/register.ts';
import { channelLaunchEnabled } from '../src/mcp/channel.ts';
import { cliWordListOf } from '../src/launch/cli-scope.ts';
import { MCP_SETUP_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { currentBriefClaim } from '../src/launch/general-brief.ts';
import { forgetTeam, getTeam, upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { installKey } from '../src/store/keys.ts';
import { CLAUDE_IDLE, fixtureBase, testIo } from './helpers.ts';

const SESSION = 'setup-scene';
const PANE = 'fixture-pane';
const NOW = new Date('2026-11-07T12:00:00Z');
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const made: string[] = [];
afterEach(() => { setHerdrRun(null); for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true }); });
function world(inLobby = false) {
  const base = fixtureBase('mcp-setup-'); made.push(base);
  const home = join(base, 'home'); const root = join(base, 'project'); const lobby = join(root, 'lobby'); const cwd = inLobby ? join(lobby, 'alpha') : join(root, 'start');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(join(root, '.agents'), { recursive: true }); if (inLobby) mkdirSync(lobby, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  if (!inLobby) execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const file = join(root, '.agents/team.yaml');
  writeFileSync(file, `format: 1
project: sample
session: ${SESSION}
coordinator: alpha
operator: alpha
${inLobby ? `lobby: ${lobby}\ntrust:\n  - ${root}\n  - ${lobby}\n` : ''}workspace:
  mode: shared
seats:
  - name: alpha
    role: coordinator
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: claude --model fixture
    # Pair equivalence uses this lead's explicitly declared owned start.
${inLobby ? `    cwd: ${relative(root, cwd)}\n` : ''}`);
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/key.json'), 'utf8')));
  upsertTeam(home, teamIdOf(root), { root, project: 'sample', session: SESSION, ...(inLobby ? { lobby } : {}), roster: [{ agent: 'agt_000000000001', seat: 'alpha', role: 'coordinator' }] });
  setHerdrRun(() => { throw new Error('a synthetic test must not reach a live terminal host'); });
  const register: RegisterSources = {
    home, sessionState: () => 'running', agents: () => [],
    processInfo: () => ({ shell: 7001, foreground: [7002] }), foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE, now: () => NOW, renameAgent: () => true,
    renameWorkspace: () => true, reportDisplayAgent: () => true,
    refreshAddress: () => ({ address: null }),
  };
  const sources = { ...mcpSources, home: () => home, setup: { register, config: { home, env: {}, now: () => NOW } } };
  return { base, home, root, cwd, file, sources };
}
function snapshot(base: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(dir: string) { for (const name of readdirSync(dir)) { if (name === '.git') continue; const p = join(dir, name); const s = lstatSync(p); entries[relative(base, p)] = s.isSymbolicLink() ? `link:${readlinkSync(p)}` : s.isDirectory() ? 'directory' : readFileSync(p).toString('base64'); if (s.isDirectory()) visit(p); } }
  visit(base); return entries;
}
async function setup(w: ReturnType<typeof world>, args: string[] = [], caller: Io['caller'] = { kind: 'owner' }) {
  const io = testIo(w.cwd, caller); io.env.HERDR_PANE_ID = PANE;
  const code = await runMcp(['setup', 'alpha', ...args], io, w.sources);
  return { code, out: io.out, err: io.err };
}
test('setup dry-run prints all three changes without writing any fixture path', async () => {
  const w = world(); const before = snapshot(w.base);
  const r = await setup(w, ['--dry-run', '--json']);
  expect(r).toMatchObject({ code: 0 });
  expect(JSON.parse(r.out).changes).toHaveLength(3);
  expect(snapshot(w.base)).toEqual(before);
});
test('setup uses this runner, scopes the server and records the calling pane without a launch', async () => {
  const w = world(); const r = await setup(w, ['--json']);
  expect(r).toMatchObject({ code: 0 });
  const entry = JSON.parse(readFileSync(join(w.cwd, '.mcp.json'), 'utf8')).mcpServers['team-inbox'];
  expect(entry.command).toBe(selfRunner().command);
  const epoch = currentBriefClaim(readState(join(w.root, '.agents')).sessions[SESSION]?.briefs?.alpha)?.epoch;
  expect(epoch).toBeString();
  expect(entry.args).toEqual([selfRunner().entry, 'mcp', 'serve', '--seat', 'alpha', '--session', SESSION, '--epoch', epoch]);
  expect(readState(join(w.root, '.agents')).sessions[SESSION]?.seats.alpha?.pane).toBe(PANE);
  expect(readFileSync(w.file, 'utf8')).toContain(FLAG);
  expect(JSON.parse(readFileSync(join(w.cwd, '.claude/settings.local.json'), 'utf8')).enabledMcpjsonServers).toEqual(['team-inbox']);
  expect(existsSync(join(w.home, '.claude'))).toBe(false);
});

function files(w: ReturnType<typeof world>) {
  return [join(w.cwd, '.mcp.json'), join(w.cwd, '.claude/settings.local.json')];
}
function writePair(w: ReturnType<typeof world>, mcp: string, approval: string) {
  mkdirSync(join(w.cwd, '.claude'), { mode: 0o700 });
  for (const [index, path] of files(w).entries()) writeFileSync(path, index === 0 ? mcp : approval);
}
test('setup and the launch writer produce the exact same pair for the same resulting claim', async () => {
  const w = world(true);
  expect(readTeamConfig(w.root, { home: w.home })).toMatchObject({ ok: true });
  expect(await setup(w)).toMatchObject({ code: 0 });
  const after = files(w).map((p) => readFileSync(p, 'utf8'));
  for (const path of files(w)) unlinkSync(path);
  const epoch = currentBriefClaim(readState(join(w.root, '.agents')).sessions[SESSION]?.briefs?.alpha)?.epoch;
  const launch = prepareChannelConfig({ root: w.root, home: w.home, seat: 'alpha', session: SESSION, cwd: w.cwd, epoch });
  if (!launch.ok) throw new Error(launch.reason);
  expect(launch.ok).toBe(true);
  launch.lease.check(); launch.lease.release();
  expect(files(w).map((p) => readFileSync(p, 'utf8'))).toEqual(after);
});
test('setup preserves unrelated raw JSON spans and off restores both original files byte for byte', async () => {
  const w = world();
  const mcp = '{ \n "note" : "keep \\"quoted\\" text", "mcpServers" : {"other" : { "command" : "fixture", "args": [ "a", 2 ] }} }\n';
  const approval = '{\n  "env" : { "SYNTHETIC": "keep raw" },\n "enabledMcpjsonServers" : [ "other" ], "permissions" : { "allow" : ["Read(*)"] }\n}\n';
  writePair(w, mcp, approval);
  const launchBefore = readTeamConfig(w.root, { home: w.home });
  expect(await setup(w)).toMatchObject({ code: 0 });
  expect(readFileSync(files(w)[0]!, 'utf8')).toContain('"other" : { "command" : "fixture", "args": [ "a", 2 ] }');
  expect(readFileSync(files(w)[1]!, 'utf8')).toContain('"env" : { "SYNTHETIC": "keep raw" }');
  expect(readFileSync(files(w)[1]!, 'utf8')).toContain('"permissions" : { "allow" : ["Read(*)"] }');
  expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
  expect(files(w).map((p) => readFileSync(p, 'utf8'))).toEqual([mcp, approval]);
  const restored = readTeamConfig(w.root, { home: w.home });
  expect(restored.ok && restored.team.seats[0]!.launch).toBe(launchBefore.ok && launchBefore.team.seats[0]!.launch);
  expect(existsSync(join(w.cwd, '.team-channel-setup.json'))).toBe(false);
});
test('off removes newly created project files and directory and keeps placement', async () => {
  const w = world(); expect(await setup(w)).toMatchObject({ code: 0 });
  expect(await setup(w, ['--off', '--dry-run', '--json'])).toMatchObject({ code: 0 });
  expect(files(w).every(existsSync)).toBe(true);
  expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
  expect(files(w).some(existsSync)).toBe(false);
  expect(existsSync(join(w.cwd, '.claude'))).toBe(false);
  expect(readState(join(w.root, '.agents')).sessions[SESSION]?.seats.alpha?.pane).toBe(PANE);
  const before = snapshot(w.base); expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
  expect(snapshot(w.base)).toEqual(before);
});
test('repeated setup adds the channel once and preserves another channel in the same flag', async () => {
  const w = world(); writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('claude --model fixture', 'claude --model fixture --dangerously-load-development-channels server:other'));
  expect(await setup(w)).toMatchObject({ code: 0 });
  expect(await setup(w)).toMatchObject({ code: 0 });
  const loaded = readTeamConfig(w.root, { home: w.home });
  expect(loaded.ok && loaded.team.seats[0]!.launch).toBe('claude --model fixture --dangerously-load-development-channels server:other,server:team-inbox');
  expect(JSON.parse(readFileSync(files(w)[1]!, 'utf8')).enabledMcpjsonServers).toEqual(['team-inbox']);
  expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
  const off = readTeamConfig(w.root, { home: w.home });
  expect(off.ok && off.team.seats[0]!.launch).toBe('claude --model fixture --dangerously-load-development-channels server:other');
});
test('serve placement accepts the recorded calling pane through its real proof seam', async () => {
  const w = world(); expect(await setup(w)).toMatchObject({ code: 0 });
  const io = testIo(w.cwd); io.env = { HERDR_PANE_ID: PANE };
  io.callerSources = () => ({
    ancestors: () => [{ pid: 7003, name: 'team' }, { pid: 7002, name: 'claude' }, { pid: 7001, name: 'shell' }, { pid: 1, name: 'init' }],
    agents: () => [{ name: 'alpha', agent: 'claude', pane: PANE, workspace: 'workspace', status: 'idle', cwd: w.cwd }],
    paneRootPid: () => 7001, env: io.env, stdinIsTTY: false,
    paneProcesses: () => ({ shell: 7001, foreground: [7002] }), processStartOf: () => null,
  });
  expect(await placementAtStart(io, join(w.root, '.agents'), SESSION, 'alpha', { sleep: async () => { throw new Error('no placement wait expected'); } })).toEqual({ ok: true });
});
for (const [label, change] of [
  ['unowned server', (w: ReturnType<typeof world>) => writePair(w, '{"mcpServers":{"team-inbox":{"command":"foreign"}}}', '{}')],
  ['malformed approval', (w: ReturnType<typeof world>) => writePair(w, '{}', '{"secret":"fixture-only-do-not-print",')],
  ['duplicate approval field', (w: ReturnType<typeof world>) => writePair(w, '{}', '{"enabledMcpjsonServers":[],"enabledMcpjsonServers":[]}')],
  ['explicit rejection', (w: ReturnType<typeof world>) => writePair(w, '{}', '{"disabledMcpServers":["team-inbox"]}')],
  ['hard-linked config', (w: ReturnType<typeof world>) => { writePair(w, '{}', '{}'); linkSync(files(w)[0]!, join(w.base, 'other-link')); }],
  ['linked config', (w: ReturnType<typeof world>) => { writeFileSync(join(w.base, 'other'), '{}'); symlinkSync(join(w.base, 'other'), files(w)[0]!); }],
  ['linked local team directory', (w: ReturnType<typeof world>) => symlinkSync(join(w.root, '.agents'), join(w.cwd, '.agents'))],
  ['linked cwd', (w: ReturnType<typeof world>) => { const link = join(w.base, 'alias'); symlinkSync(w.cwd, link); w.cwd = link; }],
  ['stopped seat', (w: ReturnType<typeof world>) => writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('    cli:', '    stopped: true\n    cli:'))],
  ['another CLI', (w: ReturnType<typeof world>) => writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('cli: claude-code', 'cli: codex'))],
] as const) test(`setup refuses ${label} before any config, placement or project write`, async () => {
  const w = world(); change(w); const before = snapshot(w.base);
  const r = await setup(w, ['--json']); expect(r.code).toBe(1);
  expect(snapshot(w.base)).toEqual(before);
  expect(r.out + r.err).not.toContain('fixture-only-do-not-print');
});
function place(root: string, name: string, pane: string) {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane };
  });
}
function crew() {
  const w = world();
  writeFileSync(w.file, `format: 1
project: sample
session: ${SESSION}
operator: ops
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: claude --model fixture
  - name: ops
    role: builder
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: claude --model fixture
  - name: worker
    role: builder
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: claude --model fixture
`);
  upsertTeam(w.home, teamIdOf(w.root), { root: w.root, project: 'sample', session: SESSION, roster: [
    { agent: 'agt_000000000001', seat: 'lead', role: 'coordinator' },
    { agent: 'agt_000000000002', seat: 'ops', role: 'operator' },
    { agent: 'agt_000000000003', seat: 'worker', role: 'builder' },
  ] });
  return w;
}
async function ask(w: ReturnType<typeof world>, seat: string, args: string[], caller: Io['caller']) {
  const io = testIo(w.cwd, caller); io.env.HERDR_PANE_ID = PANE;
  const code = await runMcp(['setup', seat, ...args], io, w.sources);
  return { code, out: io.out, err: io.err };
}
test('a placed seat is refused by the config editor on a dry run and a real run, and another seat is refused', async () => {
  const w = world(); place(w.root, 'alpha', PANE); const before = snapshot(w.base);
  const own = await setup(w, ['--dry-run', '--json'], { kind: 'seat', name: 'alpha', pane: PANE, session: SESSION });
  expect(own.code, own.err + own.out).toBe(1); expect(JSON.parse(own.out).error.id).toBe('mcp.setup-config');
  const off = await setup(w, ['--off', '--dry-run', '--json'], { kind: 'seat', name: 'alpha', pane: PANE, session: SESSION });
  expect(off.code, off.err + off.out).toBe(1); expect(JSON.parse(off.out).error.id).toBe('mcp.setup-config');
  const real = await setup(w, ['--json'], { kind: 'seat', name: 'alpha', pane: PANE, session: SESSION });
  expect(real.code, real.err + real.out).toBe(1); expect(JSON.parse(real.out).error.id).toBe('mcp.setup-config');
  expect(snapshot(w.base)).toEqual(before);
  const other = await setup(w, ['--dry-run', '--json'], { kind: 'seat', name: 'beta', pane: PANE, session: SESSION });
  expect(other.code, other.err + other.out).toBe(1); expect(JSON.parse(other.out).error.id).toBe('mcp.setup-caller');
  expect(snapshot(w.base)).toEqual(before);
});
test('a seat whose record already holds the calling pane keeps placement and does not register', async () => {
  const kept = crew();
  place(kept.root, 'lead', 'pane-lead');
  const dev = writeDevelopmentMode({ home: kept.home, mode: 'local-fast', now: NOW, caller: 'synthetic-fixture' });
  if (!dev.ok) throw new Error(dev.why);
  kept.sources.setup.register.processInfo = () => null;
  const caller = { kind: 'seat' as const, name: 'lead', pane: 'pane-lead', session: SESSION };
  const dry = await ask(kept, 'lead', ['--dry-run', '--json'], caller);
  expect(dry.code, dry.err + dry.out).toBe(0);
  expect(JSON.parse(dry.out).changes.find((change: { kind: string }) => change.kind === 'placement')).toEqual({ kind: 'placement', action: 'keep', pane: 'pane-lead' });
  const real = await ask(kept, 'lead', ['--json'], caller);
  expect(real.code, real.err + real.out).toBe(0);
  expect(JSON.parse(real.out).changes.find((change: { kind: string }) => change.kind === 'placement')).toEqual({ kind: 'placement', action: 'keep', pane: 'pane-lead' });
  expect(readState(join(kept.root, '.agents')).sessions[SESSION]?.seats.lead?.pane).toBe('pane-lead');
});
test('a different pane still goes through register, and a renamed shell is refused at the caller check', async () => {
  const moved = world();
  place(moved.root, 'alpha', 'pane-other');
  const refused = await setup(moved, ['--dry-run', '--json']);
  expect(refused.code, refused.err + refused.out).toBe(1);
  expect(JSON.parse(refused.out).error.id).toBe('mcp.setup-placement');
  const renamed = world();
  place(renamed.root, 'alpha', PANE);
  const renamedRun = await setup(renamed, ['--dry-run', '--json'], { kind: 'seat', name: 'alpha', pane: 'renamed-pane', session: SESSION });
  expect(renamedRun.code, renamedRun.err + renamedRun.out).toBe(1);
  expect(JSON.parse(renamedRun.out).error.id).toBe('mcp.setup-caller');
});
async function setupPlain(w: ReturnType<typeof world>, args: string[] = [], caller: Io['caller'] = { kind: 'owner' }) {
  const io = testIo(w.cwd, caller);
  const code = await runMcp(['setup', 'alpha', ...args], io, w.sources);
  return { code, out: io.out, err: io.err };
}
test('the owner with no pane keeps the pane the seat record holds', async () => {
  const w = world();
  place(w.root, 'alpha', PANE);
  w.sources.setup.register.processInfo = () => null;
  const dry = await setupPlain(w, ['--dry-run', '--json']);
  expect(dry.code, dry.err + dry.out).toBe(0);
  expect(JSON.parse(dry.out).changes.find((change: { kind: string }) => change.kind === 'placement')).toEqual({ kind: 'placement', action: 'keep', pane: PANE });
  const real = await setupPlain(w, ['--json']);
  expect(real.code, real.err + real.out).toBe(0);
  expect(JSON.parse(real.out).changes.find((change: { kind: string }) => change.kind === 'placement')).toEqual({ kind: 'placement', action: 'keep', pane: PANE });
  expect(readState(join(w.root, '.agents')).sessions[SESSION]?.seats.alpha?.pane).toBe(PANE);
});
test('the owner with no pane and no recorded pane is refused, and a non-owner with no pane is refused', async () => {
  const w = world();
  const missing = await setupPlain(w, ['--dry-run', '--json']);
  expect(missing.code, missing.err + missing.out).toBe(1);
  expect(JSON.parse(missing.out).error.id).toBe('mcp.setup-placement');
  expect(missing.out).toContain('run setup from the pane');
  const seat = await setupPlain(w, ['--dry-run', '--json'], { kind: 'seat', name: 'alpha', pane: '', session: SESSION });
  expect(seat.code, seat.err + seat.out).toBe(1);
  expect(JSON.parse(seat.out).error.id).toBe('mcp.setup-caller');
});
test('a placed lead under dev mode is admitted, and another team or a renamed pane is refused', async () => {
  const lead = crew(); place(lead.root, 'lead', 'pane-lead');
  const dev = writeDevelopmentMode({ home: lead.home, mode: 'local-fast', now: NOW, caller: 'synthetic-fixture' });
  if (!dev.ok) throw new Error(dev.why);
  const asLead = await ask(lead, 'worker', ['--dry-run', '--json'], { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION });
  expect(asLead.code, asLead.err + asLead.out).toBe(0);
  const asLeadReal = await ask(lead, 'worker', ['--json'], { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION });
  expect(asLeadReal.code, asLeadReal.err + asLeadReal.out).toBe(0);
  const ops = crew(); place(ops.root, 'ops', 'pane-ops'); const opsBefore = snapshot(ops.base);
  const asOps = await ask(ops, 'worker', ['--dry-run', '--json'], { kind: 'seat', name: 'ops', pane: 'pane-ops', session: SESSION });
  expect(asOps.code, asOps.err + asOps.out).toBe(1); expect(JSON.parse(asOps.out).error.id).toBe('mcp.setup-config');
  const asOpsReal = await ask(ops, 'worker', ['--json'], { kind: 'seat', name: 'ops', pane: 'pane-ops', session: SESSION });
  expect(asOpsReal.code, asOpsReal.err + asOpsReal.out).toBe(1); expect(JSON.parse(asOpsReal.out).error.id).toBe('mcp.setup-config');
  expect(snapshot(ops.base)).toEqual(opsBefore);
  const stranger = crew(); const before = snapshot(stranger.base);
  const otherTeam = await ask(stranger, 'worker', ['--dry-run', '--json'], { kind: 'seat', name: 'worker', pane: PANE, session: 'other-team' });
  expect(otherTeam.code, otherTeam.err + otherTeam.out).toBe(1); expect(JSON.parse(otherTeam.out).error.id).toBe('mcp.setup-caller');
  expect(snapshot(stranger.base)).toEqual(before);
  const renamed = world(); place(renamed.root, 'alpha', PANE);
  const renamedRun = await setup(renamed, ['--dry-run', '--json'], { kind: 'seat', name: 'alpha', pane: 'renamed-pane', session: SESSION });
  expect(renamedRun.code, renamedRun.err + renamedRun.out).toBe(1); expect(JSON.parse(renamedRun.out).error.id).toBe('mcp.setup-caller');
  const owner = crew();
  const asOwner = await ask(owner, 'worker', ['--dry-run', '--json'], { kind: 'owner' });
  expect(asOwner.code, asOwner.err + asOwner.out).toBe(0);
});
test('a changed setup-owned entry is refused on off and leaves every fixture byte alone', async () => {
  const w = world(); expect(await setup(w)).toMatchObject({ code: 0 });
  const path = files(w)[0]!; writeFileSync(path, readFileSync(path, 'utf8').replace('mcp","serve', 'mcp","different'));
  const before = snapshot(w.base); expect(await setup(w, ['--off'])).toMatchObject({ code: 1 });
  expect(snapshot(w.base)).toEqual(before);
});
test('a new claim during pair publication refuses and never publishes a stale server entry', async () => {
  const w = world(); const rename = fs.renameSync; let changed = false;
  const mock = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (!changed && String(to) === join(w.cwd, '.team-channel-setup.json')) {
      changed = true;
      const path = join(w.root, '.agents/team.state.json'); const state = JSON.parse(readFileSync(path, 'utf8'));
      state.sessions[SESSION].briefs.alpha.epoch = 'run_ba9876543210';
      writeFileSync(path, JSON.stringify(state));
    }
  });
  try {
    const r = await setup(w, ['--json']); expect(r.code).toBe(1); expect(changed).toBe(true);
    expect(r.out).toContain('claim changed');
    expect(existsSync(files(w)[0]!)).toBe(false);
    expect(existsSync(join(w.cwd, '.team-channel.lock'))).toBe(false);
  } finally { mock.mockRestore(); }
});
test('off retains its restoration record if the second project write fails, and a retry restores it', async () => {
  const w = world(); writePair(w, '{ "keep": 1 }\n', '{ "keep" : [1, 2] }\n');
  expect(await setup(w)).toMatchObject({ code: 0 });
  const rename = fs.renameSync;
  const mock = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === files(w)[1]) throw new Error('synthetic publication failure');
    rename(from, to);
  });
  try { expect(await setup(w, ['--off'])).toMatchObject({ code: 1 }); }
  finally { mock.mockRestore(); }
  expect(existsSync(join(w.cwd, '.team-channel-setup.json'))).toBe(true);
  expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
  expect(files(w).map((p) => readFileSync(p, 'utf8'))).toEqual(['{ "keep": 1 }\n', '{ "keep" : [1, 2] }\n']);
});
test('off preserves later unrelated edits and an approval that predated setup', async () => {
  const w = world(); writePair(w, '{ "keep": 1 }\n', '{ "enabledMcpjsonServers" : [ "team-inbox", "other" ], "keep": 1 }\n');
  expect(await setup(w)).toMatchObject({ code: 0 });
  for (const path of files(w)) writeFileSync(path, readFileSync(path, 'utf8').replace('"keep": 1', '"keep": { "later" : [ 2, 3 ] }'));
  expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
  for (const path of files(w)) expect(readFileSync(path, 'utf8')).toContain('"keep": { "later" : [ 2, 3 ] }');
  expect(JSON.parse(readFileSync(files(w)[0]!, 'utf8')).mcpServers).toBeUndefined();
  expect(JSON.parse(readFileSync(files(w)[1]!, 'utf8')).enabledMcpjsonServers).toEqual(['team-inbox', 'other']);
});
for (const args of [[], ['missing'], ['alpha', '--seat', 'alpha'], ['alpha', '--file', 'elsewhere'], ['alpha', '--nope']]) {
  test(`invalid or unknown setup invocation ${JSON.stringify(args)} writes nothing`, async () => {
    const w = world(); const before = snapshot(w.base); const io = testIo(w.cwd, { kind: 'owner' });
    const code = await runMcp(['setup', ...args, '--json'], io, w.sources);
    expect(code).toBe(args[0] === 'missing' ? 1 : 2); expect(snapshot(w.base)).toEqual(before);
  });
}
for (const launch of ["sh -c 'claude --model fixture'", "sh -c 'claude --dangerously-load-development-channels server:other'", 'claude --model fixture -- prompt', "sh -c 'claude --model fixture -- prompt'", 'claude --dangerously-load-development-channels=server:other', `claude ${FLAG}`]) {
  test(`setup places its flag within the CLI option scope: ${launch}`, async () => {
    const w = world(); writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('claude --model fixture', launch));
    expect(await setup(w)).toMatchObject({ code: 0 });
    const loaded = readTeamConfig(w.root, { home: w.home }); if (!loaded.ok) throw new Error('fixture team did not load');
    expect(channelLaunchEnabled(loaded.team.seats[0]!.launch)).toBe(true);
    const words = cliWordListOf('claude', loaded.team.seats[0]!.launch)!;
    const delimiter = words.indexOf('--'); const options = delimiter < 0 ? words : words.slice(0, delimiter);
    expect(options.join(' ')).toContain('server:team-inbox');
    expect(await setup(w, ['--off'])).toMatchObject({ code: 0 });
    const off = readTeamConfig(w.root, { home: w.home }); expect(off.ok && off.team.seats[0]!.launch).toBe(launch);
  });
}
test('off dry run is byte-for-byte read only and has the published output schema', async () => {
  const w = world(); const r = await setup(w, ['--json']); expect(r.code).toBe(0);
  assertMatchesOutputSchema(r.out, MCP_SETUP_OUTPUT_SCHEMA);
  const before = snapshot(w.base); const dry = await setup(w, ['--off', '--dry-run', '--json']);
  expect(dry.code).toBe(0); assertMatchesOutputSchema(dry.out, MCP_SETUP_OUTPUT_SCHEMA);
  expect(snapshot(w.base)).toEqual(before);
});
test('registration refusal and unsafe launch placement are zero-write refusals', async () => {
  const w = world(); w.sources.setup.register.processInfo = () => null;
  const before = snapshot(w.base); expect(await setup(w)).toMatchObject({ code: 1 }); expect(snapshot(w.base)).toEqual(before);
  writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('claude --model fixture', 'claude --model fixture > output'));
  const after = snapshot(w.base); expect(await setup(w)).toMatchObject({ code: 1 }); expect(snapshot(w.base)).toEqual(after);
});

test('setup binds the containing team when another registered team has the same seat name', async () => {
  const w = world(); const first = join(w.base, 'first-project'); const firstFile = join(first, '.agents/team.yaml');
  mkdirSync(join(first, '.agents'), { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: first, stdio: 'ignore' });
  writeFileSync(firstFile, readFileSync(w.file, 'utf8').replace('project: sample', 'project: first').replace(`session: ${SESSION}`, 'session: first-scene'));
  upsertTeam(w.home, teamIdOf(first), { root: first, project: 'first', session: 'first-scene', roster: [{ agent: 'agt_000000000002', seat: 'alpha', role: 'coordinator' }] });
  const beforeFirst = snapshot(first); const firstRecord = getTeam(w.home, teamIdOf(first));
  const result = await setup(w, ['--json']); expect(result).toMatchObject({ code: 0 });
  const doc = JSON.parse(result.out); expect(doc.session).toBe(SESSION);
  const entry = JSON.parse(readFileSync(files(w)[0]!, 'utf8')).mcpServers['team-inbox'];
  expect(entry.args[6]).toBe(SESSION); expect(JSON.parse(entry.env.TEAMCLI_CHANNEL_SCOPE).team).toBe(teamIdOf(w.root));
  expect(readState(join(w.root, '.agents')).sessions[SESSION]?.seats.alpha?.pane).toBe(PANE);
  expect(snapshot(first)).toEqual(beforeFirst); expect(getTeam(w.home, teamIdOf(first))).toEqual(firstRecord);
});
test('setup outside every team refuses without writes even when only one team holds the seat', async () => {
  const w = world(); w.cwd = `${w.root}-outside`; mkdirSync(w.cwd, { mode: 0o700 });
  const before = snapshot(w.base); const result = await setup(w, ['--json']);
  expect(result.code).toBe(1); expect(JSON.parse(result.out).error.id).toBe('mcp.setup-team'); expect(snapshot(w.base)).toEqual(before);
});
test('setup resolves a containing registered plain-folder team from its child folder', async () => {
  const w = world(); rmSync(join(w.root, '.git'), { recursive: true });
  expect(await setup(w, ['--json'])).toMatchObject({ code: 0 });
  expect(JSON.parse(readFileSync(files(w)[0]!, 'utf8')).mcpServers['team-inbox'].args[6]).toBe(SESSION);
});

test('setup can select the local plain-folder team file without a pre-existing roster entry', async () => {
  const w = world(true); forgetTeam(w.home, teamIdOf(w.root)); w.cwd = w.root;
  const result = await setup(w, ['--json']); expect(result).toMatchObject({ code: 0 });
  expect(JSON.parse(result.out).session).toBe(SESSION);
  expect(JSON.parse(readFileSync(files(w)[0]!, 'utf8')).mcpServers['team-inbox'].args[6]).toBe(SESSION);
});
