// The `desktop_control` setting: whether a seat may control the computer (computer use, the
// user's browser, desktop apps). Off by default, settable at team and seat level, the seat's
// word winning. Off, a Codex seat's line, recorded recipe and managed app-server carry the
// feature pins and the computer and browser MCP and plugin pins; a Claude Code seat's settings
// file denies the computer and browser MCP tools; `team doctor` and `team check` name a seat
// whose recorded line lacks them. On, none of these is placed.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { installCliHooks } from '../src/launch/cli-hook.ts';
import { CLAUDE_DESKTOP_DENY, claudeDesktopDeny, seatDesktopControl } from '../src/launch/desktop-control.ts';
import { DESKTOP_PIN_GAP, featureSettings, pinMismatch, seatPins, seatPinWords } from '../src/launch/features.ts';
import { codexEndpointStartConfig, upPlan } from '../src/launch/plan.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand, pinnedRecordLine } from '../src/profiles/profile.ts';
import { resolveDesktopControl } from '../src/settings/desktop-control.ts';
import { emptySession, updateState, type SeatState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const FEATURES_OFF = ['computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'browser_use_full_cdp_access'];
const CONFIG_OFF = [
  'mcp_servers.cua_repl.command=/usr/bin/false', 'mcp_servers.cua_repl.enabled=false',
  'mcp_servers.node_repl.command=/usr/bin/false', 'mcp_servers.node_repl.enabled=false',
  'plugins.computer-use@openai-bundled.enabled=false', 'plugins.unified-computer-use@openai-bundled.enabled=false',
  'plugins.browser@openai-bundled.enabled=false',
];
const CLI = 'codex -m gpt-6.1-sol';
const SESSION = 'acme';
const NOW = new Date('2026-11-22T09:00:00Z');

function codex() {
  const profile = profileFor('codex');
  if (!profile) throw new Error('codex profile must exist');
  return profile;
}

/** A minimal valid team file with one Codex worker; `extra` lines go at the top level and
 *  `seatExtra` on the worker. */
function teamText(extra = '', seatExtra = ''): string {
  return `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
${extra}seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: ${CLI}
${seatExtra}`;
}

function team(extra = '', seatExtra = '') {
  const read = validateTeamFile(teamText(extra, seatExtra));
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  return read.team;
}

describe('the setting resolves nearest first, off by default', () => {
  test('off when nothing writes it', () => {
    expect(resolveDesktopControl({})).toBe(false);
    expect(seatDesktopControl({ team: team(), seat: 'worker' })).toBe(false);
  });

  test('the team word stands for a seat that writes none', () => {
    expect(seatDesktopControl({ team: team('desktop_control: true\n'), seat: 'worker' })).toBe(true);
  });

  test('the seat word wins over the team word, both ways', () => {
    expect(seatDesktopControl({ team: team('desktop_control: true\n', '    desktop_control: false\n'), seat: 'worker' })).toBe(false);
    expect(seatDesktopControl({ team: team('', '    desktop_control: true\n'), seat: 'worker' })).toBe(true);
    expect(seatDesktopControl({ team: team('', '    desktop_control: true\n'), seat: 'lead' })).toBe(false);
  });

  test('a signed seat record beats the seat file word; a wider record stands under it', () => {
    expect(resolveDesktopControl({ seat: false, record: { level: 'seat', value: true } })).toBe(true);
    expect(resolveDesktopControl({ seat: false, record: { level: 'team', value: true } })).toBe(false);
    expect(resolveDesktopControl({ team: false, record: { level: 'team', value: true } })).toBe(true);
  });

  test('a word that is not true or false is refused at both levels', () => {
    for (const text of [teamText('desktop_control: yes\n'), teamText('', '    desktop_control: "true"\n')]) {
      const read = validateTeamFile(text);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(JSON.stringify(read.errors)).toContain('desktop_control must be true or false');
    }
  });
});

describe('a Codex seat with desktop control off carries every computer and browser pin', () => {
  test('the profile declares the five feature names and the config pairs', () => {
    expect(codex().desktopControl?.features).toEqual(FEATURES_OFF);
    expect(codex().desktopControl?.config).toEqual(CONFIG_OFF);
    expect(seatPins(codex(), false)).toEqual({ features: FEATURES_OFF.map((name) => `${name}=false`), config: CONFIG_OFF });
    expect(seatPins(codex(), true)).toEqual({ features: [], config: [] });
  });

  test('the launch line: off carries the pins as bare words; on carries none', () => {
    const off = launchCommand(codex(), CLI, 'Rules.', null, undefined, undefined, {});
    for (const name of FEATURES_OFF) expect(featureSettings(off).get(name)).toBe(false);
    for (const pair of CONFIG_OFF) expect(off).toContain(` -c ${pair}`);
    const on = launchCommand(codex(), CLI, 'Rules.', null, undefined, undefined, { desktopControl: true });
    expect(on).not.toContain('features.');
    expect(on).not.toContain('mcp_servers.');
    expect(on).not.toContain('plugins.');
  });

  test('the managed app-server start words follow the seat', () => {
    const off = codexEndpointStartConfig(`${CLI} -a never`);
    expect(off).toEqual(['-c', 'approval_policy="never"', ...seatPinWords(seatPins(codex(), false))]);
    expect(codexEndpointStartConfig(`${CLI} -a never`, true)).toEqual(['-c', 'approval_policy="never"']);
  });

  test('the plan: a seat the team file turns on launches without pins, its op says so', () => {
    const plan = (file: ReturnType<typeof team>) => {
      const steps = upPlan({
        root: '/tmp/acme', session: SESSION, sessionRunning: true, watchAlive: true, watchLabel: 'Watch · acme',
        stateDir: '/tmp/acme/.agents', team: file,
        seats: [{ name: 'worker', cli: 'codex', launch: CLI, cwd: '/tmp/acme', label: 'worker', stopped: false, rules: 'Rules.', repairLine: 'repair' }],
      });
      const launch = steps.map((step) => step.do).find((op) => op?.do === 'launch');
      if (launch?.do !== 'launch') throw new Error('the plan holds no launch');
      return launch;
    };
    const off = plan(team());
    expect(off.command).toContain('-c mcp_servers.cua_repl.enabled=false');
    expect(off.recordLine).toBe(pinnedRecordLine('codex', CLI, seatPins(codex(), false).features, CONFIG_OFF));
    expect(off.desktopControl).toBeUndefined();
    const on = plan(team('', '    desktop_control: true\n'));
    expect(on.command).not.toContain('features.computer_use');
    expect(on.command).not.toContain('cua_repl');
    expect(on.command).not.toContain('plugins.');
    expect(on.recordLine).toBe(CLI);
    expect(on.desktopControl).toBe(true);
  });

  test('a recorded line without the pins is named; one with them, or a seat turned on, is not', () => {
    const pins = seatPins(codex(), false);
    expect(pinMismatch(pinnedRecordLine('codex', CLI, pins.features, pins.config), pins)).toBeNull();
    const said = pinMismatch(`${CLI} ${seatPinWords({ features: pins.features, config: [] }).join(' ')}`, pins);
    expect(said).toContain('does not pin mcp_servers.cua_repl.command=/usr/bin/false');
    expect(said).toContain(DESKTOP_PIN_GAP);
    expect(said).not.toContain('features.computer_use');
    expect(pinMismatch(CLI, seatPins(codex(), true))).toBeNull();
  });
});

describe('a Claude Code seat with desktop control off denies the computer and browser tools', () => {
  let base = '';
  afterEach(() => {
    if (base !== '') rmSync(base, { recursive: true, force: true });
    base = '';
  });

  test('the settings file carries the deny when off and none when on', () => {
    base = mkdtempSync(join(tmpdir(), 'team-desktop-hook-'));
    const dir = join(base, '.agents');
    mkdirSync(dir, { recursive: true });
    const landed = installCliHooks(dir, SESSION, [
      { name: 'off', cli: 'claude-code', launch: 'claude' },
      { name: 'on', cli: 'claude-code', launch: 'claude', desktopControl: true },
    ]);
    const read = (seat: string) => JSON.parse(readFileSync(landed[seat]!, 'utf8')) as { permissions?: { deny?: string[] }; hooks?: unknown };
    expect(read('off').permissions?.deny).toEqual([...CLAUDE_DESKTOP_DENY]);
    expect(read('off').hooks).toBeDefined();
    expect(read('on').permissions).toBeUndefined();
    expect(claudeDesktopDeny(undefined)).toEqual(['mcp__computer-use', 'mcp__claude-in-chrome', 'mcp__Claude_Browser']);
  });

  test('a read-only shipped seat keeps its own deny beside the desktop one', () => {
    base = mkdtempSync(join(tmpdir(), 'team-desktop-hook-'));
    const dir = join(base, '.agents');
    mkdirSync(dir, { recursive: true });
    const landed = installCliHooks(dir, SESSION, [{ name: 'rev', cli: 'claude-code', launch: 'claude', launcher: 'claude-code', role: 'reviewer' }]);
    const settings = JSON.parse(readFileSync(landed.rev!, 'utf8')) as { permissions: { deny: string[] }; sandbox?: unknown };
    expect(settings.permissions.deny).toEqual(['Edit(**)', ...CLAUDE_DESKTOP_DENY]);
    expect(settings.sandbox).toBeDefined();
  });
});

describe('team doctor and team check name a seat whose recorded line lacks the off pins', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function place(text: string, held: Partial<SeatState>): { root: string; home: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-desktop-check-')));
    made.push(base);
    const root = join(base, 'acme');
    const home = join(base, 'home');
    const dir = join(root, '.agents');
    mkdirSync(dir, { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
    writeFileSync(join(dir, 'team.yaml'), text);
    updateState(dir, (state) => {
      state.sessions[SESSION] = { ...emptySession(), seats: { worker: { stage: 'ready', pane: 'fixture-pane-two', workspace: 'fixture-ws-two', ...held } } };
    });
    return { root, home };
  }

  const sources = (home: string): DoctorSources => ({
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  });

  async function doctorFindings(text: string, line: string): Promise<{ level: string; text: string }[]> {
    const { root, home } = place(text, { launch_line: line });
    const io = testIo(root, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml', '--json'], io, sources(home));
    return (JSON.parse(io.out) as { findings: { level: string; text: string }[] }).findings;
  }

  test('doctor: an off seat whose line lacks the pins is a miss naming the relaunch', async () => {
    const pins = seatPins(codex(), false);
    const featuresOnly = `${CLI} ${seatPinWords({ features: pins.features, config: [] }).join(' ')}`;
    const found = (await doctorFindings(teamText(), featuresOnly)).filter((finding) => finding.text.includes(DESKTOP_PIN_GAP));
    expect(found).toHaveLength(1);
    expect(found[0]!.level).toBe('miss');
    expect(found[0]!.text).toContain('worker: its recorded launch line does not pin mcp_servers.cua_repl.command=/usr/bin/false');
    expect(found[0]!.text).toContain('run `team restart worker`');
  });

  test('doctor: the full pinned line, and an on seat with no pins, are not named', async () => {
    const pins = seatPins(codex(), false);
    const full = pinnedRecordLine('codex', CLI, pins.features, pins.config);
    expect((await doctorFindings(teamText(), full)).some((finding) => finding.text.includes('its recorded launch line'))).toBe(false);
    const on = await doctorFindings(teamText('', '    desktop_control: true\n'), CLI);
    expect(on.some((finding) => finding.text.includes('its recorded launch line'))).toBe(false);
  });

  test('check: the same gap is a difference with the relaunch as its repair', () => {
    const { root, home } = place(teamText(), { launch_line: CLI });
    const live: Live = {
      running: true,
      agents: [{ name: 'worker', agent: 'codex', pane: 'fixture-pane-two', workspace: 'fixture-ws-two', status: 'idle', cwd: null }],
      workspaces: [{ id: 'fixture-ws-two', label: 'worker' }],
      screens: {},
    };
    const io = testIo(root, { kind: 'owner' });
    runTeamCheck({ file: '.agents/team.yaml' }, io, { live: () => live, branch: () => 'main', standing: (at) => approvalStanding(at, home), now: () => NOW, home });
    const out = `${io.out}${io.err}`;
    expect(out).toContain(`worker: its recorded launch line does not pin features.computer_use=false`);
    expect(out).toContain(DESKTOP_PIN_GAP);
    expect(out).toContain('repair: team restart worker');
  });
});
