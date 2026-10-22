// A held send, retried by the watch once the seat is free.
//
// `team send` writes the drop before it types the trigger. A composer holding a person's draft
// makes the send exit `held`, and a seat that never takes the trigger makes it `not-submitted`:
// both leave the drop on disk with a marker beside it, and the watch's next passes deliver it —
// never by typing over the text that held it, and never for longer than the record's bounds.
// A pane back at its shell is refused as the typed leg and the daemon refuse it: no keystroke,
// the reason said, the drop kept.
// The pane here is a scripted screen; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDrops } from '../src/commands/drops.ts';
import { listUnacked, plantMessage } from '../src/commands/messages.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { installCliHooks } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { readHistory } from '../src/send/history.ts';
import { dropMessage, readTriggerLine, type NativePane } from '../src/send/native.ts';
import {
  clearPending,
  markPending,
  PENDING_MAX_AGE_MS,
  PENDING_MAX_TRIES,
  pendingDropPath,
  readPending,
  type PendingDrop,
} from '../src/send/pending.ts';
import { signRecord, signReceiptPayload, signedReceiptOf, verifyReceipt, writeReceipt } from '../src/send/record.ts';
import { markTaken, readTaken, TAKEN_IDLE_GRACE_MS } from '../src/send/taken.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { INBOX_FALLBACK_MS, INBOX_FALLBACK_REASON, readMessage, receiptPath, writeListener } from '../src/mcp/inbox.ts';
import { CHANNEL_HELD_RECEIPT, channelPushHeld, channelPushPath, channelPushed } from '../src/mcp/channel.ts';
import { promoteInboxDrops, retryHeldDrops, type RetrySources } from '../src/watch/retry.ts';
import { confirmTakenDrops } from '../src/watch/taken.ts';
import { claudeBox, recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T04:00:00.000Z');
// Inbox ids are what `team send` writes — a lowercase UUID — because the server serves no other
// name: a seeded message must be readable through `readMessage`, the code the server reads with.
const INBOX_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const INBOX_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const INBOX_C = 'cccccccc-0000-4000-8000-000000000003';
const INBOX_D = 'dddddddd-0000-4000-8000-000000000004';
const INBOX_W = 'eeeeeeee-0000-4000-8000-000000000005';
const INBOX_E = 'ffffffff-0000-4000-8000-000000000006';
const DROP_A = 'aaaaaaaa-0000-4000-8000-000000000011';
const DROP_B = 'bbbbbbbb-0000-4000-8000-000000000012';
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
# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
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

/** A pane this test scripts: the screen it shows, the status it reports, whether an Enter
 *  actually submits, and whether submitting moves the status off idle. `typed` and `enters` are
 *  the calls it received. */
type Pane = {
  screen: string | null;
  status: string;
  submits: boolean;
  moves?: boolean;
  typed: string[];
  enters: number;
  /** The keys a delivery sent into this box, for the sources `scripts(one, true)` builds. */
  keys: string[];
};

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, submits: true, typed: [], enters: 0, keys: [] };
}

function scripts(one: Pane, withKeys = false): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      // A bracketed paste redraws the box as its rows; a trigger is the box's text.
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      one.screen = claudeBox(pasted ? pasted[1] ?? '' : text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      if (one.submits) {
        if (one.moves !== false) one.status = 'working';
        one.screen = claudeBox('');
      }
      return true;
    },
    sleep: async () => {},
    // The watch's real sources carry herdr's key sender; a scene that leaves it out is a
    // fallback host, and its delivery holds on unsent text instead of moving it.
    ...(withKeys ? { sendKey: (_pane: string, key: string) => { one.keys.push(key); one.screen = claudeBox(''); return true; } } : {}),
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

/** Where a seeded record is signed and bound: the checkout and the home `team` runs with. */
type SeedWorld = { root: string; dir: string; home: string };

/** The record a send writes, dropped into `seat`'s folder under the message's own id. */
function seedRecord(at: SeedWorld, session: string, seat: string, id: string, body: string, ts: Date): string {
  const dropDir = join(at.dir, 'send-drops', session, seat);
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(at.root),
    session,
    at: ts.toISOString(),
    body,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  return dropDir;
}

/** A drop and its record, as a held send leaves them. */
function seedHeld(at: SeedWorld, session: string, seat: string, id: string, body: string, ts = NOW): string {
  const dropDir = seedRecord(at, session, seat, id, body, ts);
  markPending(dropDir, { id, from: 'owner', to: seat, body, ts: ts.toISOString() });
  return dropDir;
}

/** A drop and its record, as the mcp-inbox leg leaves them: the message waits in the seat's own
 *  inbox, and the marker says which leg left it. */
function seedInbox(at: SeedWorld, session: string, seat: string, id: string, body: string, ts = NOW): string {
  const dropDir = seedRecord(at, session, seat, id, body, ts);
  markPending(dropDir, { id, from: 'owner', to: seat, body, ts: ts.toISOString(), leg: 'mcp-inbox' });
  return dropDir;
}

