// `team send`'s addressing: one spec — an agent id (`agt_…`), a `@nickname`, a `seat@team` (team
// = id, project or session; `lead@team` is the team's lead), or a plain seat of the caller's own
// team — resolved through the registry, with the live herdr read as the fallback for a record
// that carries no pane yet. The unit scenes pin each refusal; the last scenes run the whole
// command, so the drop the receiver is pointed at carries the sender's header, and a spec the
// registry refuses types nowhere.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { agentsDir, registerAgent, updateAgent, type Agent } from '../src/registry/agents.ts';
import { readTeams, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { admitSend, senderHeader } from '../src/send/admit.ts';
import { historyPath } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { isRegistrySpec, parseSpec, resolveTarget, type LiveAgent } from '../src/send/resolve.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { installKey } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { gitEnv, recordBody, testIo } from './helpers.ts';

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
${seats.join('')}# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the drop file is named and its line typed. The team's word keeps the default's drop step
# (which types nothing) out.
delivery_order: [mcp-inbox, typed]
`);
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

function team(home: string, id: string, project: string, session: string, root: string, roster: { agent: string; seat: string; role: string; leads: boolean; nickname?: string }[], entity = project): void {
  // The file sets neither `entity` nor `lobby`, so the lobby its seats start in — and the entry
  // its trust lists — is the machine lobby; the record says the same, as `up` would have noted it.
  upsertTeam(home, id, { project, entity, session, root, lobby: lobbyDir(home), roster, lifecycle: 'running' });
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
function seatOf(w: World, project: string, session: string, seat: string, role: string, pane: string | null, cli = 'claude-code', extra: { nickname?: string; leads?: boolean } = {}): Agent {
  const id = teamIdOf(w.root);
  const made = agent(w.home, { name: seat, role, cli, team: id, seat, session, pane });
  team(w.home, id, project, session, w.root, [{ agent: made.id, seat, role, leads: extra.leads === true, ...(extra.nickname === undefined ? {} : { nickname: extra.nickname }) }]);
  return made;
}

/** One signed nickname on an agent record, through the store's own plan and write. */
function signNickname(home: string, agentId: string, nickname: string): void {
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const plan = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'nickname', value: nickname }] });
  if (!plan.ok) throw new Error(`the plan was refused: ${plan.why}`);
  const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T08:00:00.000Z') });
  if (!written.ok) throw new Error(`the write was refused: ${written.why}`);
}

// ---- unit: the spec grammar, and what each refusal says -------------------------------------

describe('isRegistrySpec', () => {
  test('an agent id, a mistyped one, a nickname and a seat@team are the registry\'s; a plain seat is not', () => {
    expect(isRegistrySpec('agt_0123456789ab')).toBe(true);
    expect(isRegistrySpec('agt_nope')).toBe(true);
    expect(isRegistrySpec('lead@beta')).toBe(true);
    expect(isRegistrySpec('@hephaestus')).toBe(true);
    expect(isRegistrySpec('builder-1')).toBe(false);
    expect(isRegistrySpec('main')).toBe(false);
  });
});

describe('parseSpec', () => {
  test('one grammar: an agent id, a leading @ for a nickname, one @ with a scope after it, or a plain target', () => {
    expect(parseSpec('agt_0123456789ab')).toEqual({ kind: 'id', id: 'agt_0123456789ab' });
    // A leading @ is always a nickname, whatever follows it: `@x` never means the team's lead.
    expect(parseSpec('@hephaestus')).toEqual({ kind: 'nickname', nickname: 'hephaestus' });
    // `lead` is the reserved target that names a team's lead.
    expect(parseSpec('lead@api')).toEqual({ kind: 'at', target: 'lead', scope: 'api' });
    expect(parseSpec('zeus@api')).toEqual({ kind: 'at', target: 'zeus', scope: 'api' });
    expect(parseSpec('builder-1')).toEqual({ kind: 'seat', seat: 'builder-1' });
    expect(parseSpec('a@b@c')).toEqual({ error: 'a@b@c: a spec is @<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id' });
    expect(parseSpec('lead@')).toEqual({ error: 'lead@: a spec is @<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id' });
    expect(parseSpec('@')).toEqual({ error: '@: a spec is @<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id' });
    expect(parseSpec('@a@b')).toEqual({ error: '@a@b: a spec is @<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id' });
    expect(parseSpec('agt_zz')).toEqual({ error: 'agt_zz: that is not an agent id (agt_ plus 12 hex)' });
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
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const found = seatOf(w, 'alpha', 'alpha', 'builder-1', 'builder', 'pane-builder');
    const never = (): LiveAgent[] => {
      throw new Error('the live read must not be asked when the record carries a pane');
    };

    for (const spelling of [teamIdOf(w.root), 'alpha']) {
      const target = resolveTarget(w.home, `builder-1@${spelling}`, { cwd: w.root }, never);
      if ('error' in target) throw new Error(`${spelling} did not resolve: ${target.error}`);
      expect(target.agent.id).toBe(found.id);
      expect(target.pane).toBe('pane-builder');
    }
    expect(AGENT_ID.test(found.id)).toBe(true);
  });

  test('an unknown team, a team with no such seat, and two @s each refuse', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');

    expect(resolveTarget(w.home, 'lead@ghost', { cwd: w.root })).toEqual({ error: 'lead@ghost: no team registry record matches "ghost" (by id, project or session)' });
    expect(resolveTarget(w.home, 'ghost@alpha', { cwd: w.root })).toEqual({ error: 'ghost@alpha: no registered agent holds the seat or nickname "ghost" in that team; `team up` records a seat it launches, or `team register ghost` records one already running' });
    expect(resolveTarget(w.home, 'a@b@c', { cwd: w.root })).toEqual({ error: 'a@b@c: a spec is @<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id' });
    expect(resolveTarget(w.home, 'lead@', { cwd: w.root })).toEqual({ error: 'lead@: a spec is @<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id' });
  });
});

describe('resolveTarget by the team\'s lead address and by nickname', () => {
  test('lead@team resolves to the seat its roster marks as lead, across the team spellings', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true, nickname: 'zeus' },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false },
    ]);
    const never = (): LiveAgent[] => {
      throw new Error('the live read must not be asked when the record carries a pane');
    };

    for (const spelling of [teamIdOf(w.root), 'alpha']) {
      const target = resolveTarget(w.home, `lead@${spelling}`, { cwd: w.root }, never);
      if ('error' in target) throw new Error(`${spelling} did not resolve: ${target.error}`);
      expect(target.agent.id).toBe(lead.id);
      expect(target.pane).toBe('pane-alpha-lead');
    }
  });

  test('a roster written before the `leads` capability reaches the lead its file names', () => {
    // An upgraded 0.3.5/0.4 team: the file names its lead with the legacy `coordinator:` key and
    // no `leads: true`, and the registry roster written then carries no capability on any line.
    // The address reads the file's own lead — the seat, never the role word — so the send works
    // without the role rename.
    const w = world('alpha', 'alpha', 'steward', [seatBlock('coordinator', 'steward', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'steward', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'steward', session: 'alpha', pane: 'pane-alpha-lead' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [{ agent: lead.id, seat: 'steward', role: 'coordinator', leads: false }]);
    const never = (): LiveAgent[] => {
      throw new Error('the live read must not be asked when the record carries a pane');
    };

    const target = resolveTarget(w.home, 'lead@alpha', { cwd: w.root }, never);
    if ('error' in target) throw new Error(`lead@alpha did not resolve: ${target.error}`);
    expect(target.agent.id).toBe(lead.id);
    expect(target.pane).toBe('pane-alpha-lead');
  });

  test('a nickname answers at a team, and bare in the caller\'s own team; a plain seat still answers', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true, nickname: 'zeus' },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'hephaestus' },
    ]);

    const atTeam = resolveTarget(w.home, 'hephaestus@alpha', { cwd: w.root });
    if ('error' in atTeam) throw new Error(`the nickname did not resolve at the team: ${atTeam.error}`);
    expect(atTeam.agent.id).toBe(builder.id);
    const bare = resolveTarget(w.home, 'hephaestus', { cwd: w.root });
    if ('error' in bare) throw new Error(`the bare nickname did not resolve: ${bare.error}`);
    expect(bare.agent.id).toBe(builder.id);
    const bySeat = resolveTarget(w.home, 'builder-1', { cwd: w.root });
    if ('error' in bySeat) throw new Error(`the seat did not resolve: ${bySeat.error}`);
    expect(bySeat.agent.id).toBe(builder.id);
  });

  test('a signed nickname is the address, and the roster word it replaced names nobody', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true, nickname: 'zeus' },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'hephaestus' },
    ]);
    signNickname(w.home, builder.id, 'wren');

    // The signed word stands where the file's word did: both spellings reach the seat…
    for (const spec of ['wren@alpha', '@wren']) {
      const target = resolveTarget(w.home, spec, { cwd: w.root });
      if ('error' in target) throw new Error(`${spec} did not resolve: ${target.error}`);
      expect(target.agent.id).toBe(builder.id);
    }
    // …and the word the signed record replaced addresses nobody any more.
    expect(resolveTarget(w.home, '@hephaestus', { cwd: w.root })).toEqual({
      error: '@hephaestus: no seat carries the nickname "hephaestus"; `team send --list` shows the addresses',
    });
  });

  test('a signed nickname equal to another seat\'s name is refused, naming both', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false },
    ]);
    signNickname(w.home, lead.id, 'builder-1');

    expect(resolveTarget(w.home, 'builder-1', { cwd: w.root })).toEqual({
      error: 'builder-1: the spec matches two seats — the seat "builder-1" and the nickname "builder-1" of the seat "lead"; nothing was sent',
      kind: 'ambiguous',
    });
  });

  test('a nickname over a record that does not verify is refused, never read as absence', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false },
    ]);
    signNickname(w.home, builder.id, 'wren');
    const path = join(agentsDir(w.home), `${builder.id}.yaml`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('value: "wren"', 'value: "crow"'));

    // Falling back to the roster's projection would resolve an address the store disowns; the
    // send refuses and names the record instead.
    const target = resolveTarget(w.home, '@wren', { cwd: w.root });
    expect('error' in target).toBe(true);
    if (!('error' in target)) return;
    expect(target.kind).toBe('configuration');
    expect(target.error).toContain(path);
    expect(target.error).toContain('signature verification failed');
  });

  test('no role addresses: a spec equal to a seat\'s role names nobody', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }]);

    expect(resolveTarget(w.home, 'coordinator@alpha', { cwd: w.root })).toEqual({ error: 'coordinator@alpha: no registered agent holds the seat or nickname "coordinator" in that team; `team up` records a seat it launches, or `team register coordinator` records one already running' });
  });

  test('a team with no lead refuses its lead address: there is no one to deliver to', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [{ agent: builder.id, seat: 'builder-1', role: 'builder', leads: false }]);

    expect(resolveTarget(w.home, 'lead@alpha', { cwd: w.root })).toEqual({
      error: 'lead@alpha: this team has no lead seat, so there is no one to deliver to; name a seat (team send --list) or give a seat `leads`',
    });
  });

  test('two leads refuse the lead address, naming both rather than taking the first', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('coordinator', 'lead-2', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const second = agent(w.home, { name: 'lead-2', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead-2', session: 'alpha', pane: 'pane-alpha-lead-2' });
    // The file load refuses two leads; a registry written elsewhere can still hold them, and
    // `lead@alpha` must not deliver to whichever line came first.
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: second.id, seat: 'lead-2', role: 'coordinator', leads: true },
    ]);

    expect(resolveTarget(w.home, 'lead@alpha', { cwd: w.root })).toEqual({
      error: 'lead@alpha: this team has more than one lead seat — "lead" and "lead-2"; nothing was sent',
      kind: 'ambiguous',
    });
  });

  test('the lead address always reaches the seat holding leads, never a stale seat or nickname named lead', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    // The load refuses this collision now (a nickname may not be "lead"); a registry written
    // elsewhere can still hold it. The lead address is reserved, so it takes the leads seat even
    // so; the bare word is the seats-or-nickname union and refuses the two answers.
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'lead' },
    ]);

    const atLead = resolveTarget(w.home, 'lead@alpha', { cwd: w.root });
    if ('error' in atLead) throw new Error(`the lead address did not resolve: ${atLead.error}`);
    expect(atLead.agent.id).toBe(lead.id);
    expect(resolveTarget(w.home, 'lead', { cwd: w.root })).toEqual({
      error: 'lead: the spec matches two seats — the seat "lead" and the nickname "lead" of the seat "builder-1"; nothing was sent',
      kind: 'ambiguous',
    });
  });
});

describe('resolveTarget by @nickname', () => {
  /** A second team in the same home; its seats are registered under its own id. */
  function secondTeam(w: World, project: string, seats: { seat: string; nickname: string; leads?: boolean }[], entity: string): Agent[] {
    const root = world(project, project, 'atlas', seats.map((one) => seatBlock(one.leads === true ? 'coordinator' : 'builder', one.seat, 'claude-code', 'anthropic')), w).root;
    const id = teamIdOf(root);
    const registered = seats.map((one) =>
      agent(w.home, { name: one.seat, role: one.leads === true ? 'coordinator' : 'builder', cli: 'claude-code', team: id, seat: one.seat, session: project, pane: `pane-${project}-${one.seat}` }));
    team(w.home, id, project, project, root, seats.map((one, index) => ({ agent: registered[index]!.id, seat: one.seat, role: one.leads === true ? 'coordinator' : 'builder', leads: one.leads === true, nickname: one.nickname })), entity);
    return registered;
  }

  test('@nick unique: the caller\'s own team first, then the teams of its entity', () => {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const atlas = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-alpha-atlas' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: id, seat: 'builder-1', session: 'alpha', pane: 'pane-alpha-builder' });
    team(w.home, id, 'alpha', 'alpha', w.root, [
      { agent: atlas.id, seat: 'atlas', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'zeus' },
    ]);

    const own = resolveTarget(w.home, '@zeus', { cwd: w.root });
    if ('error' in own) throw new Error(`the nickname did not resolve in its own team: ${own.error}`);
    expect(own.agent.id).toBe(builder.id);
  });

  test('@nick in two teams: the caller\'s team answers first, the same nickname in a sibling never shadows it', () => {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const atlas = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-alpha-atlas' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: id, seat: 'builder-1', session: 'alpha', pane: 'pane-alpha-builder' });
    team(w.home, id, 'alpha', 'alpha', w.root, [
      { agent: atlas.id, seat: 'atlas', role: 'coordinator', leads: true },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'zeus' },
    ]);
    const [, betaBuilder] = secondTeam(w, 'beta', [{ seat: 'atlas', nickname: 'hera', leads: true }, { seat: 'builder-1', nickname: 'zeus' }], 'alpha');

    const own = resolveTarget(w.home, '@zeus', { cwd: w.root });
    if ('error' in own) throw new Error(`the nickname did not resolve in the caller's team: ${own.error}`);
    expect(own.agent.id).toBe(builder.id);

    // From the sibling's folder, the same word reaches the sibling's own seat.
    const there = resolveTarget(w.home, '@zeus', { cwd: join(w.base, 'beta') });
    if ('error' in there) throw new Error(`the nickname did not resolve in the sibling team: ${there.error}`);
    expect(there.agent.id).toBe(betaBuilder!.id);
  });

  test('@nick in the entity but not the caller\'s team resolves there; @nick outside the entity is not searched', () => {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const atlas = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-alpha-atlas' });
    team(w.home, id, 'alpha', 'alpha', w.root, [{ agent: atlas.id, seat: 'atlas', role: 'coordinator', leads: true }]);
    const [, betaBuilder] = secondTeam(w, 'beta', [{ seat: 'atlas', nickname: 'hera', leads: true }, { seat: 'builder-1', nickname: 'hermes' }], 'alpha');
    secondTeam(w, 'gamma', [{ seat: 'atlas', nickname: 'ares', leads: true }], 'other');

    const entitySibling = resolveTarget(w.home, '@hermes', { cwd: w.root });
    if ('error' in entitySibling) throw new Error(`the entity sibling's nickname did not resolve: ${entitySibling.error}`);
    expect(entitySibling.agent.id).toBe(betaBuilder!.id);

    expect(resolveTarget(w.home, '@ares', { cwd: w.root })).toEqual({
      error: '@ares: no seat carries the nickname "ares"; `team send --list` shows the addresses',
    });
  });

  test('@nick unknown is refused, pointing at the list; two teams holding it are refused, naming the addresses', () => {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const atlas = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-alpha-atlas' });
    team(w.home, id, 'alpha', 'alpha', w.root, [{ agent: atlas.id, seat: 'atlas', role: 'coordinator', leads: true }]);
    secondTeam(w, 'beta', [{ seat: 'atlas', nickname: 'hera', leads: true }, { seat: 'builder-1', nickname: 'zeus' }], 'alpha');
    secondTeam(w, 'gamma', [{ seat: 'atlas', nickname: 'ares', leads: true }, { seat: 'builder-1', nickname: 'zeus' }], 'alpha');
    const outside = join(w.base, 'nowhere');
    mkdirSync(outside, { recursive: true });

    expect(resolveTarget(w.home, '@hermes', { cwd: w.root })).toEqual({
      error: '@hermes: no seat carries the nickname "hermes"; `team send --list` shows the addresses',
    });
    // Outside any team's folder the caller's own team is unknown, so every registry record is
    // asked; two answers are refused rather than one picked.
    expect(resolveTarget(w.home, '@zeus', { cwd: outside })).toEqual({
      error: '@zeus: the nickname "zeus" is on more than one team: zeus@beta or zeus@gamma: say which',
      kind: 'ambiguous',
    });
  });

  test('a nickname two roster lines carry in one team refuses, naming both seats', () => {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const atlas = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-alpha-atlas' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: id, seat: 'builder-1', session: 'alpha', pane: 'pane-alpha-builder' });
    // The load refuses two nicknames equal in one team; a registry written elsewhere can hold them.
    team(w.home, id, 'alpha', 'alpha', w.root, [
      { agent: atlas.id, seat: 'atlas', role: 'coordinator', leads: true, nickname: 'zeus' },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'zeus' },
    ]);

    expect(resolveTarget(w.home, '@zeus', { cwd: w.root })).toEqual({
      error: '@zeus: the nickname "zeus" names more than one seat of this team — the seat "atlas" and the seat "builder-1"; nothing was sent',
      kind: 'ambiguous',
    });
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

  test('mixed widths in one team each resolve to their own seat: builder-9, builder-10, builder-100', () => {
    const names = ['builder-9', 'builder-10', 'builder-100'];
    const w = world('alpha', 'alpha', 'lead', [
      seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'),
      ...names.map((name) => seatBlock('builder', name, 'claude-code', 'deepseek')),
    ]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: id, seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builders = names.map((name) =>
      agent(w.home, { name, role: 'builder', cli: 'claude-code', team: id, seat: name, session: 'alpha', pane: `pane-${name}` }));
    team(w.home, id, 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      ...builders.map((builder) => ({ agent: builder.id, seat: builder.reach.seat, role: 'builder', leads: false })),
    ]);

    for (const [index, name] of names.entries()) {
      const target = resolveTarget(w.home, name, { cwd: w.root });
      if ('error' in target) throw new Error(`${name} did not resolve: ${target.error}`);
      expect(target.agent.id).toBe(builders[index]!.id);
      expect(target.agent.reach.seat).toBe(name);
      expect(target.pane).toBe(`pane-${name}`);
    }
  });

  test('a team with no registry record, and a seat nobody holds, each refuse', () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    expect(resolveTarget(w.home, 'lead', { cwd: w.root })).toEqual({ error: 'lead: this team has no registry record yet' });

    seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead');
    expect(resolveTarget(w.home, 'ghost', { cwd: w.root })).toEqual({ error: 'ghost: no registered agent holds the seat or nickname "ghost" in that team; `team up` records a seat it launches, or `team register ghost` records one already running' });
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

/** The record the trigger names: the typed line's whitespace-free token that is a path, and
 *  the signed record's body. */
function dropOf(typed: string): { path: string; text: string } {
  const word = typed.split(/\s+/).find((part) => part.startsWith('/'));
  if (!word) throw new Error(`no absolute path in the typed trigger: ${typed}`);
  return { path: word, text: recordBody(word) };
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

  test('--list prints the nickname a seat signed, and every row is a spec the resolver takes', async () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const lead = agent(w.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(w.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(w.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, teamIdOf(w.root), 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true, nickname: 'zeus' },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'hephaestus' },
    ]);
    signNickname(w.home, builder.id, 'wren');
    const host = sendHost(w, 'alpha', {});
    const io = testIo(w.root, OWNER);

    const code = await runSend(['--list'], io, host);

    expect(code).toBe(0);
    // The signed word replaces the file's in the row: the printed address is the one @wren takes.
    expect(io.out).toContain('@wren');
    expect(io.out).not.toContain('@hephaestus');
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

  test('a bare spec two registry entries answer is refused before the declared seat, in a send and a record', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [
      seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'),
      seatBlock('web', 'web-lead', 'claude-code', 'anthropic'),
      seatBlock('builder', 'builder-1', 'claude-code', 'anthropic'),
    ]);
    const lead = agent(alpha.home, { name: 'lead', role: 'coordinator', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'lead', session: 'alpha', pane: 'pane-alpha-lead' });
    const webLead = agent(alpha.home, { name: 'web-lead', role: 'web', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'web-lead', session: 'alpha', pane: 'pane-web-lead' });
    const builder = agent(alpha.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    // `web-lead` is one seat's name and another seat's nickname. The file cannot carry that
    // collision — the load refuses it — but a registry written elsewhere can, and a bare spec
    // must never fall through to the declared seat of that name while `web-lead@alpha` refuses.
    team(alpha.home, teamIdOf(alpha.root), 'alpha', 'alpha', alpha.root, [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: webLead.id, seat: 'web-lead', role: 'web', leads: false },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'web-lead' },
    ]);
    const webPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { 'web-lead': { pane: 'pane-web-lead', paneStatus: webPane }, 'builder-1': { pane: 'pane-builder', paneStatus: scripted(['idle']) } });
    const refusal = 'team send: refused: web-lead: the spec matches two seats — the seat "web-lead" and the nickname "web-lead" of the seat "builder-1"; nothing was sent\n';

    const dry = testIo(alpha.root, OWNER);
    expect(await runSend(['web-lead', BODY, '--dry-run'], dry, host)).toBe(1);
    expect(dry.err).toBe(refusal);
    const recorded = testIo(alpha.root, OWNER);
    expect(await runSend(['--record', 'web-lead', '--channel', 'native', '--ms', '812'], recorded, host)).toBe(1);
    expect(recorded.err).toBe(refusal);
    expect(webPane.typed).toEqual([]);
    expect(existsSync(join(alpha.root, '.agents', 'send-drops'))).toBe(false);
    expect(existsSync(historyPath('alpha', alpha.root, alpha.home))).toBe(false);
  });

  test('a bare nickname the registry has no record for resolves through the local file', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [
      seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'),
      `${seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')}    nickname: hephaestus\n`,
    ]);
    // No registry record at all: the declared-seat path answers the bare nickname by the file's
    // own seats, instead of calling the seat undeclared.
    const helperPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { 'builder-1': { pane: 'pane-builder', paneStatus: helperPane } });
    const io = testIo(alpha.root, OWNER);

    const code = await runSend(['hephaestus', BODY], io, host);

    expect(code).toBe(0);
    expect(helperPane.typed.length).toBe(1);
    const typed = helperPane.typed[0] as Typed;
    expect(typed.pane).toBe('pane-builder');
    const drop = dropOf(typed.text);
    expect(drop.text).toBe(`from the owner — admitted by: the owner\n\n${BODY}`);
    expect(drop.path.startsWith(join(alpha.root, '.agents', 'send-drops', 'alpha', 'builder-1'))).toBe(true);
  });

  test('a bare nickname the registry has no record for answers to the word its record signs', async () => {
    const alpha = world('alpha', 'alpha', 'lead', [
      seatBlock('coordinator', 'lead', 'claude-code', 'anthropic'),
      `${seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')}    nickname: hephaestus\n`,
    ]);
    // The seat's record signs another word: the declared-seat path takes the word the listing
    // prints and the registry addresses, so the file's replaced word names nobody.
    const builder = agent(alpha.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: teamIdOf(alpha.root), seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    signNickname(alpha.home, builder.id, 'wren');
    const helperPane = scripted(['idle', 'working']);
    const host = sendHost(alpha, 'alpha', { 'builder-1': { pane: 'pane-builder', paneStatus: helperPane } });
    const io = testIo(alpha.root, OWNER);

    const code = await runSend(['wren', BODY], io, host);

    expect(code).toBe(0);
    expect(helperPane.typed.length).toBe(1);
    const typed = helperPane.typed[0] as Typed;
    expect(typed.pane).toBe('pane-builder');
    const drop = dropOf(typed.text);
    expect(drop.path.startsWith(join(alpha.root, '.agents', 'send-drops', 'alpha', 'builder-1'))).toBe(true);

    // The native handoff names the same seat: the recorded run resolves the word as the send
    // does, so a delivery the sender makes itself reaches the seat the word signs.
    const recorded = testIo(alpha.root, OWNER);
    expect(await runSend(['--record', 'wren', '--channel', 'native', '--ms', '812', '--dry-run'], recorded, host)).toBe(0);
    expect(recorded.out).toContain('builder-1: would record (native, 812 ms); nothing was written');

    const replaced = testIo(alpha.root, OWNER);
    expect(await runSend(['hephaestus', BODY], replaced, host)).toBe(1);
    expect(replaced.err).toBe(`team send: refused: hephaestus: it is not a declared seat; the file's seats are lead, builder-1\n`);
  });
});

