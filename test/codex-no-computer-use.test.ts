// A Codex seat whose `desktop_control` is false drives neither the user's desktop, browser nor
// connectors. The profile pins the six switches off (`computer_use`, `browser_use`,
// `browser_use_external`, `in_app_browser`, `browser_use_full_cdp_access`, `apps`), and the pin reaches
// both places a seat's turns are configured: the TUI's own launch line and the managed
// app-server's start words, because an attached TUI runs its turns under the server's
// configuration. The reuse check and `team check` read the same words, so a server started
// without the set is replaced, never reused.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { codexEndpointSocket, ensureCodexEndpoint, sameEndpointConfig, sameLiveEndpointFlags } from '../src/launch/codex-endpoint.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { featureMismatch, featureSettings, featureToggle, withPinnedFeatures } from '../src/launch/features.ts';
import { codexEndpointConfig, codexEndpointStartConfig, upPlan } from '../src/launch/plan.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand, pinnedRecordLine } from '../src/profiles/profile.ts';
import type { CodexEndpointRecord } from '../src/daemon/presence/endpoint-record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { shortSocketBase } from './helpers.ts';

const OFF = ['computer_use=false', 'browser_use=false', 'browser_use_external=false', 'in_app_browser=false', 'browser_use_full_cdp_access=false', 'apps=false'];
const CONFIG_OFF = [
  'mcp_servers.cua_repl.command=/usr/bin/false', 'mcp_servers.cua_repl.enabled=false',
  'mcp_servers.node_repl.command=/usr/bin/false', 'mcp_servers.node_repl.enabled=false',
  'plugins.computer-use@openai-bundled.enabled=false', 'plugins.unified-computer-use@openai-bundled.enabled=false',
  'plugins.browser@openai-bundled.enabled=false',
  'mcp_servers.codex_apps.command=/usr/bin/false', 'mcp_servers.codex_apps.enabled=false',
];
/** The words a launch takes for a seat whose `desktop_control` is false. */
const SET_FALSE = { desktopControl: false } as const;
const OFF_WORDS = [...OFF.flatMap((pair) => ['-c', `features.${pair}`]), ...CONFIG_OFF.flatMap((pair) => ['-c', pair])];
const SESSION = 'acme';
const SEAT = 'coder';
const BINDING = 'prs_0123456789ab';
const T0 = '2026-11-05T01:00:00.000Z';
const NOW = new Date('2026-11-05T01:05:00.000Z');

function codex() {
  const profile = profileFor('codex');
  if (!profile) throw new Error('codex profile must exist');
  return profile;
}

/** Every pinned name's effective value on the words, read the way the CLI reads them. */
function effective(words: readonly string[]): Record<string, boolean | undefined> {
  const settings = featureSettings('', words);
  return Object.fromEntries(OFF.map((pair) => [pair.split('=')[0]!, settings.get(pair.split('=')[0]!)]));
}

const ALL_OFF = { computer_use: false, browser_use: false, browser_use_external: false, in_app_browser: false, browser_use_full_cdp_access: false, apps: false };

describe('a seat set false pins computer, browser and connector use off', () => {
  test('the codex profile carries the six off pairs', () => {
    expect(codex().features).toEqual(OFF);
  });

  test('a seat launch line carries the pins, plain, wrapped and resumed', () => {
    for (const line of ['codex -m gpt-6.1-sol', 'zsh /w/as-floor.sh codex -m gpt-6.1-sol', 'codex -m gpt-6.1-sol resume 01a1']) {
      const command = launchCommand(codex(), line, 'Rules.', null, undefined, undefined, SET_FALSE);
      for (const pair of OFF) expect(command).toContain(`-c features.${pair}`);
      expect(effective(OFF_WORDS)).toEqual(ALL_OFF);
      expect(Object.fromEntries(OFF.map((pair) => [pair.split('=')[0]!, featureSettings(command).get(pair.split('=')[0]!)]))).toEqual(ALL_OFF);
    }
  });

  test('a line that turns one on is overridden by the pin, which comes last', () => {
    const command = launchCommand(codex(), 'codex -m gpt-6.1-sol -c features.computer_use=true --enable browser_use', 'Rules.', null, undefined, undefined, SET_FALSE);
    expect(featureSettings(command).get('computer_use')).toBe(false);
    expect(featureSettings(command).get('browser_use')).toBe(false);
  });

  test('the recorded base recipe carries the pins, and one without them is named', () => {
    const recorded = pinnedRecordLine('codex', 'zsh /w/as-floor.sh codex -m gpt-6.1-sol', codex().features);
    expect(featureMismatch(recorded, codex().features)).toBeNull();
    expect(featureMismatch('zsh /w/as-floor.sh codex -m gpt-6.1-sol', codex().features)).toContain('does not pin features.computer_use=false');
  });
});

describe('--enable and --disable read as the feature pairs they stand for', () => {
  test('spaced and joined spellings', () => {
    expect(featureToggle('--disable', 'computer_use')).toEqual({ name: 'computer_use', value: false, took: true });
    expect(featureToggle('--enable=browser_use', undefined)).toEqual({ name: 'browser_use', value: true, took: false });
    expect(featureToggle('--disable', '--model')).toBeNull();
    expect(featureToggle('-c', 'features.x=false')).toBeNull();
  });

  test('the line reader and the endpoint config both read them, and stop at --', () => {
    expect(featureSettings('codex --disable computer_use --enable=in_app_browser').get('computer_use')).toBe(false);
    expect(featureSettings('codex --disable computer_use --enable=in_app_browser').get('in_app_browser')).toBe(true);
    expect(featureSettings('codex -- --enable computer_use').get('computer_use')).toBeUndefined();
    expect(codexEndpointConfig('codex --disable computer_use --enable=in_app_browser -- --enable browser_use')).toEqual([
      '-c', 'features.computer_use=false',
      '-c', 'features.in_app_browser=true',
    ]);
  });
});