/** The receipt an `inbox_read` call writes: through the same code the server serves reads with,
 *  so the record's shape — and its verification — is the server's own. */
function readInbox(at: SeedWorld, id: string, seat: string, session: string): void {
  const dropDir = join(at.dir, 'send-drops', session, seat);
  const read = readMessage({ dropDir, root: realpathSync(at.root), seat, session }, id, at.home);
  if (!read.ok) throw new Error(read.reason);
}

/** A drop and its record, as the drop leg leaves them: the sender's command has already said
 *  `sent (unconfirmed)`, and the marker waits for the seat's own watcher to read it. */
function seedDropped(at: SeedWorld, session: string, seat: string, id: string, body: string, ts = NOW): string {
  const dropDir = seedRecord(at, session, seat, id, body, ts);
  markPending(dropDir, { id, from: 'owner', to: seat, body, ts: ts.toISOString(), leg: 'drop' });
  return dropDir;
}

/** The receipt the turn-start read writes: the signed status receipt the inbox server writes
 *  too, naming this message, seat, checkout and session. The end-to-end scene runs the installed
 *  hook command itself instead. */
function readByHook(at: SeedWorld, dropDir: string, id: string, seat: string, session: string): void {
  const written = writeReceipt(dropDir, signReceiptPayload({
    kind: 'receipt',
    status: 'read',
    id,
    to: seat,
    root: realpathSync(at.root),
    session,
    at: NOW.toISOString(),
  }, at.home), at.home);
  if (!written.ok) throw new Error(written.reason);
}

