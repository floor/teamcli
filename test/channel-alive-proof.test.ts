// A channel push re-proves its seat (`alive()`) on every use: the live placement and the current
// declaration are read again each time (no file the process can witness shows a pane's terminal
// placement, and a registry-backed team's declaration is its registry record), so a moved pane, a
// stopped declaration or a registry-only stop refuses the next push. Fixtures only: synthetic
// folders, home and launch line.
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
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';
import { sha256, writeStoredTeamConfig } from '../src/registry/team-config-store.ts';

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


const IDS = Array.from({ length: 6 }, (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`);

function stateText(leadPane: string, lead: Record<string, unknown> = {}, session: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: leadPane, ...lead }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {}, ...session } } })}\n`;
}

async function servedCounting() {
  const at = place();
  expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  const feed = queue();
  const io = testIo(at.root);
  const placed = { count: 0 };
  // Every placement of the caller reads this: the count is how often the proof ran.
  Object.defineProperty(io, 'caller', { get() { placed.count += 1; return seatCaller(); } });
  const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
  await until(() => existsSync(listenerPath(at.dropDir)));
  return { at, feed, running, placed };
}

async function pushed(feed: ReturnType<typeof queue>, n: number): Promise<number> {
  await until(() => notice(feed.replies).length >= n, 200);
  return notice(feed.replies).length;
}

describe('the seat proof a push makes', () => {
  test('every push places its caller again; a moved pane refuses', async () => {
    const { at, feed, running, placed } = await servedCounting();
    try {
      stamped(at, IDS[0]!);
      expect(await pushed(feed, 1)).toBe(1);
      stamped(at, IDS[1]!);
      expect(await pushed(feed, 2)).toBe(2);
      const proved = placed.count;
      stamped(at, IDS[2]!);
      expect(await pushed(feed, 3)).toBe(3);
      stamped(at, IDS[3]!);
      expect(await pushed(feed, 4)).toBe(4);
      expect(placed.count).toBeGreaterThan(proved);
      // The seat is restarted on another pane: the state names it, the proof runs and refuses.
      writeFileSync(join(at.root, '.agents', 'team.state.json'), stateText('pane-moved'));
      stamped(at, IDS[4]!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(placed.count).toBeGreaterThan(proved);
      expect(notice(feed.replies).length).toBe(4);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('a state rewritten for fields the proof does not read, or by a restart on the same pane, still pushes', async () => {
    const { at, feed, running, placed } = await servedCounting();
    try {
      stamped(at, IDS[0]!);
      stamped(at, IDS[1]!);
      expect(await pushed(feed, 2)).toBe(2);
      const proved = placed.count;
      const path = join(at.root, '.agents', 'team.state.json');
      // A heartbeat and a presence stamp: the file is replaced, the proof's words are not.
      writeFileSync(`${path}.tmp`, stateText('pane-lead', { last_active: '2026-11-21T15:00:00.000Z' }, { watch: { heartbeat: '2026-11-21T15:00:00.000Z' } }));
      renameSync(`${path}.tmp`, path);
      stamped(at, IDS[2]!);
      expect(await pushed(feed, 3)).toBe(3);
      expect(placed.count).toBeGreaterThan(proved);
      // A restart on the same pane records its new launch: the proof runs again.
      writeFileSync(`${path}.tmp`, stateText('pane-lead', { launched: { cli: [424242] } }));
      renameSync(`${path}.tmp`, path);
      stamped(at, IDS[3]!);
      expect(await pushed(feed, 4)).toBe(4);
      expect(placed.count).toBeGreaterThan(proved);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('an edited team file proves again; a seat it marks stopped is refused on the next push', async () => {
    const { at, feed, running, placed } = await servedCounting();
    try {
      stamped(at, IDS[0]!);
      stamped(at, IDS[1]!);
      expect(await pushed(feed, 2)).toBe(2);
      const proved = placed.count;
      const file = join(at.root, '.agents', 'team.yaml');
      writeFileSync(file, `${readFileSync(file, 'utf8')}# edited\n`);
      stamped(at, IDS[5]!);
      expect(await pushed(feed, 3)).toBe(3);
      expect(placed.count).toBeGreaterThan(proved);
      writeFileSync(file, readFileSync(file, 'utf8').replace('    name: lead\n', '    name: lead\n    stopped: true\n'));
      stamped(at, IDS[2]!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(notice(feed.replies).length).toBe(3);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('a registry-only session change of a registry-backed team is refused on the next tool call', async () => {
    await underRegistry(async () => {
      const at = place();
      intoRegistry(at.root, at.home);
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), feed, { home: at.home });
      try {
        await until(() => existsSync(listenerPath(at.dropDir)));
        expect((await tool(feed, 'c0', 'inbox_check')).isError).not.toBe(true);
        expect((await tool(feed, 'c1', 'inbox_check')).isError).not.toBe(true);
        // The registry's record moves the team to another session; no team file and no state changes.
        const record = storedTeam(at.root, at.home)!;
        const text = record.text.replace(`session: ${SESSION}\n`, 'session: elsewhere\n');
        expect(text).not.toBe(record.text);
        writeStoredTeamConfig(at.home, { ...record, text, text_sha256: sha256(text) });
        expect((await tool(feed, 'c2', 'inbox_check')).isError).toBe(true);
      } finally {
        feed.end();
        await running;
        at.cleanup();
      }
    });
  });

  test('an explicit team file that is a link is judged by the file it names: a target edit is refused on the next tool call', async () => {
    const at = place();
    // The team file the server is started with is a link to the real file elsewhere.
    const target = join(at.root, 'team-target.yaml');
    const link = join(at.root, '.agents', 'team.yaml');
    renameSync(link, target);
    symlinkSync(target, link);
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION, file: link }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      expect((await tool(feed, 'c0', 'inbox_check')).isError).not.toBe(true);
      expect((await tool(feed, 'c1', 'inbox_check')).isError).not.toBe(true);
      writeFileSync(target, readFileSync(target, 'utf8').replace(`session: ${SESSION}\n`, 'session: elsewhere\n'));
      expect((await tool(feed, 'c2', 'inbox_check')).isError).toBe(true);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('a sender the linked team file no longer declares is not pushed: channel admission reads the roster fresh', async () => {
    const at = place();
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    const target = join(at.root, 'team-target.yaml');
    const link = join(at.root, '.agents', 'team.yaml');
    renameSync(link, target);
    symlinkSync(target, link);
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION, file: link }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      stamped(at, IDS[0]!);
      expect(await pushed(feed, 1)).toBe(1);
      // The worker leaves the roster in the file the link names; its registry record stays live.
      const text = readFileSync(target, 'utf8');
      writeFileSync(target, text.slice(0, text.indexOf('  - role: worker')));
      stamped(at, IDS[1]!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(notice(feed.replies).length).toBe(1);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });
});
