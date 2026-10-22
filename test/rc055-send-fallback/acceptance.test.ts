// Independent coverage for two seams the orchestrator named on 2026-10-22T12Z, authored by
// tester-2 against builder-4's quota branch head a37ae86f8462ceedbc06f5d977066a777ec2f7d1:
//
//   1. the quota-out reader state: `quotaOutOf` reads the RECEIVING seat's own pane during the
//      send preflight, and a positively read wall refuses the send before any leg exists — the
//      socket frame included. A pane the host cannot read is no wall (the named gap), and a
//      wall on the caller's own pane is never read: the receiving seat's screen decides.
//   2. the socket-refused typed fallback: a socket leg the walk does not take falls through to
//      the typed trigger, the outcome and history carry `typed, socket <reason>`, the team log
//      names the fallback, and the typed leg delivers with `channel: typed`. A frame past the
//      measured limit and a session started before its declaration are refused before any
//      dial; an accepted frame still types nothing (`channel: socket`).
//
// Fixtures: the wall frame is the repository's retained Claude Code capture
// `test/fixtures/claude-code/rate-limit.txt`, read in place and never copied. The healthy
// composer and the sockets are synthetic scene state this file writes; no native trace is
// claimed and no live session, CLI home or pane is touched.
//
// Base: builder-4's pushed head a37ae86f8 (PR #650 lineage); these rows exercise behavior
// already on that head, so this is coverage-only, not red-first evidence for a new fix.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SendOutcome } from '../../src/send/uds.ts';
import { runSend } from '../../src/commands/send.ts';
import { cliHookSettingsPath } from '../../src/launch/cli-hook.ts';
import { readTriggerLine } from '../../src/send/native.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { dropDir, fake, scripted, world, type Scripted, type World } from '../send-native-fixtures.ts';
import { testIo } from '../helpers.ts';

const RULE = '─'.repeat(30);
const HEALTHY = `${RULE}\n❯ \n${RULE}`;
const WALL = readFileSync(new URL('../fixtures/claude-code/rate-limit.txt', import.meta.url), 'utf8');
const LIMIT = 1_048_576;

let made: World;

beforeEach(() => {
  made = world(['socket', 'typed'], [], { lead: 'claude' });
  // The caller is a placed seat: a seat-origin frame needs no owner-reply target, so the
  // socket leg can be walked in a world that names no entity.
  updateState(made.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.helper = { stage: 'launched', pane: 'w2:p1' };
  });
  mkdirSync(made.sockets, { recursive: true });
});

afterEach(() => made.cleanup());

/** The receiving seat's own generated declaration (this build's launcher appends it), and the
 *  socket its pane exposes. `skewMs` moves the socket's mtime, so a negative value is a
 *  session started before the declaration took effect. */
function accepting(skewMs = 0): void {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  if (skewMs !== 0) {
    const at = Date.now() + skewMs;
    utimesSync(socket, new Date(at), new Date(at));
  }
}

type Scene = {
  code: number;
  out: string;
  err: string;
  doc: any;
  typed: string[];
  enters: number;
  dials: string[];
  reads: string[];
  records: string[];
  log: string;
};

