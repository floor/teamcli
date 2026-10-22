// The socket delivery's read receipt: a frame the receiver's socket takes is the delivery, so
// the send writes the signed `read` receipt itself — the same receipt a reader writes — and the
// record stops at `read`. The watch does not ring for it and `team drops --read` and
// `team messages` do not serve it again. A frame the box holds is not a delivery: it writes no
// receipt and the record stays unread, so the watch's retry after its window remains the attempt.
// The frame also opens with the sender's display line (the nickname the roster holds, else the
// seat name) without touching the record's own attribution line or the typed wake's template.
// Fake hosts and temporary homes: no pane is typed into and no socket is dialed.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDrops } from '../src/commands/drops.ts';
import { listUnacked } from '../src/commands/messages.ts';
import { runSend } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { isRead, signReceiptPayload, signedReceiptOf, verifyReceipt, writeReceipt } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import { claudeBox, testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's declaration at the launch's own settings path, and the socket its pane
 *  exposes. The declaration's file predates the socket: the session was started after the
 *  launcher declared the policy. */
function declare(made: World, seat = 'lead', policy = 'accept'): string {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  // The declaration predates the socket: the session was started after the launcher wrote it.
  const declaredAt = new Date(Date.now() - 60_000);
  utimesSync(path, declaredAt, declaredAt);
  writeFileSync(join(made.sockets, '222.sock'), '');
  return path;
}

/** The team file with an entity, and the entity's own lobby in its trust list: the owner-origin
 *  frame's reply address is read from the entity the team names. */
function declareEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** The seat's signed agent record in the fixture's registry: the identity a signed `from_id`
 *  resolves through. */
function registerSeat(made: World, seat: string, pane: string, nickname?: string): string {
  return registerAgent(made.home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude',
    launcher: null,
    launch: 'claude',
    reach: { team: 'acme', seat, session: 'acme', pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  }).id;
}

/** The state record `up` leaves for a launched seat: the pane it stands on. */
function place(made: World, seat: string, pane: string): void {
  updateState(made.dir, (state) => {
    const one = (state.sessions.acme ??= emptySession());
    one.seats[seat] = { stage: 'launched', pane, workspace: 'w1' };
  });
}

/** The team's roster as sync projects it: the nickname the frame's display line reads. */
function roster(made: World, ...lines: { agent: string; seat: string; role: string; nickname?: string }[]): void {
  upsertTeam(made.home, teamIdOf(made.root), {
    project: 'acme',
    session: 'acme',
    root: realpathSync(made.root),
    roster: lines,
    at: NOW.toISOString(),
  });
}

function recordName(drops: string): string {
  const names = readdirSync(drops).filter((name) => !name.includes('.'));
  if (names.length !== 1) throw new Error(`expected one record, found ${String(names.length)}`);
  return names[0] as string;
}

function frameContent(frame: string): string {
  return (JSON.parse(frame) as { message: { content: string } }).message.content;
}

/** One watch pane: idle, empty box, every read a turn. */
function watchPane(): { typed: string[]; source: RetrySources } {
  let screen = claudeBox('');
  const typed: string[] = [];
  const source: RetrySources = {
    screen: () => screen,
    status: () => 'idle',
    typeText: (_pane, text) => {
      typed.push(text);
      screen = claudeBox(text);
      return true;
    },
    pressEnter: () => true,
    sleep: async () => {},
  };
  return { typed, source };
}

function liveWith(seat: string, pane: string): Live {
  const agents: HerdrAgent[] = [{ name: seat, agent: 'claude', pane, workspace: 'first', status: 'idle', cwd: null }];
  return { running: true, agents, workspaces: [], screens: {} };
}

function watchScene(made: World, sources: RetrySources, now: Date) {
  const text = readFileSync(join(made.dir, 'team.yaml'), 'utf8');
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const said: string[] = [];
  return {
    scene: {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team: parsed.team,
      live: liveWith('lead', 'w1:p1'),
      ownPane: null,
      sources,
      now,
      say: (line: string) => said.push(line),
    },
    said,
  };
}

test('an accepted socket frame writes the signed read receipt, and the frame opens with the sender line', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  declare(made);
  const host = fake(made);

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toHaveLength(1);
  // The frame's first line is the sender as a person reads it; the record's own attribution
  // line follows it under one blank line, unchanged.
  expect(frameContent(host.frames[0] as string).startsWith('Message from owner (owner@acme)\n\nfrom the owner — admitted by: the owner\n')).toBe(true);
  // The receipt is a signed read, naming the delivery that took the record.
  const drops = dropDir(made.dir, 'lead');
  const id = recordName(drops);
  const receipt = signedReceiptOf(JSON.parse(readFileSync(join(drops, `${id}.read.json`), 'utf8')));
  expect(receipt).not.toBeNull();
  if (receipt === null) return;
  expect(receipt.payload).toEqual({
    kind: 'receipt',
    status: 'read',
    id,
    to: 'lead',
    root: realpathSync(made.root),
    session: 'acme',
    at: NOW.toISOString(),
    read_by: 'socket delivery',
  });
  expect(verifyReceipt(receipt, messageKeyOf(made.home))).toBe(true);
});

