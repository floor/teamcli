// The delivery class a dispatch and `up` read: an accepted cross-session socket counts only
// while the running session is younger than the settings file that declares accept. A seat whose
// socket predates its declaration was started without the setting, so the socket is no evidence
// and the seat is not wakeable — the same age gate the send walk applies before it dials.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seatDeliveryClass, wakeableWhileIdle } from '../src/launch/delivery-class.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';

let dir: string;
let home: string;
let socket: string;
let settings: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delivery-socket-age-'));
  home = join(dir, 'home');
  const path = cliHookSettingsPath(dir, 'acme', 'helper');
  if (path === null) throw new Error('the fixture cannot name the seat settings path');
  settings = path;
  socket = join(dir, 'helper.sock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The launch a socket seat leaves behind: generated settings declaring accept, and a registry
 *  record naming the socket. `bootedAt` dates the settings file against the socket. */
function socketSeat(bootedAt: 'after-socket' | 'before-socket'): void {
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(socket, '');
  const at = bootedAt === 'after-socket' ? Date.now() + 60_000 : Date.now() - 60_000;
  utimesSync(settings, new Date(at), new Date(at));
  registerAgent(home, {
    name: 'helper',
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(dir), seat: 'helper', session: 'acme', pane: 'fixture-pane-9', address: socket },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function read() {
  return seatDeliveryClass({
    dir,
    root: dir,
    session: 'acme',
    seat: 'helper',
    declared: { cli: 'claude-code', launch: 'claude' },
    state: { cli: 'claude-code', watcher: 'hook' },
    home,
  });
}

describe('the socket evidence a delivery class reads', () => {
  test('a socket younger than its accept declaration is a live route, and the seat is wakeable', () => {
    socketSeat('before-socket');
    const seat = read();
    expect(seat.evidence.socket).toBe(true);
    expect(seat.class).toBe('push');
    expect(wakeableWhileIdle(seat.class)).toBe(true);
  });

  test('a socket older than its accept declaration is no evidence, and the seat is not wakeable', () => {
    socketSeat('after-socket');
    const seat = read();
    expect(seat.evidence.socket).toBe(false);
    expect(seat.class).toBe('pull-on-turn');
    expect(wakeableWhileIdle(seat.class)).toBe(false);
  });
});
