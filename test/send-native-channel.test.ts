// Every world here declares the native leg first — `delivery_order: [native, mcp-inbox, typed]`,
// since a word naming native is what puts it in the walk. A sender whose own file declares Claude
// Code gets the handoff: one pending record, the exact SendMessage target, the body, and the
// confirm line — and `team send --confirm <id>` writes the one history line. A sender that cannot
// make the leg walks on to the inbox and the typed trigger. `--wait` to a Claude Code seat is
// refused while the socket is not the channel. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import {
  PENDING_NATIVE_CONFIRM_WINDOW_MS,
  PENDING_NATIVE_TTL_MS,
  pendingDir,
  pendingPath,
  sweepPendingNative,
} from '../src/send/pending.ts';
import { updateState } from '../src/state.ts';
import { expirePendingNative } from '../src/watch/native.ts';
import type { RetryScene } from '../src/watch/retry.ts';
import { recordBody, testIo, type TestIo } from './helpers.ts';
import { NOW, dropDir, fake, filed, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** Every world in this suite declares the native leg first: the handoff is the leg under test,
 *  and a declared order is what puts it in the walk. */
function nativeWorld(): World {
  return world(['native', 'mcp-inbox', 'typed']);
}

/** The id the fake host mints, so the printed confirm line is exact. */
const ID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'nv-11111111';

/** The body a declared seat's send files: its header, then the text. */
const HELPER_HEADER = "from the file's seat helper (no registry record yet) — admitted by: a seat to its own team's orchestrator\n\n";
const HELPER_BODY = `${HELPER_HEADER}hello`;

/** The body a native handoff prints and stores: the sender header carries `[nv-<8 hex>]`. */
const HANDOFF_HEADER = `from the file's seat helper (no registry record yet) — admitted by: a seat to its own team's orchestrator [${NONCE}]\n\n`;
const HANDOFF_BODY = `${HANDOFF_HEADER}hello`;

/** A seat caller placed where the state records it: helper on w1:p1 of session acme. */
function helperCaller(root: string): TestIo {
  return testIo(root, { kind: 'seat', name: 'helper', pane: 'w1:p1', session: 'acme' });
}

/** The state `up` leaves: the seat launched, on the pane its caller stands on. */
function placeHelper(made: World): void {
  updateState(made.dir, (state) => {
    state.sessions.acme = {
      seats: { helper: { stage: 'ready', pane: 'w1:p1' } },
      worktrees: {},
    };
  });
}

function pending(made: World): string {
  return pendingPath('acme', made.root, made.home, ID);
}

test('a plain send to a claude-code seat writes the drop and types one trigger', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  expect(pane.typed[0]).toContain('hello');
  expect(pane.enters).toBe(1);
  const drops = dropDir(made.dir, 'lead');
  const files = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(files.length).toBe(1);
  expect(recordBody(join(drops, files[0] as string))).toBe(filed('hello'));
});

test('a registered recipient with model drift is held before any send leg writes or types', async () => {
  const made = world(['typed']);
  cleanup = made.cleanup;
  const leadId = teamIdOf(made.root);
  registerAgent(made.home, {
    name: 'lead',
    // Claude Code can run a non-Claude model through a wrapper; its status footer still needs
    // to be compared directly with the registry signing, not filtered by seatModel's CLI rule.
    signing: { model: 'DeepSeek Flash', version: '4.1', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: leadId, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'up',
  });
  const pane = scripted(['idle', 'working'], `❯ \n${'─'.repeat(40)}\n  main · …/acme · Opus 4.6 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`);
  const host = fake(made, { native: pane });
  const io = owner(made.root);

  expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
  expect(io.err).toContain('model drift: DeepSeek Flash 4.1 vs Claude Opus 4.6');
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(host.frames).toEqual([]);
  expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
});

test('the direct typed leg names the signed sender and the team it wrote from', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(pane.typed).toEqual(['Message from owner (owner@acme): hello Read it with: team drops --read.']);
});

test('--wait to a claude-code seat walks the typed leg without dialing the socket and waits on the thread', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, waitMs: 0 });

  const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], owner(made.root), host);

  expect(code).toBe(1);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  expect(pane.enters).toBe(1);
  const drops = dropDir(made.dir, 'lead');
  const files = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(files.length).toBe(1);
  expect(recordBody(join(drops, files[0] as string))).toBe(filed('hello'));
});

