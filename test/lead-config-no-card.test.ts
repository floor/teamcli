// Who may change a team's record without an owner card. A team's resolved lead, placed in its
// own session, and the same entity's main orchestrator, placed above the target, write the
// record through dev mode's owner lift (`team config set`, `team add`) and spend the owner's
// standing `always` rules; a plain seat, a sibling lead and another entity's orchestrator do
// not, and leave no audit line. The same subjects answer for the owner-action record helpers.
// Cards stay the default workflow's: a cardless seat, or label change asks none, while a
// general-grant change is carded, and `team check` names any other pending card under dev mode
// as policy drift. Every folder, caller, key, pane and client below is synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { actionAuditFolder, actionRequestsFolder } from '../src/client/team-create.ts';
import { createOwnerActionRequest, readOwnerActionRecord } from '../src/client/owner-action.ts';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import { ownerAdmitsRecord, ownerSeatRuleAdmits } from '../src/client/owner-action-step.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runClient } from '../src/commands/client.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo, recordRenames } from './helpers.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'synthetic-pane-1', session: 'acme' };
const WORKER = { kind: 'seat' as const, name: 'worker', pane: 'synthetic-pane-2', session: 'acme' };

const CONFIG_LINE = "only the owner edits the team's record, from a terminal outside herdr; this call is";
const ADD_LINE = 'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The one team of the lead scenes: a coordinator `lead`, a live `worker`, and a stopped
 *  `builder` a copy can be added from. */
function teamText(root: string): string {
  return `format: 1
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

type World = { base: string; root: string; home: string; file: string; team: TeamFile; store: FakeStore };

/** One repository, a home beside it, the record approved, both seats placed in the state, the
 *  team in the registry, the owner seat registered, and — unless `dev` is false — the machine
 *  development-mode record set to `local-fast`. */
function world(options: { dev?: boolean } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lead-no-card-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const file = join(root, '.agents', 'team.yaml');
  const text = teamText(root);
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
        lead: { stage: 'ready', pane: LEAD.pane },
        worker: { stage: 'ready', pane: WORKER.pane },
      },
      worktrees: {},
    };
  });
  upsertTeam(home, teamIdOf(root), { project: 'acme', entity: 'floor', session: 'acme', root, roster: [], by: 'test' });
  const store = seatOwner(home);
  if (options.dev !== false) {
    const written = writeDevelopmentMode({ home, mode: 'local-fast', now: NOW, caller: 'synthetic-fixture' });
    if (!written.ok) throw new Error(written.why);
  }
  return { base, root, home, file, team: loaded.team, store };
}

function config(at: World, caller: typeof LEAD | typeof WORKER, key: string, value: string, env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(at.root, caller);
  io.env = env;
  const sources: ConfigSources = { home: at.home, env, now: () => NOW };
  return runConfig(['set', key, value], io, sources).then((code) => ({ code, out: io.out, err: io.err }));
}

function logOf(at: World): string {
  const path = join(at.root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The owner-action cards waiting under this home: the `oa_…` request records, by file name. */
function cards(home: string): string[] {
  try {
    return readdirSync(actionRequestsFolder(home)).filter((name) => /^oa_[0-9a-f]{24}\.json$/.test(name)).sort();
  } catch {
    return [];
  }
}

function audits(home: string): string[] {
  try {
    return readdirSync(actionAuditFolder(home)).sort();
  } catch {
    return [];
  }
}

// --- the lead of its own team ----------------------------------------------------------------

describe('a team record changed without a card', () => {
  test('the placed lead changes its own team\'s seat under local-fast: warning, audit, no card', async () => {
    const at = world();
    const ran = await config(at, LEAD, 'seats.worker.model', 'Claude Sonnet');
    expect(ran.code).toBe(0);
    expect(ran.err).toBe(`warning: ${CONFIG_LINE} lead; dev mode continues (dev-mode on at machine level)\n`);
    expect(readFileSync(at.file, 'utf8')).toContain('    model: Claude Sonnet\n');
    expect(logOf(at)).toContain(`config [lead] warning: ${CONFIG_LINE} lead; dev mode continues (dev-mode on at machine level); admitted as orchestrator\n`);
    // The lift writes an audit line, never a card: the owner is not asked for a seat change.
    expect(cards(at.home)).toEqual([]);
  });

  test('the same write from a plain seat is refused in every mode, with no card and no audit line', async () => {
    const at = world();
    const before = readFileSync(at.file, 'utf8');
    for (const env of [{}, { TEAMCLI_DEV_MODE: '1' }] as Record<string, string>[]) {
      const ran = await config(at, WORKER, 'seats.worker.model', 'Claude Sonnet', env);
      expect(ran.code).toBe(1);
      expect(ran.err).toBe(`team config: ${CONFIG_LINE} worker\n`);
      expect(readFileSync(at.file, 'utf8')).toBe(before);
    }
    expect(logOf(at)).toBe('');
    expect(cards(at.home)).toEqual([]);
  });
});

// --- the main orchestrator above the target --------------------------------------------------

const ATLAS = { kind: 'seat' as const, name: 'atlas', pane: 'synthetic-pane-main', session: 'main' };
const MILL = { kind: 'seat' as const, name: 'mill', pane: 'synthetic-pane-target', session: 'material' };
const OUTS = { kind: 'seat' as const, name: 'outs', pane: 'synthetic-pane-outside', session: 'outside' };
const OTHER_LEAD = { kind: 'seat' as const, name: 'other-lead', pane: 'synthetic-pane-other', session: 'other' };

function teamWith(project: string, entity: string, session: string, lead: string, root: string): string {
  return `format: 1
project: ${project}
entity: ${entity}
session: ${session}
coordinator: ${lead}
operator: ${lead}
trust:
  - ~/.config/team/lobbies/${entity}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${lead}
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
}

