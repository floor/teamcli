// Independent coverage for 0.5.13 compact delivery and `team show <id>`.
//
// The two halves are one pair: a seat marked `compact_delivery: true` receives only the sender
// header, the first non-empty content line and a footer naming `team show`, while the signed
// record on disk keeps the whole body and `team show` prints it back in full for the addressee.
// The scene pins the seat setting (per-seat, digest-preserving when false, refused when not a
// boolean), the reader line and frame wording, the live send and daemon paths, and `team show`'s
// own mail scoping and refusals (another seat's record, a tampered record, a short or ambiguous
// prefix, an unknown id, the wrong pane and the launch's general brief).
//
// Synthetic homes, repositories, keys and panes only; nothing here touches a real CLI home.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { CLIENT_RULE } from '../src/client/send.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend } from '../src/commands/send.ts';
import { CONFIG_KEYS } from '../src/config/registry.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../src/launch/general-brief.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { requestDaemon, startSendDaemon, type DaemonHost } from '../src/send/daemon.ts';
import * as frameMod from '../src/send/frame.ts';
import { signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import * as senderMod from '../src/send/sender-claim.ts';
import { updateState } from '../src/state.ts';
import { messageKeyOf, RECEIPT_DOMAIN, verifyDomain } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, testIo, type TestIo } from './helpers.ts';
import { fake, world } from './send-native-fixtures.ts';

const NOW = new Date('2026-11-05T18:00:00.000Z');
const TO_ORCH = "a seat to its own team's orchestrator";
const FROM_ORCH = 'an orchestrator or operator to a seat of its own team';

const cleanupDirs: string[] = [];
const extraCleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of extraCleanups.splice(0)) fn();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The compact line picker, reached through the namespace so a build without it fails the
 *  assertion rather than the whole file at import time. */
function firstContentLineOf(mod: Record<string, unknown>): (text: string) => string {
  const fn = mod['firstContentLine'];
  if (typeof fn !== 'function') throw new Error('sender-claim exports no firstContentLine');
  return fn as (text: string) => string;
}

// ---------------------------------------------------------------------------------------------
// The seat setting: one seat's opt-in, and the approval digest it does or does not change.
// ---------------------------------------------------------------------------------------------

function seatBlock(name: string, role: string, model: string, extra = ''): string {
  return `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: ${model}
    version: "5.5"
    launch: claude
${extra}`;
}

function harborTeamText(captainExtra = '', scoutExtra = ''): string {
  return `format: 1
project: harbor
coordinator: captain
operator: captain
workspace:
  mode: shared
seats:
${seatBlock('captain', 'coordinator', 'Claude Opus', captainExtra)}${seatBlock('scout', 'implementer', 'Claude Sonnet', scoutExtra)}`;
}