test('a claude-code seat gets the native handoff: a pending record, the exact target, the body and the confirm line', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });
  const io = helperCaller(made.root);

  const code = await runSend(['lead', 'hello', '--json'], io, host);
  const address = `uds:${join(made.sockets, '222.sock')}`;

  expect(code).toBe(0);
  expect(JSON.parse(io.out)).toEqual({
    schema: { name: 'team.send', version: 1 },
    format: 1,
    dry_run: false,
    status: 'native',
    action_summary: 'lead: native: nothing was sent; make the call with your own SendMessage, then record it',
    project: 'acme',
    session: 'acme',
    seat: 'lead',
    channel: 'native',
    to: address,
    confirm: `team send --confirm ${ID}`,
    message: HANDOFF_BODY,
    delivery: [
      { leg: 'native', state: 'attempted' },
      { leg: 'mcp-inbox', state: 'not-reached' },
      { leg: 'typed', state: 'not-reached' },
    ],
    ids: { sent: ID, reply: null },
  });
  // Nothing was delivered by the handoff: no frame, no trigger. The signed record the native
  // leg transports is already in the recipient's folder, so `team messages` can read the
  // message before the sender's own SendMessage carries the line.
  expect(host.frames).toEqual([]);
  expect(pane.typed).toEqual([]);
  const drops = join(made.dir, 'send-drops', 'acme', 'lead');
  expect(readdirSync(drops)).toEqual([ID]);
  expect(recordBody(join(drops, ID))).toBe(HANDOFF_BODY);
  // One pending record, the caller's own, at 0600 — and no history line yet.
  const path = pending(made);
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  expect(record.from).toBe('helper');
  expect(record.to).toBe('lead');
  expect(record.address).toBe(address);
  expect(record.body).toBe(HANDOFF_BODY);
  expect(record.nonce).toBe(NONCE);
  expect(record.rule).toBe("a seat to its own team's orchestrator");
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([]);

  // The plain run prints the same decision in the copy-paste shape: the target, the body the
  // sender's own SendMessage carries, and the one line that records it.
  unlinkSync(path);
  const plainIo = helperCaller(made.root);
  expect(await runSend(['lead', 'hello'], plainIo, host)).toBe(0);
  expect(plainIo.out).toBe(
    'team acme, session "acme"\n' +
      'lead: native: nothing was sent; make the call with your own SendMessage, then record it\n' +
      `to: ${address}\n` +
      `message:\n${HANDOFF_BODY}\n` +
      `team send --confirm ${ID}\n`,
  );
  expect(existsSync(path)).toBe(true);
});

test('the confirm with the nonce in the fake transcript records delivered and clears the record; a second confirm is refused', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working'], `Cross-session message [${NONCE}]: hello`);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  const confirmIo = helperCaller(made.root);
  expect(await runSend(['--confirm', ID], confirmIo, host)).toBe(0);
  expect(confirmIo.out).toBe('team acme, session "acme"\nlead: delivered (native, 0 ms)\n');
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'delivered',
      ms: 0,
      via: 'native',
    },
  ]);
  expect(existsSync(pending(made))).toBe(false);

  // Exactly once: the record is gone, so the second confirm records nothing.
  const again = helperCaller(made.root);
  expect(await runSend(['--confirm', ID], again, host)).toBe(1);
  expect(again.err).toContain('no pending native record holds that id');
  const after = readHistory('acme', made.root, made.home);
  expect(after.ok && after.entries.length).toBe(1);

  // Under --json, --confirm with nonce evidence emits status: "delivered".
  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  const confirmJsonIo = helperCaller(made.root);
  expect(await runSend(['--confirm', ID, '--json'], confirmJsonIo, host)).toBe(0);
  expect(JSON.parse(confirmJsonIo.out)).toEqual({
    schema: { name: 'team.send', version: 1 },
    format: 1,
    dry_run: false,
    status: 'delivered',
    action_summary: 'lead: delivered (native, 0 ms)',
    project: 'acme',
    session: 'acme',
    seat: 'lead',
    channel: 'native',
    ids: { sent: ID, reply: null },
  });
});

test('confirm without the nonce in the recipient transcript records sent (unconfirmed), never delivered', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working'], 'idle prompt with no cross-session frame');
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  const confirmIo = helperCaller(made.root);
  expect(await runSend(['--confirm', ID], confirmIo, host)).toBe(0);
  expect(confirmIo.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (native, 0 ms)\n');
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'sent (unconfirmed)',
      ms: 0,
      via: 'native',
    },
  ]);

  // Under --json, --confirm without nonce evidence emits status: "sent (unconfirmed)".
  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  const confirmJsonIo = helperCaller(made.root);
  expect(await runSend(['--confirm', ID, '--json'], confirmJsonIo, host)).toBe(0);
  expect(JSON.parse(confirmJsonIo.out)).toEqual({
    schema: { name: 'team.send', version: 1 },
    format: 1,
    dry_run: false,
    status: 'sent (unconfirmed)',
    action_summary: 'lead: sent (unconfirmed) (native, 0 ms)',
    project: 'acme',
    session: 'acme',
    seat: 'lead',
    channel: 'native',
    ids: { sent: ID, reply: null },
  });
});

