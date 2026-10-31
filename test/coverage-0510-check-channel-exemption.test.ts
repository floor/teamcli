// A seat woken through the development channel keeps the push promise without a socket: `team
// check` must not name its skipped socket as a difference to fix. A plain seat with the same
// held frame is named, so the scene pins the exemption rather than a check that stays silent.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { deliverBriefs, testIo } from './helpers.ts';
import { NOW, world, type ExtraSeat, type World } from './send-native-fixtures.ts';

const SHELL_PID = 990120;
const SESSION_PID = 990121;
const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';
const paneOf = (name: string): string => `fixture-pane-${name}`;

let restored: Array<() => void> = [];
afterEach(() => {
  for (const undo of restored.reverse()) undo();
  restored = [];
});

function socketsDir(made: World): string {
  return join(dirname(made.root), 'cc-socks');
}

/** The generated settings this build's launcher writes: an accept declaration the launch attests,
 *  so the socket is eligible and the held frame is the only gate left. */
function generated(made: World, seat: string): void {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
}

function settle(made: World, names: readonly string[]): void {
  updateState(made.dir, (state) => {
    const one = (state.sessions.acme ??= emptySession());
    one.watch = { pid: 1, heartbeat: NOW.toISOString() };
    for (const name of names) one.seats[name] = { stage: 'ready', pane: paneOf(name), workspace: 'fixture-ws', watcher: 'hook' };
  });
  deliverBriefs({ dir: made.dir, root: made.root, session: 'acme', seats: names, home: made.home, at: NOW.toISOString() });
}

function agentsOf(names: readonly string[]): HerdrAgent[] {
  return names.map((name) => ({ name, agent: 'claude', pane: paneOf(name), workspace: 'fixture-ws', status: 'idle', cwd: null }));
}

function processesOf(names: readonly string[]): Record<string, PaneProcesses | null> {
  const out: Record<string, PaneProcesses | null> = {};
  for (const name of names) out[paneOf(name)] = { shell: SHELL_PID, foreground: [SESSION_PID] };
  return out;
}

/** The two extra seats: one woken through the development channel, one plain, each with a live
 *  socket and a held frame standing under its current declaration. */
function fixture(): { made: World; names: string[] } {
  const extras: ExtraSeat[] = [
    { name: 'chan', role: 'implementer', launch: CHANNEL_LAUNCH },
    { name: 'plain', role: 'implementer' },
  ];
  const made = world(null, extras);
  restored.push(made.cleanup);
  const names = ['lead', 'helper', 'native', 'chan', 'plain'];
  const sockets = socketsDir(made);
  mkdirSync(sockets, { recursive: true });
  writeFileSync(join(sockets, `${String(SESSION_PID)}.sock`), '');
  for (const seat of ['chan', 'plain']) {
    generated(made, seat);
    const declaration = declaredInboundOf({
      dir: made.dir,
      root: made.root,
      session: 'acme',
      seat,
      launch: seat === 'chan' ? CHANNEL_LAUNCH : 'claude',
    });
    recordHeldSocket(heldSocketPath(made.dir, 'acme', seat), declaration, NOW);
  }
  settle(made, names);
  return { made, names };
}

test('a development-channel seat’s held socket is no finding; a plain seat’s is', () => {
  const { made, names } = fixture();
  // The premise the exemption reads: the channel launch is what makes this seat push.
  const chan = seatDeliveryClass({
    dir: made.dir,
    root: made.root,
    session: 'acme',
    seat: 'chan',
    declared: { cli: 'claude-code', launch: CHANNEL_LAUNCH },
    state: { cli: 'claude-code', watcher: 'hook' },
    home: made.home,
  });
  expect(`${chan.class} ${String(chan.evidence.channel)}`).toBe('push true');
  const io = testIo(made.root, { kind: 'owner' });
  const code = runTeamCheck({ file: join(made.dir, 'team.yaml') }, io, {
    live: () => ({ running: true, agents: agentsOf(names), workspaces: [], screens: {}, processes: processesOf(names) }),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, made.home),
    now: () => NOW,
    home: made.home,
    sockets: socketsDir(made),
  });
  const out = `${io.out}${io.err}`;
  expect(out).toContain('plain: sends go to its drop folder, not its socket');
  expect(out).not.toContain('chan: sends go to its drop folder, not its socket');
  expect(code).not.toBe(0);
});
