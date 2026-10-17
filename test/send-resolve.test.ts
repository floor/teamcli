// `team send`'s addressing: one spec — an agent id (`agt_…`), a `seat@team` (team = id, project
// or session), or a plain seat of the caller's own team — resolved through the registry, with the
// live herdr read as the fallback for a record that carries no pane yet. The unit scenes pin each
// refusal; the last scenes run the whole command, so the drop the receiver is pointed at carries
// the sender's header, and a spec the registry refuses types nowhere.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent, updateAgent, type Agent } from '../src/registry/agents.ts';
import { readTeams, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { admitSend, senderHeader } from '../src/send/admit.ts';
import type { NativePane } from '../src/send/native.ts';
import { isRegistrySpec, resolveTarget, type LiveAgent } from '../src/send/resolve.ts';
import { updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const OWNER = { kind: 'owner' as const };
const AGENT_ID = /^agt_[0-9a-f]{12}$/;
const BODY = 'the coordinator asked for a status line';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBase(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

function seatBlock(role: string, name: string, cli: string, vendor: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: ${vendor}
    model: Test
    version: "1"
    launch: ${cli} --model test
`;
}

type World = { base: string; home: string; root: string };

/** One root with `.agents/team.yaml`, in a home. A second team joins the first's home: one home
 *  is one lobby, and a file whose trust names another home's lobby does not load. */
function world(project: string, session: string, coordinator: string, seats: string[], into?: World): World {
  const base = into?.base ?? tempBase('r4a-resolve-');
  const home = into?.home ?? join(base, 'h');
  if (!into) mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, project);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${project}
coordinator: ${coordinator}
operator: ${coordinator}
session: ${session}
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seats.join('')}`);
  return { base, home, root };
}

/** One agent record, as `up`/`add` would have registered it. */
function agent(home: string, init: { name: string; role: string; cli: string; team: string; seat: string; session: string; pane: string | null }): Agent {
  return registerAgent(home, {
    name: init.name,
    signing: { model: 'Test', version: '1', role: init.role },
    lab: 'test-lab',
    cli: init.cli,
    launcher: null,
    launch: `${init.cli} --model test`,
    reach: { team: init.team, seat: init.seat, session: init.session, pane: init.pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

function team(home: string, id: string, project: string, session: string, root: string, roster: { agent: string; seat: string; role: string; leads: boolean }[]): void {
  upsertTeam(home, id, { project, entity: project, session, root, lobby: join(home, 'lobby'), roster, lifecycle: 'running' });
}

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. The placement
 *  check reads this, so a caller judged as the file's declared seat is placed here. */
function place(root: string, session: string, seat: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions[session] = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

/** The rule the real admission returns for this target: what the drop's header must carry. */
function admitRuleFor(home: string, target: Agent): string {
  const admitted = admitSend('owner', target, readTeams(home));
  if (!admitted.ok) throw new Error(`the owner's send is not admitted: ${admitted.why}`);
  return admitted.rule;
}

/** One seat of a world, registered and rostered: the common case in these scenes. */
function seatOf(w: World, project: string, session: string, seat: string, role: string, pane: string | null, cli = 'claude-code'): Agent {
  const id = teamIdOf(w.root);
  const made = agent(w.home, { name: seat, role, cli, team: id, seat, session, pane });
  team(w.home, id, project, session, w.root, [{ agent: made.id, seat, role, leads: false }]);
  return made;
}

// ---- unit: the spec grammar, and what each refusal says -------------------------------------

describe('isRegistrySpec', () => {
  test('an agent id, a mistyped one, and a seat@team are the registry\'s; a plain seat is not', () => {
    expect(isRegistrySpec('agt_0123456789ab')).toBe(true);
    expect(isRegistrySpec('agt_nope')).toBe(true);
    expect(isRegistrySpec('lead@beta')).toBe(true);
    expect(isRegistrySpec('builder-1')).toBe(false);
    expect(isRegistrySpec('main')).toBe(false);
  });
});

describe('resolveTarget by agent id', () => {
  test('an id resolves to its team, its agent and the pane the record carries — the live read is never asked', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');
    const never = (): LiveAgent[] => {
      throw new Error('the live read must not be asked when the record carries a pane');
    };

    const target = resolveTarget(w.home, found.id, { cwd: w.root }, never);
    if ('error' in target) throw new Error(`the id did not resolve: ${target.error}`);
    expect(target.agent.id).toBe(found.id);
    expect(target.team.project).toBe('alpha');
    expect(target.pane).toBe('pane-alpha-lead');
  });

  test('a mistyped id, an unknown id and a retired agent each refuse, by name', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');

    expect(resolveTarget(w.home, 'agt_zz', { cwd: w.root })).toEqual({ error: 'agt_zz: that is not an agent id (agt_ plus 12 hex)' });
    expect(resolveTarget(w.home, 'agt_0123456789ab', { cwd: w.root })).toEqual({ error: 'agt_0123456789ab: no registered agent carries that id' });
    updateAgent(w.home, found.id, { lifecycle: 'retired' });
    expect(resolveTarget(w.home, found.id, { cwd: w.root })).toEqual({ error: `${found.id}: the agent is retired; nothing was sent` });
  });
});

describe('resolveTarget by seat@team', () => {
  test('the team may be spelled by id, by project or by session; all three reach the same agent', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');
    const never = (): LiveAgent[] => {
      throw new Error('the live read must not be asked when the record carries a pane');
    };

    for (const spelling of [teamIdOf(w.root), 'alpha']) {
      const target = resolveTarget(w.home, `lead@${spelling}`, { cwd: w.root }, never);
      if ('error' in target) throw new Error(`${spelling} did not resolve: ${target.error}`);
      expect(target.agent.id).toBe(found.id);
      expect(target.pane).toBe('pane-alpha-lead');
    }
    expect(AGENT_ID.test(found.id)).toBe(true);
  });

  test('an unknown team, a team with no such seat, and two @s each refuse', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');

    expect(resolveTarget(w.home, 'lead@ghost', { cwd: w.root })).toEqual({ error: 'lead@ghost: no team registry record matches "ghost" (by id, project or session)' });
    expect(resolveTarget(w.home, 'ghost@alpha', { cwd: w.root })).toEqual({ error: 'ghost@alpha: no registered agent holds the seat "ghost" in that team; `team up` records a seat it launches, or `team register ghost` records one already running' });
    expect(resolveTarget(w.home, 'a@b@c', { cwd: w.root })).toEqual({ error: 'a@b@c: a spec is <seat>@<team>, or an agent id' });
    expect(resolveTarget(w.home, 'lead@', { cwd: w.root })).toEqual({ error: 'lead@: a spec is <seat>@<team>, or an agent id' });
    expect(resolveTarget(w.home, '@alpha', { cwd: w.root })).toEqual({ error: '@alpha: a spec is <seat>@<team>, or an agent id' });
  });
});

describe('resolveTarget by plain seat', () => {
  test('a plain seat resolves inside the caller\'s own team, matched by the id the registry keys on', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'builder-1', 'builder', 'pane-builder');

    const target = resolveTarget(w.home, 'builder-1', { cwd: w.root });
    if ('error' in target) throw new Error(`the plain seat did not resolve: ${target.error}`);
    expect(target.agent.id).toBe(found.id);
    expect(target.team.project).toBe('alpha');
    expect(target.pane).toBe('pane-builder');
  });

  test('a team with no registry record, and a seat nobody holds, each refuse', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    expect(resolveTarget(w.home, 'lead', { cwd: w.root })).toEqual({ error: 'lead: this team has no registry record yet' });

    seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');
    expect(resolveTarget(w.home, 'ghost', { cwd: w.root })).toEqual({ error: 'ghost: no registered agent holds the seat "ghost" in that team; `team up` records a seat it launches, or `team register ghost` records one already running' });
  });

  test('a folder that is no team at all refuses with the folder it could not read', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const bare = join(w.base, 'nowhere');
    mkdirSync(bare, { recursive: true });
    const target = resolveTarget(w.home, 'lead', { cwd: bare });
    if (!('error' in target)) throw new Error('a folder with no team file must not resolve');
    expect(target.error).toContain('the team of the caller\'s folder cannot be read');
  });
});

