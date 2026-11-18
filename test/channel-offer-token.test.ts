// The Claude adapter §2.2 (F4, F5): the channel's offer token.
//
// On an active root each channel push of a stamped copy carries `meta.offer`, a fresh random
// token, kept beside that copy in its delivery history with the listener that pushed it. An ack
// whose offer matches a copy THIS listener pushed lands in the listener's token-ack log, which
// proves the channel. An ack without the token (a client that found the id through inbox_check),
// or with another copy's or another incarnation's token, settles the message and proves nothing.
// A dark root's push carries no offer. Fixtures only: synthetic folders, home and launch line.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerKeyOf, offerAckFolder, offerAcks, proveOffer } from '../src/comms/offer.ts';
import { runDrops } from '../src/commands/drops.ts';
import { listenerPath, readListener } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { offeredCopies, takeCopyNumber } from '../src/queue/handover.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { isRead, signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const FIRST = 'aaaaaaaa-0000-4000-8000-0000000a0f01';
const SECOND = 'bbbbbbbb-0000-4000-8000-0000000a0f02';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };

function teamText(launch: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

type Place = {
  root: string;
  home: string;
  dropDir: string;
  leadId: string;
  workerId: string;
  cleanup(): void;
};

function place(launch = `claude ${FLAG}`): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(launch));
  // The state `team up` leaves: the server proves its caller stands on lead's recorded pane.
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {} } } })}\n`,
  );
  const home = join(root, 'home');
  const teamId = teamIdOf(root);
  // Roster membership alone cannot resolve a signed from_id: the sender lookup also requires
  // a live agent file with matching team, seat and session. Register both synthetic agents.
  const agents = (['lead', 'worker'] as const).map((seat) => registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'worker' },
    lab: 'test', cli: 'claude-code', launcher: null,
    launch: seat === 'lead' ? launch : 'claude',
    reach: { team: teamId, seat, session: SESSION, pane: `pane-${seat}`, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }));
  // A server started with no --file resolves its team from the registry record holding the seat.
  upsertTeam(home, teamId, {
    project: 'acme',
    session: SESSION,
    root,
    roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
  });
  return {
    root,
    home,
    dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'),
    leadId: agents[0]!.id,
    workerId: agents[1]!.id,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function queue(): { lines: AsyncIterable<string>; write(line: string): void; push(line: string): void; end(): void; replies: string[] } {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    lines,
    write: (line) => replies.push(line),
    push: (line) => {
      pending.push(line);
      bump();
    },
    end: () => {
      ended = true;
      bump();
    },
    replies,
  };
}

function call(id: string, name: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });
}

function notice(replies: readonly string[]): Record<string, any>[] {
  return replies
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((one) => one.method === 'notifications/claude/channel');
}

async function until(check: () => boolean, limit = 400): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The caller lead's own launch line places: the seat, on its recorded pane, in the session. */
function seatCaller(): { kind: 'seat'; name: string; pane: string; session: string } {
  return { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION };
}


async function tool(feed: ReturnType<typeof queue>, request: string, name: string, args?: Record<string, unknown>): Promise<Record<string, any>> {
  feed.push(call(request, name, args));
  await until(() => feed.replies.some((line) => JSON.parse(line).id === request));
  return feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === request)!.result;
}

/** A stamped record from the worker, written through this build's record writer. */
function stamped(at: Place, id: string): void {
  const payload: RecordPayload = { kind: 'message', id, to: 'lead', to_id: at.leadId, root: realpathSync(at.root), session: SESSION, at: new Date().toISOString(), body: `body of ${id}`, from: 'worker', from_id: at.workerId, rule: 'the owner', thread: id };
  const signed = signRecord(stampedPayload(payload, at.home), at.home);
  expect(signed.payload.lvl).toBe(3);
  expect(writeRecord(at.dropDir, signed).ok).toBe(true);
}

function stampedDir(at: Place): string {
  return seatMailDirs(at.root, SESSION, 'lead').stamped;
}

function settled(at: Place, id: string): boolean {
  const key = messageKeyState(at.home);
  if (key.kind !== 'key') throw new Error('no key');
  return isRead(stampedDir(at), id, { to: 'lead', root: realpathSync(at.root), session: SESSION }, key.key);
}

function bindingOf(at: Place) {
  const key = messageKeyState(at.home);
  if (key.kind !== 'key') throw new Error('no key');
  return { root: realpathSync(at.root), session: SESSION, seat: 'lead', key: key.key };
}

async function served(active: boolean) {
  const at = place();
  if (active) expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  const feed = queue();
  const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), feed, { home: at.home });
  await until(() => existsSync(listenerPath(at.dropDir)));
  const listener = readListener(at.dropDir);
  if (listener === null) throw new Error('no listener');
  return { at, feed, running, key: listenerKeyOf(listener) };
}

describe('the offer token (active root)', () => {
  test('a stamped push carries a fresh offer, kept beside its copy with this listener; an ack with it proves the channel', async () => {
    const { at, feed, running, key } = await served(true);
    try {
      stamped(at, FIRST);
      await until(() => notice(feed.replies).length >= 1);
      const meta = notice(feed.replies)[0]!.params.meta as Record<string, string>;
      expect(meta.id).toBe(FIRST);
      expect(meta.offer).toMatch(/^[0-9a-f]{32}$/);
      // The copy's history entry holds the same token and this listener's key.
      expect(offeredCopies(stampedDir(at), FIRST)).toEqual([expect.objectContaining({ n: 1, token: meta.offer, listener: key })]);
      // The push marker keeps no token.
      const markers = readdirSync(stampedDir(at)).filter((name) => name.startsWith(FIRST) && name.endsWith('.json'));
      for (const name of markers) expect(readFileSync(join(stampedDir(at), name), 'utf8')).not.toContain(meta.offer!);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([]);
      // No reader prints the token: inbox_check, inbox_read and team drops --read.
      const checked = await tool(feed, 'c', 'inbox_check');
      const read = await tool(feed, 'r', 'inbox_read', { id: FIRST });
      expect(JSON.stringify(checked)).not.toContain(meta.offer!);
      expect(JSON.stringify(read)).toContain(`body of ${FIRST}`);
      expect(JSON.stringify(read)).not.toContain(meta.offer!);
      const dropsIo = testIo(at.root, { kind: 'owner' });
      const dropsCode = await runDrops(['--read', '--id', FIRST, '--seat', 'lead', '--session', SESSION], dropsIo, { home: at.home });
      expect(dropsCode).toBe(0);
      expect(`${dropsIo.out}${dropsIo.err}`).not.toContain(meta.offer!);
      const answer = await tool(feed, '1', 'ack', { id: FIRST, offer: meta.offer });
      expect(answer.isError).toBeUndefined();
      expect(settled(at, FIRST)).toBe(true);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([expect.objectContaining({ id: FIRST, n: 1 })]);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('F4: an ack without the token (an id found through inbox_check) settles and proves nothing', async () => {
    const { at, feed, running, key } = await served(true);
    try {
      stamped(at, FIRST);
      await until(() => notice(feed.replies).length >= 1);
      const answer = await tool(feed, '1', 'ack', { id: FIRST });
      expect(answer.isError).toBeUndefined();
      expect(settled(at, FIRST)).toBe(true);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([]);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('F5: an ack with another copy\'s token settles and proves nothing', async () => {
    const { at, feed, running, key } = await served(true);
    try {
      stamped(at, FIRST);
      await until(() => notice(feed.replies).length >= 1);
      stamped(at, SECOND);
      await until(() => notice(feed.replies).length >= 2);
      const pushes = notice(feed.replies).map((one) => one.params.meta as Record<string, string>);
      const firstOffer = pushes.find((one) => one.id === FIRST)!.offer;
      const secondOffer = pushes.find((one) => one.id === SECOND)!.offer;
      expect(firstOffer).not.toBe(secondOffer);
      // SECOND's ack carries FIRST's token.
      const answer = await tool(feed, '1', 'ack', { id: SECOND, offer: firstOffer });
      expect(answer.isError).toBeUndefined();
      expect(settled(at, SECOND)).toBe(true);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([]);
      // A malformed token proves nothing either.
      await tool(feed, '2', 'ack', { id: FIRST, offer: 'not-a-token' });
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([]);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('F5: a copy another incarnation pushed proves nothing for this listener', () => {
    const at = place();
    try {
      expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
      stamped(at, FIRST);
      const token = 'c'.repeat(32);
      expect(takeCopyNumber(stampedDir(at), FIRST, 'channel', Date.now(), { token, listener: '111@2026-11-18T00:00:00.000Z' })).toBe(1);
      expect(proveOffer(at.dropDir, FIRST, token, '222@2026-11-18T00:05:00.000Z', bindingOf(at))).toBeNull();
      expect(offerAcks(at.dropDir, '222@2026-11-18T00:05:00.000Z', bindingOf(at))).toEqual([]);
      // The incarnation that pushed it is proven by the same token.
      expect(proveOffer(at.dropDir, FIRST, token, '111@2026-11-18T00:00:00.000Z', bindingOf(at))).toEqual(expect.objectContaining({ id: FIRST, n: 1 }));
      expect(offerAcks(at.dropDir, '111@2026-11-18T00:00:00.000Z', bindingOf(at))).toHaveLength(1);
    } finally {
      at.cleanup();
    }
  });
});

describe('a proof entry is signed and bound (round 1)', () => {
  test('a fabricated log entry, and a genuine entry replayed under another listener, prove nothing', () => {
    const at = place();
    try {
      expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
      stamped(at, FIRST);
      const token = 'e'.repeat(32);
      const one = '111@2026-11-18T00:00:00.000Z';
      const two = '222@2026-11-18T00:05:00.000Z';
      expect(takeCopyNumber(stampedDir(at), FIRST, 'channel', Date.now(), { token, listener: one })).toBe(1);
      // A fabricated entry under the listener's folder: no signature over the proof domain.
      const folder = offerAckFolder(at.dropDir, one)!;
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${FIRST}.1`), JSON.stringify({ id: FIRST, n: 1, at: new Date().toISOString() }));
      expect(offerAcks(at.dropDir, one, bindingOf(at))).toEqual([]);
      rmSync(join(folder, `${FIRST}.1`));
      // A genuine proof, copied into another listener's folder: its binding names the first.
      expect(proveOffer(at.dropDir, FIRST, token, one, bindingOf(at))).not.toBeNull();
      expect(offerAcks(at.dropDir, one, bindingOf(at))).toHaveLength(1);
      const other = offerAckFolder(at.dropDir, two)!;
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, `${FIRST}.1`), readFileSync(join(folder, `${FIRST}.1`), 'utf8'));
      expect(offerAcks(at.dropDir, two, bindingOf(at))).toEqual([]);
      // And under another seat's binding the genuine one proves nothing.
      expect(offerAcks(at.dropDir, one, { ...bindingOf(at), seat: 'worker' })).toEqual([]);
    } finally {
      at.cleanup();
    }
  });
});