test('a nonce from another handoff in the recipient transcript does not count as evidence for this confirm', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  // Transcript shows another handoff's nonce (nv-99999999), not this handoff's (nv-11111111).
  const pane = scripted(['idle', 'working'], 'Cross-session message [nv-99999999]: earlier message');
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  const confirmIo = helperCaller(made.root);
  expect(await runSend(['--confirm', ID], confirmIo, host)).toBe(0);
  expect(confirmIo.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (native, 0 ms)\n');
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'sent (unconfirmed)',
      ms: 0,
      via: 'native',
    },
  ]);
});

test('only the sender that printed the handoff confirms it, and a dry run writes nothing', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const host = fake(made, { native: scripted(['idle', 'working']), newId: () => ID });
  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  const dry = helperCaller(made.root);
  expect(await runSend(['--confirm', ID, '--dry-run'], dry, host)).toBe(0);
  expect(dry.out).toBe('team acme, session "acme"\nlead: would record (native, 0 ms); nothing was written\n');
  expect(existsSync(pending(made))).toBe(true);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([]);

  // The owner cannot confirm a seat's handoff: the record names its sender.
  const outsider = owner(made.root);
  expect(await runSend(['--confirm', ID], outsider, host)).toBe(1);
  expect(outsider.err).toContain(`it was printed for helper, and this call is owner`);
  expect(existsSync(pending(made))).toBe(true);
});

test('a handoff with no socket falls back to the typed drop and records the skip', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });
  const io = helperCaller(made.root);

  const code = await runSend(['lead', 'hello'], io, host);

  expect(code).toBe(0);
  expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
  expect(pane.typed.length).toBe(1);
  expect(readdirSync(dropDir(made.dir, 'lead')).filter((name) => !name.includes('.')).length).toBe(1);
  expect(existsSync(pending(made))).toBe(false);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: HELPER_BODY,
      id: expect.any(String),
      thread: expect.any(String),
      outcome: 'sent (unconfirmed)',
      note: 'trigger taken, no read receipt yet',
      ms: 0,
      via: 'typed',
      failed: [
        `native: no socket was found for its pane's processes (looked in ${made.sockets})`,
        'mcp-inbox: no live inbox listener',
      ],
    },
  ]);
});

test('a registry-resolved spec keeps to_id, spec and resolved through the handoff and confirm', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const teamId = teamIdOf(made.root);
  const leadAgent = registerAgent(made.home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamId, seat: 'lead', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, teamId, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: made.root,
    lobby: lobbyDir(made.home),
    roster: [{ agent: leadAgent.id, seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });

  const host = fake(made, { native: scripted(['idle', 'working'], NONCE), newId: () => ID });
  expect(await runSend(['lead@acme', 'hello'], helperCaller(made.root), host)).toBe(0);

  const record = JSON.parse(readFileSync(pending(made), 'utf8')) as Record<string, unknown>;
  expect(record.to_id).toBe(leadAgent.id);
  expect(record.spec).toBe('lead@acme');
  expect(record.resolved).toBe(leadAgent.id);

  expect(await runSend(['--confirm', ID], helperCaller(made.root), host)).toBe(0);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      from_team: teamIdOf(made.root),
      spec: 'lead@acme',
      resolved: leadAgent.id,
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'delivered',
      ms: 0,
      via: 'native',
    },
  ]);
});

