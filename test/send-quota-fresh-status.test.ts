// Synthetic screens and hosts only. The active typed wake uses an injected in-memory host;
// the legacy trigger remains retired, and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { quotaFor } from '../src/profiles/profile.ts';
import { figuresOf } from '../src/profiles/quota.ts';
import { requestDaemon, startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { dialogKind } from '../src/send/deliver.ts';
import { quotaOutOf } from '../src/send/quota-out.ts';
import { readHistory } from '../src/send/history.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { storePath } from '../src/store/store.ts';
import { readScreen, screenWord, statusRow } from '../src/watch/screen.ts';
import { claudeBox } from './helpers.ts';
import { dropDir, fake, owner, quietNative, world, type World } from './send-native-fixtures.ts';

const LIMIT = 'You’ve hit your usage limit for 5h. Switch to another model now, or try again at 3:05 PM.';
const RESET = { kind: 'at', value: '3:05 PM' } as const;
const PANE = 'synthetic-recipient-pane';
const FULL = '  GPT-6.1-Sol ultra · Context 100% left · weekly 100% left';
const EMPTY = '  GPT-6.1-Sol ultra · Context 100% left · weekly 0% left';
const UNREADABLE = '  Remaining quota: weekly 100% left';

function frame(row: string | null, history = false): string {
  return [
    ...(history ? ['Previous response:', '', LIMIT] : [LIMIT]),
    '',
    '› ',
    '',
    ...(row === null ? [] : [row]),
  ].join('\n');
}

const cleanups: Array<() => void> = [];
const handles: SendDaemonHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(): World {
  const made = world(['typed']);
  cleanups.push(made.cleanup);
  return made;
}

function paneHost(made: World, initial: string) {
  let screen = initial;
  const reads: Array<{ session: string; pane: string }> = [];
  const writes: string[] = [];
  const typed: Array<{ pane: string; text: string }> = [];
  const entered: string[] = [];
  const wakeReads: string[] = [];
  const wake: TypedWakeHost = {
    read: (pane) => {
      wakeReads.push(pane);
      if (entered.length > 0) return ['• Working (esc to interrupt)', '', '› ', '', FULL].join('\n');
      const line = typed.at(-1)?.text;
      return line === undefined ? screen : screen.replace(/^›\s*$/m, `› ${line}`);
    },
    type: (pane, text) => { typed.push({ pane, text }); return true; },
    enter: (pane) => { entered.push(pane); return true; },
    wait: async () => {},
  };
  const host = fake(made, {
    agents: () => [{ name: 'native', pane: PANE }],
    native: {
      ...quietNative(),
      status: () => 'idle',
      paneText: (session, pane) => {
        reads.push({ session, pane });
        return screen;
      },
      typeText: () => { writes.push('type'); throw new Error('unexpected pane write'); },
      pressEnter: () => { writes.push('enter'); throw new Error('unexpected pane write'); },
    },
    typedWake: (session) => {
      expect(session).toBe('acme');
      return wake;
    },
  });
  return { host, reads, writes, typed, entered, wakeReads, show: (next: string) => { screen = next; } };
}

async function daemonFor(made: World, host: DaemonHost) {
  const loaded = loadTeamFile(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('synthetic team did not load');
  // Keep the endpoint address short even when the gate's synthetic home has a long path.
  const socketDir = mkdtempSync('/tmp/send-quota-socket-');
  cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));
  const home = join(socketDir, 'home');
  mkdirSync(home);
  const started = await startSendDaemon({
    root: made.root, dir: made.dir, team: loaded.team,
    host: { ...host, home, deliverWaitMs: 1, pollReadyMs: 1 },
    socketPath: join(socketDir, 'daemon.sock'),
    alive: () => true,
  });
  if (started.kind !== 'serving') throw new Error(started.kind);
  handles.push(started.handle);
  return { team: loaded.team, home, socketPath: started.handle.socketPath };
}

