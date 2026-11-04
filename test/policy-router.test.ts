// The mailbox router's three policy words: `router.aliases`, `router.fallback` and
// `router.reply-bound` (the mailbox-router design note, with the owner's answers of 2026-11-03). The
// words live in the catalogue; `src/policy/router.ts` reads them back into the shape the router
// child consumes, refusing at load with a named error rather than routing a word that broke its
// rules. The bridge's synchronous 120 s cap and the definite-miss fallback rule are the router's
// own mechanics and never policy values.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { planPolicySet, resolvePolicy, writePolicySet } from '../src/policy/index.ts';
import { mailboxRouterPolicyProblem, readMailboxRouterPolicy } from '../src/policy/router.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T12:00:00Z');

const TEAM_YAML = `format: 1
project: beacon
session: beacon
entity: floor
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const parsedTeam = validateTeamFile(TEAM_YAML);
if (!parsedTeam.ok) throw new Error(JSON.stringify(parsedTeam.errors));
/** The fixture's own team, narrowed once: property narrowings do not reach inside functions. */
const TEAM = parsedTeam.team;

const QUIET_LIVE: Live = {
  running: true,
  agents: [
    { name: 'lead', agent: 'claude', pane: 'fixture-pane-1', workspace: 'w1', status: 'idle', cwd: null },
    { name: 'worker', agent: 'claude', pane: 'fixture-pane-2', workspace: 'w2', status: 'idle', cwd: null },
  ],
  workspaces: [
    { id: 'w1', label: workspaceLabel(TEAM.seats[0]!) },
    { id: 'w2', label: workspaceLabel(TEAM.seats[1]!) },
  ],
  screens: { 'fixture-pane-1': CLAUDE_IDLE, 'fixture-pane-2': CLAUDE_IDLE },
};


function makeFixture(session: string = 'beacon'): {
  base: string;
  home: string;
  root: string;
  teamId: string;
  cleanup: () => void;
} {
  // An entity-scoped team spells its session `<entity>-<project>` while its addresses still name
  // the project, so the fixture can be built in either shape.
  const yaml = session === TEAM.session ? TEAM_YAML : TEAM_YAML.replace('session: beacon', `session: ${session}`);
  const parsed = validateTeamFile(yaml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const team = parsed.team;

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-router-policy-')));
  const home = join(base, 'home');
  const root = join(base, 'beacon');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);

  const teamId = teamIdOf(root);
  const leadAgent = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamId, seat: 'lead', session: team.session, pane: 'fixture-pane-1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  const agent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamId, seat: 'worker', session: team.session, pane: 'fixture-pane-2', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  upsertTeam(home, teamId, {
    project: team.project,
    session: team.session,
    root,
    roster: [
      { seat: 'lead', agent: leadAgent.id, role: 'coordinator', leads: true },
      { seat: 'worker', agent: agent.id, role: 'implementer' },
    ],
    at: NOW.toISOString(),
  });
  // The entity's own team: a second registered team whose record carries the entity, so an
  // entity-level word may place an alias on it (the beacon team belongs through its project).
  const floorRoot = join(base, 'floor');
  mkdirSync(floorRoot, { recursive: true });
  upsertTeam(home, teamIdOf(floorRoot), {
    project: 'floor',
    session: 'floor',
    entity: team.entity,
    root: floorRoot,
    roster: [],
    at: NOW.toISOString(),
  });
  upsertProject(home, 'beacon', {
    name: 'beacon',
    entity: team.entity,
    teams: [teamId],
    at: NOW.toISOString(),
  });
  updateState(join(root, '.agents'), (state) => {
    const stateSession = (state.sessions[team.session] ??= emptySession());
    stateSession.watch = { pid: 1, heartbeat: NOW.toISOString() };
    stateSession.seats.lead = { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1' };
    stateSession.seats.worker = { stage: 'ready', pane: 'fixture-pane-2', workspace: 'w2' };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: team.session,
    seats: team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });

  return {
    base,
    home,
    root,
    teamId,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** One owner-signed word, as `team policy set` writes it. */
function setWord(
  fx: { home: string; root: string; teamId: string },
  level: 'entity' | 'team',
  name: string,
  value: string | number,
): void {
  const written = writePolicySet(
    fx.home,
    {
      level,
      target: level === 'entity' ? 'floor' : fx.teamId,
      ...(level === 'team' ? { teamRoot: fx.root } : {}),
      name,
      value,
    },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
}

/** One planned word, refused or accepted, as `team policy set --dry-run` plans it. A refused
 * value names its problem with the level in front, the way every word's plan refusal reads. */
function planWord(
  fx: { home: string; root: string; teamId: string },
  level: 'entity' | 'team' | 'project',
  name: string,
  value: string | number,
): { ok: true } | { ok: false; why: string } {
  const plan = planPolicySet(
    fx.home,
    {
      level,
      target: level === 'entity' ? 'floor' : level === 'team' ? fx.teamId : 'beacon',
      ...(level === 'team' ? { teamRoot: fx.root } : {}),
      name,
      value,
    },
    { now: NOW },
  );
  return plan.ok ? { ok: true } : { ok: false, why: plan.why };
}

describe('the mailbox router policy words', () => {
  test('the release defaults answer when no level declares a word', () => {
    const fx = makeFixture();
    try {
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.policy.routes).toEqual([
        { alias: 'iris', address: 'iris@floor', fallback: null },
        { alias: 'atlas', address: 'orchestrator@floor', fallback: 'iris@floor' },
        { alias: 'zeus', address: 'architect@floor', fallback: null },
      ]);
      expect(read.policy.replyBoundSeconds).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test('an entity aliases word is sparse: it changes what it names and the release map keeps the rest', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.aliases', 'atlas=zeus@floor');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.policy.routes).toEqual([
        { alias: 'iris', address: 'iris@floor', fallback: null },
        { alias: 'atlas', address: 'zeus@floor', fallback: 'iris@floor' },
        { alias: 'zeus', address: 'architect@floor', fallback: null },
      ]);
    } finally {
      fx.cleanup();
    }
  });

  test('an entity word names a team of the entity, never one outside it', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.aliases', 'pal=iris@foreign');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router alias "pal" names "iris@foreign", which is not a team of this entity');
    } finally {
      fx.cleanup();
    }
    const fx2 = makeFixture();
    try {
      setWord(fx2, 'entity', 'router.fallback', 'atlas=iris@foreign');
      const moved = readMailboxRouterPolicy(fx2.root, fx2.home, NOW);
      expect(moved.ok).toBe(false);
      if (moved.ok) return;
      expect(moved.why).toBe('router fallback for "atlas" names "iris@foreign", which is not a team of this entity');
    } finally {
      fx2.cleanup();
    }
  });

  test('a team aliases word adds an alias for its own seats', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.aliases', 'mirror=lead@beacon');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.policy.routes).toEqual([
        { alias: 'iris', address: 'iris@floor', fallback: null },
        { alias: 'atlas', address: 'orchestrator@floor', fallback: 'iris@floor' },
        { alias: 'zeus', address: 'architect@floor', fallback: null },
        { alias: 'mirror', address: 'lead@beacon', fallback: null },
      ]);
    } finally {
      fx.cleanup();
    }
  });

  test('a team alias may spell its team by its id, its name or its session', () => {
    // An entity-scoped team's session is `<entity>-<project>` while its addresses still name the
    // project, so the project spelling must reach the team's own seats the way a send's does.
    const fx = makeFixture('floor-beacon');
    try {
      setWord(
        fx,
        'team',
        'router.aliases',
        `by-name=worker@beacon,by-session=worker@floor-beacon,by-id=worker@${fx.teamId}`,
      );
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const addresses = read.policy.routes
        .filter((route) => route.alias.startsWith('by-'))
        .map((route) => route.address)
        .sort();
      expect(addresses).toEqual([`worker@${fx.teamId}`, 'worker@beacon', 'worker@floor-beacon'].sort());
    } finally {
      fx.cleanup();
    }
  });

  test('a team word that re-declares an entity alias at the same address changes nothing', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.aliases', 'atlas=orchestrator@floor');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.policy.routes).toEqual([
        { alias: 'iris', address: 'iris@floor', fallback: null },
        { alias: 'atlas', address: 'orchestrator@floor', fallback: 'iris@floor' },
        { alias: 'zeus', address: 'architect@floor', fallback: null },
      ]);
    } finally {
      fx.cleanup();
    }
  });

  test('a team word may not retarget an entity alias: the reader names it and the resolver refuses it', () => {
    const fx = makeFixture();
    try {
      // The write lands (the plan checks the value, not the chain); the load refuses it.
      setWord(fx, 'team', 'router.aliases', 'atlas=iris@floor');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router alias "atlas" is set by the entity; a team may add an alias, never retarget one');

      const atLoad = resolvePolicy(
        'router.aliases',
        [
          { name: 'router.aliases', level: 'entity', value: 'atlas=orchestrator@floor', kind: 'advised', setter: 'owner', date: NOW.toISOString(), expiry: null, signature: 'x', target: 'floor', generation: 1 },
          { name: 'router.aliases', level: 'team', value: 'atlas=iris@floor', kind: 'advised', setter: 'owner', date: NOW.toISOString(), expiry: null, signature: 'x', target: 'beacon', generation: 2 },
        ],
        { now: NOW },
      );
      expect(atLoad.ok).toBe(false);
      if (atLoad.ok) return;
      const refusal = atLoad.refusals[0];
      expect(refusal?.kind).toBe('loosening');
      if (refusal?.kind !== 'loosening') return;
      expect(refusal.policy).toBe('router.aliases');
    } finally {
      fx.cleanup();
    }
  });

  test('a team alias may only name a seat of its own team', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.aliases', 'pal=pal@elsewhere');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router alias "pal" names "pal@elsewhere", which is not a seat of this team');
    } finally {
      fx.cleanup();
    }
  });

  test('an alias with no address is refused with a named error, at write and at load', () => {
    const fx = makeFixture();
    try {
      const empty = planWord(fx, 'entity', 'router.aliases', 'iris=');
      expect(empty.ok).toBe(false);
      if (empty.ok) return;
      expect(empty.why).toBe('entity: router alias "iris" has no address');

      const bare = planWord(fx, 'entity', 'router.aliases', 'iris');
      expect(bare.ok).toBe(false);
      if (bare.ok) return;
      expect(bare.why).toBe('entity: router alias "iris" has no address');

      const atLoad = resolvePolicy(
        'router.aliases',
        [{ name: 'router.aliases', level: 'entity', value: 'iris', kind: 'advised', setter: 'owner', date: NOW.toISOString(), expiry: null, signature: 'x', target: 'floor', generation: 1 }],
        { now: NOW },
      );
      expect(atLoad.ok).toBe(false);
      if (atLoad.ok) return;
      const refusal = atLoad.refusals[0];
      expect(refusal?.kind).toBe('invalid-policy');
      if (refusal?.kind !== 'invalid-policy') return;
      expect(refusal.why).toBe('router alias "iris" has no address');
    } finally {
      fx.cleanup();
    }
  });

  test('an alias targeting the desk seat is refused with a named error', () => {
    const fx = makeFixture();
    try {
      const plan = planWord(fx, 'entity', 'router.aliases', 'shadow=desk@beacon');
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.why).toBe('entity: router alias "shadow" targets the desk seat, which no alias may name');

      const atLoad = resolvePolicy(
        'router.aliases',
        [{ name: 'router.aliases', level: 'entity', value: 'shadow=desk@beacon', kind: 'advised', setter: 'owner', date: NOW.toISOString(), expiry: null, signature: 'x', target: 'floor', generation: 1 }],
        { now: NOW },
      );
      expect(atLoad.ok).toBe(false);
      if (atLoad.ok) return;
      const refusal = atLoad.refusals[0];
      expect(refusal?.kind).toBe('invalid-policy');
      if (refusal?.kind !== 'invalid-policy') return;
      expect(refusal.why).toBe('router alias "shadow" targets the desk seat, which no alias may name');
    } finally {
      fx.cleanup();
    }
  });

  test('a target that is not a seat@team address is refused by name', () => {
    const fx = makeFixture();
    try {
      const plan = planWord(fx, 'entity', 'router.aliases', 'shadow=beacon');
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.why).toBe('entity: router alias "shadow" names "beacon", which is not a seat@team address');
    } finally {
      fx.cleanup();
    }
  });

  test('a duplicated alias inside one word is refused', () => {
    const fx = makeFixture();
    try {
      const plan = planWord(fx, 'entity', 'router.aliases', 'iris=iris@floor,iris=helper@floor');
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.why).toBe('entity: router alias "iris" is named twice in one word');
    } finally {
      fx.cleanup();
    }
  });

  test('an entity fallback word may change or clear an entity alias\'s fallback', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.fallback', 'atlas=zeus@floor');
      const moved = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.policy.routes.find((r) => r.alias === 'atlas')?.fallback).toBe('zeus@floor');
    } finally {
      fx.cleanup();
    }
    const fx2 = makeFixture();
    try {
      setWord(fx2, 'entity', 'router.fallback', 'atlas=none');
      const cleared = readMailboxRouterPolicy(fx2.root, fx2.home, NOW);
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) return;
      expect(cleared.policy.routes.find((r) => r.alias === 'atlas')?.fallback).toBeNull();
    } finally {
      fx2.cleanup();
    }
  });

  test('a fallback that names the alias itself is refused with a named error', () => {
    const fx = makeFixture();
    try {
      const plan = planWord(fx, 'entity', 'router.fallback', 'atlas=atlas');
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.why).toBe('entity: router fallback for "atlas" names the alias itself');
    } finally {
      fx.cleanup();
    }
  });

  test('a fallback that names the route\'s own address is a self-loop the reader refuses', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.fallback', 'atlas=orchestrator@floor');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router fallback for "atlas" names the route itself (orchestrator@floor)');
    } finally {
      fx.cleanup();
    }
  });

  test('a team level may not change or clear an entity alias\'s fallback', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.fallback', 'atlas=lead@beacon');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router fallback for "atlas" belongs to the entity; only the entity level may change or clear it');
    } finally {
      fx.cleanup();
    }
  });

  test('a team may set the fallback of an alias it added', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.aliases', 'mirror=lead@beacon');
      setWord(fx, 'team', 'router.fallback', 'mirror=worker@beacon');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.policy.routes.find((r) => r.alias === 'mirror')).toEqual({
        alias: 'mirror',
        address: 'lead@beacon',
        fallback: 'worker@beacon',
      });
    } finally {
      fx.cleanup();
    }
  });

  test('a team fallback for its own alias names a seat of the same team', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.aliases', 'mirror=lead@beacon');
      setWord(fx, 'team', 'router.fallback', 'mirror=outside@other');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router fallback for "mirror" names "outside@other", which is not a seat of this team');
    } finally {
      fx.cleanup();
    }
  });

  test('a fallback naming an alias no map holds is refused', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.fallback', 'ghost=iris@floor');
      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.why).toBe('router fallback names "ghost", which no alias maps');
    } finally {
      fx.cleanup();
    }
  });

  test('router.reply-bound: the nearest level wins, and unset means twice the seat\'s unread window', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.reply-bound', 600);
      const entity = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(entity.ok).toBe(true);
      if (!entity.ok) return;
      expect(entity.policy.replyBoundSeconds).toBe(600);

      setWord(fx, 'team', 'router.reply-bound', 60);
      const team = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(team.ok).toBe(true);
      if (!team.ok) return;
      expect(team.policy.replyBoundSeconds).toBe(60);
    } finally {
      fx.cleanup();
    }
    const fx2 = makeFixture();
    try {
      const none = readMailboxRouterPolicy(fx2.root, fx2.home, NOW);
      expect(none.ok).toBe(true);
      if (!none.ok) return;
      expect(none.policy.replyBoundSeconds).toBeNull();
    } finally {
      fx2.cleanup();
    }
  });

  test('the words take the entity and team levels only, and their values are checked at write', () => {
    const fx = makeFixture();
    try {
      const project = planWord(fx, 'project', 'router.aliases', 'mirror=lead@beacon');
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(project.why).toBe('policy "router.aliases" may not be set at level project (allowed: entity, team)');

      const badBound = planWord(fx, 'entity', 'router.reply-bound', 'forever');
      expect(badBound.ok).toBe(false);
      if (badBound.ok) return;
      expect(badBound.why).toBe('entity: policy "router.reply-bound" is a whole number of seconds from 1 to 86400, such as 600');
    } finally {
      fx.cleanup();
    }
  });

  test('mailboxRouterPolicyProblem names a route that broke its final shape', () => {
    expect(mailboxRouterPolicyProblem([
      { alias: 'iris', address: 'iris@floor', fallback: null },
      { alias: 'iris', address: 'helper@floor', fallback: null },
    ])).toBe('router alias "iris" is named twice');

    expect(mailboxRouterPolicyProblem([
      { alias: 'shadow', address: 'desk@beacon', fallback: null },
    ])).toBe('router alias "shadow" targets the desk seat, which no alias may name');

    expect(mailboxRouterPolicyProblem([
      { alias: 'atlas', address: 'orchestrator@floor', fallback: 'orchestrator@floor' },
    ])).toBe('router fallback for "atlas" names the route itself (orchestrator@floor)');

    expect(mailboxRouterPolicyProblem([
      { alias: 'iris', address: 'iris@floor', fallback: null },
      { alias: 'atlas', address: 'orchestrator@floor', fallback: 'iris@floor' },
    ])).toBeNull();
  });

  test('team check names a router word the load refuses', () => {
    const fx = makeFixture();
    try {
      setWord(fx, 'team', 'router.aliases', 'atlas=iris@floor');
      const io = testIo(fx.root, { kind: 'owner' });
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code, io.err).toBe(1);
      expect(io.out).toContain('difference: router alias "atlas" is set by the entity');
      expect(io.out).toContain('  repair: team policy unset team router.aliases');
    } finally {
      fx.cleanup();
    }
  });
});
