// The minimal external-client slice, on synthetic homes only: an owner-signed client grant, a
// request signed with the client's own key, one signed drop to the entity orchestrator, a request
// id used once, and an appended revocation read again before the drop is written. No live key,
// grant, pane or team record is touched.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readArgs } from '../src/args.ts';
import type { CheckSources } from '../src/check/team.ts';
import { check } from '../src/commands/check.ts';
import type { SendHost } from '../src/commands/send.ts';
import { runSend } from '../src/commands/send.ts';
import {
  CLIENT_EXPIRY_MAX_MS,
  KEY_ISOLATION_LINE,
  appendClientRevocation,
  clientGrantsFolder,
  clientKeyDir,
  clientKeyPlacementProblem,
  clientRevocations,
  newClientKeyPair,
  publicKeyObject,
  readClientGrant,
  readClientGrantFile,
  writeClientGrant,
  writeClientKeyFiles,
  type ClientGrantRecord,
} from '../src/client/records.ts';
import { claimClientRequest } from '../src/client/replay.ts';
import { resolveClientTarget, runClientSend } from '../src/client/send.ts';
import { insideTeamPane } from '../src/client/pane-guard.ts';
import { runClient } from '../src/commands/client.ts';
import { runClientMessages } from '../src/client/inbox.ts';
import { clientRequestBody, signClientRequest, type ClientRequest } from '../src/client/verify.ts';
import { CLIENT_REQUEST_DOMAIN } from '../src/client/verify.ts';
import type { Caller } from '../src/caller.ts';
import type { Io } from '../src/io.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { emptySession, updateState, type SessionState } from '../src/state.ts';
import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { readHistory, type HistoryEntry } from '../src/send/history.ts';
import { signedRecordOf, verifyRecord } from '../src/send/record.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import type { DeliveryLeg } from '../src/settings/inherit.ts';
import { keyOf, messageKeyState, verifyDomain } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const TEAM_ID = 'aaaaaaaaaaaa';
const OTHER_TEAM_ID = 'bbbbbbbbbbbb';
const CLIENT_ID = 'grok-bot';
const NOW = new Date('2026-10-19T12:00:00.000Z');

type Fixture = {
  base: string;
  home: string;
  teamRoot: string;
  dropDir: string;
  grant: ClientGrantRecord;
  grantPath: string;
  keyPath: string;
  keyDir: string;
  ownerKey: ReturnType<typeof keyOf>;
};

const made: string[] = [];

afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

function fixture(label: string): Fixture {
  const base = realpathSync(mkdtempSync(join(process.cwd(), `.client-${label}-`)));
  made.push(base);
  const home = join(base, 'home');
  const teamRoot = join(base, 'floor');
  const lobby = join(base, 'lobby');
  for (const dir of [home, teamRoot, lobby]) mkdirSync(dir, { recursive: true });
  const ownerKey = keyOf(home);
  const agent = registerAgent(home, {
    name: 'orchestrator',
    signing: { model: 'DeepSeek', version: 'V4.1', role: 'orchestrator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: TEAM_ID, seat: 'orchestrator', session: 'floor', pane: 'w1:p1', address: join(base, 'x.sock') },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  const provenance = 'provenance: { registered_by: test, registered_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" }';
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'team', 'teams.yaml'),
    `teams:
  "${TEAM_ID}":
    project: floor
    project_id: null
    entity: floor
    session: floor
    root: ${teamRoot}
    lobby: ${lobby}
    roster:
      - { agent: ${agent.id}, seat: orchestrator, role: orchestrator, leads: true }
    lifecycle: running
    ${provenance}
  "${OTHER_TEAM_ID}":
    project: teamcli
    project_id: null
    entity: floor
    session: teamcli
    root: ${join(base, 'teamcli')}
    lobby: ${join(base, 'lobby-2')}
    roster:
      - { agent: ${agent.id}, seat: orchestrator, role: orchestrator, leads: true }
    lifecycle: running
    ${provenance}
`,
  );
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), `floor:\n  roots:\n    - ${teamRoot}\n`);
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, CLIENT_ID);
  const keyFiles = writeClientKeyFiles(keyDir, pair);
  if (!keyFiles.ok) throw new Error(keyFiles.why);
  const grant = writeClientGrant(
    home,
    { clientId: CLIENT_ID, entity: 'floor', publicKey: pair.publicKey, keyId: pair.keyId, keyDir },
    { now: NOW, key: ownerKey },
  );
  if (!grant.ok) throw new Error(grant.why);
  return {
    base,
    home,
    teamRoot,
    dropDir: join(teamRoot, '.agents', 'send-drops', 'floor', 'orchestrator'),
    grant: grant.grant,
    grantPath: grant.path,
    keyPath: join(keyDir, 'client.key'),
    keyDir,
    ownerKey,
  };
}

function capture(f: Fixture, options: { tty?: boolean; caller?: Caller } = {}): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    cwd: f.teamRoot,
    env: {},
    stdinIsTTY: options.tty === true,
    ...(options.caller === undefined ? {} : { caller: options.caller }),
  };
  return { io, out: () => out, err: () => err };
}

async function sendClient(
  f: Fixture,
  argv: string[],
  io: Io,
  options: { now?: Date; sendId?: string; clientLockWaitMs?: number } = {},
): Promise<number> {
  const host = {
    home: f.home,
    now: () => options.now ?? NOW,
    sendId: () => options.sendId ?? 'drop-1',
    ...(options.clientLockWaitMs === undefined ? {} : { clientLockWaitMs: options.clientLockWaitMs }),
  } as unknown as SendHost;
  return runClientSend(readArgs(argv, ['file', 'client', 'key', 'request-id'], ['json']), io, host, argv.includes('--json'));
}

function clientArgs(f: Fixture, words: string[] = ['orchestrator@floor', 'hello orchestrator']): string[] {
  return ['--client', f.grantPath, '--key', f.keyPath, ...words];
}

