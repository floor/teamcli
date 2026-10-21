// Independent acceptance of the watch's own direct-work sender on source 5a032f438. Everything
// below drives the actual `sendWatchDirect` entry, whose authority is the actual
// `verifyWatchAuthority` over a real seeded watch record and a real session state — no verifier
// stub and no hand-made verdict on the entry scenes. The transport is the fixture's fake socket
// and scripted pane, so nothing here touches a live session, a real CLI home or a pane.
//
// The last two scenes pin the reported seam bypasses: a watch principal handed to `runSend`
// without a direct context, and a `sendDirect` call that omits the guard. Both were authored as
// expected failures against 5a032f438, the source on which each body failed, and are ordinary
// tests here because 6a84228f6 makes the principal's recheck and the direct context invariants
// of the watch send.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend, sendDirect, type WatchSendPrincipal } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { STATE_FILE, updateState } from '../src/state.ts';
import { verifyWatchAuthority, WATCH_DIRECT_WORK } from '../src/watch/authority.ts';
import { sendWatchDirect } from '../src/watch/direct-send.ts';
import { mintWatchEpoch } from '../src/watch/epoch.ts';
import { dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const PANE = 'w1:p1';
const BODY = 'take the next task';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving Claude session's declaration that it accepts a cross-session frame, and the
 *  socket its pane exposes, written so the declaration predates the socket. */
function receives(made: World): void {
  const path = cliHookSettingsPath(made.dir, SESSION, 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The team record and the running seat `up` leaves, on the pane the pass reads. The team file
 *  names the fixture's lobby outright: the verifier loads the file under the process's own home,
 *  and an absolute lobby is the same lobby to that reader and to the send's. */
function registered(made: World): ReturnType<typeof registerAgent> {
  const path = join(made.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8');
  if (!text.includes('\nlobby: ')) writeFileSync(path, `${text}lobby: ${lobbyDir(made.home)}\n`);
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
  return agent;
}

/** The state a live watch leaves: the target seat's pane, the watch record this process holds
 *  under the epoch its host captured, and the watchdog file `up` wrote. */
function watching(made: World, epoch: string): void {
  updateState(made.dir, (state) => {
    state.sessions[SESSION] = {
      seats: { lead: { stage: 'launched', pane: PANE, workspace: 'w1' } },
      worktrees: {},
      watch: { pid: process.pid, epoch, heartbeat: new Date().toISOString(), pane: 'w7:p7' },
      watchdog: { file: join(made.dir, 'team.yaml'), pane: 'w7:p7' },
    };
  });
}

/** The signed records staged for the seat: the direct wake stages one before it dials. */
function staged(made: World, seat = 'lead'): string[] {
  try {
    return readdirSync(dropDir(made.dir, seat)).filter((name) => MESSAGE_ID.test(name));
  } catch {
    return [];
  }
}

/** The real verifier packaged as the watch principal the internal seam takes, so even the seam
 *  scenes read their authority from the state, never from a permissive stand-in. */
function principalOf(made: World, epoch: string): WatchSendPrincipal {
  return {
    root: made.root,
    session: SESSION,
    recheck: () => {
      const verdict = verifyWatchAuthority({
        root: made.root,
        session: SESSION,
        epoch,
        purpose: WATCH_DIRECT_WORK,
      });
      return verdict.ok ? { ok: true } : { ok: false, why: verdict.why };
    },
  };
}

describe('the actual direct-work entry', () => {
  test('delivers over the socket as the watch, never as the owner or a seat', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    receives(made);
    registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    const pane = scripted(['idle'], null);
    const frames: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: epoch },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: BODY },
      host,
    );

    expect(result).toEqual({ ok: true, outcome: 'socket: delivered' });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain(BODY);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    // The durable copy the receiver keeps names its sender: the watch principal, no registry id
    // and never the owner label.
    const ids = staged(made);
    expect(ids).toHaveLength(1);
    const record = readFileSync(join(dropDir(made.dir, 'lead'), ids[0] as string), 'utf8');
    expect(record).toContain('"from": "watch"');
    expect(record).toContain('"from_id": null');
    expect(record).toContain("from the watch — admitted by: the watch's direct-work authority");
    expect(record).not.toContain('from the owner');
  });

  test('refuses a captured session that is not the team file\'s before anything is staged', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    registered(made);
    watching(made, mintWatchEpoch());
    const frames: string[] = [];
    const host = fake(made, {
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendWatchDirect(
      { root: made.root, session: 'other', capturedEpoch: mintWatchEpoch() },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: BODY },
      host,
    );

    expect(result).toEqual({ ok: false, refused: "the session is not this team file's" });
    expect(staged(made)).toEqual([]);
    expect(frames).toEqual([]);
  });

  test('refuses a captured root the run does not load, even when the verifier can read the file', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    // A folder inside the checkout: the verifier resolves the team file from it, and the run
    // loads the checkout root. The captured root is not that root.
    const below = join(made.root, 'below');
    mkdirSync(below);
    const frames: string[] = [];
    const host = fake(made, {
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendWatchDirect(
      { root: below, session: SESSION, capturedEpoch: epoch },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: BODY },
      host,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refused).toContain('the watch was verified for its captured root, and this run loaded another root');
    expect(result.refused).toContain('same session names do not make another root\'s team');
    expect(staged(made)).toEqual([]);
    expect(frames).toEqual([]);
  });
});

