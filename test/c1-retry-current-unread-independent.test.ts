// C1 round 2, independent: the retry pass retires nothing that is both current and unread.
//
// The watch's age bound exists so a marker nobody took leaves eventually. A launch-brief marker
// whose record is still the seat's current claim and whose delivery no receipt has shown to be
// read proves a delivery the seat still owes; giving it up past the bound would retire the very
// delivery the seat's next look is meant to find. The exemption must be narrow: an ordinary
// send's marker still ages out, and a marker of an earlier delivery is still retired as
// superseded. The two round-1 pins ride along: a read marker of the current claim is retired
// with one line, and a human seat's current unread marker is kept without typing into the pane.
//
// These scenes drive the real retryHeldDrops with their own fixtures and a scripted pane; the
// signed records are the product's own signer, so the bytes compared are the ones a launch
// would have left. No builder fixture or product file is reused.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrAgent } from '../src/herdr.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import {
  GENERAL_BRIEF_FROM,
  GENERAL_BRIEF_RULE,
  GENERAL_BRIEF_SHA256,
  generalBriefBody,
  generalBriefId,
} from '../src/launch/general-brief.ts';
import { mintBriefEpoch, mintBriefIncarnation } from '../src/launch/brief-id.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending, PENDING_MAX_AGE_MS, pendingDropPath } from '../src/send/pending.ts';
import { signReceiptPayload, signRecord, writeReceipt } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { retryHeldDrops, type RetrySources } from '../src/watch/retry.ts';

const NOW = new Date('2026-10-31T09:30:00.000Z');
/** Past the whole retry window: the age bound has nothing left to give this marker. */
const AGED = new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 5 * 60_000).toISOString();
const SEAT = 'wisp';
const SESSION = 'acme';

let base = '';

afterEach(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamText(root: string, lobby: string, humanDesk = false): string {
  return `format: 1
project: acme
coordinator: helm
operator: bosun
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: helm
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: operator
    name: bosun
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${SEAT}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${humanDesk
    ? `  - role: operator
    name: desk
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    human: true
`
    : ''}`;
}

type World = { root: string; dir: string; home: string; team: TeamFile };

/** The seat's own drop folder under this session. */
function dropDirOf(at: World, seat = SEAT): string {
  return join(at.dir, 'send-drops', SESSION, seat);
}

function world(input: { humanDesk?: boolean } = {}): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-c1retry-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = teamText(root, lobbyDir(home), input.humanDesk === true);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { root, dir, home, team: loaded.team };
}

/** The seat's current claim, written the way a launch writes it: one lifetime's id. */
function claimFor(at: World, seat = SEAT): { id: string; incarnation: string; epoch: string } {
  const incarnation = mintBriefIncarnation();
  const epoch = mintBriefEpoch();
  const id = generalBriefId(incarnation, generalBriefBody(), 0);
  updateState(at.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.briefs = {
      ...(session.briefs ?? {}),
      [seat]: {
        id,
        at: NOW.toISOString(),
        incarnation,
        epoch,
        sha256: GENERAL_BRIEF_SHA256,
        attempt: 0,
        stage: 'claimed' as const,
      },
    };
  });
  return { id, incarnation, epoch };
}

/** A launch-brief sidecar the launch's own walk leaves: the signed record, then the marker. */
function seedLaunchSidecar(
  at: World,
  input: { incarnation: string; ts: string; seat?: string },
): { id: string; pending: string; record: string } {
  const seat = input.seat ?? SEAT;
  const dropDir = dropDirOf(at, seat);
  const body = generalBriefBody();
  const id = generalBriefId(input.incarnation, body, 0);
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: input.ts,
    body,
    from: GENERAL_BRIEF_FROM,
    from_id: null,
    rule: GENERAL_BRIEF_RULE,
    thread: id,
    brief_sha256: GENERAL_BRIEF_SHA256,
    incarnation: input.incarnation,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  markPending(dropDir, { id, from: GENERAL_BRIEF_FROM, to: seat, body, ts: input.ts });
  return { id, pending: pendingDropPath(dropDir, id), record: join(dropDir, id) };
}

/** An ordinary send's held marker, with the signed record it names. */
function seedOrdinary(at: World, input: { ts: string; seat?: string }): { id: string; pending: string; record: string } {
  const seat = input.seat ?? SEAT;
  const dropDir = dropDirOf(at, seat);
  const id = 'ord_0123456789ab';
  const body = 'from the owner — a note for the retry scene\n';
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: input.ts,
    body,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  markPending(dropDir, { id, from: 'owner', to: seat, body, ts: input.ts });
  return { id, pending: pendingDropPath(dropDir, id), record: join(dropDir, id) };
}

