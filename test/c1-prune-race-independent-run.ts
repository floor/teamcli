// C1 round 2, independent: `team brief prune --apply` racing a launch that publishes a newer
// claim. The launch is injected at the pending-snapshot seam: the claim the prune read is A,
// and before the marker list is returned a launch writes claim B and its marker the way a
// launch writes them (claim first, signed record, marker). B is therefore current, unread and
// complete by the time prune classifies the list. Prune must retire nothing and say why: a list
// classified against a claim the state has already left cannot be trusted, and B's marker is
// the one a retry still owes. The --vanish scene withdraws the claim instead, so the re-read
// finds none; --stable leaves the claim alone for the control.
//
// Run as its own process so the seam is in place before the command loads, with the real
// module's functions captured by value before the mock is registered.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
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
import * as realPending from '../src/send/pending.ts';
import { markPending, pendingDropPath } from '../src/send/pending.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { runBrief } from '../src/commands/brief.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T09:30:00.000Z');
const SESSION = 'acme';
const SEAT = 'wisp';
const PANE = 'fixture-pane-1';

function teamText(root: string, lobby: string): string {
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
`;
}

type World = { base: string; root: string; dir: string; home: string; dropDir: string; team: TeamFile };

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-c1prune-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = teamText(root, lobbyDir(home));
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { base, root, dir, home, dropDir: join(dir, 'send-drops', SESSION, SEAT), team: loaded.team };
}

/** The seat's recorded pane, so the prune's caller gate places the caller on it. */
function placeSeat(at: World): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats = { ...(session.seats ?? {}), [SEAT]: { stage: 'ready' as const, pane: PANE } };
  });
}

/** A lifetime's claim, as a launch writes it to the session state. */
function writeClaim(at: World, claim: { id: string; incarnation: string; epoch: string }): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.briefs = {
      ...(session.briefs ?? {}),
      [SEAT]: {
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
}

/** The delivery's signed record, then its marker: the order a launch's own walk uses. */
function writeDelivery(at: World, claim: { id: string; incarnation: string }): string {
  mkdirSync(at.dropDir, { recursive: true });
  const body = generalBriefBody();
  const record = signRecord({
    kind: 'message',
    id: claim.id,
    to: SEAT,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: NOW.toISOString(),
    body,
    from: GENERAL_BRIEF_FROM,
    from_id: null,
    rule: GENERAL_BRIEF_RULE,
    thread: claim.id,
    brief_sha256: GENERAL_BRIEF_SHA256,
    incarnation: claim.incarnation,
  }, at.home);
  dropMessage(at.dropDir, claim.id, `${JSON.stringify(record, null, 2)}\n`);
  markPending(at.dropDir, { id: claim.id, from: GENERAL_BRIEF_FROM, to: SEAT, body, ts: NOW.toISOString() });
  return pendingDropPath(at.dropDir, claim.id);
}

function mintClaim(): { id: string; incarnation: string; epoch: string } {
  const incarnation = mintBriefIncarnation();
  return { id: generalBriefId(incarnation, generalBriefBody(), 0), incarnation, epoch: mintBriefEpoch() };
}

const at = world();
let code: number;
let out = '';
let err = '';
let markerB = '';
let recordB = '';
let staleMarker = '';
const stable = process.argv.includes('--stable');
const vanish = process.argv.includes('--vanish');
let claimB: { id: string; incarnation: string; epoch: string } = mintClaim();
try {
  placeSeat(at);
  const claimA = mintClaim();
  writeClaim(at, claimA);
  const markerA = writeDelivery(at, claimA);

  // The concurrent launch: before prune reads the marker list, a newer delivery is published in
  // the launch's own order (claim, signed record, marker). The stable control publishes nothing:
  // A's marker is current and unread, and a delivery of an earlier lifetime is the only marker
  // the prune may retire. The vanish scene withdraws the claim instead, so the re-read finds
  // none.
  claimB = mintClaim();
  const realReadPending = realPending.readPending;
  let published = false;
  if (!stable) {
    mock.module('../src/send/pending.ts', () => ({
      ...realPending,
      readPending: (dropDir: string) => {
        if (!published) {
          published = true;
          if (vanish) {
            updateState(at.dir, (state) => {
              const session = state.sessions[SESSION];
              if (session?.briefs !== undefined) delete session.briefs[SEAT];
            });
          } else {
            writeClaim(at, claimB);
            markerB = writeDelivery(at, claimB);
            recordB = readFileSync(join(at.dropDir, claimB.id), 'utf8');
          }
        }
        return realReadPending(dropDir);
      },
    }));
  } else {
    // In the control the current claim stays A; an earlier lifetime's marker is the one due.
    claimB = claimA;
    staleMarker = writeDelivery(at, mintClaim());
  }
  if (vanish) {
    // The withdrawn claim is still the first read's; a marker the listing classifies against it
    // is there, so the re-read's answer actually decides this run.
    claimB = claimA;
    staleMarker = writeDelivery(at, mintClaim());
  }

  const io = testIo(at.root, { kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
  code = await runBrief(['prune', '--apply'], io, { home: at.home, now: () => NOW });
  out = io.out;
  err = io.err;

  const claimAfter = readState(at.dir).sessions[SESSION]?.briefs?.[SEAT]?.id ?? null;
  process.stdout.write(`${JSON.stringify({
    stable,
    published,
    code,
    out,
    err,
    markerAExists: existsSync(markerA),
    markerAPath: markerA,
    markerB,
    markerBExists: markerB !== '' && existsSync(markerB),
    recordBUnchanged: markerB === '' || (existsSync(join(at.dropDir, claimB.id)) && readFileSync(join(at.dropDir, claimB.id), 'utf8') === recordB),
    staleMarker,
    staleExists: staleMarker !== '' && existsSync(staleMarker),
    claimAfter,
    claimB: claimB.id,
  })}\n`);
} finally {
  rmSync(at.base, { recursive: true, force: true });
}
