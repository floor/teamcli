// Adversarial red suite for Item 0, Slice 2b (home-only chain, admission over memberships).
//
// Five adversarial scenes:
//   (1) A served project leaking a policy, rule, setting, or lead into the serving team's chain;
//   (2) `also_in` naming a project with no registry record admitting cross-team sends;
//   (3) A served project's lead reaching beyond the serving team's lead (or the serving team
//       claiming lead of the served project);
//   (4) `seats_cross_teams` read from a served project's chain instead of the asker's home chain;
//   (5) A bare, unplaced, or unrecorded caller admitted on a cross-project send.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { resolveProjectIdForTeam, runPolicy } from '../src/commands/policy.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { rulesOf, workSettingsFor } from '../src/launch/rules.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { readAgents } from '../src/registry/agents.ts';
import * as projectRegistry from '../src/registry/projects.ts';
import { readTeams, teamIdOf } from '../src/registry/teams.ts';
import { admitSend, PROJECT_RULES, sendGrantFor } from '../src/send/admit.ts';
import { deliveryChainOf } from '../src/send/delivery.ts';
import { senderNameModeFor } from '../src/send/names.ts';
import type { NativePane } from '../src/send/native.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T01:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const BODY = 'synthetic cross-project adversarial probe';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBase(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

function seatBlock(role: string, name: string, leads: boolean): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${leads ? '    leads: true\n' : ''}`;
}

type Place = { session: string; workspace: string; pane: string };

const PANES: Record<string, Place> = {
  'lead-a': { session: 'team-alpha', workspace: 'ws-alpha', pane: 'pane-lead-a' },
  'worker-a': { session: 'team-alpha', workspace: 'ws-alpha', pane: 'pane-worker-a' },
  'unregistered-a': { session: 'team-alpha', workspace: 'ws-alpha', pane: 'pane-unreg-a' },
  'lead-b': { session: 'team-beta', workspace: 'ws-beta', pane: 'pane-lead-b' },
  'worker-b': { session: 'team-beta', workspace: 'ws-beta', pane: 'pane-worker-b' },
};

type World = {
  base: string;
  home: string;
  rootA: string;
  rootB: string;
};

function writeTeamRepo(root: string, yaml: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
}

function makeWorld(opts?: {
  entityA?: string;
  entityB?: string;
  inProjectA?: string;
  inProjectB?: string;
  projectLeadA?: boolean;
  projectLeadB?: boolean;
  alsoInA?: string[];
  alsoInB?: string[];
  extraSeatA?: string;
}): World {
  const base = tempBase('s2b-adv-');
  const home = join(base, 'home');
  const rootA = join(base, 'team-alpha');
  const rootB = join(base, 'team-beta');

  const entityA = opts?.entityA ?? 'org-alpha';
  const entityB = opts?.entityB ?? 'org-beta';
  const lobbyA = resolveLobby(home, { entity: entityA });
  const lobbyB = resolveLobby(home, { entity: entityB });
  mkdirSync(lobbyA, { recursive: true });
  mkdirSync(lobbyB, { recursive: true });
  const inProjectA = opts?.inProjectA ?? 'HomeAlpha';
  const inProjectB = opts?.inProjectB ?? 'ServedBeta';
  const projectLeadA = opts?.projectLeadA ?? true;
  const projectLeadB = opts?.projectLeadB ?? true;
  const alsoInA = opts?.alsoInA ?? ['ServedBeta'];
  const alsoInB = opts?.alsoInB ?? [];

  const alsoInLineA = alsoInA.length > 0 ? `also_in: [${alsoInA.join(', ')}]\n` : '';
  const alsoInLineB = alsoInB.length > 0 ? `also_in: [${alsoInB.join(', ')}]\n` : '';

  writeTeamRepo(
    rootA,
    `format: 1
project: team-alpha
entity: ${entityA}
in_project: ${inProjectA}
${projectLeadA ? 'project_lead: true\n' : ''}${alsoInLineA}coordinator: lead-a
operator: lead-a
session: team-alpha
trust:
  - ${lobbyA}
  - ${rootA}
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead-a', true)}${seatBlock('implementer', 'worker-a', false)}${opts?.extraSeatA ?? ''}delivery_order: [mcp-inbox, typed]
`,
  );

  writeTeamRepo(
    rootB,
    `format: 1