function liveWith(seat: string): Live {
  const agents: HerdrAgent[] = [
    { name: seat, agent: 'claude', pane: 'fixture-pane-1', workspace: 'first', status: 'idle', cwd: null },
    { name: null, agent: 'claude', pane: 'fixture-pane-2', workspace: 'helm', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

/** The real pass, with a pane it may type into: `typed` records what, if anything, it sent. */
async function pass(at: World, options: { seat?: string } = {}): Promise<{ said: string[]; typed: string[] }> {
  const seat = options.seat ?? SEAT;
  const typed: string[] = [];
  const said: string[] = [];
  const sources: RetrySources = {
    screen: () => '╭─\n│ Ready\n╰─',
    status: () => 'idle',
    typeText: (_pane, text) => {
      typed.push(text);
      return true;
    },
    pressEnter: () => true,
    sleep: async () => {},
  };
  await retryHeldDrops({
    dir: at.dir,
    session: SESSION,
    root: at.root,
    home: at.home,
    team: at.team,
    live: liveWith(seat),
    ownPane: null,
    sources,
    now: NOW,
    say: (text) => said.push(text),
  });
  return { said, typed };
}

describe('C1 round 2: the retry age bound and a current unread brief', () => {
  test('an aged marker of the current unread delivery is not given up on', async () => {
    const at = world();
    const claim = claimFor(at);
    const sidecar = seedLaunchSidecar(at, { incarnation: claim.incarnation, ts: AGED });
    const bytes = readFileSync(sidecar.record, 'utf8');

    const run = await pass(at);

    // Nothing about this marker may be retired: the marker stands, no give-up line names it,
    // and the signed record is byte-for-byte the one the launch left.
    expect(existsSync(sidecar.pending)).toBe(true);
    expect(readFileSync(sidecar.record, 'utf8')).toBe(bytes);
    expect(run.said).toEqual([]);
    // The claim the exemption rests on is unchanged.
    expect(readState(at.dir).sessions[SESSION]?.briefs?.[SEAT]?.id).toBe(claim.id);
  });

  test('the exemption is narrow: an ordinary send past the bound is still given up on', async () => {
    const at = world();
    const claim = claimFor(at);
    const sidecar = seedLaunchSidecar(at, { incarnation: claim.incarnation, ts: AGED });
    const ordinary = seedOrdinary(at, { ts: AGED });

    const run = await pass(at);

    expect(existsSync(sidecar.pending)).toBe(true);
    expect(existsSync(ordinary.pending)).toBe(false);
    expect(run.said).toEqual([
      `${SEAT}: a held send from owner was not delivered (the retry window passed); the record is at ${ordinary.record}; send it again`,
    ]);
  });

  test('a marker of an earlier delivery, however old, is still retired as superseded', async () => {
    const at = world();
    const claim = claimFor(at);
    const current = seedLaunchSidecar(at, { incarnation: claim.incarnation, ts: AGED });
    const earlier = mintBriefIncarnation();
    const stale = seedLaunchSidecar(at, { incarnation: earlier, ts: AGED });

    const run = await pass(at);

    expect(existsSync(current.pending)).toBe(true);
    expect(existsSync(stale.pending)).toBe(false);
    expect(run.said).toEqual([
      `${SEAT}: a dropped send from the launch was superseded by the seat's newer brief delivery`,
    ]);
  });

  // The round-1 pin: a receipt bound to the current claim proves the delivery was read, so its
  // marker is retired — with exactly one line saying why.
  test('a read marker of the current claim is retired with one line', async () => {
    const at = world();
    const claim = claimFor(at);
    const sidecar = seedLaunchSidecar(at, { incarnation: claim.incarnation, ts: NOW.toISOString() });
    expect(sidecar.id).toBe(claim.id);
    const written = writeReceipt(dropDirOf(at), signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: claim.id,
      to: SEAT,
      root: realpathSync(at.root),
      session: SESSION,
      at: NOW.toISOString(),
      brief_sha256: GENERAL_BRIEF_SHA256,
      incarnation: claim.incarnation,
      brief_epoch: claim.epoch,
    }, at.home), at.home);
    if (!written.ok) throw new Error(written.reason);
    const bytes = readFileSync(sidecar.record, 'utf8');

    const run = await pass(at);

    expect(existsSync(sidecar.pending)).toBe(false);
    expect(run.said).toEqual([`${SEAT}: a dropped send from the launch was read in its drop folder`]);
    // The record itself is the launch's, untouched — the retry only clears the marker.
    expect(readFileSync(sidecar.record, 'utf8')).toBe(bytes);
    expect(run.typed).toEqual([]);
  });

  // The round-2 fix's human path: a human seat's unread current marker is owed too, so the human
  // cleanup must not give it up; the pane is still never typed into.
  test('a human seat\'s current unread marker is kept, and nothing is typed into its pane', async () => {
    const at = world({ humanDesk: true });
    const claim = claimFor(at, 'desk');
    const sidecar = seedLaunchSidecar(at, { incarnation: claim.incarnation, ts: NOW.toISOString(), seat: 'desk' });
    const bytes = readFileSync(sidecar.record, 'utf8');

    const run = await pass(at, { seat: 'desk' });

    expect(existsSync(sidecar.pending)).toBe(true);
    expect(readFileSync(sidecar.record, 'utf8')).toBe(bytes);
    expect(run.said).toEqual([]);
    expect(run.typed).toEqual([]);
    expect(readState(at.dir).sessions[SESSION]?.briefs?.desk?.id).toBe(claim.id);
  });
});