describe('retryHeldDrops', () => {
  test('never types into a box that holds someone else\'s text, and delivers once it is free', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-1', 'from the owner — admitted by: the owner\n\nhello');
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
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    expect(recordBody(join(dropDir, 'drop-1'))).toBe('from the owner — admitted by: the owner\n\nhello');
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner — admitted by: the owner\n\nhello',
        id: 'drop-1',
        outcome: 'sent (unconfirmed)',
        note: 'trigger taken, no read receipt yet',
        via: 'typed',
      },
    ]);
    expect(said).toEqual(['lead: a held send from owner was sent on retry (trigger taken, no read receipt yet)']);
  });

  test('a native hold keeps the drop pending even at a free box, and the retry runs once it lifts', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-1', 'from the owner — admitted by: the owner\n\nhello');
    const one = pane(claudeBox(''));
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
      nativeHeld: new Set(['lead']),
      say: (text: string) => said.push(text),
    };

    // The screen says free, but the native store says the seat is in a turn (or a person wait, a
    // session end, or an unproven projection): the drop is left alone and the marker stays.
    await retryHeldDrops(at);
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);

    // The same scene with the hold lifted is the ordinary retry: one trigger, the marker gone.
    at.nativeHeld = new Set();
    await retryHeldDrops(at);
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
  });

  test('a retry whose trigger writes the read receipt is delivered (read), never merely sent', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-receipt', 'from the owner — admitted by: the owner\n\nhello');
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const base = scripts(one);
    const at = {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team,
      live: liveWith('lead', 'w1:p1'),
      ownPane: null,
      // The retry's trigger is the seat's own `team drops --read`: a seat that runs it writes the
      // signed receipt before the line leaves the box, and that receipt is the read itself.
      sources: {
        ...base,
        pressEnter: () => {
          readByHook(made, dropDir, 'drop-receipt', 'lead', 'acme');
          return base.pressEnter('w1:p1', 'acme');
        },
      },
      now: NOW,
      say: (text: string) => said.push(text),
    };

    await retryHeldDrops(at);

    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    expect(existsSync(receiptPath(dropDir, 'drop-receipt'))).toBe(true);
    expect(said).toEqual(['lead: a held send from owner was read on retry (receipt)']);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner — admitted by: the owner\n\nhello',
        id: 'drop-receipt',
        outcome: 'delivered (read)',
        via: 'typed',
      },
    ]);
  });

  test('a message read before the retry types is settled as read and no line is typed', async () => {
    // The retry records are read first; the seat's own read lands before the delivery. The
    // receipt is the read itself, so the trigger would be a duplicate reminder: the marker is
    // settled with the words a receipt inside the retry's window earns, and nothing is typed.
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-read-first', 'from the owner — admitted by: the owner\n\nhello');
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const base = scripts(one);
    let read = false;
    const at = {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team,
      live: liveWith('lead', 'w1:p1'),
      ownPane: null,
      sources: {
        ...base,
        screen: () => {
          if (!read) {
            read = true;
            readByHook(made, dropDir, 'drop-read-first', 'lead', 'acme');
          }
          return one.screen;
        },
      },
      now: NOW,
      say: (text: string) => said.push(text),
    };

    await retryHeldDrops(at);

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual(['lead: a held send from owner was read on retry (receipt)']);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner — admitted by: the owner\n\nhello',
        id: 'drop-read-first',
        outcome: 'delivered (read)',
        via: 'typed',
      },
    ]);
  });

  test('a retry that moves the owner\'s draft carries the paste-back receipt on its line and in history', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-draft', 'from the owner — admitted by: the owner\n\nhello');
    const one = pane(claudeBox('a draft for the retry'));
    const said: string[] = [];
    const at = {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team,
      live: liveWith('lead', 'w1:p1'),
      ownPane: null,
      sources: scripts(one, true),
      now: NOW,
      say: (text: string) => said.push(text),
    };

    await retryHeldDrops(at);
    // One clear, the trigger, one Enter, then the owner's text back as one bracketed paste.
    expect(one.keys).toEqual(['ctrl+c']);
    expect(one.typed).toEqual([
      readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string,
      '\x1b[200~a draft for the retry\x1b[201~',
    ]);
    expect(readPending(dropDir)).toEqual([]);
    expect(existsSync(join(dropDir, 'drop-draft.draft'))).toBe(false);
    // The retry's receipt names where the text went, as the send's own line would have.
    expect(said).toEqual(['lead: a held send from owner was sent on retry (trigger taken, no read receipt yet; the unsent text was pasted back)']);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner — admitted by: the owner\n\nhello',
        id: 'drop-draft',
        outcome: 'sent (unconfirmed)',
        note: 'trigger taken, no read receipt yet; the unsent text was pasted back',
        via: 'typed',
      },
    ]);
  });

  test('a seat the file marks human is never typed into: the marker is given up with the reason', async () => {
    const made = world();
    const text = teamText(made.root, lobbyDir(made.home)).replace('    name: lead\n', '    name: lead\n    human: true\n');
    const team = teamOf(text);
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-human', 'from the owner — admitted by: the owner\n\nhello');
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
      `lead: a held send from owner was not delivered (the pane is a human's, and nothing is typed into it); the record is at ${join(dropDir, 'drop-human')}; send it again`,
    ]);
    // The message itself waits on disk: the person reads the record's body.
    expect(recordBody(join(dropDir, 'drop-human'))).toBe('from the owner — admitted by: the owner\n\nhello');
  });

  test('a pane back at its shell is not typed into: the reason is said and the drop kept', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-shell', 'from the owner — admitted by: the owner\n\nhello');
    // An idle status and an empty-looking box, but the foreground is the pane's own shell: the
    // seat's CLI has exited, and a trigger typed here would reach the shell, not the seat.
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const sources = scripts(one);
    sources.processes = () => ({ shell: 111, foreground: [111] });

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources, now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual([
      `lead: a held send from owner was not delivered (the seat is back at its shell; nothing was typed); the record is at ${join(dropDir, 'drop-shell')}; send it again`,
    ]);
    // The message waits on disk for the seat's return or a person's hand.
    expect(recordBody(join(dropDir, 'drop-shell'))).toBe('from the owner — admitted by: the owner\n\nhello');
  });

  test('a trigger left unsent in the box is submitted, never typed over', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-2', 'from the owner — admitted by: the owner\n\nagain');
    const line = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'again' }) as string;
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
    expect(said).toEqual(['lead: a held send from owner was sent on retry (trigger taken, no read receipt yet)']);
  });

  test('a held drop whose signed record does not verify is never typed nameless', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-unverified', 'from the owner — admitted by: the owner\n\nhello');
    writeFileSync(join(dropDir, 'drop-unverified'), 'not a signed record\n');
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    // The drop file is kept and named; no trigger is typed, and the watcher stops retrying it.
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(existsSync(join(dropDir, 'drop-unverified'))).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("its signed record does not verify with this home's key");
    expect(said[0]).toContain(join(dropDir, 'drop-unverified'));
  });

  test('is bounded: after three tries the drop path is said and the record is gone', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-3', 'from the owner — admitted by: the owner\n\nstuck');
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
    expect(said[0]).toContain('the record is at');
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
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-4', 'from the owner — admitted by: the owner\n\nold', old);
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
      `lead: a held send from owner was not delivered (the retry window passed); the record is at ${join(dropDir, 'drop-4')}; send it again`,
    ]);
  });

  test('a seat that vanished still ages out its record, with no pane to read', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const old = new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 60_000);
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-gone-seat', 'from the owner — admitted by: the owner\n\nvanished', old);
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
      `lead: a held send from owner was not delivered (the retry window passed); the record is at ${join(dropDir, 'drop-gone-seat')}; send it again`,
    ]);
  });

  test('a record whose drop file is gone is given up on, not typed', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-missing', 'from the owner — admitted by: the owner\n\nlost');
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

  test('a young mcp-inbox marker is not a held send: the pass leaves it and types nothing', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nread by the seat when it polls';
    // The marker send leaves when its mcp-inbox leg gets no receipt: it records the leg so the
    // watch knows the message is the seat's own to read, not one to type.
    const dropDir = seedInbox(made, 'acme', 'lead', 'drop-inbox', body);
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(said).toEqual([]);
    // The record keeps its leg and its try count: this pass never walked it.
    const records = readPending(dropDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'drop-inbox', leg: 'mcp-inbox', tries: 0 });
    expect(recordBody(join(dropDir, 'drop-inbox'))).toBe(body);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok && history.entries).toEqual([]);
  });
});