describe('the whole command from a folder that is no team', () => {
  /** A team whose lead is `atlas` and whose builder carries the nickname `hermes`. */
  function teamWorld(): { w: World; lead: Agent; builder: Agent } {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic'), seatBlock('builder', 'builder-1', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const lead = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-atlas' });
    const builder = agent(w.home, { name: 'builder-1', role: 'builder', cli: 'claude-code', team: id, seat: 'builder-1', session: 'alpha', pane: 'pane-builder' });
    team(w.home, id, 'alpha', 'alpha', w.root, [
      { agent: lead.id, seat: 'atlas', role: 'coordinator', leads: true, nickname: 'zeus' },
      { agent: builder.id, seat: 'builder-1', role: 'builder', leads: false, nickname: 'hermes' },
    ]);
    return { w, lead, builder };
  }

  /** One send with its own fake herdr, so only that send's pane holds a typed line. */
  async function sends(w: World, spec: string, session = 'alpha'): Promise<{ code: number; io: ReturnType<typeof testIo>; panes: { atlas: Scripted; 'builder-1': Scripted } }> {
    const panes = { atlas: scripted(['idle', 'working']), 'builder-1': scripted(['idle', 'working']) };
    const host = sendHost(w, session, {
      atlas: { pane: 'pane-atlas', paneStatus: panes.atlas },
      'builder-1': { pane: 'pane-builder', paneStatus: panes['builder-1'] },
    });
    const outside = join(w.base, 'nowhere');
    mkdirSync(outside, { recursive: true });
    const io = testIo(outside, OWNER);
    const code = await runSend([spec, BODY], io, host);
    return { code, io, panes };
  }

  test('a full address still resolves: seat@team, nickname@team, the lead address and an agent id', async () => {
    const { w, lead, builder } = teamWorld();

    for (const spec of ['builder-1@alpha', 'hermes@alpha', builder.id]) {
      const sent = await sends(w, spec);
      expect(sent.code).toBe(0);
      const typed = sent.panes['builder-1'].typed;
      expect(typed.length).toBe(1);
      expect((typed[0] as Typed).pane).toBe('pane-builder');
      const drop = dropOf((typed[0] as Typed).text);
      expect(drop.text).toBe(`from the owner — admitted by: the owner\n\n${BODY}`);
      expect(drop.path.startsWith(join(w.root, '.agents', 'send-drops', 'alpha', 'builder-1'))).toBe(true);
      expect(sent.panes.atlas.typed).toEqual([]);
    }

    const toLead = await sends(w, 'lead@alpha');
    expect(toLead.code).toBe(0);
    expect((toLead.panes.atlas.typed[0] as Typed).pane).toBe('pane-atlas');
    expect(AGENT_ID.test(lead.id)).toBe(true);
    expect(AGENT_ID.test(builder.id)).toBe(true);
  });

  test('a bare name from outside a team is refused with the forms that need no team, never a team init', async () => {
    const { w } = teamWorld();
    const outside = join(w.base, 'nowhere');
    mkdirSync(outside, { recursive: true });
    const builderPane = scripted(['idle']);
    const host = sendHost(w, 'alpha', { 'builder-1': { pane: 'pane-builder', paneStatus: builderPane } });
    const io = testIo(outside, OWNER);

    const code = await runSend(['builder-1', BODY], io, host);

    expect(code).toBe(2);
    expect(io.err).toBe("team send: builder-1 needs a team: run it inside a team's folder, or write builder-1@<team> (team send --list shows the addresses)\n");
    expect(io.err).not.toContain('team init');
    expect(builderPane.typed).toEqual([]);
    expect(existsSync(join(w.root, '.agents', 'send-drops'))).toBe(false);
  });
});

