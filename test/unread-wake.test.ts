// An idle seat whose message is still unread, woken once and then reported.
//
// A delivery is a deposit until the seat's signed read receipt follows. The watch's unread pass
// counts from `watch.unread_after` (N): N after a message landed it types the seat's own drop
// read once, and at twice that window it tells the sender and the team's lead — a mailbox record
// `team messages` reads, never a keystroke into another seat's pane. A message a held send is
// still retrying is not woken here, a human seat is never typed into, and a box holding someone's
// unsent text is moved and put back, never typed over.
// The pane here is a scripted screen; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listUnacked } from '../src/commands/messages.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { generalBriefRecord } from '../src/launch/general-brief.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readMessage, receiptPath } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { readHistory } from '../src/send/history.ts';
import { dropMessage, readTriggerLine } from '../src/send/native.ts';
import { markPending, pendingDropPath } from '../src/send/pending.ts';
import { signReceiptPayload, signRecord, writeReceipt } from '../src/send/record.ts';
import { takenDropPath } from '../src/send/taken.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { reportUnreadDrops, reportedPath, wakePath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T04:00:00.000Z');
const N = 600;
const MIN = 60_000;
const UNREAD_A = 'aaaaaaaa-0000-4000-8000-000000000101';
const UNREAD_B = 'bbbbbbbb-0000-4000-8000-000000000102';
const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

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

type World = { root: string; dir: string; home: string; cleanup: () => void };

function world(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-unread-wake-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

type Pane = {
  screen: string | null;
  status: string;
  submits: boolean;
  moves?: boolean;
  typed: string[];
  enters: number;
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
    ...(withKeys ? { sendKey: (_pane: string, _key: string) => { one.keys.push('ctrl+c'); one.screen = claudeBox(''); return true; } } : {}),
  };
}

function liveWith(name: string, paneId: string, status = 'idle'): Live {
  const agents: HerdrAgent[] = [
    { name, agent: 'claude', pane: paneId, workspace: 'first', status, cwd: null },
    { name: null, agent: 'claude', pane: 'lead:pane', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function teamOf(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** A signed message dropped into `seat`'s folder with the message's own id, its file time set to
 *  the instant it landed: the unread pass counts from that time, as `team drops` does. */
function seedMessage(
  at: { root: string; dir: string; home: string },
  session: string,
  seat: string,
  id: string,
  body: string,
  ts: Date,
  from = 'owner',
  fromId: string | null = null,
): string {
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
    from,
    from_id: fromId,
    rule: 'the owner',
    thread: id,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, id), new Date(), ts);
  return dropDir;
}

/** The receipt an `inbox_read` call writes: through the same code the server serves reads with. */
function readInbox(at: { root: string; dir: string; home: string }, id: string, seat: string, session: string): void {
  const dropDir = join(at.dir, 'send-drops', session, seat);
  const read = readMessage({ dropDir, root: realpathSync(at.root), seat, session }, id, at.home);
  if (!read.ok) throw new Error(read.reason);
}

/** One agent record in this home: the identity a signed `from_id` is resolved through. */
function registerSeat(home: string, team: string, seat: string, session: string): string {
  return registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test',
    cli: 'claude',
    launcher: null,
    launch: 'claude',
    reach: { team, seat, session, pane: null, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  }).id;
}

type Scene = Parameters<typeof wakeUnreadDrops>[0];

function sceneOf(
  made: World,
  team: ReturnType<typeof teamOf>,
  one: Pane,
  said: string[],
  options: { now?: Date; sources?: RetrySources; live?: Live; ownPane?: string | null } = {},
): Scene {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team,
    live: options.live ?? liveWith('lead', 'w1:p1'),
    ownPane: options.ownPane ?? null,
    sources: options.sources ?? scripts(one),
    now: options.now ?? NOW,
    say: (text: string) => said.push(text),
  };
}