type Families = { floorRoot: string; targetRoot: string; outsideRoot: string; otherRoot: string; home: string };

/** A main folder holding two project checkouts, a team outside it, and a home. The `material`
 *  team shares the main team's entity; `outside` sits inside the main folder but says another
 *  entity; `other` is the sibling no main folder holds. */
function families(): Families {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-main-orchestrator-')));
  dirs.push(base);
  const floorRoot = join(base, 'floor');
  const targetRoot = join(floorRoot, 'material');
  const outsideRoot = join(floorRoot, 'outside');
  const otherRoot = join(base, 'other');
  const home = join(base, 'home');
  for (const root of [floorRoot, targetRoot, outsideRoot, otherRoot]) mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(floorRoot, '.agents', 'team.yaml'), teamWith('floor', 'floor', 'main', 'atlas', floorRoot));
  writeFileSync(join(targetRoot, '.agents', 'team.yaml'), teamWith('material', 'floor', 'material', 'mill', targetRoot));
  writeFileSync(join(outsideRoot, '.agents', 'team.yaml'), teamWith('outside', 'outside', 'outside', 'outs', outsideRoot));
  writeFileSync(join(otherRoot, '.agents', 'team.yaml'), teamWith('other', 'outside', 'other', 'other-lead', otherRoot));
  for (const root of [targetRoot, outsideRoot, otherRoot]) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  }
  const place = (root: string, session: string, name: string, pane: string): void => {
    updateState(join(root, '.agents'), (state) => {
      state.sessions[session] = { seats: { [name]: { stage: 'ready', pane } }, worktrees: {} };
    });
  };
  place(floorRoot, 'main', 'atlas', ATLAS.pane);
  place(targetRoot, 'material', 'mill', MILL.pane);
  place(outsideRoot, 'outside', 'outs', OUTS.pane);
  place(otherRoot, 'other', 'other-lead', OTHER_LEAD.pane);
  for (const [root, project, entity, session, name] of [
    [floorRoot, 'floor', 'floor', 'main', 'atlas'],
    [targetRoot, 'material', 'floor', 'material', 'mill'],
    [outsideRoot, 'outside', 'outside', 'outside', 'outs'],
    [otherRoot, 'other', 'outside', 'other', 'other-lead'],
  ] as const) {
    upsertTeam(home, teamIdOf(root), { project, entity, session, root, roster: [], by: 'test' });
    void name;
  }
  return { floorRoot, targetRoot, outsideRoot, otherRoot, home };
}

async function configAt(root: string, home: string, caller: typeof ATLAS, key: string, value: string): Promise<{ code: number; err: string }> {
  const io = testIo(root, caller);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  const code = await runConfig(['set', key, value], io, { home, env: io.env, now: () => NOW });
  return { code, err: io.err };
}