describe('the whole command on a legacy seat named lead', () => {
  test('a file whose named seat holds leads loads, and its lead address reaches that seat', async () => {
    const w = world('alpha', 'alpha', 'lead', [seatBlock('coordinator', 'lead', 'claude-code', 'anthropic')]);
    const lead = seatOf(w, 'alpha', 'alpha', 'lead', 'coordinator', 'pane-alpha-lead', 'claude-code', { leads: true });
    const outside = join(w.base, 'nowhere');
    mkdirSync(outside, { recursive: true });
    const leadPane = scripted(['idle', 'working']);
    const host = sendHost(w, 'alpha', { lead: { pane: 'pane-alpha-lead', paneStatus: leadPane } });
    const io = testIo(outside, OWNER);

    const code = await runSend(['lead@alpha', BODY], io, host);

    expect(code).toBe(0);
    expect(leadPane.typed.length).toBe(1);
    const typed = leadPane.typed[0] as Typed;
    expect(typed.pane).toBe('pane-alpha-lead');
    const drop = dropOf(typed.text);
    expect(drop.text).toContain(BODY);
    expect(drop.path.startsWith(join(w.root, '.agents', 'send-drops', 'alpha', 'lead'))).toBe(true);
    expect(AGENT_ID.test(lead.id)).toBe(true);
  });

  test('a named seat another seat leads by keeps its bare name, and the lead address goes to the lead', async () => {
    const w = world('alpha', 'alpha', 'atlas', [seatBlock('coordinator', 'atlas', 'claude-code', 'anthropic'), seatBlock('builder', 'lead', 'claude-code', 'anthropic')]);
    const id = teamIdOf(w.root);
    const atlas = agent(w.home, { name: 'atlas', role: 'coordinator', cli: 'claude-code', team: id, seat: 'atlas', session: 'alpha', pane: 'pane-atlas' });
    const legacy = agent(w.home, { name: 'lead', role: 'builder', cli: 'claude-code', team: id, seat: 'lead', session: 'alpha', pane: 'pane-legacy' });
    team(w.home, id, 'alpha', 'alpha', w.root, [
      { agent: atlas.id, seat: 'atlas', role: 'coordinator', leads: true },
      { agent: legacy.id, seat: 'lead', role: 'builder', leads: false },
    ]);

    // The lead address always means the seat that holds `leads`.
    const outside = join(w.base, 'nowhere');
    mkdirSync(outside, { recursive: true });
    const atlasPane = scripted(['idle', 'working']);
    const legacyPane = scripted(['idle', 'working']);
    const host = () => sendHost(w, 'alpha', { atlas: { pane: 'pane-atlas', paneStatus: atlasPane }, lead: { pane: 'pane-legacy', paneStatus: legacyPane } });
    expect(await runSend(['lead@alpha', BODY], testIo(outside, OWNER), host())).toBe(0);
    expect(atlasPane.typed.length).toBe(1);
    expect((atlasPane.typed[0] as Typed).pane).toBe('pane-atlas');
    expect(legacyPane.typed).toEqual([]);

    // The bare name is the legacy seat's own, in its own team.
    expect(await runSend(['lead', BODY], testIo(w.root, OWNER), host())).toBe(0);
    expect(legacyPane.typed.length).toBe(1);
    expect((legacyPane.typed[0] as Typed).pane).toBe('pane-legacy');
    expect(atlasPane.typed.length).toBe(1);
  });
});