function mailboxBody(root: string, seat: string, id: string): { from: string; to: string; body: string } {
  const text = readFileSync(join(root, '.agents', 'messages', seat, `${id}.json`), 'utf8');
  const parsed = JSON.parse(text) as { payload: { from: string; to: string; body: string } };
  return parsed.payload;
}

describe('wakeUnreadDrops', () => {
  test('a message unread past the window gets one wake line, and a second pass types nothing', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nwaiting', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const scene = sceneOf(made, team, one, said);

    await wakeUnreadDrops(scene, { unreadAfter: N });

    const line = readTriggerLine('lead', 'acme') as string;
    expect(one.typed).toEqual([line]);
    expect(one.enters).toBe(1);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);
    expect(said).toEqual(['lead: a message from owner was unread and one wake line was sent (trigger taken, no read receipt yet)']);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner\n\nwaiting',
        id: UNREAD_A,
        thread: UNREAD_A,
        outcome: 'sent (unconfirmed)',
        note: 'trigger taken, no read receipt yet',
        via: 'typed',
      },
    ]);

    // The one wake is the message's: a later pass with the same message unread types nothing.
    one.status = 'idle';
    one.screen = claudeBox('');
    await wakeUnreadDrops(scene, { unreadAfter: N });
    expect(one.typed).toEqual([line]);
    expect(one.enters).toBe(1);
  });

  test('a receipt that does not bind the seat\'s current claim is no read, and does not hide the wake', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const incarnation = 'inc_aaaaaaaaaaaa';
    const record = generalBriefRecord({
      to: 'lead',
      root: realpathSync(made.root),
      session: 'acme',
      at: new Date(NOW.getTime() - 11 * MIN).toISOString(),
      incarnation,
    });
    const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
    dropMessage(dropDir, record.id, `${JSON.stringify(signRecord(record, made.home), null, 2)}\n`);
    utimesSync(join(dropDir, record.id), new Date(), new Date(NOW.getTime() - 11 * MIN));
    updateState(made.dir, (state) => {
      const one = (state.sessions['acme'] ??= emptySession());
      (one.briefs ??= {})['lead'] = {
        id: record.id,
        at: record.at,
        incarnation,
        epoch: 'run_bbbbbbbbbbbb',
        sha256: record.brief_sha256 as string,
        attempt: 0,
        stage: 'ready',
        superseded: [],
      };
    });
    // A read of an earlier delivery: it verifies for this message, seat, checkout and session,
    // but it was written under no claim, so it is not a read of the delivery the claim names.
    const stale = signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: record.id,
      to: 'lead',
      root: realpathSync(made.root),
      session: 'acme',
      at: NOW.toISOString(),
    }, made.home);
    writeReceipt(dropDir, stale, made.home);

    const one = pane(claudeBox(''));
    const said: string[] = [];
    const scene = sceneOf(made, team, one, said);

    await wakeUnreadDrops(scene, { unreadAfter: N });

    // The claim-bound reading still lists the delivery as unread, and the wake's own receipt
    // check agrees: the stale file is not promoted into `delivered (read)`.
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme') as string]);
    expect(one.enters).toBe(1);
    expect(said).toEqual(['lead: a message from the launch was unread and one wake line was sent (trigger taken, no read receipt yet)']);
    expect(existsSync(wakePath(dropDir, record.id))).toBe(true);
  });

  test('a wake whose trigger writes the read receipt is delivered (read), never merely sent', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nread at once', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const base = scripts(one);
    const sources: RetrySources = {
      ...base,
      pressEnter: () => {
        readInbox(made, UNREAD_A, 'lead', 'acme');
        return base.pressEnter('w1:p1', 'acme');
      },
    };
    const scene = sceneOf(made, team, one, said, { sources });

    await wakeUnreadDrops(scene, { unreadAfter: N });

    expect(one.typed).toEqual([readTriggerLine('lead', 'acme') as string]);
    expect(existsSync(receiptPath(dropDir, UNREAD_A))).toBe(true);
    expect(said).toEqual(['lead: a message from owner was unread and was read on the wake (receipt)']);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toEqual([
      {
        ts: NOW.toISOString(),
        from: 'owner',
        to: 'lead',
        body: 'from the owner\n\nread at once',
        id: UNREAD_A,
        thread: UNREAD_A,
        outcome: 'delivered (read)',
        via: 'typed',
      },
    ]);

    // The receipt is the read: the report window passes with nothing to report.
    const later: string[] = [];
    reportUnreadDrops(sceneOf(made, team, one, later, { now: new Date(NOW.getTime() + 10 * MIN) }), { unreadAfter: N });
    expect(later).toEqual([]);
    expect(existsSync(join(made.root, '.agents', 'messages', 'owner', `unread-${UNREAD_A}.json`))).toBe(false);
  });

  test('a message a held send\'s retry still owns is not woken here', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nheld', new Date(NOW.getTime() - 11 * MIN));
    markPending(dropDir, { id: UNREAD_A, from: 'owner', to: 'lead', body: 'from the owner\n\nheld', ts: new Date(NOW.getTime() - 11 * MIN).toISOString() });
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await wakeUnreadDrops(sceneOf(made, team, one, said), { unreadAfter: N });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(false);
    expect(existsSync(pendingDropPath(dropDir, UNREAD_A))).toBe(true);
    expect(said).toEqual([]);
  });

  test('a box holding someone else\'s text is moved and put back, never typed over', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nwake me', new Date(NOW.getTime() - 11 * MIN));
    const draft = 'a draft only its author can send';
    const one = pane(claudeBox(draft));
    const said: string[] = [];

    await wakeUnreadDrops(sceneOf(made, team, one, said, { sources: scripts(one, true) }), { unreadAfter: N });

    expect(one.keys).toEqual(['ctrl+c']);
    expect(one.typed).toEqual([
      readTriggerLine('lead', 'acme') as string,
      `\x1b[200~${draft}\x1b[201~`,
    ]);
    expect(one.screen).toBe(claudeBox(draft));
    expect(existsSync(join(dropDir, `${UNREAD_A}.draft`))).toBe(false);
  });

  test('a message younger than the window is left alone', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nfresh', new Date(NOW.getTime() - 5 * MIN));
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await wakeUnreadDrops(sceneOf(made, team, one, said), { unreadAfter: N });

    expect(one.typed).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(false);
    expect(said).toEqual([]);
  });

  test('a taken wake leaves the marker the watch\'s later passes confirm', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\ntaken', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox(''));
    // The box clears with no status and no transcript sign: a take, and the marker's own case.
    one.moves = false;
    const said: string[] = [];

    await wakeUnreadDrops(sceneOf(made, team, one, said), { unreadAfter: N });

    expect(one.enters).toBe(1);
    expect(existsSync(takenDropPath(dropDir, UNREAD_A))).toBe(true);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);
    expect(said).toEqual(['lead: a message from owner was unread and one wake line was sent (trigger taken, no read receipt yet)']);
  });

  test('a human seat is never typed into and never reported', async () => {
    const made = world();
    const text = teamText(made.root, lobbyDir(made.home)).replace('    name: lead\n', '    name: lead\n    human: true\n');
    const team = teamOf(text);
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nfor a person', new Date(NOW.getTime() - 21 * MIN));
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const scene = sceneOf(made, team, one, said);

    await wakeUnreadDrops(scene, { unreadAfter: N });
    reportUnreadDrops(scene, { unreadAfter: N });

    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(false);
    expect(existsSync(reportedPath(dropDir, UNREAD_A))).toBe(false);
    expect(existsSync(join(made.root, '.agents', 'messages', 'owner', `unread-${UNREAD_A}.json`))).toBe(false);
    expect(said).toEqual([]);
  });
});