test('the watch does not ring for a socket-delivered record, and rings for it once the receipt is gone', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  declare(made);
  const host = fake(made);
  expect(await runSend(['lead', 'a note'], owner(made.root), host)).toBe(0);
  const drops = dropDir(made.dir, 'lead');
  const id = recordName(drops);

  // Eleven minutes later the record would be due for the unread wake; the receipt is the read,
  // so the watch types nothing.
  const pane = watchPane();
  const { scene, said } = watchScene(made, pane.source, new Date(NOW.getTime() + 11 * 60_000));
  await wakeUnreadDrops(scene, { unreadAfter: 600 });
  expect(pane.typed).toEqual([]);
  expect(said).toEqual([]);

  // The control: without the receipt the same scene types the wake line for the same record.
  unlinkSync(join(drops, `${id}.read.json`));
  await wakeUnreadDrops(scene, { unreadAfter: 600 });
  expect(pane.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme' }) as string]);
});

test('a held socket frame writes no receipt, and the record waits for the watch retry', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made);
  declare(made);
  const rule = '─'.repeat(30);
  const heldDialog = `Held message from another session\n${rule}\n❯ \n${rule}`;
  const pane = scripted(['idle', 'working', 'idle', 'working', 'idle']);
  pane.paneText = () => heldDialog;
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_path: string, frame: string) => {
      dials.push(frame);
      return { ok: true };
    },
  });

  expect(await runSend(['lead', 'held note'], owner(made.root), host)).toBe(0);
  expect(dials).toHaveLength(1);
  const drops = dropDir(made.dir, 'lead');
  const id = recordName(drops);
  // No receipt, no other status file: the frame was held, not delivered.
  expect(readdirSync(drops).filter((name) => name.endsWith('.read.json'))).toEqual([]);
  // The record is still the watch's to retry.
  const context = { to: 'lead', root: realpathSync(made.root), session: 'acme' };
  expect(listUnread(drops, context, made.home).map((message) => message.id)).toEqual([id]);
});

test('drops --read does not serve a socket-delivered record again', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  declare(made);
  expect(await runSend(['lead', 'a note'], owner(made.root), fake(made))).toBe(0);
  const drops = dropDir(made.dir, 'lead');
  const id = recordName(drops);
  const context = { to: 'lead', root: realpathSync(made.root), session: 'acme' };

  expect(listDrops(drops, messageKeyOf(made.home), context)).toEqual({ kind: 'ok', rows: [] });

  // The control: a receipt that does not verify proves nothing, and the record is served.
  unlinkSync(join(drops, `${id}.read.json`));
  const listing = listDrops(drops, messageKeyOf(made.home), context);
  expect(listing.kind).toBe('ok');
  if (listing.kind !== 'ok') return;
  expect(listing.rows.map((row) => row.id)).toEqual([id]);
});

test('team messages does not list a socket-delivered record as unacked', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  declare(made);
  expect(await runSend(['lead', 'a note'], owner(made.root), fake(made))).toBe(0);
  const drops = dropDir(made.dir, 'lead');
  const id = recordName(drops);

  expect(listUnacked(made.root, 'acme', made.home)).toEqual([]);

  unlinkSync(join(drops, `${id}.read.json`));
  expect(listUnacked(made.root, 'acme', made.home).map((row) => row.id)).toEqual([id]);
});

