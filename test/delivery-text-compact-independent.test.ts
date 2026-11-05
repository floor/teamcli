// Independent third-lab scene for 0.5.13 compact delivery text (`feat/delivery-text-compact`).
// Authored by operator-1; shares no assertions with the author's test file. It checks, from the
// outside:
//   1. the one-line reader footer names an 8-character prefix, extended only when another record
//      in the same mailbox shares it;
//   2. `team reply` and `team ack` accept that prefix, refuse an ambiguous one by naming both
//      records, keep exact ids decisive, and judge ambiguity within the caller's own mailbox;
//   3. the compact sender header renders at every reading surface (inbox_read, drops --read,
//      team messages, socket frame), with the seat's profile kind first for non-Claude senders;
//   4. the signed record on disk keeps its full `from … — admitted by: …` body and `rule`, and
//      `team trace` still shows the admission rule.
// Synthetic fixture only: a temp checkout, a temp home, synthetic registry records.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLIENT_RULE } from '../src/client/send.ts';
import { runAck } from '../src/commands/ack.ts';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend } from '../src/commands/send.ts';
import { runTrace } from '../src/commands/trace.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { requestDaemon, startSendDaemon, type DaemonHost } from '../src/send/daemon.ts';
import { readerLine } from '../src/send/frame.ts';
import { readRecord, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { fake, owner, world } from './send-native-fixtures.ts';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const RULE = "a seat to its own team's orchestrator";
const PANE_ORCH = 'pane-orch-compact';
const PANE_SELENE = 'pane-selene-compact';

const TEAM_YAML = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: chief
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: meadow
    label: Meadow · builder
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: implementer
    name: selene
    label: Selene · builder
    cli: antigravity
    vendor: google
    model: Gemini 4 Selene
    version: "1"
    launch: agy --model gemini-4-selene
  - role: implementer
    name: corvid
    label: Corvid · builder
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
  - role: implementer
    name: lyra
    label: Lyra · builder
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok -m grok-4-7
`;

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Scene = {
  base: string;
  root: string;
  home: string;
  dropDir: string;
  ids: { orchestrator: string; meadow: string; selene: string; corvid: string; lyra: string };
};

function scene(): Scene {
  const base = fixtureBase('.delivery-text-independent-');
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  messageKeyOf(home);

  const agent = (
    name: string,
    cli: string,
    seat: string,
    pane: string,
    lab: string,
    signing: { model: string; version: string; role: 'coordinator' | 'implementer' },
    launch: string,
  ) =>
    registerAgent(home, {
      name,
      signing,
      lab,
      cli,
      launcher: null,
      launch,
      reach: { team: 'acme', seat, session: 'acme', pane, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });

  const orchestrator = agent('Dora', 'claude-code', 'orchestrator', PANE_ORCH, 'anthropic',
    { model: 'Claude Opus', version: '5.5', role: 'coordinator' }, 'claude --model claude-opus-5-5');
  const meadow = agent('Meadow', 'claude-code', 'meadow', 'pane-meadow', 'anthropic',
    { model: 'Claude Sonnet', version: '5.5', role: 'implementer' }, 'claude --model claude-sonnet-5-5');
  const selene = agent('Selene', 'antigravity', 'selene', PANE_SELENE, 'google',
    { model: 'Gemini 4 Selene', version: '1', role: 'implementer' }, 'agy --model gemini-4-selene');
  const corvid = agent('Corvid', 'codex', 'corvid', 'pane-corvid', 'openai',
    { model: 'GPT Sol', version: '6', role: 'implementer' }, 'codex -m gpt-6-sol');
  const lyra = agent('Lyra', 'grok', 'lyra', 'pane-lyra', 'xai',
    { model: 'Grok', version: '4.7', role: 'implementer' }, 'grok -m grok-4-7');

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    lobby: '',
    roster: [
      { agent: orchestrator.id, seat: 'orchestrator', role: 'coordinator', nickname: 'Dora' },
      { agent: meadow.id, seat: 'meadow', role: 'implementer', nickname: 'Meadow' },
      { agent: selene.id, seat: 'selene', role: 'implementer', nickname: 'Selene' },
      { agent: corvid.id, seat: 'corvid', role: 'implementer', nickname: 'Corvid' },
      { agent: lyra.id, seat: 'lyra', role: 'implementer', nickname: 'Lyra' },
    ],
  });

  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: {
        orchestrator: { stage: 'ready' as const, pane: PANE_ORCH },
        meadow: { stage: 'ready' as const, pane: 'pane-meadow' },
        selene: { stage: 'ready' as const, pane: PANE_SELENE },
        corvid: { stage: 'ready' as const, pane: 'pane-corvid' },
        lyra: { stage: 'ready' as const, pane: 'pane-lyra' },
      },
    } as never;
  });

  return {
    base,
    root,
    home,
    dropDir: join(root, '.agents', 'send-drops', 'acme', 'orchestrator'),
    ids: {
      orchestrator: orchestrator.id,
      meadow: meadow.id,
      selene: selene.id,
      corvid: corvid.id,
      lyra: lyra.id,
    },
  };
}

function seatIo(at: Scene, seat: string, pane: string) {
  return testIo(at.root, { kind: 'seat', name: seat, pane, session: 'acme' });
}

function note(at: Scene, to: string, id: string, from: string, fromId: string | null, body: string, rule = RULE) {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to,
    to_id: to === 'orchestrator' ? at.ids.orchestrator : null,
    root: at.root,
    session: 'acme',
    at: NOW.toISOString(),
    body,
    from,
    from_id: fromId,
    rule,
    thread: id,
  };
  return writeRecord(recordDir(at.root, 'acme', to), signRecord(payload, at.home));
}

describe('1. the reader footer names the shortest unique id prefix', () => {
  test('an isolated id gets its 8-character prefix, in the one-line footer', () => {
    const id = 'a1b2c3d4-1111-4000-8000-000000000001';
    expect(readerLine(id)).toBe('↩ team reply a1b2c3d4 "…" · team ack a1b2c3d4');
    // The record itself is never its own collision.
    expect(readerLine(id, [id])).toBe('↩ team reply a1b2c3d4 "…" · team ack a1b2c3d4');
    // The old two-sentence footer is gone, including the read-marking explanation.
    expect(readerLine(id)).not.toContain('Answer with team reply');
    expect(readerLine(id)).not.toContain('this marks it read');
  });

  test('a shared prefix grows one character at a time until it stops colliding', () => {
    const id = 'a1b2c3d4-1111-4000-8000-000000000001';
    // Same first 10 characters, then "1" against "2": 11 characters separate them.
    expect(readerLine(id, ['a1b2c3d4-2222-4000-8000-000000000002'])).toBe(
      '↩ team reply a1b2c3d4-1 "…" · team ack a1b2c3d4-1',
    );
    // Same first 11 characters, then "1" against "a": 12 characters separate them.
    expect(readerLine(id, ['a1b2c3d4-1aaa-4000-8000-000000000003'])).toBe(
      '↩ team reply a1b2c3d4-11 "…" · team ack a1b2c3d4-11',
    );
    // Two neighbours at different depths: the farther one decides the length.
    expect(readerLine(id, ['a1b2c3d4-2222-4000-8000-000000000002', 'a1b2c3d4-1aaa-4000-8000-000000000003']))
      .toBe('↩ team reply a1b2c3d4-11 "…" · team ack a1b2c3d4-11');
  });
});

describe('2. reply and ack by prefix, in the caller mailbox', () => {
  test('team ack reads an 8-character prefix and names the full record in its receipt line', async () => {
    const at = scene();
    const id = 'a1b2c3d4-1111-4000-8000-000000000001';
    note(at, 'orchestrator', id, 'selene', at.ids.selene,
      `from Selene — admitted by: ${RULE}\n\nQuestion for the lead.\n`);

    const io = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runAck(['a1b2c3d4'], io, { home: at.home, now: () => NOW })).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain(`${id}: read`);
    expect(existsSync(join(at.dropDir, `${id}.read.json`))).toBe(true);
  });

  test('a prefix shorter than 8 characters is refused and marks nothing read or answered', async () => {
    const at = scene();
    const id = 'a1b2c3d4-5555-4000-8000-000000000005';
    note(at, 'orchestrator', id, 'selene', at.ids.selene,
      `from Selene — admitted by: ${RULE}\n\nShort prefix check.\n`);

    const ackIo = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runAck(['a1b'], ackIo, { home: at.home, now: () => NOW })).toBe(1);
    expect(ackIo.err).toContain(
      'record prefix "a1b" is shorter than 8 characters; pass at least 8 characters',
    );
    expect(existsSync(join(at.dropDir, `${id}.read.json`))).toBe(false);

    const replyId = 'd4e5f6a7-0000-4000-8000-00000000000c';
    const replyHost = {
      home: at.home,
      now: () => NOW,
      newId: () => replyId,
      agents: () => [
        { name: 'orchestrator', pane: PANE_ORCH },
        { name: 'selene', pane: PANE_SELENE },
      ],
      processInfo: () => ({ shell: 100, foreground: [200] }),
      socketsDir: join(at.base, 'sockets'),
    };
    const replyIo = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runReply(['a1b', 'Too short.'], replyIo, replyHost)).toBe(1);
    expect(replyIo.err).toContain(
      'record prefix "a1b" is shorter than 8 characters; pass at least 8 characters',
    );
    expect(existsSync(join(recordDir(at.root, 'acme', 'selene'), replyId))).toBe(false);
    expect(existsSync(join(at.dropDir, `${id}.replied.json`))).toBe(false);
    expect(existsSync(join(at.dropDir, `${id}.read.json`))).toBe(false);
  });

  test('an ambiguous prefix is refused with both ids named; the exact id stays decisive', async () => {
    const at = scene();
    const first = '99aabbcc-1111-4000-8000-000000000001';
    const second = '99aabbcc-2222-4000-8000-000000000002';
    for (const id of [first, second]) {
      note(at, 'orchestrator', id, 'selene', at.ids.selene,
        `from Selene — admitted by: ${RULE}\n\nRecord ${id}.\n`);
    }

    const ambiguous = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runAck(['99aabbcc'], ambiguous, { home: at.home, now: () => NOW })).toBe(1);
    expect(ambiguous.err).toContain('record prefix "99aabbcc" is ambiguous in orchestrator\'s mailbox');
    expect(ambiguous.err).toContain(first);
    expect(ambiguous.err).toContain(second);
    expect(ambiguous.err).toContain('pass a longer prefix');
    expect(existsSync(join(at.dropDir, `${first}.read.json`))).toBe(false);
    expect(existsSync(join(at.dropDir, `${second}.read.json`))).toBe(false);

    // A full id selects one record even while the shared 8-character prefix is ambiguous.
    const exact = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runAck([second], exact, { home: at.home, now: () => NOW })).toBe(0);
    expect(exact.out).toContain(`${second}: read`);
    expect(existsSync(join(at.dropDir, `${first}.read.json`))).toBe(false);
  });

  test('a neighbour in another seat\'s folder does not make the caller\'s prefix ambiguous', async () => {
    const at = scene();
    const mine = 'cafef00d-1111-4000-8000-000000000001';
    const theirs = 'cafef00d-2222-4000-8000-000000000002';
    note(at, 'orchestrator', mine, 'selene', at.ids.selene,
      `from Selene — admitted by: ${RULE}\n\nMine only.\n`);
    note(at, 'selene', theirs, 'meadow', at.ids.meadow,
      `from Meadow — admitted by: ${RULE}\n\nSelene's own.\n`);

    const io = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runAck(['cafef00d'], io, { home: at.home, now: () => NOW })).toBe(0);
    expect(io.out).toContain(`${mine}: read`);
    const seleneReceipts = existsSync(recordDir(at.root, 'acme', 'selene'))
      ? readdirSync(recordDir(at.root, 'acme', 'selene')).filter((name) => name.startsWith(`${theirs}.`))
      : [];
    expect(seleneReceipts).toHaveLength(0);
  });

  test('team reply resolves the prefix to the full record for the written answer', async () => {
    const at = scene();
    const asked = 'a1b2c3d4-9999-4000-8000-000000000009';
    const replyId = 'b2c3d4e5-0000-4000-8000-00000000000a';
    note(at, 'orchestrator', asked, 'selene', at.ids.selene,
      `from Selene — admitted by: ${RULE}\n\nMay I proceed?\n`);

    const replyHost = {
      home: at.home,
      now: () => NOW,
      newId: () => replyId,
      agents: () => [
        { name: 'orchestrator', pane: PANE_ORCH },
        { name: 'selene', pane: PANE_SELENE },
      ],
      processInfo: () => ({ shell: 100, foreground: [200] }),
      socketsDir: join(at.base, 'sockets'),
    };
    const io = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runReply(['a1b2c3d4', 'Proceed.'], io, replyHost)).toBe(0);
    expect(io.err).toBe('');
    expect(existsSync(join(at.dropDir, `${asked}.replied.json`))).toBe(true);
    expect(existsSync(join(at.dropDir, `${asked}.read.json`))).toBe(true);

    const written = readRecord(join(recordDir(at.root, 'acme', 'selene'), replyId), replyId);
    expect(written.ok).toBe(true);
    if (written.ok && written.record !== null) {
      expect(written.record.payload.to).toBe('selene');
      expect(written.record.payload.in_reply_to).toBe(asked);
      expect(written.record.payload.thread).toBe(asked);
    }
  });

  test('an ambiguous reply prefix is refused before any answer is written', async () => {
    const at = scene();
    const first = '77aa77aa-1111-4000-8000-000000000001';
    const second = '77aa77aa-2222-4000-8000-000000000002';
    const replyId = 'c3d4e5f6-0000-4000-8000-00000000000b';
    for (const id of [first, second]) {
      note(at, 'orchestrator', id, 'selene', at.ids.selene,
        `from Selene — admitted by: ${RULE}\n\nWhich thread ${id}?\n`);
    }
    const replyHost = {
      home: at.home,
      now: () => NOW,
      newId: () => replyId,
      agents: () => [
        { name: 'orchestrator', pane: PANE_ORCH },
        { name: 'selene', pane: PANE_SELENE },
      ],
      processInfo: () => ({ shell: 100, foreground: [200] }),
      socketsDir: join(at.base, 'sockets'),
    };
    const io = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runReply(['77aa77aa', 'Which one?'], io, replyHost)).toBe(1);
    expect(io.err).toContain('record prefix "77aa77aa" is ambiguous in orchestrator\'s mailbox');
    expect(io.err).toContain(first);
    expect(io.err).toContain(second);
    expect(existsSync(join(recordDir(at.root, 'acme', 'selene'), replyId))).toBe(false);
    expect(existsSync(join(at.dropDir, `${first}.replied.json`))).toBe(false);
    expect(existsSync(join(at.dropDir, `${second}.replied.json`))).toBe(false);
  });
});

