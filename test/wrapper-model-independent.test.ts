// What `team status` and `team send` read for a seat that runs another maker's model through a
// provider wrapper in front of Claude Code. Claude Code's own status line prints its own family
// whatever provider the launcher selected, so the wrapper's declaration — or the provider id on
// its banner — is the seat's model. A bare Claude Code launch keeps the screen reading, where the
// Claude family is the contradiction the declared model needs. Every pane here is synthetic.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runSend } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Standing } from '../src/store/store.ts';
import { recordBody, testIo, type TestIo } from './helpers.ts';
import { dropDir, fake, filed, owner, scripted, world, type World } from './send-native-fixtures.ts';

const STATUS_NOW = new Date('2026-10-31T09:00:00Z');

const LEAD_PANE = 'fixture-pane-lead';
const GLM_PANE = 'fixture-pane-glm';
const DS_PANE = 'fixture-pane-ds';

const claudeScreen = (model: string) =>
  `❯ \n${'─'.repeat(40)}\n  main · …/glow · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
const banner = (id: string) => `  ${id} · API Usage Billing\n`;

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
    const { host, pane } = sendHost(made, claudeScreen('Opus 4.6') + banner('deepseek-v4.1'));
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
    const { host } = sendHost(made, claudeScreen('Opus 4.6') + banner('glm-5.3'));
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
});