test('the read receipt verifies with read_by and an older receipt without it still does', () => {
  const made = world(null);
  cleanup = made.cleanup;
  // The signing key lives in the home and is created on the first sign.
  const key = messageKeyOf(made.home);
  const parsedReceipt = (value: unknown) => {
    const receipt = signedReceiptOf(value);
    if (receipt === null) throw new Error('not a signed receipt');
    return receipt;
  };
  const base = { kind: 'receipt' as const, status: 'read' as const, id: 'aaaa', to: 'lead', root: realpathSync(made.root), session: 'acme', at: NOW.toISOString() };
  const signed = signReceiptPayload({ ...base, read_by: 'socket delivery' }, made.home);
  expect(verifyReceipt(parsedReceipt(JSON.parse(JSON.stringify(signed))), key)).toBe(true);

  // A receipt written by a reader carries no read_by, and it verifies and reads exactly as before.
  const reader = signReceiptPayload(base, made.home);
  expect(verifyReceipt(parsedReceipt(JSON.parse(JSON.stringify(reader))), key)).toBe(true);
  const drops = dropDir(made.dir, 'lead');
  mkdirSync(drops, { recursive: true });
  expect(writeReceipt(drops, reader, made.home).ok).toBe(true);
  expect(isRead(drops, 'aaaa', { to: 'lead', root: realpathSync(made.root), session: 'acme' }, key)).toBe(true);

  // read_by is signed with the payload: rewriting or stripping it stops the signature proving
  // anything, so the receipt does not count as a read.
  const tampered = { payload: { ...signed.payload, read_by: 'a reader' }, signature: signed.signature };
  expect(verifyReceipt(parsedReceipt(tampered), key)).toBe(false);
  const { read_by: _dropped, ...stripped } = signed.payload;
  expect(verifyReceipt(parsedReceipt({ payload: stripped, signature: signed.signature }), key)).toBe(false);
  const planted = dropDir(made.dir, 'other');
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, 'aaaa.read.json'), `${JSON.stringify(tampered, null, 2)}\n`);
  expect(isRead(planted, 'aaaa', { to: 'lead', root: realpathSync(made.root), session: 'acme' }, key)).toBe(false);
});

test('a seat with no nickname opens the frame with its written label name, and with its seat name when that is blank', async () => {
  const made = world(null, [
    { name: 'labelled', role: 'builder', label: 'Epimetheus · builder 5' },
    { name: 'blank', role: 'builder', label: '   ' },
  ]);
  cleanup = made.cleanup;
  declare(made);
  const labelled = registerSeat(made, 'labelled', 'w4:p1');
  place(made, 'labelled', 'w4:p1');
  roster(made, { agent: labelled, seat: 'labelled', role: 'builder' });
  const host = fake(made, { agents: () => [{ name: 'labelled', pane: 'w4:p1' }, { name: 'lead', pane: 'w2:p1' }] });
  const io = testIo(made.root, { kind: 'seat', name: 'labelled', pane: 'w4:p1', session: 'acme' });

  // The roster holds no nickname, so the written label's name before the middle dot stands.
  expect(await runSend(['lead', 'from the label'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(frameContent(host.frames[0] as string).startsWith('Message from Epimetheus (labelled@acme)\n\n')).toBe(true);

  // A written label with nothing before the middle dot falls through to the seat name.
  const blank = registerSeat(made, 'blank', 'w5:p1');
  place(made, 'blank', 'w5:p1');
  roster(made, { agent: blank, seat: 'blank', role: 'builder' });
  const again = fake(made, { agents: () => [{ name: 'blank', pane: 'w5:p1' }, { name: 'lead', pane: 'w2:p1' }] });
  const fromBlank = testIo(made.root, { kind: 'seat', name: 'blank', pane: 'w5:p1', session: 'acme' });
  expect(await runSend(['lead', 'from the blank'], fromBlank, again)).toBe(0);
  expect(again.frames).toHaveLength(1);
  expect(frameContent(again.frames[0] as string).startsWith('Message from blank (blank@acme)\n\n')).toBe(true);
});

test('a seat sender opens the frame with its nickname, and with its seat name when the roster holds none', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made);
  const helper = registerSeat(made, 'helper', 'w1:p1', 'Bea');
  place(made, 'helper', 'w1:p1');
  roster(made, { agent: helper, seat: 'helper', role: 'implementer', nickname: 'Bea' });
  const host = fake(made, { agents: () => [{ name: 'helper', pane: 'w1:p1' }, { name: 'lead', pane: 'w2:p1' }] });
  const io = testIo(made.root, { kind: 'seat', name: 'helper', pane: 'w1:p1', session: 'acme' });

  expect(await runSend(['lead', 'from bea'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(frameContent(host.frames[0] as string).startsWith('Message from Bea (helper@acme)\n\n')).toBe(true);

  // The roster without a nickname for the seat: the same line falls back to the seat name.
  const native = registerSeat(made, 'native', 'w3:p1');
  place(made, 'native', 'w3:p1');
  roster(made, { agent: native, seat: 'native', role: 'reviewer' });
  const again = fake(made, { agents: () => [{ name: 'native', pane: 'w3:p1' }, { name: 'lead', pane: 'w2:p1' }] });
  const fromNative = testIo(made.root, { kind: 'seat', name: 'native', pane: 'w3:p1', session: 'acme' });
  expect(await runSend(['lead', 'from native'], fromNative, again)).toBe(0);
  expect(again.frames).toHaveLength(1);
  expect(frameContent(again.frames[0] as string).startsWith('Message from native (native@acme)\n\n')).toBe(true);
});