test('a registered sender records from_id and confirm refuses a replaced agent or wrong registry pane', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const teamId = teamIdOf(made.root);
  const helperAgent = registerAgent(made.home, {
    name: 'helper',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamId, seat: 'helper', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });

  const host = fake(made, { native: scripted(['idle', 'working']), newId: () => ID });
  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  const record = JSON.parse(readFileSync(pending(made), 'utf8')) as Record<string, unknown>;
  expect(record.from_id).toBe(helperAgent.id);

  // A caller on another pane than the registry record holds is refused.
  const wrongPane = testIo(made.root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
  expect(await runSend(['--confirm', ID], wrongPane, host)).toBe(1);
  expect(wrongPane.err).toContain('a pane renamed to a seat\'s name is not that seat');
  expect(existsSync(pending(made))).toBe(true);

  // If a newer agent record replaces helper on the same seat name, the replacement cannot confirm
  // the earlier agent's handoff.
  const replacement = registerAgent(made.home, {
    name: 'helper',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamId, seat: 'helper', session: 'acme', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  const replacedIo = helperCaller(made.root);
  expect(await runSend(['--confirm', ID], replacedIo, host)).toBe(1);
  expect(replacedIo.err).toContain(`it was printed for agent ${helperAgent.id} (seat helper), and this call has agent ${replacement.id}`);
  expect(existsSync(pending(made))).toBe(true);
});

test('the 24h sweep keeps records younger than or at 24h, deletes records older than 24h, and recovers dead-PID .taken files', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');

  const idYounger = '22222222-2222-4222-8222-222222222221';
  const idExact = '22222222-2222-4222-8222-222222222222';
  const idOlder = '22222222-2222-4222-8222-222222222223';
  const idNew = '22222222-2222-4222-8222-222222222224';

  const tsOlder = new Date(NOW.getTime() - PENDING_NATIVE_TTL_MS - 1);
  const tsExact = new Date(NOW.getTime() - PENDING_NATIVE_TTL_MS);
  const tsYounger = new Date(NOW.getTime() - PENDING_NATIVE_TTL_MS + 1);

  expect(
    await runSend(['lead', 'older'], helperCaller(made.root), fake(made, { now: () => tsOlder, newId: () => idOlder })),
  ).toBe(0);
  expect(
    await runSend(['lead', 'exact'], helperCaller(made.root), fake(made, { now: () => tsExact, newId: () => idExact })),
  ).toBe(0);
  expect(
    await runSend(['lead', 'younger'], helperCaller(made.root), fake(made, { now: () => tsYounger, newId: () => idYounger })),
  ).toBe(0);

  // Writing a new handoff at NOW triggers the sweep: only the record strictly older than 24h
  // (24h + 1ms) is deleted; both the 24h - 1ms record and the exact 24h boundary record remain.
  expect(
    await runSend(['lead', 'new'], helperCaller(made.root), fake(made, { now: () => NOW, newId: () => idNew })),
  ).toBe(0);

  expect(existsSync(pendingPath('acme', made.root, made.home, idOlder))).toBe(false);
  expect(existsSync(pendingPath('acme', made.root, made.home, idExact))).toBe(true);
  expect(existsSync(pendingPath('acme', made.root, made.home, idYounger))).toBe(true);
  expect(existsSync(pendingPath('acme', made.root, made.home, idNew))).toBe(true);

  // Simulate a crashed confirm leaving a `.${id}.${pid}.taken` file from a dead PID (999999)
  // and another from a live PID (process.pid).
  const dir = pendingDir('acme', made.root, made.home);
  const deadTaken = join(dir, `.${idYounger}.999999.taken`);
  const liveTaken = join(dir, `.${idExact}.${String(process.pid)}.taken`);
  writeFileSync(deadTaken, readFileSync(pendingPath('acme', made.root, made.home, idYounger), 'utf8'));
  unlinkSync(pendingPath('acme', made.root, made.home, idYounger));
  writeFileSync(liveTaken, readFileSync(pendingPath('acme', made.root, made.home, idExact), 'utf8'));
  unlinkSync(pendingPath('acme', made.root, made.home, idExact));

  sweepPendingNative('acme', made.root, made.home, NOW, (pid) => pid === process.pid);

  // Dead PID's `.taken` was restored to `${idYounger}.json`; live PID's `.taken` stayed in flight.
  expect(existsSync(deadTaken)).toBe(false);
  expect(existsSync(pendingPath('acme', made.root, made.home, idYounger))).toBe(true);
  expect(existsSync(liveTaken)).toBe(true);
  expect(existsSync(pendingPath('acme', made.root, made.home, idExact))).toBe(false);

  // And the restored record confirms cleanly.
  const confirmIo = helperCaller(made.root);
  expect(await runSend(['--confirm', idYounger], confirmIo, fake(made, { now: () => NOW }))).toBe(0);
  expect(existsSync(pendingPath('acme', made.root, made.home, idYounger))).toBe(false);
});

const IDLE_SCREEN = '────────\n❯ \n────────';

function watchScene(made: World, now: Date, pane = scripted(['idle', 'working'])): { scene: RetryScene; pane: ReturnType<typeof scripted>; said: string[] } {
  const loaded = loadTeamFile(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('failed to load team file');
  const said: string[] = [];
  const scene: RetryScene = {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: loaded.team,
    live: {
      running: true,
      agents: [{ name: 'lead', agent: 'claude', workspace: 'w1', pane: 'w1:p1', cwd: made.root, status: 'idle' }],
      workspaces: [],
      screens: { 'w1:p1': IDLE_SCREEN },
    },
    ownPane: null,
    sources: {
      screen: () => IDLE_SCREEN,
      status: () => 'idle',
      typeText: (_id, text) => pane.typeText('acme', _id, text),
      pressEnter: (_id) => pane.pressEnter('acme', _id),
      sleep: async () => {},
    },
    now,
    say: (text) => {
      said.push(text);
    },
  };
  return { scene, pane, said };
}

test('expiry after 10m falls through to drop for a human-pane seat ([native, drop]) with no pane write', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, {
    native: pane,
    newId: () => ID,
    delivery: { seat: ['native', 'drop'] },
  });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  expect(existsSync(pending(made))).toBe(true);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene, pane: watchPane } = watchScene(made, expiredAt);
  await expirePendingNative(scene);

  // Pending record was claimed and removed; drop file was written; zero pane writes occurred.
  expect(existsSync(pending(made))).toBe(false);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(watchPane.typed).toEqual([]);
  expect(watchPane.enters).toBe(0);

  const drops = dropDir(made.dir, 'lead');
  const files = readdirSync(drops).sort();
  expect(files).toEqual([ID, `${ID}.pending`]);
  expect(statSync(join(drops, ID)).mode & 0o777).toBe(0o600);
  expect(recordBody(join(drops, ID))).toBe(HANDOFF_BODY);
  // The marker names the drop leg, so the seat's own receipt promotes it and no retry types it.
  expect(JSON.parse(readFileSync(join(drops, `${ID}.pending`), 'utf8'))).toEqual({
    id: ID,
    from: 'helper',
    to: 'lead',
    body: HANDOFF_BODY,
    ts: expiredAt.toISOString(),
    tries: 0,
    leg: 'drop',
  });

  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: expiredAt.toISOString(),
      from: 'helper',
      to: 'lead',
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'sent (unconfirmed)',
      ms: PENDING_NATIVE_CONFIRM_WINDOW_MS + 1,
      via: 'drop',
      failed: ['native: unconfirmed after 10m'],
    },
  ]);
});

