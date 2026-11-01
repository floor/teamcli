// C1, independent: two round-1 properties of the general brief delivery, pinned on their own.
//
// (1) A re-broadcast of a claim the seat already holds writes no new sidecar. Once the claim
// and its signed record stand, the rollout's second pass targets the same delivery, walks no
// leg, and leaves the drop folder byte-for-byte as the first walk left it — before and after
// the seat reads it. (2) `team brief prune --apply` reaches only the caller's own drop folder:
// run as one seat it retires that seat's earlier-lifetime marker and leaves a second declared
// seat's folder untouched, current marker and all.
//
// The scenes drive the real delivery walk and the real command with their own fixtures. The
// inbox listener is the product's own writeListener; the send host is a fake that refuses every
// pane, so no scene reaches the terminal host.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrief } from '../src/commands/brief.ts';
import type { SendHost } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  GENERAL_BRIEF_FROM,
  GENERAL_BRIEF_RULE,
  GENERAL_BRIEF_SHA256,
  currentBriefClaim,
  deliverBriefForAttribution,
  generalBriefBody,
  generalBriefId,
  walkBriefDeliveries,
  type CurrentBriefClaim,
} from '../src/launch/general-brief.ts';
import { mintBriefEpoch, mintBriefIncarnation } from '../src/launch/brief-id.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readMessage, writeListener } from '../src/mcp/inbox.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { clearPending, markPending, pendingDropPath } from '../src/send/pending.ts';
import { dropMessage, type NativePane } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T09:30:00.000Z');
const SESSION = 'acme';
const PROJECT = 'acme';
const WISP = 'wisp';
const HELM = 'helm';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; dir: string; home: string; sockets: string };