describe('a fresh quota reading on the same pane', () => {
  test('the newer positive status replaces the earlier quota-out classification', () => {
    const before = frame(EMPTY);
    const after = frame(FULL);
    expect(quotaOutOf('codex', before)).toEqual({ reset: RESET });
    expect(dialogKind('codex', before)).toBe('rate limit');
    expect(statusRow('codex', after)).toBe(FULL);
    expect(quotaOutOf('codex', after)).toBeNull();
    expect(dialogKind('codex', after)).toBeNull();
    expect(readScreen('codex', after)).toEqual({ kind: 'idle' });
    // The replacement does not mutate a cached reading or clear another pane's wall.
    expect(quotaOutOf('codex', before)).toEqual({ reset: RESET });
  });

  for (const [name, row] of [
    ['zero quota', EMPTY],
    ['no status row', null],
    ['a quota sentence outside the profile status grammar', UNREADABLE],
  ] as const) {
    test(`${name} preserves the quota wall and dialog guard`, () => {
      const screen = frame(row);
      expect(quotaOutOf('codex', screen)).toEqual({ reset: RESET });
      expect(dialogKind('codex', screen)).toBe('rate limit');
      expect(readScreen('codex', screen)).toEqual({ kind: 'rate limit', reset: RESET });
      if (row !== EMPTY) expect(statusRow('codex', screen)).toBeNull();
    });
  }

  test('a quota-looking transcript row cannot replace an exhausted status row', () => {
    const screen = [FULL, '', frame(EMPTY)].join('\n');
    expect(statusRow('codex', screen)).toBe(EMPTY);
    expect(quotaOutOf('codex', screen)).toEqual({ reset: RESET });
    expect(dialogKind('codex', screen)).toBe('rate limit');
  });

  test('a positive status row without a current prompt keeps the quota wall', () => {
    const screen = [LIMIT, '', FULL].join('\n');
    expect(readScreen('codex', screen)).toEqual({ kind: 'rate limit', reset: RESET });
    expect(quotaOutOf('codex', screen)).toEqual({ reset: RESET });
    expect(dialogKind('codex', screen)).toBe('rate limit');
  });

  for (const [empty, sessionUsed, weeklyUsed] of [
    ['five-hour', 100, 20],
    ['weekly', 20, 100],
  ] as const) {
    test(`an exhausted ${empty} window keeps its wall despite headroom in the other window`, () => {
      const screen = [
        'API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00',
        claudeBox(''),
        ` L: ${sessionUsed}% (1h) · W: ${weeklyUsed}% (40h)`,
      ].join('\n');
      const figures = figuresOf(quotaFor('claude-code'), statusRow('claude-code', screen));
      expect(figures).toEqual(expect.arrayContaining([
        expect.objectContaining({ window: 'session', left: 100 - sessionUsed }),
        expect.objectContaining({ window: 'weekly', left: 100 - weeklyUsed }),
      ]));
      expect(quotaOutOf('claude-code', screen)).toEqual({ reset: { kind: 'at', value: '11:00' } });
      expect(readScreen('claude-code', screen).kind).toBe('rate limit');
      expect(dialogKind('claude-code', screen)).toBe('rate limit');
    });
  }
});

