// Independent scenes for the channel opt-out preserved through lobby canonicalization:
// a declared `channel: off` claude seat that waits in the lobby stays in the lobby's common
// root at both canonicalization sites (the verified-lobby plan and the lobby a run creates),
// while a default seat keeps its owned channel folder and flag. The refusal guards around
// placement — trust, protected checkout, a foreign pair, and the channel config lease — refuse
// an opted-out seat exactly as they refuse a default one.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { importTeamFile } from '../src/file/team-import.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { CLAUDE_IDLE, deliverBriefs, gitEnv, recordRenames, testIo } from './helpers.ts';

const FLAG = '--dangerously-load-development-channels';
const EPOCH = 'run_0123456789ab';
const SESSION = 'synthetic-session';
const NOW = new Date('2026-11-10T06:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type World = ReturnType<typeof world>;

/** A synthetic home and project with a migrated-trust team whose lead starts in the project,
 *  a default claude worker and a `channel: off` claude worker that both wait in the lobby. */
function world(options: { lobby?: boolean; legacyTrust?: boolean; protectedRoot?: boolean; nested?: boolean; foreignPair?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'channel-off-placement-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'project');
  const lobby = join(home, 'lobby');
  mkdirSync(home, { mode: 0o700 });
  if (options.lobby !== false) mkdirSync(lobby, { mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const seats = [
    `  - name: lead
    role: coordinator
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
    `  - name: open
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
    `  - name: quiet
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    channel: off
    launch: claude --model claude-opus-5-5`,
    ...(options.nested ? [
      `  - name: nested
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    cwd: wt
    launch: claude --model claude-opus-5-5`,
      `  - name: hushed
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    channel: off
    cwd: wt2
    launch: claude --model claude-opus-5-5`,
    ] : []),
  ].join('\n');
  const trust = options.legacyTrust
    ? '  - .'
    : `  - ${root}\n  - ${lobby}`;
  writeFileSync(join(root, '.agents/team.yaml'), `format: 1
project: synthetic-project
session: ${SESSION}
coordinator: lead
operator: lead
lobby: ${lobby}
trust:
${trust}
workspace:
  mode: shared
${options.protectedRoot ? '  protected:\n    - .\n' : ''}seats:
${seats}
`);
  // A legacy-trust world is never imported: `migrate` would rewrite the file into the current
  // absolute-path form and store that copy in the registry, where the run would read it instead
  // of the legacy text this scene means to hold up.
  if (!options.legacyTrust) {
    const imported = importTeamFile({ cwd: root, home, mode: 'migrate' });
    if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  }
  const names = ['lead', 'open', 'quiet', ...(options.nested ? ['nested', 'hushed'] : [])];
  upsertTeam(home, teamIdOf(root), {
    root, project: 'synthetic-project', session: SESSION, lobby,
    roster: names.map((seat, i) => ({ agent: `agt_${String(i + 1).padStart(12, '0')}`, seat, role: 'worker' })),
  });
  writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({ format: 1, sessions: { [SESSION]: {
    seats: {},
    worktrees: {},
    briefs: Object.fromEntries(names.map((seat) => [seat, {
      id: '01234567-0000-4000-8000-000000000001', incarnation: 'inc_0123456789ab', epoch: EPOCH,
      at: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64), stage: 'ready',
    }])),
  } } }));
  deliverBriefs({ dir: join(root, '.agents'), root, session: SESSION, seats: names, home, at: NOW.toISOString() });
  // A foreign channel pair in the project root: another seat's config this run must not touch.
  let kept = '';
  if (options.foreignPair) {
    kept = `${JSON.stringify({
      mcpServers: { 'team-inbox': { command: '/usr/bin/team', args: ['mcp', 'serve', '--seat', 'owner', '--session', SESSION], env: {} } },
    }, null, 2)}\n`;
    writeFileSync(join(root, '.mcp.json'), kept);
    mkdirSync(join(root, '.claude'), { mode: 0o755 });
    writeFileSync(join(root, '.claude', 'settings.local.json'), `${JSON.stringify({ enabledMcpjsonServers: ['team-inbox'] })}\n`);
  }
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { base, home, root, lobby, team: loaded.team, kept };
}

/** The dry plan of a cold start, the way the up command prints it. The state file the world
 *  wrote is read for real: a source that answers "absent" hides its brief epochs and the run
 *  reports seats it could have placed. */
async function dryPlan(w: World) {
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runUp(['--dry-run'], io, {
    home: w.home, sessionRunning: () => false, agents: () => [], now: () => NOW,
  });
  return { code, out: io.out, err: io.err };
}

/** A full run over a launch host that records each workspace's cwd and each pane's command. */
async function fullRun(w: World) {
  const created: { pane: string; cwd: string }[] = [];
  const runs: { pane: string; command: string }[] = [];
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, cwd) {
      n += 1;
      const pane = `pane-${n}`;
      created.push({ pane, cwd });
      return { pane, workspace: `workspace-${n}` };
    },
    paneRun(_session, pane, command) { runs.push({ pane, command }); return true; },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => created.map((one) => one.pane),
    agents: () => [],
    paneText: () => CLAUDE_IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runUp([], io, {
    sessionRunning: () => false, agents: () => [],
    home: w.home, launch, now: () => NOW,
  });
  const commandAt = (cwd: string) => runs.filter((one) => created.find((made) => made.pane === one.pane)?.cwd === cwd).map((one) => one.command);
  return { code, out: io.out, err: io.err, created, commandAt };
}

test('the dry plan keeps an opted-out seat in the lobby root and a default seat in its channel folder', async () => {
  const w = world();
  const plan = await dryPlan(w);
  expect(plan.code).toBe(0);
  const line = (name: string) => plan.out.split('\n').find((one) => one.includes(`workspace create --cwd `) && one.includes(`--label '${name} · `));
  expect(line('open')).toContain(`--cwd ${join(w.lobby, 'open')}`);
  expect(line('quiet')).toContain(`--cwd ${w.lobby}`);
  expect(line('quiet')).not.toContain(join(w.lobby, 'quiet'));
  expect(plan.out).not.toContain(join(w.lobby, 'quiet'));
  // The default seat's launch carries the channel; the opted-out seat's carries none.
  const launches = plan.out.split('\n').filter((one) => one.includes(`pane run <pane of `));
  const openRun = launches.find((one) => one.includes('pane of open'));
  const quietRun = launches.find((one) => one.includes('pane of quiet'));
  expect(openRun).toContain(FLAG);
  expect(openRun).toContain('server:team-inbox');
  expect(quietRun).not.toContain(FLAG);
  expect(quietRun).not.toContain('server:team-inbox');
  // A dry run makes nothing: the opted-out seat's folder is not even planned into existence.
  expect(existsSync(join(w.lobby, 'quiet'))).toBe(false);
});

test('a run that creates the lobby starts the opted-out seat in the common root and never writes it a channel pair', async () => {
  const w = world({ lobby: false, foreignPair: true });
  const run = await fullRun(w);
  expect(run.code).toBe(0);
  // The lobby the plan found absent was created by the run, under its lock.
  expect(existsSync(w.lobby)).toBe(true);
  const cwds = run.created.map((one) => one.cwd);
  expect(cwds).toContain(join(w.lobby, 'open'));
  expect(cwds).toContain(w.lobby);
  expect(cwds).not.toContain(join(w.lobby, 'quiet'));
  expect(existsSync(join(w.lobby, 'quiet'))).toBe(false);
  // The default seat's folder holds its channel pair; the common root holds none of it.
  const pair = JSON.parse(readFileSync(join(w.lobby, 'open', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  expect(pair.mcpServers['team-inbox']?.args).toContain('open');
  const settings = JSON.parse(readFileSync(join(w.lobby, 'open', '.claude', 'settings.local.json'), 'utf8')) as { enabledMcpjsonServers: string[] };
  expect(settings.enabledMcpjsonServers).toContain('team-inbox');
  expect(existsSync(join(w.lobby, '.mcp.json'))).toBe(false);
  // An opted-out seat takes no channel lease: its start is refused by the same door.
  expect(prepareChannelConfig({ root: w.root, home: w.home, seat: 'quiet', session: SESSION, cwd: w.lobby, epoch: EPOCH }).ok).toBe(false);
  expect(run.commandAt(join(w.lobby, 'open')).join('\n')).toContain(FLAG);
  expect(run.commandAt(w.lobby).join('\n')).not.toContain(FLAG);
  // The foreign pair in the project root is byte-identical after the run.
  expect(readFileSync(join(w.root, '.mcp.json'), 'utf8')).toBe(w.kept);
});

test('the tolerated project-relative trust form leaves both seats exactly where the migrated form puts them', async () => {
  const w = world({ legacyTrust: true });
  const plan = await dryPlan(w);
  // Project-relative trust is not a refusal: the run trusts the lobby and the project, nothing
  // degrades, and the opt-out outcomes are the migrated form's.
  expect(plan.code).toBe(0);
  expect(plan.out).not.toContain('its channel needs the current trust form');
  const openRun = plan.out.split('\n').find((one) => one.includes('pane of open'));
  expect(openRun).toContain(FLAG);
  const quietRun = plan.out.split('\n').find((one) => one.includes('pane of quiet'));
  expect(quietRun).not.toContain(FLAG);
  expect(plan.out).not.toContain(join(w.lobby, 'quiet'));
});

test('a protected checkout still refuses an explicit cwd for an opted-out seat', async () => {
  const w = world({ protectedRoot: true, nested: true });
  const plan = await dryPlan(w);
  expect(plan.code).toBe(1);
  const said = plan.out + plan.err;
  expect(said).toContain('seat nested would start in wt, inside the protected checkout');
  expect(said).toContain('seat hushed would start in wt2, inside the protected checkout');
  // The lobby waiters are unaffected: their folders are outside the protected root.
  expect(said).not.toContain('seat quiet would start');
  expect(said).not.toContain('seat open would start');
});
