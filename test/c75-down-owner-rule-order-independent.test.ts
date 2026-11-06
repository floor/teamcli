// Independent verification of fix/c75-down-owner-rule-order at 3854649294:
// 1. A non-owner `down` with `--file` or `--session` is refused before any terminal-host read
//    (no agent list, no pane-root read), and writes nothing.
// 2. With no covering rule, `ownerSeatRuleAdmits` returns before reading the caller at all; a
//    rule for another action does not cover; a covering rule does read and admits its lead.
// 3. An owner-seat `always` rule still admits what it admitted before: a down on another team's
//    folder by the same entity's main orchestrator, and an add by the target team's lead; a plain
//    seat keeps both refusals.
// 4. The dev-mode lift is unchanged: the target lead's add continues with the warning and the
//    audit line, the main orchestrator's `down --abandon` continues with both warnings, and a
//    plain seat keeps the abandon refusal.
// 5. A no-terminal owner with a covering `team-down` always rule is admitted at the detached
//    check (the run then stops only for its missing launch seam), and without the rule it is
//    refused there with no caller read.
// All fixtures, keys, signers, processes, hosts and launches are synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller, CallerSources } from '../src/caller.ts';
import { approveOwnerAction, createOwnerActionRequest } from '../src/client/owner-action.ts';
import { ownerSeatRuleAdmits } from '../src/client/owner-action-step.ts';
import { actionAuditFolder, actionRequestsFolder } from '../src/client/team-create.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo, recordRenames } from './helpers.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-11-05T09:30:00.000Z');

const DETACHED_DOWN = 'only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane';
const DOWN_CALLER_PREFIX = 'only the owner or `leads` stops the team; this call is';
const ADD_REFUSAL_PREFIX = 'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is ';
const ABANDON_REFUSAL = 'only the owner abandons a team, from a terminal outside herdr';
const NO_LAUNCH = 'this call has no way to reach herdr';

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function renderTeamYaml(opts: { project: string; entity: string; session: string; lead: string; root: string }): string {
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
      .map((name) => name.slice(0, -'.json'.length))
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

function makeAddSources(home: string, launched: ReturnType<typeof fakeLaunch>, store: FakeStore): AddSources {
  return {
    ownerSeatStore: store,
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
  acmeTeam: TeamFile;
  callers: { atlas: Caller; acmeLead: Caller; acmeWorker: Caller };
}

/**
 * A two-team hierarchy: entity `floor`'s main team at `floorRoot` (lead `atlas`, session `main`,
 * not a git repository) and its child team `acme` at `floorRoot/acme` (lead `lead`, plain seat
 * `worker`, session `acme`, a git repository). Dev mode is a synthetic machine record or off.
 */
function setupHierarchy(options: { devMode?: boolean } = {}): HierarchyFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'down-rule-order-ind-')));
  cleanupDirs.push(base);
  const home = join(base, 'home');
  const floorRoot = join(base, 'floor');
  const acmeRoot = join(floorRoot, 'acme');

  mkdirSync(home, { recursive: true });
  const store = seatOwner(home);
  if (options.devMode === true) {
    const written = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'synthetic-fixture' });
    if (!written.ok) throw new Error(written.why);
  }

  const specs = [
    { root: floorRoot, project: 'floor', entity: 'floor', session: 'main', lead: 'atlas', leadPane: 'pane-atlas', workerPane: 'pane-floor-worker', git: false },
    { root: acmeRoot, project: 'acme', entity: 'floor', session: 'acme', lead: 'lead', leadPane: 'pane-acme-lead', workerPane: 'pane-acme-worker', git: true },
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
    acmeTeam: acmeTeam!,
    callers: {
      atlas: { kind: 'seat', name: 'atlas', pane: 'pane-atlas', session: 'main' },
      acmeLead: { kind: 'seat', name: 'lead', pane: 'pane-acme-lead', session: 'acme' },
      acmeWorker: { kind: 'seat', name: 'worker', pane: 'pane-acme-worker', session: 'acme' },
    },
  };
}

function signAlwaysRule(
  home: string,
  store: FakeStore,
  root: string,
  team: string,
  action: 'team-down' | 'team-add',
): string {
  const req = createOwnerActionRequest(
    home,
    { actions: [action], root, team, head: null, args: {}, requestedBy: 'synthetic-requester' },
    NOW,
  );
  if (!req.ok) throw new Error(req.why);
  const approved = approveOwnerAction(home, req.record.request_id, 'always', store, NOW);
  if (!approved.ok) throw new Error(approved.why);
  return req.record.request_id;
}