// One team file in its own git checkout, so `team check` reaches its report path with no live
// herdr and no registry: the check's warning field is what this scene reads.
const CHECK_TEAM = `format: 1
project: acme
operator: steward
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: steward
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

function checkWorld(): { root: string } {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.client-check-')));
  made.push(base);
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), CHECK_TEAM);
  return { root };
}

function checkSources(): CheckSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    branch: () => 'main',
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
  } as unknown as CheckSources;
}

describe('client grant and key records', () => {
  test('a grant id is random per issuance and a fresh write never reuses one', () => {
    const f = fixture('ids');
    const second = writeClientGrant(
      f.home,
      { clientId: CLIENT_ID, entity: 'floor', publicKey: f.grant.publicKey, keyId: f.grant.keyId, keyDir: f.keyDir },
      { now: NOW, key: f.ownerKey },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.grant.grantId).not.toBe(f.grant.grantId);
    expect(readClientGrant(f.home, f.grant.grantId).ok).toBe(true);
    expect(readClientGrant(f.home, second.grant.grantId).ok).toBe(true);
  });

  test('expiry defaults to seven days and anything longer, unlimited or past is refused', () => {
    const f = fixture('expiry');
    expect(Date.parse(f.grant.expires!) - Date.parse(f.grant.issued)).toBe(CLIENT_EXPIRY_MAX_MS);
    const base = { clientId: CLIENT_ID, entity: 'floor', publicKey: f.grant.publicKey, keyId: f.grant.keyId, keyDir: f.keyDir };
    const longer = writeClientGrant(f.home, { ...base, expires: new Date(NOW.getTime() + CLIENT_EXPIRY_MAX_MS + 1000).toISOString() }, { now: NOW, key: f.ownerKey });
    expect(longer.ok).toBe(false);
    if (!longer.ok) expect(longer.why).toContain('more than 7 days');
    const past = writeClientGrant(f.home, { ...base, expires: new Date(NOW.getTime() - 1000).toISOString() }, { now: NOW, key: f.ownerKey });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.why).toContain('not in the future');
    const unlimited = writeClientGrant(f.home, { ...base, expires: '9999-01-01T00:00:00.000Z' }, { now: NOW, key: f.ownerKey });
    expect(unlimited.ok).toBe(false);
  });

  test('a key directory inside a team root or outside the client folder is refused', () => {
    const f = fixture('placement');
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toBeNull();
    // The team root here is outside the client folder, so the outside rule answers first; either
    // way the placement is refused and no grant is written.
    expect(clientKeyPlacementProblem(f.home, join(f.teamRoot, 'keys'))).not.toBeNull();
    expect(clientKeyPlacementProblem(f.home, join(f.teamRoot, 'keys'))).toContain('outside');
    expect(clientKeyPlacementProblem(f.home, join(f.base, 'elsewhere'))).toContain('outside');
    const inside = writeClientGrant(
      f.home,
      { clientId: CLIENT_ID, entity: 'floor', publicKey: f.grant.publicKey, keyId: f.grant.keyId, keyDir: join(f.teamRoot, 'keys') },
      { now: NOW, key: f.ownerKey },
    );
    expect(inside.ok).toBe(false);
  });

  test('a key directory inside a recorded seat folder is refused', () => {
    const f = fixture('seat-cwd');
    // The session ran a seat with the client folder itself as its launch folder.
    const seatCwd = dirname(f.keyDir);
    updateState(join(f.teamRoot, '.agents'), (state) => {
      const session = emptySession();
      session.seats.worker = { id: 'seat_0123456789ab', stage: 'ready', start_cwd: seatCwd };
      state.sessions.floor = session;
    });
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('inside the folder seat "worker" ran in');
  });

  test('a key directory inside a recorded worktree is refused', () => {
    const f = fixture('worktree-cwd');
    const worktreePath = dirname(f.keyDir);
    updateState(join(f.teamRoot, '.agents'), (state) => {
      const session = emptySession();
      session.worktrees['feat/x'] = { path: worktreePath, branch: 'feat/x', setup: 'ok' };
      state.sessions.floor = session;
    });
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('recorded worktree');
  });

  test('a recorded state that cannot be read refuses an otherwise allowed key directory', () => {
    const f = fixture('state-corrupt');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(join(f.teamRoot, '.agents', 'team.state.json'), 'not json');
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('cannot be read');
  });

  test('a present but non-path recorded start folder is unknown, not accepted', () => {
    const f = fixture('numeric-cwd');
    updateState(join(f.teamRoot, '.agents'), (state) => {
      // A hand-edited or future record: the field is present, but it is not a path.
      state.sessions.floor = { seats: { worker: { id: 'seat_0123456789ab', stage: 'ready', start_cwd: 42 } }, worktrees: {} } as unknown as SessionState;
    });
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('not an absolute path');
  });

  test('a present but non-path recorded worktree path is unknown, not accepted', () => {
    const f = fixture('numeric-worktree');
    updateState(join(f.teamRoot, '.agents'), (state) => {
      state.sessions.floor = { seats: {}, worktrees: { worker: { path: 42, branch: 'seat/worker', setup: 'ok' } } } as unknown as SessionState;
    });
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('is not a path');
  });

  test('an empty recorded worktree path is unknown, not accepted', () => {
    const f = fixture('empty-worktree');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: {}, worktrees: { worker: { path: '', branch: 'seat/worker', setup: 'ok' } } } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('is not a path');
  });

  test('a legacy relative worktree path leaves an unrelated key directory available', () => {
    const f = fixture('relative-worktree-ok');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: {}, worktrees: { worker: { path: '../worktrees/floor/worker', branch: 'seat/worker', setup: 'ok' } } } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toBeNull();
  });

  test('a legacy relative worktree path that resolves over the key directory refuses', () => {
    const f = fixture('relative-worktree-over');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    // Resolved against the team root this reaches the key directory's folder; against the
    // caller's working folder it would reach an unrelated path, so a refusal here proves the
    // recorded team root is the base.
    const recordedPath = relative(f.teamRoot, dirname(f.keyDir));
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: {}, worktrees: { worker: { path: recordedPath, branch: 'seat/worker', setup: 'ok' } } } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('inside the recorded worktree');
  });

  test('a recorded session of an unknown shape refuses the placement', () => {
    const f = fixture('bad-session');
    updateState(join(f.teamRoot, '.agents'), (state) => {
      state.sessions.floor = 'not a session' as unknown as SessionState;
    });
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('cannot be checked');
  });

  test('an old record that carries neither seats nor worktrees leaves the canonical folder available', () => {
    const f = fixture('old-record');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(join(f.teamRoot, '.agents', 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { floor: {} } })}\n`);
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toBeNull();
  });

  test('a present null seats map refuses instead of reading as an empty one', () => {
    const f = fixture('null-seats');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: null, worktrees: {} } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('cannot be read');
  });

  test('a present null worktrees map refuses instead of reading as an empty one', () => {
    const f = fixture('null-worktrees');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: {}, worktrees: null } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('cannot be read');
  });

  test('a ready seat with no recorded start folder refuses as an unknown placement', () => {
    const f = fixture('ready-no-cwd');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: { worker: { id: 'seat_0123456789ab', stage: 'ready' } }, worktrees: {} } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('carries no start folder');
  });

  test('a named legacy seat with neither pane nor launched identity may carry no start folder', () => {
    const f = fixture('inactive-named-legacy');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: { worker: { id: 'seat_0123456789ab', stage: 'named' } }, worktrees: {} } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toBeNull();
  });

  test('a launched seat with no recorded start folder refuses as an unknown placement', () => {
    const f = fixture('launched-no-cwd');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(
      join(f.teamRoot, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { floor: { seats: { worker: { id: 'seat_0123456789ab', stage: 'launched' } }, worktrees: {} } } })}\n`,
    );
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('carries no start folder');
  });

  test('a named seat carrying runtime activity evidence refuses when its start folder is absent', () => {
    const cases = [
      { label: 'pane', pane: '%7' },
      { label: 'launched-identity', launched: { shell: 1234, foreground: [4321] } },
      { label: 'workspace', workspace: 'w1' },
      { label: 'agent-session', agent_session: 'ses_1' },
    ];
    for (const evidence of cases) {
      const f = fixture(`named-active-${evidence.label}`);
      mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
      const seat = { id: 'seat_0123456789ab', stage: 'named', ...evidence };
      delete (seat as { label?: string }).label;
      writeFileSync(
        join(f.teamRoot, '.agents', 'team.state.json'),
        `${JSON.stringify({ format: 1, sessions: { floor: { seats: { worker: seat }, worktrees: {} } } })}\n`,
      );
      expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('carries no start folder');
    }
  });

  test('a present team file that does not validate refuses the placement', () => {
    const f = fixture('invalid-team');
    mkdirSync(join(f.teamRoot, '.agents'), { recursive: true });
    writeFileSync(join(f.teamRoot, '.agents', 'team.yaml'), 'not a team file\n');
    expect(clientKeyPlacementProblem(f.home, f.keyDir)).toContain('cannot be checked');
  });

  test('issuance admits only the grok-bot principal and the floor entity', () => {
    const f = fixture('slice');
    const base = { publicKey: f.grant.publicKey, keyId: f.grant.keyId, keyDir: f.keyDir };
    const otherClient = writeClientGrant(f.home, { ...base, clientId: 'other-bot', entity: 'floor' }, { now: NOW, key: f.ownerKey });
    expect(otherClient.ok).toBe(false);
    if (!otherClient.ok) expect(otherClient.why).toContain('declares no client "other-bot"');
    const otherEntity = writeClientGrant(f.home, { ...base, clientId: CLIENT_ID, entity: 'teamcli' }, { now: NOW, key: f.ownerKey });
    expect(otherEntity.ok).toBe(false);
    if (!otherEntity.ok) expect(otherEntity.why).toContain('entity "teamcli" declares no client "grok-bot"');
  });

  test('the signed coordinator binding cannot be edited on the stored file', () => {
    const f = fixture('binding');
    expect(f.grant.teamId).toBe(TEAM_ID);
    expect(f.grant.recipientId.startsWith('agt_')).toBe(true);
    const record = JSON.parse(readFileSync(f.grantPath, 'utf8')) as { client_grant: Record<string, unknown>; signature: string };
    record.client_grant.team_id = OTHER_TEAM_ID;
    const copy = join(f.base, 'binding-copy.json');
    writeFileSync(copy, JSON.stringify(record));
    expect(readClientGrantFile(f.home, copy).ok).toBe(false);
    const recipient = JSON.parse(readFileSync(f.grantPath, 'utf8')) as { client_grant: Record<string, unknown>; signature: string };
    recipient.client_grant.recipient_id = 'agt_111111111111';
    const recipientCopy = join(f.base, 'binding-recipient-copy.json');
    writeFileSync(recipientCopy, JSON.stringify(recipient));
    expect(readClientGrantFile(f.home, recipientCopy).ok).toBe(false);
  });
});

describe('client send', () => {
  test('a delivery walk that throws is logged in the receiving team log and warned on stderr, not swallowed', async () => {
    const f = fixture('walk-throws');
    const io = capture(f);
    const host = { home: f.home, now: () => NOW, sendId: () => 'drop-1' } as unknown as SendHost;
    const deliver = async (): Promise<void> => {
      throw new Error('boom in the walk');
    };
    const code = await runClientSend(readArgs(clientArgs(f), ['file', 'client', 'key', 'request-id'], ['json']), io.io, host, false, deliver);
    expect(code).toBe(0);
    expect(io.out()).toBe('sent: orchestrator@floor (drop drop-1)\n');
    expect(io.err()).toContain(`${KEY_ISOLATION_LINE}\n`);
    expect(io.err()).toContain('team send: warning: the drop was written but its delivery walk failed (boom in the walk)');
    expect(existsSync(join(f.dropDir, 'drop-1'))).toBe(true);
    const log = readFileSync(join(f.teamRoot, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('client delivery walk failed for drop drop-1 (boom in the walk)');
  });

  test('a delivery walk that returns logs its ending in the receiving team log', async () => {
    const f = fixture('walk-ends');
    const io = capture(f);
    const host = { home: f.home, now: () => NOW, sendId: () => 'drop-1' } as unknown as SendHost;
    const code = await runClientSend(readArgs(clientArgs(f), ['file', 'client', 'key', 'request-id'], ['json']), io.io, host, false, async () => {});
    expect(code).toBe(0);
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    const log = readFileSync(join(f.teamRoot, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('client delivery walk ended for drop drop-1');
  });

  test('writes one signed drop as the client, prints the declared limitation, and never reads a caller', async () => {
    const f = fixture('happy');
    const io = capture(f, { tty: true, caller: { kind: 'owner' } as Caller });
    const code = await sendClient(f, clientArgs(f), io.io, { sendId: 'drop-1' });
    expect(code).toBe(0);
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    expect(io.out()).toBe('sent: orchestrator@floor (drop drop-1)\n');
    const path = join(f.dropDir, 'drop-1');
    expect(existsSync(path)).toBe(true);
    const parsed = signedRecordOf(JSON.parse(readFileSync(path, 'utf8')));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.payload.from).toBe(`client:${CLIENT_ID}`);
    expect(parsed.payload.from_id).toBeNull();
    expect(parsed.payload.from_client).toEqual({ client_id: CLIENT_ID, grant_id: f.grant.grantId });
    expect(parsed.payload.to).toBe('orchestrator');
    expect(parsed.payload.to_id).not.toBeNull();
    const messageKey = messageKeyState(f.home);
    expect(messageKey.kind).toBe('key');
    if (messageKey.kind === 'key') expect(verifyRecord(parsed, messageKey.key)).toBe(true);
  });

  test('refuses a request id used twice and writes no second drop', async () => {
    const f = fixture('replay');
    const args = [...clientArgs(f), '--request-id', 'rq_once'];
    const first = capture(f);
    expect(await sendClient(f, args, first.io, { sendId: 'drop-1' })).toBe(0);
    const second = capture(f);
    expect(await sendClient(f, args, second.io, { sendId: 'drop-2' })).toBe(1);
    expect(second.err()).toContain('was already used for client "grok-bot"');
    expect(second.out()).toBe('');
    expect(readdirSync(f.dropDir).sort()).toEqual(['drop-1']);
  });

  test('a revocation appended before the send refuses it, and the drop folder stays empty', async () => {
    const f = fixture('revoked');
    const appended = appendClientRevocation(f.home, f.grant.grantId, { now: NOW, key: f.ownerKey });
    expect(appended.ok).toBe(true);
    const read = clientRevocations(f.home, f.grant.grantId);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.records).toHaveLength(1);
    const io = capture(f);
    expect(await sendClient(f, clientArgs(f), io.io)).toBe(1);
    expect(io.err()).toContain(`the grant ${f.grant.grantId} was revoked at ${NOW.toISOString()}`);
    expect(existsSync(f.dropDir)).toBe(false);
  });

  test('damage in the reserved revocation namespace refuses the send, never reads as unrevoked', async () => {
    const f = fixture('revocation-damage');
    // A file inside the reserved `revoke-cg_` namespace that is not a verified owner-signed
    // revocation: malformed JSON must fail the whole read closed.
    writeFileSync(join(clientGrantsFolder(f.home), `revoke-${f.grant.grantId}-0123456789abcdef.json`), 'not json');
    const read = clientRevocations(f.home, f.grant.grantId);
    expect(read.ok).toBe(false);
    const io = capture(f);
    expect(await sendClient(f, clientArgs(f), io.io)).toBe(1);
    expect(io.err()).toContain('is not whole JSON');
    expect(existsSync(f.dropDir)).toBe(false);
  });

  test('a key that is not the grant\'s is refused', async () => {
    const f = fixture('wrong-key');
    const otherPair = newClientKeyPair();
    const otherDir = clientKeyDir(f.home, 'other-bot');
    const written = writeClientKeyFiles(otherDir, otherPair);
    expect(written.ok).toBe(true);
    const io = capture(f);
    const args = ['--client', f.grantPath, '--key', join(otherDir, 'client.key'), 'orchestrator@floor', 'hello'];
    expect(await sendClient(f, args, io.io)).toBe(1);
    expect(io.err()).toContain('is not the app key the grant');
  });

  test('any destination but orchestrator@<entity> is refused', async () => {
    const f = fixture('destination');
    const seat = capture(f);
    expect(await sendClient(f, clientArgs(f, ['builder-4@floor', 'hello']), seat.io)).toBe(1);
    expect(seat.err()).toContain('addresses only orchestrator@floor');
    const entity = capture(f);
    expect(await sendClient(f, clientArgs(f, ['orchestrator@elsewhere', 'hello']), entity.io)).toBe(1);
    expect(entity.err()).toContain('addresses only orchestrator@floor');
  });

  test('a grant file whose bytes were edited is refused, so a copy cannot widen the role', async () => {
    const f = fixture('tampered');
    const record = JSON.parse(readFileSync(f.grantPath, 'utf8')) as { client_grant: Record<string, unknown>; signature: string };
    record.client_grant.allowed_roles = ['owner'];
    const copy = join(f.base, 'copy.json');
    writeFileSync(copy, JSON.stringify(record));
    const io = capture(f);
    expect(await sendClient(f, ['--client', copy, '--key', f.keyPath, 'orchestrator@floor', 'hello'], io.io)).toBe(1);
    expect(io.err()).toContain('not a verified owner-signed client grant');
  });

  test('a grant past its expiry refuses the send', async () => {
    const f = fixture('expired');
    const io = capture(f);
    const later = new Date(Date.parse(f.grant.expires!) + 1000);
    expect(await sendClient(f, clientArgs(f), io.io, { now: later })).toBe(1);
    expect(io.err()).toContain('expired at');
  });

  test('the target resolver picks the coordinator team, not another team of the same entity', () => {
    const f = fixture('target');
    const resolved = resolveClientTarget(f.home, 'orchestrator@floor', f.grant);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.teamId).toBe(TEAM_ID);
    expect(resolved.target.recipientSeat).toBe('orchestrator');
    expect(resolved.target.recipientId.startsWith('agt_')).toBe(true);
    expect(resolved.target.dropDir).toBe(f.dropDir);
  });

  test('the coordinator agent reaches the team by its registry id, never by a project or session label', () => {
    const f = fixture('reach-label');
    // The team's project and session are both "floor"; the agent record used to pass with either.
    updateAgent(f.home, f.grant.recipientId, { reach: { team: 'floor' } });
    const resolved = resolveClientTarget(f.home, 'orchestrator@floor', f.grant);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.why).toContain(`not recorded on team "${TEAM_ID}"`);
  });

  test('a --team grant addresses <seat>@<team>: orchestrator@teamcli is admitted, orchestrator@floor refused', async () => {
    const f = fixture('team');
    const teamcliRoot = join(f.base, 'teamcli');
    mkdirSync(teamcliRoot, { recursive: true });
    const agamemnon = registerAgent(f.home, {
      name: 'orchestrator',
      signing: { model: 'M', version: '1', role: 'orchestrator' },
      lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
      reach: { team: OTHER_TEAM_ID, seat: 'orchestrator', session: 'teamcli', pane: 'w2:p1', address: join(f.base, 'y.sock') },
      mcp: [], skills: [], lifecycle: 'running', by: 'test',
    });
    const teams = join(f.home, '.config', 'team', 'teams.yaml');
    const text = readFileSync(teams, 'utf8');
    const at = text.indexOf(`"${OTHER_TEAM_ID}":`);
    writeFileSync(teams, text.slice(0, at) + text.slice(at).replace(`agent: ${f.grant.recipientId}`, `agent: ${agamemnon.id}`));
    writeFileSync(join(f.home, '.config', 'team', 'entities.yaml'), `floor:\n  roots:\n    - ${f.teamRoot}\n    - ${teamcliRoot}\n`);
    const pair = newClientKeyPair();
    const keyDir = join(clientKeyDir(f.home, CLIENT_ID), '..', 'grok-bot-teamcli');
    const keys = writeClientKeyFiles(keyDir, pair);
    if (!keys.ok) throw new Error(keys.why);
    const issued = writeClientGrant(
      f.home,
      { clientId: CLIENT_ID, entity: 'floor', team: 'teamcli', publicKey: pair.publicKey, keyId: pair.keyId, keyDir },
      { now: NOW, key: f.ownerKey },
    );
    if (!issued.ok) throw new Error(issued.why);
    expect(issued.grant.team).toBe('teamcli');
    expect(issued.grant.teamId).toBe(OTHER_TEAM_ID);
    expect(issued.grant.recipientId).toBe(agamemnon.id);
    expect(JSON.parse(readFileSync(issued.path, 'utf8')).client_grant.team).toBe('teamcli');
    const ok = resolveClientTarget(f.home, 'orchestrator@teamcli', issued.grant);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.target.recipientId).toBe(agamemnon.id);
    const floor = resolveClientTarget(f.home, 'orchestrator@floor', issued.grant);
    expect(floor.ok).toBe(false);
    if (!floor.ok) expect(floor.why).toContain('addresses only orchestrator@teamcli');
    const io = capture(f);
    const words = ['--client', issued.path, '--key', join(keyDir, 'client.key'), 'orchestrator@teamcli', 'hello'];
    expect(await sendClient(f, words, io.io, { sendId: 'drop-t' })).toBe(0);
    expect(io.out()).toContain('sent: orchestrator@teamcli (drop drop-t)');
    expect(existsSync(join(teamcliRoot, '.agents', 'send-drops', 'teamcli', 'orchestrator', 'drop-t'))).toBe(true);
    const refused = capture(f);
    expect(await sendClient(f, [...words.slice(0, 4), 'orchestrator@floor', 'hello'], refused.io, { sendId: 'drop-u' })).toBe(1);
    // The legacy grant, with no team field, still reaches the floor orchestrator.
    expect(JSON.parse(readFileSync(f.grantPath, 'utf8')).client_grant.team).toBeUndefined();
    const legacy = resolveClientTarget(f.home, 'orchestrator@floor', f.grant);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.target.teamId).toBe(TEAM_ID);
    expect(resolveClientTarget(f.home, 'orchestrator@teamcli', f.grant).ok).toBe(false);
  });

  test('a stored team field equal to the entity, or edited onto a legacy grant, does not verify', () => {
    const f = fixture('team-tamper');
    for (const team of ['floor', 'teamcli']) {
      const record = JSON.parse(readFileSync(f.grantPath, 'utf8')) as { client_grant: Record<string, unknown>; signature: string };
      record.client_grant.team = team;
      const copy = join(f.base, `team-${team}.json`);
      writeFileSync(copy, JSON.stringify(record));
      expect(readClientGrantFile(f.home, copy).ok).toBe(false);
    }
  });

  test('an owner caller on a TTY still writes the client drop, never an owner send', async () => {
    const f = fixture('never-owner');
    const io = capture(f, { tty: true, caller: { kind: 'owner' } as Caller });
    expect(await sendClient(f, clientArgs(f), io.io, { sendId: 'drop-client' })).toBe(0);
    const parsed = signedRecordOf(JSON.parse(readFileSync(join(f.dropDir, 'drop-client'), 'utf8')));
    expect(parsed?.payload.from).toBe(`client:${CLIENT_ID}`);
  });

  test('a request signature over changed bytes does not verify', () => {
    const f = fixture('request-bytes');
    const request: ClientRequest = {
      v: 1,
      grant_id: f.grant.grantId,
      client_id: CLIENT_ID,
      key_id: f.grant.keyId,
      op: 'send',
      entity: 'floor',
      recipient_id: 'agt_111111111111',
      recipient_seat: 'orchestrator',
      body_sha256: createHash('sha256').update('one body').digest('hex'),
      request_id: 'rq_1',
      issued_at: NOW.toISOString(),
      challenge: null,
    };
    const stored = JSON.parse(readFileSync(f.keyPath, 'utf8')) as { private: string };
    const signature = signClientRequest(request, stored.private);
    const publicKey = publicKeyObject(f.grant.publicKey);
    expect(publicKey).not.toBeNull();
    if (publicKey === null) return;
    expect(verifyDomain(CLIENT_REQUEST_DOMAIN, clientRequestBody(request), signature, publicKey)).toBe(true);
    const changed: ClientRequest = { ...request, body_sha256: createHash('sha256').update('another body').digest('hex') };
    expect(verifyDomain(CLIENT_REQUEST_DOMAIN, clientRequestBody(changed), signature, publicKey)).toBe(false);
    const otherRecipient: ClientRequest = { ...request, recipient_seat: 'builder-4' };
    expect(verifyDomain(CLIENT_REQUEST_DOMAIN, clientRequestBody(otherRecipient), signature, publicKey)).toBe(false);
  });

  test('a valid grant file detached from the canonical store is refused', async () => {
    const f = fixture('detached');
    const detached = join(f.base, 'detached-grant.json');
    renameSync(f.grantPath, detached);
    const io = capture(f);
    expect(await sendClient(f, ['--client', detached, '--key', f.keyPath, 'orchestrator@floor', 'hello'], io.io)).toBe(1);
    expect(io.err()).toContain('cannot be read');
    expect(existsSync(f.dropDir)).toBe(false);
  });

  test('a held grant lock refuses busy and is never stolen by age or by a dead-looking body', async () => {
    const f = fixture('lock');
    const lockPath = join(clientGrantsFolder(f.home), '.client.lock');
    const held = `${JSON.stringify({ pid: 999999, token: 'held-by-tests', at: '2000-01-01T00:00:00.000Z' })}\n`;
    writeFileSync(lockPath, held);
    const io = capture(f);
    const code = await sendClient(f, clientArgs(f), io.io, { clientLockWaitMs: 1 });
    expect(code).toBe(1);
    expect(io.err()).toContain('another command holds the client grant lock');
    expect(io.err()).toContain('the owner must remove that file');
    // The lock is not reclaimed: same file, same bytes, no drop written.
    expect(readFileSync(lockPath, 'utf8')).toBe(held);
    expect(existsSync(f.dropDir)).toBe(false);
  });

  test('JSON send keeps valid stdout and still prints the declared limitation on stderr', async () => {
    const f = fixture('json-send');
    const io = capture(f);
    const code = await sendClient(f, [...clientArgs(f), '--json'], io.io, { sendId: 'drop-json' });
    expect(code).toBe(0);
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    const doc = JSON.parse(io.out()) as { sent: { to: string; record: string; request_id: string } };
    expect(doc.sent.to).toBe('orchestrator@floor');
    expect(doc.sent.record).toBe('drop-json');
    expect(doc.sent.request_id.startsWith('rq_')).toBe(true);
  });

  test('the claim file refuses a second claim, including a partial one', () => {
    const f = fixture('claim');
    expect(claimClientRequest(f.teamRoot, CLIENT_ID, 'rq_claim', NOW).ok).toBe(true);
    const second = claimClientRequest(f.teamRoot, CLIENT_ID, 'rq_claim', NOW);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.why).toContain('used once');
  });
});

describe('the declared limitation is printed on both paths', () => {
  test('a parser refusal on a client invocation still prints it first', async () => {
    const f = fixture('usage');
    const io = capture(f);
    const host = { home: f.home, now: () => NOW } as unknown as SendHost;
    const code = await runSend(['--client'], io.io, host);
    expect(code).toBe(2);
    expect(io.err().split('\n')[0]).toBe(KEY_ISOLATION_LINE);
  });

  test('a parser refusal in JSON keeps the error document valid and carries the line', async () => {
    const f = fixture('usage-json');
    const io = capture(f);
    const host = { home: f.home, now: () => NOW } as unknown as SendHost;
    const code = await runSend(['--client', '--json', '--nope'], io.io, host);
    expect(code).toBe(2);
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    const doc = JSON.parse(io.out()) as { error?: { id?: string }; key_isolation?: string };
    expect(doc.error?.id).toBe('send.usage');
    expect(doc.key_isolation).toBe(KEY_ISOLATION_LINE);
  });

  test('team check prints it as text on stdout and carries key_isolation in the JSON report', async () => {
    const world = checkWorld();
    const text = testIo(world.root, { kind: 'owner' });
    await check([], text, undefined, checkSources());
    expect(text.out.split('\n')[0]).toStartWith('team ');
    expect(text.out.split('\n')[1]).toBe(KEY_ISOLATION_LINE);
    expect(text.err).toBe('');
    const machine = testIo(world.root, { kind: 'owner' });
    const code = await check(['--json'], machine, undefined, checkSources());
    expect(Number.isInteger(code)).toBe(true);
    expect(machine.err).toBe('');
    const doc = JSON.parse(machine.out) as { key_isolation?: string; format?: number };
    expect(doc.format).toBe(1);
    expect(doc.key_isolation).toBe(KEY_ISOLATION_LINE);
  });
});

describe('the client pane guard', () => {
  const seat: Caller = { kind: 'seat', name: 'orchestrator', pane: 'w1:p1' };
  const pane: Caller = { kind: 'pane', pane: 'w1:p2' };
  const underHerdr: Caller = { kind: 'unplaced', reason: 'it runs under herdr' };

  test('places only callers inside a herdr pane as inside a team pane', () => {
    expect(insideTeamPane(seat)).toBe(true);
    expect(insideTeamPane(pane)).toBe(true);
    expect(insideTeamPane(underHerdr)).toBe(true);
    expect(insideTeamPane({ kind: 'owner' })).toBe(false);
    expect(insideTeamPane({ kind: 'owner-no-tty' })).toBe(false);
    expect(insideTeamPane({ kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' })).toBe(false);
  });

  for (const caller of [seat, pane, underHerdr]) {
    test(`send refuses a ${caller.kind} caller before any drop, exit 1`, async () => {
      const f = fixture('pane-send');
      const io = capture(f, { caller });
      const code = await sendClient(f, clientArgs(f), io.io);
      expect(code).toBe(1);
      expect(io.err()).toContain('team send: refused: a client key is not used from inside a team pane');
      expect(io.err().split('\n')[0]).toBe(KEY_ISOLATION_LINE);
      expect(existsSync(f.dropDir) ? readdirSync(f.dropDir) : []).toEqual([]);
    });
  }

  test('send --json names the refusal send.client-pane', async () => {
    const f = fixture('pane-json');
    const io = capture(f, { caller: seat });
    const code = await sendClient(f, [...clientArgs(f), '--json'], io.io);
    expect(code).toBe(1);
    const doc = JSON.parse(io.out()) as { error: { code: string }; key_isolation: string };
    expect(doc.error.code).toBe('send.client-pane');
    expect(doc.key_isolation).toBe(KEY_ISOLATION_LINE);
  });

  test('a usage error inside a pane stays a usage error, exit 2', async () => {
    const f = fixture('pane-usage');
    const io = capture(f, { caller: seat });
    expect(await sendClient(f, ['--client', f.grantPath], io.io)).toBe(2);
  });

  test('messages refuses a seat caller with messages.client-pane', () => {
    const f = fixture('pane-messages');
    const io = capture(f, { caller: seat });
    const code = runClientMessages(
      readArgs(['--client', f.grantPath, '--key', f.keyPath, '--json'], ['client', 'key', 'since', 'ack', 'limit', 'request-id'], ['json']),
      io.io,
      { home: f.home, now: () => NOW },
      true,
    );
    expect(code).toBe(1);
    expect((JSON.parse(io.out()) as { error: { code: string } }).error.code).toBe('messages.client-pane');
  });

  test('the client outside herdr is not refused by the guard', async () => {
    const f = fixture('pane-owner');
    const io = capture(f, { caller: { kind: 'owner-no-tty' } });
    const code = await sendClient(f, clientArgs(f), io.io);
    expect(io.err()).not.toContain('inside a team pane');
    expect(code).toBe(0);
  });
});

describe('the client pane guard on keygen', () => {
  test('keygen inside a team pane is refused and writes nothing', () => {
    const base = realpathSync(mkdtempSync(join(process.cwd(), '.client-keygen-pane-')));
    made.push(base);
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const out = join(home, '.config', 'team-client', 'grok-bot');
    let err = '';
    const io: Io = { stdout: () => {}, stderr: (t) => { err += t; }, cwd: base, env: {}, stdinIsTTY: false, caller: { kind: 'seat', name: 'orchestrator', pane: 'w1:p1' } };
    expect(runClient(['keygen', '--out', out], io, home)).toBe(1);
    expect(err).toContain('team client keygen: refused: a client key is not used from inside a team pane');
    expect(existsSync(out)).toBe(false);
  });

  test('keygen by an external agent outside herdr is not refused by the guard', () => {
    const base = realpathSync(mkdtempSync(join(process.cwd(), '.client-keygen-ext-')));
    made.push(base);
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const out = join(home, '.config', 'team-client', 'grok-bot');
    const io: Io = { stdout: () => {}, stderr: () => {}, cwd: base, env: {}, stdinIsTTY: false, caller: { kind: 'unplaced', reason: 'it is run by an agent (cursor-agent) outside herdr' } };
    expect(runClient(['keygen', '--out', out], io, home)).toBe(0);
    expect(existsSync(join(out, 'client.key'))).toBe(true);
  });
});

// The client send's walk, against the public `runSend`/`SendHost` seam: the same signed drop the
// grant wrote, carried through the coordinator seat's resolved order — its own inbox channel, the
// cross-session socket, then the typed trigger — with every leg keeping its ordinary pane-safety
// checks. The grant, the registry binding and the drop folder are the client fixture's; only the
// receiving team's file, its seat's declaration and the fake host are added here.

const WALK_RULE = '─'.repeat(30);

/** The one trigger the typed leg types for this record: the receiver's own read, named by the
 *  signed sender. `from` is the client principal the record carries, not a seat. */
const WAKE_LINE = 'Message from client:grok-bot (client:grok-bot@… Read it with: team drops --read.';

type WalkWorld = Fixture & { dir: string; sockets: string };

/** The receiving team the grant's coordinator resolves to: one Claude Code seat, no declared
 *  delivery order, so the client default (channel, socket when declared, typed) is what runs. */
function walkFixture(label: string): WalkWorld {
  const f = fixture(label);
  const dir = join(f.teamRoot, '.agents');
  const sockets = join(f.base, 'sockets');
  // The lobby an entity's team starts in, which its trust list must name. The team names the
  // same entity the grant's coordinator resolves to, so an owner-origin frame has its default
  // reply target (`orchestrator@floor`) and no declaration is needed.
  const lobby = resolveLobby(f.home, { entity: 'floor' });
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  // The receiving team is its own checkout: the team file is found from the team root, never
  // from the worktree this test file runs in.
  execFileSync('git', ['init', '-q'], { cwd: f.teamRoot, stdio: 'ignore' });
  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: floor
entity: floor
coordinator: orchestrator
operator: orchestrator
session: floor
workspace:
  mode: shared
trust:
  - ${f.teamRoot}
  - ${lobby}
seats:
  - role: orchestrator
    name: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
`,
  );
  return { ...f, dir, sockets };
}

