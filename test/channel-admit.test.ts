// Residual channel roster and current-holder controls over the integrated admission module:
// - Scoped registry readability: unrelated non-record files in `agents/` and `roster: null` on
//   disjoint teams do not block valid local, cross-team or owner/launch admission, while
//   corrupt records for participating endpoints or possible same-seat competitors fail closed.
// - Explicit currentness: tied `updated_at` timestamps between non-retired claimants of the same
//   `(team, seat)` fail closed (`ambiguous`), unavailable competitor metadata fails closed
//   (`unreadable`), and file `mtime` rewrites cannot manufacture or restore authority.
// - Same-team sender and projected-roster uniqueness: an agent bound to two seats on the same
//   team's roster is refused, and projected rosters exclude superseded or tied holders.
// - Before-exposure stream control: refused records emit no channel notification, write no push
//   marker and write no consumer read receipt, while a valid push writes only `.channel-push.json`
//   and leaves `.read.json` absent until consumer acknowledgment.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { TeamFile } from '../src/file/types.ts';
import { admitChannelDelivery } from '../src/mcp/channel-admit.ts';
import { channelPushPath } from '../src/mcp/channel.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { testIo } from './helpers.ts';

const CHANNEL_FLAG = '--dangerously-load-development-channels server:team-inbox';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type FixtureTeam = {
  root: string;
  teamId: string;
  session: string;
  file: string;
  team: TeamFile;
  lead: Agent;
  worker: Agent;
};

function createHome(): { base: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'channel-roster-residual-')));
  roots.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  return { base, home };
}