describe('promoteInboxDrops', () => {
  test('a receipt promotes the send once: delivered (read), the marker gone, nothing typed', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nread when the seat polls';
    const dropDir = seedInbox(made, 'acme', 'lead', INBOX_A, body);
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const at = {
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      // No pane is named: a promotion reads two files and types nothing.
      live: { running: true, agents: [], workspaces: [], screens: {} } as Live,
      ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    };

    // Before the read there is no receipt, and the marker stands untouched.
    promoteInboxDrops(at);
    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);
    expect(readHistory('acme', made.root, made.home)).toMatchObject({ ok: true, entries: [] });

    readInbox(made, INBOX_A, 'lead', 'acme');
    expect(promoteInboxDrops(at)).toEqual(new Set([`lead\n${INBOX_A}`]));

    expect(readPending(dropDir)).toEqual([]);
    // The record is the message and stays: only the receipt beside it is done with.
    expect(recordBody(join(dropDir, INBOX_A))).toBe(body);
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body,
        id: INBOX_A,
        outcome: 'delivered (read)',
        via: 'mcp-inbox',
      },
    ]);
    expect(said).toEqual(['lead: an inbox send from owner was read in its inbox']);

    // The marker is gone, so a later pass neither promotes nor reports it again.
    promoteInboxDrops(at);
    expect(said).toHaveLength(1);
    expect(readHistory('acme', made.root, made.home)).toMatchObject({ ok: true, entries: [{ id: INBOX_A }] });
  });

  test('a read through the inbox hides the drop from team drops, and the watch then promotes it', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nread, and no longer waiting';
    const dropDir = seedInbox(made, 'acme', 'lead', INBOX_E, body);
    const one = pane(claudeBox(''));
    const said: string[] = [];

    // Waiting, the drop is what team drops lists.
    const keyState = messageKeyState(made.home);
    if (keyState.kind !== 'key') throw new Error('the fixture wrote no message key');
    const key = keyState.key;
    const context = { to: 'lead', root: realpathSync(made.root), session: 'acme' };
    const waiting = listDrops(dropDir, key, context);
    expect(waiting.kind === 'ok' && waiting.rows.map((row) => row.id)).toEqual([INBOX_E]);

    // The inbox read writes the one receipt both readings know by name: the drop is no longer
    // waiting for the seat, and the watch turns the same receipt into the sender's history line.
    readInbox(made, INBOX_E, 'lead', 'acme');
    expect(listDrops(dropDir, key, context)).toEqual({ kind: 'ok', rows: [] });

    promoteInboxDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: { running: true, agents: [], workspaces: [], screens: {} } as Live,
      ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(readPending(dropDir)).toEqual([]);
    expect(recordBody(join(dropDir, INBOX_E))).toBe(body);
    expect(said).toEqual(['lead: an inbox send from owner was read in its inbox']);
  });

  test('a receipt that names another seat proves nothing', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedInbox(made, 'acme', 'lead', INBOX_B, 'from the owner — admitted by: the owner\n\nnot for helper');
    const one = pane(claudeBox(''));
    const said: string[] = [];

    // The receipt exists under the same id, but its record names another seat's read. It is not
    // this inbox's own proof, so the marker stands and nothing is written down.
    const foreign = writeReceipt(dropDir, signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: INBOX_B,
      to: 'helper',
      root: realpathSync(made.root),
      session: 'acme',
      at: NOW.toISOString(),
    }, made.home), made.home);
    expect(foreign.ok).toBe(true);
    promoteInboxDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: { running: true, agents: [], workspaces: [], screens: {} },
      ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok && history.entries).toEqual([]);
  });

  test('a drop receipt promotes a dropped send: delivered (read), the marker gone, nothing typed', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nread at turn start';
    const dropDir = seedDropped(made, 'acme', 'lead', DROP_A, body);
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const at = {
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      // No pane is named: a promotion reads two files and types nothing.
      live: { running: true, agents: [], workspaces: [], screens: {} } as Live,
      ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    };

    // Before the read there is no receipt, and the marker stands untouched.
    promoteInboxDrops(at);
    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);

    readByHook(made, dropDir, DROP_A, 'lead', 'acme');
    expect(statSync(receiptPath(dropDir, DROP_A)).mode & 0o777).toBe(0o600);
    promoteInboxDrops(at);

    expect(readPending(dropDir)).toEqual([]);
    // The record is the message and stays: only the receipt beside it is done with.
    expect(recordBody(join(dropDir, DROP_A))).toBe(body);
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body,
        id: DROP_A,
        outcome: 'delivered (read)',
        via: 'drop',
      },
    ]);
    expect(said).toEqual(['lead: a dropped send from owner was read in its drop folder']);

    // The marker is gone, so a later pass neither promotes nor reports it again.
    promoteInboxDrops(at);
    expect(said).toHaveLength(1);
  });

  test('an inbox receipt promotes a dropped send too, and another seat\'s receipt proves nothing', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nread through the inbox';
    const dropDir = seedDropped(made, 'acme', 'lead', DROP_B, body);
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const at = {
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: { running: true, agents: [], workspaces: [], screens: {} } as Live,
      ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    };

    // A receipt under the same id that names another seat is not this inbox's own proof.
    readByHook(made, dropDir, DROP_B, 'helper', 'acme');
    promoteInboxDrops(at);
    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);

    // The receipt is write-once: the wrong proof is set aside before the seat's own read can
    // leave its own at the name.
    rmSync(receiptPath(dropDir, DROP_B));

    // The two watchers read one folder: the inbox client's receipt promotes the drop-leg marker.
    readInbox(made, DROP_B, 'lead', 'acme');
    promoteInboxDrops(at);

    expect(readPending(dropDir)).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toMatchObject([{ id: DROP_B, outcome: 'delivered (read)', via: 'drop' }]);
    expect(said).toEqual(['lead: a dropped send from owner was read in its drop folder']);
  });
});