describe('the pane the record does not carry yet', () => {
  test('a record with no pane falls back to the live read of its session, by the seat\'s name', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'builder-1', 'builder', null);
    const asked: string[] = [];

    const target = resolveTarget(w.home, found.id, { cwd: w.root }, (session) => {
      asked.push(session);
      return [{ name: 'builder-1', pane: 'pane-live' }];
    });
    if ('error' in target) throw new Error(`the live fallback did not resolve: ${target.error}`);
    expect(target.pane).toBe('pane-live');
    expect(asked).toEqual(['alpha']);
  });

  test('a session that answers nothing, no live match, and two live matches each refuse', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'builder-1', 'builder', null);

    expect(resolveTarget(w.home, found.id, { cwd: w.root }, () => null)).toEqual({
      error: `${found.id}: the session "alpha" could not be read for a pane`,
    });
    expect(resolveTarget(w.home, found.id, { cwd: w.root }, () => [])).toEqual({
      error: `${found.id}: no live agent carries the seat "builder-1" in the session "alpha"`,
    });
    expect(resolveTarget(w.home, found.id, { cwd: w.root }, () => [{ name: 'builder-1', pane: 'a' }, { name: 'builder-1', pane: 'b' }])).toEqual({
      error: `${found.id}: herdr lists more than one agent named "builder-1"; nothing was sent`,
    });
  });
});