describe('the seat setting is per seat and keeps the digest when it changes nothing', () => {
  test('compact_delivery: true changes only that seat; omitted and false keep both seats as they were', () => {
    const base = validateTeamFile(harborTeamText());
    const writtenFalse = validateTeamFile(harborTeamText('', '    compact_delivery: false\n'));
    const scoutCompact = validateTeamFile(harborTeamText('', '    compact_delivery: true\n'));
    const captainCompact = validateTeamFile(harborTeamText('    compact_delivery: true\n', ''));
    for (const loaded of [base, writtenFalse, scoutCompact, captainCompact]) {
      expect(loaded.ok).toBe(true);
    }
    if (!base.ok || !writtenFalse.ok || !scoutCompact.ok || !captainCompact.ok) return;

    expect('compactDelivery' in (base.team.seats[0] as Record<string, unknown>)).toBe(false);
    expect('compactDelivery' in (base.team.seats[1] as Record<string, unknown>)).toBe(false);

    // A written false reads as absent: neither built seat nor digest moves.
    expect('compactDelivery' in (writtenFalse.team.seats[0] as Record<string, unknown>)).toBe(false);
    expect('compactDelivery' in (writtenFalse.team.seats[1] as Record<string, unknown>)).toBe(false);
    expect(fingerprints(writtenFalse.team).seats['captain']).toBe(fingerprints(base.team).seats['captain']);
    expect(fingerprints(writtenFalse.team).seats['scout']).toBe(fingerprints(base.team).seats['scout']);

    // The mark is the marked seat's own: the other seat's digest is untouched.
    expect((scoutCompact.team.seats[1] as Record<string, unknown>).compactDelivery).toBe(true);
    expect('compactDelivery' in (scoutCompact.team.seats[0] as Record<string, unknown>)).toBe(false);
    expect(fingerprints(scoutCompact.team).seats['scout']).not.toBe(fingerprints(base.team).seats['scout']);
    expect(fingerprints(scoutCompact.team).seats['captain']).toBe(fingerprints(base.team).seats['captain']);

    expect((captainCompact.team.seats[0] as Record<string, unknown>).compactDelivery).toBe(true);
    expect(fingerprints(captainCompact.team).seats['captain']).not.toBe(fingerprints(base.team).seats['captain']);
    expect(fingerprints(captainCompact.team).seats['scout']).toBe(fingerprints(base.team).seats['scout']);
  });

  test('a non-boolean is refused with the seat and the field named, and it is not a team config key', () => {
    const bad = validateTeamFile(harborTeamText('', '    compact_delivery: "yes"\n'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const message = bad.errors.map((problem) => problem.message).join('; ');
      expect(message).toContain('compact_delivery must be true or false');
      expect(message).toContain('scout');
    }
    expect((CONFIG_KEYS as readonly string[]).includes('compact_delivery')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The frame: header, first non-empty content line, and the show/reply/ack footer.
// ---------------------------------------------------------------------------------------------

describe('the compact frame is the first content line and the show footer', () => {
  test('the reader line names show, reply and ack with the shortest unique prefix', () => {
    const id = 'ab12cd34-1111-4000-8000-000000000001';
    expect(frameMod.compactReaderLine(id)).toBe(
      '↩ team show ab12cd34 · team reply ab12cd34 · team ack ab12cd34',
    );
    const rival = 'ab12cd34-2222-4000-8000-000000000002';
    expect(frameMod.compactReaderLine(id, [id, rival])).toBe(
      '↩ team show ab12cd34-1 · team reply ab12cd34-1 · team ack ab12cd34-1',
    );
  });

  test('only the first non-empty line survives, and the full rendering is unchanged without the mark', () => {
    const compact = senderMod.attributedBody(
      `from Scout — admitted by: ${TO_ORCH}\n\n\n\nAlpha headline\nBeta detail`,
      'scout',
      { rule: TO_ORCH, cli: 'claude-code', compact: true },
    );
    expect(compact).toBe('from scout (to orchestrator):\n\nAlpha headline');

    const full = senderMod.attributedBody(
      `from Scout — admitted by: ${TO_ORCH}\n\nAlpha headline\nBeta detail`,
      'scout',
      { rule: TO_ORCH, cli: 'claude-code' },
    );
    expect(full).toBe('from scout (to orchestrator):\n\nAlpha headline\nBeta detail');

    const headerless = senderMod.attributedBody('No header line one\nline two', 'scout', {
      rule: TO_ORCH,
      cli: 'claude-code',
      compact: true,
    });
    expect(headerless).toBe('from scout (to orchestrator):\n\nNo header line one');
    expect(firstContentLineOf(senderMod)('\n\n\n')).toBe('');
  });

  test('the socket frame carries the compact block and footer; a person pane still gets no footer', () => {
    const id = 'ab12cd34-1111-4000-8000-000000000001';
    const body = `from Scout — admitted by: ${TO_ORCH}\n\nAlpha headline\nBeta detail`;
    const frame = JSON.parse(
      frameMod.socketMessageFrame('harbor', 'captain', body, id, {
        from: 'scout',
        rule: TO_ORCH,
        cli: 'claude-code',
        compact: true,
      }),
    ) as { msg_id: string; message: { content: string } };
    expect(frame.msg_id).toBe(id);
    expect(frame.message.content).toBe(
      'from scout (to orchestrator):\n\nAlpha headline\n\n↩ team show ab12cd34 · team reply ab12cd34 · team ack ab12cd34',
    );

    const human = JSON.parse(
      frameMod.socketMessageFrame('harbor', 'captain', body, id, {
        from: 'scout',
        rule: TO_ORCH,
        cli: 'claude-code',
        compact: true,
        human: true,
      }),
    ) as { message: { content: string } };
    expect(human.message.content).toBe('from scout (to orchestrator):\n\nAlpha headline');

    const plain = JSON.parse(
      frameMod.socketMessageFrame('harbor', 'captain', body, id, {
        from: 'scout',
        rule: TO_ORCH,
        cli: 'claude-code',
      }),
    ) as { message: { content: string } };
    expect(plain.message.content).toBe(
      'from scout (to orchestrator):\n\nAlpha headline\nBeta detail\n\n↩ team reply ab12cd34 "…" · team ack ab12cd34',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The live send paths: the marked seat's frame is compact, its neighbour's is whole, and the
// signed record on disk always holds the whole body.
// ---------------------------------------------------------------------------------------------

type CompactWorld = {
  made: ReturnType<typeof world>;
  captainId: string;
  scoutId: string;
};

function compactWorld(): CompactWorld {
  const made = world(null, [{ name: 'scout', role: 'implementer', cli: 'claude-code' }]);
  extraCleanups.push(made.cleanup);

  const teamPath = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity: 'floor' });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(teamPath, 'utf8')
    .replace(lobbyDir(made.home), lobby)
    .replace('    name: lead\n', '    name: lead\n    compact_delivery: true\n');
  writeFileSync(teamPath, `${text}entity: floor\n`);

  for (const seat of ['lead', 'scout']) {
    const settingsPath = cliHookSettingsPath(made.dir, 'acme', seat);
    if (settingsPath === null) throw new Error(`fixture has no settings path for ${seat}`);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(settingsPath, past, past);
  }
  writeFileSync(join(made.sockets, '222.sock'), '');

  const captainId = registerAgent(made.home, {
    name: 'Captain',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: 'pane-lead', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
  const scoutId = registerAgent(made.home, {
    name: 'Scout',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(made.root), seat: 'scout', session: 'acme', pane: 'pane-scout', address: null },
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
      { agent: captainId, seat: 'lead', role: 'coordinator', nickname: 'Captain' },
      { agent: scoutId, seat: 'scout', role: 'implementer', nickname: 'Scout' },
    ],
  });
  updateState(made.dir, (state) => {
    state.sessions.acme = {
      seats: {
        lead: { stage: 'ready' as const, pane: 'pane-lead' },
        scout: { stage: 'ready' as const, pane: 'pane-scout' },
      },
    } as never;
  });
  return { made, captainId, scoutId };
}

describe('the send path honours the receiving seat only', () => {
  test('a marked seat gets one content line and the show footer; an unmarked seat gets the whole body', async () => {
    const { made } = compactWorld();
    const frames: string[] = [];
    const host = fake(made, {
      agents: () => [
        { name: 'lead', pane: 'pane-lead' },
        { name: 'scout', pane: 'pane-scout' },
      ],
      deliver: async (_socket: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const multi = 'Only this headline\nSecond detail\nThird detail';
    const fromScout = testIo(made.root, { kind: 'seat', name: 'scout', pane: 'pane-scout', session: 'acme' });
    expect(await runSend(['lead', multi], fromScout, host)).toBe(0);
    expect(frames).toHaveLength(1);
    const leadFrame = JSON.parse(frames[0]!) as { msg_id: string; message: { content: string } };
    const leadPrefix = leadFrame.msg_id.slice(0, 8);
    expect(leadFrame.message.content).toBe(
      `from Scout (to orchestrator):\n\nOnly this headline\n\n↩ team show ${leadPrefix} · team reply ${leadPrefix} · team ack ${leadPrefix}`,
    );
    expect(leadFrame.message.content).not.toContain('Second detail');

    // The signed record the frames were cut from still carries every line.
    const stored = JSON.parse(
      readFileSync(join(made.dir, 'send-drops', 'acme', 'lead', leadFrame.msg_id), 'utf8'),
    ) as { payload: { body: string; rule: string } };
    expect(stored.payload.rule).toBe(TO_ORCH);
    expect(stored.payload.body).toBe(`from Scout — admitted by: ${TO_ORCH}\n\n${multi}`);

    // The neighbouring seat carries no mark: its frame is whole.
    const fromCaptain = testIo(made.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    const replyBody = 'Reply line one\nReply line two';
    expect(await runSend(['scout', replyBody], fromCaptain, host)).toBe(0);
    expect(frames).toHaveLength(2);
    const scoutFrame = JSON.parse(frames[1]!) as { msg_id: string; message: { content: string } };
    const scoutPrefix = scoutFrame.msg_id.slice(0, 8);
    expect(scoutFrame.message.content).toBe(
      `from Captain (team lead):\n\n${replyBody}\n\n↩ team reply ${scoutPrefix} "…" · team ack ${scoutPrefix}`,
    );
  });

  test('the daemon socket send renders the compact frame for a marked seat', async () => {
    const { made } = compactWorld();
    const loaded = loadTeamFileOrThrow(made);
    const frames: string[] = [];
    const daemonHost: DaemonHost = {
      agents: () => [
        { name: 'lead', pane: 'pane-lead' },
        { name: 'scout', pane: 'pane-scout' },
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
      team: loaded,
      host: daemonHost,
    });
    if (started.kind !== 'serving') throw new Error(`the fixture daemon did not start: ${started.kind}`);
    extraCleanups.push(() => {
      void started.handle.close();
    });

    await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'scout',
      to: 'lead',
      rule: TO_ORCH,
      body: `from Scout — admitted by: ${TO_ORCH}\n\nDaemon headline\nDaemon detail`,
      wait: true,
      timeout_s: 1,
    });

    expect(frames).toHaveLength(1);
    const frame = JSON.parse(frames[0]!) as { msg_id: string; message: { content: string } };
    const prefix = frame.msg_id.slice(0, 8);
    // The daemon's compact header names the sender as the team file declares the seat (this
    // fixture's seat carries no label); the frame's subject is the line count, not the casing.
    expect(frame.message.content).toBe(
      `from scout (to orchestrator):\n\nDaemon headline\n\n↩ team show ${prefix} · team reply ${prefix} · team ack ${prefix}`,
    );
    expect(frame.message.content).not.toContain('Daemon detail');
  });
});

function loadTeamFileOrThrow(made: ReturnType<typeof world>) {
  const loaded = loadTeamFile(made.root, { home: made.home });
  if (!loaded.ok) throw new Error(`the fixture team file did not load: ${JSON.stringify(loaded.errors)}`);
  return loaded.team;
}

// ---------------------------------------------------------------------------------------------
// `team show <id>`: the addressee reads the whole record back, and the receipt is the same signed
// read `team messages` and `team ack` write.
// ---------------------------------------------------------------------------------------------

const HARBOR_TEAM = harborTeamText('    compact_delivery: true\n', '');

type Harbor = {
  base: string;
  root: string;
  home: string;
  captainId: string;
  scoutId: string;
  dropDir: string;
};

function harborWorld(): Harbor {
  const base = fixtureBase('.compact-show-independent-');
  cleanupDirs.push(base);
  const root = join(base, 'harbor');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), HARBOR_TEAM);
  messageKeyOf(home);

  const captainId = registerAgent(home, {
    name: 'Captain',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(root), seat: 'captain', session: 'harbor', pane: 'pane-cap', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
  const scoutId = registerAgent(home, {
    name: 'Scout',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(root), seat: 'scout', session: 'harbor', pane: 'pane-scout', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
  upsertTeam(home, teamIdOf(root), {
    project: 'harbor',
    session: 'harbor',
    root,
    lobby: '',
    roster: [
      { agent: captainId, seat: 'captain', role: 'coordinator', nickname: 'Captain' },
      { agent: scoutId, seat: 'scout', role: 'implementer', nickname: 'Scout' },
    ],
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions.harbor = {
      seats: {
        captain: { stage: 'ready' as const, pane: 'pane-cap' },
        scout: { stage: 'ready' as const, pane: 'pane-scout' },
      },
    } as never;
  });
  return { base, root, home, captainId, scoutId, dropDir: recordDir(root, 'harbor', 'captain') };
}

type ShowRunner = (argv: string[], io: TestIo, host: { home: string; now: () => Date }) => Promise<number>;

async function showRunner(): Promise<ShowRunner> {
  const mod = await import('../src/commands/show.ts');
  return mod.runShow as ShowRunner;
}

const captainIo = (at: Harbor): TestIo =>
  testIo(at.root, { kind: 'seat', name: 'captain', pane: 'pane-cap', session: 'harbor' });

describe('team show reads the whole record for its addressee', () => {
  test('the full body comes back by prefix or id, the signed read receipt is written, and a read or replied record still shows', async () => {
    const at = harborWorld();
    const runShow = await showRunner();
    const id = 'd1f0a7c2-1111-4000-8000-000000000001';
    const body = `from Scout — admitted by: ${TO_ORCH}\n\nHarbor line one\nHarbor line two\nHarbor line three`;
    plantRecord(at.home, at.root, 'harbor', 'captain', id, body, {
      from: 'scout',
      from_id: at.scoutId,
      rule: TO_ORCH,
      at: NOW.toISOString(),
    });

    // The first show writes the receipt and prints the whole body even though the captain's seat
    // is marked compact_delivery: show reads the signed record, never the socket frame.
    const expected =
      'from Scout (to orchestrator):\n\nHarbor line one\nHarbor line two\nHarbor line three\n\n↩ team reply d1f0a7c2 "…" · team ack d1f0a7c2';
    const jsonIo = captainIo(at);
    expect(await runShow([id, '--json'], jsonIo, { home: at.home, now: () => NOW })).toBe(0);
    const doc = JSON.parse(jsonIo.out) as Record<string, unknown>;
    expect(doc['schema']).toEqual({ name: 'team.show', version: 1 });
    expect(doc).toMatchObject({
      format: 1,
      id,
      prefix: 'd1f0a7c2',
      project: 'harbor',
      session: 'harbor',
      seat: 'captain',
      from: 'scout',
      from_id: at.scoutId,
      rule: TO_ORCH,
      at: NOW.toISOString(),
      written: true,
      content: expected,
    });

    const receiptPath = join(at.dropDir, `${id}.read.json`);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      payload: { kind: string; status: string; id: string; to: string; session: string };
      signature: string;
    };
    expect(receipt.payload).toMatchObject({
      kind: 'receipt',
      status: 'read',
      id,
      to: 'captain',
      session: 'harbor',
    });
    expect(
      verifyDomain(RECEIPT_DOMAIN, receipt.payload as never, receipt.signature, messageKeyOf(at.home)),
    ).toBe(true);

    // A second show by the shortest prefix prints the same text; the receipt is served, not new.
    const second = captainIo(at);
    expect(await runShow(['d1f0a7c2'], second, { home: at.home, now: () => NOW })).toBe(0);
    expect(second.out).toBe(`${expected}\n`);
    const reShow = captainIo(at);
    expect(await runShow([id, '--json'], reShow, { home: at.home, now: () => NOW })).toBe(0);
    expect((JSON.parse(reShow.out) as Record<string, unknown>)['written']).toBe(false);

    // After `team reply` writes the replied receipt, the record still shows: answering did not
    // make it unreadable to its addressee.
    const replyIo = captainIo(at);
    expect(await runReply(['d1f0a7c2', 'Ack'], replyIo, { home: at.home, now: () => NOW })).toBe(0);
    expect(existsSync(join(at.dropDir, `${id}.replied.json`))).toBe(true);
    const afterReply = captainIo(at);
    expect(await runShow(['d1f0a7c2'], afterReply, { home: at.home, now: () => NOW })).toBe(0);
    expect(afterReply.out).toBe(`${expected}\n`);
  });

  test('a client-origin record in the same mailbox shows its body under the client header', async () => {
    const at = harborWorld();
    const runShow = await showRunner();
    const id = '019a0000-0000-7000-8000-000000000101';
    mkdirSync(at.dropDir, { recursive: true });
    const payload: RecordPayload = {
      kind: 'message',
      id,
      to: 'captain',
      to_id: at.captainId,
      from: 'client:grok-bot',
      from_id: null,
      from_client: { client_id: 'grok-bot', grant_id: 'grant-01' },
      rule: CLIENT_RULE,
      root: at.root,
      session: 'harbor',
      at: NOW.toISOString(),
      body: `from client:grok-bot — admitted by: ${CLIENT_RULE}\n\nClient line one\nClient line two`,
      thread: id,
    };
    writeRecord(at.dropDir, signRecord(payload, at.home));

    const io = captainIo(at);
    expect(await runShow(['019a0000'], io, { home: at.home, now: () => NOW })).toBe(0);
    expect(io.out).toBe(
      'Client Grok Bot (owner relay):\n\nClient line one\nClient line two\n\n↩ team reply 019a0000 "…" · team ack 019a0000\n',
    );
    expect(existsSync(join(at.dropDir, `${id}.read.json`))).toBe(true);
  });
});

describe('team show refuses what is not this caller\'s record', () => {
  test('another seat, a tampered file, a short or ambiguous prefix, an unknown id, the wrong pane and the launch brief', async () => {
    const at = harborWorld();
    const runShow = await showRunner();

    // Two of the captain's own records share the eight-character prefix, so the prefix is
    // ambiguous and the id must be passed whole.
    const id1 = 'd1f0a7c2-1111-4000-8000-000000000001';
    const id2 = 'd1f0a7c2-2222-4000-8000-000000000002';
    plantRecord(at.home, at.root, 'harbor', 'captain', id1, `from Scout — admitted by: ${TO_ORCH}\n\nAlpha line\nmore`, {
      from: 'scout',
      from_id: at.scoutId,
      rule: TO_ORCH,
      at: NOW.toISOString(),
    });
    plantRecord(at.home, at.root, 'harbor', 'captain', id2, `from Scout — admitted by: ${TO_ORCH}\n\nBeta line\nmore`, {
      from: 'scout',
      from_id: at.scoutId,
      rule: TO_ORCH,
      at: NOW.toISOString(),
    });

    const ambiguous = captainIo(at);
    expect(await runShow(['d1f0a7c2'], ambiguous, { home: at.home, now: () => NOW })).toBe(1);
    expect(ambiguous.err).toContain('ambiguous');
    expect(ambiguous.err).toContain(id1);
    expect(ambiguous.err).toContain(id2);
    expect(ambiguous.out).toBe('');

    // Given the whole id, the same show succeeds and its footer widens the prefix.
    const whole = captainIo(at);
    expect(await runShow([id1], whole, { home: at.home, now: () => NOW })).toBe(0);
    expect(whole.out).toBe(
      'from Scout (to orchestrator):\n\nAlpha line\nmore\n\n↩ team reply d1f0a7c2-1 "…" · team ack d1f0a7c2-1\n',
    );

    // A record waiting in another seat's folder is refused without naming its text, and no read
    // receipt is written for it.
    const otherId = '99aa0011-2233-4455-6677-8899aabbccdd';
    plantRecord(at.home, at.root, 'harbor', 'scout', otherId, `from Captain — admitted by: ${FROM_ORCH}\n\nFor Scout only.`, {
      from: 'captain',
      from_id: at.captainId,
      rule: FROM_ORCH,
      at: NOW.toISOString(),
    });
    const crossSeat = captainIo(at);
    expect(await runShow(['99aa0011'], crossSeat, { home: at.home, now: () => NOW })).toBe(1);
    expect(crossSeat.err).toContain('addressed to scout, not to captain');
    expect(crossSeat.out).toBe('');
    expect(crossSeat.err).not.toContain('For Scout only');
    expect(existsSync(join(recordDir(at.root, 'harbor', 'scout'), `${otherId}.read.json`))).toBe(false);

    // A record whose body changed after signing is refused, and neither wording leaks.
    const tamperedId = 'ffff0000-1111-4000-8000-000000000007';
    const tamperedPath = plantRecord(
      at.home,
      at.root,
      'harbor',
      'captain',
      tamperedId,
      `from Scout — admitted by: ${TO_ORCH}\n\nOriginal line`,
      { from: 'scout', from_id: at.scoutId, rule: TO_ORCH, at: NOW.toISOString() },
    );
    writeFileSync(tamperedPath, readFileSync(tamperedPath, 'utf8').replace('Original line', 'Tampered line'));
    const tampered = captainIo(at);
    expect(await runShow([tamperedId], tampered, { home: at.home, now: () => NOW })).toBe(1);
    expect(tampered.err).toContain('does not verify against this message key');
    expect(tampered.out).toBe('');
    expect(tampered.err).not.toContain('Tampered line');
    expect(tampered.err).not.toContain('Original line');
    expect(existsSync(join(at.dropDir, `${tamperedId}.read.json`))).toBe(false);

    // A prefix shorter than eight characters and an id nobody wrote.
    const short = captainIo(at);
    expect(await runShow(['d1f0'], short, { home: at.home, now: () => NOW })).toBe(1);
    expect(short.err).toContain('shorter than 8 characters');
    const unknown = captainIo(at);
    expect(await runShow(['deadbeef'], unknown, { home: at.home, now: () => NOW })).toBe(1);
    expect(unknown.err).toContain('no record named deadbeef waits');

    // A seat caller on another seat's pane is refused as a placement difference.
    const wrongPane = testIo(at.root, { kind: 'seat', name: 'captain', pane: 'pane-scout', session: 'harbor' });
    expect(await runShow([id1], wrongPane, { home: at.home, now: () => NOW })).toBe(1);
    expect(wrongPane.err).toContain('is not this call on its own pane and session');
    expect(wrongPane.out).toBe('');
    expect(wrongPane.err).not.toContain('Alpha line');

    // The launch's general brief is read by the seat's own turn-start reader, never here.
    const briefId = 'bbbb0000-1111-4000-8000-00000000000b';
    plantRecord(
      at.home,
      at.root,
      'harbor',
      'captain',
      briefId,
      `from ${GENERAL_BRIEF_FROM} — admitted by: ${GENERAL_BRIEF_RULE}\n\nThe seat brief.`,
      { from: GENERAL_BRIEF_FROM, rule: GENERAL_BRIEF_RULE, at: NOW.toISOString() },
    );
    const brief = captainIo(at);
    expect(await runShow([briefId], brief, { home: at.home, now: () => NOW })).toBe(1);
    expect(brief.err).toContain('general seat brief');
    expect(brief.out).toBe('');
  });
});
