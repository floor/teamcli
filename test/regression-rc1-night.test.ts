// Five failures the RC1 night run found, pinned so they never return: a pane whose session
// holds a cross-session frame is never a delivered send; no send path dials a session's socket;
// a provider error the pane has scrolled past does not make an idle seat unreachable; a failed
// send is never seat activity; and a registry record binds a caller only where the call stands
// as it. Fixtures only: fake panes, a fake sockets folder and a temporary home. No live session
// is touched and no real socket is opened.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { showsHeldFrameDialog } from '../src/send/deliver.ts';
import { appendHistory, historyPath, readHistory } from '../src/send/history.ts';
import { messageTrace } from '../src/labels/traces.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { updateState } from '../src/state.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import { readScreen } from '../src/watch/screen.ts';
import { claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T05:00:00.000Z');
const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';

let made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seat(role: string, name: string): string {
  return `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

function teamYaml(root: string, lobby: string): string {
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
${seat('coordinator', 'lead')}${seat('implementer', 'helper')}# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

type World = { root: string; home: string; sockets: string };

/** One root with `.agents/team.yaml`, a home for the registry and the send history, and a
 *  sockets folder no fake write may touch. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rc1-night-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml(root, lobbyDir(home)));
  return { root, home, sockets };
}

type Fake = SendHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
  frames: string[];
  dials: () => number;
};

type View = {
  /** The pane's screen before a line is typed. */
  idle: string;
  /** The screen once the trigger sits in the box; absent keeps `idle` on every read. */
  typed?: (line: string) => string;
  /** herdr's status once Enter is pressed; `idle` keeps it where it was. */
  after?: string;
};

/** The host every send-side scene is handed: `deliver` is the socket, and it counts the attempt
 *  before throwing, so a path that dials fails loudly and a path that swallows the failure still
 *  shows up in the count. The pane walks one scripted view. */
function fake(w: World, view: View): Fake {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  let dials = 0;
  return {
    typed,
    enters,
    frames,
    dials: () => dials,
    agents: () => [
      { name: 'lead', pane: 'w1:p1' },
      { name: 'helper', pane: 'w1:p2' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async (_socketPath: string, frame: string): Promise<SendOutcome> => {
      dials += 1;
      frames.push(frame);
      throw new Error('the socket was dialed');
    },
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        return true;
      },
      status: () => (enters.length > 0 ? (view.after ?? 'idle') : 'idle'),
      wait: async () => {},
      paneText: () => {
        const last = typed[typed.length - 1];
        if (view.typed && last !== undefined) return enters.length > 0 ? view.idle : view.typed(last.text);
        return view.idle;
      },
    },
    now: () => NOW,
    home: w.home,
  };
}

/** The dialog a busy Claude Code session shows for a cross-session frame, and the same title
 *  wrapped mid-sentence inside its frame. */
const HELD_DIALOG = [
  '╭──────────────────────────────────────╮',
  '│ Held message from another session    │',
  '│ a cross-session frame is waiting for │',
  '│ you to let it through                │',
  '╰──────────────────────────────────────╯',
].join('\n');
const HELD_WRAPPED = '╭ Held message from\n│ another session\n╰──────────────';
const QUIET = claudeBox('');

/** The held-message dialog as a live Claude Code 2.1.302 pane drew it (the capture in
 *  `fixtures/claude-code/2.1.302/held.txt`): the transcript row naming the held message, then the
 *  dialog with its two choices — and no composer under it. */
const HELD_REAL = readFileSync(new URL('./fixtures/claude-code/2.1.302/held.txt', import.meta.url), 'utf8');

/** A live composer under a transcript row that quotes the dialog's sentence — our own drops, docs
 *  and tests print it. The box reader sees the composer, so this screen is not the dialog. */
const QUOTE_ABOVE_BOX = [
  "⏺ the seat was told: don't send while 'Held message from another session' is up",
  claudeBox(''),
].join('\n');

/** The field report's pane: a seat idle at its prompt, and a "connection lost" line two turns
 *  above it — the sentence the pane has scrolled past, not the newest turn. */
const OLD_ERROR = [
  '❯ first task',
  '',
  '⏺ First task done.',
  '',
  LOST,
  '',
  '✻ Sautéed for 2s · done 5:25 PM',
  '',
  '❯ second task',
  '',
  '⏺ Second task done as well.',
  '',
  claudeBox(''),
].join('\n');

const owner = (root: string) => testIo(root, { kind: 'owner' });

function lastOutcome(w: World, seatName: string): string | undefined {
  const read = readHistory('acme', w.root, w.home);
  if (!read.ok) return undefined;
  return read.entries.filter((entry) => entry.to === seatName).at(-1)?.outcome;
}

describe('a pane the session holds at its cross-session frame is never a delivered send', () => {
  test('the held-frame dialog is read in both drawn shapes, and a quiet screen is not', () => {
    expect(showsHeldFrameDialog(HELD_DIALOG)).toBe(true);
    expect(showsHeldFrameDialog(HELD_WRAPPED)).toBe(true);
    expect(showsHeldFrameDialog(QUIET)).toBe(false);
  });

  test('the send is not delivered, and its history line does not say so either', async () => {
    const w = world();
    const host = fake(w, { idle: HELD_DIALOG });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.out).not.toContain('delivered');
    expect(host.dials()).toBe(0);
    expect(lastOutcome(w, 'lead')).not.toBe('delivered');
  });

  test('the live capture is the dialog because no composer is under it, and a quote above a box is not', () => {
    expect(showsHeldFrameDialog(HELD_REAL)).toBe(true);
    expect(readScreen('claude-code', HELD_REAL).kind).toBe('unknown');
    // The same sentence quoted in the transcript, with a live composer under it, is not the
    // dialog: the box reader sees the box.
    expect(showsHeldFrameDialog(QUOTE_ABOVE_BOX)).toBe(true);
    expect(readScreen('claude-code', QUOTE_ABOVE_BOX).kind).toBe('idle');
  });

  test('a send to a live box under a quoted sentence is sent, not taken for the dialog', async () => {
    const w = world();
    const typed = (line: string) => [QUOTE_ABOVE_BOX.split('\n')[0] as string, claudeBox(line)].join('\n');
    const host = fake(w, { idle: QUOTE_ABOVE_BOX, typed, after: 'working' });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(host.typed).toHaveLength(1);
    expect(host.typed[0]?.pane).toBe('w1:p1');
    // The typed wake is the message-display line: the sender, the body's first line, the fixed
    // read hint. It opens the same header every transport carries.
    expect(host.typed[0]?.text).toBe('Message from owner (owner@acme): hello Read it with: team drops --read.');
    expect(host.enters).toEqual(['w1:p1']);
    expect(host.dials()).toBe(0);
  });

  test('the captured held dialog stops the send before anything is typed', async () => {
    const w = world();
    const host = fake(w, { idle: HELD_REAL });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.out).not.toContain('delivered');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(lastOutcome(w, 'lead')).not.toBe('delivered');
  });
});

describe('no send path dials a session socket', () => {
  test('a plain send takes the typed trigger and never calls the socket', async () => {
    const w = world();
    const host = fake(w, { idle: QUIET, typed: (line) => claudeBox(line), after: 'working' });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    expect(host.typed).toHaveLength(1);
    expect(host.enters).toEqual(['w1:p1']);
  });

  test('--wait walks the delivery order and waits on the thread, dialing nothing', async () => {
    const w = world();
    const host = { ...fake(w, { idle: QUIET, typed: (line) => claudeBox(line), after: 'working' }), waitMs: 0 };
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    expect(host.typed).toHaveLength(1);
  });
});

describe('a provider error in the scrollback does not make an idle seat unreachable', () => {
  test('the send types the trigger and is reported sent; the old error is not the live screen', async () => {
    const w = world();
    const host = fake(w, {
      idle: OLD_ERROR,
      typed: (line) => OLD_ERROR.replace(claudeBox(''), claudeBox(line)),
      after: 'working',
    });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(io.err).toBe('');
    expect(host.typed).toHaveLength(1);
  });
});

describe('a failed send is no seat activity', () => {
  test('the message trace keeps the last send the seat took, passing over every failed outcome', () => {
    const w = world();
    const line = (outcome: string, ts: string) => appendHistory('acme', w.root, w.home, { ts, from: 'orchestrator', to: 'lead', body: 'a body', id: ts, outcome, ms: 1 });
    line('delivered', '2026-10-17T08:00:00Z');
    line('answered', '2026-10-17T08:30:00Z');
    line('unreachable', '2026-10-17T09:15:00Z');
    line('not-submitted', '2026-10-17T09:20:00Z');
    line('held', '2026-10-17T09:25:00Z');
    line('timeout', '2026-10-17T09:30:00Z');

    expect(messageTrace('acme', w.root, 'lead', w.home)).toEqual({
      kind: 'ack',
      at: '2026-10-17T08:30:00Z',
      what: 'answered a message from orchestrator',
    });
  });

  test('a seat the send never reached reads as idle, not working', () => {
    const w = world();
    // No delivered or answered line at all: every entry names a send that failed.
    appendHistory('acme', w.root, w.home, { ts: '2026-10-17T09:30:00Z', from: 'orchestrator', to: 'lead', body: 'a body', id: 'one', outcome: 'held', ms: 1 });

    expect(messageTrace('acme', w.root, 'lead', w.home)).toBeNull();
  });
});

/** One agent record, as `up`/`add` would have registered it. */
function record(w: World, seatName: 'lead' | 'helper', role: string, pane: string): Agent {
  return registerAgent(w.home, {
    name: seatName,
    signing: { model: 'Claude Opus', version: '5.5', role },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model test',
    reach: { team: teamIdOf(w.root), seat: seatName, session: 'acme', pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. */
function place(w: World, seatName: string, pane: string): void {
  updateState(join(w.root, '.agents'), (state) => {
    const seats = state.sessions['acme']?.seats ?? {};
    state.sessions['acme'] = {
      seats: { ...seats, [seatName]: { stage: 'launched', pane, workspace: 'w1' } },
      worktrees: state.sessions['acme']?.worktrees ?? {},
    };
  });
}

/** The acme world with both seats registered and placed, the record a send must bind to. */
function registered(): World {
  const w = world();
  const id = teamIdOf(w.root);
  const lead = record(w, 'lead', 'coordinator', 'w1:p1');
  const helper = record(w, 'helper', 'implementer', 'w1:p2');
  upsertTeam(w.home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: w.root,
    lobby: lobbyDir(w.home),
    roster: [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
  });
  place(w, 'lead', 'w1:p1');
  place(w, 'helper', 'w1:p2');
  return w;
}

describe('a registry record binds a caller only where the call stands as it', () => {
  test("a pane renamed to a registered seat's name is refused before anything is written", async () => {
    const w = registered();
    const host = fake(w, { idle: QUIET });
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w9:p9', session: 'acme' };
    const io = testIo(w.root, caller);

    const code = await runSend(['helper', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe(
      "team send: refused: the registry records pane w1:p1 for seat lead in session acme, and this call is on pane w9:p9: a pane renamed to a seat's name is not that seat\n",
    );
    expect(host.typed).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
  });

  test('a caller of the same name in another session is refused too', async () => {
    const w = registered();
    const host = fake(w, { idle: QUIET });
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'beta' };
    const io = testIo(w.root, caller);

    const code = await runSend(['helper', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('a caller of another session is not that seat');
    expect(host.typed).toEqual([]);
  });

  test('the same caller where its record and the state both place it is admitted', async () => {
    const w = registered();
    const host = fake(w, { idle: QUIET, typed: (line) => claudeBox(line), after: 'working' });
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };

    const code = await runSend(['helper', 'hello'], testIo(w.root, caller), host);

    expect(code).toBe(0);
    expect(host.typed).toHaveLength(1);
    expect(host.typed[0]?.pane).toBe('w1:p2');
    // The trigger is the message-display line — sender, the body's first line as the summary,
    // the fixed read hint — never the signed body and never a path the composer names.
    expect(host.typed[0]?.text).toBe('Message from lead (lead@acme): hello Read it with: team drops --read.');
    expect(lastOutcome(w, 'helper')).toBe('sent (unconfirmed)');
  });
});
