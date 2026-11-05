import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runFeed } from '../src/commands/feed.ts';
import { listUnacked, plantMessage, runMessages } from '../src/commands/messages.ts';
import { runRename } from '../src/commands/rename.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { writeGrant } from '../src/permissions/grants.ts';
import { resolveCaller } from '../src/permissions/who.ts';
import { findAgent, getAgent } from '../src/registry/agents.ts';
import * as projects from '../src/registry/projects.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { getTeam, noteTeam, readTeams, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { admitSend, sendGrantFor } from '../src/send/admit.ts';
import { readSendGrants, writeSendGrant } from '../src/send/grants.ts';
import { appendHistory } from '../src/send/history.ts';
import { resolveTarget } from '../src/send/resolve.ts';
import { beginSession, latestSessionOf, readStoreSessions } from '../src/sessions/registry.ts';
import { emptySession, readState, updateState } from '../src/state.ts';import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';
import { intoRegistry, realRegistryTouched, storedTeam, underRegistry } from './helpers/registry-team.ts';

const NOW = new Date('2026-11-05T19:00:00.000Z');
const owner: Caller = { kind: 'owner' };

function makeTeamYaml(opts: {
  project: string;
  entity?: string;
  session?: string;
  inProject?: string;
  projectLead?: boolean;
}): string {
  const lines = [
    'format: 1',
    `project: ${opts.project}`,
    ...(opts.entity ? [`entity: ${opts.entity}`] : []),
    ...(opts.inProject ? [`in_project: ${opts.inProject}`] : []),
    ...(opts.projectLead ? ['project_lead: true'] : []),
    ...(opts.session ? [`session: ${opts.session}`] : []),
    'coordinator: lead',
    'operator: operator-1',
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: coordinator',
    '    name: lead',
    '    nickname: nick-lead',
    '    label: lead',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '    leads: true',
    '',
    '  - role: coordinator',
    '    name: operator-1',
    '    label: operator-1',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '',
    '  - role: implementer',
    '    name: builder-1',
    '    label: builder-1',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    'delivery_order: [drop]',
    '',
  ];
  return lines.join('\n');
}

