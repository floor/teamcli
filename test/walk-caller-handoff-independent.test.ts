// Independent verification of fix/walk-caller-handoff (security surface: caller placement):
// 1. No server (`herdr`) ancestor plus a hinted pane (`HERDR_PANE_ID`) whose reported root pid is an
//    ancestor answers `{ kind: 'unplaced', reason: 'it runs under herdr' }` in `walkCaller` and gives
//    the dev-mode lead lift end-to-end (`team config set`, `team add`).
// 2. The variable alone, a reported root pid that is not an ancestor, a failed server read (`null`),
//    and no hint (`undefined` or `''`) each keep the refusal and leave team records untouched.
// 3. No agent-list read (`agents()`) ever happens in the sessionless (`session === undefined`) walk.
// All processes, panes, signers, launches, and repositories are synthetic in-memory fakes.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { walkCaller, type CallerSources, type Process } from '../src/caller.ts';
import { runConfig } from '../src/commands/config.ts';
import { runSettings } from '../src/commands/settings.ts';
import { devModeOwnerLiftAtCwd } from '../src/dev_mode.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T09:45:00.000Z');

// Re-parented pane process chain after a live server handoff: no `herdr` process in ancestors.
const REPARENTED_CHAIN: Process[] = [
  { pid: 3420, name: 'bun' },
  { pid: 3410, name: 'claude' },
  { pid: 3400, name: 'zsh' },
  { pid: 1, name: 'launchd' },
];

interface CallRecord {
  session: string | undefined;
  op: 'agents' | `paneRootPid:${string}`;
}

