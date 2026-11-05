// Red-first tests for 0.5.13 compact delivery text (`feat/delivery-text-compact`):
// 1. One-line footer `↩ team reply <prefix> "…" · team ack <prefix>` using the shortest unique id
//    prefix in the mailbox (at least 8 characters, extended only when needed to disambiguate).
// 2. `team reply` and `team ack` accept the short unique prefix and refuse an ambiguous prefix
//    with a clear message naming the colliding record ids.
// 3. Render-time compact header folding across socket frames, `team drops --read`, `inbox_read`,
//    and `team messages`, with the profile's display kind first for non-Claude senders:
//    - Client:      "Grok Bot, a client (owner relay):"
//    - Gemini seat: "Gemini seat Argon (to orchestrator):"
//    - Codex seat:  "Codex seat Cora (to orchestrator):"
//    - Grok seat:   "Grok seat Hyperion (to orchestrator):"
//    - Claude seat: "from Bea (to orchestrator):"
// 4. Signed record payload on disk (`payload.body` and `payload.rule`) stays unchanged and the
//    admission rule stays available in the record and in `team trace`.
//
// Synthetic homes, repositories, keys, and panes only; never touches real credential stores.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLIENT_RULE } from '../src/client/send.ts';
import { runAck } from '../src/commands/ack.ts';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend } from '../src/commands/send.ts';
import { runTrace } from '../src/commands/trace.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readerLine } from '../src/send/frame.ts';
import { readRecord, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const NOW = new Date('2026-11-05T14:00:00.000Z');
const PANE_ORCH = 'pane-orch-compact';
const PANE_BEA = 'pane-bea-compact';
const PANE_ARGON = 'pane-argon-compact';
const PANE_CORA = 'pane-cora-compact';
const PANE_HYPERION = 'pane-hyperion-compact';
const TO_ORCH_RULE = "a seat to its own team's orchestrator";

const TEAM_YAML = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: builder-claude
    label: Bea · builder
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: implementer
    name: builder-gemini
    label: Argon · builder
    cli: antigravity
    vendor: google
    model: Gemini 4 Argon
    version: "1"
    launch: agy --model gemini-4-argon
  - role: implementer
    name: builder-codex
    label: Cora · builder
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
  - role: implementer
    name: builder-grok
    label: Hyperion · builder
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok -m grok-4-7
`;

const cleanupDirs: string[] = [];
const extraCleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of extraCleanups.splice(0)) fn();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture() {
  const base = fixtureBase('.delivery-compact-');
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  messageKeyOf(home);

  const orchAgent = registerAgent(home, {
    name: 'Dora',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: 'acme', seat: 'orchestrator', session: 'acme', pane: PANE_ORCH, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const beaAgent = registerAgent(home, {
    name: 'Bea',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-sonnet-5-5',
    reach: { team: 'acme', seat: 'builder-claude', session: 'acme', pane: PANE_BEA, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const argonAgent = registerAgent(home, {
    name: 'Argon',
    signing: { model: 'Gemini 4 Argon', version: '1', role: 'implementer' },
    lab: 'google',
    cli: 'antigravity',
    launcher: null,
    launch: 'agy --model gemini-4-argon',
    reach: { team: 'acme', seat: 'builder-gemini', session: 'acme', pane: PANE_ARGON, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const coraAgent = registerAgent(home, {
    name: 'Cora',
    signing: { model: 'GPT Sol', version: '6', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6-sol',
    reach: { team: 'acme', seat: 'builder-codex', session: 'acme', pane: PANE_CORA, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const hyperionAgent = registerAgent(home, {
    name: 'Hyperion',
    signing: { model: 'Grok', version: '4.7', role: 'implementer' },
    lab: 'xai',
    cli: 'grok',
    launcher: null,
    launch: 'grok -m grok-4-7',
    reach: { team: 'acme', seat: 'builder-grok', session: 'acme', pane: PANE_HYPERION, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    lobby: '',
    roster: [
      { agent: orchAgent.id, seat: 'orchestrator', role: 'coordinator', nickname: 'Dora' },
      { agent: beaAgent.id, seat: 'builder-claude', role: 'implementer', nickname: 'Bea' },
      { agent: argonAgent.id, seat: 'builder-gemini', role: 'implementer', nickname: 'Argon' },
      { agent: coraAgent.id, seat: 'builder-codex', role: 'implementer', nickname: 'Cora' },
      { agent: hyperionAgent.id, seat: 'builder-grok', role: 'implementer', nickname: 'Hyperion' },
    ],
  });

  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: {
        orchestrator: { stage: 'ready' as const, pane: PANE_ORCH },
        'builder-claude': { stage: 'ready' as const, pane: PANE_BEA },
        'builder-gemini': { stage: 'ready' as const, pane: PANE_ARGON },
        'builder-codex': { stage: 'ready' as const, pane: PANE_CORA },
        'builder-grok': { stage: 'ready' as const, pane: PANE_HYPERION },
      },
    } as never;
  });

  const dropDir = join(root, '.agents', 'send-drops', 'acme', 'orchestrator');
  return {
    base,
    root,
    home,
    dropDir,
    agents: {
      orchestrator: orchAgent.id,
      claude: beaAgent.id,
      gemini: argonAgent.id,
      codex: coraAgent.id,
      grok: hyperionAgent.id,
    },
  };
}

describe('1. compact single-line footer and shortest unique id prefix', () => {
  test('readerLine uses the 8-character id prefix and extends it only when another record in the mailbox shares that prefix', () => {
    const id = '47c25f34-ab42-47d2-a54c-5597aeb305fa';
    expect(readerLine(id)).toBe('↩ team reply 47c25f34 "…" · team ack 47c25f34');

    const colliding = '47c25f34-ab99-4000-8000-000000000001';
    expect(readerLine(id, [colliding])).toBe('↩ team reply 47c25f34-ab4 "…" · team ack 47c25f34-ab4');
  });

  test('socket frame closes with the single-line compact footer using the shortest unique prefix in the recipient mailbox', async () => {
    const made: World = world(null);
    extraCleanups.push(made.cleanup);

    const teamPath = join(made.dir, 'team.yaml');
    const lobby = resolveLobby(made.home, { entity: 'floor' });
    mkdirSync(lobby, { recursive: true });
    const teamText = readFileSync(teamPath, 'utf8').replace(lobbyDir(made.home), lobby);
    writeFileSync(teamPath, `${teamText}entity: floor\n`);

    const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
    if (settingsPath === null) throw new Error('missing settings path for lead');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
    writeFileSync(join(made.sockets, '222.sock'), '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(settingsPath, past, past);

    const frames: string[] = [];
    const host = fake(made, {
      deliver: async (_socket: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    expect(await runSend(['lead', 'first note'], owner(made.root), host)).toBe(0);
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]!) as { msg_id: string; message: { content: string } };
    const prefix = parsed.msg_id.slice(0, 8);
    expect(parsed.message.content.split('\n').at(-1)).toBe(
      `↩ team reply ${prefix} "…" · team ack ${prefix}`,
    );
    expect(parsed.message.content).not.toContain('Answer with team reply');
  });
});

describe('2. team reply and team ack by short prefix and ambiguous prefix refusal', () => {
  test('team ack accepts an 8-character prefix and refuses an ambiguous prefix naming the colliding ids', async () => {
    const f = makeFixture();
    const id1 = '47c25f34-ab42-47d2-a54c-5597aeb305fa';
    plantRecord(
      f.home,
      f.root,
      'acme',
      'orchestrator',
      id1,
      `from Bea — admitted by: ${TO_ORCH_RULE}\n\nReady for review.\n`,
      {
        from: 'builder-claude',
        from_id: f.agents.claude,
        rule: TO_ORCH_RULE,
        at: NOW.toISOString(),
      },
    );

    const ackIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    const ackCode = await runAck(['47c25f34'], ackIo, { home: f.home, now: () => NOW });
    expect(ackCode, ackIo.err).toBe(0);
    expect(ackIo.out).toContain(`${id1}: read`);
    expect(existsSync(join(f.dropDir, `${id1}.read.json`))).toBe(true);

    // Plant two colliding records sharing an 8-character prefix (`99aabbcc`)
    const collA = '99aabbcc-1111-4000-8000-000000000001';
    const collB = '99aabbcc-2222-4000-8000-000000000002';
    for (const id of [collA, collB]) {
      plantRecord(
        f.home,
        f.root,
        'acme',
        'orchestrator',
        id,
        `from Bea — admitted by: ${TO_ORCH_RULE}\n\nNote ${id}.\n`,
        {
          from: 'builder-claude',
          from_id: f.agents.claude,
          rule: TO_ORCH_RULE,
          at: NOW.toISOString(),
        },
      );
    }

    const ambigAckIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    const ambigAckCode = await runAck(['99aabbcc'], ambigAckIo, { home: f.home, now: () => NOW });
    expect(ambigAckCode).toBe(1);
    expect(ambigAckIo.err).toContain('ambiguous');
    expect(ambigAckIo.err).toContain(collA);
    expect(ambigAckIo.err).toContain(collB);
  });

  test('team reply accepts an 8-character prefix and refuses an ambiguous prefix naming the colliding ids', async () => {
    const f = makeFixture();
    const id1 = '47c25f34-ab42-47d2-a54c-5597aeb305fa';
    plantRecord(
      f.home,
      f.root,
      'acme',
      'orchestrator',
      id1,
      `from Bea — admitted by: ${TO_ORCH_RULE}\n\nQuestion for orchestrator.\n`,
      {
        from: 'builder-claude',
        from_id: f.agents.claude,
        rule: TO_ORCH_RULE,
        at: NOW.toISOString(),
      },
    );

    const replyHost = {
      home: f.home,
      now: () => NOW,
      agents: () => [
        { name: 'orchestrator', pane: PANE_ORCH },
        { name: 'builder-claude', pane: PANE_BEA },
      ],
      processInfo: () => ({ shell: 100, foreground: [200] }),
      socketsDir: join(f.base, 'sockets'),
    };
    const replyIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    const replyCode = await runReply(['47c25f34', 'Proceed with the plan.'], replyIo, replyHost);
    expect(replyCode, replyIo.err).toBe(0);
    expect(existsSync(join(f.dropDir, `${id1}.replied.json`))).toBe(true);
    expect(existsSync(join(f.dropDir, `${id1}.read.json`))).toBe(true);

    // Verify the reply record written to builder-claude's folder cites the full id in `in_reply_to`
    const claudeDrops = recordDir(f.root, 'acme', 'builder-claude');
    const writtenFiles = readdirSync(claudeDrops).filter((n) => !n.endsWith('.json') && !n.endsWith('.pending'));
    expect(writtenFiles).toHaveLength(1);
    const readBack = readRecord(join(claudeDrops, writtenFiles[0]!));
    expect(readBack.ok).toBe(true);
    if (readBack.ok && readBack.record) {
      expect(readBack.record.payload.in_reply_to).toBe(id1);
      expect(readBack.record.payload.thread).toBe(id1);
    }

    // Colliding records in orchestrator's mailbox
    const collA = '88ddeeff-1111-4000-8000-000000000001';
    const collB = '88ddeeff-2222-4000-8000-000000000002';
    for (const id of [collA, collB]) {
      plantRecord(
        f.home,
        f.root,
        'acme',
        'orchestrator',
        id,
        `from Bea — admitted by: ${TO_ORCH_RULE}\n\nColliding ${id}.\n`,
        {
          from: 'builder-claude',
          from_id: f.agents.claude,
          rule: TO_ORCH_RULE,
          at: NOW.toISOString(),
        },
      );
    }

    const ambigReplyIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    const ambigReplyCode = await runReply(['88ddeeff', 'Which one?'], ambigReplyIo, replyHost);
    expect(ambigReplyCode).toBe(1);
    expect(ambigReplyIo.err).toContain('ambiguous');
    expect(ambigReplyIo.err).toContain(collA);
    expect(ambigReplyIo.err).toContain(collB);
  });
});

describe('3. compact header folding and sender kind opening words across render points', () => {
  test('renders client, Gemini seat, Codex seat, Grok seat, and Claude seat compact headers in inbox_read, drops --read, and messages while keeping record payload intact', async () => {
    const f = makeFixture();

    const cases: Array<{
      id: string;
      from: string;
      from_id: string | null;
      from_client?: { client_id: string; grant_id: string };
      rule: string;
      rawBody: string;
      expectedHeader: string;
      messageText: string;
    }> = [
      {
        id: '11111111-0000-4000-8000-000000000001',
        from: 'client:grok-bot',
        from_id: null,
        from_client: { client_id: 'grok-bot', grant_id: 'grant-01' },
        rule: CLIENT_RULE,
        rawBody: 'Owner relay ping.\n',
        expectedHeader: 'Grok Bot, a client (owner relay):',
        messageText: 'Owner relay ping.\n',
      },
      {
        id: '22222222-0000-4000-8000-000000000002',
        from: 'builder-gemini',
        from_id: f.agents.gemini,
        rule: TO_ORCH_RULE,
        rawBody: `from Argon — admitted by: ${TO_ORCH_RULE}\n\nGemini lane green.\n`,
        expectedHeader: 'Gemini seat Argon (to orchestrator):',
        messageText: 'Gemini seat Argon (to orchestrator):\n\nGemini lane green.\n',
      },
      {
        id: '33333333-0000-4000-8000-000000000003',
        from: 'builder-codex',
        from_id: f.agents.codex,
        rule: TO_ORCH_RULE,
        rawBody: `from Cora — admitted by: ${TO_ORCH_RULE}\n\nCodex lane green.\n`,
        expectedHeader: 'Codex seat Cora (to orchestrator):',
        messageText: 'Codex seat Cora (to orchestrator):\n\nCodex lane green.\n',
      },
      {
        id: '44444444-0000-4000-8000-000000000004',
        from: 'builder-grok',
        from_id: f.agents.grok,
        rule: TO_ORCH_RULE,
        rawBody: `from Hyperion — admitted by: ${TO_ORCH_RULE}\n\nGrok lane green.\n`,
        expectedHeader: 'Grok seat Hyperion (to orchestrator):',
        messageText: 'Grok seat Hyperion (to orchestrator):\n\nGrok lane green.\n',
      },
      {
        id: '55555555-0000-4000-8000-000000000005',
        from: 'builder-claude',
        from_id: f.agents.claude,
        rule: TO_ORCH_RULE,
        rawBody: `from Bea — admitted by: ${TO_ORCH_RULE}\n\nClaude lane green.\n`,
        expectedHeader: 'from Bea (to orchestrator):',
        messageText: 'from Bea (to orchestrator):\n\nClaude lane green.\n',
      },
    ];

    // Check `inbox_read` (`readMessage`) and verify signed record on disk is untouched
    for (const c of cases) {
      rmSync(f.dropDir, { recursive: true, force: true });
      mkdirSync(f.dropDir, { recursive: true });
      const payload: RecordPayload = {
        kind: 'message',
        id: c.id,
        from: c.from,
        from_id: c.from_id,
        to: 'orchestrator',
        to_id: f.agents.orchestrator,
        root: f.root,
        session: 'acme',
        at: NOW.toISOString(),
        body: c.rawBody,
        rule: c.rule,
        thread: c.id,
        ...(c.from_client === undefined ? {} : { from_client: c.from_client }),
      };
      const wrote = writeRecord(f.dropDir, signRecord(payload, f.home));
      if (!wrote.ok) throw new Error(wrote.reason);
      const rawDiskBefore = readFileSync(wrote.path, 'utf8');

      const readRes = readMessage(
        { dropDir: f.dropDir, root: f.root, seat: 'orchestrator', session: 'acme' },
        c.id,
        f.home,
      );
      expect(readRes.ok).toBe(true);
      if (readRes.ok) {
        expect(readRes.body.startsWith(`${c.expectedHeader}\n\n`)).toBe(true);
        expect(readRes.body).not.toContain('— admitted by:');
        expect(readRes.body).not.toContain('[attributed sender:');
      }

      // Signed record on disk keeps its full `body` and `rule`
      expect(readFileSync(wrote.path, 'utf8')).toBe(rawDiskBefore);
      const onDisk = readRecord(wrote.path, c.id);
      expect(onDisk.ok).toBe(true);
      if (onDisk.ok && onDisk.record) {
        expect(onDisk.record.payload.body).toBe(c.rawBody);
        expect(onDisk.record.payload.rule).toBe(c.rule);
      }
    }

    // Check `team drops --read` and `team messages`
    rmSync(f.dropDir, { recursive: true, force: true });
    plantRecord(
      f.home,
      f.root,
      'acme',
      'orchestrator',
      cases[1]!.id,
      cases[1]!.rawBody,
      {
        from: cases[1]!.from,
        from_id: cases[1]!.from_id,
        rule: cases[1]!.rule,
        at: NOW.toISOString(),
      },
    );
    const dropsIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runDrops(['--read', '--seat', 'orchestrator', '--session', 'acme'], dropsIo, { home: f.home })).toBe(0);
    expect(dropsIo.out).toContain('Gemini seat Argon (to orchestrator):\n\nGemini lane green.');
    expect(dropsIo.out).not.toContain('— admitted by:');

    rmSync(f.dropDir, { recursive: true, force: true });
    plantRecord(
      f.home,
      f.root,
      'acme',
      'orchestrator',
      cases[2]!.id,
      cases[2]!.rawBody,
      {
        from: cases[2]!.from,
        from_id: cases[2]!.from_id,
        rule: cases[2]!.rule,
        at: NOW.toISOString(),
      },
    );
    const msgIo = testIo(f.root, { kind: 'owner' });
    expect(await runMessages([], msgIo, { home: f.home, now: () => NOW })).toBe(0);
    expect(msgIo.out).toContain('Codex seat Cora (to orchestrator):\n\nCodex lane green.');
    expect(msgIo.out).not.toContain('— admitted by:');
  });

  test('socket frame has a single compact header line, the body, and the one-line footer, while team trace preserves the admission rule', async () => {
    const made: World = world(null, [
      { name: 'argon', role: 'implementer', cli: 'antigravity', label: 'Argon · builder' },
    ]);
    extraCleanups.push(made.cleanup);

    const teamPath = join(made.dir, 'team.yaml');
    const lobby = resolveLobby(made.home, { entity: 'floor' });
    mkdirSync(lobby, { recursive: true });
    const teamText = readFileSync(teamPath, 'utf8').replace(lobbyDir(made.home), lobby);
    writeFileSync(teamPath, `${teamText}entity: floor\n`);

    const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
    if (settingsPath === null) throw new Error('missing settings path for lead');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
    writeFileSync(join(made.sockets, '222.sock'), '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(settingsPath, past, past);

    const argonId = registerAgent(made.home, {
      name: 'Argon',
      signing: { model: 'Gemini 4 Argon', version: '1', role: 'implementer' },
      lab: 'google',
      cli: 'antigravity',
      launcher: null,
      launch: 'agy --model gemini-4-argon',
      reach: { team: 'acme', seat: 'argon', session: 'acme', pane: 'pane-argon', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    }).id;
    const leadId = registerAgent(made.home, {
      name: 'Dora',
      signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: { team: 'acme', seat: 'lead', session: 'acme', pane: 'pane-lead', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    }).id;

    upsertTeam(made.home, teamIdOf(made.root), {
      project: 'acme',
      session: 'acme',
      root: made.root,
      lobby,
      roster: [
        { agent: leadId, seat: 'lead', role: 'coordinator', nickname: 'Dora' },
        { agent: argonId, seat: 'argon', role: 'implementer', nickname: 'Argon' },
      ],
    });
    updateState(made.dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: { stage: 'ready' as const, pane: 'pane-lead' },
          argon: { stage: 'ready' as const, pane: 'pane-argon' },
        },
      } as never;
    });

    const frames: string[] = [];
    const host = fake(made, {
      agents: () => [
        { name: 'lead', pane: 'pane-lead' },
        { name: 'argon', pane: 'pane-argon' },
      ],
      deliver: async (_socket: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const sendIo = testIo(made.root, { kind: 'seat', name: 'argon', pane: 'pane-argon', session: 'acme' });
    expect(await runSend(['lead', 'ship it'], sendIo, host)).toBe(0);
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]!) as { msg_id: string; message: { content: string } };
    const prefix = parsed.msg_id.slice(0, 8);
    expect(parsed.message.content).toBe(
      `Gemini seat Argon (to orchestrator):\n\nship it\n\n↩ team reply ${prefix} "…" · team ack ${prefix}`,
    );

    // Record on disk keeps the full `from Argon — admitted by: <rule>` and `payload.rule`
    const dropPath = join(made.dir, 'send-drops', 'acme', 'lead', parsed.msg_id);
    const recordOnDisk = readRecord(dropPath, parsed.msg_id);
    expect(recordOnDisk.ok).toBe(true);
    if (recordOnDisk.ok && recordOnDisk.record) {
      expect(recordOnDisk.record.payload.rule).toBe(TO_ORCH_RULE);
      expect(recordOnDisk.record.payload.body).toBe(
        `from Argon — admitted by: ${TO_ORCH_RULE}\n\nship it`,
      );
    }

    // `team trace` surfaces the admission rule
    const traceIo = owner(made.root);
    expect(await runTrace([parsed.msg_id], traceIo, { home: made.home })).toBe(0);
    expect(traceIo.out).toContain(`admitted by: ${TO_ORCH_RULE}`);
  });
});
