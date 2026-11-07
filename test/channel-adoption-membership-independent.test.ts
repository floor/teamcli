// Channel admission uses the derived project view. A project lead reaches another
// team's lead from the team records, a seat of another project stays refused
// even when a stale project list names that team, and a push reserves the
// record without writing a read receipt.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { TeamFile } from '../src/file/types.ts';
import { admitChannelDelivery } from '../src/mcp/channel-admit.ts';
import { channelPushPath } from '../src/mcp/channel.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { list, projectsFile, upsertProject } from '../src/registry/projects.ts';
import { setTeamProjectMembership, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';

const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';
const PROJECT_LEAD = 'the project lead and the leads of its teams';
const LEAD_ID = '11111111-0000-4000-8000-000000000311';
const OTHER_ID = '11111111-0000-4000-8000-000000000312';
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0));
});

type Side = {
  root: string;
  teamId: string;
  session: string;
  file: string;
  team: TeamFile;
  lead: Agent;
  worker: Agent;
};

function scratch(): { base: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'channel-adoption-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  return { base, home };
}

function side(base: string, home: string, name: string, entity: string | null): Side {
  const root = join(base, name);
  const session = `${name}-session`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    file,
    `format: 1
project: ${name}
${entity === null ? '' : `entity: ${entity}\n`}session: ${session}
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${CHANNEL_LAUNCH}
  - role: builder
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${CHANNEL_LAUNCH}
`,
  );
  const teamId = teamIdOf(root);
  const agents = (['lead', 'worker'] as const).map((seat, index) => registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'builder' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: CHANNEL_LAUNCH,
    reach: { team: teamId, seat, session, pane: `pane-${name}-${seat}-${index}`, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  }));
  upsertTeam(home, teamId, {
    root,
    project: name,
    entity,
    session,
    lobby: join(home, 'lobby'),
    lifecycle: 'running',
    roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
  });
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      [session]: {
        seats: {
          lead: { stage: 'ready', pane: `pane-${name}-lead` },
          worker: { stage: 'ready', pane: `pane-${name}-worker` },
        },
        worktrees: {},
      },
    },
  })}\n`);
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors[0]?.message ?? 'fixture team failed');
  return { root, teamId, session, file, team: loaded.team, lead: agents[0]!, worker: agents[1]! };
}

function world(): {
  home: string;
  leadSide: Side;
  other: Side;
  recipient: Side;
} {
  const { base, home } = scratch();
  const leadSide = side(base, home, 'side-lead', 'org');
  const recipient = side(base, home, 'side-recv', 'org');
  const other = side(base, home, 'side-other', 'org');
  upsertProject(home, 'proj-main', { name: 'proj-main', entity: 'org', lead: null, by: 'owner' });
  upsertProject(home, 'proj-other', { name: 'proj-other', entity: 'org', lead: null, by: 'owner' });
  setTeamProjectMembership(home, leadSide.teamId, 'proj-main', { by: 'owner' });
  setTeamProjectMembership(home, recipient.teamId, 'proj-main', { by: 'owner' });
  setTeamProjectMembership(home, other.teamId, 'proj-other', { by: 'owner' });
  upsertProject(home, 'proj-main', { lead: leadSide.worker.id });
  const path = projectsFile(home);
  // A team id is twelve hex characters of the temp path. Unquoted, one YAML reads as a number,
  // and the channel reports the project registry cannot be read.
  const staleTeams = `teams: [${JSON.stringify(recipient.teamId)}, ${JSON.stringify(other.teamId)}]`;
  const raw = readFileSync(path, 'utf8').replace(
    '    name: proj-main\n',
    `    name: proj-main\n    ${staleTeams}\n`,
  );
  writeFileSync(path, raw);
  return { home, leadSide, other, recipient };
}

function deliver(
  home: string,
  from: Side,
  sender: Agent,
  recipient: Side,
): ReturnType<typeof admitChannelDelivery> {
  const reloaded = readTeamConfig(recipient.root, { home });
  if (!reloaded.ok) throw new Error(reloaded.errors[0]?.message ?? 'recipient team failed');
  return admitChannelDelivery({
    payload: {
      from: sender.reach.seat,
      from_id: sender.id,
      to: 'lead',
      to_id: recipient.lead.id,
      rule: PROJECT_LEAD,
    },
    home,
    root: recipient.root,
    session: recipient.session,
    seat: 'lead',
    team: reloaded.team,
  });
}

test('channel admission admits a project lead from team-record membership', () => {
  const { home, leadSide, other, recipient } = world();
  const stored = readFileSync(projectsFile(home), 'utf8');
  expect(stored).toContain(`teams: [${JSON.stringify(recipient.teamId)}, ${JSON.stringify(other.teamId)}]`);
  expect(stored).not.toContain(leadSide.teamId);
  const members = list(home).find((project) => project.id === 'proj-main')?.teams ?? [];
  expect(members).toEqual([leadSide.teamId, recipient.teamId].sort());
  expect(deliver(home, leadSide, leadSide.worker, recipient)).toEqual({ ok: true, rule: PROJECT_LEAD });
});

test('a seat of another project is refused though the stale list names its team', () => {
  const { home, other, recipient } = world();
  // The other lead may write as a lead of the same entity. The worker is the
  // project-exclusion case: same entity, other project, stale list, no membership.
  const verdict = deliver(home, other, other.worker, recipient);
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.why).toContain('no rule admits');
});

test('a channel push reserves the record and does not settle a read', async () => {
  const { home, leadSide, other, recipient } = world();
  const dropDir = join(recipient.root, '.agents', 'send-drops', recipient.session, 'lead');
  let wake: (() => void) | undefined;
  let ended = false;
  const replies: Array<Record<string, unknown>> = [];
  const feed = {
    lines: (async function* () {
      while (!ended) await new Promise<void>((resolve) => { wake = resolve; });
    })(),
    write: (line: string) => { replies.push(JSON.parse(line) as Record<string, unknown>); },
    end: () => { ended = true; wake?.(); },
  };
  const io = testIo(recipient.root, { kind: 'seat', name: 'lead', pane: 'pane-side-recv-lead', session: recipient.session });
  const running = runMcpServe(
    { seat: 'lead', session: recipient.session, file: recipient.file },
    io,
    feed,
    { home },
  );
  const stage = (id: string, from: Side, sender: Agent, body: string) => {
    const payload: RecordPayload = {
      kind: 'message',
      id,
      root: recipient.root,
      session: recipient.session,
      from: sender.reach.seat,
      from_id: sender.id,
      to: 'lead',
      to_id: recipient.lead.id,
      at: '2026-11-06T12:00:00.000Z',
      body,
      rule: PROJECT_LEAD,
      thread: id,
    };
    mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dropDir, id), `${JSON.stringify(signRecord(payload, home), null, 2)}\n`, { mode: 0o600 });
  };
  try {
    for (let i = 0; i < 400 && !existsSync(listenerPath(dropDir)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(existsSync(listenerPath(dropDir)), io.err).toBe(true);
    stage(LEAD_ID, leadSide, leadSide.worker, 'project-lead-body');
    stage(OTHER_ID, other, other.worker, 'other-project-secret');
    for (let i = 0; i < 400 && !replies.some((one) => one.method === 'notifications/claude/channel'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const notes = replies.filter((one) => one.method === 'notifications/claude/channel');
    expect(notes).toHaveLength(1);
    const params = notes[0]?.params as { content?: string; meta?: { id?: string } };
    expect(params.meta?.id).toBe(LEAD_ID);
    expect(params.content).toContain('project-lead-body');
    expect(JSON.stringify(replies)).not.toContain('other-project-secret');
    expect(existsSync(channelPushPath(dropDir, LEAD_ID))).toBe(true);
    expect(existsSync(receiptPath(dropDir, LEAD_ID))).toBe(false);
    expect(existsSync(channelPushPath(dropDir, OTHER_ID))).toBe(false);
    expect(existsSync(receiptPath(dropDir, OTHER_ID))).toBe(false);
  } finally {
    feed.end();
    await running;
  }
});