/** A live inbox server's marker beside the seat's drop folder: this process's pid, and the
 *  fixture's own seat, session and root. */
function liveInboxIn(w: WalkWorld): void {
  mkdirSync(w.dropDir, { recursive: true });
  writeFileSync(
    join(w.dropDir, '.inbox-listener'),
    `${JSON.stringify({
      v: 1,
      seat: 'orchestrator',
      session: 'floor',
      root: w.teamRoot,
      cli: 'claude-code',
      pid: process.pid,
      ts: NOW.toISOString(),
    })}\n`,
  );
}

/** The receiving session's own declaration that it accepts cross-session frames, and the socket
 *  its pane exposes. The declaration's file predates the socket, so the session was started after
 *  the declaration took effect and the socket leg is live. */
function acceptInbound(w: WalkWorld): void {
  const path = cliHookSettingsPath(w.dir, 'floor', 'orchestrator');
  if (path === null) throw new Error('the fixture seat declares no settings path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
  writeFileSync(join(w.sockets, '222.sock'), '');
}

type WalkHost = SendHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
  frames: string[];
  dials: () => number;
};

/** The host every scene is handed: one idle Claude pane, a socket the pane's second pid owns, and
 *  a dial that records the frame and answers `ok` unless the scene refuses it. The pane reads back
 *  the trigger it was typed before Enter, the idle box after it — the shape the proof gate reads. */