function seatSources(fx: HierarchyFixture): { home: string; now: () => Date; ownerSeatStore: FakeStore } {
  return { home: fx.home, now: () => NOW, ownerSeatStore: fx.store };
}

function downSources(home: string, store: FakeStore): DownSources {
  return {
    ownerSeatStore: store,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    home,
  };
}

interface Counts {
  agents: number;
  paneRoot: number;
  ancestors: number;
}

/** Caller sources whose every read is counted: one herdr server among the parents, and the
 *  agent list and pane-root record only when a scene asks for them. With `lead`, the list
 *  places the acme lead on its recorded pane and the pane root is one of its parents. */
function countedSources(counts: Counts, options: { lead?: boolean; paneRoot?: number } = {}): CallerSources {
  return {
    ancestors: () => {
      counts.ancestors += 1;
      return [
        { pid: 210, name: 'zsh' },
        { pid: 200, name: 'claude' },
        { pid: 10, name: 'herdr' },
      ];
    },
    agents: () => {
      counts.agents += 1;
      return options.lead === true
        ? [{ name: 'lead', agent: 'claude', pane: 'pane-acme-lead', workspace: 'ws-1', status: 'idle', cwd: '/' }]
        : null;
    },
    paneRootPid: () => {
      counts.paneRoot += 1;
      return options.paneRoot ?? null;
    },
    env: {},
    stdinIsTTY: false,
  };
}

/** A caller outside herdr with no terminal: `walkCaller` places it `owner-no-tty`. */
function noTerminalSources(counts: Counts): CallerSources {
  return {
    ancestors: () => {
      counts.ancestors += 1;
      return [{ pid: 310, name: 'zsh' }];
    },
    agents: () => {
      counts.agents += 1;
      return null;
    },
    paneRootPid: () => {
      counts.paneRoot += 1;
      return null;
    },
    env: {},
    stdinIsTTY: false,
  };
}

function countedIo(cwd: string, sources: (counts: Counts) => CallerSources, counts: Counts): ReturnType<typeof testIo> {
  const io = testIo(cwd);
  io.callerSources = () => sources(counts);
  return io;
}

describe('1. a non-owner down with --file or --session is refused before any terminal-host read', () => {
  test('--file refuses at down.file-owner with no agent or pane-root read and no audit', async () => {
    const fx = setupHierarchy({ devMode: false });
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => countedSources(c), counts);
    const code = await runDown(['--file', join(fx.base, 'no-such-team.yaml')], io, downSources(fx.home, fx.store));
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: --file is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n`);
    expect(counts.ancestors).toBeGreaterThan(0);
    expect(counts.agents).toBe(0);
    expect(counts.paneRoot).toBe(0);
    expect(auditFiles(fx.home)).toEqual([]);
    expect(pendingCards(fx.home)).toEqual([]);
  });

  test('--session refuses at down.session-owner with no agent or pane-root read and no audit', async () => {
    const fx = setupHierarchy({ devMode: false });
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => countedSources(c), counts);
    const code = await runDown(['--session', 'other-web'], io, downSources(fx.home, fx.store));
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: --session is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n`);
    expect(counts.ancestors).toBeGreaterThan(0);
    expect(counts.agents).toBe(0);
    expect(counts.paneRoot).toBe(0);
    expect(auditFiles(fx.home)).toEqual([]);
    expect(pendingCards(fx.home)).toEqual([]);
  });
});

describe('2. with no covering rule the caller is never read; a covering rule reads and admits its lead', () => {
  test('an empty store and a rule for another action both return before the caller read', () => {
    const fx = setupHierarchy({ devMode: false });
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => countedSources(c, { lead: true, paneRoot: 200 }), counts);

    expect(ownerSeatRuleAdmits('team-down', fx.acmeRoot, false, io, seatSources(fx))).toBe(false);
    expect(counts.agents).toBe(0);
    expect(auditFiles(fx.home)).toEqual([]);

    signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-add');
    expect(ownerSeatRuleAdmits('team-down', fx.acmeRoot, false, io, seatSources(fx))).toBe(false);
    expect(counts.agents).toBe(0);
    expect(auditFiles(fx.home)).toEqual([]);
  });

  test('a covering team-down rule reads the caller and admits its team lead, with one audit entry', () => {
    const fx = setupHierarchy({ devMode: false });
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => countedSources(c, { lead: true, paneRoot: 200 }), counts);
    const ruleId = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-down');

    expect(ownerSeatRuleAdmits('team-down', fx.acmeRoot, false, io, seatSources(fx))).toBe(true);
    expect(counts.agents).toBeGreaterThan(0);
    const entries = auditFiles(fx.home);
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(actionAuditFolder(fx.home), entries[0]!), 'utf8')) as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'team-down', via: 'rule', rule_id: ruleId });
  });
});

