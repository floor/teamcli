// Independent verification of fix/lead-config-no-card (security surface):
// 1. `team config set` and `team add` admit the target team's placed lead and the same entity's
//    placed main orchestrator under dev mode, logging the owner-lift audit line and creating no card.
// 2. `team config set` and `team add` refuse (and never card or audit) a plain seat, another team's
//    lead, another entity's orchestrator, and any caller placed only by the pane environment variable.
// 3. An owner-signer `always` rule (`ownerSeatRuleAdmits`, `ownerAdmitsRecord`) is spent only by the
//    caller it names (the lead of `rule.team` or that entity's main orchestrator); sibling leads in
//    the same folder spend only their own team's rule and never another team's rule.
// 4. `team check` flags a pending card that is neither `team-general-grant` nor `development-mode`
//    as `policy drift` under dev mode, while ignoring general-grant, security-policy, expired,
//    answered, or other-root cards, and reading no cards when dev mode is off.
// All fixtures, keys, signers, processes, and launches are synthetic in-memory fakes.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller, CallerSources } from '../src/caller.ts';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { approveOwnerAction, createOwnerActionRequest } from '../src/client/owner-action.ts';
import { ownerAdmitsRecord, ownerSeatRuleAdmits } from '../src/client/owner-action-step.ts';
import { actionAuditFolder, actionRequestsFolder } from '../src/client/team-create.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo, recordRenames } from './helpers.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-11-04T09:30:00.000Z');