describe('3. compact sender headers at each reading surface', () => {
  const cases = [
    { id: '11111111-0000-4000-8000-000000000001', seat: 'selene', header: 'Selene', prefix: 'Gemini seat Selene', body: 'Gemini lane clear.' },
    { id: '11111111-0000-4000-8000-000000000002', seat: 'corvid', header: 'Corvid', prefix: 'Codex seat Corvid', body: 'Codex lane clear.' },
    { id: '11111111-0000-4000-8000-000000000003', seat: 'lyra', header: 'Lyra', prefix: 'Grok seat Lyra', body: 'Grok lane clear.' },
    { id: '11111111-0000-4000-8000-000000000004', seat: 'meadow', header: 'Meadow', prefix: 'from Meadow', body: 'Claude lane clear.' },
  ] as const;

  test('inbox_read folds from/admitted-by into one header and leaves the signed record untouched', () => {
    const at = scene();
    for (const one of cases) {
      const id = one.id;
      const body = `from ${one.header} — admitted by: ${RULE}\n\n${one.body}\n`;
      const wrote = note(at, 'orchestrator', id, one.seat, at.ids[one.seat], body);
      if (!wrote.ok) throw new Error(wrote.reason);
      const before = readFileSync(wrote.path, 'utf8');

      const read = readMessage(
        { dropDir: at.dropDir, root: at.root, seat: 'orchestrator', session: 'acme' },
        id,
        at.home,
      );
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.body.startsWith(`${one.prefix} (to orchestrator):\n\n`)).toBe(true);
        expect(read.body).not.toContain('— admitted by:');
        expect(read.body).not.toContain('[attributed sender:');
      }

      // The stored bytes are the sender's; the fold exists only at render time.
      expect(readFileSync(wrote.path, 'utf8')).toBe(before);
      const onDisk = readRecord(wrote.path, id);
      expect(onDisk.ok).toBe(true);
      if (onDisk.ok && onDisk.record !== null) {
        expect(onDisk.record.payload.body).toBe(body);
        expect(onDisk.record.payload.rule).toBe(RULE);
      }
    }
  });

  test('a client record opens with its name and kind, not the seat fold', () => {
    const at = scene();
    const id = '22222222-0000-4000-8000-000000000001';
    const body = 'Owner relay ping.\n';
    const payload: RecordPayload = {
      kind: 'message',
      id,
      from: 'client:grok-bot',
      from_id: null,
      to: 'orchestrator',
      to_id: at.ids.orchestrator,
      root: at.root,
      session: 'acme',
      at: NOW.toISOString(),
      body,
      rule: CLIENT_RULE,
      thread: id,
      from_client: { client_id: 'grok-bot', grant_id: 'grant-7' },
    };
    const wrote = writeRecord(at.dropDir, signRecord(payload, at.home));
    if (!wrote.ok) throw new Error(wrote.reason);
    const read = readMessage(
      { dropDir: at.dropDir, root: at.root, seat: 'orchestrator', session: 'acme' },
      id,
      at.home,
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.body.startsWith('Client Grok Bot (owner relay):\n\n')).toBe(true);
      expect(read.body).not.toContain('— admitted by:');
    }
  });

  test('an owner frame opens with the owner header, not the reserved words of a seat', async () => {
    const made = world(null);
    try {
      const teamPath = join(made.dir, 'team.yaml');
      const lobby = resolveLobby(made.home, { entity: 'floor' });
      mkdirSync(lobby, { recursive: true });
      const teamText = readFileSync(teamPath, 'utf8').replace(lobbyDir(made.home), lobby);
      writeFileSync(teamPath, `${teamText}entity: floor\n`);
      const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
      if (settingsPath === null) throw new Error('missing CliHook settings path for lead');
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
      writeFileSync(join(made.sockets, '222.sock'), '');
      const past = new Date(Date.now() - 60_000);
      utimesSync(settingsPath, past, past);

      const host = fake(made, { agents: () => [{ name: 'lead', pane: 'pane-lead' }] });
      const io = owner(made.root);
      expect(await runSend(['lead', 'plain note'], io, host)).toBe(0);
      expect(host.frames).toHaveLength(1);
      const frame = JSON.parse(host.frames[0]!) as { msg_id: string; message: { content: string } };
      const prefix = frame.msg_id.slice(0, 8);
      expect(frame.message.content).toBe(
        `from the owner (owner):\n\nplain note\n\n↩ team reply ${prefix} "…" · team ack ${prefix}`,
      );
    } finally {
      made.cleanup();
    }
  });

  test('team drops --read folds the Gemini seat header', async () => {
    const at = scene();
    const id = '33333333-0000-4000-8000-000000000001';
    plantRecord(at.home, at.root, 'acme', 'orchestrator', id,
      `from Selene — admitted by: ${RULE}\n\nStaged report.`, {
        from: 'selene',
        from_id: at.ids.selene,
        rule: RULE,
        at: NOW.toISOString(),
      });
    const io = seatIo(at, 'orchestrator', PANE_ORCH);
    expect(await runDrops(['--read', '--seat', 'orchestrator', '--session', 'acme'], io, { home: at.home })).toBe(0);
    expect(io.out).toContain('Gemini seat Selene (to orchestrator):\n\nStaged report.');
    expect(io.out).not.toContain('— admitted by:');
  });

  test('team messages folds the Codex seat header in its text reading', async () => {
    const at = scene();
    const id = '44444444-0000-4000-8000-000000000001';
    plantRecord(at.home, at.root, 'acme', 'orchestrator', id,
      `from Corvid — admitted by: ${RULE}\n\nQueue report.`, {
        from: 'corvid',
        from_id: at.ids.corvid,
        rule: RULE,
        at: NOW.toISOString(),
      });
    const io = owner(at.root);
    expect(await runMessages([], io, { home: at.home, now: () => NOW })).toBe(0);
    expect(io.out).toContain('Codex seat Corvid (to orchestrator):\n\nQueue report.');
    expect(io.out).not.toContain('— admitted by:');
  });

  test('the socket frame carries the compact header, the body, and the one-line footer; the record and trace keep the full rule', async () => {
    const made = world(null, [{ name: 'corvid', role: 'implementer', cli: 'codex', label: 'Corvid · builder' }]);
    try {
      const teamPath = join(made.dir, 'team.yaml');
      const lobby = resolveLobby(made.home, { entity: 'floor' });
      mkdirSync(lobby, { recursive: true });
      const teamText = readFileSync(teamPath, 'utf8').replace(lobbyDir(made.home), lobby);
      writeFileSync(teamPath, `${teamText}entity: floor\n`);

      const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
      if (settingsPath === null) throw new Error('missing CliHook settings path for lead');
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
      writeFileSync(join(made.sockets, '222.sock'), '');
      const past = new Date(Date.now() - 60_000);
      utimesSync(settingsPath, past, past);

      const corvidId = registerAgent(made.home, {
        name: 'Corvid',
        signing: { model: 'GPT Sol', version: '6', role: 'implementer' },
        lab: 'openai',
        cli: 'codex',
        launcher: null,
        launch: 'codex -m gpt-6-sol',
        reach: { team: 'acme', seat: 'corvid', session: 'acme', pane: 'pane-corvid', address: null },
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
          { agent: corvidId, seat: 'corvid', role: 'implementer', nickname: 'Corvid' },
        ],
      });
      updateState(made.dir, (state) => {
        state.sessions.acme = {
          seats: {
            lead: { stage: 'ready' as const, pane: 'pane-lead' },
            corvid: { stage: 'ready' as const, pane: 'pane-corvid' },
          },
        } as never;
      });

      const host = fake(made, {
        agents: () => [
          { name: 'lead', pane: 'pane-lead' },
          { name: 'corvid', pane: 'pane-corvid' },
        ],
      });
      const io = testIo(made.root, { kind: 'seat', name: 'corvid', pane: 'pane-corvid', session: 'acme' });
      expect(await runSend(['lead', 'status report'], io, host)).toBe(0);
      expect(host.frames).toHaveLength(1);
      const frame = JSON.parse(host.frames[0]!) as { msg_id: string; message: { content: string } };
      const prefix = frame.msg_id.slice(0, 8);
      expect(frame.message.content).toBe(
        `Codex seat Corvid (to orchestrator):\n\nstatus report\n\n↩ team reply ${prefix} "…" · team ack ${prefix}`,
      );
      expect(frame.message.content).not.toContain('Answer with team reply');
      expect(frame.message.content).not.toContain('— admitted by:');

      const stored = readRecord(join(made.dir, 'send-drops', 'acme', 'lead', frame.msg_id), frame.msg_id);
      expect(stored.ok).toBe(true);
      if (stored.ok && stored.record !== null) {
        expect(stored.record.payload.rule).toBe(RULE);
        expect(stored.record.payload.body).toBe(`from Corvid — admitted by: ${RULE}\n\nstatus report`);
      }

      const traceIo = owner(made.root);
      expect(await runTrace([frame.msg_id], traceIo, { home: made.home })).toBe(0);
      expect(traceIo.out).toContain(`admitted by: ${RULE}`);
    } finally {
      made.cleanup();
    }
  });

  test('a daemon waited socket frame names only the sender; the summary stays in the body', async () => {
    const made = world(null, [{ name: 'corvid', role: 'implementer', cli: 'codex', label: 'Corvid · builder' }]);
    try {
      const teamPath = join(made.dir, 'team.yaml');
      const lobby = resolveLobby(made.home, { entity: 'floor' });
      mkdirSync(lobby, { recursive: true });
      const teamText = readFileSync(teamPath, 'utf8').replace(lobbyDir(made.home), lobby);
      writeFileSync(teamPath, `${teamText}entity: floor\n`);

      const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
      if (settingsPath === null) throw new Error('missing CliHook settings path for lead');
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
      writeFileSync(join(made.sockets, '222.sock'), '');
      const past = new Date(Date.now() - 60_000);
      utimesSync(settingsPath, past, past);

      const corvidId = registerAgent(made.home, {
        name: 'Corvid',
        signing: { model: 'GPT Sol', version: '6', role: 'implementer' },
        lab: 'openai',
        cli: 'codex',
        launcher: null,
        launch: 'codex -m gpt-6-sol',
        reach: { team: 'acme', seat: 'corvid', session: 'acme', pane: 'pane-corvid', address: null },
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
          { agent: corvidId, seat: 'corvid', role: 'implementer', nickname: 'Corvid' },
        ],
      });
      updateState(made.dir, (state) => {
        state.sessions.acme = {
          seats: {
            lead: { stage: 'ready' as const, pane: 'pane-lead' },
            corvid: { stage: 'ready' as const, pane: 'pane-corvid' },
          },
        } as never;
      });

      const loaded = loadTeamFile(made.root, { home: made.home });
      if (!loaded.ok) throw new Error('failed to load the team file');

      const frames: string[] = [];
      const daemonHost: DaemonHost = {
        agents: () => [
          { name: 'lead', pane: 'pane-lead' },
          { name: 'corvid', pane: 'pane-corvid' },
        ],
        processInfo: () => ({ shell: 111, foreground: [222] }),
        socketsDir: made.sockets,
        deliver: async (_socket: string, frame: string) => {
          frames.push(frame);
          return { ok: true };
        },
        native: {
          typeText: () => true,
          pressEnter: () => true,
          status: () => 'idle',
          wait: async () => {},
        },
        now: () => NOW,
        home: made.home,
        deliverWaitMs: 0,
        pollReadyMs: 5,
      };

      const started = await startSendDaemon({
        root: made.root,
        dir: made.dir,
        team: loaded.team,
        host: daemonHost,
      });
      if (started.kind !== 'serving') throw new Error(`daemon failed to start: ${started.kind}`);
      try {
        await requestDaemon(started.handle.socketPath, {
          v: 1,
          op: 'send',
          from: 'corvid',
          to: 'lead',
          body: `from Corvid — admitted by: ${RULE}\n\nSummary headline\nDetails below.`,
          wait: true,
          timeout_s: 1,
        });
      } finally {
        await started.handle.close();
      }

      expect(frames).toHaveLength(1);
      const parsed = JSON.parse(frames[0]!) as { msg_id: string; message: { content: string } };
      const prefix = parsed.msg_id.slice(0, 8);
      expect(parsed.message.content).toBe(
        `Codex seat Corvid (to orchestrator):\n\nSummary headline\nDetails below.\n\n↩ team reply ${prefix} "…" · team ack ${prefix}`,
      );
      // The opening line is the sender alone: the summary never rides in the header.
      expect(parsed.message.content.split('\n')[0]).toBe('Codex seat Corvid (to orchestrator):');
      expect(parsed.message.content).not.toContain('Message from');
      expect(parsed.message.content).not.toContain('[attributed sender:');
    } finally {
      made.cleanup();
    }
  });
});