describe('3. an owner-seat always rule still admits what it admitted before', () => {
  test('down: the entity main orchestrator is refused without the rule and admitted past the caller gate with it', async () => {
    const fx = setupHierarchy({ devMode: false });

    const refusedIo = testIo(fx.acmeRoot, fx.callers.atlas);
    const refusedCode = await runDown([], refusedIo, downSources(fx.home, fx.store));
    expect(refusedCode).toBe(1);
    expect(refusedIo.err).toBe(`team down: ${DOWN_CALLER_PREFIX} atlas\n`);
    expect(auditFiles(fx.home)).toEqual([]);

    const ruleId = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-down');
    const admittedIo = testIo(fx.acmeRoot, fx.callers.atlas);
    const admittedCode = await runDown([], admittedIo, downSources(fx.home, fx.store));
    expect(admittedCode).toBe(1);
    expect(admittedIo.err).toBe(`team down: ${NO_LAUNCH}\n`);
    expect(admittedIo.err).not.toContain(DOWN_CALLER_PREFIX);
    const entries = auditFiles(fx.home);
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(actionAuditFolder(fx.home), entries[0]!), 'utf8')) as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'team-down', via: 'rule', rule_id: ruleId });
  });

  test('add: the target team lead is refused without the rule and admitted with it; a plain seat keeps the refusal', async () => {
    const fx = setupHierarchy({ devMode: false });
    const yamlPath = join(fx.acmeRoot, '.agents', 'team.yaml');

    const withoutRule = fakeLaunch();
    const refusedIo = testIo(fx.acmeRoot, fx.callers.acmeLead);
    const refusedCode = await runAdd(['apprentice', '--like', 'builder'], refusedIo, makeAddSources(fx.home, withoutRule, fx.store));
    expect(refusedCode).toBe(1);
    expect(refusedIo.err).toBe(`team add: ${ADD_REFUSAL_PREFIX}lead\n`);
    expect(withoutRule.creates).toEqual([]);
    expect(readFileSync(yamlPath, 'utf8')).not.toContain('    name: apprentice\n');

    const addRule = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-add');
    const admitted = fakeLaunch();
    const admittedIo = testIo(fx.acmeRoot, fx.callers.acmeLead);
    const admittedCode = await runAdd(['apprentice', '--like', 'builder'], admittedIo, makeAddSources(fx.home, admitted, fx.store));
    expect(admittedCode, admittedIo.out + admittedIo.err).toBe(0);
    expect(readFileSync(yamlPath, 'utf8')).toContain('    name: apprentice\n');
    expect(admitted.creates).toEqual(['apprentice']);

    const worker = fakeLaunch();
    const workerIo = testIo(fx.acmeRoot, fx.callers.acmeWorker);
    const workerCode = await runAdd(['intruder', '--like', 'builder'], workerIo, makeAddSources(fx.home, worker, fx.store));
    expect(workerCode).toBe(1);
    expect(workerIo.err).toBe(`team add: ${ADD_REFUSAL_PREFIX}worker\n`);
    expect(worker.creates).toEqual([]);
    expect(readFileSync(yamlPath, 'utf8')).not.toContain('    name: intruder\n');
    // The signed rule's answered request is the only card file the run leaves behind.
    expect(pendingCards(fx.home)).toEqual([addRule]);
  });
});