function makeAgent(name: string | null, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: 'ws-1', status: 'idle', cwd: null };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createFixtureRepo(): { root: string; home: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'walk-handoff-ind-')));
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });

  const file = join(root, '.agents', 'team.yaml');
  const text = `format: 1
project: acme
entity: floor
session: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobbies/floor
  - ${root}
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: builder
    label: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;
  writeFileSync(file, text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(loaded.team, root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead' },
        worker: { stage: 'ready', pane: 'pane-worker' },
      },
      worktrees: {},
    };
  });
  upsertTeam(home, teamIdOf(root), { project: 'acme', entity: 'floor', session: 'acme', root, roster: [], by: 'test' });
  const dev = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'synthetic-fixture' });
  if (!dev.ok) throw new Error(dev.why);
  return { root, home, file };
}

function readLog(root: string): string {
  const p = join(root, '.agents', 'team.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('1. sessionless walkCaller handoff proof and zero agent-list reads', () => {
  test('no server ancestor + hinted pane whose root pid is an ancestor returns under-herdr with zero agent-list reads', () => {
    const calls: CallRecord[] = [];
    const walked = walkCaller({
      env: { HERDR_PANE_ID: 'pane-lead' },
      stdinIsTTY: false,
      callerSources: (session) => ({
        ancestors: () => REPARENTED_CHAIN,
        agents: () => {
          calls.push({ session, op: 'agents' });
          return [makeAgent('lead', 'pane-lead')];
        },
        paneRootPid: (pane) => {
          calls.push({ session, op: `paneRootPid:${pane}` });
          return pane === 'pane-lead' ? 3400 : null;
        },
        env: { HERDR_PANE_ID: 'pane-lead' },
        stdinIsTTY: false,
      }),
    });

    expect(walked).toEqual({ kind: 'unplaced', reason: 'it runs under herdr' });
    expect(calls).toEqual([{ session: undefined, op: 'paneRootPid:pane-lead' }]);
    expect(calls.filter((c) => c.op === 'agents')).toEqual([]);
  });

  test('the variable alone, a non-ancestor root pid, a failed server read, and no hint each keep the refusal with zero agent-list reads', () => {
    // (a) Variable alone (HERDR_PANE set without HERDR_PANE_ID, or non-CLI shell with HERDR_PANE_ID whose root is not an ancestor)
    const varOnlyCalls: CallRecord[] = [];
    const varOnlyWalked = walkCaller({
      env: { HERDR_PANE: 'pane-lead' },
      stdinIsTTY: false,
      callerSources: (session) => ({
        ancestors: () => REPARENTED_CHAIN,
        agents: () => {
          varOnlyCalls.push({ session, op: 'agents' });
          return [makeAgent('lead', 'pane-lead')];
        },
        paneRootPid: (pane) => {
          varOnlyCalls.push({ session, op: `paneRootPid:${pane}` });
          return 3400;
        },
        env: { HERDR_PANE: 'pane-lead' },
        stdinIsTTY: false,
      }),
    });
    expect(varOnlyWalked).toEqual({
      kind: 'unplaced',
      reason: 'it is run by an agent (claude) outside herdr',
    });
    expect(varOnlyCalls).toEqual([]);

    // (b) Reported root pid is not an ancestor (9999 not in REPARENTED_CHAIN)
    const wrongRootCalls: CallRecord[] = [];
    const wrongRootWalked = walkCaller({
      env: { HERDR_PANE_ID: 'pane-lead' },
      stdinIsTTY: false,
      callerSources: (session) => ({
        ancestors: () => REPARENTED_CHAIN,
        agents: () => {
          wrongRootCalls.push({ session, op: 'agents' });
          return [makeAgent('lead', 'pane-lead')];
        },
        paneRootPid: (pane) => {
          wrongRootCalls.push({ session, op: `paneRootPid:${pane}` });
          return 9999;
        },
        env: { HERDR_PANE_ID: 'pane-lead' },
        stdinIsTTY: false,
      }),
    });
    expect(wrongRootWalked).toEqual({
      kind: 'unplaced',
      reason:
        'it is run by an agent (claude) outside herdr: its environment names pane pane-lead, but no herdr server is among its parent processes, so the agent was detached from that pane (for example a Claude Code background session); run the seat in its pane again (team restart <seat>)',
    });
    expect(wrongRootCalls).toEqual([{ session: undefined, op: 'paneRootPid:pane-lead' }]);

    // (c) Server read fails (`paneRootPid` returns `null`)
    const failedReadCalls: CallRecord[] = [];
    const failedReadWalked = walkCaller({
      env: { HERDR_PANE_ID: 'pane-lead' },
      stdinIsTTY: false,
      callerSources: (session) => ({
        ancestors: () => REPARENTED_CHAIN,
        agents: () => {
          failedReadCalls.push({ session, op: 'agents' });
          return [makeAgent('lead', 'pane-lead')];
        },
        paneRootPid: (pane) => {
          failedReadCalls.push({ session, op: `paneRootPid:${pane}` });
          return null;
        },
        env: { HERDR_PANE_ID: 'pane-lead' },
        stdinIsTTY: false,
      }),
    });
    expect(failedReadWalked).toEqual({
      kind: 'unplaced',
      reason:
        'it is run by an agent (claude) outside herdr: its environment names pane pane-lead, but no herdr server is among its parent processes, so the agent was detached from that pane (for example a Claude Code background session); run the seat in its pane again (team restart <seat>)',
    });
    expect(failedReadCalls).toEqual([{ session: undefined, op: 'paneRootPid:pane-lead' }]);

    // (d) No hint (`undefined` or `''`) never queries paneRootPid or agents
    for (const env of [{}, { HERDR_PANE_ID: '' }] as Record<string, string | undefined>[]) {
      const noHintCalls: CallRecord[] = [];
      const noHintWalked = walkCaller({
        env,
        stdinIsTTY: false,
        callerSources: (session) => ({
          ancestors: () => REPARENTED_CHAIN,
          agents: () => {
            noHintCalls.push({ session, op: 'agents' });
            return [makeAgent('lead', 'pane-lead')];
          },
          paneRootPid: (pane) => {
            noHintCalls.push({ session, op: `paneRootPid:${pane}` });
            return 3400;
          },
          env,
          stdinIsTTY: false,
        }),
      });
      expect(noHintWalked).toEqual({
        kind: 'unplaced',
        reason: 'it is run by an agent (claude) outside herdr',
      });
      expect(noHintCalls).toEqual([]);
    }
  });
});

describe('2. end-to-end dev-mode lead lift and refusal preservation across config set, settings set, and devModeOwnerLiftAtCwd', () => {
  function makeSourcesFor(
    calls: CallRecord[],
    opts: {
      env?: Record<string, string | undefined>;
      rootPidFor?: (pane: string, session?: string) => number | null;
    } = {},
  ): (session?: string) => CallerSources {
    const env = opts.env ?? { HERDR_PANE_ID: 'pane-lead', TEAMCLI_DEV_MODE: '1' };
    return (session?: string) => ({
      ancestors: () => REPARENTED_CHAIN,
      agents: () => {
        calls.push({ session, op: 'agents' });
        return [makeAgent('lead', 'pane-lead'), makeAgent('worker', 'pane-worker')];
      },
      paneRootPid: (pane) => {
        calls.push({ session, op: `paneRootPid:${pane}` });
        return opts.rootPidFor ? opts.rootPidFor(pane, session) : pane === 'pane-lead' ? 3400 : pane === 'pane-worker' ? 3500 : null;
      },
      env,
      stdinIsTTY: false,
    });
  }

  test('no server ancestor + hinted pane with ancestor root pid admits the lead through dev-mode lift for config set, settings set, and devModeOwnerLiftAtCwd, with zero sessionless agent reads', async () => {
    const fx = createFixtureRepo();

    // 1. Direct `devModeOwnerLiftAtCwd`
    const liftCalls: CallRecord[] = [];
    const liftIo = testIo(fx.root);
    liftIo.env = { HERDR_PANE_ID: 'pane-lead', TEAMCLI_DEV_MODE: '1' };
    liftIo.callerSources = makeSourcesFor(liftCalls);
    const lift = devModeOwnerLiftAtCwd(liftIo, {
      command: 'config',
      refusal: "only the owner edits the team's record",
      home: fx.home,
      now: NOW,
      audit: 'later',
    });
    expect(lift).not.toBeNull();
    expect(lift?.lifted).toBe(true);
    expect(lift?.role).toBe('lead');
    expect(lift?.caller).toEqual({ kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    expect(liftCalls.filter((c) => c.session === undefined && c.op === 'agents')).toEqual([]);
    expect(liftCalls.filter((c) => c.session === undefined)).toEqual([
      { session: undefined, op: 'paneRootPid:pane-lead' },
    ]);

    // 2. End-to-end `team config set`
    const cfgCalls: CallRecord[] = [];
    const cfgIo = testIo(fx.root);
    cfgIo.env = { HERDR_PANE_ID: 'pane-lead', TEAMCLI_DEV_MODE: '1' };
    cfgIo.callerSources = makeSourcesFor(cfgCalls);
    const cfgCode = await runConfig(
      ['set', 'seats.worker.model', 'Claude Sonnet'],
      cfgIo,
      { home: fx.home, env: cfgIo.env, now: () => NOW },
    );
    expect(cfgCode, cfgIo.err).toBe(0);
    expect(cfgIo.err).toBe(
      "warning: only the owner edits the team's record, from a terminal outside herdr; this call is lead; dev mode continues (dev-mode on at machine level)\n",
    );
    expect(readFileSync(fx.file, 'utf8')).toContain('    model: Claude Sonnet\n');
    expect(readLog(fx.root)).toContain(
      "config [lead] warning: only the owner edits the team's record, from a terminal outside herdr; this call is lead; dev mode continues (dev-mode on at machine level); admitted as lead\n",
    );

    // 3. End-to-end `team settings set` (which uses `walkCaller` directly before `devModeOwnerLiftAtCwd`)
    const setCalls: CallRecord[] = [];
    const setIo = testIo(fx.root);
    setIo.env = { HERDR_PANE_ID: 'pane-lead', TEAMCLI_DEV_MODE: '1' };
    setIo.callerSources = makeSourcesFor(setCalls);
    const setCode = await runSettings(
      ['set', 'worker', 'effort', 'high'],
      setIo,
      { home: fx.home, now: NOW },
    );
    expect(setCode, setIo.err).toBe(0);
    expect(setIo.err).toContain('dev mode continues (dev-mode on at machine level)');
    expect(setCalls.filter((c) => c.session === undefined && c.op === 'agents')).toEqual([]);
    expect(setCalls.filter((c) => c.session === undefined)).toEqual([
      { session: undefined, op: 'paneRootPid:pane-lead' },
      { session: undefined, op: 'paneRootPid:pane-lead' },
    ]);
  });

  test('variable alone, non-ancestor root pid, failed server read, no hint, and handoff plain seat each keep their refusal on devModeOwnerLiftAtCwd, config set, and settings set', async () => {
    const fx = createFixtureRepo();
    const beforeYaml = readFileSync(fx.file, 'utf8');

    const scenarios: {
      name: string;
      env: Record<string, string | undefined>;
      rootPidFor: (pane: string) => number | null;
      expectedConfigErr: string;
      expectedSettingsErr: string;
      expectedSessionlessQueries: CallRecord[];
    }[] = [
      {
        name: 'variable alone (HERDR_PANE without HERDR_PANE_ID)',
        env: { HERDR_PANE: 'pane-lead', TEAMCLI_DEV_MODE: '1' },
        rootPidFor: () => 3400,
        expectedConfigErr: 'this call is unplaced (it is run by an agent (claude) outside herdr)',
        expectedSettingsErr: 'this call is unplaced (it is run by an agent (claude) outside herdr)',
        expectedSessionlessQueries: [],
      },
      {
        name: 'root pid is not an ancestor (9999)',
        env: { HERDR_PANE_ID: 'pane-lead', TEAMCLI_DEV_MODE: '1' },
        rootPidFor: () => 9999,
        expectedConfigErr: 'its environment names pane pane-lead, but no herdr server is among its parent processes',
        expectedSettingsErr: 'its environment names pane pane-lead, but no herdr server is among its parent processes',
        expectedSessionlessQueries: [{ session: undefined, op: 'paneRootPid:pane-lead' }],
      },
      {
        name: 'failed server read (null)',
        env: { HERDR_PANE_ID: 'pane-lead', TEAMCLI_DEV_MODE: '1' },
        rootPidFor: () => null,
        expectedConfigErr: 'its environment names pane pane-lead, but no herdr server is among its parent processes',
        expectedSettingsErr: 'its environment names pane pane-lead, but no herdr server is among its parent processes',
        expectedSessionlessQueries: [{ session: undefined, op: 'paneRootPid:pane-lead' }],
      },
      {
        name: 'no hint (empty)',
        env: { TEAMCLI_DEV_MODE: '1' },
        rootPidFor: () => 3400,
        expectedConfigErr: 'this call is unplaced (it is run by an agent (claude) outside herdr)',
        expectedSettingsErr: 'this call is unplaced (it is run by an agent (claude) outside herdr)',
        expectedSessionlessQueries: [],
      },
      {
        name: 'handoff plain seat (pane-worker with ancestor root pid 3400)',
        env: { HERDR_PANE_ID: 'pane-worker', TEAMCLI_DEV_MODE: '1' },
        rootPidFor: (pane) => (pane === 'pane-worker' ? 3400 : null),
        expectedConfigErr: 'this call is worker',
        expectedSettingsErr: 'this call is unplaced (it runs under herdr)',
        expectedSessionlessQueries: [
          { session: undefined, op: 'paneRootPid:pane-worker' },
        ],
      },
    ];

    for (const s of scenarios) {
      // 1. `devModeOwnerLiftAtCwd` refuses and never reads `agents` in the sessionless walk
      const liftCalls: CallRecord[] = [];
      const liftIo = testIo(fx.root);
      liftIo.env = { ...s.env };
      liftIo.callerSources = makeSourcesFor(liftCalls, { env: s.env, rootPidFor: s.rootPidFor });
      const lift = devModeOwnerLiftAtCwd(liftIo, {
        command: 'config',
        refusal: "only the owner edits the team's record",
        home: fx.home,
        now: NOW,
      });
      expect(lift === null || !lift.lifted, `lift for ${s.name}`).toBe(true);
      expect(liftCalls.filter((c) => c.session === undefined && c.op === 'agents')).toEqual([]);
      expect(liftCalls.filter((c) => c.session === undefined)).toEqual(s.expectedSessionlessQueries);

      // 2. `team config set` refused
      const cfgCalls: CallRecord[] = [];
      const cfgIo = testIo(fx.root);
      cfgIo.env = { ...s.env };
      cfgIo.callerSources = makeSourcesFor(cfgCalls, { env: s.env, rootPidFor: s.rootPidFor });
      const cfgCode = await runConfig(
        ['set', 'seats.worker.model', 'Claude Sonnet'],
        cfgIo,
        { home: fx.home, env: cfgIo.env as Record<string, string>, now: () => NOW },
      );
      expect(cfgCode, `config set for ${s.name}`).toBe(1);
      expect(cfgIo.err).toContain(s.expectedConfigErr);
      expect(readFileSync(fx.file, 'utf8')).toBe(beforeYaml);
      expect(readLog(fx.root)).toBe('');

      // 3. `team settings set` refused and never reads `agents` in the sessionless walk
      const setCalls: CallRecord[] = [];
      const setIo = testIo(fx.root);
      setIo.env = { ...s.env };
      setIo.callerSources = makeSourcesFor(setCalls, { env: s.env, rootPidFor: s.rootPidFor });
      const setCode = await runSettings(
        ['set', 'worker', 'effort', 'high'],
        setIo,
        { home: fx.home, now: NOW },
      );
      expect(setCode, `settings set for ${s.name}`).toBe(1);
      expect(setIo.err).toContain(s.expectedSettingsErr);
      expect(readLog(fx.root)).toBe('');
      expect(setCalls.filter((c) => c.session === undefined && c.op === 'agents')).toEqual([]);
    }
  });
});