describe('the main orchestrator and the teams around it', () => {
  test('it changes a team of its own entity under the main folder', async () => {
    const at = families();
    const ran = await configAt(at.targetRoot, at.home, ATLAS, 'seats.worker.model', 'Claude Sonnet');
    expect(ran.code).toBe(0);
    expect(ran.err).toBe(`warning: ${CONFIG_LINE} atlas; dev mode continues\n`);
    expect(readFileSync(join(at.targetRoot, '.agents', 'team.yaml'), 'utf8')).toContain('    model: Claude Sonnet\n');
    const log = readFileSync(join(at.targetRoot, '.agents', 'team.log'), 'utf8');
    expect(log).toContain(`config [atlas] warning: ${CONFIG_LINE} atlas; dev mode continues; admitted as orchestrator\n`);
  });

  test('a team of another entity under the same main folder is refused', async () => {
    const at = families();
    const file = join(at.outsideRoot, '.agents', 'team.yaml');
    const before = readFileSync(file, 'utf8');
    const ran = await configAt(at.outsideRoot, at.home, ATLAS, 'seats.worker.model', 'Claude Sonnet');
    expect(ran.code).toBe(1);
    expect(ran.err).toBe(`team config: ${CONFIG_LINE} atlas\n`);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(at.outsideRoot, '.agents', 'team.log'))).toBe(false);
  });

  test('a lead of another team is no admission either', async () => {
    const at = families();
    const file = join(at.targetRoot, '.agents', 'team.yaml');
    const before = readFileSync(file, 'utf8');
    const ran = await configAt(at.targetRoot, at.home, OTHER_LEAD, 'seats.worker.model', 'Claude Sonnet');
    expect(ran.code).toBe(1);
    expect(ran.err).toBe(`team config: ${CONFIG_LINE} other-lead\n`);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('the target team\'s own lead is admitted, so the proof is the team and not the folder', async () => {
    const at = families();
    const ran = await configAt(at.targetRoot, at.home, MILL, 'seats.worker.model', 'Claude Sonnet');
    expect(ran.code).toBe(0);
    expect(ran.err).toBe(`warning: ${CONFIG_LINE} mill; dev mode continues\n`);
  });
});

// --- the always rules ------------------------------------------------------------------------

describe('an owner-signer always rule is spent only by the same two subjects', () => {
  function rule(home: string, store: FakeStore, root: string, action: 'team-migrate' | 'team-revoke-approval'): string {
    const made = createOwnerActionRequest(home, {
      actions: [action],
      root,
      team: 'acme',
      head: null,
      args: {},
      requestedBy: 'synthetic-fixture',
    }, NOW);
    if (!made.ok) throw new Error(made.why);
    const approved = approveOwnerAction(home, made.record.request_id, 'always', store, NOW);
    if (!approved.ok) throw new Error(approved.why);
    return made.record.request_id;
  }

  test('under a team-migrate rule the lead is admitted and the seat is refused with no audit', () => {
    const at = world({ dev: false });
    rule(at.home, at.store, at.root, 'team-migrate');
    const sources = { home: at.home, now: () => NOW, ownerSeatStore: at.store };
    const seatIo = testIo(at.root, WORKER);
    expect(ownerSeatRuleAdmits('team-migrate', at.root, false, seatIo, sources)).toBe(false);
    expect(audits(at.home)).toEqual([]);
    const leadIo = testIo(at.root, LEAD);
    expect(ownerSeatRuleAdmits('team-migrate', at.root, false, leadIo, sources)).toBe(true);
    expect(audits(at.home)).toHaveLength(1);
  });

  test('ownerAdmitsRecord binds the same subject: the seat is refused, the lead admitted and audited', () => {
    const at = world({ dev: false });
    rule(at.home, at.store, at.root, 'team-revoke-approval');
    const sources = { home: at.home, now: () => NOW, ownerSeatStore: at.store };
    const seatIo = testIo(at.root, WORKER);
    expect(ownerAdmitsRecord('team-revoke-approval', seatIo, [at.root], sources)).toMatchObject({ ok: false, kind: 'caller' });
    expect(audits(at.home)).toEqual([]);
    const leadIo = testIo(at.root, LEAD);
    expect(ownerAdmitsRecord('team-revoke-approval', leadIo, [at.root], sources)).toMatchObject({ ok: true, via: 'rule' });
    expect(audits(at.home)).toHaveLength(1);
  });
});

// --- add -------------------------------------------------------------------------------------

