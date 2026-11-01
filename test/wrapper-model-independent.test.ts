// What `team status` and `team send` read for a seat that runs another maker's model through a
// provider wrapper in front of Claude Code. Claude Code's own status line prints its own family
// whatever provider the launcher selected, so the wrapper's declaration — or the provider id on
// its banner — is the seat's model. A bare Claude Code launch keeps the screen reading, where the
// Claude family is the contradiction the declared model needs. Every pane here is synthetic.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runSend } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding, type Standing } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { recordBody, testIo, wrapperPane, type TestIo } from './helpers.ts';
import { dropDir, fake, filed, owner, scripted, world, type World } from './send-native-fixtures.ts';

const STATUS_NOW = new Date('2026-10-31T09:00:00Z');

const LEAD_PANE = 'fixture-pane-lead';
const GLM_PANE = 'fixture-pane-glm';
const DS_PANE = 'fixture-pane-ds';

const claudeScreen = (model: string) =>
  `❯ \n${'─'.repeat(40)}\n  main · …/glow · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

// A team of my own: a plain Claude Code lead, and two seats whose launch lines are provider
// wrappers around Claude Code, each declaring another maker's model.
const TEAM = `format: 1
project: glow
session: glow
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - .
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: glm-seat
    cli: claude-code
    vendor: zhipu
    model: GLM
    version: "5.3"
    display: GLM 5.3
    launch: claude-glm.sh
  - role: implementer
    name: ds-seat
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: claude-deepseek.sh
`;

function seatAgent(name: string, pane: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace, status, cwd: null };
}

/** The three seats live, with the screens a scene hands in. */
function liveWith(screens: Record<string, string>): Live {
  return {
    running: true,
    agents: [
      seatAgent('lead', LEAD_PANE, 'fixture-ws-lead', 'working'),
      seatAgent('glm-seat', GLM_PANE, 'fixture-ws-glm', 'idle'),
      seatAgent('ds-seat', DS_PANE, 'fixture-ws-ds', 'idle'),
    ],
    workspaces: [
      { id: 'fixture-ws-lead', label: 'lead' },
      { id: 'fixture-ws-glm', label: 'glm' },
      { id: 'fixture-ws-ds', label: 'deepseek' },
    ],
    screens,
  };
}

describe('team status behind a provider wrapper', () => {
  let dir: string;
  let file: string;
  let live: Live;
  let standing: Standing;
  const sources: StatusSources = {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => STATUS_NOW,
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-wrapper-status-')));
    mkdirSync(join(dir, '.agents'));
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, TEAM);
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error(`the wrapper fixture does not validate: ${JSON.stringify(checked.errors)}`);
    standing = verifiedOf(checked.team, TEAM, dir, STATUS_NOW);
    // The session's watch is live, so the report's subject is the seats, not the missing watch.
    updateState(join(dir, '.agents'), (state) => {
      state.sessions.glow = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-31T08:59:00Z' } };
    });
    live = liveWith({
      [LEAD_PANE]: claudeScreen('Opus 5.5'),
      [GLM_PANE]: claudeScreen('Opus 5.5'),
      [DS_PANE]: claudeScreen('Opus 5.5'),
    });
  });
  afterEach(() => {
    delete sources.home;
    rmSync(dir, { recursive: true, force: true });
  });

  async function status(...argv: string[]) {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runStatus(['--file', file, ...argv], io, sources);
    return { code, out: io.out, err: io.err };
  }

  /** A registry record for one launcher seat, the way `team up` leaves it: the signing is the
   *  launcher's declaration, and the reach names this fixture's own pane. */
  function registerLauncher(seat: string, pane: string, signing: { model: string; version: string }, launch: string): void {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    sources.home = home;
    registerAgent(home, {
      name: seat,
      signing: { ...signing, role: 'implementer' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch,
      reach: { team: teamIdOf(dir), seat, session: 'glow', pane, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
  }

  test('an unrecorded launcher seat shows the model it declares, never the CLI family', async () => {
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toMatch(new RegExp(`glm-seat\\s+idle\\s+GLM 5\\.3\\s+${GLM_PANE}`));
    expect(out).toMatch(new RegExp(`ds-seat\\s+idle\\s+DeepSeek V4\\.1 Flash\\s+${DS_PANE}`));
    // The declaration is the reading: neither seat falls back to the declared-unread word.
    expect(out).not.toContain('note: glm-seat:');
    expect(out).not.toContain('note: ds-seat:');
    expect(out).not.toMatch(/glm-seat\s+idle\s+Claude/);
    expect(out).not.toMatch(/ds-seat\s+idle\s+Claude/);
  });

  test('a recorded launcher seat is compared with its signing, and no drift is claimed', async () => {
    registerLauncher('glm-seat', GLM_PANE, { model: 'GLM', version: '5.3' }, 'claude-glm.sh');
    registerLauncher('ds-seat', DS_PANE, { model: 'DeepSeek Flash', version: 'V4.1' }, 'claude-deepseek.sh');
    const { out } = await status();
    // The registered row carries the registry's own label for the signed declaration.
    expect(out).toMatch(new RegExp(`glm-seat\\s+idle\\s+glm 5\\.3\\s+${GLM_PANE}`));
    expect(out).toMatch(new RegExp(`ds-seat\\s+idle\\s+deepseek flash v4\\.1\\s+${DS_PANE}`));
    // Claude Code's own family is never the reading of a wrapper's pane.
    expect(out).not.toContain('running Claude Opus');
    expect(out).not.toContain('difference: glm-seat:');
    expect(out).not.toContain('difference: ds-seat:');
  });

  test('a plain Claude Code seat still reports the family its screen names', async () => {
    live = liveWith({
      [LEAD_PANE]: claudeScreen('Opus 4.6'),
      [GLM_PANE]: claudeScreen('Opus 5.5'),
      [DS_PANE]: claudeScreen('Opus 5.5'),
    });
    const { out } = await status();
    expect(out).toContain('lead: running Claude Opus 4.6, file says Claude Opus 5.5');
  });
});

describe('team send behind a provider wrapper', () => {
  let cleanup: () => void = () => {};
  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  /** A registry record for the lead, signed with the launcher's declared model. */
  function registerLead(made: World, fields: { model: string; version: string; launch: string }): void {
    registerAgent(made.home, {
      name: 'lead',
      signing: { model: fields.model, version: fields.version, role: 'coordinator' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: fields.launch,
      reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: LEAD_PANE, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
  }

  /** The live read and the one pane, its text the screen the scene hands in. */
  function sendHost(made: World, screen: string) {
    const pane = scripted(['idle', 'working'], screen);
    const host = fake(made, { agents: () => [{ name: 'lead', pane: LEAD_PANE }], native: pane });
    return { host, pane };
  }

  /** The one drop the fixture files for the owner's send. */
  function expectDrop(made: World): void {
    const drops = dropDir(made.dir, 'lead');
    const files = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(files.length).toBe(1);
    expect(recordBody(join(drops, files[0] as string))).toBe(filed('hello'));
  }

  test('a signed wrapper is not held for the Claude family its screen prints', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'GLM', version: '5.3', launch: 'claude-glm.sh' });
    const { host, pane } = sendHost(made, claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });

  test('a wrapper whose banner names another provider model is still held', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'GLM', version: '5.3', launch: 'claude-glm.sh' });
    const { host, pane } = sendHost(made, wrapperPane('deepseek-v4.1') + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('model drift: GLM 5.3 vs deepseek v4.1');
    expect(pane.typed).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  });

  test('a wrapper whose banner names the signed model walks its leg', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'GLM', version: '5.3', launch: 'claude-glm.sh' });
    const { host } = sendHost(made, wrapperPane('glm-5.3') + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });

  test('a plain Claude Code seat whose screen names another family is still held', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'Claude Opus', version: '5.5', launch: 'claude --model claude-opus-5-5' });
    const { host, pane } = sendHost(made, claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('model drift: Claude Opus 5.5 vs Claude Opus 4.6');
    expect(pane.enters).toBe(0);
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  });

  test('a plain Claude Code seat whose screen names the signed model is delivered', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'Claude Opus', version: '5.5', launch: 'claude --model claude-opus-5-5' });
    const { host } = sendHost(made, claudeScreen('Opus 5.5'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });

  // The CLI itself reached by a path, through env, or quoted is still the CLI: there is no
  // provider wrapper in the line, so the family its screen prints is the contradiction the
  // signed model needs.
  test('a CLI launched by a path, through env, or quoted is not a wrapper', async () => {
    for (const launch of ['env claude', '/opt/fixture/bin/claude', '"claude"']) {
      const made = world(['typed']);
      registerLead(made, { model: 'DeepSeek Flash', version: 'V4.1', launch });
      const { host } = sendHost(made, claudeScreen('Opus 4.6'));
      const io = owner(made.root);

      expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
      expect(io.err).toContain('model drift: DeepSeek Flash V4.1 vs Claude Opus 4.6');
      made.cleanup();
    }
  });

  // The id on the banner names the signed model even where the declaration keeps the family's
  // number in the model name, and even with a suffix word after the version.
  test('a banner id whose family number is in the model name matches its declaration', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'GLM 5', version: '5.3', launch: 'claude-glm.sh' });
    const { host } = sendHost(made, wrapperPane('glm-5.3') + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });

  test('a banner id with a suffix after the version names the declared model', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'DeepSeek Flash', version: 'V4.1', launch: 'claude-deepseek.sh' });
    const { host } = sendHost(made, wrapperPane('deepseek-v4.1-flash') + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });

  // A banner is read word by word, order included: the same words in another order name another
  // version, and a wrapper that moved from 5.3 to 3.5 is a drift like any other. Sorting the
  // declaration's words would let every reordering through.
  test('a banner id that writes the GLM version in another order is still held', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'GLM 5', version: '5.3', launch: 'claude-glm.sh' });
    const { host, pane } = sendHost(made, wrapperPane('glm-3.5') + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('model drift: GLM 5 5.3 vs');
    expect(pane.enters).toBe(0);
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  });

  test('a banner id that writes the DeepSeek version in another order is still held', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLead(made, { model: 'DeepSeek Flash', version: 'V4.1', launch: 'claude-deepseek.sh' });
    const { host, pane } = sendHost(made, wrapperPane('deepseek-v1.4-flash') + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('model drift: DeepSeek Flash V4.1 vs');
    expect(pane.enters).toBe(0);
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  });
});

// `team check` reads a running pane against the record that signs it. The wrapper evidence is the
// launch the record was made from, not the line the team file happens to carry now: the recorded
// launch is what the running process was started with.
describe('team check behind a provider wrapper', () => {
  let base: string;
  let root: string;
  let home: string;
  let live: Live;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-wrapper-check-')));
    root = join(base, 'glow');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
    updateState(join(root, '.agents'), (state) => {
      state.sessions.glow = {
        ...emptySession(),
        watch: { pid: 1, heartbeat: '2026-10-31T08:59:00Z' },
        seats: { 'ds-seat': { stage: 'ready', pane: DS_PANE, workspace: 'fixture-ws-ds' } },
      };
    });
    live = liveWith({
      [LEAD_PANE]: claudeScreen('Opus 5.5'),
      [GLM_PANE]: claudeScreen('Opus 5.5'),
      [DS_PANE]: claudeScreen('Opus 4.6'),
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** The record the launch would have written: the signed model, and the launch line it ran. */
  function recordDs(launch: string): void {
    registerAgent(home, {
      name: 'ds-seat',
      signing: { model: 'DeepSeek Flash', version: 'V4.1', role: 'implementer' },
      lab: 'deepseek',
      cli: 'claude-code',
      launcher: null,
      launch,
      reach: { team: teamIdOf(root), seat: 'ds-seat', session: 'glow', pane: DS_PANE, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'the test',
    });
  }

  /** The check over one team file. */
  function checkOn(fileText: string) {
    writeFileSync(join(root, '.agents', 'team.yaml'), fileText);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => STATUS_NOW,
      home,
    });
    return { code, out: io.out, err: io.err };
  }

  test('the recorded wrapper launch speaks for the pane, not the file line', async () => {
    recordDs('claude-deepseek.sh');
    const { out } = checkOn(TEAM.replace('    launch: claude-deepseek.sh', '    launch: claude'));
    // The record ran a provider wrapper; the family on the pane is the CLI's own default, never
    // a drift from the signed declaration.
    expect(out).not.toContain('signs as');
  });

  test('a recorded bare launch is compared even when the file names a wrapper', async () => {
    recordDs('claude');
    const { out } = checkOn(TEAM);
    // The record ran the CLI itself, so the Claude family the pane prints contradicts the
    // foreign model the record signs, whatever line the file carries now.
    expect(out).toContain('signs as DeepSeek V4.1 Flash, runs Claude Opus 4.6');
  });
});

// The watch reads the same evidence as `team check`: the record's own cli and launch are what
// the running process was started from, and its model-drift check compares the pane with the
// registry's signing. A banner that writes the version words in another order names another
// version there too.
describe('team watch behind a provider wrapper', () => {
  const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

  function teamOf(fileText: string): TeamFile {
    const checked = validateTeamFile(fileText);
    if (!checked.ok) throw new Error(`the wrapper fixture does not validate: ${JSON.stringify(checked.errors)}`);
    return checked.team;
  }

  /** One pass with the glm seat ready, the screen the scene hands in, and the registry's signing
   *  for that seat; the file line may differ from the launch the record was made from. */
  function reportsOf(options: { fileLaunch?: string; signed: { model: string; version: string; launch: string }; screen: string }): string[] {
    const fileText =
      options.fileLaunch === undefined ? TEAM : TEAM.replace('    launch: claude-glm.sh', `    launch: ${options.fileLaunch}`);
    const team = teamOf(fileText);
    const state = emptySession();
    state.seats['glm-seat'] = { stage: 'ready', pane: GLM_PANE, workspace: 'fixture-ws-glm' };
    const live = liveWith({
      [LEAD_PANE]: claudeScreen('Opus 5.5'),
      [GLM_PANE]: options.screen,
      [DS_PANE]: claudeScreen('Opus 5.5'),
    });
    const signing = new Map([['glm-seat', { ...options.signed, cli: 'claude-code' }]]);
    return pass({ team, watch: team.watch, state, live, machine: fine, now: 0, memory: newMemory(), signing }).reports.map(
      (report) => report.text,
    );
  }

  /** The model-drift report for the glm seat, when the pass makes one. */
  const modelReports = (reports: string[]): string[] =>
    reports.filter((text) => text.startsWith('glm-seat runs ') && text.includes('signs with the wrong model'));

  test('the watch reports a banner id that writes the GLM version in another order', () => {
    const reports = reportsOf({
      signed: { model: 'GLM 5', version: '5.3', launch: 'claude-glm.sh' },
      screen: wrapperPane('glm-3.5') + claudeScreen('Opus 4.6'),
    });
    expect(modelReports(reports).some((text) => text.includes('the registry says GLM 5 5.3:'))).toBe(true);
  });

  test('the watch reports a banner id that writes the DeepSeek version in another order', () => {
    const reports = reportsOf({
      signed: { model: 'DeepSeek Flash', version: 'V4.1', launch: 'claude-deepseek.sh' },
      screen: wrapperPane('deepseek-v1.4-flash') + claudeScreen('Opus 4.6'),
    });
    expect(modelReports(reports).some((text) => text.includes('the registry says DeepSeek Flash V4.1:'))).toBe(true);
  });

  test('the watch reports nothing for a banner id naming the signed model', () => {
    const reports = reportsOf({
      signed: { model: 'GLM 5', version: '5.3', launch: 'claude-glm.sh' },
      screen: wrapperPane('glm-5.3') + claudeScreen('Opus 4.6'),
    });
    expect(modelReports(reports)).toEqual([]);
  });

  // The record's launch is the provenance: a file line saying the CLI itself does not turn a
  // recorded wrapper's screen into a drift, and a recorded bare launch is compared even when
  // the file names a wrapper.
  test('the watch takes a recorded wrapper launch over a file line naming the CLI', () => {
    const reports = reportsOf({
      fileLaunch: 'claude',
      signed: { model: 'GLM 5', version: '5.3', launch: 'claude-glm.sh' },
      screen: claudeScreen('Opus 4.6'),
    });
    expect(modelReports(reports)).toEqual([]);
  });

  test('the watch compares a recorded bare launch even when the file names a wrapper', () => {
    const reports = reportsOf({
      signed: { model: 'GLM 5', version: '5.3', launch: 'claude' },
      screen: claudeScreen('Opus 4.6'),
    });
    expect(modelReports(reports).some((text) => text.includes('runs Claude Opus 4.6') && text.includes('the registry says GLM 5 5.3:'))).toBe(true);
  });
});