describe('the managed app-server of a seat set false starts with the set', () => {
  test('a line with no pins of its own still gives the server all of them', () => {
    expect(codexEndpointStartConfig('zsh /w/as-floor.sh codex -m gpt-6.1-sol -a never', false)).toEqual([
      '-c', 'approval_policy="never"',
      ...OFF_WORDS,
    ]);
  });

  test('a launch command already carrying the pins is not given them twice', () => {
    const command = launchCommand(codex(), 'codex -m gpt-6.1-sol', 'Rules.', null, undefined, undefined, SET_FALSE);
    const config = codexEndpointStartConfig(command, false);
    expect(config.filter((word) => word === 'features.computer_use=false')).toHaveLength(1);
    expect(effective(config)).toEqual(ALL_OFF);
  });

  test('a line that turns one on gets the pin after it', () => {
    const config = codexEndpointStartConfig('codex -c features.computer_use=true --enable browser_use', false);
    expect(effective(config)).toEqual(ALL_OFF);
    expect(withPinnedFeatures(['-c', 'features.computer_use=true'], ['computer_use=false'])).toEqual([
      '-c', 'features.computer_use=true', '-c', 'features.computer_use=false',
    ]);
  });

  test('the launch hands the endpoint the pinned config, and the TUI line carries it too', async () => {
    const plan = upPlan({
      root: '/tmp/acme', session: SESSION, sessionRunning: true, watchAlive: true, watchLabel: 'Watch · acme',
      stateDir: '/tmp/acme/.agents',
      seats: [{
        name: SEAT, cli: 'codex', launch: 'zsh /w/as-floor.sh codex -m gpt-6.1-sol', cwd: '/tmp/acme', label: SEAT,
        stopped: false, rules: 'Rules.', repairLine: 'repair', codexDaemon: 'on', desktopControl: false,
      }],
    });
    const at = plan.findIndex((step) => step.do?.do === 'launch');
    expect(plan[at]?.do).toMatchObject({ do: 'launch', codexEndpoint: { dir: '/tmp/acme/.agents' } });
    const seen: (string[] | undefined)[] = [];
    const ran: string[] = [];
    const url = 'unix:///tmp/acme/.agents/run/acme/coder/prs_0123456789ab.sock';
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: (_s, _p, command) => { ran.push(command); return true; },
      managedCodexEndpoint: async (input) => { seen.push(input.config); return { kind: 'up', url, started: true }; },
      typeLine: () => false,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: () => {},
    };
    await executePlan(plan.slice(0, at + 1), SESSION, host);
    expect(seen).toHaveLength(1);
    expect(effective(seen[0]!)).toEqual(ALL_OFF);
    expect(ran).toHaveLength(1);
    for (const pair of OFF) expect(ran[0]).toContain(`-c features.${pair}`);
    expect(ran[0]).toContain(`--remote ${url}`);
  });

  test('the spawned server argv carries the set, and a live server without it is replaced', async () => {
    const dir = mkdtempSync(join(shortSocketBase(), 'cnc-'));
    try {
      const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
      if (socket === null) throw new Error('expected socket');
      const old = ['-c', 'approval_policy="never"'];
      const prior: CodexEndpointRecord = { url: socket.url, binding: BINDING, pid: 700, started_at: T0, config: old };
      updateState(dir, (state) => {
        const session = (state.sessions[SESSION] ??= emptySession());
        session.seats[SEAT] = { stage: 'ready', pane: 'p1', workspace: 'w1', presence_binding: BINDING, codex_endpoint: prior };
      });
      const needed = codexEndpointStartConfig('codex -a never', false);
      // The reuse comparison treats the pins as the team's settings: the old record and the old
      // live command line both fall short of them.
      expect(sameEndpointConfig(old, needed)).toBe(false);
      expect(sameLiveEndpointFlags(`codex app-server --listen ${socket.url} ${old.join(' ')}`, socket.url, needed)).toBe(false);
      expect(sameLiveEndpointFlags(`codex app-server --listen ${socket.url} ${needed.join(' ')}`, socket.url, needed)).toBe(true);
      const spawned: string[][] = [];
      const terminated: number[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, config: needed,
        deps: {
          alive: (pid) => pid === 700 && terminated.length === 0,
          commandOf: () => `codex app-server --listen ${socket.url} ${old.join(' ')}`,
          startOf: () => Date.parse(T0) + 200,
          isPlainDir: () => true,
          isSocket: () => true,
          drop: () => {},
          sleep: async () => {},
          now: () => NOW,
          terminate: (pid) => { terminated.push(pid); },
          spawn: (input) => { spawned.push(['app-server', '--listen', input.url, ...(input.config ?? [])]); return { pid: 801 }; },
        },
      });
      expect(terminated).toEqual([700]);
      expect(answer).toEqual({ kind: 'up', url: socket.url, started: true });
      expect(spawned).toEqual([['app-server', '--listen', socket.url, '-c', 'approval_policy="never"', ...OFF_WORDS]]);
      expect(readState(dir).sessions[SESSION]?.seats[SEAT]?.codex_endpoint?.config).toEqual(needed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