describe('an inbox send past its fallback window', () => {
  test('the watch types the trigger once and records why', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nleft unread';
    const old = new Date(NOW.getTime() - INBOX_FALLBACK_MS - 60_000);
    const dropDir = seedInbox(made, 'acme', 'lead', INBOX_C, body, old);
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'left unread' }) as string]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body,
        id: INBOX_C,
        outcome: 'sent (unconfirmed)',
        note: 'trigger taken, no read receipt yet',
        via: 'typed',
        failed: [INBOX_FALLBACK_REASON],
      },
    ]);
    expect(said).toEqual(['lead: an inbox send from owner was sent on retry (trigger taken, no read receipt yet)']);
  });

  test('a typed marker goes before an inbox marker that is already due', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedHeld(made, 'acme', 'lead', 'held-now', 'from the owner — admitted by: the owner\n\nheld first');
    const old = new Date(NOW.getTime() - INBOX_FALLBACK_MS - 60_000);
    seedInbox(made, 'acme', 'lead', INBOX_D, 'from the owner — admitted by: the owner\n\ninbox second', old);
    const one = pane(claudeBox(''));

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: () => {},
    });

    // One delivery per seat per pass, and it is the typed marker's: the inbox marker is due but
    // waits behind the retry's own kind.
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'held first' }) as string]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir).map((drop) => drop.id)).toEqual([INBOX_D]);
  });

  test('a drop marker is never typed, and past the age bound it is given up with the path', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedDropped(made, 'acme', 'lead', DROP_A, 'from the owner — admitted by: the owner\n\nunread');
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });

    // The seat is free and idle, and still nothing is typed: the drop leg never types.
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toHaveLength(1);
    expect(said).toEqual([]);

    // The age bound ends the wait for a receipt, and the words name the file that still waits.
    const later: string[] = [];
    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one),
      now: new Date(NOW.getTime() + PENDING_MAX_AGE_MS + 1_000),
      say: (text: string) => later.push(text),
    });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(later).toEqual([
      `lead: a dropped send from owner was not read (no receipt within 30m); the drop file is at ${join(dropDir, DROP_A)}`,
    ]);
    // The message itself stays: only the watch's wait for a receipt ended.
    expect(recordBody(join(dropDir, DROP_A))).toBe('from the owner — admitted by: the owner\n\nunread');
    expect(readHistory('acme', made.root, made.home)).toMatchObject({ ok: true, entries: [] });
  });
});

