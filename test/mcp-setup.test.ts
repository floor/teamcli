// Synthetic homes, starting folders and terminal-host readings only; no live agent CLI.
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { afterEach, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync, linkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runMcp, realSources as mcpSources } from '../src/commands/mcp.ts';
import type { RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { placementAtStart } from '../src/mcp/serve.ts';
import type { Io } from '../src/io.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { selfRunner } from '../src/mcp/register.ts';
import { cliWordListOf } from '../src/launch/cli-scope.ts';
import { MCP_SETUP_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { currentBriefClaim } from '../src/launch/general-brief.ts';
import { upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import { readState } from '../src/state.ts';
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
  const home = join(base, 'home'); const root = join(base, 'project'); const lobby = join(home, 'lobby'); const cwd = inLobby ? join(lobby, 'alpha') : join(base, 'start');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(join(root, '.agents'), { recursive: true }); if (inLobby) mkdirSync(lobby, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
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
`);
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
  expect(launch.ok).toBe(true);
  if (!launch.ok) throw new Error(launch.reason);
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
  ['linked cwd', (w: ReturnType<typeof world>) => { const link = join(w.base, 'alias'); symlinkSync(w.cwd, link); w.cwd = link; }],
  ['stopped seat', (w: ReturnType<typeof world>) => writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('    cli:', '    stopped: true\n    cli:'))],
  ['another CLI', (w: ReturnType<typeof world>) => writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('cli: claude-code', 'cli: codex'))],
] as const) test(`setup refuses ${label} before any config, placement or project write`, async () => {
  const w = world(); change(w); const before = snapshot(w.base);
  const r = await setup(w, ['--json']); expect(r.code).toBe(1);
  expect(snapshot(w.base)).toEqual(before);
  expect(r.out + r.err).not.toContain('fixture-only-do-not-print');
});
test('own-seat setup still needs the existing config gate and another seat cannot set it up', async () => {
  const w = world(); const before = snapshot(w.base);
  const own = await setup(w, ['--json'], { kind: 'seat', name: 'alpha', pane: PANE, session: SESSION });
  expect(own.code).toBe(1); expect(JSON.parse(own.out).error.id).toBe('mcp.setup-config');
  expect(snapshot(w.base)).toEqual(before);
  const other = await setup(w, ['--json'], { kind: 'seat', name: 'beta', pane: PANE, session: SESSION });
  expect(other.code).toBe(1); expect(JSON.parse(other.out).error.id).toBe('mcp.setup-caller');
  expect(snapshot(w.base)).toEqual(before);
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
for (const launch of ['claude --model fixture -- prompt', "sh -c 'claude --model fixture -- prompt'", 'claude --dangerously-load-development-channels=server:other', `claude ${FLAG}`]) {
  test(`setup places its flag within the CLI option scope: ${launch}`, async () => {
    const w = world(); writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('claude --model fixture', launch));
    expect(await setup(w)).toMatchObject({ code: 0 });
    const loaded = readTeamConfig(w.root, { home: w.home }); if (!loaded.ok) throw new Error('fixture team did not load');
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
