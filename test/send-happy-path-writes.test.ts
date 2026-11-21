// The send path diet (step 2): a send whose first leg delivers writes no fallback episode (no
// `<id>.fallback.json` marker, no `fallback-attempts-*.jsonl` ledger) and no `.unread.json` hint.
// The episode starts only when a fallback leg does. Step 3: its one log line is the history line
// (`messages.jsonl`): no step event in `events.jsonl` and no `team.log` line. Fixtures only: a synthetic team, a listener
// written by this test, and the push marker written where the seat's server would write it.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { channelEmitted, channelNotified, channelPushed, channelPushHeld, markChannelNotified, recordChannelPush, reserveChannelFallback, retireChannelAttempt } from '../src/mcp/channel.ts';
import { listenerPath, MESSAGE_ID, writeListener } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { activate } from '../src/queue/floor.ts';
import { copyHistory, firstRetiredRoundAborted, offeredCopies, takeCopyNumber } from '../src/queue/handover.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const SEND_ID = 'aaaaaaaa-0000-4000-8000-000000000301';
const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** Every file under `top` modified after `since` (ms), as paths relative to `base`. */
function writtenSince(top: string, since: number, base: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of existsSync(at) ? readdirSync(at) : []) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.mtimeMs > since) out.push(relative(base, path));
    }
  };
  walk(top);
  return out.sort();
}

function channelScene(): { made: World; dir: string } {
  const made = world(null, [], { lead: CHANNEL_LAUNCH });
  cleanup = made.cleanup;
  const dir = dropDir(made.dir, 'lead');
  mkdirSync(dir, { recursive: true });
  const root = realpathSync(made.root);
  writeListener(dir, { v: 1, seat: 'lead', session: 'acme', root, cli: 'claude-code', pid: process.pid, ts: NOW.toISOString(), channel: true });
  return { made, dir };
}

describe('the happy path writes no fallback episode and no unread hint', () => {
  test('a channel push that lands: no marker, no attempt ledger, no unread hint', async () => {
    const { made, dir } = channelScene();
    const root = realpathSync(made.root);
    const host = fake(made, {
      sendId: () => SEND_ID,
      channelGraceMs: 500,
      native: {
        typeText: () => false,
        pressEnter: () => false,
        status: () => 'idle',
        paneText: () => null,
        wait: async () => {
          const id = readdirSync(dir).find((name) => MESSAGE_ID.test(name));
          if (id === undefined) return;
          recordChannelPush(dir, { v: 1, kind: 'channel-push', id, at: NOW.toISOString() });
          markChannelNotified(dir, id);
        },
      },
    } as never);
    const mark = join(made.root, '..', 'mark');
    writeFileSync(mark, '');
    const since = statSync(mark).mtimeMs;
    const code = await runSend(['lead', 'hello'], owner(made.root), host);
    expect(code).toBe(0);
    const base = join(made.root, '..');
    const written = [...writtenSince(made.dir, since, base), ...writtenSince(made.home, since, base)];
    if (process.env.SEND_DIET_LIST === '1') process.stderr.write(`${String(written.length)} files\n${written.join('\n')}\n`);
    expect(written.some((path) => path.endsWith(`${SEND_ID}.fallback.json`))).toBe(false);
    expect(written.some((path) => /fallback-attempts-.*\.jsonl$/.test(path))).toBe(false);
    expect(written.some((path) => path.endsWith('.unread.json'))).toBe(false);
    expect(written.some((path) => path.endsWith(SEND_ID))).toBe(true);
    expect(written.filter((path) => /(messages|events)\.jsonl$|team\.log$/.test(path)).map((path) => path.split('/').at(-1))).toEqual(['messages.jsonl']);
  });
});

// Step 4: the receiver's side of one channel push of a stamped copy, on an active root. The
// seat's own server (`team mcp serve`) pushes the record; every file it leaves is counted.
const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const STAMPED_ID = 'aaaaaaaa-0000-4000-8000-000000000401';

function servedPlace(): { root: string; home: string; dropDir: string; leadId: string; workerId: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-diet-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  const seat = (role: string, name: string, launch: string): string => `  - role: ${role}\n    name: ${name}\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: ${launch}\n`;
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1\nproject: acme\ncoordinator: lead\noperator: lead\nsession: ${SESSION}\nworkspace:\n  mode: shared\nseats:\n${seat('coordinator', 'lead', `claude ${FLAG}`)}${seat('worker', 'worker', 'claude')}`);
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {} } } })}\n`);
  const home = join(root, 'home');
  const teamId = teamIdOf(root);
  const agents = (['lead', 'worker'] as const).map((name) => registerAgent(home, {
    name,
    signing: { model: 'Test', version: '1', role: name === 'lead' ? 'coordinator' : 'worker' },
    lab: 'test', cli: 'claude-code', launcher: null,
    launch: name === 'lead' ? `claude ${FLAG}` : 'claude',
    reach: { team: teamId, seat: name, session: SESSION, pane: `pane-${name}`, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }));
  upsertTeam(home, teamId, { project: 'acme', session: SESSION, root, roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })) });
  cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, home, dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'), leadId: agents[0]!.id, workerId: agents[1]!.id };
}

