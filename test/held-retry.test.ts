// A held send, retried by the watch once the seat is free.
//
// `team send` writes the drop before it types the trigger. A composer holding a person's draft
// makes the send exit `held`, and a seat that never takes the trigger makes it `not-submitted`:
// both leave the drop on disk with a marker beside it, and the watch's next passes deliver it —
// never by typing over the text that held it, and never for longer than the record's bounds.
// The pane here is a scripted screen; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { readHistory } from '../src/send/history.ts';
import { dropMessage, triggerLine, type NativePane } from '../src/send/native.ts';
import {
  markPending,
  PENDING_MAX_AGE_MS,
  PENDING_MAX_TRIES,
  pendingDropPath,
  readPending,
  type PendingDrop,
} from '../src/send/pending.ts';
import type { Live } from '../src/status/compare.ts';
import { retryHeldDrops, type RetrySources } from '../src/watch/retry.ts';
import { claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T04:00:00.000Z');
const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
// A question the agent asked: the classifier's last-line footer makes it a dialog, never a box
// the send may type into or press Enter on.
const QUESTION_SCREEN = [
  '☐ Scope',
  'Which file should we edit?',
  '❯ 1. src/index.ts',
  '  2. src/cli.ts',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamText(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

type World = { root: string; dir: string; home: string; sockets: string; cleanup: () => void };

function world(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-held-retry-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), home, sockets, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A pane this test scripts: the screen it shows, the status it reports, and whether an Enter
 *  actually submits. `typed` and `enters` are the calls it received. */
type Pane = {
  screen: string | null;
  status: string;
  submits: boolean;
  typed: string[];
  enters: number;
};

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, submits: true, typed: [], enters: 0 };
}

function scripts(one: Pane): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      one.screen = claudeBox(text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      if (one.submits) {
        one.status = 'working';
        one.screen = claudeBox('');
      }
      return true;
    },
    sleep: async () => {},
  };
}