function walkHost(
  w: WalkWorld,
  options: {
    delivery?: Partial<Record<'seat' | 'team', readonly DeliveryLeg[]>>;
    dial?: (socketPath: string, frame: string) => Promise<SendOutcome>;
    onDial?: () => void;
  } = {},
): WalkHost {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  const statusByPane: Record<string, string> = { 'pane-orchestrator': 'idle' };
  let dials = 0;
  return {
    typed,
    enters,
    frames,
    dials: () => dials,
    delivery: options.delivery,
    agents: () => [{ name: 'orchestrator', pane: 'pane-orchestrator' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async (socketPath: string, frame: string): Promise<SendOutcome> => {
      dials += 1;
      frames.push(frame);
      options.onDial?.();
      if (options.dial !== undefined) return options.dial(socketPath, frame);
      return { ok: true };
    },
    native: {
      typeText: (_session: string, pane: string, text: string) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session: string, pane: string) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session: string, pane: string) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session: string, pane: string) => {
        const last = [...typed].reverse().find((one) => one.pane === pane);
        if (last && !enters.includes(pane)) return `${WALK_RULE}\n❯ ${last.text}\n${WALK_RULE}`;
        return `${WALK_RULE}\n❯ \n${WALK_RULE}`;
      },
    },
    now: () => NOW,
    home: w.home,
    sendId: () => 'drop-1',
    inboxGraceMs: 0,
    deliverWaitMs: 50,
    pollReadyMs: 5,
  } as unknown as WalkHost;
}