async function until(check: () => boolean, limit = 400): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('the receiver writes one delivered line per copy', () => {
  test('one stamped channel push: the copy entry, and no push or emitted marker beside the record', async () => {
    const at = servedPlace();
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [{ kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 }] }).kind).toBe('activated');
    const replies: string[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const lines = (async function* () {
      while (!ended) await new Promise<void>((resolve) => { wake = resolve; });
    })();
    const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION }), { lines, write: (line: string) => replies.push(line) }, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const payload: RecordPayload = { kind: 'message', id: STAMPED_ID, to: 'lead', to_id: at.leadId, root: at.root, session: SESSION, at: new Date().toISOString(), body: 'hello', from: 'worker', from_id: at.workerId, rule: 'the owner', thread: STAMPED_ID };
      const signed = signRecord(stampedPayload(payload, at.home), at.home);
      const mark = join(at.root, 'mark');
      writeFileSync(mark, '');
      const since = statSync(mark).mtimeMs;
      expect(writeRecord(at.dropDir, signed).ok).toBe(true);
      const notified = () => replies.some((line) => line.includes('notifications/claude/channel'));
      await until(notified);
      expect(notified()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const written = writtenSince(join(at.root, '.agents'), since, at.root).filter((path) => !path.endsWith('team.log'));
      if (process.env.SEND_DIET_LIST === '1') process.stderr.write(`receiver: ${String(written.length)} files\n${written.join('\n')}\n`);
      const folder = seatMailDirs(at.root, SESSION, 'lead').stamped;
      expect(existsSync(join(folder, `${STAMPED_ID}.channel-push.json`))).toBe(false);
      expect(existsSync(join(folder, `${STAMPED_ID}.channel-emitted`))).toBe(false);
      expect(offeredCopies(folder, STAMPED_ID)).toHaveLength(1);
      expect(channelNotified(folder, STAMPED_ID)).toBe(true);
    } finally {
      ended = true;
      (wake as (() => void) | null)?.();
      await running;
    }
  });
});

describe('a stamped copy\'s live channel entry is its push marker', () => {
  test('emitted before the line, notified after it, retired by a mark, then the next copy is live', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-diet-copy-')));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    const id = STAMPED_ID;
    const held = { v: 1 as const, kind: 'channel-held' as const, id, at: NOW.toISOString(), reason: 'another leg' };
    expect(takeCopyNumber(dir, id, 'channel', Date.now(), { token: 'f'.repeat(32), listener: '1@then' })).toBe(1);
    // The entry is the emitted marker: the sender's fallback starts no other leg.
    expect([channelEmitted(dir, id), channelPushHeld(dir, id), channelPushed(dir, id), channelNotified(dir, id)]).toEqual([true, true, true, false]);
    expect(reserveChannelFallback(dir, held)).toBe('uncertain');
    expect(markChannelNotified(dir, id)).toBe(true);
    expect(channelNotified(dir, id)).toBe(true);
    expect(reserveChannelFallback(dir, held)).toBe('notified');
    // The offer token stays in the private entry, unchanged by the notified rewrite.
    expect(offeredCopies(dir, id)).toEqual([expect.objectContaining({ n: 1, token: 'f'.repeat(32), listener: '1@then' })]);
    // Nothing beside the record: no push, emitted or abort marker.
    expect(readdirSync(dir).filter((name) => name.startsWith(id))).toEqual([]);
    // The ladder's retirement leaves one mark; the copy stays counted, and is no longer live.
    expect(retireChannelAttempt(dir, id, 1_000)).toBe(true);
    expect([channelEmitted(dir, id), channelPushHeld(dir, id), channelNotified(dir, id)]).toEqual([false, false, false]);
    expect(copyHistory(dir, id)).toMatchObject({ copies: 1 });
    expect(firstRetiredRoundAborted(dir, id)).toBe(false);
    expect(takeCopyNumber(dir, id, 'channel')).toBe(2);
    expect([channelEmitted(dir, id), channelNotified(dir, id)]).toEqual([true, false]);
  });
});