describe('4. the dev-mode lift is unchanged', () => {
  test('add: the target lead continues with the warning, the audit line and no card; a plain seat keeps the refusal', async () => {
    const fx = setupHierarchy({ devMode: true });

    const launched = fakeLaunch();
    const leadIo = testIo(fx.acmeRoot, fx.callers.acmeLead);
    const leadCode = await runAdd(['apprentice', '--like', 'builder'], leadIo, makeAddSources(fx.home, launched, fx.store));
    expect(leadCode, leadIo.out + leadIo.err).toBe(0);
    expect(leadIo.err).toBe(`team add: warning: ${ADD_REFUSAL_PREFIX}lead; dev mode continues (dev-mode on at machine level)\n`);
    expect(launched.creates).toEqual(['apprentice']);
    expect(teamLog(fx.acmeRoot)).toContain(
      `add [lead] warning: ${ADD_REFUSAL_PREFIX}lead; dev mode continues (dev-mode on at machine level); admitted as lead\n`,
    );
    expect(pendingCards(fx.home)).toEqual([]);

    const worker = fakeLaunch();
    const workerIo = testIo(fx.acmeRoot, fx.callers.acmeWorker);
    const workerCode = await runAdd(['intruder', '--like', 'builder'], workerIo, makeAddSources(fx.home, worker, fx.store));
    expect(workerCode).toBe(1);
    expect(workerIo.err).toBe(`team add: ${ADD_REFUSAL_PREFIX}worker\n`);
    expect(worker.creates).toEqual([]);
  });

  test('down --abandon: the main orchestrator continues with both warnings; a plain seat keeps the abandon refusal', async () => {
    const fx = setupHierarchy({ devMode: true });

    const atlasIo = testIo(fx.acmeRoot, fx.callers.atlas);
    const atlasCode = await runDown(['--abandon'], atlasIo, downSources(fx.home, fx.store));
    expect(atlasCode).toBe(1);
    expect(atlasIo.err).toBe(
      `warning: ${ABANDON_REFUSAL}; dev mode continues (dev-mode on at machine level)\n`
      + `team down: warning: ${DOWN_CALLER_PREFIX} atlas (dev-mode on at machine level)\n`
      + `team down: ${NO_LAUNCH}\n`,
    );
    expect(teamLog(fx.acmeRoot)).toContain(
      `down [atlas] warning: ${ABANDON_REFUSAL}; dev mode continues (dev-mode on at machine level); admitted as lead\n`,
    );

    const workerIo = testIo(fx.acmeRoot, fx.callers.acmeWorker);
    const workerCode = await runDown(['--abandon'], workerIo, downSources(fx.home, fx.store));
    expect(workerCode).toBe(1);
    expect(workerIo.err).toContain(`team down: ${ABANDON_REFUSAL}\n`);
    expect(workerIo.err).not.toContain(`team down: ${NO_LAUNCH}`);
  });
});

describe('5. the no-terminal owner at the detached check', () => {
  test('without a covering rule it is refused at down.detached with no caller read and no audit', async () => {
    const fx = setupHierarchy({ devMode: false });
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => noTerminalSources(c), counts);
    const code = await runDown([], io, downSources(fx.home, fx.store));
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${DETACHED_DOWN}\n`);
    expect(counts.ancestors).toBeGreaterThan(0);
    expect(counts.agents).toBe(0);
    expect(counts.paneRoot).toBe(0);
    expect(auditFiles(fx.home)).toEqual([]);
    expect(pendingCards(fx.home)).toEqual([]);
  });

  test('a covering team-down rule admits it past the detached check, spending exactly that rule', async () => {
    const fx = setupHierarchy({ devMode: false });
    const ruleId = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-down');
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => noTerminalSources(c), counts);
    const code = await runDown([], io, downSources(fx.home, fx.store));
    // Admitted past the detached gate, the run stops at its missing launch seam instead.
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${NO_LAUNCH}\n`);
    expect(io.err).not.toContain(DETACHED_DOWN);
    expect(auditFiles(fx.home)).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(actionAuditFolder(fx.home), auditFiles(fx.home)[0]!), 'utf8')) as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'team-down', via: 'rule', rule_id: ruleId });
    expect(pendingCards(fx.home)).toEqual([ruleId]);
  });

  test('a rule for another action does not admit it: still refused at the detached check, no caller read', async () => {
    const fx = setupHierarchy({ devMode: false });
    const otherRule = signAlwaysRule(fx.home, fx.store, fx.acmeRoot, 'acme', 'team-add');
    const counts: Counts = { agents: 0, paneRoot: 0, ancestors: 0 };
    const io = countedIo(fx.acmeRoot, (c) => noTerminalSources(c), counts);
    const code = await runDown([], io, downSources(fx.home, fx.store));
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${DETACHED_DOWN}\n`);
    expect(counts.agents).toBe(0);
    expect(auditFiles(fx.home)).toEqual([]);
    expect(pendingCards(fx.home)).toEqual([otherRule]);
  });
});