describe('the exact target evidence', () => {
  /** One refusal scene: seed the world, apply a change, and expect nothing staged or attempted. */
  async function refusal(change: (made: World, agent: ReturnType<typeof registerAgent>) => void): Promise<string> {
    const made = world(null);
    cleanup = made.cleanup;
    receives(made);
    const agent = registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    change(made, agent);
    const pane = scripted(['idle'], null);
    const frames: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });
    const result = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: epoch },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: BODY },
      host,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return '';
    expect(staged(made)).toEqual([]);
    expect(frames).toEqual([]);
    expect(pane.typed).toEqual([]);
    return result.refused;
  }

  test('refuses a stopped registry record before staging', async () => {
    const why = await refusal((made, agent) => {
      updateAgent(made.home, agent.id, { lifecycle: 'stopped' });
    });
    expect(why).toContain('is stopped, not running');
  });

  test('refuses when the registry holds no record for the seat in its session', async () => {
    const why = await refusal((made, agent) => {
      updateAgent(made.home, agent.id, { reach: { seat: 'helper' } });
    });
    expect(why).toContain('the registry holds no record for it in session acme');
  });

  test('refuses a registry pane that is not the pane the pass read', async () => {
    const why = await refusal((made, agent) => {
      updateAgent(made.home, agent.id, { reach: { pane: 'w2:p2' } });
    });
    expect(why).toContain('the registry records pane w2:p2 for seat lead, and the pass read pane w1:p1');
  });

  test('refuses a registry CLI that is not the CLI the pass read', async () => {
    const why = await refusal((made, agent) => {
      updateAgent(made.home, agent.id, { cli: 'codex' });
    });
    // The registry's own CLI for the seat is compared before the exact-target evidence: the
    // binding reads codex and refuses the pass's claude-code.
    expect(why).toContain('its CLI is codex, not the claude-code the pass saw');
  });

  test('refuses a state pane that disagrees with the pass', async () => {
    const why = await refusal((made) => {
      updateState(made.dir, (state) => {
        const seat = state.sessions[SESSION]?.seats.lead;
        if (seat !== undefined) seat.pane = 'w2:p2';
      });
    });
    expect(why).toContain('the state records pane w2:p2 for seat lead, and the pass read pane w1:p1');
  });
});