test('a native hold keeps an expired handoff pending: no claim, no drop fallback, no pane write', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, {
    native: pane,
    newId: () => ID,
    delivery: { seat: ['native', 'drop'] },
  });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  expect(existsSync(pending(made))).toBe(true);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene, pane: watchPane } = watchScene(made, expiredAt);
  // The native store says the seat is not idle — a turn, a person wait, a session end, or an
  // unproven projection. Expiry is the last typing-free fallback and it waits too.
  scene.nativeHeld = new Set(['lead']);
  await expirePendingNative(scene);
  expect(existsSync(pending(made))).toBe(true);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(watchPane.typed).toEqual([]);
  expect(watchPane.enters).toBe(0);
  // The marker is what expiry's drop leg writes; the record file itself can pre-date it.
  expect(existsSync(join(dropDir(made.dir, 'lead'), `${ID}.pending`))).toBe(false);

  // Lifting the hold lets the ordinary expiry claim the record and write the marker.
  scene.nativeHeld = new Set();
  await expirePendingNative(scene);
  expect(existsSync(pending(made))).toBe(false);
  expect(existsSync(join(dropDir(made.dir, 'lead'), `${ID}.pending`))).toBe(true);
  expect(pane.typed).toEqual([]);
  expect(watchPane.typed).toEqual([]);
});