function teamText(root: string, lobby: string): string {
  return `format: 1
project: ${PROJECT}
coordinator: ${HELM}
operator: bosun
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: ${HELM}
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
    name: ${WISP}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-c1round1-')));
  made.push(base);
  const root = join(base, PROJECT);
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = teamText(root, lobbyDir(home));
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { base, root, dir, home, sockets };
}

function dropDir(w: World, seat: string): string {
  return join(w.dir, 'send-drops', SESSION, seat);
}

/** The team-level policy read the walk follows: briefs travel as messages. */
function setMessageTransport(w: World): void {
  const wrote = writePolicySet(
    w.home,
    { level: 'team', target: w.root, teamRoot: w.root, name: 'brief-transport', value: 'message' },
    { now: NOW },
  );
  if (!wrote.ok) throw new Error(wrote.why);
}

/** A send host that refuses every pane: the scenes exercise the delivery legs, not the host. */
function fake(w: World): SendHost {
  const native: NativePane = {
    typeText: () => {
      throw new Error('no scene types into a pane');
    },
    pressEnter: () => {
      throw new Error('no scene types into a pane');
    },
    status: () => 'idle',
    wait: async () => {},
  };
  return {
    agents: () => [],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: w.home,
    inboxGraceMs: 0,
  };
}

/** Every file in a seat's drop folder and its bytes: the sidecar snapshot. */
function snapshot(w: World, seat: string): Record<string, string> {
  const dir = dropDir(w, seat);
  if (!existsSync(dir)) return {};
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isFile()) files[name] = readFileSync(path, 'utf8');
  }
  return files;
}

function claimOf(w: World, seat: string): CurrentBriefClaim | null {
  return currentBriefClaim(readState(w.dir).sessions[SESSION]?.briefs?.[seat]);
}

// ---------------------------------------------------------------- (1) re-broadcast

function placeSeat(w: World, seat: string, pane: string): void {
  updateState(w.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats = { ...(session.seats ?? {}), [seat]: { stage: 'ready' as const, pane } };
  });
}

/** The rollout's own shape: no attributed seat, every live seat broadcast to. */
function broadcast(w: World) {
  return deliverBriefForAttribution({
    dir: w.dir,
    root: w.root,
    session: SESSION,
    home: w.home,
    now: NOW,
    team: { seats: [{ name: WISP, cli: 'claude-code' }] },
    state: readState(w.dir).sessions[SESSION] ?? emptySession(),
    attributed: [],
    broadcast: true,
  });
}

describe('C1 round 1: a re-broadcast writes no new sidecar', () => {
  test('the held claim is walked once, and later broadcasts leave the folder byte-identical', async () => {
    const w = world();
    setMessageTransport(w);
    placeSeat(w, WISP, 'fixture-pane-1');

    const first = broadcast(w);
    const delivery = first.deliveries[0];
    if (delivery === undefined || !delivery.ok) throw new Error(JSON.stringify(first));
    expect(first.walks).toHaveLength(1);
    expect(delivery.existing).not.toBe(true);
    expect(claimOf(w, WISP)?.id).toBe(delivery.id);

    // A live inbox listener takes the brief; the walk leaves the claim's retry marker beside
    // the signed record the launch already wrote.
    writeListener(dropDir(w, WISP), {
      v: 1,
      seat: WISP,
      session: SESSION,
      root: w.root,
      cli: 'claude-code',
      pid: process.pid,
      ts: NOW.toISOString(),
    });
    await walkBriefDeliveries(first, { dir: w.dir, home: w.home, sendHost: fake(w) });
    expect(delivery.message).toMatchObject({ via: 'mcp-inbox', walked: true, exit: 0 });
    const held = snapshot(w, WISP);
    expect(Object.keys(held).filter((name) => name.endsWith('.pending'))).toEqual([`${delivery.id}.pending`]);
    const record = held[delivery.id];
    expect(record).toBeString();

    // The claim and its record already stand, so this broadcast is the same delivery, not a new
    // notification: nothing is walked, and nothing in the folder moves — the sidecar the first
    // walk left is neither rewritten nor doubled.
    const second = broadcast(w);
    expect(second.deliveries[0]).toMatchObject({ ok: true, existing: true, id: delivery.id });
    expect(second.walks ?? []).toEqual([]);
    await walkBriefDeliveries(second, { dir: w.dir, home: w.home, sendHost: fake(w) });
    expect(snapshot(w, WISP)).toEqual(held);
    expect(claimOf(w, WISP)?.id).toBe(delivery.id);

    // The seat reads the brief — a signed receipt bound to the claim — and the watch's promote
    // clears the marker. A broadcast after the read still walks nothing and writes no sidecar.
    const bound = claimOf(w, WISP);
    if (bound === null) throw new Error('the delivery left no claim');
    const read = readMessage(
      { dropDir: dropDir(w, WISP), root: w.root, seat: WISP, session: SESSION },
      delivery.id,
      w.home,
      { claim: () => bound },
    );
    expect(read.ok).toBe(true);
    clearPending(dropDir(w, WISP), delivery.id);
    const afterRead = snapshot(w, WISP);
    expect(Object.keys(afterRead).filter((name) => name.endsWith('.pending'))).toEqual([]);

    const third = broadcast(w);
    expect(third.walks ?? []).toEqual([]);
    await walkBriefDeliveries(third, { dir: w.dir, home: w.home, sendHost: fake(w) });
    expect(snapshot(w, WISP)).toEqual(afterRead);
    // The signed record is still the first walk's bytes.
    expect(afterRead[delivery.id]).toBe(record);
  });
});

// ---------------------------------------------------------------- (2) another seat's folder

function mintClaim(): { id: string; incarnation: string; epoch: string } {
  const incarnation = mintBriefIncarnation();
  return { id: generalBriefId(incarnation, generalBriefBody(), 0), incarnation, epoch: mintBriefEpoch() };
}

/** The seat's current claim, as a launch writes it to the session state. */
function writeClaim(w: World, seat: string): { id: string; incarnation: string; epoch: string } {
  const claim = mintClaim();
  updateState(w.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.briefs = {
      ...(session.briefs ?? {}),
      [seat]: {
        id: claim.id,
        at: NOW.toISOString(),
        incarnation: claim.incarnation,
        epoch: claim.epoch,
        sha256: GENERAL_BRIEF_SHA256,
        attempt: 0,
        stage: 'claimed' as const,
      },
    };
  });
  return claim;
}

/** A delivery's signed record and its marker, in the launch's own order; returns the marker path. */
function writeDelivery(w: World, seat: string, claim: { id: string; incarnation: string }): string {
  const dir = dropDir(w, seat);
  mkdirSync(dir, { recursive: true });
  const body = generalBriefBody();
  const record = signRecord({
    kind: 'message',
    id: claim.id,
    to: seat,
    to_id: null,
    root: realpathSync(w.root),
    session: SESSION,
    at: NOW.toISOString(),
    body,
    from: GENERAL_BRIEF_FROM,
    from_id: null,
    rule: GENERAL_BRIEF_RULE,
    thread: claim.id,
    brief_sha256: GENERAL_BRIEF_SHA256,
    incarnation: claim.incarnation,
  }, w.home);
  dropMessage(dir, claim.id, `${JSON.stringify(record, null, 2)}\n`);
  markPending(dir, { id: claim.id, from: GENERAL_BRIEF_FROM, to: seat, body, ts: NOW.toISOString() });
  return pendingDropPath(dir, claim.id);
}

describe('C1 round 1: another seat cannot prune your folder', () => {
  test('prune --apply retires only the caller\'s own earlier-lifetime markers', async () => {
    const w = world();
    const claimW = writeClaim(w, WISP);
    const claimH = writeClaim(w, HELM);
    placeSeat(w, WISP, 'fixture-pane-1');
    placeSeat(w, HELM, 'fixture-pane-2');
    const currentW = writeDelivery(w, WISP, claimW);
    const staleW = writeDelivery(w, WISP, mintClaim());
    const currentH = writeDelivery(w, HELM, claimH);
    const staleH = writeDelivery(w, HELM, mintClaim());

    // As helm: helm's earlier lifetime is due and retired; wisp's folder is another declared
    // seat's own, so both of its markers stand — the current one by the unread rule, the
    // earlier lifetime's because this run never looks there.
    const asHelm = testIo(w.root, { kind: 'seat', name: HELM, pane: 'fixture-pane-2', session: SESSION });
    expect(await runBrief(['prune', '--apply'], asHelm, { home: w.home, now: () => NOW })).toBe(0);
    expect(existsSync(staleH)).toBe(false);
    expect(existsSync(currentH)).toBe(true);
    expect(existsSync(staleW)).toBe(true);
    expect(existsSync(currentW)).toBe(true);
    expect(asHelm.out).toContain(staleH);
    expect(asHelm.out).not.toContain(staleW);

    // As wisp: now wisp's own earlier lifetime is retired, and helm's current marker is
    // untouched — the folder reached is still the caller's own.
    const asWisp = testIo(w.root, { kind: 'seat', name: WISP, pane: 'fixture-pane-1', session: SESSION });
    expect(await runBrief(['prune', '--apply'], asWisp, { home: w.home, now: () => NOW })).toBe(0);
    expect(existsSync(staleW)).toBe(false);
    expect(existsSync(currentW)).toBe(true);
    expect(existsSync(currentH)).toBe(true);
    expect(asWisp.out).toContain(staleW);
    expect(asWisp.out).not.toContain(currentH);
  });
});
