// Coverage: the wakeability reading `team status` and `team seats` print (src/status/wake.ts).
//
// The class is the one a send measures, read from the seat's own records; the facts beside it
// are what explains the class — a recorded endpoint with no bound conversation, a live inbox
// listener, and the oldest unread drop's age. Everything here is a synthetic world: a temporary
// team root and state folder, a registry home, one listener marker and one unsigned drop. No
// provider, no pane, no network.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeListener } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { seatWakeOf, wakeAge, wakeCell, type SeatWakeInput } from '../src/status/wake.ts';

const NOW = new Date('2026-11-01T10:00:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const HANDLE = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const ENDPOINT = 'unix:///private/tmp/wake-fixture/app-server.sock';
const DROP = '019a0000-4444-7555-8666-777788889999';

let base: string;
let root: string;
let dir: string;
let home: string;

const dropDir = (): string => join(dir, 'send-drops', SESSION, SEAT);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wake-'));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The registry record a managed Codex launch leaves for the seat, naming `agent_session`. */
function record(agentSession: string | null): void {
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'GPT Sol', version: '6.1', role: 'coordinator' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: 'pane-1',
      address: null,
      ...(agentSession === null ? {} : { agent_session: agentSession }),
    },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

/** The seat's runtime record: a codex seat whose managed launch recorded an endpoint under its
 *  current presence incarnation, and a state copy that names `agentSession` when given one. */
function state(agentSession?: string): NonNullable<SeatWakeInput['state']> {
  return {
    id: HANDLE,
    cli: 'codex',
    launch_line: 'codex -m gpt-6.1-sol',
    presence_binding: BINDING,
    codex_endpoint: { url: ENDPOINT, binding: BINDING, pid: 4242, started_at: NOW.toISOString() },
    ...(agentSession === undefined ? {} : { agent_session: agentSession }),
  };
}

function read(over: {
  declared?: SeatWakeInput['declared'];
  state?: SeatWakeInput['state'];
  home?: string | undefined;
} = {}) {
  return seatWakeOf({
    dir,
    root,
    session: SESSION,
    seat: SEAT,
    declared: over.declared ?? { cli: 'codex', launch: 'codex -m gpt-6.1-sol' },
    ...(over.state !== undefined ? { state: over.state } : {}),
    ...('home' in over ? { home: over.home } : { home }),
    now: NOW,
  });
}

test('a seat with no endpoint and no listener is unwakeable, and its cell is flagged', () => {
  const wake = read();
  expect(wake).toEqual({
    class: 'pull-on-turn',
    wakeable: false,
    conversation: false,
    endpoint: false,
    listener: false,
    unread: 0,
    oldest_unread_seconds: null,
  });
  // The `!` is the flag: a scan finds the seat a message cannot wake before the drop stacks up.
  expect(wakeCell(wake)).toBe('!pull-on-turn');
});

test('an endpoint with no bound conversation keeps the seat unwakeable, and the cell says why', () => {
  // The registry names the thread, and the state copy names none: exactly the records a
  // sessionless launch leaves, and the gap a send must not read as a wake.
  record(THREAD);
  const wake = read({ state: state() });
  expect(wake).toMatchObject({ class: 'pull-on-turn', wakeable: false, endpoint: true, conversation: false });
  expect(wakeCell(wake)).toBe('!pull-on-turn (endpoint, no bound conversation)');
});

test('an endpoint with a bound conversation is walked between turns', () => {
  record(THREAD);
  const wake = read({ state: state(THREAD) });
  expect(wake).toMatchObject({ class: 'between-turns', wakeable: true, endpoint: true, conversation: true });
  expect(wakeCell(wake)).toBe('between-turns');
});

test('a live listener and an unread drop are shown beside the class', () => {
  mkdirSync(dropDir(), { recursive: true });
  // A listener whose process is this one: alive, for this seat, session and root.
  expect(writeListener(dropDir(), {
    v: 1, seat: SEAT, session: SESSION, root, cli: 'codex', pid: process.pid, ts: NOW.toISOString(),
  })).toBe(true);
  // An unsigned drop is dated by the send's own marker: five minutes before the reading.
  writeFileSync(join(dropDir(), DROP), 'hello\n');
  writeFileSync(
    join(dropDir(), `${DROP}.pending`),
    `${JSON.stringify({ id: DROP, from: 'lead', ts: new Date(NOW.getTime() - 5 * 60_000).toISOString() })}\n`,
  );
  const wake = read();
  expect(wake).toMatchObject({ class: 'pull-on-turn', wakeable: false, listener: true, unread: 1, oldest_unread_seconds: 300 });
  expect(wakeCell(wake)).toBe('!pull-on-turn (inbox, unread 5m)');
});

test('a human seat is never woken, whatever its records say', () => {
  const wake = read({ declared: { cli: 'claude-code', launch: 'claude --model claude-opus-5-5', human: true } });
  expect(wake).toMatchObject({ class: 'none', wakeable: false });
  expect(wakeCell(wake)).toBe('!none');
});

test('the unread age is in the table\'s short words', () => {
  expect(wakeAge(30)).toBe('30s');
  expect(wakeAge(300)).toBe('5m');
  expect(wakeAge(7200)).toBe('2h');
  expect(wakeAge(172800)).toBe('2d');
});