const CONFIG_REFUSAL_PREFIX = "only the owner edits the team's record, from a terminal outside herdr; this call is";
const ADD_REFUSAL_PREFIX = 'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is';

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function renderTeamYaml(opts: {
  project: string;
  entity: string;
  session: string;
  lead: string;
  root: string;
}): string {
  return `format: 1
project: ${opts.project}
entity: ${opts.entity}
session: ${opts.session}
coordinator: ${opts.lead}
operator: ${opts.lead}
trust:
  - ~/.config/team/lobbies/${opts.entity}
  - ${opts.root}
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: ${opts.lead}
    label: ${opts.lead}
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
}

function pendingCards(home: string): string[] {
  try {
    return readdirSync(actionRequestsFolder(home))
      .filter((name) => /^oa_[0-9a-f]{24}\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function auditFiles(home: string): string[] {
  try {
    return readdirSync(actionAuditFolder(home)).sort();
  } catch {
    return [];
  }
}

function teamLog(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function fakeLaunch(): { launch: Launch; creates: string[] } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let seq = 0;
  let clock = NOW.getTime();
  const state = { launch: {} as Launch, creates: [] as string[] };
  state.launch = {
    sessionState: () => 'absent' as const,
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      seq += 1;
      const paneId = `synthetic-launched-pane-${String(seq)}`;
      panes.set(paneId, { text: CLAUDE_IDLE, agent: false });
      state.creates.push(label);
      return { pane: paneId, workspace: `synthetic-ws-${String(seq)}` };
    },
    paneRun(_session, pane) {
      const entry = panes.get(pane);
      if (entry) entry.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, p]) => p.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  recordRenames(state.launch);
  return state;
}

function fakeDoctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function makeAddSources(home: string, launched: ReturnType<typeof fakeLaunch>): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: fakeDoctor(home),
    now: () => NOW,
    launch: launched.launch,
  };
}

interface HierarchyFixture {
  base: string;
  home: string;
  store: FakeStore;
  floorRoot: string;
  acmeRoot: string;
  betaRoot: string;
  outsideRoot: string;
  otherEntityMainRoot: string;
  acmeTeam: TeamFile;
  callers: {
    atlas: Caller;
    acmeLead: Caller;
    acmeWorker: Caller;
    betaLead: Caller;
    outsideLead: Caller;
    otherMainOrchestrator: Caller;
  };
}

/**
 * Builds a complete multi-team hierarchy:
 * - `floorRoot`: parent folder holding the `floor` entity's main orchestrator (`atlas`, session `main`)
 * - `acmeRoot` (`floorRoot/acme`): target team `acme` (entity `floor`, session `acme`, lead `lead`, plain seat `worker`, template `builder`)
 * - `betaRoot` (`floorRoot/beta`): sibling team `beta` (entity `floor`, session `beta`, lead `beta-lead`)
 * - `outsideRoot` (`floorRoot/outside`): team inside `floorRoot` belonging to another entity `outside` (lead `outs`)
 * - `otherEntityMainRoot` (`base/rival-floor`): another entity's main orchestrator folder (`rival-atlas`, entity `rival`)
 */
function setupHierarchy(options: { devMode?: boolean } = {}): HierarchyFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lead-no-card-ind-')));
  cleanupDirs.push(base);
  const home = join(base, 'home');
  const floorRoot = join(base, 'floor');
  const acmeRoot = join(floorRoot, 'acme');
  const betaRoot = join(floorRoot, 'beta');
  const outsideRoot = join(floorRoot, 'outside');
  const otherEntityMainRoot = join(base, 'rival-floor');

  mkdirSync(home, { recursive: true });
  const store = seatOwner(home);
  if (options.devMode !== false) {
    const written = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'synthetic-fixture' });
    if (!written.ok) throw new Error(written.why);
  }

  const specs = [
    { root: floorRoot, project: 'floor', entity: 'floor', session: 'main', lead: 'atlas', leadPane: 'pane-atlas', workerPane: 'pane-floor-worker', git: false },
    { root: acmeRoot, project: 'acme', entity: 'floor', session: 'acme', lead: 'lead', leadPane: 'pane-acme-lead', workerPane: 'pane-acme-worker', git: true },
    { root: betaRoot, project: 'beta', entity: 'floor', session: 'beta', lead: 'beta-lead', leadPane: 'pane-beta-lead', workerPane: 'pane-beta-worker', git: true },
    { root: outsideRoot, project: 'outside', entity: 'outside', session: 'outside', lead: 'outs', leadPane: 'pane-outs-lead', workerPane: 'pane-outs-worker', git: true },
    { root: otherEntityMainRoot, project: 'rival-floor', entity: 'rival', session: 'rival-main', lead: 'rival-atlas', leadPane: 'pane-rival-atlas', workerPane: 'pane-rival-worker', git: false },
  ] as const;

  let acmeTeam: TeamFile | undefined;
  for (const spec of specs) {
    mkdirSync(join(spec.root, '.agents'), { recursive: true });
    if (spec.git) {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: spec.root, env: gitEnv(), stdio: 'ignore' });
    }
    const text = renderTeamYaml({
      project: spec.project,
      entity: spec.entity,
      session: spec.session,
      lead: spec.lead,
      root: spec.root,
    });
    writeFileSync(join(spec.root, '.agents', 'team.yaml'), text);
    const validated = validateTeamFile(text);
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    if (spec.project === 'acme') acmeTeam = validated.team;
    writeApproval(
      storePath(validated.team.project, spec.root, home),
      { approval: approvalOf(validated.team, spec.root, NOW), file: text },
      validated.team.seats,
      home,
      NOW,
    );
    updateState(join(spec.root, '.agents'), (state) => {
      state.sessions[spec.session] = {
        seats: {
          [spec.lead]: { stage: 'ready', pane: spec.leadPane },
          worker: { stage: 'ready', pane: spec.workerPane },
        },
        worktrees: {},
      };
    });
    upsertTeam(home, teamIdOf(spec.root), {
      project: spec.project,
      entity: spec.entity,
      session: spec.session,
      root: spec.root,
      roster: [],
      by: 'test',
    });
  }

  return {
    base,
    home,
    store,
    floorRoot,
    acmeRoot,
    betaRoot,
    outsideRoot,
    otherEntityMainRoot,
    acmeTeam: acmeTeam!,
    callers: {
      atlas: { kind: 'seat', name: 'atlas', pane: 'pane-atlas', session: 'main' },
      acmeLead: { kind: 'seat', name: 'lead', pane: 'pane-acme-lead', session: 'acme' },
      acmeWorker: { kind: 'seat', name: 'worker', pane: 'pane-acme-worker', session: 'acme' },
      betaLead: { kind: 'seat', name: 'beta-lead', pane: 'pane-beta-lead', session: 'beta' },
      outsideLead: { kind: 'seat', name: 'outs', pane: 'pane-outs-lead', session: 'outside' },
      otherMainOrchestrator: { kind: 'seat', name: 'rival-atlas', pane: 'pane-rival-atlas', session: 'rival-main' },
    },
  };
}

describe('1. config set and add admitted for target lead and same-entity main orchestrator under dev mode, with no card', () => {
  test('target team lead is admitted for both config set and add with warning, audit log, and zero cards', async () => {
    const fx = setupHierarchy();

    // 1a. `team config set` by target team's placed lead
    const cfgIo = testIo(fx.acmeRoot, fx.callers.acmeLead);
    cfgIo.env = {};
    const cfgSources: ConfigSources = { home: fx.home, env: cfgIo.env, now: () => NOW };
    const cfgCode = await runConfig(['set', 'seats.worker.model', 'Claude Sonnet'], cfgIo, cfgSources);
    expect(cfgCode).toBe(0);
    expect(cfgIo.err).toBe(
      `warning: ${CONFIG_REFUSAL_PREFIX} lead; dev mode continues (dev-mode on at machine level)\n`,
    );
    expect(readFileSync(join(fx.acmeRoot, '.agents', 'team.yaml'), 'utf8')).toContain('    model: Claude Sonnet\n');
    expect(teamLog(fx.acmeRoot)).toContain(
      `config [lead] warning: ${CONFIG_REFUSAL_PREFIX} lead; dev mode continues (dev-mode on at machine level); admitted as orchestrator\n`,
    );
    expect(pendingCards(fx.home)).toEqual([]);

    // 1b. `team add` by target team's placed lead
    const launched = fakeLaunch();
    const addIo = testIo(fx.acmeRoot, fx.callers.acmeLead);
    addIo.env = {};
    const addCode = await runAdd(['apprentice', '--like', 'builder'], addIo, makeAddSources(fx.home, launched));
    expect(addCode, addIo.out + addIo.err).toBe(0);
    expect(addIo.err).toBe(
      `team add: warning: ${ADD_REFUSAL_PREFIX} lead; dev mode continues (dev-mode on at machine level)\n`,
    );
    expect(readFileSync(join(fx.acmeRoot, '.agents', 'team.yaml'), 'utf8')).toContain('    name: apprentice\n');
    expect(launched.creates).toEqual(['apprentice']);
    expect(teamLog(fx.acmeRoot)).toContain(
      `add [lead] warning: ${ADD_REFUSAL_PREFIX} lead; dev mode continues (dev-mode on at machine level); admitted as orchestrator\n`,
    );
    expect(pendingCards(fx.home)).toEqual([]);
  });

  test('same entity main orchestrator above the target is admitted for both config set and add with zero cards', async () => {
    const fx = setupHierarchy();

    // 1c. `team config set` on child `acme` by `atlas` (main orchestrator of entity `floor`)
    const cfgIo = testIo(fx.acmeRoot, fx.callers.atlas);
    cfgIo.env = {};
    const cfgCode = await runConfig(
      ['set', 'seats.worker.model', 'Claude Haiku'],
      cfgIo,
      { home: fx.home, env: cfgIo.env, now: () => NOW },
    );
    expect(cfgCode).toBe(0);
    expect(cfgIo.err).toBe(
      `warning: ${CONFIG_REFUSAL_PREFIX} atlas; dev mode continues (dev-mode on at machine level)\n`,
    );
    expect(readFileSync(join(fx.acmeRoot, '.agents', 'team.yaml'), 'utf8')).toContain('    model: Claude Haiku\n');
    expect(teamLog(fx.acmeRoot)).toContain(
      `config [atlas] warning: ${CONFIG_REFUSAL_PREFIX} atlas; dev mode continues (dev-mode on at machine level); admitted as orchestrator\n`,
    );
    expect(pendingCards(fx.home)).toEqual([]);

    // 1d. `team add` on child `acme` by `atlas` (main orchestrator of entity `floor`)
    const launched = fakeLaunch();
    const addIo = testIo(fx.acmeRoot, fx.callers.atlas);
    addIo.env = {};
    const addCode = await runAdd(['scout', '--like', 'builder'], addIo, makeAddSources(fx.home, launched));
    expect(addCode, addIo.out + addIo.err).toBe(0);
    expect(addIo.err).toBe(
      `team add: warning: ${ADD_REFUSAL_PREFIX} atlas; dev mode continues (dev-mode on at machine level)\n`,
    );
    expect(readFileSync(join(fx.acmeRoot, '.agents', 'team.yaml'), 'utf8')).toContain('    name: scout\n');
    expect(launched.creates).toEqual(['scout']);
    expect(teamLog(fx.acmeRoot)).toContain(
      `add [atlas] warning: ${ADD_REFUSAL_PREFIX} atlas; dev mode continues (dev-mode on at machine level); admitted as orchestrator\n`,
    );
    expect(pendingCards(fx.home)).toEqual([]);
  });
});

describe('2. config set and add refused (never carded, never audited) for unauthorized or pane-env-only callers', () => {
  test('refuses plain seat, sibling team lead, and another entity orchestrator for both config set and add with no card', async () => {
    const fx = setupHierarchy();

    const deniedCases: { label: string; root: string; caller: Caller; expectedName: string }[] = [
      { label: 'plain seat of target team', root: fx.acmeRoot, caller: fx.callers.acmeWorker, expectedName: 'worker' },
      { label: 'another team lead (sibling in same entity)', root: fx.acmeRoot, caller: fx.callers.betaLead, expectedName: 'beta-lead' },
      { label: 'another team lead (different entity)', root: fx.acmeRoot, caller: fx.callers.outsideLead, expectedName: 'outs' },
      { label: 'main orchestrator targeting another entity child in same parent folder', root: fx.outsideRoot, caller: fx.callers.atlas, expectedName: 'atlas' },
      { label: 'another entity main orchestrator targeting acme', root: fx.acmeRoot, caller: fx.callers.otherMainOrchestrator, expectedName: 'rival-atlas' },
    ];

    for (const c of deniedCases) {
      const yamlPath = join(c.root, '.agents', 'team.yaml');
      const beforeYaml = readFileSync(yamlPath, 'utf8');

      // `team config set` refused
      const cfgIo = testIo(c.root, c.caller);
      cfgIo.env = { TEAMCLI_DEV_MODE: '1' };
      const cfgCode = await runConfig(
        ['set', 'seats.worker.model', 'Claude Sonnet'],
        cfgIo,
        { home: fx.home, env: cfgIo.env, now: () => NOW },
      );
      expect(cfgCode, `config set for ${c.label}`).toBe(1);
      expect(cfgIo.err).toBe(`team config: ${CONFIG_REFUSAL_PREFIX} ${c.expectedName}\n`);
      expect(readFileSync(yamlPath, 'utf8')).toBe(beforeYaml);
      expect(teamLog(c.root)).toBe('');
      expect(pendingCards(fx.home)).toEqual([]);

      // `team add` refused before launch or write
      const launched = fakeLaunch();
      const addIo = testIo(c.root, c.caller);
      addIo.env = { TEAMCLI_DEV_MODE: '1' };
      const addCode = await runAdd(['intruder', '--like', 'builder'], addIo, makeAddSources(fx.home, launched));
      expect(addCode, `add for ${c.label}`).toBe(1);
      expect(addIo.err).toBe(`team add: ${ADD_REFUSAL_PREFIX} ${c.expectedName}\n`);
      expect(launched.creates).toEqual([]);
      expect(readFileSync(yamlPath, 'utf8')).toBe(beforeYaml);
      expect(teamLog(c.root)).toBe('');
      expect(pendingCards(fx.home)).toEqual([]);
    }
  });

  test('refuses a caller placed only by the pane environment variable (HERDR_PANE_ID / HERDR_PANE) with no card', async () => {
    const fx = setupHierarchy();
    const yamlPath = join(fx.acmeRoot, '.agents', 'team.yaml');
    const beforeYaml = readFileSync(yamlPath, 'utf8');

    // Build `Io` instances where `io.caller` is undefined and the environment carries the lead's
    // recorded pane (`pane-acme-lead`), but the process/pid chain does not prove placement on that pane:
    // (a) detached agent outside herdr carrying HERDR_PANE_ID=pane-acme-lead
    // (b) process under herdr carrying HERDR_PANE_ID=pane-acme-lead whose paneRootPid is not an ancestor
    // (c) agentless pane caller carrying the lead's pane id
    // (d) seat caller with no session or mismatched recorded pane
    const makeEnvPlacedIo = (sourcesFn: (session?: string) => CallerSources): Io => {
      const baseIo = testIo(fx.acmeRoot, { kind: 'owner' });
      const env = {
        HERDR_PANE_ID: 'pane-acme-lead',
        HERDR_PANE: 'pane-acme-lead',
        TEAMCLI_DEV_MODE: '1',
      };
      const io: Io = {
        cwd: fx.acmeRoot,
        env,
        stdinIsTTY: false,
        callerSources: sourcesFn,
        stdout: (t) => baseIo.stdout(t),
        stderr: (t) => baseIo.stderr(t),
      };
      Object.defineProperty(io, 'out', { get: () => baseIo.out });
      Object.defineProperty(io, 'err', { get: () => baseIo.err });
      return io;
    };

    const detachedEnvSources = (): CallerSources => ({
      ancestors: () => [
        { pid: 701, name: 'claude' },
        { pid: 1, name: 'launchd' },
      ],
      agents: () => [{ name: 'lead', agent: 'claude', pane: 'pane-acme-lead', workspace: 'ws-1', status: 'idle', cwd: fx.acmeRoot }],
      paneRootPid: () => 9999, // Not in caller's ancestors
      env: { HERDR_PANE_ID: 'pane-acme-lead', HERDR_PANE: 'pane-acme-lead', TEAMCLI_DEV_MODE: '1' },
      stdinIsTTY: false,
    });

    const underHerdrWrongPidSources = (): CallerSources => ({
      ancestors: () => [
        { pid: 702, name: 'claude' },
        { pid: 200, name: 'herdr' },
        { pid: 1, name: 'launchd' },
      ],
      agents: () => [{ name: 'lead', agent: 'claude', pane: 'pane-acme-lead', workspace: 'ws-1', status: 'idle', cwd: fx.acmeRoot }],
      paneRootPid: () => 9999, // Server says lead pane root is 9999, not an ancestor of 702
      env: { HERDR_PANE_ID: 'pane-acme-lead', HERDR_PANE: 'pane-acme-lead', TEAMCLI_DEV_MODE: '1' },
      stdinIsTTY: false,
    });

    const agentlessPaneSources = (): CallerSources => ({
      ancestors: () => [
        { pid: 703, name: 'zsh' },
        { pid: 200, name: 'herdr' },
        { pid: 1, name: 'launchd' },
      ],
      agents: () => [], // No agent registered on the pane
      paneRootPid: (pane) => (pane === 'pane-acme-lead' ? 703 : null),
      env: { HERDR_PANE_ID: 'pane-acme-lead', HERDR_PANE: 'pane-acme-lead', TEAMCLI_DEV_MODE: '1' },
      stdinIsTTY: false,
    });

    for (const factory of [detachedEnvSources, underHerdrWrongPidSources, agentlessPaneSources]) {
      const cfgIo = makeEnvPlacedIo(factory);
      const cfgCode = await runConfig(
        ['set', 'seats.worker.model', 'Claude Sonnet'],
        cfgIo,
        { home: fx.home, env: cfgIo.env, now: () => NOW },
      );
      expect(cfgCode).toBe(1);
      expect((cfgIo as unknown as { err: string }).err).toContain(`team config: ${CONFIG_REFUSAL_PREFIX}`);
      expect(readFileSync(yamlPath, 'utf8')).toBe(beforeYaml);
      expect(teamLog(fx.acmeRoot)).toBe('');
      expect(pendingCards(fx.home)).toEqual([]);

      const launched = fakeLaunch();
      const addIo = makeEnvPlacedIo(factory);
      const addCode = await runAdd(['env-only-seat', '--like', 'builder'], addIo, makeAddSources(fx.home, launched));
      expect(addCode).toBe(1);
      expect((addIo as unknown as { err: string }).err).toContain(`team add: ${ADD_REFUSAL_PREFIX}`);
      expect(launched.creates).toEqual([]);
      expect(readFileSync(yamlPath, 'utf8')).toBe(beforeYaml);
      expect(teamLog(fx.acmeRoot)).toBe('');
      expect(pendingCards(fx.home)).toEqual([]);
    }
  });
});

describe('3. an always rule is spent only by the caller it names', () => {
  function signAlwaysRule(
    home: string,
    store: FakeStore,
    root: string,
    team: string,
    action: 'team-migrate' | 'team-revoke-approval',
  ): string {
    const req = createOwnerActionRequest(
      home,
      {
        actions: [action],
        root,
        team,
        head: null,
        args: {},
        requestedBy: 'synthetic-requester',
      },
      NOW,
    );
    if (!req.ok) throw new Error(req.why);
    const approved = approveOwnerAction(home, req.record.request_id, 'always', store, NOW);
    if (!approved.ok) throw new Error(approved.why);
    return req.record.request_id;
  }

  test('a rule for acme is spent only by acme lead or floor main orchestrator, never by worker, sibling beta lead, or rival orchestrator', () => {
    const fx = setupHierarchy({ devMode: false });
    const ruleAcme = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-migrate');
    const revokeRuleAcme = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-revoke-approval');
    const sources = { home: fx.home, now: () => NOW, ownerSeatStore: fx.store };

    // Denied callers in the exact same parent folder (`fx.floorRoot`)
    for (const denied of [
      fx.callers.acmeWorker,
      fx.callers.betaLead,
      fx.callers.outsideLead,
      fx.callers.otherMainOrchestrator,
      { kind: 'pane' as const, pane: 'pane-acme-lead', session: 'acme' },
    ]) {
      const io = testIo(fx.acmeRoot, denied);
      expect(ownerSeatRuleAdmits('team-migrate', fx.acmeRoot, false, io, sources)).toBe(false);
      expect(ownerAdmitsRecord('team-revoke-approval', io, [fx.acmeRoot], sources)).toMatchObject({
        ok: false,
        kind: 'caller',
      });
    }
    // No denied caller wrote an audit entry
    expect(auditFiles(fx.home)).toEqual([]);

    // Admitted callers: `acme`'s lead and `floor`'s main orchestrator (`atlas`)
    const leadIo = testIo(fx.acmeRoot, fx.callers.acmeLead);
    expect(ownerSeatRuleAdmits('team-migrate', fx.acmeRoot, false, leadIo, sources)).toBe(true);
    const leadRecord = ownerAdmitsRecord('team-revoke-approval', leadIo, [fx.acmeRoot], sources);
    expect(leadRecord).toEqual({
      ok: true,
      via: 'rule',
      ruleId: revokeRuleAcme,
      signer: 'mac',
      ruleFolder: fx.floorRoot,
    });
    expect(auditFiles(fx.home)).toHaveLength(2);

    const laterSources = { home: fx.home, now: () => new Date(NOW.getTime() + 1000), ownerSeatStore: fx.store };
    const atlasIo = testIo(fx.acmeRoot, fx.callers.atlas);
    expect(ownerSeatRuleAdmits('team-migrate', fx.acmeRoot, false, atlasIo, laterSources)).toBe(true);
    const atlasRecord = ownerAdmitsRecord('team-revoke-approval', atlasIo, [fx.acmeRoot], laterSources);
    expect(atlasRecord).toEqual({
      ok: true,
      via: 'rule',
      ruleId: revokeRuleAcme,
      signer: 'mac',
      ruleFolder: fx.floorRoot,
    });
    void ruleAcme;
    expect(auditFiles(fx.home)).toHaveLength(4);
  });

  test('when sibling teams in the same folder each hold an always rule, each lead spends only the rule naming its own team', () => {
    const fx = setupHierarchy({ devMode: false });
    const ruleAcme = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-revoke-approval');
    const ruleBeta = signAlwaysRule(fx.home, fx.store, fx.betaRoot, 'beta', 'team-revoke-approval');
    const sources = { home: fx.home, now: () => NOW, ownerSeatStore: fx.store };

    const acmeAdmitted = ownerAdmitsRecord(
      'team-revoke-approval',
      testIo(fx.acmeRoot, fx.callers.acmeLead),
      [fx.acmeRoot],
      sources,
    );
    expect(acmeAdmitted).toMatchObject({ ok: true, via: 'rule', ruleId: ruleAcme, ruleFolder: fx.floorRoot });

    const betaAdmitted = ownerAdmitsRecord(
      'team-revoke-approval',
      testIo(fx.betaRoot, fx.callers.betaLead),
      [fx.betaRoot],
      sources,
    );
    expect(betaAdmitted).toMatchObject({ ok: true, via: 'rule', ruleId: ruleBeta, ruleFolder: fx.floorRoot });
  });
});

describe('4. team check flags pending cards that are neither general-grant nor security-policy loosening under dev mode', () => {
  function liveForAcme(team: TeamFile): Live {
    const lead = team.seats.find((s) => s.name === 'lead')!;
    const worker = team.seats.find((s) => s.name === 'worker')!;
    return {
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'pane-acme-lead', workspace: 'ws-lead', status: 'idle', cwd: null, displayAgent: displayAgent(lead) },
        { name: 'worker', agent: 'claude', pane: 'pane-acme-worker', workspace: 'ws-worker', status: 'idle', cwd: null, displayAgent: displayAgent(worker) },
      ],
      workspaces: [
        { id: 'ws-lead', label: workspaceLabel(lead) },
        { id: 'ws-worker', label: workspaceLabel(worker) },
      ],
      screens: {
        'pane-acme-lead': CLAUDE_IDLE,
        'pane-acme-worker': CLAUDE_IDLE,
      },
    };
  }

  function runCheckOnAcme(fx: HierarchyFixture, env: Record<string, string> = {}): { code: number; out: string } {
    const io = testIo(fx.acmeRoot, { kind: 'owner' });
    io.env = env;
    const sources: CheckSources = {
      live: () => liveForAcme(fx.acmeTeam),
      branch: () => 'main',
      standing: (root) => approvalStanding(root, fx.home),
      now: () => NOW,
      home: fx.home,
    };
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, sources);
    return { code, out: `${io.out}${io.err}` };
  }

  test('flags pending team-config and team-add cards as policy drift under dev mode, with non-approval repair', () => {
    const fx = setupHierarchy({ devMode: true });
    expect(runCheckOnAcme(fx).out).not.toContain('policy drift');

    const cfgCard = createOwnerActionRequest(
      fx.home,
      { actions: ['team-config'], root: fx.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!cfgCard.ok) throw new Error(cfgCard.why);

    const addCard = createOwnerActionRequest(
      fx.home,
      { actions: ['team-add'], root: fx.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!addCard.ok) throw new Error(addCard.why);

    const checked = runCheckOnAcme(fx);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain('policy drift');
    expect(checked.out).toContain(
      `difference: owner card ${cfgCard.record.request_id} asks for team-config under dev mode: policy drift, and only a general grant change or a security policy loosening is carded there`,
    );
    expect(checked.out).toContain(
      `repair: answer or let ${cfgCard.record.request_id} expire; under dev mode the lead runs a seat, CLI or label change with no card`,
    );
    expect(checked.out).toContain(
      `difference: owner card ${addCard.record.request_id} asks for team-add under dev mode: policy drift, and only a general grant change or a security policy loosening is carded there`,
    );
    expect(checked.out).toContain(
      `repair: answer or let ${addCard.record.request_id} expire; under dev mode the lead runs a seat, CLI or label change with no card`,
    );
  });

  test('does not flag team-general-grant, development-mode, answered, expired, or other-root cards, nor any card when dev mode is off', () => {
    const fx = setupHierarchy({ devMode: true });

    // 1. General-grant card is allowed and never flagged as policy drift
    const grantCard = createOwnerActionRequest(
      fx.home,
      { actions: ['team-general-grant'], root: fx.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!grantCard.ok) throw new Error(grantCard.why);

    // 2. Security-policy loosening (`development-mode`) card is allowed and never flagged as policy drift
    const devModeCard = createOwnerActionRequest(
      fx.home,
      { actions: ['development-mode'], root: fx.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!devModeCard.ok) throw new Error(devModeCard.why);

    // 3. Card for another root (`betaRoot`) does not drift `acmeRoot`
    const otherRootCard = createOwnerActionRequest(
      fx.home,
      { actions: ['team-config'], root: fx.betaRoot, team: 'beta', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!otherRootCard.ok) throw new Error(otherRootCard.why);

    // 4. Answered (`non`) card is not pending and not flagged
    const answeredCard = createOwnerActionRequest(
      fx.home,
      { actions: ['team-config'], root: fx.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!answeredCard.ok) throw new Error(answeredCard.why);
    const declined = approveOwnerAction(fx.home, answeredCard.record.request_id, 'non', fx.store, NOW);
    if (!declined.ok) throw new Error(declined.why);

    // 5. Expired card is not flagged
    const past = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const expiredCard = createOwnerActionRequest(
      fx.home,
      { actions: ['team-config'], root: fx.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      past,
    );
    if (!expiredCard.ok) throw new Error(expiredCard.why);

    const checkedOn = runCheckOnAcme(fx);
    expect(checkedOn.out).not.toContain('policy drift');
    expect(checkedOn.out).not.toContain('owner card');

    // 6. When dev mode is off, even a pending `team-config` card is not flagged as policy drift
    const fxOff = setupHierarchy({ devMode: false });
    const pendingOff = createOwnerActionRequest(
      fxOff.home,
      { actions: ['team-config'], root: fxOff.acmeRoot, team: 'acme', head: null, args: {}, requestedBy: 'synthetic' },
      NOW,
    );
    if (!pendingOff.ok) throw new Error(pendingOff.why);
    const checkedOff = runCheckOnAcme(fxOff);
    expect(checkedOff.out).not.toContain('policy drift');
    expect(checkedOff.out).not.toContain('owner card');
  });
});
