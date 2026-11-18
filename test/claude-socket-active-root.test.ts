// The Claude adapter §1 (F11, F12): socket suppression on E7b-active roots.
//
// On an active root no new delivery dials a cross-session socket: not the send's default, not a
// seat's `inbound: accept`, not the watch's redelivery. The decision is read at each delivery from
// the receiving root's floor state. A dark root keeps its socket leg and its eligibility exactly as
// today, so a deactivation gives the socket back with no config change, and stamped mail still
// pending stays readable by the level-3 readers. Fixtures only: synthetic roots, a fake socket.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redeliverChannelOnSocket, runSend } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { listUnread, readMessage } from '../src/mcp/inbox.ts';
import { channelLaunchFallback } from '../src/mcp/launch-config.ts';
import { activate, deactivate, floorState, SOCKET_OFF_ON_ACTIVE, socketSuppressed, type FloorActor } from '../src/queue/floor.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const ID = '7c2d3e4f-0000-4000-8000-0000000f1101';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

/** A team whose lead accepts cross-session frames (team word and launch word), with a socket. */
function socketWorld(): World {
  const made = world(null);
  cleanups.push(made.cleanup);
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity: 'acme-entity' });
  mkdirSync(lobby, { recursive: true });
  writeFileSync(path, `${readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby)}entity: acme-entity\n`);
  const settings = cliHookSettingsPath(made.dir, SESSION, 'lead');
  if (settings === null) throw new Error('no settings path');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = new Date(Date.now() - 60_000);
  utimesSync(settings, at, at);
  return made;
}

function activateRoot(made: World): void {
  expect(activate(made.root, { home: made.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
}

describe('F11: an active root beside a dark root', () => {
  test('the dark root keeps its permitted socket; the active root is never dialed', async () => {
    const dark = socketWorld();
    const active = socketWorld();
    activateRoot(active);
    expect(socketSuppressed(dark.root, dark.home)).toBe(false);
    expect(socketSuppressed(active.root, active.home)).toBe(true);

    const darkHost = fake(dark);
    expect(await runSend(['lead', 'to the dark root'], owner(dark.root), darkHost)).toBe(0);
    expect(darkHost.frames).toHaveLength(1);

    const activeHost = fake(active);
    await runSend(['lead', 'to the active root'], owner(active.root), activeHost);
    expect(activeHost.frames).toEqual([]);
  });

  test('the watch\'s socket redelivery refuses an active root before any dial', async () => {
    const active = socketWorld();
    activateRoot(active);
    const root = realpathSync(active.root);
    const dropDir = seatMailDirs(root, SESSION, 'lead').legacy;
    mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    const payload: RecordPayload = { kind: 'message', id: ID, to: 'lead', to_id: null, root, session: SESSION, at: new Date().toISOString(), body: 'hi', from: 'owner', from_id: null, rule: 'the owner', thread: ID };
    expect(writeRecord(dropDir, signRecord(payload, active.home)).ok).toBe(true);
    const loaded = loadTeamFile(active.root, { home: active.home });
    if (!loaded.ok) throw new Error('fixture team failed to load');
    const host = fake(active);
    const result = await redeliverChannelOnSocket({ host, dir: active.dir, root, project: 'acme', session: SESSION, seat: 'lead', cli: 'claude-code', dropDir, drop: { id: ID, from: 'owner' }, team: loaded.team });
    expect(result).toEqual({ ok: false, reason: SOCKET_OFF_ON_ACTIVE });
    expect(host.frames).toEqual([]);
  });

  test('the launch warning names the pointer on an active root and the socket on a dark one', () => {
    const active = socketWorld();
    activateRoot(active);
    const dark = socketWorld();
    const team = { trust: ['legacy/relative'], orchestrator: 'lead', operator: 'lead' } as Parameters<typeof channelLaunchFallback>[0];
    const seat = { name: 'lead', cli: 'claude-code', launch: 'claude', cwd: '.' } as Parameters<typeof channelLaunchFallback>[1];
    const onActive = channelLaunchFallback(team, seat, active.root, active.home);
    const onDark = channelLaunchFallback(team, seat, dark.root, dark.home);
    expect(onActive).toContain('no proven channel: pointer wakes until the next `team restart`');
    expect(onActive).not.toContain('socket');
    expect(onDark).toContain('socket delivery remains available');
  });
});

describe('round 1: an activation that lands during the send stops the dial', () => {
  test('dark when the walk starts, active before the frame: no frame is written', async () => {
    // A dark send's reads of the pane, counted: the last one is the placement proof read just
    // before the dial, after the leg and the frame were admitted.
    const counting = socketWorld();
    let reads = 0;
    const counted = fake(counting);
    const probe = fake(counting, { processInfo: (session: string, pane: string) => { reads += 1; return counted.processInfo(session, pane); } });
    expect(await runSend(['lead', 'counted'], owner(counting.root), probe)).toBe(0);
    expect(probe.frames).toHaveLength(1);
    const made = socketWorld();
    let seen = 0;
    let activated = false;
    const base = fake(made);
    const host = fake(made, {
      processInfo: (session: string, pane: string) => {
        seen += 1;
        if (seen === reads && !activated) {
          activated = true;
          activateRoot(made);
        }
        return base.processInfo(session, pane);
      },
    });
    await runSend(['lead', 'raced'], owner(made.root), host);
    expect(activated).toBe(true);
    expect(socketSuppressed(made.root, made.home)).toBe(true);
    expect(host.frames).toEqual([]);
  });
});

describe('F12: deactivation with pending stamped mail', () => {
  test('the dark root gets its socket eligibility back unchanged; the stamped mail stays readable by level-3 readers', async () => {
    const made = socketWorld();
    activateRoot(made);
    const host = fake(made, { sendId: () => ID });
    await runSend(['lead', 'stamped while active'], owner(made.root), host);
    expect(host.frames).toEqual([]);
    const root = realpathSync(made.root);
    const dirs = seatMailDirs(root, SESSION, 'lead');
    expect(listUnread(dirs.legacy, { to: 'lead', root, session: SESSION }, made.home).map((one) => one.id)).toContain(ID);

    expect(deactivate(made.root, made.home).kind).toBe('dark');
    expect(floorState(made.root, made.home).kind).toBe('dark');
    expect(socketSuppressed(made.root, made.home)).toBe(false);
    // The socket is back, with no config change.
    const after = fake(made);
    expect(await runSend(['lead', 'after the rollback'], owner(made.root), after)).toBe(0);
    expect(after.frames).toHaveLength(1);
    // The stamped message stays listed and readable by this (level-3) build.
    expect(listUnread(dirs.legacy, { to: 'lead', root, session: SESSION }, made.home).map((one) => one.id)).toContain(ID);
    const read = readMessage({ dropDir: dirs.legacy, root, session: SESSION, seat: 'lead' }, ID, made.home);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.body).toContain('stamped while active');
  });
});