describe('round 2: proofs and copy history are read only inside the seat tree', () => {
  test('a linked proof folder, a linked numbered copy and a fifo copy prove nothing', () => {
    const at = place();
    try {
      expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
      stamped(at, FIRST);
      const token = 'c'.repeat(32);
      const key = '111@2026-11-18T00:00:00.000Z';
      // A genuine copy and proof, moved out of the tree and linked back in.
      expect(takeCopyNumber(stampedDir(at), FIRST, 'channel', Date.now(), { token, listener: key })).toBe(1);
      expect(proveOffer(at.dropDir, FIRST, token, key, bindingOf(at))).not.toBeNull();
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toHaveLength(1);
      const folder = offerAckFolder(at.dropDir, key)!;
      const outside = join(at.root, 'outside-proofs');
      renameSync(folder, outside);
      symlinkSync(outside, folder);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([]);
      unlinkSync(folder);
      renameSync(outside, folder);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toHaveLength(1);
      // The numbered copy linked from outside: the copy match is gone, so the proof is too.
      const copy = join(stampedDir(at), '.exposures', FIRST, '1');
      const away = join(at.root, 'outside-copy');
      renameSync(copy, away);
      symlinkSync(away, copy);
      expect(offeredCopies(stampedDir(at), FIRST)).toEqual([]);
      expect(offerAcks(at.dropDir, key, bindingOf(at))).toEqual([]);
      // A fifo in its place is never opened for a read that could block.
      unlinkSync(copy);
      execFileSync('mkfifo', [copy]);
      expect(offeredCopies(stampedDir(at), FIRST)).toEqual([]);
    } finally {
      at.cleanup();
    }
  });
});

describe('a dark root', () => {
  test('a push carries no offer, and the history holds no token', async () => {
    const { at, feed, running } = await served(false);
    try {
      const record = signRecord({ kind: 'message', id: FIRST, to: 'lead', to_id: at.leadId, root: realpathSync(at.root), session: SESSION, at: new Date().toISOString(), body: 'dark', from: 'worker', from_id: at.workerId, rule: 'the owner', thread: FIRST }, at.home);
      mkdirSync(at.dropDir, { recursive: true });
      writeFileSync(join(at.dropDir, FIRST), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await until(() => notice(feed.replies).length >= 1);
      expect(Object.keys(notice(feed.replies)[0]!.params.meta as Record<string, string>)).not.toContain('offer');
      expect(offeredCopies(at.dropDir, FIRST)).toEqual([]);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });
});
