// The socket delivery writes no read receipt: a frame the receiver's socket takes is the
// delivery, and only the seat writes a read receipt (its `inbox_read`, `team drops --read` or
// hook receipt). The sender's own write used to mark every taken frame read, including a frame
// an agent never saw; now the record stays unread for the seat's own read, and the watch's
// unread pass re-wakes it like any other message — the report at twice the window is what speaks
// when no seat receipt comes. A taken frame ends the sender's work at once: it reads no pane, so
// a box showing a held-message dialog changes nothing here — the record stays unread, and the
// daemon's held step is what marks a dialog. The watch's retry after its window remains the
// attempt. The frame also opens with the sender's display line (the nickname the roster holds,
// else the seat name) without touching the record's own attribution line or the typed wake's
// template. Fake hosts and temporary homes: no pane is typed into and no socket is dialed.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDrops } from '../src/commands/drops.ts';
import { listUnacked } from '../src/commands/messages.ts';
import { runSend, sendDirect } from '../src/commands/send.ts';
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
import { reportedPath, reportUnreadDrops, wakePath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { claudeBox, testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

// Leads wake at 180 seconds, independently of the ordinary seat delivery order.
const N = 180;

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

/** The team file with an entity, and the entity's own lobby in its trust list: the team a
 *  registry record reads by. The frame's reader line names the record's own id, so it needs no
 *  address from the entity. */
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
  const signed = signReceiptPayload({ ...base, read_by: 'channel' }, made.home);
  expect(verifyReceipt(parsedReceipt(JSON.parse(JSON.stringify(signed))), key)).toBe(true);

  // read_by is optional: a receipt without it verifies and reads exactly as before, and that is
  // what a plain seat reader (`team drops --read`) writes.
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
    { name: 'labelled', role: 'builder', label: 'Seat Eight · builder 5' },
    { name: 'blank', role: 'builder', label: '   ' },
  ]);
  cleanup = made.cleanup;
  declare(made);
  const labelled = registerSeat(made, 'labelled', 'fixture-pane-a');
  place(made, 'labelled', 'fixture-pane-a');
  roster(made, { agent: labelled, seat: 'labelled', role: 'builder' });
  const host = fake(made, {
    agents: () => [
      { name: 'labelled', pane: 'fixture-pane-a', cli: 'claude' },
      { name: 'lead', pane: 'fixture-pane-b', cli: 'claude' },
    ],
  });
  const io = testIo(made.root, { kind: 'seat', name: 'labelled', pane: 'fixture-pane-a', session: 'acme' });

  // The roster holds no nickname, so the written label's name before the middle dot stands.
  expect(await runSend(['lead', 'from the label'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(frameContent(host.frames[0] as string).startsWith('Seat Eight · labelled@acme · 2026-10-05 04:00Z · admitted: to orchestrator\n\n')).toBe(true);

  // A written label with nothing before the middle dot falls through to the seat name.
  const blank = registerSeat(made, 'blank', 'fixture-pane-c');
  place(made, 'blank', 'fixture-pane-c');
  roster(made, { agent: blank, seat: 'blank', role: 'builder' });
  const again = fake(made, {
    agents: () => [
      { name: 'blank', pane: 'fixture-pane-c', cli: 'claude' },
      { name: 'lead', pane: 'fixture-pane-b', cli: 'claude' },
    ],
  });
  const fromBlank = testIo(made.root, { kind: 'seat', name: 'blank', pane: 'fixture-pane-c', session: 'acme' });
  expect(await runSend(['lead', 'from the blank'], fromBlank, again)).toBe(0);
  expect(again.frames).toHaveLength(1);
  expect(frameContent(again.frames[0] as string).startsWith('blank · blank@acme · 2026-10-05 04:00Z · admitted: to orchestrator\n\n')).toBe(true);
});

test('a seat sender opens the frame with its nickname, and with its seat name when the roster holds none', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made);
  const helper = registerSeat(made, 'helper', 'fixture-pane-a', 'Bea');
  place(made, 'helper', 'fixture-pane-a');
  roster(made, { agent: helper, seat: 'helper', role: 'implementer', nickname: 'Bea' });
  const host = fake(made, {
    agents: () => [
      { name: 'helper', pane: 'fixture-pane-a', cli: 'claude' },
      { name: 'lead', pane: 'fixture-pane-b', cli: 'claude' },
    ],
  });
  const io = testIo(made.root, { kind: 'seat', name: 'helper', pane: 'fixture-pane-a', session: 'acme' });

  expect(await runSend(['lead', 'from bea'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(frameContent(host.frames[0] as string).startsWith('Bea · helper@acme · 2026-10-05 04:00Z · admitted: to orchestrator\n\n')).toBe(true);

  // The roster without a nickname for the seat: the same line falls back to the seat name.
  const native = registerSeat(made, 'native', 'fixture-pane-c');
  place(made, 'native', 'fixture-pane-c');
  roster(made, { agent: native, seat: 'native', role: 'reviewer' });
  const again = fake(made, {
    agents: () => [
      { name: 'native', pane: 'fixture-pane-c', cli: 'claude' },
      { name: 'lead', pane: 'fixture-pane-b', cli: 'claude' },
    ],
  });
  const fromNative = testIo(made.root, { kind: 'seat', name: 'native', pane: 'fixture-pane-c', session: 'acme' });
  expect(await runSend(['lead', 'from native'], fromNative, again)).toBe(0);
  expect(again.frames).toHaveLength(1);
  expect(frameContent(again.frames[0] as string).startsWith('native · native@acme · 2026-10-05 04:00Z · admitted: to orchestrator\n\n')).toBe(true);
});