project: team-beta
entity: ${entityB}
in_project: ${inProjectB}
${projectLeadB ? 'project_lead: true\n' : ''}${alsoInLineB}coordinator: lead-b
operator: lead-b
session: team-beta
trust:
  - ${lobbyB}
  - ${rootB}
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead-b', true)}${seatBlock('implementer', 'worker-b', false)}delivery_order: [mcp-inbox, typed]
`,
  );

  return { base, home, rootA, rootB };
}

function herdrAgent(name: string): HerdrAgent {
  const at = PANES[name]!;
  return {
    name,
    agent: 'claude',
    pane: at.pane,
    workspace: at.workspace,
    status: 'idle',
    cwd: null,
    session: 'claude-session-1',
  };
}

function registerSources(home: string): RegisterSources {
  return {
    home,
    sessionState: () => 'running',
    agents: (session) =>
      Object.keys(PANES)
        .filter((name) => PANES[name]!.session === session)
        .map((name) => herdrAgent(name)),
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
  };
}

async function registerSeat(w: World, root: string, seat: string): Promise<void> {
  const io = testIo(root, OWNER);
  const code = await runRegister([seat], io, registerSources(w.home));
  if (code !== 0) {
    throw new Error(`team register ${seat} failed (${code}): ${io.out}${io.err}`);
  }
}

type Typed = { session: string; pane: string; text: string };
type PaneBox = { session: string; samples: string[]; typed: Typed[]; enters: number };

function paneBox(session: string, samples: string[] = ['idle', 'working']): PaneBox {
  return { session, samples, typed: [], enters: 0 };
}

function defaultPanes(): Map<string, PaneBox> {
  return new Map([
    ['lead-a', paneBox('team-alpha')],
    ['worker-a', paneBox('team-alpha')],
    ['unregistered-a', paneBox('team-alpha')],
    ['lead-b', paneBox('team-beta')],
    ['worker-b', paneBox('team-beta')],
  ]);
}

function sendHost(w: World, panes: Map<string, PaneBox> = defaultPanes()): SendHost {
  const bySession = new Map<string, { name: string; pane: string }[]>();
  for (const [name, at] of Object.entries(PANES)) {
    const list = bySession.get(at.session) ?? [];
    list.push({ name, pane: at.pane });
    bySession.set(at.session, list);
  }
  function paneAt(pane: string): PaneBox | undefined {
    for (const [name, place] of Object.entries(PANES)) {
      if (place.pane === pane) return panes.get(name);
    }
    return undefined;
  }
  const native: NativePane = {
    typeText: (session, pane, text) => {
      const one = paneAt(pane);
      if (!one) return false;
      one.typed.push({ session, pane, text });
      return true;
    },
    pressEnter: (_session, pane) => {
      const one = paneAt(pane);
      if (!one) return false;
      one.enters += 1;
      return true;
    },
    status: (_session, pane) => {
      const one = paneAt(pane);
      if (!one) return null;
      return one.samples[Math.min(one.enters, one.samples.length - 1)] ?? 'idle';
    },
    wait: async () => {},
  };
  return {
    agents: (session) => bySession.get(session) ?? null,
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(w.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: w.home,
  };
}

function seatCaller(name: string): Caller {
  const at = PANES[name]!;
  return { kind: 'seat', name, pane: at.pane, session: at.session };
}

function dropsIn(root: string, session: string, seat: string): { path: string; text: string }[] {
  const dir = join(root, '.agents', 'send-drops', session, seat);
  try {
    const names = readdirSync(dir).filter((one) => !one.includes('.'));
    const out: { path: string; text: string }[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const text = readFileSync(path, 'utf8');
      if (!text.includes('from the launch — admitted by:')) out.push({ path, text });
    }
    return out;
  } catch {
    return [];
  }
}

describe('Item 0 Slice 2b adversarial red suite', () => {
  test('1. a served project never leaks a policy, rule, setting, or lead into the serving team chain', async () => {
    const w = makeWorld({
      inProjectA: 'HomeAlpha',
      inProjectB: 'ServedBeta',
      projectLeadA: true,
      projectLeadB: true,
      alsoInA: ['ServedBeta'],
    });

    // Register team-beta first so ServedBeta exists in projects.yaml with lead-b as its lead,
    // then register team-alpha (home: HomeAlpha, also_in: [ServedBeta]).
    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootB, 'worker-b');
    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootA, 'worker-a');

    const idA = teamIdOf(w.rootA);
    const idB = teamIdOf(w.rootB);
    const agents = readAgents(w.home);
    const leadA = agents.find((a) => a.reach.team === idA && a.reach.seat === 'lead-a')!;
    const leadB = agents.find((a) => a.reach.team === idB && a.reach.seat === 'lead-b')!;

    // Populate distinct project-level settings and owner-signed policies on HomeAlpha vs ServedBeta.
    // ServedBeta carries values that would visibly contaminate team-alpha if leaked.
    projectRegistry.upsertProject(w.home, 'homealpha', {
      name: 'HomeAlpha',
      lead: leadA.id,
      teams: [idA],
      deliveryOrder: ['typed', 'drop'],
      senderName: 'nickname',
      at: NOW.toISOString(),
    });
    projectRegistry.upsertProject(w.home, 'servedbeta', {
      name: 'ServedBeta',
      lead: leadB.id,
      teams: [idB, idA],
      deliveryOrder: ['drop'],
      senderName: 'seat@team',
      at: NOW.toISOString(),
    });

    const pHomeLanding = writePolicySet(
      w.home,
      { level: 'project', target: 'homealpha', name: 'landing-mode', value: 'pr-per-change' },
      { now: NOW },
    );
    expect(pHomeLanding.ok).toBe(true);
    const pHomeVault = writePolicySet(
      w.home,
      { level: 'project', target: 'homealpha', name: 'vault-root', value: '/tmp/vault-home-alpha' },
      { now: NOW },
    );
    expect(pHomeVault.ok).toBe(true);

    const pServedLanding = writePolicySet(
      w.home,
      { level: 'project', target: 'servedbeta', name: 'landing-mode', value: 'direct' },
      { now: NOW },
    );
    expect(pServedLanding.ok).toBe(true);
    const pServedVault = writePolicySet(
      w.home,
      { level: 'project', target: 'servedbeta', name: 'vault-root', value: '/tmp/vault-served-beta-leak' },
      { now: NOW },
    );
    expect(pServedVault.ok).toBe(true);

    // 1a. projectRegistry.ofTeam(home, idA) must resolve team-alpha's home project (homealpha),
    // never throwing on 2-project membership and never returning servedbeta.
    const homeOfA = projectRegistry.ofTeam(w.home, idA);
    expect(homeOfA?.id).toBe('homealpha');
    expect(homeOfA?.lead).toBe(leadA.id);
    expect(homeOfA?.lead).not.toBe(leadB.id);

    const loadedA = readTeamConfig(w.rootA, { home: w.home });
    if (!loadedA.ok) throw new Error('expected team-alpha config to load');
    const teamFileA = loadedA.team;
    const seatLeadA = teamFileA.seats.find((s) => s.name === 'lead-a')!;

    // 1b. Work settings and rendered rules for team-alpha must come from HomeAlpha, never ServedBeta.
    const workA = workSettingsFor(teamFileA, w.rootA, w.home);
    expect(workA).not.toBeNull();
    expect(workA?.landingMode.value).toBe('pr-per-change');
    expect(workA?.vaultRoot.value).toBe('/tmp/vault-home-alpha');

    const renderedRules = rulesOf(teamFileA, seatLeadA, w.rootA, workA);
    expect(renderedRules).toContain('/tmp/vault-home-alpha');
    expect(renderedRules).not.toContain('/tmp/vault-served-beta-leak');
    expect(renderedRules).toContain('one pull request per change');
    expect(renderedRules).not.toContain('land it directly on the integration branch');

    // 1c. Delivery chain for team-alpha must read HomeAlpha's project word (['typed', 'drop']),
    // never ServedBeta's (['drop']) and never throwing DeliveryChainUnreadable.
    const chainA = deliveryChainOf({
      home: w.home,
      root: w.rootA,
      seat: 'lead-a',
      file: teamFileA,
      projectOfTeam: (id) => projectRegistry.ofTeam(w.home, id),
      now: NOW,
    });
    expect(chainA.project).toEqual(['typed', 'drop']);

    // 1d. Sender name mode for team-alpha must read HomeAlpha's 'nickname', never ServedBeta's 'seat@team'.
    const modeA = senderNameModeFor({
      home: w.home,
      root: w.rootA,
      seat: 'lead-a',
      file: teamFileA,
    });
    expect(modeA).toBe('nickname');

    // 1e. Even if projects.yaml has idA listed only under servedbeta.teams while teams.yaml
    // records team-alpha's home projectId as 'homealpha', ofTeam must still follow teams.yaml's
    // home projectId ('homealpha') and never leak servedbeta!
    projectRegistry.upsertProject(w.home, 'homealpha', {
      name: 'HomeAlpha',
      lead: leadA.id,
      teams: [],
      deliveryOrder: ['typed', 'drop'],
      senderName: 'nickname',
      at: NOW.toISOString(),
    });
    const stillHomeOfA = projectRegistry.ofTeam(w.home, idA);
    expect(stillHomeOfA?.id).toBe('homealpha');
    expect(stillHomeOfA?.id).not.toBe('servedbeta');
    expect(resolveProjectIdForTeam(w.home, w.rootA, teamFileA)).toBe('homealpha');

    const policyIo = testIo(w.rootA, OWNER);
    const policyExit = await runPolicy(['--json'], policyIo, { home: w.home, now: NOW });
    expect(policyExit).toBe(0);
    const policyReport = JSON.parse(policyIo.out) as {
      policies: { name: string; value: unknown; level: string }[];
    };
    const landingPolicy = policyReport.policies.find((p) => p.name === 'landing-mode');
    expect(landingPolicy?.value).toBe('pr-per-change');
    expect(landingPolicy?.value).not.toBe('direct');
  });

  test('2. also_in for a project with no registry record never creates a project record and never admits', async () => {
    // Both teams belong to different entities (org-alpha vs org-beta) and different home projects
    // (HomeAlpha vs HomeBeta), and both name an unregistered GhostProject in also_in alongside a
    // registered SharedServed project.
    const w = makeWorld({
      entityA: 'org-alpha',
      entityB: 'org-beta',
      inProjectA: 'HomeAlpha',
      inProjectB: 'HomeBeta',
      projectLeadA: true,
      projectLeadB: true,
      alsoInA: ['GhostProject'],
      alsoInB: ['GhostProject'],
    });

    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootA, 'worker-a');
    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootB, 'worker-b');

    // GhostProject had no record in projects.yaml prior to registration, so registration must NOT
    // create a record for it.
    expect(projectRegistry.get(w.home, 'ghostproject')).toBeNull();

    // Because GhostProject has no registry record, lead-a -> lead-b and worker-a -> worker-b
    // share no registered project and belong to different entities: both must be refused.
    const panes = defaultPanes();
    const host = sendHost(w, panes);

    const leadSendIo = testIo(w.rootA, seatCaller('lead-a'));
    const leadCode = await runSend(['lead-b@team-beta', BODY], leadSendIo, host);
    expect(leadCode).toBe(1);
    expect(leadSendIo.err).toContain('may not send');
    expect(dropsIn(w.rootB, 'team-beta', 'lead-b')).toEqual([]);

    const workerSendIo = testIo(w.rootA, seatCaller('worker-a'));
    const workerCode = await runSend(['worker-b@team-beta', BODY], workerSendIo, host);
    expect(workerCode).toBe(1);
    expect(dropsIn(w.rootB, 'team-beta', 'worker-b')).toEqual([]);

    // Now create a real registry record for SharedServed, add SharedServed to both teams' also_in
    // alongside GhostProject, and re-register: SharedServed must record both teams while
    // GhostProject still has no record, and lead-a -> lead-b must now be admitted via SharedServed.
    projectRegistry.upsertProject(w.home, 'sharedserved', {
      name: 'SharedServed',
      teams: [],
      at: NOW.toISOString(),
    });

    writeTeamRepo(
      w.rootA,
      readFileSync(join(w.rootA, '.agents', 'team.yaml'), 'utf8').replace(
        'also_in: [GhostProject]',
        'also_in: [GhostProject, SharedServed]',
      ),
    );
    writeTeamRepo(
      w.rootB,
      readFileSync(join(w.rootB, '.agents', 'team.yaml'), 'utf8').replace(
        'also_in: [GhostProject]',
        'also_in: [GhostProject, SharedServed]',
      ),
    );

    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootB, 'lead-b');

    const idA = teamIdOf(w.rootA);
    const idB = teamIdOf(w.rootB);
    expect(projectRegistry.get(w.home, 'ghostproject')).toBeNull();
    const shared = projectRegistry.get(w.home, 'sharedserved');
    expect(shared).not.toBeNull();
    expect(shared?.teams).toContain(idA);
    expect(shared?.teams).toContain(idB);

    // Home project pointers on teams.yaml must remain their own home projects, never SharedServed.
    const teams = readTeams(w.home);
    expect(teams[idA]?.projectId).toBe('homealpha');
    expect(teams[idB]?.projectId).toBe('homebeta');

    const admittedIo = testIo(w.rootA, seatCaller('lead-a'));
    const admittedCode = await runSend(['lead-b@team-beta', BODY], admittedIo, host);
    expect(admittedCode).toBe(0);
    const drops = dropsIn(w.rootB, 'team-beta', 'lead-b');
    expect(drops.length).toBe(1);
    expect(drops[0]!.text).toContain(PROJECT_RULES[1]);
  });

  test('3. a served project lead reaches the serving team lead but never a worker seat, and the serving team never claims the served project lead', async () => {
    // team-beta is at home in ServedBeta with project_lead: true (lead-b is ServedBeta's lead).
    // team-alpha is at home in HomeAlpha with project_lead: true and also_in: [ServedBeta].
    const w = makeWorld({
      entityA: 'org-alpha',
      entityB: 'org-beta',
      inProjectA: 'HomeAlpha',
      inProjectB: 'ServedBeta',
      projectLeadA: true,
      projectLeadB: true,
      alsoInA: ['ServedBeta'],
      alsoInB: [],
    });

    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootB, 'worker-b');
    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootA, 'worker-a');

    const idA = teamIdOf(w.rootA);
    const idB = teamIdOf(w.rootB);
    const agents = readAgents(w.home);
    const leadA = agents.find((a) => a.reach.team === idA && a.reach.seat === 'lead-a')!;
    const workerA = agents.find((a) => a.reach.team === idA && a.reach.seat === 'worker-a')!;
    const leadB = agents.find((a) => a.reach.team === idB && a.reach.seat === 'lead-b')!;

    // 3a. team-alpha's `project_lead: true` claims lead of HomeAlpha only; it must NEVER overwrite
    // ServedBeta's lead (`leadB.id`), while still adding idA to ServedBeta's teams.
    const homeAlpha = projectRegistry.get(w.home, 'homealpha');
    const servedBeta = projectRegistry.get(w.home, 'servedbeta');
    expect(homeAlpha?.lead).toBe(leadA.id);
    expect(servedBeta?.lead).toBe(leadB.id);
    expect(servedBeta?.teams).toContain(idB);
    expect(servedBeta?.teams).toContain(idA);

    // 3b. ServedBeta's project lead (lead-b) MUST NOT reach a non-lead worker seat (worker-a)
    // of the serving team, nor may worker-a reach lead-b.
    const teams = readTeams(w.home);
    const projects = projectRegistry.readProjects(w.home);

    const leadBToWorkerAVerdict = admitSend(leadB, workerA, teams, undefined, {
      projects,
      crossTeams: {},
    });
    expect(leadBToWorkerAVerdict.ok).toBe(false);

    const workerAToLeadBVerdict = admitSend(workerA, leadB, teams, undefined, {
      projects,
      crossTeams: {},
    });
    expect(workerAToLeadBVerdict.ok).toBe(false);

    const host = sendHost(w);
    const illegalIo1 = testIo(w.rootB, seatCaller('lead-b'));
    expect(await runSend(['worker-a@team-alpha', BODY], illegalIo1, host)).toBe(1);
    expect(dropsIn(w.rootA, 'team-alpha', 'worker-a')).toEqual([]);

    const illegalIo2 = testIo(w.rootA, seatCaller('worker-a'));
    expect(await runSend(['lead-b@team-beta', BODY], illegalIo2, host)).toBe(1);
    expect(dropsIn(w.rootB, 'team-beta', 'lead-b')).toEqual([]);

    // 3c. ServedBeta's project lead (lead-b) and the serving team's lead (lead-a) DO reach each
    // other under PROJECT_RULES[0] ('the project lead and the leads of its teams').
    const leadBToLeadAVerdict = admitSend(leadB, leadA, teams, undefined, {
      projects,
      crossTeams: {},
    });
    expect(leadBToLeadAVerdict).toEqual({ ok: true, rule: PROJECT_RULES[0] });

    const legalIo = testIo(w.rootB, seatCaller('lead-b'));
    expect(await runSend(['lead-a@team-alpha', BODY], legalIo, host)).toBe(0);
    const drops = dropsIn(w.rootA, 'team-alpha', 'lead-a');
    expect(drops.length).toBe(1);
    expect(drops[0]!.text).toContain(PROJECT_RULES[0]);
  });

  test('4. seats_cross_teams is resolved from the asker home chain, never from a served project chain', async () => {
    const w = makeWorld({
      entityA: 'org-alpha',
      entityB: 'org-beta',
      inProjectA: 'HomeAlpha',
      inProjectB: 'ServedBeta',
      projectLeadA: true,
      projectLeadB: true,
      alsoInA: ['ServedBeta'],
      alsoInB: [],
    });

    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootB, 'worker-b');
    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootA, 'worker-a');

    // Case A: ServedBeta opens `seats-cross-teams: true`, while team-alpha's home project
    // HomeAlpha keeps `seats-cross-teams: false`.
    expect(
      writePolicySet(
        w.home,
        { level: 'project', target: 'servedbeta', name: 'seats-cross-teams', value: true },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(
      writePolicySet(
        w.home,
        { level: 'project', target: 'homealpha', name: 'seats-cross-teams', value: false },
        { now: NOW },
      ).ok,
    ).toBe(true);

    const host = sendHost(w);

    // worker-a@team-alpha -> worker-b@team-beta MUST be refused: worker-a's home project is
    // HomeAlpha (false), and ServedBeta's `seats-cross-teams: true` must not leak into worker-a's
    // chain!
    const fromServingWorkerIo = testIo(w.rootA, seatCaller('worker-a'));
    const fromServingCode = await runSend(['worker-b@team-beta', BODY], fromServingWorkerIo, host);
    expect(fromServingCode).toBe(1);
    expect(fromServingWorkerIo.err).toContain('may not send');
    expect(dropsIn(w.rootB, 'team-beta', 'worker-b')).toEqual([]);

    // Conversely, worker-b@team-beta -> worker-a@team-alpha IS admitted: worker-b's HOME project
    // is ServedBeta (`seats-cross-teams: true`), and both teams are members of ServedBeta.
    const fromHomeWorkerIo = testIo(w.rootB, seatCaller('worker-b'));
    const fromHomeCode = await runSend(['worker-a@team-alpha', BODY], fromHomeWorkerIo, host);
    expect(fromHomeCode).toBe(0);
    const dropsOnA = dropsIn(w.rootA, 'team-alpha', 'worker-a');
    expect(dropsOnA.length).toBe(1);
    expect(dropsOnA[0]!.text).toContain(PROJECT_RULES[2]);

    // Case B: Flip the policies — HomeAlpha opens `seats-cross-teams: true` and ServedBeta closes
    // `seats-cross-teams: false`. Now worker-a@team-alpha -> worker-b@team-beta MUST be admitted
    // from worker-a's home chain (HomeAlpha).
    expect(
      writePolicySet(
        w.home,
        { level: 'project', target: 'homealpha', name: 'seats-cross-teams', value: true },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(
      writePolicySet(
        w.home,
        { level: 'project', target: 'servedbeta', name: 'seats-cross-teams', value: false },
        { now: NOW },
      ).ok,
    ).toBe(true);

    const afterFlipIo = testIo(w.rootA, seatCaller('worker-a'));
    const afterFlipCode = await runSend(['worker-b@team-beta', BODY], afterFlipIo, host);
    expect(afterFlipCode).toBe(0);
    const dropsOnB = dropsIn(w.rootB, 'team-beta', 'worker-b');
    expect(dropsOnB.length).toBe(1);
    expect(dropsOnB[0]!.text).toContain(PROJECT_RULES[2]);
  });

  test('5. bare, unplaced, impostor-pane, or unrecorded callers are refused while the placed registered lead is admitted', async () => {
    const w = makeWorld({
      entityA: 'org-alpha',
      entityB: 'org-beta',
      inProjectA: 'HomeAlpha',
      inProjectB: 'ServedBeta',
      projectLeadA: true,
      projectLeadB: true,
      alsoInA: ['ServedBeta'],
      alsoInB: [],
      extraSeatA: seatBlock('implementer', 'unregistered-a', false),
    });

    // Register lead-b, worker-b, lead-a, worker-a — intentionally leave `unregistered-a`
    // unregistered in `~/.config/team/agents/`.
    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootB, 'worker-b');
    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootA, 'worker-a');

    const host = sendHost(w);

    const invalidCallers: Caller[] = [
      { kind: 'unplaced', reason: 'caller pane is not in herdr' },
      { kind: 'owner-no-tty' },
      { kind: 'pane', pane: 'pane-lead-a', session: 'team-alpha' },
      { kind: 'seat', name: 'lead-a', pane: 'pane-lead-a' }, // bare seat without session
      { kind: 'seat', name: 'lead-a', pane: 'pane-lead-a', session: 'foreign-session' }, // wrong session
      { kind: 'seat', name: 'lead-a', pane: 'pane-impostor', session: 'team-alpha' }, // impostor pane
      { kind: 'seat', name: 'unregistered-a', pane: 'pane-unreg-a', session: 'team-alpha' }, // declared seat with no agent record crossing teams
    ];

    for (const badCaller of invalidCallers) {
      const io = testIo(w.rootA, badCaller);
      const code = await runSend(['lead-b@team-beta', BODY], io, host);
      expect(code).toBe(1);
    }
    expect(dropsIn(w.rootB, 'team-beta', 'lead-b')).toEqual([]);

    // Also verify sendGrantFor refuses bare `from` and cross-team bare `to` principals.
    const idA = teamIdOf(w.rootA);
    const idB = teamIdOf(w.rootB);
    const agents = readAgents(w.home);
    const workerA = agents.find((a) => a.reach.team === idA && a.reach.seat === 'worker-a')!;
    const workerB = agents.find((a) => a.reach.team === idB && a.reach.seat === 'worker-b')!;
    const teams = readTeams(w.home);
    const future = new Date(NOW.getTime() + 3600_000).toISOString();

    expect(
      sendGrantFor(
        workerA,
        workerB,
        [
          { name: 'bare-from', from: 'worker-a', to: 'worker-b@team-beta', expires: future },
          { name: 'bare-cross-to', from: 'worker-a@team-alpha', to: 'worker-b', expires: future },
        ],
        teams,
        NOW,
      ),
    ).toBeUndefined();

    // Finally, the properly placed, registered lead-a on its recorded session and pane IS admitted
    // across ServedBeta to lead-b@team-beta.
    const validIo = testIo(w.rootA, seatCaller('lead-a'));
    const validCode = await runSend(['lead-b@team-beta', BODY], validIo, host);
    expect(validCode).toBe(0);
    const drops = dropsIn(w.rootB, 'team-beta', 'lead-b');
    expect(drops.length).toBe(1);
    expect(drops[0]!.text).toContain(PROJECT_RULES[0]);
  });
});