type TeamFixture = {
  base: string;
  home: string;
  root: string;
  file: string;
  dir: string;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function createTeamInHome(
  base: string,
  home: string,
  folderName: string,
  yamlText: string,
): TeamFixture {
  const root = join(base, folderName);
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const realRoot = realpathSync(root);
  const realDir = join(realRoot, '.agents');
  const file = join(realDir, 'team.yaml');
  writeFileSync(file, yamlText);

  const loaded = loadTeamFile(realRoot, { home });
  if (!loaded.ok) throw new Error(`fixture team file invalid: ${loaded.errors.map((e) => e.message).join('; ')}`);
  writeApproval(
    storePath(loaded.team.project, realRoot, home),
    {
      approval: approvalOf(loaded.team, realRoot, NOW),
      file: yamlText,
    },
    [],
    home,
  );

  const session = loaded.team.session;
  updateState(realDir, (current) => {
    current.sessions[session] = {
      ...emptySession(),
      seats: {
        lead: { id: 'seat_000000000001', stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' },
        'operator-1': { id: 'seat_000000000002', stage: 'ready', pane: 'pane-op', workspace: 'ws-op' },
        'builder-1': { id: 'seat_000000000004', stage: 'ready', pane: 'pane-b1', workspace: 'ws-b1' },
      },
    };
  });

  for (const seat of loaded.team.seats) {
    const seatState = readState(realDir).sessions[session]?.seats[seat.name];
    registerLaunch(
      { home, team: loaded.team, root: realRoot, by: 'owner', owner: true },
      seat,
      seatState?.pane ?? 'pane-spare',
      seatState?.id,
    );
  }

  const lobbyDir = join(home, '.config', 'team', 'lobbies', loaded.team.project);
  mkdirSync(lobbyDir, { recursive: true });
  upsertTeam(home, teamIdOf(realRoot), { session, lobby: lobbyDir, lobbies: { [session]: lobbyDir } });

  return { base, home, root: realRoot, file, dir: realDir };
}

describe('team rename --team', () => {
  test('1. two teams of one name: renames team & project membership, keeps teamId key, and resolves @team-b and @project-x unambiguously', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-dup-')));
    dirs.push(base);
    const home = join(base, 'home');

    // Team A: project-x (root: root-a, session: project-x)
    const productFx = createTeamInHome(
      base,
      home,
      'root-a',
      makeTeamYaml({ project: 'project-x', entity: 'floor', session: 'project-x', inProject: 'project-x', projectLead: true }),
    );
    // Team B: also named `project: project-x` at root `root-b` with session `team-b`
    const marketingFx = createTeamInHome(
      base,
      home,
      'root-b',
      makeTeamYaml({ project: 'project-x', entity: 'floor', session: 'team-b' }),
    );

    const productId = teamIdOf(productFx.root);
    const marketingId = teamIdOf(marketingFx.root);
    expect(productId).not.toBe(marketingId);

    // Before rename: `lead@project-x` is ambiguous across the two `project-x` teams
    const beforeTarget = resolveTarget(home, 'lead@project-x', testIo(productFx.root, owner), () => [
      { name: 'lead', pane: 'pane-lead', cli: 'claude' },
    ]);
    expect('error' in beforeTarget).toBe(true);
    if ('error' in beforeTarget) {
      expect(beforeTarget.kind).toBe('ambiguous');
      expect(beforeTarget.error).toContain('"project-x" names 2 teams');
    }

    // Rename team B to `team-b` and join project `project-x`
    const renameIo = testIo(marketingFx.root, owner);
    const code = await runRename(
      ['--team', 'team-b', '--in-project', 'project-x'],
      renameIo,
      { home, now: () => NOW },
    );
    expect(code, `${renameIo.err}${renameIo.out}`).toBe(0);
    expect(renameIo.out).toContain('renamed team project-x -> team-b');

    // Key invariance: teamId is unchanged
    expect(teamIdOf(marketingFx.root)).toBe(marketingId);
    const marketingRecord = getTeam(home, marketingId);
    expect(marketingRecord).not.toBeNull();
    expect(marketingRecord?.project).toBe('team-b');
    expect(marketingRecord?.projectId).toBe('project-x');
    expect(marketingRecord?.projects).toContain('project-x');

    // Project registry holds both teams under `project-x`
    const matProject = projects.get(home, 'project-x');
    expect(matProject?.teams).toContain(productId);
    expect(matProject?.teams).toContain(marketingId);

    // Approval standing remains verified with zero differences
    const loadedAfter = loadTeamFile(marketingFx.root, { home });
    expect(loadedAfter.ok).toBe(true);
    if (loadedAfter.ok) {
      expect(loadedAfter.team.project).toBe('team-b');
      expect(loadedAfter.team.inProject).toBe('project-x');
      expect(approvalStanding(marketingFx.root, home).kind).toBe('verified');
      expect(approvalDifferences(loadedAfter.team, marketingFx.root, home)).toEqual([]);
    }

    // Now `lead@team-b` resolves to team B, and `lead@project-x` resolves unambiguously to team A!
    const toMarketing = resolveTarget(home, 'lead@team-b', testIo(productFx.root, owner), () => [
      { name: 'lead', pane: 'pane-lead', cli: 'claude' },
    ]);
    expect('error' in toMarketing).toBe(false);
    if (!('error' in toMarketing)) {
      expect(toMarketing.team.id).toBe(marketingId);
      expect(toMarketing.team.project).toBe('team-b');
    }

    const toProduct = resolveTarget(home, 'lead@project-x', testIo(marketingFx.root, owner), () => [
      { name: 'lead', pane: 'pane-lead', cli: 'claude' },
    ]);
    expect('error' in toProduct).toBe(false);
    if (!('error' in toProduct)) {
      expect(toProduct.team.id).toBe(productId);
      expect(toProduct.team.project).toBe('project-x');
    }
  });

  test('2. new name delivers; old name resolves with a deprecation note during grace period, or is refused by policy', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-grace-')));
    dirs.push(base);
    const home = join(base, 'home');

    const fx = createTeamInHome(
      base,
      home,
      'repo-b',
      makeTeamYaml({ project: 'team-b-old', entity: 'floor', session: 'team-b-old' }),
    );

    const renameIo = testIo(fx.root, owner);
    expect(
      await runRename(['--team', 'team-b', '--session', 'team-b'], renameIo, {
        home,
        now: () => NOW,
      }),
      `${renameIo.err}${renameIo.out}`,
    ).toBe(0);

    // 1) New name resolves cleanly with no deprecation note and delivers via runSend
    const newIo = testIo(fx.root, owner);
    const resolvedNew = resolveTarget(home, 'builder-1@team-b', newIo, () => [
      { name: 'builder-1', pane: 'pane-b1', cli: 'claude' },
    ]);
    expect('error' in resolvedNew).toBe(false);
    if (!('error' in resolvedNew)) {
      expect(resolvedNew.team.project).toBe('team-b');
      expect(resolvedNew.notice).toBeUndefined();
    }
    expect(newIo.err).toBe('');

    const sendHost: SendHost = {
      home,
      now: () => NOW,
      socketsDir: join(base, 'sockets'),
      agents: () => [
        { name: 'lead', pane: 'pane-lead', cli: 'claude' },
        { name: 'builder-1', pane: 'pane-b1', cli: 'claude' },
      ],
      processInfo: () => null,
      deliver: async () => ({ ok: false, reason: 'no-socket' }),
      native: {
        typeText: () => true,
        pressEnter: () => true,
        status: () => 'idle',
        wait: async () => {},
      },
    };
    const sendNewIo = testIo(fx.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'team-b' });
    expect(await runSend(['builder-1@team-b', 'hello new address'], sendNewIo, sendHost), `${sendNewIo.err}${sendNewIo.out}`).toBe(0);

    // 2) Old name resolves during the grace period with a deprecation warning pointing to `<seat>@team-b`
    const oldIo = testIo(fx.root, owner);
    const resolvedOld = resolveTarget(home, 'builder-1@team-b-old', oldIo, () => [
      { name: 'builder-1', pane: 'pane-b1', cli: 'claude' },
    ]);
    expect('error' in resolvedOld).toBe(false);
    if (!('error' in resolvedOld)) {
      expect(resolvedOld.team.project).toBe('team-b');
      expect(resolvedOld.notice).toContain('deprecated: "builder-1@team-b-old"');
      expect(resolvedOld.notice).toContain('use "builder-1@team-b"');
    }
    expect(oldIo.err).toContain('deprecated: "builder-1@team-b-old" — use "builder-1@team-b"');

    // 3) When policy refuses old-name aliases (or grace window is disabled/expired), old name is refused naming the new address
    const strictIo = testIo(fx.root, owner);
    strictIo.env.TEAM_RENAME_GRACE = 'off';
    const refusedOld = resolveTarget(home, 'builder-1@team-b-old', strictIo, () => [
      { name: 'builder-1', pane: 'pane-b1', cli: 'claude' },
    ]);
    expect('error' in refusedOld).toBe(true);
    if ('error' in refusedOld) {
      expect(refusedOld.error).toContain('renamed to "team-b"');
      expect(refusedOld.error).toContain('builder-1@team-b');
    }
  });

  test('3. nothing pending is lost: state store, lobbies, sessions, drops, mailboxes, history, rules and grants carry over', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-carry-')));
    dirs.push(base);
    const home = join(base, 'home');

    const fx = createTeamInHome(
      base,
      home,
      'carry-repo',
      makeTeamYaml({ project: 'old-team', entity: 'floor', session: 'old-team' }),
    );
    const teamId = teamIdOf(fx.root);

    // 1) Pending send-drop under .agents/send-drops/old-team/builder-1/drop-001
    const dropDir = join(fx.root, '.agents', 'send-drops', 'old-team', 'builder-1');
    mkdirSync(dropDir, { recursive: true });
    writeFileSync(join(dropDir, 'drop-001'), 'From lead: pending work before team rename\n');

    // 2) Signed mailbox message
    plantMessage(home, fx.root, 'builder-1', 'm-team-001', {
      kind: 'message',
      id: 'm-team-001',
      to: 'builder-1',
      root: fx.root,
      session: 'old-team',
      at: NOW.toISOString(),
      body: 'mailbox survives team rename',
      from: 'lead',
    });

    // 3) Message history in storePath('old-team', fx.root, home)/messages.jsonl
    appendHistory('old-team', fx.root, home, {
      ts: '2026-11-05T18:50:00.000Z',
      from: 'lead',
      to: 'builder-1',
      body: 'history line before team rename',
      id: 'hist-1',
      outcome: 'delivered',
    });

    // 4) Session registry entry in storePath('old-team', fx.root, home)/sessions.jsonl
    const loadedOld = loadTeamFile(fx.root, { home });
    if (!loadedOld.ok) throw new Error('expected valid old team');
    beginSession({
      home,
      root: fx.root,
      team: loadedOld.team,
      session: 'old-team',
      seat: loadedOld.team.seats.find((s) => s.name === 'builder-1')!,
      pane: 'pane-b1',
      cli_session: 'sess-uuid-1234',
      now: NOW,
    });

    // 5) Per-seat rules file in old state folder
    const oldStore = storePath('old-team', fx.root, home);
    mkdirSync(join(oldStore, 'rules'), { recursive: true });
    writeFileSync(join(oldStore, 'rules', 'builder-1.md'), '# Builder rules\n');

    // 6) Team-scoped capability grant and send-grant naming @old-team
    expect(
      writeGrant(
        home,
        {
          name: 'team-merge',
          kind: 'team',
          grantee: teamId,
          capabilities: ['merge'],
          roots: [fx.root],
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    expect(
      writeSendGrant(
        home,
        {
          name: 'cross-to-old-team',
          from: 'lead@other-team',
          to: 'lead@old-team',
          expires: '2026-12-31T00:00:00.000Z',
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    // Run team rename --team new-team --session new-team
    const io = testIo(fx.root, owner);
    const code = await runRename(['--team', 'new-team', '--session', 'new-team'], io, {
      home,
      now: () => NOW,
    });
    expect(code, `${io.err}${io.out}`).toBe(0);

    // State folder moved from old-team-<hash> to new-team-<hash>
    const newStore = storePath('new-team', fx.root, home);
    expect(existsSync(oldStore)).toBe(false);
    expect(existsSync(newStore)).toBe(true);
    expect(existsSync(join(newStore, 'rules', 'builder-1.md'))).toBe(true);

    // Lobby moved and recorded on TeamRecord
    const teamRec = getTeam(home, teamId);
    expect(teamRec?.project).toBe('new-team');
    expect(teamRec?.session).toBe('new-team');
    expect(teamRec?.lobby).toBe(join(home, '.config', 'team', 'lobbies', 'new-team'));
    expect(existsSync(join(home, '.config', 'team', 'lobbies', 'new-team'))).toBe(true);

    // Herdr session state and agent reach.session updated
    expect(readState(fx.dir).sessions['new-team']?.seats['builder-1']?.pane).toBe('pane-b1');
    expect(findAgent(home, { team: teamId, seat: 'builder-1' })?.reach.session).toBe('new-team');

    // Sessions registry preserved and updated under new-team
    const loadedNew = loadTeamFile(fx.root, { home });
    expect(loadedNew.ok).toBe(true);
    if (loadedNew.ok) {
      expect(latestSessionOf(home, loadedNew.team, fx.root, 'new-team', 'builder-1')?.cli_session).toBe('sess-uuid-1234');
    }

    // Pending send-drops carried to new session folder
    expect(
      readFileSync(join(fx.root, '.agents', 'send-drops', 'new-team', 'builder-1', 'drop-001'), 'utf8'),
    ).toBe('From lead: pending work before team rename\n');

    // Mailbox message still unacked and readable via runMessages
    expect(listUnacked(fx.root, 'new-team', home).some((d) => d.id === 'm-team-001')).toBe(true);
    const msgIo = testIo(fx.root, owner);
    expect(await runMessages([], msgIo, { home, now: () => NOW })).toBe(0);
    expect(msgIo.out).toContain('mailbox survives team rename');

    // History preserved and readable via team feed
    const feedIo = testIo(fx.root, owner);
    expect(await runFeed(['--seat', 'builder-1', '--json'], feedIo, { home })).toBe(0);
    const feedParsed = JSON.parse(feedIo.out) as { events: Array<{ body: string }> };
    expect(feedParsed.events.some((e) => e.body === 'history line before team rename')).toBe(true);

    // Team-scoped send grant re-signed to @new-team by owner, and capability grant still valid
    const sendGrants = readSendGrants(home);
    expect(sendGrants.some((g) => g.to === 'lead@new-team')).toBe(true);
  });

  test('4. root move is never recomputed silently: refused without --rekey, and explicitly re-keyed with --rekey by the owner', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-rootmove-')));
    dirs.push(base);
    const home = join(base, 'home');

    const fx = createTeamInHome(
      base,
      home,
      'before-move',
      makeTeamYaml({ project: 'movable', entity: 'floor', session: 'movable', inProject: 'project-x' }),
    );
    const oldRoot = fx.root;
    const oldId = teamIdOf(oldRoot);
    projects.upsertProject(home, 'project-x', { name: 'project-x', entity: 'floor', teams: [oldId], by: 'owner', at: NOW.toISOString() });
    upsertTeam(home, oldId, {
      project: 'movable',
      entity: 'floor',
      projectId: 'project-x',
      projects: ['project-x'],
      root: oldRoot,
      session: 'movable',
      by: 'owner',
      at: NOW.toISOString(),
    });
    const builderAgentId = findAgent(home, { team: oldId, seat: 'builder-1' })!.id;
    expect(
      writeGrant(
        home,
        {
          name: 'movable-merge',
          kind: 'team',
          grantee: oldId,
          capabilities: ['merge'],
          roots: [oldRoot],
        },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(
      writeGrant(
        home,
        {
          name: 'builder-merge',
          kind: 'seat',
          grantee: builderAgentId,
          capabilities: ['merge'],
          roots: [oldRoot],
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    // Move the repository folder on disk to a new path
    const newRoot = join(base, 'after-move');
    renameSync(oldRoot, newRoot);
    const newId = teamIdOf(newRoot);
    expect(newId).not.toBe(oldId);

    // Without --rekey: refuses the root move and states why, naming oldId and newId
    const refuseIo = testIo(newRoot, owner);
    const refuseCode = await runRename(
      ['--team', 'moved-team', '--from', 'movable'],
      refuseIo,
      { home, now: () => NOW },
    );
    expect(refuseCode).toBe(1);
    expect(refuseIo.err).toContain(oldId);
    expect(refuseIo.err).toContain(newId);
    expect(refuseIo.err).toContain('--rekey');
    // Old record was not silently recomputed or lost
    expect(getTeam(home, oldId)).not.toBeNull();
    expect(getTeam(home, newId)).toBeNull();

    // With --rekey by owner: explicitly re-keys record, state folder, project membership, agents, and team grants
    const rekeyIo = testIo(newRoot, owner);
    const rekeyCode = await runRename(
      ['--team', 'moved-team', '--from', 'movable', '--rekey'],
      rekeyIo,
      { home, now: () => NOW },
    );
    expect(rekeyCode, `${rekeyIo.err}${rekeyIo.out}`).toBe(0);
    expect(getTeam(home, oldId)).toBeNull();
    const newTeamRec = getTeam(home, newId);
    expect(newTeamRec).not.toBeNull();
    expect(newTeamRec?.project).toBe('moved-team');
    expect(newTeamRec?.root).toBe(newRoot);
    expect(projects.get(home, 'project-x')?.teams).toContain(newId);
    expect(projects.get(home, 'project-x')?.teams).not.toContain(oldId);
    expect(findAgent(home, { team: newId, seat: 'builder-1' })).not.toBeNull();
    expect(approvalStanding(newRoot, home).kind).toBe('verified');

    // Re-issued team and seat grants now admit builder-1 under newId and newRoot
    const loadedAfter = loadTeamFile(newRoot, { home });
    expect(loadedAfter.ok).toBe(true);
    if (loadedAfter.ok) {
      const decision = resolveCaller(
        { kind: 'seat', name: 'builder-1', pane: 'pane-b1', session: loadedAfter.team.session },
        { id: newId, orchestrator: loadedAfter.team.orchestrator, operator: loadedAfter.team.operator, seats: loadedAfter.team.seats },
        newRoot,
        home,
        'merge',
        { session: loadedAfter.team.session, recordedPane: 'pane-b1', stage: 'ready' },
        NOW,
      );
      expect(decision).toMatchObject({ effect: 'allow', rule: 'seat-grant' });
    }
  });

  test('5. admission (owner or lead in dev mode) and --dry-run parity with real-run refusals', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-dryrun-')));
    dirs.push(base);
    const home = join(base, 'home');

    const fx1 = createTeamInHome(
      base,
      home,
      'team-one',
      makeTeamYaml({ project: 'alpha', entity: 'floor', session: 'alpha' }),
    );
    const fx2 = createTeamInHome(
      base,
      home,
      'team-two',
      makeTeamYaml({ project: 'beta', entity: 'floor', session: 'beta' }),
    );

    // 1) Non-lead seat is refused on both --dry-run and real run
    const builderCaller: Caller = { kind: 'seat', name: 'builder-1', pane: 'pane-b1', session: 'alpha' };
    const dryRefuseCaller = testIo(fx1.root, builderCaller);
    expect(await runRename(['--team', 'gamma', '--dry-run'], dryRefuseCaller, { home, now: () => NOW })).toBe(1);
    const realRefuseCaller = testIo(fx1.root, builderCaller);
    expect(await runRename(['--team', 'gamma'], realRefuseCaller, { home, now: () => NOW })).toBe(1);
    expect(dryRefuseCaller.err).toBe(realRefuseCaller.err);

    // 2) Lead seat without dev mode is refused for team rename, and admitted when dev mode is active
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'alpha' };
    const leadNoDev = testIo(fx1.root, leadCaller);
    expect(await runRename(['--team', 'gamma', '--dry-run'], leadNoDev, { home, now: () => NOW })).toBe(1);
    const leadNoDevReal = testIo(fx1.root, leadCaller);
    expect(await runRename(['--team', 'gamma'], leadNoDevReal, { home, now: () => NOW })).toBe(1);
    expect(leadNoDev.err).toBe(leadNoDevReal.err);

    // 3) Colliding with an existing team name in the same entity ('beta') is refused identically on --dry-run and real run
    const dryCollide = testIo(fx1.root, owner);
    expect(await runRename(['--team', 'beta', '--dry-run'], dryCollide, { home, now: () => NOW })).toBe(1);
    const realCollide = testIo(fx1.root, owner);
    expect(await runRename(['--team', 'beta'], realCollide, { home, now: () => NOW })).toBe(1);
    expect(dryCollide.err).toBe(realCollide.err);

    // 4) Valid --dry-run exits 0, prints planned rename, and writes nothing
    const beforeYaml = readFileSync(fx1.file, 'utf8');
    const dryOk = testIo(fx1.root, owner);
    expect(await runRename(['--team', 'gamma', '--in-project', 'project-x', '--dry-run'], dryOk, { home, now: () => NOW })).toBe(0);
    expect(dryOk.out).toContain('alpha -> gamma (dry run)');
    expect(readFileSync(fx1.file, 'utf8')).toBe(beforeYaml);
    expect(getTeam(home, teamIdOf(fx1.root))?.project).toBe('alpha');

    // 5) Lead in dev mode can execute the rename
    const leadDev = testIo(fx1.root, leadCaller);
    leadDev.env.TEAMCLI_DEV_MODE = '1';
    expect(await runRename(['--team', 'gamma', '--in-project', 'project-x'], leadDev, { home, now: () => NOW }), `${leadDev.err}${leadDev.out}`).toBe(0);
    expect(getTeam(home, teamIdOf(fx1.root))?.project).toBe('gamma');
    expect(getTeam(home, teamIdOf(fx1.root))?.projectId).toBe('project-x');
  });

  test('6. works under registry source (team-config/<id>.json) without touching real ~/.config/team', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-reg-')));
    dirs.push(base);
    const home = join(base, 'home');
    const fx = createTeamInHome(
      base,
      home,
      'reg-repo',
      makeTeamYaml({ project: 'reg-old', entity: 'floor', session: 'reg-old' }),
    );
    intoRegistry(fx.root, home);

    const io = testIo(fx.root, owner);
    const code = await underRegistry(() =>
      runRename(['--team', 'reg-new', '--in-project', 'teamcli'], io, { home, now: () => NOW }),
    );
    expect(code, `${io.err}${io.out}`).toBe(0);
    const stored = storedTeam(fx.root, home);
    expect(stored?.edited_by).toBe('rename');
    expect(stored?.text).toContain('project: reg-new');
    expect(stored?.text).toContain('in_project: teamcli');
    expect(realRegistryTouched()).toBe(false);
  });

  test('7. entity create-grant does not admit team rename (non-lead or lead with dev mode off, or detached caller)', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-creategrant-')));
    dirs.push(base);
    const home = join(base, 'home');

    const fx = createTeamInHome(
      base,
      home,
      'cg-repo',
      makeTeamYaml({ project: 'cg-old', entity: 'floor', session: 'cg-old' }),
    );
    const teamId = teamIdOf(fx.root);
    const builderAgent = findAgent(home, { team: teamId, seat: 'builder-1' })!;
    const leadAgent = findAgent(home, { team: teamId, seat: 'lead' })!;

    const grantsFolder = join(home, '.config', 'team', 'grants');
    mkdirSync(grantsFolder, { recursive: true });
    writeFileSync(
      join(grantsFolder, 'cg-builder.json'),
      JSON.stringify({
        agent: builderAgent.id,
        paths: [base],
        expires: '2026-12-31T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(grantsFolder, 'cg-lead.json'),
      JSON.stringify({
        agent: leadAgent.id,
        paths: [base],
        expires: '2026-12-31T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(grantsFolder, 'cg-team.json'),
      JSON.stringify({
        team: teamId,
        paths: [base],
        expires: '2026-12-31T00:00:00.000Z',
      }),
    );

    // Non-lead with entity create-grant is refused (with or without dev mode)
    const builderCaller: Caller = { kind: 'seat', name: 'builder-1', pane: 'pane-b1', session: 'cg-old' };
    const builderIo = testIo(fx.root, builderCaller);
    expect(await runRename(['--team', 'cg-new'], builderIo, { home, now: () => NOW })).toBe(1);
    expect(builderIo.err).toContain('only the owner or `leads` (in development mode) renames a team');

    const builderDevIo = testIo(fx.root, builderCaller);
    builderDevIo.env.TEAMCLI_DEV_MODE = '1';
    expect(await runRename(['--team', 'cg-new'], builderDevIo, { home, now: () => NOW })).toBe(1);

    // Lead with entity create-grant but dev mode OFF is refused
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'cg-old' };
    const leadNoDevIo = testIo(fx.root, leadCaller);
    expect(await runRename(['--team', 'cg-new'], leadNoDevIo, { home, now: () => NOW })).toBe(1);
    expect(leadNoDevIo.err).toContain('only the owner (or `leads` in development mode) renames a team');

    // Detached caller with entity create-grant is refused
    const detachedIo = testIo(fx.root, { kind: 'owner-no-tty' });
    expect(await runRename(['--team', 'cg-new'], detachedIo, { home, now: () => NOW })).toBe(1);
    expect(getTeam(home, teamId)?.project).toBe('cg-old');
  });

  test('8. sendGrantFor / teamSpelled honours previousNames until & TEAM_RENAME_GRACE and never aliases a name another team holds', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-grantgrace-')));
    dirs.push(base);
    const home = join(base, 'home');

    const senderFx = createTeamInHome(
      base,
      home,
      'sender-repo',
      makeTeamYaml({ project: 'sender-team', entity: 'other-entity', session: 'sender-team' }),
    );
    const marketingFx = createTeamInHome(
      base,
      home,
      'root-b',
      makeTeamYaml({ project: 'project-x', entity: 'floor', session: 'team-b' }),
    );
    const senderId = teamIdOf(senderFx.root);
    const marketingId = teamIdOf(marketingFx.root);

    // Standing send grant to builder-1@project-x
    expect(
      writeSendGrant(
        home,
        {
          name: 'to-project-x-builder',
          from: 'builder-1@sender-team',
          to: 'builder-1@project-x',
          expires: '2027-06-01T00:00:00.000Z',
        },
        { now: NOW },
      ).ok,
    ).toBe(true);

    // Lead in dev mode renames team B from `project-x` -> `team-b` (does not re-sign grant)
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'team-b' };
    const leadDevIo = testIo(marketingFx.root, leadCaller);
    leadDevIo.env.TEAMCLI_DEV_MODE = '1';
    expect(
      await runRename(['--team', 'team-b'], leadDevIo, { home, now: () => NOW }),
      `${leadDevIo.err}${leadDevIo.out}`,
    ).toBe(0);

    const grants = readSendGrants(home);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.to).toBe('builder-1@project-x');

    const callerSide = { seat: 'builder-1', team: senderId };
    const marketingTarget = { seat: 'builder-1', team: marketingId };

    // 1) When no other team holds `project-x`, within the 30-day grace window, the grant admits marketingTarget
    const teamsNoConflict = readTeams(home);
    expect(sendGrantFor(callerSide, marketingTarget, grants, teamsNoConflict, NOW)).toEqual({
      name: 'to-project-x-builder',
    });

    // 2) After the 30-day `until` grace date expires, `teamSpelled` no longer admits via previousNames
    const afterGrace = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(sendGrantFor(callerSide, marketingTarget, grants, teamsNoConflict, afterGrace)).toBeUndefined();

    // 3) When TEAM_RENAME_GRACE=off, `teamSpelled` refuses previousNames alias even before `until`
    const prevEnv = process.env.TEAM_RENAME_GRACE;
    process.env.TEAM_RENAME_GRACE = 'off';
    try {
      expect(sendGrantFor(callerSide, marketingTarget, grants, teamsNoConflict, NOW)).toBeUndefined();
    } finally {
      if (prevEnv === undefined) delete process.env.TEAM_RENAME_GRACE;
      else process.env.TEAM_RENAME_GRACE = prevEnv;
    }

    // 4) When another team holds `project: project-x` (two teams of one name), `builder-1@project-x`
    //    never aliases the renamed team B — it only matches the team that holds `project-x`.
    const productFx = createTeamInHome(
      base,
      home,
      'root-a',
      makeTeamYaml({ project: 'project-x', entity: 'floor', session: 'project-x' }),
    );
    const productId = teamIdOf(productFx.root);
    const productTarget = { seat: 'builder-1', team: productId };
    const teamsWithProduct = readTeams(home);

    expect(sendGrantFor(callerSide, marketingTarget, grants, teamsWithProduct, NOW)).toBeUndefined();
    expect(sendGrantFor(callerSide, productTarget, grants, teamsWithProduct, NOW)).toEqual({
      name: 'to-project-x-builder',
    });
  });
});