describe('reportUnreadDrops', () => {
  test('at twice the window the sender and the lead are told once, and no wake was typed', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nnobody came', new Date(NOW.getTime() - 21 * MIN));
    const one = pane(claudeBox(''));
    const said: string[] = [];
    const scene = sceneOf(made, team, one, said);

    reportUnreadDrops(scene, { unreadAfter: N });

    expect(existsSync(reportedPath(dropDir, UNREAD_A))).toBe(true);
    const toOwner = mailboxBody(made.root, 'owner', `unread-${UNREAD_A}`);
    expect(toOwner.to).toBe('owner');
    expect(toOwner.from).toBe('runtime');
    expect(toOwner.body).toContain('lead: a message from owner has been unread for 21 min');
    expect(toOwner.body).toContain('no wake line was typed');
    expect(toOwner.body).toContain(join(dropDir, UNREAD_A));
    const toLead = mailboxBody(made.root, 'lead', `unread-${UNREAD_A}`);
    expect(toLead.body).toBe(toOwner.body);
    expect(said).toEqual(['lead: a message from owner was still unread after 21 min; reported to owner and lead']);

    // One report per message: the marker is the memory, and a later pass says nothing new.
    const again: string[] = [];
    reportUnreadDrops(sceneOf(made, team, one, again), { unreadAfter: N });
    expect(again).toEqual([]);
  });

  test('a woken message says its wake line was sent, and a seat sender is told in its own mailbox', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const helper = registerSeat(made.home, teamIdOf(made.root), 'helper', 'acme');
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from helper\n\nstill here', new Date(NOW.getTime() - 21 * MIN), 'helper', helper);
    const one = pane(claudeBox(''));
    const said: string[] = [];
    // The wake happened a pass earlier; this pass is the report at twice the window.
    const woke = new Date(NOW.getTime() - 10 * MIN);
    await wakeUnreadDrops(sceneOf(made, team, one, said, { now: woke }), { unreadAfter: N });
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);

    reportUnreadDrops(sceneOf(made, team, one, said, { now: NOW }), { unreadAfter: N });

    const toHelper = mailboxBody(made.root, 'helper', `unread-${UNREAD_A}`);
    expect(toHelper.body).toContain('its wake line was sent at 2026-10-17T03:50:00.000Z');
    expect(mailboxBody(made.root, 'lead', `unread-${UNREAD_A}`).body).toBe(toHelper.body);
  });

  test("a foreign sender's own team is told in its own root and session", () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const beta = join(made.root, '..', 'beta');
    mkdirSync(join(beta, '.agents'), { recursive: true });
    const betaRoot = realpathSync(beta);
    const betaId = teamIdOf(betaRoot);
    const scout = registerSeat(made.home, betaId, 'scout', 'beta');
    upsertTeam(made.home, betaId, {
      project: 'beta',
      session: 'beta',
      root: betaRoot,
      lobby: 'beta-lobby',
      roster: [{ agent: scout, seat: 'scout', role: 'builder' }],
    });
    seedMessage(made, 'acme', 'lead', UNREAD_A, 'from scout\n\nforeign', new Date(NOW.getTime() - 21 * MIN), 'scout', scout);
    const said: string[] = [];

    reportUnreadDrops(sceneOf(made, team, pane(claudeBox('')), said), { unreadAfter: N });

    // The record is one the foreign team's own `team messages` reads: its root and session.
    const record = JSON.parse(
      readFileSync(join(betaRoot, '.agents', 'messages', 'scout', `unread-${UNREAD_A}.json`), 'utf8'),
    ) as { payload: { root: string; session: string; to: string } };
    expect(record.payload.to).toBe('scout');
    expect(record.payload.session).toBe('beta');
    expect(realpathSync(record.payload.root)).toBe(betaRoot);
    expect(listUnacked(betaRoot, 'beta', made.home).map((one) => one.id)).toContain(`unread-${UNREAD_A}`);
    // Nothing was written under our own root for that name.
    expect(existsSync(join(made.root, '.agents', 'messages', 'scout'))).toBe(false);
    expect(said).toEqual([`lead: a message from scout was still unread after 21 min; reported to scout of beta and lead`]);
  });

  test('an unresolved sender is reported to the lead only, never to a same-named local seat', () => {
    const made = world();
    // The team file declares a local `helper`: the name alone must never route the report to it.
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    seedMessage(made, 'acme', 'lead', UNREAD_A, 'from helper\n\nunproven', new Date(NOW.getTime() - 21 * MIN), 'helper');
    const said: string[] = [];

    reportUnreadDrops(sceneOf(made, team, pane(claudeBox('')), said), { unreadAfter: N });

    expect(existsSync(join(made.root, '.agents', 'messages', 'helper'))).toBe(false);
    const toLead = mailboxBody(made.root, 'lead', `unread-${UNREAD_A}`);
    expect(toLead.body).toContain('the sender\'s own mailbox could not be resolved (the signed record names no agent id for "helper")');
    expect(toLead.body).toContain('this report goes to the team\'s lead only');
    expect(said).toEqual([
      'lead: a message from helper was still unread after 21 min; reported to lead only: the sender\'s own mailbox could not be resolved (the signed record names no agent id for "helper")',
    ]);
  });

  test('an agent whose team the registry does not hold is reported to the lead only', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const ghost = registerSeat(made.home, 'ffffffffffff', 'scout', 'beta');
    seedMessage(made, 'acme', 'lead', UNREAD_A, 'from scout\n\norphan', new Date(NOW.getTime() - 21 * MIN), 'scout', ghost);
    const said: string[] = [];

    reportUnreadDrops(sceneOf(made, team, pane(claudeBox('')), said), { unreadAfter: N });

    expect(existsSync(join(made.root, '.agents', 'messages', 'scout'))).toBe(false);
    expect(mailboxBody(made.root, 'lead', `unread-${UNREAD_A}`).body).toContain(
      `agent ${ghost} names team "ffffffffffff", which this home's registry does not hold`,
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('reported to lead only');
  });

  test('a message inside twice the window is not reported yet', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nstill early', new Date(NOW.getTime() - 15 * MIN));
    const one = pane(claudeBox(''));
    const said: string[] = [];

    reportUnreadDrops(sceneOf(made, team, one, said), { unreadAfter: N });

    expect(existsSync(reportedPath(dropDir, UNREAD_A))).toBe(false);
    expect(said).toEqual([]);
  });
});