describe('the direct wake legs', () => {
  test('a socket that refuses the frame is followed by no resume and no other route once the epoch moved', async () => {
    const made = world(['socket', 'headless-resume']);
    cleanup = made.cleanup;
    receives(made);
    registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    const successor = mintWatchEpoch();
    const pane = scripted(['idle'], null);
    let dials = 0;
    const host = fake(made, {
      native: pane,
      deliver: async () => {
        dials++;
        // The socket could not take it; while the walk falls back, a successor replaces the
        // watch record this run was admitted under.
        updateState(made.dir, (state) => {
          const watch = state.sessions[SESSION]?.watch;
          if (watch !== undefined) {
            watch.epoch = successor;
            watch.heartbeat = new Date().toISOString();
          }
        });
        return { ok: false, reason: 'the receiver closed the socket' };
      },
    });

    // The walk logs its own refusal lines; the entry's io writes them to stderr. Capture them so
    // the scene can pin that the resume guard itself refused, not a missing runtime behind it.
    const say = process.stderr.write;
    let logged = '';
    process.stderr.write = ((chunk: unknown) => {
      logged += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result: Awaited<ReturnType<typeof sendWatchDirect>>;
    try {
      result = await sendWatchDirect(
        { root: made.root, session: SESSION, capturedEpoch: epoch },
        { seat: 'lead', pane: PANE, cli: 'claude-code', body: BODY },
        host,
      );
    } finally {
      process.stderr.write = say;
    }

    expect(dials).toBe(1);
    // The direct ending the caller reads names the last live route's transport failure; the
    // refused resume leg is the walk's own line, and it is a refusal, never the unavailable
    // runtime the build would have recorded had the guard passed.
    expect(result).toEqual({ ok: false, refused: 'socket: unreachable: the receiver closed the socket' });
    expect(logged).toContain("headless-resume: refused: the recorded watch is another watch's epoch");
    expect(logged).not.toContain('headless-resume: this build carries no headless resume runtime');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    // The prepared record was staged before the first attempt; the successor's record is left
    // exactly as the replacement wrote it.
    expect(staged(made)).toHaveLength(1);
    expect(readFileSync(join(made.dir, STATE_FILE), 'utf8')).toContain(successor);
  });

  test('walks only direct routes even when the team file declares a typed one', async () => {
    const made = world(['socket', 'typed']);
    cleanup = made.cleanup;
    registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    const pane = scripted(['idle'], null);
    const frames: string[] = [];
    const host = fake(made, {
      native: pane,
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendWatchDirect(
      { root: made.root, session: SESSION, capturedEpoch: epoch },
      { seat: 'lead', pane: PANE, cli: 'claude-code', body: BODY },
      host,
    );

    // The receiver declared no accept, so the socket is skipped; the typed leg the file names is
    // never walked by a watch, and the walk ends on its direct route.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refused).toStartWith('socket: unreachable');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(frames).toEqual([]);
    expect(staged(made)).toHaveLength(1);
  });
});

describe('the internal seam keeps its binding', () => {
  test('sendDirect without a guard still rechecks the principal before the socket dial', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    receives(made);
    registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    const successor = mintWatchEpoch();
    const frames: string[] = [];
    const host = fake(made, {
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
      // The first verification has already passed; the replacement lands while the record is
      // being prepared, before the socket is dialed.
      sendId: () => {
        updateState(made.dir, (state) => {
          const watch = state.sessions[SESSION]?.watch;
          if (watch !== undefined) {
            watch.epoch = successor;
            watch.heartbeat = new Date().toISOString();
          }
        });
        return '11111111-2222-4333-8444-555555555555';
      },
    });

    const run = await sendDirect(owner(made.root), host, {
      seat: 'lead',
      pane: PANE,
      cli: 'claude-code',
      body: BODY,
      watch: principalOf(made, epoch),
    });

    // The principal is the run's authority, not an optional guard: a caller that omits the hook
    // still cannot dial past a replaced epoch.
    expect(run.result).toEqual({
      outcome: 'refused',
      route: 'socket',
      id: expect.any(String),
      record: expect.any(String),
      reason: "the recorded watch is another watch's epoch",
    });
    expect(frames).toEqual([]);
  });

  test('runSend with a watch principal and no direct hook still requires the exact target', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    receives(made);
    const agent = registered(made);
    const epoch = mintWatchEpoch();
    watching(made, epoch);
    // The registry's own record has stopped: a direct-bound watch may not wake it.
    updateAgent(made.home, agent.id, { lifecycle: 'stopped' });
    const pane = scripted(['idle'], null);
    const host = fake(made, {
      native: pane,
      watch: principalOf(made, epoch),
    });
    const io = owner(made.root);

    const code = await runSend(['lead', BODY], io, host);

    // A watch run is direct-bound by its principal: the bypass that skipped the direct filter
    // and the exact target evidence is closed, so nothing is typed or staged.
    expect(code).toBe(1);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(staged(made)).toEqual([]);
  });
});
