// The watch's own direct-work sender: the principal is established by the actual authority
// verifier, admission binds it to the team file it was verified against, and every direct
// transport sits behind a recheck. These scenes are synthetic — a temporary team, a fake socket
// folder and a scripted pane — and none touches a live session or a real CLI home.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { runSend, sendDirect, type WatchSendPrincipal } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import { verifyWatchAuthority, WATCH_DIRECT_WORK } from '../src/watch/authority.ts';
import { sendWatchDirect } from '../src/watch/direct-send.ts';
import { dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const PANE = 'w1:p1';
const EPOCH = `watch_${'0f'.repeat(16)}`;
const OTHER = `watch_${'ab'.repeat(16)}`;

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's own declaration that it accepts cross-session frames, and the socket its
 *  pane exposes, written so the declaration predates the socket. */
function accepting(made: World): void {
  const path = cliHookSettingsPath(made.dir, SESSION, 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The registry records `up` leaves: the team, and the running seat its pane is on. */
function registered(made: World): void {
  const id = teamIdOf(made.root);
  const agent = registerAgent(made.home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'lead', session: SESSION, pane: PANE, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, id, {
    project: 'acme',
    entity: 'acme',
    session: SESSION,
    root: made.root,
    lobby: lobbyDir(made.home),
    roster: [{ agent: agent.id, seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
}

/** The team file names its lobby outright. The fixture's lobby lives under the fixture home, and
 *  the actual verifier loads the file under the process's own home; an absolute lobby is the same
 *  folder to both readers, so the file the verifier judges is the file the send resolves. */
function verifiable(made: World): void {
  const path = join(made.dir, 'team.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}lobby: ${lobbyDir(made.home)}\n`);
}

/** The session state a live watch leaves: the seat's pane, the watch record this process holds,
 *  and the watchdog file record. The heartbeat is stamped at seeding, inside the liveness bound. */
function watching(made: World, epoch = EPOCH): void {
  updateState(made.dir, (state) => {
    state.sessions[SESSION] = {
      seats: { lead: { stage: 'launched', pane: PANE, workspace: 'w1' } },
      worktrees: {},
      watch: { pid: process.pid, epoch, heartbeat: new Date().toISOString(), pane: 'w9:p9' },
      watchdog: { file: join(made.dir, 'team.yaml'), pane: 'w9:p9' },
    };
  });
}

/** The same session record with another watch's epoch: what a replacement process writes. */
function replaced(made: World): void {
  updateState(made.dir, (state) => {
    const session = state.sessions[SESSION];
    if (session === undefined || session.watch === undefined) throw new Error('the fixture watches nothing');
    session.watch.epoch = OTHER;
    session.watch.heartbeat = new Date().toISOString();
  });
}

/** The team file with one seat marked as a person's: the watch wakes seats only. */
function declareHuman(made: World, seat = 'helper'): void {
  const path = join(made.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8');
  const block = `  - role: implementer\n    name: ${seat}\n`;
  if (!text.includes(block)) throw new Error(`the fixture declares no ${seat}`);
  writeFileSync(path, text.replace(block, `  - role: implementer\n    name: ${seat}\n    human: true\n`));
}

/** The staged record's id, read from the receiver's folder: a watch send stages before it dials. */
function stagedIds(made: World, seat = 'lead'): string[] {
  try {
    return readdirSync(dropDir(made.dir, seat)).filter((name) => MESSAGE_ID.test(name));
  } catch {
    return [];
  }
}

describe("the watch's direct-work sender", () => {
  test('walks the socket as the watch principal, stages its record and types nothing', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    watching(made);
    const pane = scripted(['idle'], null);
    const dials: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
    });

    const result = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: EPOCH },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: 'a note' },
      host,
    );

    expect(result).toEqual({ ok: true, outcome: 'socket: delivered' });
    expect(dials).toHaveLength(1);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    // The record the receiver keeps is the watch's own: a non-seat sender, never the owner.
    const ids = stagedIds(made);
    expect(ids).toHaveLength(1);
    const staged = readFileSync(join(dropDir(made.dir, 'lead'), ids[0] as string), 'utf8');
    expect(staged).toContain('"from": "watch"');
    expect(staged).toContain("from the watch — admitted by: the watch's direct-work authority");
    expect(staged).not.toContain('from the owner');
  });

  test('an epoch replaced during preparation stops the walk at the recheck: no dial, no resume', async () => {
    const made = world(['socket', 'headless-resume']);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    watching(made);
    const pane = scripted(['idle'], null);
    const dials: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
      // The preparation's own clock: the message id is minted after the first verification and
      // before the record is staged, so the replacement lands while this send prepares.
      sendId: () => {
        replaced(made);
        return '11111111-2222-4333-8444-555555555555';
      },
    });

    const result = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: EPOCH },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: 'a note' },
      host,
    );

    // The record was staged before the recheck, and the recheck read the replaced epoch: the
    // walk ends at the socket, with no dial and no resume attempt behind it.
    expect(stagedIds(made)).toHaveLength(1);
    expect(result).toEqual({ ok: false, refused: "socket: refused: the recorded watch is another watch's epoch" });
    expect(dials).toHaveLength(0);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('an epoch replaced during a refused socket dial stops the walk before the typed fallback', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    watching(made);
    const pane = scripted(['idle', 'working'], null);
    const dials: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        // The receiver refuses the frame as a replacement watch takes the session: the walk this
        // refusal hands the send to is the typed fallback, which must run the principal's recheck
        // again before any key leaves.
        replaced(made);
        throw new Error('the session closed the connection before it took the frame');
      },
    });

    const result = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: EPOCH },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: 'a note' },
      host,
    );

    // The socket attempt was made and refused; the typed fallback was refused by the recheck, not
    // attempted. The ending names the fallback and the verifier's own reason.
    expect(result).toEqual({
      ok: false,
      refused: "typed: refused: the recorded watch is another watch's epoch",
    });
    expect(stagedIds(made)).toHaveLength(1);
    expect(dials).toHaveLength(1);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a principal from another root is refused before anything is staged, whatever the io caller', async () => {
    const captured = world(null);
    cleanup = captured.cleanup;
    const other = world(null);
    registered(other);
    // The io caller is the owner: with no watch principal that is the strongest caller there is,
    // and the refusal below proves the run is judged as the watch, never as this caller.
    const io = owner(other.root);
    const principal: WatchSendPrincipal = {
      root: captured.root,
      session: SESSION,
      recheck: () => ({ ok: true }),
    };
    const dials: string[] = [];
    const host = fake(other, {
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
    });

    const run = await sendDirect(io, host, {
      seat: 'lead',
      pane: PANE,
      cli: 'claude-code',
      body: 'a note',
      watch: principal,
    });

    expect(run.code).toBe(1);
    expect(run.result).toBeNull();
    expect(io.err).toContain('the watch was verified for its captured root, and this run loaded another root');
    expect(io.err).not.toContain('from the owner');
    expect(stagedIds(other)).toEqual([]);
    expect(dials).toHaveLength(0);
  });

  test("a person's pane and the owner address are never a watch target", async () => {
    const made = world(null);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    watching(made);
    declareHuman(made);
    const host = fake(made);

    const human = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: EPOCH },
      { seat: 'helper', pane: 'w2:p1', cli: 'claude-code', body: 'a note' },
      host,
    );
    expect(human.ok).toBe(false);
    if (human.ok) return;
    expect(human.refused).toContain("helper: the pane is a person's, and the watch wakes seats only");

    const ownerTarget = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: EPOCH },
      { seat: 'owner', pane: PANE, cli: 'claude-code', body: 'a note' },
      host,
    );
    expect(ownerTarget.ok).toBe(false);
    if (ownerTarget.ok) return;
    expect(ownerTarget.refused).toContain('owner: it is not a declared seat');
    expect(stagedIds(made)).toEqual([]);
  });

  test('a recheck that throws ends the walk with its reason and attempts no other route', async () => {
    const made = world(['socket', 'headless-resume']);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    watching(made);
    const pane = scripted(['idle'], null);
    const dials: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
    });
    const principal: WatchSendPrincipal = {
      root: made.root,
      session: SESSION,
      recheck: () => {
        throw new Error('the recheck could not answer');
      },
    };

    const run = await sendDirect(owner(made.root), host, {
      seat: 'lead',
      pane: PANE,
      cli: 'claude-code',
      body: 'a note',
      guard: () => principal.recheck(),
      watch: principal,
    });

    expect(run.result).toEqual({ outcome: 'refused', route: 'socket', id: expect.any(String), record: expect.any(String), reason: 'the recheck could not answer' });
    expect(dials).toHaveLength(0);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a watch send with no direct context is refused before anything is staged', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    watching(made);
    const pane = scripted(['idle'], null);
    const dials: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
    });
    // A principal whose own verdict is favourable: the refusal must come from the missing direct
    // context alone, not from the watch ceasing to hold its authority.
    const principal: WatchSendPrincipal = { root: made.root, session: SESSION, recheck: () => ({ ok: true }) };
    const io = owner(made.root);

    const code = await runSend(['lead', 'a note'], io, { ...host, watch: principal });

    expect(code).toBe(1);
    expect(io.err).toContain("the watch's send carries no direct context to bind it");
    expect(stagedIds(made)).toEqual([]);
    expect(dials).toHaveLength(0);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  // The watch's recheck is composed by the send itself, not handed in by the caller: an external
  // guard that is missing or always permits must not drop it. The epoch is replaced during
  // preparation, and the walk must still stop at the socket with nothing dialled or resumed.
  for (const [label, guard] of [
    ['omitted', undefined],
    ['permissive', () => ({ ok: true as const })],
  ] as const) {
    test(`an ${label} external guard cannot drop the watch's recheck`, async () => {
      const made = world(['socket', 'headless-resume']);
      cleanup = made.cleanup;
      accepting(made);
      registered(made);
      verifiable(made);
      watching(made);
      const pane = scripted(['idle'], null);
      const dials: string[] = [];
      const host = fake(made, {
        native: pane,
        deliver: async (_socketPath, frame) => {
          dials.push(frame);
          return { ok: true };
        },
        sendId: () => {
          replaced(made);
          return '11111111-2222-4333-8444-555555555555';
        },
      });
      const principal: WatchSendPrincipal = {
        root: made.root,
        session: SESSION,
        recheck: () => {
          const again = verifyWatchAuthority({ root: made.root, session: SESSION, epoch: EPOCH, purpose: WATCH_DIRECT_WORK });
          return again.ok ? { ok: true } : { ok: false, why: again.why };
        },
      };

      const run = await sendDirect(owner(made.root), host, {
        seat: 'lead',
        pane: PANE,
        cli: 'claude-code',
        body: 'a note',
        watch: principal,
        ...(guard === undefined ? {} : { guard }),
      });

      expect(run.result).toEqual({
        outcome: 'refused',
        route: 'socket',
        id: expect.any(String),
        record: expect.any(String),
        reason: "the recorded watch is another watch's epoch",
      });
      expect(stagedIds(made)).toHaveLength(1);
      expect(dials).toHaveLength(0);
      expect(pane.typed).toEqual([]);
      expect(pane.enters).toBe(0);
    });
  }
});