describe('crash-safe reservations', () => {
  test('the wake reservation is on disk before the line is typed', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nbefore', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox(''));
    const base = scripts(one);
    let held = false;
    const sources: RetrySources = {
      ...base,
      typeText: (paneId, text, session) => {
        held = existsSync(wakePath(dropDir, UNREAD_A));
        return base.typeText(paneId, text, session);
      },
    };

    await wakeUnreadDrops(sceneOf(made, team, one, [], { sources }), { unreadAfter: N });

    expect(held).toBe(true);
  });

  test('a reservation left by a crash is never typed over, and the report says its outcome is unconfirmed', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\ncrashed', new Date(NOW.getTime() - 21 * MIN));
    const at = '2026-10-17T03:30:00.000Z';
    writeFileSync(wakePath(dropDir, UNREAD_A), `${JSON.stringify({ id: UNREAD_A, at, state: 'reserved' })}\n`);
    const one = pane(claudeBox(''));
    const said: string[] = [];

    await wakeUnreadDrops(sceneOf(made, team, one, said), { unreadAfter: N });
    expect(one.typed).toEqual([]);
    expect(one.enters).toBe(0);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);

    reportUnreadDrops(sceneOf(made, team, one, said), { unreadAfter: N });

    const owner = mailboxBody(made.root, 'owner', `unread-${UNREAD_A}`);
    expect(owner.body).toContain(`a wake was reserved at ${at} and its outcome is unconfirmed`);
    expect(owner.body).not.toContain('its wake line was sent');
  });

  test('a spent wake does not stand in the way of a later message', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\ncrashed', new Date(NOW.getTime() - 21 * MIN));
    seedMessage(made, 'acme', 'lead', UNREAD_B, 'from the owner\n\nbehind it', new Date(NOW.getTime() - 15 * MIN));
    const at = '2026-10-17T03:30:00.000Z';
    const spent = `${JSON.stringify({ id: UNREAD_A, at, state: 'reserved' })}\n`;
    writeFileSync(wakePath(dropDir, UNREAD_A), spent);
    const one = pane(claudeBox(''));

    await wakeUnreadDrops(sceneOf(made, team, one, []), { unreadAfter: N });

    // The line was typed for the message behind the spent one, whose reservation is untouched.
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme') as string]);
    expect(readFileSync(wakePath(dropDir, UNREAD_A), 'utf8')).toBe(spent);
    expect(existsSync(wakePath(dropDir, UNREAD_B))).toBe(true);
  });

  test('a held delivery gives its reservation back, and a later pass wakes', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nheld first', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox('a draft this CLI cannot move'));

    // No sendKey: the delivery cannot move the draft and holds without touching the box.
    await wakeUnreadDrops(sceneOf(made, team, one, [], { sources: scripts(one) }), { unreadAfter: N });
    expect(one.typed).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(false);

    one.screen = claudeBox('');
    await wakeUnreadDrops(sceneOf(made, team, one, []), { unreadAfter: N });
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme') as string]);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);
  });

  test('a not-submitted line gives its reservation back, and the retry submits the line already in the box', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nnot submitted', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox(''));
    one.submits = false;

    await wakeUnreadDrops(sceneOf(made, team, one, []), { unreadAfter: N });
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme') as string]);
    expect(one.enters).toBe(3);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(false);

    one.submits = true;
    await wakeUnreadDrops(sceneOf(made, team, one, []), { unreadAfter: N });
    // The second pass pressed Enter on the line already there; it never typed it again.
    expect(one.typed).toEqual([readTriggerLine('lead', 'acme') as string]);
    expect(one.enters).toBe(4);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);
  });

  test('an unreachable delivery keeps its reservation, because the attempt is uncertain', async () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nunreadable', new Date(NOW.getTime() - 11 * MIN));
    const one = pane(claudeBox(''));
    const base = scripts(one);
    let calls = 0;
    const sources: RetrySources = {
      ...base,
      status: () => {
        calls += 1;
        return calls === 1 ? 'idle' : null;
      },
    };

    await wakeUnreadDrops(sceneOf(made, team, one, [], { sources }), { unreadAfter: N });

    expect(one.typed).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD_A))).toBe(true);
  });

  test('a report reservation already on disk publishes nothing', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\nreserved', new Date(NOW.getTime() - 21 * MIN));
    writeFileSync(reportedPath(dropDir, UNREAD_A), `${JSON.stringify({ id: UNREAD_A, at: NOW.toISOString(), state: 'reserved' })}\n`);
    const said: string[] = [];

    reportUnreadDrops(sceneOf(made, team, pane(claudeBox('')), said), { unreadAfter: N });

    expect(said).toEqual([]);
    expect(existsSync(join(made.root, '.agents', 'messages', 'owner', `unread-${UNREAD_A}.json`))).toBe(false);
    expect(existsSync(join(made.root, '.agents', 'messages', 'lead', `unread-${UNREAD_A}.json`))).toBe(false);
  });

  test('a publication already on disk is left byte for byte when its marker is lost', () => {
    const made = world();
    const team = teamOf(teamText(made.root, lobbyDir(made.home)));
    const dropDir = seedMessage(made, 'acme', 'lead', UNREAD_A, 'from the owner\n\npublished', new Date(NOW.getTime() - 21 * MIN));
    const said: string[] = [];
    reportUnreadDrops(sceneOf(made, team, pane(claudeBox('')), said, { now: NOW }), { unreadAfter: N });
    const before = readFileSync(join(made.root, '.agents', 'messages', 'owner', `unread-${UNREAD_A}.json`), 'utf8');
    unlinkSync(reportedPath(dropDir, UNREAD_A));

    const later: string[] = [];
    reportUnreadDrops(sceneOf(made, team, pane(claudeBox('')), later, { now: new Date(NOW.getTime() + 5 * MIN) }), { unreadAfter: N });

    expect(readFileSync(join(made.root, '.agents', 'messages', 'owner', `unread-${UNREAD_A}.json`), 'utf8')).toBe(before);
    expect(later).toEqual([]);
    expect(existsSync(reportedPath(dropDir, UNREAD_A))).toBe(true);
  });
});