/** The receiving team's history, oldest first. */
function walkHistory(w: WalkWorld): HistoryEntry[] {
  const read = readHistory('floor', w.teamRoot, w.home);
  if (!read.ok) throw new Error(read.reason);
  return read.entries;
}

describe('the client send walk', () => {
  test('a live inbox channel takes the drop and nothing is typed', async () => {
    const w = walkFixture('walk-inbox');
    liveInboxIn(w);
    const host = walkHost(w);
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    // The client contract is unchanged by the walk: one confirmation line, one key-isolation line.
    expect(io.out()).toBe('sent: orchestrator@floor (drop drop-1)\n');
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(existsSync(join(w.dropDir, 'drop-1'))).toBe(true);
    expect(existsSync(join(w.dropDir, 'drop-1.pending'))).toBe(true);
    expect(existsSync(join(w.dropDir, 'drop-1.read.json'))).toBe(false);
    expect(walkHistory(w).at(-1)).toMatchObject({ via: 'mcp-inbox', outcome: 'sent (unconfirmed)' });
  });

  test('a receiving session that declares accept takes the frame mid-turn, under the owner header', async () => {
    const w = walkFixture('walk-socket');
    acceptInbound(w);
    const host = walkHost(w);
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    expect(io.out()).toBe('sent: orchestrator@floor (drop drop-1)\n');
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toHaveLength(1);
    const frame = JSON.parse(host.frames[0] as string) as { type: string; message: { role: string; content: string }; msg_id: string };
    expect(frame.type).toBe('user');
    expect(frame.msg_id).toBe('drop-1');
    expect(frame.message.content).toBe(
      'Message from Grok Bot (owner)\n\nhello orchestrator\n\nReply with: team send orchestrator@floor "…"',
    );
    // One signed record and the one receipt the socket write leaves, never a second of either.
    expect(readdirSync(w.dropDir).sort()).toEqual(['drop-1', 'drop-1.read.json']);
    const receipt = JSON.parse(readFileSync(join(w.dropDir, 'drop-1.read.json'), 'utf8')) as {
      payload: { id: string; status: string; to: string; read_by: string };
    };
    expect(receipt.payload).toMatchObject({ id: 'drop-1', status: 'read', to: 'orchestrator', read_by: 'socket delivery' });
    expect(walkHistory(w).at(-1)).toMatchObject({ via: 'socket', outcome: 'delivered' });
  });

  test('a refused socket frame falls back to the typed trigger with the same record', async () => {
    const w = walkFixture('walk-fallback');
    acceptInbound(w);
    const host = walkHost(w, {
      dial: async () => ({ ok: false, reason: 'the session closed the connection before it took the frame' }),
    });
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    expect(io.out()).toBe('sent: orchestrator@floor (drop drop-1)\n');
    expect(io.err()).toBe(`${KEY_ISOLATION_LINE}\n`);
    expect(host.dials()).toBe(1);
    expect(host.typed.map((one) => one.text)).toEqual([WAKE_LINE]);
    expect(host.enters).toEqual(['pane-orchestrator']);
    // The frame was never taken, so no read receipt exists for it.
    expect(existsSync(join(w.dropDir, 'drop-1.read.json'))).toBe(false);
    const last = walkHistory(w).at(-1);
    expect(last).toMatchObject({ via: 'typed', outcome: 'sent (unconfirmed)' });
    expect(last?.failed).toContain('socket: the session closed the connection before it took the frame');
  });

  test('with no channel and no inbound declaration, the typed trigger wakes the seat', async () => {
    const w = walkFixture('walk-typed');
    const host = walkHost(w);
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    expect(host.typed.map((one) => one.text)).toEqual([WAKE_LINE]);
    expect(host.enters).toEqual(['pane-orchestrator']);
    expect(existsSync(join(w.dropDir, 'drop-1.read.json'))).toBe(false);
    expect(walkHistory(w).at(-1)).toMatchObject({ via: 'typed', outcome: 'sent (unconfirmed)' });
  });

  test('a declared order is walked as written, and a live channel is not reached ahead of it', async () => {
    const w = walkFixture('walk-declared');
    liveInboxIn(w);
    const host = walkHost(w, { delivery: { seat: ['typed', 'mcp-inbox'] } });
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    // The typed leg is first in the receiver's own word and took the send; the channel never ran,
    // so no pending marker was written for it.
    expect(host.typed.map((one) => one.text)).toEqual([WAKE_LINE]);
    expect(existsSync(join(w.dropDir, 'drop-1.pending'))).toBe(false);
    expect(walkHistory(w).at(-1)).toMatchObject({ via: 'typed' });
  });

  test('a declared order naming a leg a client grant cannot walk keeps only the client legs', async () => {
    const w = walkFixture('walk-declared-drop');
    liveInboxIn(w);
    // `drop` is the durable copy the grant already wrote; the walk skips it and takes the channel.
    const host = walkHost(w, { delivery: { seat: ['drop', 'mcp-inbox'] } });
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    expect(host.typed).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(existsSync(join(w.dropDir, 'drop-1.pending'))).toBe(true);
    expect(walkHistory(w).at(-1)).toMatchObject({ via: 'mcp-inbox' });
  });

  test('the record the walk carries is the grant\'s own: one drop, one receipt, client principal intact', async () => {
    const w = walkFixture('walk-identity');
    acceptInbound(w);
    let atDial: { names: string[]; bytes: string } = { names: [], bytes: '' };
    const host = walkHost(w, {
      onDial: () => {
        atDial = {
          names: readdirSync(w.dropDir).sort(),
          bytes: readFileSync(join(w.dropDir, 'drop-1'), 'utf8'),
        };
      },
    });
    const io = capture(w);
    expect(await runSend(clientArgs(w), io.io, host)).toBe(0);
    // The record was on disk, alone, before the frame was dialed; the walk did not rewrite it.
    expect(atDial.names).toEqual(['drop-1']);
    expect(readFileSync(join(w.dropDir, 'drop-1'), 'utf8')).toBe(atDial.bytes);
    expect(readdirSync(w.dropDir).sort()).toEqual(['drop-1', 'drop-1.read.json']);
    const parsed = signedRecordOf(JSON.parse(readFileSync(join(w.dropDir, 'drop-1'), 'utf8')));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.payload.from).toBe(`client:${CLIENT_ID}`);
    expect(parsed.payload.from_id).toBeNull();
    expect(parsed.payload.from_client).toEqual({ client_id: CLIENT_ID, grant_id: w.grant.grantId });
    expect(parsed.payload.to).toBe('orchestrator');
    expect(parsed.payload.to_id).toBe(w.grant.recipientId);
    const messageKey = messageKeyState(w.home);
    expect(messageKey.kind).toBe('key');
    if (messageKey.kind === 'key') expect(verifyRecord(parsed, messageKey.key)).toBe(true);
    // The frame names the sender as the person's client, never as a seat address.
    const frame = JSON.parse(host.frames[0] as string) as { message: { content: string } };
    expect(frame.message.content).toContain('Message from Grok Bot (owner)');
    expect(frame.message.content).not.toContain('client:grok-bot@');
  });
});