test('expiry writes the handoff into a live MCP inbox and leaves the retry a marker, zero pane writes', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  expect(existsSync(pending(made))).toBe(true);

  // The record a running inbox server leaves: a live listener for this seat, session and root.
  const dir = dropDir(made.dir, 'lead');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.inbox-listener'), `${JSON.stringify({
    v: 1,
    seat: 'lead',
    session: 'acme',
    root: made.root,
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
  })}\n`);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene, pane: watchPane, said } = watchScene(made, expiredAt);
  await expirePendingNative(scene);

  // The handoff's body is the inbox message, marked for the inbox leg; nothing was typed.
  expect(existsSync(pending(made))).toBe(false);
  expect(watchPane.typed).toEqual([]);
  expect(watchPane.enters).toBe(0);
  expect(readdirSync(dir).filter((name) => !name.startsWith('.') && !name.endsWith('.pending'))).toEqual([ID]);
  expect(recordBody(join(dir, ID))).toBe(HANDOFF_BODY);
  expect(JSON.parse(readFileSync(join(dir, `${ID}.pending`), 'utf8'))).toEqual({
    id: ID,
    from: 'helper',
    to: 'lead',
    body: HANDOFF_BODY,
    ts: expiredAt.toISOString(),
    thread: ID,
    tries: 0,
    leg: 'mcp-inbox',
  });
  expect(said).toEqual([
    'lead: a native handoff from helper was unconfirmed after 10m; written to its MCP inbox',
  ]);

  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: expiredAt.toISOString(),
      from: 'helper',
      to: 'lead',
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'sent (unconfirmed)',
      ms: PENDING_NATIVE_CONFIRM_WINDOW_MS + 1,
      via: 'mcp-inbox',
      failed: ['native: unconfirmed after 10m'],
    },
  ]);
});

test('confirm after expiry is refused and never causes a second delivery', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working'], `Cross-session message [${NONCE}]: hello`);
  const host = fake(made, {
    native: pane,
    newId: () => ID,
    delivery: { seat: ['native', 'drop'] },
  });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene } = watchScene(made, expiredAt);
  await expirePendingNative(scene);

  // Late confirm after expiry is refused and records no second history entry or drop file.
  const lateConfirmIo = helperCaller(made.root);
  const lateHost = fake(made, {
    native: pane,
    now: () => new Date(expiredAt.getTime() + 1_000),
    newId: () => ID,
  });
  expect(await runSend(['--confirm', ID], lateConfirmIo, lateHost)).toBe(1);
  expect(lateConfirmIo.err).toContain('no pending native record holds that id');

  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries.length).toBe(1);
  expect(history.ok && history.entries[0]?.via).toBe('drop');
  // The drop file and its marker, nothing else: a late confirm never delivers twice.
  expect(readdirSync(dropDir(made.dir, 'lead')).sort()).toEqual([ID, `${ID}.pending`]);
});

test('confirm inside the 10m window leaves no fallback triggered', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working'], `Cross-session message [${NONCE}]: hello`);
  const host = fake(made, {
    native: pane,
    newId: () => ID,
    delivery: { seat: ['native', 'drop'] },
  });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);

  // Watch pass at 5m (and at exact 10m boundary) does not expire the handoff.
  const insideAt = new Date(NOW.getTime() + 5 * 60_000);
  await expirePendingNative(watchScene(made, insideAt).scene);
  await expirePendingNative(watchScene(made, new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS)).scene);
  expect(existsSync(pending(made))).toBe(true);
  // The handoff wrote its signed record; the watch's passes have written no second file.
  const drops = dropDir(made.dir, 'lead');
  expect(readdirSync(drops)).toEqual([ID]);
  expect(recordBody(join(drops, ID))).toBe(HANDOFF_BODY);

  // Confirm inside the window records native delivery; a subsequent watch pass past 10m sees no
  // pending record and triggers no fallback.
  const confirmIo = helperCaller(made.root);
  const confirmHost = fake(made, { native: pane, now: () => insideAt, newId: () => ID });
  expect(await runSend(['--confirm', ID], confirmIo, confirmHost)).toBe(0);
  expect(confirmIo.out).toBe('team acme, session "acme"\nlead: delivered (native, 300000 ms)\n');

  const pastWindow = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 60_000);
  await expirePendingNative(watchScene(made, pastWindow).scene);

  expect(readdirSync(drops)).toEqual([ID]);
  expect(recordBody(join(drops, ID))).toBe(HANDOFF_BODY);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: insideAt.toISOString(),
      from: 'helper',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'delivered',
      ms: 300_000,
      via: 'native',
    },
  ]);
});

test('expiry typed leg refuses a pane back at its shell with no drop file and no pane write', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  expect(existsSync(pending(made))).toBe(true);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene, pane: watchPane, said } = watchScene(made, expiredAt);
  scene.sources.processes = () => ({ shell: 50001, foreground: [50001] });
  await expirePendingNative(scene);

  expect(existsSync(pending(made))).toBe(false);
  expect(watchPane.typed).toEqual([]);
  expect(watchPane.enters).toBe(0);
  expect(readdirSync(dropDir(made.dir, 'lead'))).toEqual([ID]);
  expect(said).toEqual(['lead: the seat is back at its shell; nothing was typed']);

  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: expiredAt.toISOString(),
      from: 'helper',
      to: 'lead',
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'unreachable',
      ms: PENDING_NATIVE_CONFIRM_WINDOW_MS + 1,
      failed: [
        'native: unconfirmed after 10m',
        'mcp-inbox: no live inbox listener',
      ],
    },
  ]);
});

test('cross-team expiry binds typing and read-back to record.session and verifies pane process identity', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  const path = pending(made);
  const rec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  rec.session = 'other';
  rec.pane = 'w2:p9';
  writeFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });

  // Record launched identity on the recipient session (`other`) so expiry verifies process identity.
  updateState(made.dir, (state) => {
    state.sessions.other = {
      seats: { lead: { stage: 'ready', pane: 'w2:p9', launched: { shell: 111, cli: [222] } } },
      worktrees: {},
    };
  });

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const typedSessions: string[] = [];
  const enterSessions: string[] = [];
  const statusSessions: string[] = [];
  const screenSessions: string[] = [];
  const processSessions: string[] = [];
  let statusCalls = 0;

  const { scene, said } = watchScene(made, expiredAt);
  scene.sources = {
    screen: (_id, sess) => {
      screenSessions.push(sess ?? 'default');
      return IDLE_SCREEN;
    },
    status: (_id, sess) => {
      statusSessions.push(sess ?? 'default');
      return statusCalls++ < 2 ? 'idle' : 'working';
    },
    typeText: (_id, _text, sess) => {
      typedSessions.push(sess ?? 'default');
      return true;
    },
    pressEnter: (_id, sess) => {
      enterSessions.push(sess ?? 'default');
      return true;
    },
    processes: (_id, sess) => {
      processSessions.push(sess ?? 'default');
      return { shell: 111, foreground: [222] };
    },
    sleep: async () => {},
  };

  await expirePendingNative(scene);

  // Every read and write targeted `other`, never `acme` (`scene.session`).
  expect(processSessions).toEqual(['other']);
  expect(typedSessions).toEqual(['other']);
  expect(enterSessions).toEqual(['other']);
  expect(statusSessions.every((s) => s === 'other')).toBe(true);
  expect(screenSessions.every((s) => s === 'other')).toBe(true);
  expect(said).toEqual(['lead: a native handoff from helper was unconfirmed after 10m; sent on fallback (trigger taken, no read receipt yet)']);
});

test('expiry typed leg whose trigger writes the read receipt is delivered (read), not sent', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  expect(existsSync(pending(made))).toBe(true);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const drops = dropDir(made.dir, 'lead');
  // In an object, so the closure's write is a property write the compiler does not narrow away.
  const receipt = { at: null as string | null };
  const { scene, pane: watchPane, said } = watchScene(made, expiredAt);
  // The fallback's trigger is the seat's own `team drops --read`: the seat that runs it writes
  // the signed receipt, so the fallback ends as a read rather than as a line left in a box.
  scene.sources.pressEnter = () => {
    const written = writeReceipt(drops, signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: ID,
      to: 'lead',
      root: made.root,
      session: 'acme',
      at: expiredAt.toISOString(),
    }, made.home), made.home);
    receipt.at = written.ok ? written.path : written.reason;
    return watchPane.pressEnter('acme', 'w1:p1');
  };
  await expirePendingNative(scene);

  expect(existsSync(pending(made))).toBe(false);
  expect(watchPane.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'helper', team: 'acme', body: 'hello' }) as string]);
  expect(watchPane.enters).toBe(1);
  expect(receipt.at).toBe(join(drops, `${ID}.read.json`));
  expect(readdirSync(drops).sort()).toEqual([ID, `${ID}.read.json`]);
  expect(said).toEqual(['lead: a native handoff from helper was unconfirmed after 10m; read on fallback (receipt)']);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: expiredAt.toISOString(),
      from: 'helper',
      to: 'lead',
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'delivered (read)',
      ms: PENDING_NATIVE_CONFIRM_WINDOW_MS + 1,
      via: 'typed',
      failed: [
        'native: unconfirmed after 10m',
        'mcp-inbox: no live inbox listener',
      ],
    },
  ]);
});

test('expiry typed leg refuses to type when the recipient pane process identity was replaced', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  const path = pending(made);
  const rec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  rec.session = 'other';
  rec.pane = 'w2:p9';
  writeFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });

  updateState(made.dir, (state) => {
    state.sessions.other = {
      seats: { lead: { stage: 'ready', pane: 'w2:p9', launched: { shell: 111, cli: [222] } } },
      worktrees: {},
    };
  });

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const typedSessions: string[] = [];
  const enterSessions: string[] = [];
  const processSessions: string[] = [];
  const { scene, said } = watchScene(made, expiredAt);
  scene.sources = {
    screen: () => IDLE_SCREEN,
    status: () => 'idle',
    typeText: (_id, _text, sess) => {
      typedSessions.push(sess ?? 'default');
      return true;
    },
    pressEnter: (_id, sess) => {
      enterSessions.push(sess ?? 'default');
      return true;
    },
    processes: (_id, sess) => {
      processSessions.push(sess ?? 'default');
      return { shell: 111, foreground: [999] };
    },
    sleep: async () => {},
  };

  await expirePendingNative(scene);

  expect(processSessions).toEqual(['other']);
  expect(typedSessions).toEqual([]);
  expect(enterSessions).toEqual([]);
  expect(readdirSync(dropDir(made.dir, 'lead'))).toEqual([ID]);
  expect(said).toEqual(['lead: the pane no longer holds the process team launched for this seat; nothing was typed']);
});

test('a [native, drop] fallback and a human-marked seat never type into the pane across send and watch expiry', async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, {
    native: pane,
    newId: () => ID,
    delivery: { seat: ['native', 'drop'] },
  });

  // Dry run with [native, drop] names the drop fallback with nothing typed.
  const dryIo = helperCaller(made.root);
  expect(await runSend(['lead', 'hello', '--dry-run'], dryIo, host)).toBe(0);
  expect(dryIo.out).toContain(
    'lead: dry-run: claude-code via the native handoff (your own SendMessage, then --confirm), falling back to a 0600 drop file, with nothing typed into the pane; nothing was written',
  );

  // Without a socket, handOff returns fallback and the walk continues straight to drop with zero pane writes.
  const sendIo = helperCaller(made.root);
  expect(await runSend(['lead', 'hello'], sendIo, host)).toBe(0);
  expect(sendIo.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);

  // If a pending handoff expires while the seat is marked human: true, watch expiry walks the
  // drop leg alone: no inbox write, nothing typed.
  writeFileSync(join(made.sockets, '222.sock'), '');
  const id2 = '22222222-2222-4222-8222-222222222222';
  const hostDefault = fake(made, { native: pane, newId: () => id2 });
  expect(await runSend(['lead', 'hello'], helperCaller(made.root), hostDefault)).toBe(0);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene, pane: watchPane, said } = watchScene(made, expiredAt);
  const leadSeat = scene.team.seats.find((s) => s.name === 'lead');
  if (leadSeat) leadSeat.human = true;

  await expirePendingNative(scene);

  expect(watchPane.typed).toEqual([]);
  expect(watchPane.enters).toBe(0);
  expect(said).toEqual([
    `lead: a native handoff from helper was unconfirmed after 10m; sent (unconfirmed) (dropped ${String(HANDOFF_BODY.length)} characters)`,
  ]);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries[1]?.via).toBe('drop');
  expect(history.ok && history.entries[1]?.failed).toEqual([
    'native: unconfirmed after 10m',
    "mcp-inbox: the pane is a human's, and the drop leg is the only one walked",
    "typed: the pane is a human's, and nothing is typed into it",
  ]);
});

test("a human seat's expired-native fallback goes to drop, never a live inbox, with zero pane writes", async () => {
  const made = nativeWorld();
  cleanup = made.cleanup;
  placeHelper(made);
  writeFileSync(join(made.sockets, '222.sock'), '');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane, newId: () => ID });

  expect(await runSend(['lead', 'hello'], helperCaller(made.root), host)).toBe(0);
  expect(existsSync(pending(made))).toBe(true);

  // A live listener is beside the seat's inbox: the inbox leg would take the message, but the
  // human rule keeps it out and the expiry writes the drop file alone.
  const dir = dropDir(made.dir, 'lead');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.inbox-listener'), `${JSON.stringify({
    v: 1,
    seat: 'lead',
    session: 'acme',
    root: made.root,
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
  })}\n`);

  const expiredAt = new Date(NOW.getTime() + PENDING_NATIVE_CONFIRM_WINDOW_MS + 1);
  const { scene, pane: watchPane, said } = watchScene(made, expiredAt);
  const leadSeat = scene.team.seats.find((s) => s.name === 'lead');
  if (leadSeat) leadSeat.human = true;

  await expirePendingNative(scene);

  // The drop file is the whole delivery: no marker for the retry pass, no inbox promotion.
  expect(existsSync(pending(made))).toBe(false);
  expect(watchPane.typed).toEqual([]);
  expect(watchPane.enters).toBe(0);
  expect(readdirSync(dir).filter((name) => !name.startsWith('.') && !name.endsWith('.pending'))).toEqual([ID]);
  expect(recordBody(join(dir, ID))).toBe(HANDOFF_BODY);
  expect(existsSync(join(dir, `${ID}.pending`))).toBe(false);
  expect(said).toEqual([
    `lead: a native handoff from helper was unconfirmed after 10m; sent (unconfirmed) (dropped ${String(HANDOFF_BODY.length)} characters)`,
  ]);

  const history = readHistory('acme', made.root, made.home);
  expect(history.ok && history.entries).toEqual([
    {
      ts: expiredAt.toISOString(),
      from: 'helper',
      to: 'lead',
      body: HANDOFF_BODY,
      id: ID,
      thread: ID,
      outcome: 'sent (unconfirmed)',
      ms: PENDING_NATIVE_CONFIRM_WINDOW_MS + 1,
      via: 'drop',
      failed: [
        'native: unconfirmed after 10m',
        "mcp-inbox: the pane is a human's, and the drop leg is the only one walked",
        "typed: the pane is a human's, and nothing is typed into it",
      ],
    },
  ]);
});