describe('a retry that ends taken', () => {
  test('it leaves the taken marker and the taken word, and the later confirmation types nothing', async () => {
    const made = world();
    // The first send is not-submitted: the box keeps the trigger and the retry record is written.
    const one = pane(claudeBox(''));
    one.submits = false;
    const native: NativePane = {
      typeText: (_session, _pane, text) => { one.typed.push(text); one.screen = claudeBox(text); return true; },
      pressEnter: () => { one.enters += 1; if (one.submits) one.screen = claudeBox(''); return true; },
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
    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const pending = readPending(dropDir);
    expect(pending).toHaveLength(1);
    const id = (pending[0] as { id: string }).id;

    // The retry's Enter takes the line, but the seat never shows it working: the box clears and
    // the retry itself ends taken. Its record moves from the retry store to the taken one.
    const sent = new Date(NOW.getTime() + 5_000);
    one.submits = true;
    one.moves = false;
    one.status = 'idle';
    one.screen = claudeBox('');
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const said: string[] = [];
    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: sent,
      say: (text: string) => said.push(text),
    });

    expect(readPending(dropDir)).toEqual([]);
    const taken = readTaken(dropDir);
    expect(taken).toHaveLength(1);
    expect(taken[0]?.id).toBe(id);
    expect(taken[0]?.before).toBe('idle');
    expect(said).toEqual(['lead: a held send from owner was sent on retry (trigger taken, no read receipt yet)']);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.map((entry) => [entry.id, entry.outcome, entry.note])).toEqual([
      [id, 'not-submitted', undefined],
      [id, 'sent (unconfirmed)', 'trigger taken, no read receipt yet'],
    ]);

    // Later, the confirmation reports the never-acted line once — and types nothing, ever.
    one.typed = [];
    one.enters = 0;
    one.screen = claudeBox('');
    one.status = 'idle';
    const after = {
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one),
      now: new Date(sent.getTime() + TAKEN_IDLE_GRACE_MS + 1_000),
      say: (text: string) => said.push(text),
    };
    confirmTakenDrops(after);

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readTaken(dropDir)).toEqual([]);
    expect(said.at(-1)).toBe(
      `lead: a send from owner was taken but never acted on; the record is at ${join(dropDir, id)}`,
    );
  });

  test('a receipt the seat wrote after the retry is delivered (read), and the confirmation types nothing', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const body = 'from the owner — admitted by: the owner\n\nread after the fact';
    const dropDir = seedHeld(made, 'acme', 'lead', 'drop-taken-receipt', body);
    markTaken(dropDir, { id: 'drop-taken-receipt', from: 'owner', to: 'lead', body, ts: NOW.toISOString(), before: 'idle' });
    clearPending(dropDir, 'drop-taken-receipt');
    readByHook(made, dropDir, 'drop-taken-receipt', 'lead', 'acme');

    const one = pane(claudeBox(''));
    const said: string[] = [];
    const at = {
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one),
      now: new Date(NOW.getTime() + TAKEN_IDLE_GRACE_MS + 1_000),
      say: (text: string) => said.push(text),
    };
    confirmTakenDrops(at);

    // The receipt is the sign the retry's own window missed: the marker goes and the send is a
    // read, with no keystroke and no dependence on which pane the seat now stands on.
    expect(readTaken(dropDir)).toEqual([]);
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(said).toEqual(['lead: a typed send from owner was read (receipt)']);
    expect(readHistory('acme', made.root, made.home)).toMatchObject({
      ok: true,
      entries: [
        {
          ts: at.now.toISOString(),
          from: 'owner',
          to: 'lead',
          body,
          id: 'drop-taken-receipt',
          outcome: 'delivered (read)',
          via: 'typed',
        },
      ],
    });
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
    expect(io.err).toContain('the record is at');
    expect(io.err).toContain('a running watch retries it when the seat is idle');
    expect(one.typed).toEqual([]);

    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const drops = readPending(dropDir);
    expect(drops).toHaveLength(1);
    const drop = drops[0] as PendingDrop;
    expect(drop).toMatchObject({ from: 'owner', to: 'lead', tries: 0, ts: NOW.toISOString() });
    expect(drop.body).toContain('hello');
    expect(recordBody(join(dropDir, drop.id))).toBe(drop.body);
    expect(pendingDropPath(dropDir, drop.id)).toContain(drop.id);

    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    one.screen = claudeBox('');
    const said: string[] = [];
    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one), now: NOW,
      say: (text: string) => said.push(text),
    });
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.map((entry) => entry.outcome)).toEqual(['held', 'sent (unconfirmed)']);
    expect(history.entries[1]?.id).toBe(drop.id);
  });

  test('a retry that meets the owner\'s draft clears it, delivers, and pastes the text back', async () => {
    // The watch's shipped sources carry herdr's key sender: unlike the no-key fallback above,
    // the retry is a delivery, and a delivery moves the owner's text out of the way and puts it
    // back exactly — the copy beside the drop is removed once the box reads it again.
    const made = world();
    const draft = 'a draft only its author can send';
    const one = pane(claudeBox(draft));
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
    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('held: the composer already holds unsent text');
    expect(one.typed).toEqual([]);

    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const drop = readPending(dropDir)[0] as PendingDrop;
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const said: string[] = [];
    await retryHeldDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team,
      live: liveWith('lead', 'w1:p1'), ownPane: null, sources: scripts(one, true), now: NOW,
      say: (text: string) => said.push(text),
    });

    expect(one.keys).toEqual(['ctrl+c']);
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string, `\x1b[200~${draft}\x1b[201~`]);
    expect(one.screen).toBe(claudeBox(draft));
    expect(existsSync(join(dropDir, `${drop.id}.draft`))).toBe(false);
    expect(readPending(dropDir)).toEqual([]);
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
    expect(io.err).toContain('the record is at');
    // A dialog is nobody's to submit: the Enter stays unspent.
    expect(one.enters).toBe(0);

    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const drops = readPending(dropDir);
    expect(drops).toHaveLength(1);
    const drop = drops[0] as PendingDrop;
    expect(drop).toMatchObject({ from: 'owner', to: 'lead', tries: 0 });
    expect(recordBody(join(dropDir, drop.id))).toBe(drop.body);

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
    // The send's own typed leg named its sender; the retry that finished the delivery types the
    // same named line, which is what the seat's box already holds.
    const held = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string;
    expect(one.typed).toEqual([held, held]);
    expect(one.enters).toBe(1);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.map((entry) => entry.outcome)).toEqual(['unreachable', 'sent (unconfirmed)']);
    expect(said).toEqual(['lead: a held send from owner was sent on retry (trigger taken, no read receipt yet)']);
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
    const body = 'from the owner — admitted by: the owner\n\nwatched';
    seedHeld({ root: directory, dir: join(directory, '.agents'), home: directory }, 'acme-web', 'deepseek-acme', 'drop-5', body, new Date(clock - 60_000));

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
    const line = readTriggerLine('deepseek-acme', 'acme-web', { seat: 'owner', team: 'acme-web', body: 'watched' }) as string;
    expect(typed).toEqual([line]);
    expect(one.enters).toBe(1);
    expect(readPending(dropDir)).toEqual([]);
    expect(io.out).toContain('deepseek-acme: a held send from owner was sent on retry (trigger taken, no read receipt yet)');
    const history = readHistory('acme-web', directory, directory);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.at(-1)).toMatchObject({
      id: 'drop-5',
      outcome: 'sent (unconfirmed)',
      note: 'trigger taken, no read receipt yet',
      via: 'typed',
    });
  });
});