function createTeam(
  base: string,
  home: string,
  project: string,
  entity: string | null = null,
  extraSeats: readonly string[] = [],
): FixtureTeam {
  const root = join(base, project);
  const session = `${project}-session`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  const seatNames = ['lead', 'worker', ...extraSeats];
  const seatLines = seatNames
    .map(
      (name) => `  - role: ${name === 'lead' ? 'coordinator' : 'builder'}
    name: ${name}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude ${CHANNEL_FLAG}`,
    )
    .join('\n');
  writeFileSync(
    file,
    `format: 1
project: ${project}
${entity === null ? '' : `entity: ${entity}\n`}session: ${session}
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${seatLines}
`,
  );
  const teamId = teamIdOf(root);
  const agents = (['lead', 'worker'] as const).map((seat, index) => {
    const created = registerAgent(home, {
      name: seat,
      signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'builder' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: `claude ${CHANNEL_FLAG}`,
      reach: { team: teamId, seat, session, pane: `pane-${seat}-${index}`, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
    setAgentTimestamps(home, created.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    return created;
  });
  upsertTeam(home, teamId, {
    root,
    project,
    entity,
    session,
    lobby: join(home, 'lobby'),
    lifecycle: 'running',
    roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
  });
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    JSON.stringify({
      format: 1,
      sessions: {
        [session]: {
          seats: {
            lead: { stage: 'ready', pane: 'pane-lead-0' },
            worker: { stage: 'ready', pane: 'pane-worker-1' },
          },
          worktrees: {},
        },
      },
    }),
  );
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors[0]?.message ?? 'fixture team failed');
  return { root, teamId, session, file, team: loaded.team, lead: agents[0]!, worker: agents[1]! };
}

function agentFilePath(home: string, id: string): string {
  return join(home, '.config', 'team', 'agents', `${id}.yaml`);
}

function setAgentTimestamps(home: string, id: string, registeredAt: string, updatedAt: string): void {
  const path = agentFilePath(home, id);
  const text = readFileSync(path, 'utf8')
    .replace(/  registered_at: "[^"]*"/, `  registered_at: "${registeredAt}"`)
    .replace(/  updated_at: "[^"]*"/, `  updated_at: "${updatedAt}"`);
  writeFileSync(path, text);
}

function registerCompetitor(home: string, original: Agent, registeredAt: string, updatedAt: string): Agent {
  const { id: _id, provenance: _provenance, ...init } = original;
  const competitor = registerAgent(home, { ...init, by: 'owner' });
  setAgentTimestamps(home, competitor.id, registeredAt, updatedAt);
  return competitor;
}

describe('scoped registry readability (R1)', () => {
  test('a disjoint team with roster: null and an unrelated agents/README.md do not block valid local, cross-team or owner/launch delivery', () => {
    const { base, home } = createHome();
    const local = createTeam(base, home, 'alpha', 'org');
    const foreign = createTeam(base, home, 'beta', 'org');
    const disjoint = createTeam(base, home, 'gamma', null);

    // Give the disjoint registered team `roster: null` in teams.yaml.
    const rawTeams = readFileSync(teamsFile(home), 'utf8');
    const disjointBlock = new RegExp(`(${disjoint.teamId}:[\\s\\S]*?)roster:\\n(?:      - [\\s\\S]*?)(?=\\n  team_|$)`);
    const patchedTeams = rawTeams.replace(disjointBlock, '$1roster: null\n');
    expect(patchedTeams).toContain('roster: null');
    writeFileSync(teamsFile(home), patchedTeams);

    // Add an unrelated non-record file and a corrupt record belonging to the disjoint team/seat.
    mkdirSync(join(home, '.config', 'team', 'agents'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'agents', 'README.md'), '# unrelated documentation\n');
    writeFileSync(
      agentFilePath(home, 'agt_000000000099'),
      `id: agt_000000000099\nreach:\n  team: ${disjoint.teamId}\n  seat: helper\n  broken: [\n`,
    );

    expect(
      admitChannelDelivery({
        payload: {
          from: 'worker',
          from_id: local.worker.id,
          to: 'lead',
          to_id: local.lead.id,
          rule: "a seat to its own team's orchestrator",
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      }),
    ).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });

    expect(
      admitChannelDelivery({
        payload: {
          from: 'lead',
          from_id: foreign.lead.id,
          to: 'lead',
          to_id: local.lead.id,
          rule: 'an orchestrator to another orchestrator',
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      }),
    ).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });

    expect(
      admitChannelDelivery({
        payload: { from: 'owner', from_id: null, rule: 'the owner' },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      }),
    ).toEqual({ ok: true, rule: 'the owner' });

    expect(
      admitChannelDelivery({
        payload: {
          from: 'the launch',
          from_id: null,
          rule: 'the launch delivers it to every seat of its team',
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      }),
    ).toEqual({ ok: true, rule: 'the launch delivers it to every seat of its team' });
  });

  test('a corrupt record that could belong to a participating seat fails closed while owner/launch null-id bootstrap still works', () => {
    const { base, home } = createHome();
    const local = createTeam(base, home, 'alpha', null);

    // Write a corrupt same-seat competitor record for `(local.teamId, 'worker')`.
    const corruptCompetitor = agentFilePath(home, 'agt_000000000098');
    writeFileSync(
      corruptCompetitor,
      `id: agt_000000000098\nreach:\n  team: ${local.teamId}\n  seat: worker\nprovenance:\n  updated_at: [\n`,
    );

    const senderBlocked = admitChannelDelivery({
      payload: {
        from: 'worker',
        from_id: local.worker.id,
        to: 'lead',
        to_id: local.lead.id,
        rule: "a seat to its own team's orchestrator",
      },
      home,
      root: local.root,
      session: local.session,
      seat: 'lead',
      team: local.team,
    });
    expect(senderBlocked).toEqual({ ok: false, why: 'the sender registry cannot be read' });

    // Corrupting a possible competitor for the recipient seat blocks ordinary delivery to that seat.
    rmSync(corruptCompetitor, { force: true });
    writeFileSync(
      corruptCompetitor,
      `id: agt_000000000098\nreach:\n  team: ${local.teamId}\n  seat: lead\nprovenance:\n  updated_at: [\n`,
    );
    const recipientBlocked = admitChannelDelivery({
      payload: {
        from: 'worker',
        from_id: local.worker.id,
        to: 'lead',
        to_id: local.lead.id,
        rule: "a seat to its own team's orchestrator",
      },
      home,
      root: local.root,
      session: local.session,
      seat: 'lead',
      team: local.team,
    });
    expect(recipientBlocked).toEqual({ ok: false, why: 'the recipient registry cannot be read' });

    // Reserved null-to_id owner delivery to the declared seat remains available.
    expect(
      admitChannelDelivery({
        payload: { from: 'owner', from_id: null, rule: 'the owner' },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      }),
    ).toEqual({ ok: true, rule: 'the owner' });
  });
});

describe('explicit currentness and metadata ambiguity (R2)', () => {
  test('tied updated_at metadata between same-seat non-retired competitors refuses same-team sender, foreign sender and ordinary recipient even when the roster uniquely names one', () => {
    const { base, home } = createHome();
    const local = createTeam(base, home, 'alpha', 'org');
    const foreign = createTeam(base, home, 'beta', 'org');

    // Same-team sender tie on `(local.teamId, 'worker')`.
    const tiedWorker = registerCompetitor(
      home,
      local.worker,
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    );
    const tieTime = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(agentFilePath(home, local.worker.id), tieTime, tieTime);
    utimesSync(agentFilePath(home, tiedWorker.id), tieTime, tieTime);

    for (const candidateId of [local.worker.id, tiedWorker.id]) {
      upsertTeam(home, local.teamId, {
        root: local.root,
        project: 'alpha',
        entity: 'org',
        session: local.session,
        lobby: join(home, 'lobby'),
        lifecycle: 'running',
        roster: [
          { agent: local.lead.id, seat: 'lead', role: 'coordinator' },
          { agent: candidateId, seat: 'worker', role: 'builder' },
        ],
      });
      const res = admitChannelDelivery({
        payload: {
          from: 'worker',
          from_id: candidateId,
          to: 'lead',
          to_id: local.lead.id,
          rule: "a seat to its own team's orchestrator",
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.why).toContain('not the live holder');
    }

    // Foreign sender tie on `(foreign.teamId, 'lead')`.
    const tiedForeignLead = registerCompetitor(
      home,
      foreign.lead,
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    );
    for (const candidateId of [foreign.lead.id, tiedForeignLead.id]) {
      upsertTeam(home, foreign.teamId, {
        root: foreign.root,
        project: 'beta',
        entity: 'org',
        session: foreign.session,
        lobby: join(home, 'lobby'),
        lifecycle: 'running',
        roster: [
          { agent: candidateId, seat: 'lead', role: 'coordinator' },
          { agent: foreign.worker.id, seat: 'worker', role: 'builder' },
        ],
      });
      const res = admitChannelDelivery({
        payload: {
          from: 'lead',
          from_id: candidateId,
          to: 'lead',
          to_id: local.lead.id,
          rule: 'an orchestrator to another orchestrator',
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.why).toContain('not the current holder of foreign seat');
    }

    // Ordinary recipient tie on `(local.teamId, 'lead')`.
    setAgentTimestamps(home, foreign.lead.id, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    upsertTeam(home, foreign.teamId, {
      root: foreign.root,
      project: 'beta',
      entity: 'org',
      session: foreign.session,
      lobby: join(home, 'lobby'),
      lifecycle: 'running',
      roster: [
        { agent: foreign.lead.id, seat: 'lead', role: 'coordinator' },
        { agent: foreign.worker.id, seat: 'worker', role: 'builder' },
      ],
    });
    const tiedLocalLead = registerCompetitor(
      home,
      local.lead,
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    );
    for (const candidateId of [local.lead.id, tiedLocalLead.id]) {
      upsertTeam(home, local.teamId, {
        root: local.root,
        project: 'alpha',
        entity: 'org',
        session: local.session,
        lobby: join(home, 'lobby'),
        lifecycle: 'running',
        roster: [
          { agent: candidateId, seat: 'lead', role: 'coordinator' },
          { agent: local.worker.id, seat: 'worker', role: 'builder' },
        ],
      });
      const res = admitChannelDelivery({
        payload: {
          from: 'lead',
          from_id: foreign.lead.id,
          to: 'lead',
          to_id: candidateId,
          rule: 'an orchestrator to another orchestrator',
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.why).toContain('not the live agent');
    }
  });

  test('file mtime rewrites cannot restore a superseded holder or defeat an unambiguous newer holder', () => {
    const { base, home } = createHome();
    const local = createTeam(base, home, 'alpha', null);
    const newerWorker = registerCompetitor(
      home,
      local.worker,
      '2020-01-02T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z',
    );

    // Touch the older worker file with a much newer filesystem mtime than the replacement.
    const olderMtime = new Date('2020-01-02T00:00:00.000Z');
    const newerMtime = new Date('2025-01-01T00:00:00.000Z');
    utimesSync(agentFilePath(home, newerWorker.id), olderMtime, olderMtime);
    utimesSync(agentFilePath(home, local.worker.id), newerMtime, newerMtime);

    // While roster still names the older worker, the older worker is refused despite newer mtime.
    const staleAttempt = admitChannelDelivery({
      payload: {
        from: 'worker',
        from_id: local.worker.id,
        to: 'lead',
        to_id: local.lead.id,
        rule: "a seat to its own team's orchestrator",
      },
      home,
      root: local.root,
      session: local.session,
      seat: 'lead',
      team: local.team,
    });
    expect(staleAttempt.ok).toBe(false);
    if (!staleAttempt.ok) expect(staleAttempt.why).toContain('not the live holder');

    // Once the roster updates to the newer worker, the newer worker is admitted and the older remains refused.
    upsertTeam(home, local.teamId, {
      root: local.root,
      project: 'alpha',
      entity: null,
      session: local.session,
      lobby: join(home, 'lobby'),
      lifecycle: 'running',
      roster: [
        { agent: local.lead.id, seat: 'lead', role: 'coordinator' },
        { agent: newerWorker.id, seat: 'worker', role: 'builder' },
      ],
    });
    expect(
      admitChannelDelivery({
        payload: {
          from: 'worker',
          from_id: newerWorker.id,
          to: 'lead',
          to_id: local.lead.id,
          rule: "a seat to its own team's orchestrator",
        },
        home,
        root: local.root,
        session: local.session,
        seat: 'lead',
        team: local.team,
      }),
    ).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
  });
});

describe('same-team sender and projected-roster uniqueness', () => {
  test('a same-team sender bound to two seats on the receiving roster is refused', () => {
    const { base, home } = createHome();
    const local = createTeam(base, home, 'alpha', null, ['helper']);

    upsertTeam(home, local.teamId, {
      root: local.root,
      project: 'alpha',
      entity: null,
      session: local.session,
      lobby: join(home, 'lobby'),
      lifecycle: 'running',
      roster: [
        { agent: local.lead.id, seat: 'lead', role: 'coordinator' },
        { agent: local.worker.id, seat: 'worker', role: 'builder' },
        { agent: local.worker.id, seat: 'helper', role: 'builder' },
      ],
    });

    const res = admitChannelDelivery({
      payload: {
        from: 'worker',
        from_id: local.worker.id,
        to: 'lead',
        to_id: local.lead.id,
        rule: "a seat to its own team's orchestrator",
      },
      home,
      root: local.root,
      session: local.session,
      seat: 'lead',
      team: local.team,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.why).toContain('not the one current roster binding');
  });

  test('projected roster excludes a seat whose roster agent id is tied or superseded when evaluating project-lead authority', () => {
    const { base, home } = createHome();
    const projectLeadTeam = createTeam(base, home, 'proj-main', null);
    const subTeam = createTeam(base, home, 'proj-sub', null);

    upsertProject(home, 'proj-main', {
      name: 'proj-main',
      entity: null,
      lead: projectLeadTeam.worker.id,
      teams: [projectLeadTeam.teamId, subTeam.teamId],
      by: 'owner',
    });
    // Both teams belong to the same project `proj-main` so `projectLeadTeam.worker` (as project lead) reaches `subTeam.lead`.
    writeFileSync(
      subTeam.file,
      readFileSync(subTeam.file, 'utf8').replace('project: proj-sub', 'project: proj-main'),
    );
    const reloaded = readTeamConfig(subTeam.root, { home });
    if (!reloaded.ok) throw new Error('failed to reload subTeam');

    expect(
      admitChannelDelivery({
        payload: {
          from: 'worker',
          from_id: projectLeadTeam.worker.id,
          to: 'lead',
          to_id: subTeam.lead.id,
          rule: 'the project lead and the leads of its teams',
        },
        home,
        root: subTeam.root,
        session: subTeam.session,
        seat: 'lead',
        team: reloaded.team,
      }).ok,
    ).toBe(true);

    // Register a tied competitor for `projectLeadTeam.worker` so its currentness is ambiguous.
    registerCompetitor(
      home,
      projectLeadTeam.worker,
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    );
    expect(
      admitChannelDelivery({
        payload: {
          from: 'worker',
          from_id: projectLeadTeam.worker.id,
          to: 'lead',
          to_id: subTeam.lead.id,
          rule: 'the project lead and the leads of its teams',
        },
        home,
        root: subTeam.root,
        session: subTeam.session,
        seat: 'lead',
        team: reloaded.team,
      }).ok,
    ).toBe(false);
  });
});

describe('channel stream refusal before exposure', () => {
  test('refused records emit no channel notification, write no push marker and write no consumer receipt, while a valid push writes only .channel-push.json', async () => {
    const { base, home } = createHome();
    const local = createTeam(base, home, 'alpha', null, ['helper']);
    const dropDir = join(local.root, '.agents', 'send-drops', local.session, 'lead');

    const helperAgent = registerAgent(home, {
      name: 'helper',
      signing: { model: 'Test', version: '1', role: 'builder' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: `claude ${CHANNEL_FLAG}`,
      reach: { team: local.teamId, seat: 'helper', session: local.session, pane: 'pane-helper-2', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
    // Register a tied competitor on `helper` so `helper` has ambiguous currentness even if listed in roster.
    setAgentTimestamps(home, helperAgent.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    registerCompetitor(home, helperAgent, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');

    upsertTeam(home, local.teamId, {
      root: local.root,
      project: 'alpha',
      entity: null,
      session: local.session,
      lobby: join(home, 'lobby'),
      lifecycle: 'running',
      roster: [
        { agent: local.lead.id, seat: 'lead', role: 'coordinator' },
        { agent: local.worker.id, seat: 'worker', role: 'builder' },
        { agent: helperAgent.id, seat: 'helper', role: 'builder' },
      ],
    });

    let wake: (() => void) | undefined;
    let ended = false;
    const replies: Array<Record<string, any>> = [];
    const feed = {
      lines: (async function* () {
        while (!ended) await new Promise<void>((resolve) => { wake = resolve; });
      })(),
      write: (line: string) => { replies.push(JSON.parse(line)); },
      end: () => { ended = true; wake?.(); },
    };

    const running = runMcpServe(
      { seat: 'lead', session: local.session, file: local.file },
      testIo(local.root, { kind: 'seat', name: 'lead', pane: 'pane-lead-0', session: local.session }),
      feed,
      { home },
    );

    const stageRecord = (id: string, extra: Partial<RecordPayload>) => {
      const payload: RecordPayload = {
        kind: 'message',
        id,
        root: local.root,
        session: local.session,
        from: 'worker',
        from_id: local.worker.id,
        to: 'lead',
        to_id: local.lead.id,
        at: '2026-10-22T09:00:00.000Z',
        body: `payload-${id}`,
        rule: "a seat to its own team's orchestrator",
        thread: id,
        ...extra,
      };
      mkdirSync(dropDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dropDir, id), `${JSON.stringify(signRecord(payload, home), null, 2)}\n`, { mode: 0o600 });
    };

    const NULL_TO_ID = '11111111-0000-4000-8000-000000000201';
    const WRONG_TO_ID = '11111111-0000-4000-8000-000000000202';
    const TIED_FROM_ID = '11111111-0000-4000-8000-000000000203';
    const VALID_ID = '11111111-0000-4000-8000-000000000204';

    try {
      for (let i = 0; i < 400 && !existsSync(listenerPath(dropDir)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(existsSync(listenerPath(dropDir))).toBe(true);

      stageRecord(NULL_TO_ID, { to_id: null, body: 'secret-null-to-id' });
      stageRecord(WRONG_TO_ID, { to_id: 'agt_000000000099', body: 'secret-wrong-to-id' });
      stageRecord(TIED_FROM_ID, { from: 'helper', from_id: helperAgent.id, body: 'secret-tied-sender' });
      stageRecord(VALID_ID, { body: 'valid-channel-delivery' });

      for (let i = 0; i < 400 && !replies.some((one) => one.method === 'notifications/claude/channel'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      const notifications = replies.filter((one) => one.method === 'notifications/claude/channel');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.params.meta).toEqual({
        id: VALID_ID,
        from: 'worker',
        seat: 'lead',
        team: 'alpha',
      });
      expect(notifications[0]!.params.content).toContain('valid-channel-delivery');

      const serialized = JSON.stringify(replies);
      expect(serialized).not.toContain('secret-null-to-id');
      expect(serialized).not.toContain('secret-wrong-to-id');
      expect(serialized).not.toContain('secret-tied-sender');

      for (const refusedId of [NULL_TO_ID, WRONG_TO_ID, TIED_FROM_ID]) {
        expect(existsSync(channelPushPath(dropDir, refusedId))).toBe(false);
        expect(existsSync(receiptPath(dropDir, refusedId))).toBe(false);
      }

      // Accepted receipt separation: transport push writes `.channel-push.json` and never `.read.json`.
      expect(existsSync(channelPushPath(dropDir, VALID_ID))).toBe(true);
      expect(existsSync(receiptPath(dropDir, VALID_ID))).toBe(false);
    } finally {
      feed.end();
      await running;
    }
  });
});