function liveWith(name: string, paneId: string, status = 'idle'): Live {
  const agents: HerdrAgent[] = [
    { name, agent: 'claude', pane: paneId, workspace: 'first', status, cwd: null },
    // A busy coordinator, so the pass has no idle stretch of its own to report.
    { name: null, agent: 'claude', pane: 'lead:pane', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function teamOf(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** A drop and its record, as a held send leaves them. */
function seedHeld(dir: string, session: string, seat: string, id: string, body: string, ts = NOW): string {
  const dropDir = join(dir, 'send-drops', session, seat);
  const path = dropMessage(dropDir, id, body);
  markPending(dropDir, { id, from: 'owner', to: seat, body, ts: ts.toISOString() });
  return dropDir;
}

describe('retryHeldDrops', () => {
  test('never types into a box that holds someone else\'s text, and delivers once it is free', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made.dir, 'acme', 'lead', 'drop-1', 'from the owner\n\nhello');
    const one = pane(claudeBox('a draft only its author can send'));
    const said: string[] = [];
    const at = {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team,
      live: liveWith('lead', 'w1:p1'),
      ownPane: null,
      sources: scripts(one),
      now: NOW,
      say: (text: string) => said.push(text),
    };

    await retryHeldDrops(at);
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);

    one.screen = claudeBox('');
    await retryHeldDrops(at);
    expect(one.typed).toEqual([triggerLine(join(dropDir, 'drop-1')) as string]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    expect(readFileSync(join(dropDir, 'drop-1'), 'utf8')).toBe('from the owner\n\nhello');
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner\n\nhello',
        id: 'drop-1',
        outcome: 'delivered',
        via: 'typed',
      },
    ]);
    expect(said).toEqual(['lead: a held send from owner was delivered on retry']);
  });

  test('a trigger left unsent in the box is submitted, never typed over', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made.dir, 'acme', 'lead', 'drop-2', 'from the owner\n\nagain');
    const line = triggerLine(join(dropDir, 'drop-2')) as string;
    const one = pane(claudeBox(line));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual(['lead: a held send from owner was delivered on retry']);
  });

  test('is bounded: after three tries the drop path is said and the record is gone', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made.dir, 'acme', 'lead', 'drop-3', 'from the owner\n\nstuck');
    // The Enter is taken but nothing changes: the trigger stays in the box and the status stays
    // idle, so every retry ends not-submitted.
    const one = pane(claudeBox(''));
    one.submits = false;
    const said: string[] = [];
    const at = {
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    };

    await retryHeldDrops(at);
    await retryHeldDrops(at);
    expect(readPending(dropDir)[0]?.tries).toBe(2);
    expect(said).toEqual([]);

    await retryHeldDrops(at);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('the drop file is at');
    expect(said[0]).toContain(join(dropDir, 'drop-3'));
    expect(said[0]).toContain('send it again');
    expect(said[0]).toContain(`in ${PENDING_MAX_TRIES} tries`);

    // With no record left, the watch types nothing more.
    const typed = one.typed.length;
    await retryHeldDrops(at);
    expect(one.typed.length).toBe(typed);
  });

  test('a record older than the window is given up on without a keystroke', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const old = new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 60_000);
    const dropDir = seedHeld(made.dir, 'acme', 'lead', 'drop-4', 'from the owner\n\nold', old);
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual([
      `lead: a held send from owner was not delivered (the retry window passed); the drop file is at ${join(dropDir, 'drop-4')}; send it again`,
    ]);
  });

  test('a seat that vanished still ages out its record, with no pane to read', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const old = new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 60_000);
    const dropDir = seedHeld(made.dir, 'acme', 'lead', 'drop-gone-seat', 'from the owner\n\nvanished', old);
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: { running: true, agents: [], workspaces: [], screens: {} },
      ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual([
      `lead: a held send from owner was not delivered (the retry window passed); the drop file is at ${join(dropDir, 'drop-gone-seat')}; send it again`,
    ]);
  });

  test('a record whose drop file is gone is given up on, not typed', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made.dir, 'acme', 'lead', 'drop-missing', 'from the owner\n\nlost');
    rmSync(join(dropDir, 'drop-missing'));
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual([
      `lead: a held send from owner was not delivered (its drop file is gone from ${dropDir}); send it again`,
    ]);
  });
});