/** One send to `lead` from the placed seat `helper`, with the socket leg walked first. */
async function send(
  pane: Scripted,
  deliver: (socketPath: string, frame: string) => Promise<SendOutcome>,
  args: string[] = [],
): Promise<Scene> {
  const dials: string[] = [];
  const reads: string[] = [];
  const recorded = { ...pane, paneText: (session: string, at: string) => (reads.push(at), pane.paneText?.(session, at) ?? null) };
  const host = fake(made, {
    native: recorded,
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
    deliver: (socketPath, frame) => (dials.push(socketPath), deliver(socketPath, frame)),
  });
  const io = testIo(made.root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
  const code = await runSend(['lead', 'hello', 'world', ...args], io, host);
  let doc: any = null;
  try {
    doc = JSON.parse(io.out);
  } catch {
    doc = null;
  }
  const records = ((): string[] => {
    try {
      return readdirSync(dropDir(made.dir, 'lead')).filter((name) => !name.includes('.'));
    } catch {
      return [];
    }
  })();
  let log = '';
  try {
    log = readFileSync(join(made.dir, 'team.log'), 'utf8');
  } catch {
    log = '';
  }
  return { code, out: io.out, err: io.err, doc, typed: pane.typed, enters: pane.enters, dials, reads, records, log };
}

const accepted = async (): Promise<SendOutcome> => ({ ok: true });

describe('the quota-out reader state, before the send walk', () => {
  test('a walled receiver refuses before the socket leg is dialed', async () => {
    accepting();
    const scene = await send(scripted(['idle'], WALL), accepted);
    expect(scene.code).toBe(1);
    expect(scene.err).toContain('quota out on test');
    expect(scene.err).toContain('resets at 11:00');
    expect(scene.err).toContain('nothing was sent');
    // The wall is read before any leg exists: no frame, no key, no record, no log line
    // claiming a delivery.
    expect(scene.dials).toEqual([]);
    expect(scene.typed).toEqual([]);
    expect(scene.enters).toBe(0);
    expect(scene.records).toEqual([]);
    expect(scene.log).not.toContain('sent on the socket');
    expect(scene.log).not.toContain('sent (unconfirmed)');
  });

  test('a receiver pane the host cannot read is no wall: the socket takes the send', async () => {
    accepting();
    const scene = await send(scripted(['idle'], null), accepted);
    expect(scene.code).toBe(0);
    expect(scene.out).toBe('team acme, session "acme"\nlead: delivered (socket)\n');
    expect(scene.dials).toHaveLength(1);
    expect(scene.typed).toEqual([]);
    expect(scene.records).toHaveLength(1);
  });

  test("only the receiver's pane is read: a wall on the caller's own pane does not hold", async () => {
    accepting();
    const pane = scripted(['idle'], null);
    pane.paneText = (_session: string, at: string) => (at === 'w2:p1' ? WALL : HEALTHY);
    const scene = await send(pane, accepted);
    expect(scene.code).toBe(0);
    expect(scene.dials).toHaveLength(1);
    expect(scene.reads).not.toContain('w2:p1');
    expect(scene.reads).toContain('w1:p1');
  });
});

describe('a socket frame the walk does not take falls back to the typed trigger', () => {
  const REFUSED = 'the session closed the connection before it took the frame';

  test('the transport refusal is recorded, and the typed leg carries the send', async () => {
    accepting();
    const reason = REFUSED;
    const scene = await send(scripted(['idle', 'working'], HEALTHY), async () => ({ ok: false, reason }), ['--json']);
    expect(scene.code).toBe(0);
    expect(scene.dials).toHaveLength(1);
    expect(scene.doc?.channel).toBe('typed');
    expect(scene.doc?.status).toBe('sent (unconfirmed)');
    expect(scene.doc?.action_summary).toContain(`typed, socket ${reason}`);
    expect(scene.doc?.action_summary).toContain('trigger taken, no read receipt yet');
    // The walk's own record of the two attempts: the socket's refusal, then the typed leg.
    expect(scene.doc?.delivery).toEqual([
      { leg: 'socket', state: 'attempted', reason },
      { leg: 'typed', state: 'attempted' },
    ]);
    // The trigger left the composer; the body is the drop file only.
    const trigger = readTriggerLine('lead', 'acme', { seat: 'helper', team: 'acme' }) as string;
    expect(scene.typed).toEqual([trigger]);
    expect(scene.enters).toBe(1);
    expect(scene.records).toHaveLength(1);
    // The team log names the refusal and the leg it fell back to.
    expect(scene.log).toContain(`lead: the socket was not taken (${reason}); falling back to the typed trigger`);
  });

  test('a frame past the measured limit is refused before any dial', async () => {
    accepting();
    const body = 'x'.repeat(LIMIT + 24);
    const scene = await send(scripted(['idle', 'working'], HEALTHY), accepted, [body]);
    expect(scene.code).toBe(0);
    expect(scene.dials).toEqual([]);
    expect(scene.doc).toBeNull();
    expect(scene.out).toContain(`past the socket's measured limit of ${String(LIMIT)}`);
    expect(scene.typed).toHaveLength(1);
    expect(scene.records).toHaveLength(1);
  });

  test('a session started before its declaration is skipped, and the typed leg takes the send', async () => {
    accepting(-60_000);
    const scene = await send(scripted(['idle', 'working'], HEALTHY), accepted);
    expect(scene.code).toBe(0);
    expect(scene.dials).toEqual([]);
    expect(scene.out).toContain('the receiving session was started before its crossSessionInbound declaration; restart its CLI host so it accepts');
    expect(scene.typed).toHaveLength(1);
    expect(scene.records).toHaveLength(1);
  });

  test('control: an accepted frame delivers on the socket and types nothing', async () => {
    accepting();
    const scene = await send(scripted(['idle', 'working'], HEALTHY), accepted, ['--json']);
    expect(scene.code).toBe(0);
    expect(scene.dials).toHaveLength(1);
    expect(scene.doc?.channel).toBe('socket');
    expect(scene.typed).toEqual([]);
    expect(scene.enters).toBe(0);
    expect(scene.records).toHaveLength(1);
  });
});