describe('send preflight with a synthetic recipient', () => {
  test('after refusal a fresh row on the same pane permits a signed inbox delivery', async () => {
    const made = fixture();
    const pane = paneHost(made, frame(EMPTY));
    const refused = owner(made.root);
    expect(await runSend(['native', 'first note'], refused, pane.host)).toBe(1);
    expect(refused.err).toContain('quota out');
    expect(existsSync(dropDir(made.dir))).toBe(false);
    expect(pane.typed).toEqual([]);
    expect(pane.entered).toEqual([]);
    expect(pane.wakeReads).toEqual([]);

    pane.show(frame(FULL));
    const accepted = owner(made.root);
    expect(await runSend(['native', 'fresh note'], accepted, pane.host)).toBe(0);
    expect(accepted.err).not.toContain('quota out');
    expect(accepted.out).toContain('native: delivered (typed wake)');
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]?.pane).toBe(PANE);
    expect(pane.typed[0]?.text).toContain('team drops --read');
    expect(pane.entered).toEqual([PANE]);
    expect(pane.wakeReads.length).toBeGreaterThanOrEqual(4);
    expect(pane.wakeReads.every((pane) => pane === PANE)).toBe(true);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'native', outcome: 'delivered (typed wake)', via: 'typed' });
    }
    const drops = dropDir(made.dir);
    const messages = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(messages).toHaveLength(1);
    const id = messages[0]!;
    const read = readMessage({ root: made.root, dropDir: drops, session: 'acme', seat: 'native' }, id, made.home);
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).toContain('fresh note');
    expect(JSON.stringify(read)).not.toContain('first note');
    expect(existsSync(join(drops, `${id}.read.json`))).toBe(true);
    expect(pane.reads.length).toBeGreaterThanOrEqual(2);
    expect(pane.reads.every((read) => read.session === 'acme' && read.pane === PANE)).toBe(true);
    expect(pane.host.frames).toEqual([]);
    expect(pane.writes).toEqual([]);
  });

  for (const [name, row] of [
    ['zero quota', EMPTY],
    ['no status row', null],
    ['an unreadable status row', UNREADABLE],
  ] as const) {
    test(`${name} refuses before staging a message or reaching a transport`, async () => {
      const made = fixture();
      const pane = paneHost(made, frame(row));
      const io = owner(made.root);
      expect(await runSend(['native', 'held note'], io, pane.host)).toBe(1);
      expect(io.err).toContain('quota out');
      expect(io.err).toContain('resets at 3:05 PM; nothing was sent');
      expect(io.out).toBe('');
      expect(existsSync(dropDir(made.dir))).toBe(false);
      expect(pane.host.frames).toEqual([]);
      expect(pane.writes).toEqual([]);
      expect(pane.typed).toEqual([]);
      expect(pane.entered).toEqual([]);
      expect(pane.wakeReads).toEqual([]);
    });
  }

  test('historical usage-limit text above a fresh idle prompt permits send', async () => {
    const made = fixture();
    const pane = paneHost(made, frame(FULL, true));
    const io = owner(made.root);
    expect(await runSend(['native', 'new turn'], io, pane.host)).toBe(0);
    expect(io.err).not.toContain('quota out');
    expect(io.out).toContain('native: delivered (typed wake)');
    expect(pane.typed).toHaveLength(1);
    expect(pane.entered).toEqual([PANE]);
    const messages = readdirSync(dropDir(made.dir)).filter((name) => !name.includes('.'));
    expect(messages).toHaveLength(1);
    expect(pane.writes).toEqual([]);
  });
});

describe('the restart and status screen reading', () => {
  test('an earlier usage limit is history when the current idle prompt has quota left', () => {
    const screen = readScreen('codex', frame(FULL, true));
    expect(screen).toEqual({ kind: 'idle' });
    expect(screenWord(screen)).toBe('idle');
    expect(dialogKind('codex', frame(FULL, true))).toBeNull();
  });

  for (const [name, row] of [['zero quota', EMPTY], ['no readable row', null]] as const) {
    test(`history without a newer positive reading stays blocked with ${name}`, () => {
      const screen = readScreen('codex', frame(row, true));
      expect(screen).toEqual({ kind: 'rate limit', reset: RESET });
      expect(screenWord(screen)).toBe('blocked');
    });
  }
});

describe('the daemon quota preflight', () => {
  test('a fresh row passes both daemon quota guards and reaches the independent presence hold', async () => {
    const made = fixture();
    const pane = paneHost(made, frame(FULL));
    const daemon = await daemonFor(made, pane.host);
    const answer = await requestDaemon(daemon.socketPath, {
      v: 1, op: 'send', from: 'owner', to: 'native', body: 'fresh daemon note',
    });
    expect(answer && 'outcome' in answer ? answer.outcome : null).toBe('held');
    expect(answer && 'detail' in answer ? answer.detail : '').toContain('native presence');
    expect(answer && 'detail' in answer ? answer.detail : '').not.toContain('rate limit');
    expect(existsSync(join(storePath(daemon.team.project, made.root, daemon.home), 'drops'))).toBe(true);
    expect(pane.reads.length).toBeGreaterThanOrEqual(3);
    expect(pane.writes).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(pane.entered).toEqual([]);
  });

  for (const [name, row] of [['zero quota', EMPTY], ['no readable row', null]] as const) {
    test(`${name} refuses without a staged daemon drop`, async () => {
      const made = fixture();
      const pane = paneHost(made, frame(row));
      const daemon = await daemonFor(made, pane.host);
      const answer = await requestDaemon(daemon.socketPath, {
        v: 1, op: 'send', from: 'owner', to: 'native', body: 'daemon note',
      });
      expect(answer && 'outcome' in answer ? answer.outcome : null).toBe('refused');
      expect(answer && 'detail' in answer ? answer.detail : '').toContain('quota out');
      expect(existsSync(join(storePath(daemon.team.project, made.root, daemon.home), 'drops'))).toBe(false);
      expect(pane.writes).toEqual([]);
      expect(pane.host.frames).toEqual([]);
    });
  }
});