function watchSources(directory: string, one: Pane, typed: string[], clock: number): WatchSources {
  return {
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
}

describe('team watch wakes an unread seat', () => {
  test('the pass types the seat\'s own drop read once the unread window passes', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'team-unread-watch-')));
    base = directory;
    execFileSync('git', ['init', '-q'], { cwd: directory });
    mkdirSync(join(directory, '.agents'));
    const file = join(directory, '.agents', 'team.yaml');
    writeFileSync(file, raw);
    const clock = Date.parse('2026-10-03T14:00:00Z');
    const body = 'from the owner\n\nwatched';
    // The fixture writes no `watch` section: the default window is ten minutes.
    seedMessage({ root: directory, dir: join(directory, '.agents'), home: directory }, 'acme-web', 'deepseek-acme', UNREAD_B, body, new Date(clock - 11 * MIN));

    const one = pane(claudeBox(''));
    const typed: string[] = [];
    const io = testIo(directory, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, watchSources(directory, one, typed, clock));

    expect(code).toBe(0);
    expect(typed).toEqual([readTriggerLine('deepseek-acme', 'acme-web') as string]);
    expect(one.enters).toBe(1);
    expect(io.out).toContain('deepseek-acme: a message from owner was unread and one wake line was sent (trigger taken, no read receipt yet)');
    const history = readHistory('acme-web', directory, directory);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.at(-1)).toMatchObject({ id: UNREAD_B, outcome: 'sent (unconfirmed)', via: 'typed' });
  });

  test('--no-nudge types nothing and still reports a message unread at twice the window', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'team-unread-report-')));
    base = directory;
    execFileSync('git', ['init', '-q'], { cwd: directory });
    mkdirSync(join(directory, '.agents'));
    const file = join(directory, '.agents', 'team.yaml');
    writeFileSync(file, raw);
    const clock = Date.parse('2026-10-03T14:00:00Z');
    seedMessage({ root: directory, dir: join(directory, '.agents'), home: directory }, 'acme-web', 'deepseek-acme', UNREAD_B, 'from the owner\n\nnobody came', new Date(clock - 21 * MIN));

    const one = pane(claudeBox(''));
    const typed: string[] = [];
    const io = testIo(directory, { kind: 'owner' });
    const code = await runWatch(['--file', file, '--no-nudge'], io, watchSources(directory, one, typed, clock));

    expect(code).toBe(0);
    expect(typed).toEqual([]);
    expect(one.enters).toBe(0);
    const owner = mailboxBody(directory, 'owner', `unread-${UNREAD_B}`);
    expect(owner.body).toContain('no wake line was typed');
    expect(mailboxBody(directory, 'claude-coordinator-acme', `unread-${UNREAD_B}`).body).toBe(owner.body);
    expect(io.out).toContain('deepseek-acme: a message from owner was still unread after 21 min; reported to owner and claude-coordinator-acme');
  });
});