describe('team watch promotes an inbox send its seat has read', () => {
  test('a retry receipt is promoted before a matching unread mailbox record can ring', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-no-ring-')));
    base = directory;
    execFileSync('git', ['init', '-q'], { cwd: directory });
    mkdirSync(join(directory, '.agents'));
    const file = join(directory, '.agents', 'team.yaml');
    writeFileSync(file, raw);
    const body = 'from the owner — admitted by: the owner\n\nalready read';
    const seeded = { root: directory, dir: join(directory, '.agents'), home: directory };
    const dropDir = seedInbox(seeded, 'acme-web', 'deepseek-acme', INBOX_A, body);
    // The prior mailbox generation can leave its signed record beside the new send record. Its
    // mailbox receipt is absent, while the inbox receipt is the authoritative read for this id.
    plantMessage(directory, directory, 'deepseek-acme', INBOX_A, {
      kind: 'message', id: INBOX_A, to: 'deepseek-acme', root: realpathSync(directory),
      session: 'acme-web', at: NOW.toISOString(), body, from: 'owner',
    });
    expect(listUnacked(directory, 'acme-web', directory)).toHaveLength(2);
    readInbox(seeded, INBOX_A, 'deepseek-acme', 'acme-web');
    expect(listUnacked(directory, 'acme-web', directory)).toHaveLength(1);

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
      now: () => NOW,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: directory,
    };
    const io = testIo(directory, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(io.out).toContain('deepseek-acme: an inbox send from owner was read in its inbox');
    expect(io.out).not.toContain('rang deepseek-acme:');
  });

  test('the receipt is promoted with --no-nudge, and the watch types nothing', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-promote-')));
    base = directory;
    execFileSync('git', ['init', '-q'], { cwd: directory });
    mkdirSync(join(directory, '.agents'));
    const file = join(directory, '.agents', 'team.yaml');
    writeFileSync(file, raw);
    const dropDir = join(directory, '.agents', 'send-drops', 'acme-web', 'deepseek-acme');
    const clock = Date.parse('2026-10-03T14:00:00Z');
    const body = 'from the owner — admitted by: the owner\n\nread between passes';
    const seeded = { root: directory, dir: join(directory, '.agents'), home: directory };
    seedInbox(seeded, 'acme-web', 'deepseek-acme', INBOX_W, body, new Date(clock - 60_000));
    readInbox(seeded, INBOX_W, 'deepseek-acme', 'acme-web');

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

    // The watch that types nothing still promotes: the receipt is the seat's own read, and the
    // sender's word is the history line, not a keystroke.
    const io = testIo(directory, { kind: 'owner' });
    const code = await runWatch(['--file', file, '--no-nudge'], io, sources);

    expect(code).toBe(0);
    expect(typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(readPending(dropDir)).toEqual([]);
    expect(io.out).toContain('deepseek-acme: an inbox send from owner was read in its inbox');
    const history = readHistory('acme-web', directory, directory);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.filter((entry) => entry.id === INBOX_W)).toEqual([
      {
        ts: new Date(clock).toISOString(),
        from: 'owner',
        to: 'deepseek-acme',
        body,
        id: INBOX_W,
        outcome: 'delivered (read)',
        via: 'mcp-inbox',
      },
    ]);
  });
});