describe('team send leaves the record the retry reads', () => {
  test('a send held by a draft writes the marker, and the watch delivers it once the box is free', async () => {
    const made = world();
    const one = pane(claudeBox('a draft only its author can send'));
    const native: NativePane = {
      typeText: (_session, _pane, text) => { one.typed.push(text); one.screen = claudeBox(text); return true; },
      pressEnter: () => { one.enters += 1; return true; },
      status: () => one.status,
      wait: async () => {},
      paneText: () => one.screen,
    };
    const host: SendHost = {
      agents: () => [{ name: 'lead', pane: 'w1:p1' }],
      processInfo: () => ({ shell: 111, foreground: [222] }),
      socketsDir: made.sockets,
      deliver: async () => ({ ok: true }),
      native,
      now: () => NOW,
      home: made.home,
    };
    const io = testIo(made.root, { kind: 'owner' });

    const code = await runSend(['lead', 'hello'], io, host);
    expect(code).toBe(1);
    expect(io.err).toContain('held: the composer already holds unsent text');
    expect(io.err).toContain('the drop file is at');
    expect(io.err).toContain('a running watch retries it when the seat is idle');
    expect(one.typed).toEqual([]);

    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const drops = readPending(dropDir);
    expect(drops).toHaveLength(1);
    const drop = drops[0] as PendingDrop;
    expect(drop).toMatchObject({ from: 'owner', to: 'lead', tries: 0, ts: NOW.toISOString() });
    expect(drop.body).toContain('hello');
    expect(readFileSync(join(dropDir, drop.id), 'utf8')).toBe(drop.body);
    expect(pendingDropPath(dropDir, drop.id)).toContain(drop.id);

    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    one.screen = claudeBox('');
    const said: string[] = [];
    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });
    expect(one.typed).toEqual([triggerLine(join(dropDir, drop.id)) as string]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.map((entry) => entry.outcome)).toEqual(['held', 'delivered']);
    expect(history.entries[1]?.id).toBe(drop.id);
  });

  test('a send stopped by a dialog writes the record, and the watch delivers it once the seat is idle', async () => {
    const made = world();
    const one = pane(claudeBox(''));
    // The composer is empty when the line is typed; the question is up by the read-back.
    const native: NativePane = {
      typeText: (_session, _pane, text) => { one.typed.push(text); one.screen = QUESTION_SCREEN; return true; },
      pressEnter: () => { one.enters += 1; return true; },
      status: () => one.status,
      wait: async () => {},
      paneText: () => one.screen,
    };
    const host: SendHost = {
      agents: () => [{ name: 'lead', pane: 'w1:p1' }],
      processInfo: () => ({ shell: 111, foreground: [222] }),
      socketsDir: made.sockets,
      deliver: async () => ({ ok: true }),
      native,
      now: () => NOW,
      home: made.home,
    };
    const io = testIo(made.root, { kind: 'owner' });

    const code = await runSend(['lead', 'hello'], io, host);
    expect(code).toBe(1);
    expect(io.err).toContain('unreachable now (the screen reads question); a running watch retries it when the seat is idle');
    expect(io.err).toContain('the drop file is at');
    // A dialog is nobody's to submit: the Enter stays unspent.
    expect(one.enters).toBe(0);

    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const drops = readPending(dropDir);
    expect(drops).toHaveLength(1);
    const drop = drops[0] as PendingDrop;
    expect(drop).toMatchObject({ from: 'owner', to: 'lead', tries: 0 });
    expect(readFileSync(join(dropDir, drop.id), 'utf8')).toBe(drop.body);

    // Once the prompt is answered the seat is free, and the watch delivers the drop.
    one.screen = claudeBox('');
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const said: string[] = [];
    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(readPending(dropDir)).toEqual([]);
    expect(one.typed).toEqual([triggerLine(join(dropDir, drop.id)) as string, triggerLine(join(dropDir, drop.id)) as string]);
    expect(one.enters).toBe(1);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.map((entry) => entry.outcome)).toEqual(['unreachable', 'delivered']);
    expect(said).toEqual(['lead: a held send from owner was delivered on retry']);
  });
});

describe('team watch retries a held drop', () => {
  test('the next pass types the trigger once the seat is idle', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'team-held-watch-')));
    base = directory;
    execFileSync('git', ['init', '-q'], { cwd: directory });
    mkdirSync(join(directory, '.agents'));
    const file = join(directory, '.agents', 'team.yaml');
    writeFileSync(file, raw);
    const dropDir = join(directory, '.agents', 'send-drops', 'acme-web', 'deepseek-acme');
    const clock = Date.parse('2026-10-03T14:00:00Z');
    const body = 'from the owner\n\nwatched';
    dropMessage(dropDir, 'drop-5', body);
    markPending(dropDir, { id: 'drop-5', from: 'owner', to: 'deepseek-acme', body, ts: new Date(clock - 60_000).toISOString() });

    const one = pane(claudeBox(''));
    const typed: string[] = [];
    const sources: WatchSources = {
      live: () => liveWith('deepseek-acme', 'first:pane'),
      machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => one.screen,
      status: () => one.status,
      foreground: () => ['claude'],
      typeText: (_pane, text) => { typed.push(text); one.screen = claudeBox(text); return true; },
      pressEnter: () => { one.enters += 1; one.status = 'working'; one.screen = claudeBox(''); return true; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: directory,
    };

    const io = testIo(directory, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources);

    expect(code).toBe(0);
    const line = triggerLine(join(dropDir, 'drop-5')) as string;
    expect(typed).toEqual([line]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    expect(io.out).toContain('deepseek-acme: a held send from owner was delivered on retry');
    const history = readHistory('acme-web', directory, directory);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.at(-1)).toMatchObject({ id: 'drop-5', outcome: 'delivered', via: 'typed' });
  });
});