// ---- the whole command: the drop's header, and a refusal that types nowhere -----------------

type Typed = { session: string; pane: string; text: string };
type Scripted = NativePane & { typed: Typed[]; enters: number };

/** Status samples, one per read: the pre-Enter read, then the polls. `wait` costs nothing. */
function scripted(samples: string[]): Scripted {
  const typed: Typed[] = [];
  let enters = 0;
  let read = 0;
  return {
    typed,
    get enters() {
      return enters;
    },
    typeText: (session, pane, text) => {
      typed.push({ session, pane, text });
      return true;
    },
    pressEnter: () => {
      enters += 1;
      return true;
    },
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

type FakeHost = SendHost & { typedInto: (pane: string) => Typed[] };

/** A fake herdr: named panes with scripted statuses, one session for the live read. */
function sendHost(w: World, session: string, seats: Record<string, { pane: string; paneStatus: Scripted }>): FakeHost {
  const byPane = new Map(Object.values(seats).map((seat) => [seat.pane, seat]));
  const list: { name: string; pane: string }[] = Object.entries(seats).map(([name, seat]) => ({ name, pane: seat.pane }));
  return {
    typedInto: (pane) => byPane.get(pane)?.paneStatus.typed ?? [],
    agents: (asked) => (asked === session ? list : null),
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(w.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (asked, pane, text) => byPane.get(pane)?.paneStatus.typeText(asked, pane, text) ?? false,
      pressEnter: (asked, pane) => byPane.get(pane)?.paneStatus.pressEnter(asked, pane) ?? false,
      status: (asked, pane) => byPane.get(pane)?.paneStatus.status(asked, pane) ?? null,
      wait: async () => {},
    },
    now: () => new Date('2026-10-16T09:00:00Z'),
    home: w.home,
  };
}

/** The drop the trigger names: the typed line's whitespace-free token that is a path. */
function dropOf(typed: string): { path: string; text: string } {
  const word = typed.split(/\s+/).find((part) => part.startsWith('/'));
  if (!word) throw new Error(`no absolute path in the typed trigger: ${typed}`);
  return { path: word, text: readFileSync(word, 'utf8') };
}

describe('the whole command on a registry-resolved spec', () => {
  test('the owner\'s send to another team\'s seat carries the sender header before the body', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const beta = world('beta', 'beta', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')], alpha);
    const betaAgent = agent(beta.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(beta.root), seat: 'lead', session: 'beta', pane: 'pane-beta-lead' });
    team(beta.home, teamIdOf(beta.root), 'beta', 'beta', beta.root, [{ agent: betaAgent.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const betaPane = scripted(['idle', 'working']);
    const alphaPane = scripted(['idle']);
    const host = sendHost(beta, 'beta', { lead: { pane: 'pane-beta-lead', paneStatus: betaPane } });
    // The caller stands in alpha's folder, but the send resolves into beta's world: the live read
    // of alpha's own session must never decide this pane.
    const io = testIo(alpha.root, OWNER);

    const code = await runSend(['lead@beta', BODY], io, host);

    expect(code).toBe(0);
    expect(alphaPane.typed).toEqual([]);
    expect(betaPane.typed.length).toBe(1);
    const typed = betaPane.typed[0] as Typed;
    expect(typed.session).toBe('beta');
    expect(typed.pane).toBe('pane-beta-lead');
    const drop = dropOf(typed.text);
    const admitted = admitSend('owner', betaAgent, readTeams(beta.home));
    if (!admitted.ok) throw new Error(`the owner's send is not admitted: ${admitted.why}`);
    expect(drop.text).toBe(`${senderHeader('owner', admitted.rule)}\n${BODY}`);
    expect(drop.path.startsWith(join(beta.root, '.agents', 'send-drops', 'beta', 'lead'))).toBe(true);
  });

  test('a spec the registry refuses types nowhere and leaves no drop behind', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const beta = world('beta', 'beta', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')], alpha);
    const betaAgent = agent(beta.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(beta.root), seat: 'lead', session: 'beta', pane: 'pane-beta-lead' });
    team(beta.home, teamIdOf(beta.root), 'beta', 'beta', beta.root, [{ agent: betaAgent.id, seat: 'lead', role: 'coordinator', leads: true }]);
    const betaPane = scripted(['idle', 'working']);
    const host = sendHost(beta, 'beta', { lead: { pane: 'pane-beta-lead', paneStatus: betaPane } });
    const io = testIo(alpha.root, OWNER);

    const code = await runSend(['lead@ghost', BODY], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead@ghost: no team registry record matches "ghost"');
    expect(betaPane.typed).toEqual([]);
    expect(betaPane.enters).toBe(0);
    expect(existsSync(join(alpha.root, '.agents', 'send-drops'))).toBe(false);
    expect(existsSync(join(beta.root, '.agents', 'send-drops'))).toBe(false);
  });

  test('a record with no pane sends to the pane the live read names', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const builder = seatOf(alpha, 'alpha', 'alpha', 'builder-1', 'builder', null);
    const builderPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { 'builder-1': { pane: 'pane-live-builder', paneStatus: builderPane }, lead: { pane: 'pane-alpha-lead', paneStatus: scripted(['idle']) } });
    const io = testIo(alpha.root, OWNER);

    const code = await runSend([builder.id, BODY], io, host);

    expect(code).toBe(0);
    expect(builderPane.typed.length).toBe(1);
    const typed = builderPane.typed[0] as Typed;
    expect(typed.pane).toBe('pane-live-builder');
    const drop = dropOf(typed.text);
    expect(drop.text.split('\n')[0]).toBe(senderHeader('owner', admitRuleFor(alpha.home, builder)).trimEnd());
    expect(drop.text).toContain(BODY);
  });

  test('a recorded pane another seat now holds is never typed into', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    // The record still names the pane builder-1 was launched on; herdr now lists the lead there
    // and names no agent of builder-1's at all — the pane was reused after the record was
    // written. The trigger must not go into the lead's box on the strength of the record.
    const builder = agent(alpha.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'builder-1', session: 'alpha', pane: 'pane-reused' });
    team(alpha.home, teamIdOf(alpha.root), 'alpha', 'alpha', alpha.root, [{ agent: builder.id, seat: 'builder-1', role: 'builder', leads: false }]);
    const leadPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { lead: { pane: 'pane-reused', paneStatus: leadPane } });
    const io = testIo(alpha.root, OWNER);

    const code = await runSend([builder.id, BODY], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: builder-1: unreachable: no live agent carries that name in the session\n');
    expect(leadPane.typed).toEqual([]);
    expect(leadPane.enters).toBe(0);
    expect(existsSync(join(alpha.root, '.agents', 'send-drops'))).toBe(false);
  });

  test('a seat herdr lists on another pane is reached there, never at the pane the record carries', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const builder = agent(alpha.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'builder-1', session: 'alpha', pane: 'pane-old' });
    team(alpha.home, teamIdOf(alpha.root), 'alpha', 'alpha', alpha.root, [{ agent: builder.id, seat: 'builder-1', role: 'builder', leads: false }]);
    const builderPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { 'builder-1': { pane: 'pane-new', paneStatus: builderPane } });
    const io = testIo(alpha.root, OWNER);

    const code = await runSend([builder.id, BODY], io, host);

    expect(code).toBe(0);
    expect(builderPane.typed.length).toBe(1);
    const typed = builderPane.typed[0] as Typed;
    expect(typed.pane).toBe('pane-new');
    const drop = dropOf(typed.text);
    expect(drop.text).toContain(BODY);
  });

  test('a seat whose own record is missing is judged as the file\'s seat: the own-team rules admit it', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    // The team record and the target exist; the caller's own seat has no record of its own — the
    // live file declares it, and that declared seat is the identity the own-team rule judges.
    const target = agent(alpha.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(alpha.home, teamIdOf(alpha.root), 'alpha', 'alpha', alpha.root, [{ agent: target.id, seat: 'builder-1', role: 'builder', leads: false }]);
    const builderPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { lead: { pane: 'pane-alpha-lead', paneStatus: scripted(['idle']) }, 'builder-1': { pane: 'pane-builder', paneStatus: builderPane } });
    // The state records the caller on the orchestrator's pane — the placement the declared
    // judgement asks — and it has no agent record of its own.
    place(alpha.root, 'alpha', 'lead', 'pane-alpha-lead');
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-alpha-lead', session: 'alpha' };
    const io = testIo(alpha.root, caller);

    const code = await runSend([target.id, BODY], io, host);

    expect(code).toBe(0);
    const typed = builderPane.typed[0] as Typed;
    const drop = dropOf(typed.text);
    expect(drop.text.split('\n')[0]).toBe(
      "from the file's seat lead (no registry record yet) — admitted by: an orchestrator or operator to a seat of its own team",
    );
    expect(drop.text).toContain(BODY);
  });

  test('a seat whose own record is missing and whose target is another team is refused: no rule names it', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const beta = world('beta', 'beta', 'chief', [seatBlock('coordinator', 'chief', 'claude-code', 'anthropic')], alpha);
    const chief = agent(beta.home, { name: 'chief', role: 'coordinator', cli: 'claude-code', team: teamIdOf(beta.root), seat: 'chief', session: 'beta', pane: 'pane-beta-chief' });
    team(beta.home, teamIdOf(beta.root), 'beta', 'beta', beta.root, [{ agent: chief.id, seat: 'chief', role: 'coordinator', leads: true }]);
    const chiefPane = scripted(['idle', 'working']);
    const host = sendHost(beta, 'beta', { chief: { pane: 'pane-beta-chief', paneStatus: chiefPane } });
    // A record-less caller is judged as the file's seat for its own team's rules only: another
    // team's seat is out of the declared identity's reach until a record exists for it.
    place(alpha.root, 'alpha', 'lead', 'pane-alpha-lead');
    const io = testIo(alpha.root, { kind: 'seat', name: 'lead', pane: 'pane-alpha-lead', session: 'alpha' });

    const code = await runSend([chief.id, BODY], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: no agent record on this machine, so no rule admits the send');
    // The file declares this caller's seat, so the refusal names both commands that record it:
    // `register` is the one that does it where the seat already runs, and it is named first.
    expect(io.err).toContain('`team register lead` records the seat where it already runs, or `team up` registers a seat it leaves standing');
    expect(chiefPane.typed).toEqual([]);
    expect(AGENT_ID.test(chief.id)).toBe(true);
  });
});