describe('the turn-start read, end to end', () => {
  test('a plain send lands by drop, the installed hook reads it, and its receipt promotes the send', async () => {
    const made = world();
    // The default order — mcp-inbox, typed, drop — with no inbox listener would type; the team's
    // word keeps the typed leg out, so the drop file takes the send and nothing wakes the seat.
    const text = teamText(made.root, lobbyDir(made.home)).replace(
      "# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,\n# then the line is typed. The team's word keeps the default's drop step out.\ndelivery_order: [mcp-inbox, typed]\n",
      "# This scene walks the drop leg: the inbox is tried and skipped for want of a listener, and\n# the team's word keeps the typed step out so the drop file takes the send.\ndelivery_order: [mcp-inbox, drop]\n",
    );
    writeFileSync(join(made.root, '.agents', 'team.yaml'), text);
    const dialled: string[] = [];
    const host: SendHost = {
      agents: () => [],
      processInfo: () => null,
      socketsDir: made.sockets,
      deliver: async (socketPath: string) => {
        dialled.push(socketPath);
        return { ok: true };
      },
      native: {
        typeText: () => true,
        pressEnter: () => true,
        status: () => 'idle',
        wait: async () => {},
        paneText: () => null,
      },
      now: () => NOW,
      home: made.home,
    };
    const io = testIo(made.root, { kind: 'owner' });

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(dialled).toEqual([]);

    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    const pending = readPending(dropDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.leg).toBe('drop');
    const id = pending[0]?.id as string;
    const body = recordBody(join(dropDir, id));

    // The launch installs the hook the seat's next turn start runs, and the read finds the drop.
    const landed = installCliHooks(made.dir, 'acme', [{ name: 'lead', cli: 'claude-code', launch: 'claude' }]);
    const settingsPath = landed.lead as string;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] };
    };
    const read = settings.hooks.UserPromptSubmit
      .flatMap((entry) => entry.hooks.map((hook) => hook.command))
      .find((command) => command.includes('drops --read'));
    expect(typeof read).toBe('string');

    // The hook's stdout is the JSON envelope the CLI adds to the turn; the body arrives whole.
    // It runs as the launch does: in the project, with the seat's own home for its message key.
    const out = execFileSync('sh', ['-c', read as string], {
      cwd: made.root,
      encoding: 'utf8',
      env: { ...process.env, HOME: made.home },
    });
    const envelope = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(envelope.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(envelope.hookSpecificOutput.additionalContext).toBe(body);

    // The receipt is the seat's proof, at the name, mode and shape the promotion reads: the same
    // signed status receipt the inbox server writes, not a marker of the hook's own.
    expect(statSync(receiptPath(dropDir, id)).mode & 0o777).toBe(0o600);
    const receipt = signedReceiptOf(JSON.parse(readFileSync(receiptPath(dropDir, id), 'utf8')));
    const key = messageKeyState(made.home);
    if (receipt === null || key.kind !== 'key') throw new Error('no signed receipt or no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);
    expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id, to: 'lead', session: 'acme' });

    // The history's first line said what the sender could know; the receipt promotes it once.
    const said: string[] = [];
    promoteInboxDrops({
      dir: made.dir, session: 'acme', root: made.root, home: made.home, team: teamOf(text),
      live: { running: true, agents: [], workspaces: [], screens: {} } as Live,
      ownPane: null, sources: scripts(pane(claudeBox(''))), now: NOW,
      say: (line: string) => said.push(line),
    });
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toEqual(['lead: a dropped send from owner was read in its drop folder']);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.map((entry) => [entry.id, entry.outcome, entry.via])).toEqual([
      [id, 'sent (unconfirmed)', 'drop'],
      [id, 'delivered (read)', 'drop'],
    ]);
  }, 30_000);

});

describe('retryHeldDrops and a stale channel', () => {
  // The install-change-between-send-and-retry case: the send found no listener, so it held no
  // push name; by the retry, a channel-enabled listener from another install serves the seat.
  // The retry reads that listener again at its own wake and holds the push name before it types,
  // so the installed build's record is woken once and no channel push follows it.
  test('an install change between send and retry holds the stale channel push name', async () => {
    const made = world();
    const text = teamText(made.root, lobbyDir(made.home)).split('launch: claude\n').join(
      'launch: claude --dangerously-load-development-channels server:team-inbox\n',
    );
    const team = teamOf(text);
    const id = 'lead-held-1';
    // The send and its record: a held drop, nothing typed yet, and no listener to ask.
    const dropDir = seedHeld(made, 'acme', 'lead', id, 'from the owner — admitted by: the owner\n\nhello');
    // The install changes under the watch: the listener serving this seat now runs another
    // version and another packed commit of the same CLI, with the channel declared.
    writeListener(dropDir, {
      v: 1,
      seat: 'lead',
      session: 'acme',
      root: realpathSync(made.root),
      cli: 'claude-code',
      pid: process.pid,
      ts: NOW.toISOString(),
      version: '0.5.4-hotfix.9',
      build: 'aaaaaaaaaaaaaaaa',
      head: 'a'.repeat(40),
      channel: true,
    });
    const one = pane(claudeBox(''));
    await retryHeldDrops({
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team,
      live: liveWith('lead', 'w1:p1'),
      ownPane: null,
      sources: scripts(one),
      now: NOW,
      build: () => ({ version: '0.5.5', build: 'bbbbbbbbbbbbbbbb', builtAt: NOW.getTime(), head: 'b'.repeat(40) }),
      say: () => {},
    });

    // The wake happens once, and the push name was held before it: a serving channel skips the
    // id, and the retry's own reading never takes the held marker for a push.
    expect(one.typed).toHaveLength(1);
    expect(one.enters).toBe(1);
    const marker = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({ v: 1, kind: CHANNEL_HELD_RECEIPT, id });
    expect(channelPushHeld(dropDir, id)).toBe(true);
    expect(channelPushed(dropDir, id)).toBe(false);
    expect(readPending(dropDir)).toEqual([]);
  });
});
