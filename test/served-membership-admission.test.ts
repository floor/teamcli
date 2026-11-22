// Adapted from the adjacent unchanged adversarial reproducer. The original positive cases
// cross entity boundaries and write legacy project-side teams[]. Served membership now lives
// on team records and is restricted to owner-recorded projects in the same entity. Keep those
// obsolete positive assumptions in the reproducer; exercise the current contract here.
// Adversarial red suite for Item 0, Slice 2b (home-only chain, admission over memberships).
//
// Five adversarial scenes:
//   (1) A served project leaking a policy, rule, setting, or lead into the serving team's chain;
//   (2) `also_in` naming a project with no registry record admitting cross-team sends;
//   (3) A served project's lead reaching beyond the serving team's lead (or the serving team
//       claiming lead of the served project);
//   (4) `seats_cross_teams` read from a served project's chain instead of the asker's home chain;
//   (5) A bare, unplaced, or unrecorded caller admitted on a cross-project send.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { crossTeamsFor } from '../src/send/cross-teams.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { resolveProjectIdForTeam, runPolicy } from '../src/commands/policy.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { rulesOf, workSettingsFor } from '../src/launch/rules.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { readAgents } from '../src/registry/agents.ts';
import * as projectRegistry from '../src/registry/projects.ts';
import { getTeam, membershipsOf, readTeams, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
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
  const entityB = opts?.entityB ?? 'org-alpha';
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

describe('home and served membership admission', () => {
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
  test('6. only an owner run in force records or removes served memberships from the file', async () => {
    const w = makeWorld({ alsoInA: [] });
    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootA, 'lead-a');
    const path = join(w.rootA, '.agents', 'team.yaml');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('in_project: HomeAlpha', 'in_project: HomeAlpha\nalso_in: [ServedBeta]'));
    function sync(owner: boolean, devMode = false): void {
      const loaded = readTeamConfig(w.rootA, { home: w.home });
      if (!loaded.ok) throw new Error('fixture config');
      const seat = loaded.team.seats.find(s => s.name === 'lead-a')!;
      const result = registerLaunch({ home: w.home, team: loaded.team, root: w.rootA, by: 'fixture', owner, devMode }, seat, PANES['lead-a']!.pane);
      expect('note' in result).toBe(false);
    }
    const ids = () => membershipsOf(getTeam(w.home, teamIdOf(w.rootA))!);
    sync(false);
    expect(ids()).toEqual(['homealpha']);
    sync(true, true);
    expect(ids()).toEqual(['homealpha']);
    sync(true);
    expect(ids()).toEqual(['homealpha', 'servedbeta']);
    writeFileSync(path, original);
    sync(false);
    expect(ids()).toEqual(['homealpha', 'servedbeta']);
    sync(true);
    expect(ids()).toEqual(['homealpha']);
  });

  test('7. foreign served projects register nothing and stale foreign memberships admit nothing', async () => {
    const w = makeWorld({ entityB: 'org-beta' });
    await registerSeat(w, w.rootB, 'lead-b');
    await registerSeat(w, w.rootB, 'worker-b');
    await registerSeat(w, w.rootA, 'lead-a');
    await registerSeat(w, w.rootA, 'worker-a');
    const idA = teamIdOf(w.rootA);
    expect(membershipsOf(getTeam(w.home, idA)!)).toEqual(['homealpha']);
    expect(projectRegistry.get(w.home, 'servedbeta')?.teams).not.toContain(idA);
    // A stale or corrupt stored link is not enough, even with a signed opening in the home.
    upsertTeam(w.home, idA, { projects: ['homealpha', 'servedbeta'] });
    expect(writePolicySet(w.home, { level: 'project', target: 'homealpha', name: 'seats-cross-teams', value: true }, { now: NOW }).ok).toBe(true);
    for (const [from, to] of [['lead-a', 'lead-b'], ['worker-a', 'worker-b']] as const) {
      const io = testIo(w.rootA, seatCaller(from));
      expect(await runSend([`${to}@team-beta`, BODY], io, sendHost(w))).toBe(1);
      expect(dropsIn(w.rootB, 'team-beta', to)).toEqual([]);
    }
  });

  test('10. the crossing policy reader uses only the asker home chain and reads no foreign runtime', async () => {
    const w = makeWorld();
    for (const [root, names] of [[w.rootB, ['lead-b', 'worker-b']], [w.rootA, ['lead-a', 'worker-a']]] as const) {
      for (const name of names) await registerSeat(w, root, name);
    }
    expect(writePolicySet(w.home, { level: 'project', target: 'homealpha', name: 'seats-cross-teams', value: true }, { now: NOW }).ok).toBe(true);
    const loaded = readTeamConfig(w.rootA, { home: w.home });
    if (!loaded.ok) throw new Error('fixture config');
    const worker = readAgents(w.home).find(a => a.reach.team === teamIdOf(w.rootA) && a.reach.seat === 'worker-a')!;
    const paths: string[] = [];
    const original = fs.readFileSync;
    const watched = spyOn(fs, 'readFileSync').mockImplementation(((path: Parameters<typeof fs.readFileSync>[0], options: never) => {
      paths.push(String(path));
      return original(path, options);
    }) as typeof fs.readFileSync);
    try {
      expect(crossTeamsFor(w.home, loaded.team, teamIdOf(w.rootA), worker, NOW)).toEqual({ ok: true, declared: { project: true } });
    } finally { watched.mockRestore(); }
    expect(paths.some(path => path.startsWith(w.rootB))).toBe(false);
    expect(paths.some(path => /(?:screens|send-drops|messages\.jsonl|drops)/.test(path))).toBe(false);
    // A foreign home record cannot provide the opening, even with a valid owner signature.
    projectRegistry.upsertProject(w.home, 'homealpha', { entity: 'org-beta' });
    const io = testIo(w.rootA, seatCaller('worker-a'));
    expect(await runSend(['worker-b@team-beta', BODY], io, sendHost(w))).toBe(1);
    expect(dropsIn(w.rootB, 'team-beta', 'worker-b')).toEqual([]);
  });

});
