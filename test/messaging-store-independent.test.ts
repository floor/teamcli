import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend, sendDirect } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { POLICY_CATALOGUE, writePolicySet } from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { carriedRecordOf, readRecord } from '../src/send/record.ts';
import { StoreChainUnreadable, messagingStoreChainOf } from '../src/send/store.ts';
import { MESSAGING_STORE, wordDeclarationsOf, type MessagingStore } from '../src/settings/inherit.ts';
import { resolveWordSetting } from '../src/settings/resolve.ts';
import { cleanupFakeJules, fakeJulesOnPath } from './helpers/fake-jules.ts';
import { withoutSendId } from './helpers/output.ts';
import { NOW, dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  cleanupFakeJules();
});

function acceptSocket(made: World, seat = 'lead'): void {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

function attachEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

type Frame = { msg_id: string; record?: string; message: { content: string } };

describe('independent probe: messaging.store (none, parallel, first, and tightening hierarchy)', () => {
  test('under none, socket carries the verified signed record in the frame, stores nothing on disk, and refuses any tamper', async () => {
    const made = world(['native', 'headless-resume', 'typed', 'socket', 'drop']);
    cleanup = made.cleanup;
    attachEntity(made, 'floor');
    acceptSocket(made, 'lead');

    const drops = dropDir(made.dir, 'lead');
    const frames: string[] = [];
    const host = fake(made, {
      store: 'none',
      deliver: async (_socket: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });
    const io = owner(made.root);

    const code = await runSend(['lead', 'confidential payload'], io, host);
    expect(code).toBe(0);
    expect(withoutSendId(io.out)).toContain('lead: delivered (socket)');
    expect(existsSync(drops)).toBe(false);
    expect(frames).toHaveLength(1);

    const rawFrame = frames[0] as string;
    const parsedFrame = JSON.parse(rawFrame) as Frame;
    expect(typeof parsedFrame.record).toBe('string');

    // Verify carriedRecordOf authenticates the carried record
    const verified = carriedRecordOf(rawFrame, made.home);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.record.payload.id).toBe(parsedFrame.msg_id);
      expect(verified.record.payload.to).toBe('lead');
      expect(verified.record.payload.body).toContain('confidential payload');
    }

    // Non-body-carrying legs (native, headless-resume, typed, drop) were set aside with reasons
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      const failed = history.entries.at(-1)?.failed ?? [];
      expect(failed.some((f) => f.startsWith('native: the store is none'))).toBe(true);
      expect(failed.some((f) => f.startsWith('headless-resume: the store is none'))).toBe(true);
      expect(failed.some((f) => f.startsWith('drop: the store is none'))).toBe(true);
    }

    // Tamper 1: alter body text inside carried record
    const tamperedBodyRecord = (parsedFrame.record as string).replace('confidential payload', 'forged payload');
    const bodyRefusal = carriedRecordOf(JSON.stringify({ ...parsedFrame, record: tamperedBodyRecord }), made.home);
    expect(bodyRefusal).toEqual({
      ok: false,
      reason: "the carried record does not verify with this home's key",
    });

    // Tamper 2: alter signature bytes inside carried record
    const recordObj = JSON.parse(parsedFrame.record as string) as { payload: unknown; signature: string };
    const flippedSig = `${recordObj.signature.slice(0, -4)}ffff`;
    const sigRefusal = carriedRecordOf(
      JSON.stringify({ ...parsedFrame, record: JSON.stringify({ ...recordObj, signature: flippedSig }) }),
      made.home,
    );
    expect(sigRefusal).toEqual({
      ok: false,
      reason: "the carried record does not verify with this home's key",
    });

    // Tamper 3: missing or non-JSON carried record or non-JSON frame
    expect(carriedRecordOf('{bad-frame', made.home)).toEqual({
      ok: false,
      reason: 'the frame is not a JSON frame',
    });
    expect(carriedRecordOf(JSON.stringify({ ...parsedFrame, record: '' }), made.home)).toEqual({
      ok: false,
      reason: 'the frame carries no signed record',
    });
    expect(carriedRecordOf(JSON.stringify({ ...parsedFrame, record: '{not-json' }), made.home)).toEqual({
      ok: false,
      reason: 'the carried record is not JSON text',
    });
  });

  test('under none, session is walked as a body-carrying leg with no stored copy, while orders without socket/session refuse before writing', async () => {
    // Part A: session leg succeeds under store: 'none' and writes nothing to drops
    const madeSession = world(
      ['session', 'typed', 'drop'],
      [{ name: 'jules-worker', role: 'implementer', cli: 'jules', launch: 'jules' }],
    );
    cleanup = madeSession.cleanup;
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/public-repo.git'], {
      cwd: madeSession.root,
      stdio: 'ignore',
    });
    const fakeJules = fakeJulesOnPath({
      status: 0,
      stdout: 'Session created: https://jules.google.com/session/sess-none-99\n',
    });
    expect(fakeJules.firstOnPath()).toBe(fakeJules.binary);

    const privateDir = join(dirname(madeSession.root), 'private');
    mkdirSync(privateDir, { recursive: true });
    const names = join(privateDir, 'names.txt');
    writeFileSync(names, 'Zephyrine Quillfeather\n', { mode: 0o600 });

    const sessionDrops = dropDir(madeSession.dir, 'jules-worker');
    const hostSession = fake(madeSession, {
      store: 'none',
      privateLists: { names, phrases: join(privateDir, 'phrases.txt') },
      repoVisibility: async () => 'public',
    });
    const ioSession = owner(madeSession.root);
    const codeSession = await runSend(['jules-worker', 'task via session under none'], ioSession, hostSession);

    expect(codeSession).toBe(0);
    expect(withoutSendId(ioSession.out)).toContain('jules-worker: delivered (session sess-none-99)');
    expect(existsSync(sessionDrops)).toBe(false);

    const hist = readHistory('acme', madeSession.root, madeSession.home);
    expect(hist.ok).toBe(true);
    if (hist.ok) {
      expect(hist.entries.at(-1)).toMatchObject({
        outcome: 'delivered',
        via: 'session',
        session: 'sess-none-99',
      });
      const failed = hist.entries.at(-1)?.failed ?? [];
      expect(failed.some((f) => f.startsWith('drop: the store is none'))).toBe(true);
    }

    // Part B: order with only non-body-carrying legs (['native', 'drop']) under store: 'none' refuses before writing
    const ioRefused = owner(madeSession.root);
    const codeRefused = await runSend(['lead', 'no body leg for lead'], ioRefused, {
      ...hostSession,
      delivery: { team: ['native', 'drop'] },
    });
    expect(codeRefused).toBe(1);
    expect(ioRefused.err).toContain('messaging.store is none and no route the order names carries the body itself');
    expect(existsSync(dropDir(madeSession.dir, 'lead'))).toBe(false);
  });

  test('parallel requires both transport and record write halves to settle before reporting delivered, while first stages before dialing', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    attachEntity(made, 'floor');
    acceptSocket(made, 'lead');
    const drops = dropDir(made.dir, 'lead');

    // 1. Verify 'first' (default) writes the record to disk BEFORE dialing the socket and omits frame.record
    let filesAtFirstDial: string[] = [];
    const firstFrames: string[] = [];
    const firstHost = fake(made, {
      deliver: async (_socket: string, frame: string) => {
        firstFrames.push(frame);
        filesAtFirstDial = existsSync(drops) ? readdirSync(drops).filter((f) => !f.includes('.')) : [];
        return { ok: true };
      },
    });
    const firstIo = owner(made.root);
    expect(await runSend(['lead', 'first mode message'], firstIo, firstHost)).toBe(0);
    const firstFrame = JSON.parse(firstFrames[0] as string) as Frame;
    expect(filesAtFirstDial).toContain(firstFrame.msg_id);
    expect(firstFrame.record).toBeUndefined();
    expect(readRecord(join(drops, firstFrame.msg_id), firstFrame.msg_id).ok).toBe(true);

    // 2. Verify 'parallel' with both halves succeeding -> delivered, record on disk, no frame.record
    const parallelFrames: string[] = [];
    const parallelOkHost = fake(made, {
      store: 'parallel',
      deliver: async (_socket: string, frame: string) => {
        parallelOkHost;
        parallelFrames.push(frame);
        return { ok: true };
      },
    });
    const parallelOkIo = owner(made.root);
    expect(await runSend(['lead', 'parallel ok message'], parallelOkIo, parallelOkHost)).toBe(0);
    expect(withoutSendId(parallelOkIo.out)).toContain('lead: delivered (socket)');
    const parallelOkFrame = JSON.parse(parallelFrames[0] as string) as Frame;
    expect(parallelOkFrame.record).toBeUndefined();
    expect(readRecord(join(drops, parallelOkFrame.msg_id), parallelOkFrame.msg_id).ok).toBe(true);

    // 3. Verify 'parallel' when socket succeeds but record write fails -> sent (unconfirmed), never delivered
    const collidedId = 'bbbbbbbb-0000-4000-8000-000000000901';
    writeFileSync(join(drops, collidedId), 'corrupt-preexisting-file');
    const parallelFailWriteHost = fake(made, {
      store: 'parallel',
      sendId: () => collidedId,
      deliver: async () => ({ ok: true }),
    });
    const parallelFailIo = owner(made.root);
    expect(await runSend(['lead', 'parallel write collision'], parallelFailIo, parallelFailWriteHost)).toBe(0);
    expect(withoutSendId(parallelFailIo.out)).toContain('lead: sent (unconfirmed) (socket,');
    expect(withoutSendId(parallelFailIo.out)).not.toContain('lead: delivered');

    // 4. Verify sendDirect under 'parallel' when write fails reports unreachable with explicit unrecorded reason
    const collidedDirectId = 'bbbbbbbb-0000-4000-8000-000000000902';
    writeFileSync(join(drops, collidedDirectId), 'corrupt-preexisting-file');
    const directRun = await sendDirect(
      owner(made.root),
      fake(made, {
        store: 'parallel',
        sendId: () => collidedDirectId,
        agents: () => [{ name: 'lead', pane: 'fixture-pane-1' }],
        deliver: async () => ({ ok: true }),
      }),
      { seat: 'lead', pane: 'fixture-pane-1', cli: 'claude-code', body: 'direct parallel collision' },
    );
    expect(directRun.code).toBe(0);
    expect(directRun.result?.outcome).toBe('unreachable');
    expect(directRun.result?.reason).toContain('the frame was taken, but the record was not written');
    expect(directRun.result?.record).toBeNull();
  });

  test('levels may only tighten below entity/project, signed records shadow file words, and unreadable lower levels refuse', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    attachEntity(made, 'floor');
    acceptSocket(made, 'lead');

    // 1. Catalogue and resolver rules: only entity and project can loosen; team and seat can only tighten
    expect(POLICY_CATALOGUE['messaging.store'].looseningLevels).toEqual(['entity', 'project']);
    expect(
      resolveWordSetting(
        MESSAGING_STORE,
        wordDeclarationsOf<MessagingStore>({ team: 'parallel', seat: 'none' }),
      ),
    ).toEqual({
      value: 'first',
      source: null,
      refused: [
        { level: 'team', value: 'parallel' },
        { level: 'seat', value: 'none' },
      ],
    });

    // Progressive tightening across all 4 levels: entity (none) -> project (parallel) -> team (parallel) -> seat (first)
    expect(
      resolveWordSetting(
        MESSAGING_STORE,
        wordDeclarationsOf<MessagingStore>({
          entity: 'none',
          project: 'parallel',
          team: 'none', // refused: attempts to loosen project's parallel
          seat: 'first', // accepted: tightens parallel -> first
        }),
      ),
    ).toEqual({
      value: 'first',
      source: 'seat',
      refused: [{ level: 'team', value: 'none' }],
    });

    // 2. Production chain (messagingStoreChainOf): entity loosens to parallel, seat attempts to loosen to none (refused), then seat tightens to first
    const leadAgent = registerAgent(made.home, {
      name: 'lead',
      signing: { model: 'Claude Opus', version: '4.6', role: 'coordinator' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'registered',
      by: 'test',
    });

    expect(
      writePolicySet(made.home, { level: 'entity', target: 'floor', name: 'messaging.store', value: 'parallel' }, { now: NOW }).ok,
    ).toBe(true);
    expect(
      writePolicySet(made.home, { level: 'seat', target: leadAgent.id, name: 'messaging.store', value: 'none' }, { now: NOW }).ok,
    ).toBe(true);

    const parsedTeam = validateTeamFile(readFileSync(join(made.dir, 'team.yaml'), 'utf8'));
    if (!parsedTeam.ok) throw new Error('failed to validate team.yaml');

    const chainLoosenedRefused = messagingStoreChainOf({
      root: made.root,
      seat: 'lead',
      agentId: leadAgent.id,
      home: made.home,
      file: parsedTeam.team,
      projectOfTeam: () => null,
      now: NOW,
    });
    expect(chainLoosenedRefused.value).toBe('parallel');
    expect(chainLoosenedRefused.source).toBe('entity');
    expect(chainLoosenedRefused.refused).toEqual([{ level: 'seat', value: 'none' }]);

    // Seat now tightens to 'first'
    expect(
      writePolicySet(made.home, { level: 'seat', target: leadAgent.id, name: 'messaging.store', value: 'first' }, { now: NOW }).ok,
    ).toBe(true);
    const chainSeatTightened = messagingStoreChainOf({
      root: made.root,
      seat: 'lead',
      agentId: leadAgent.id,
      home: made.home,
      file: parsedTeam.team,
      projectOfTeam: () => null,
      now: NOW,
    });
    expect(chainSeatTightened.value).toBe('first');
    expect(chainSeatTightened.source).toBe('seat');
    expect(chainSeatTightened.refused).toEqual([]);

    // 3. Unreadable seat policy file throws StoreChainUnreadable
    const seatAgentFile = join(made.home, '.config', 'team', 'agents', `${leadAgent.id}.yaml`);
    writeFileSync(seatAgentFile, 'policies: { corrupt yaml\n');
    expect(() =>
      messagingStoreChainOf({
        root: made.root,
        seat: 'lead',
        agentId: leadAgent.id,
        home: made.home,
        file: parsedTeam.team,
        projectOfTeam: () => null,
        now: NOW,
      }),
    ).toThrow(StoreChainUnreadable);
  });
});