function addWorld(): { launch: Launch; creates: string[] } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = { launch: {} as Launch, creates: [] as string[] };
  made.launch = {
    sessionState: () => 'absent' as const,
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`synthetic-pane-${String(n + 10)}`, { text: CLAUDE_IDLE, agent: false });
      made.creates.push(label);
      return { pane: `synthetic-pane-${String(n + 10)}`, workspace: `synthetic-workspace-${String(n)}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  recordRenames(made.launch);
  return made;
}

function doctor(home: string): DoctorSources {
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

function addSources(at: World, made: ReturnType<typeof addWorld>): AddSources {
  return {
    home: at.home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(at.home),
    now: () => NOW,
    launch: made.launch,
  };
}

describe('team add under the same lift', () => {
  test('the lead adds a seat with no card; the audit waits for the write', async () => {
    const at = world();
    const made = addWorld();
    const io = testIo(at.root, LEAD);
    io.env = {};
    expect(await runAdd(['apprentice', '--like', 'builder'], io, addSources(at, made)), io.out + io.err).toBe(0);
    expect(io.err).toBe(`team add: warning: ${ADD_LINE} lead; dev mode continues (dev-mode on at machine level)\n`);
    expect(readFileSync(at.file, 'utf8')).toContain('    name: apprentice\n');
    expect(made.creates).toEqual(['apprentice']);
    expect(logOf(at)).toContain(`add [lead] warning: ${ADD_LINE} lead; dev mode continues (dev-mode on at machine level); admitted as orchestrator\n`);
    expect(cards(at.home)).toEqual([]);
  });

  test('a plain seat is refused before any launch or write', async () => {
    const at = world();
    const made = addWorld();
    const before = readFileSync(at.file, 'utf8');
    const io = testIo(at.root, WORKER);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runAdd(['apprentice', '--like', 'builder'], io, addSources(at, made))).toBe(1);
    expect(io.err).toBe(`team add: ${ADD_LINE} worker\n`);
    expect(made.creates).toEqual([]);
    expect(readFileSync(at.file, 'utf8')).toBe(before);
    expect(logOf(at)).toBe('');
  });
});

// --- cards -----------------------------------------------------------------------------------

test('a general-grant change still asks for an owner card', () => {
  const at = world({ dev: false });
  const pub = join(at.root, 'client.pub');
  writeFileSync(pub, JSON.stringify({ public_key: 'a'.repeat(64) }));
  const io = testIo(at.root, LEAD);
  io.env = {};
  const code = runClient(['general-grant', '--to', 'synthetic-client', '--public-key', pub, '--request'], io, at.home);
  expect(code).toBe(0);
  const held = cards(at.home);
  expect(held).toHaveLength(1);
  const record = readOwnerActionRecord(at.home, held[0]!.slice(0, -'.json'.length));
  if (typeof record === 'string') throw new Error(record);
  expect(record.params.actions).toEqual(['team-general-grant']);
});

// --- team check ------------------------------------------------------------------------------

function liveFor(team: TeamFile): Live {
  const lead = team.seats.find((seat) => seat.name === 'lead');
  if (lead === undefined) throw new Error('the world names no lead');
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: LEAD.pane, workspace: 'synthetic-workspace', status: 'idle', cwd: null, displayAgent: displayAgent(lead) }],
    workspaces: [{ id: 'synthetic-workspace', label: workspaceLabel(lead) }],
    screens: { [LEAD.pane]: CLAUDE_IDLE },
  };
}

function check(at: World, env: Record<string, string>): { code: number; out: string } {
  const io = testIo(at.root, { kind: 'owner' });
  io.env = env;
  const sources: CheckSources = {
    live: () => liveFor(at.team),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
  };
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, sources);
  return { code, out: `${io.out}${io.err}` };
}

function pending(home: string, root: string, actions: 'team-config' | 'team-general-grant'): void {
  const made = createOwnerActionRequest(home, { actions: [actions], root, team: 'acme', head: null, args: {}, requestedBy: 'synthetic-fixture' }, NOW);
  if (!made.ok) throw new Error(made.why);
}

test('check names a pending card that is not a general grant or a security policy as policy drift', () => {
  const at = world();
  expect(check(at, {}).out).not.toContain('policy drift');
  pending(at.home, at.root, 'team-config');
  const on = check(at, { TEAMCLI_DEV_MODE: '1' });
  expect(on.out).toContain('policy drift');
  expect(on.out).toContain('team-config');
});

test('check leaves a general-grant card alone, and reads no card when dev mode is off', () => {
  const grant = world();
  pending(grant.home, grant.root, 'team-general-grant');
  expect(check(grant, { TEAMCLI_DEV_MODE: '1' }).out).not.toContain('policy drift');

  const off = world({ dev: false });
  pending(off.home, off.root, 'team-config');
  const ran = check(off, {});
  expect(ran.out).not.toContain('policy drift');
  // The card is still there and waiting: the check read it and wrote nothing.
  expect(cards(off.home)).toHaveLength(1);
});
