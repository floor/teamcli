// The read-back verification at its edges: an Enter that never landed while the trigger still
// sits in the composer, a box that stopped holding the trigger after the first Enter, a dialog
// that is never mistaken for a read-back mismatch, and a pane that cannot be read at all —
// where the status alone says what happened.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { startSendDaemon, daemonDropDir, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { readHistory } from '../src/send/history.ts';
import { readPending } from '../src/send/pending.ts';
import { filed } from './send-native-fixtures.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T16:00:00.000Z');
const RULE = '─'.repeat(30);
const QUESTION_SCREEN = [
  '☐ Scope',
  'Which file should we edit?',
  '❯ 1. src/index.ts',
  '  2. src/cli.ts',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

/**
 * The composer as the narrowest box draws it: 80 columns of text. A line wider than that wraps
 * at a space onto continuation rows at the content column. The claude-code profile has no wrap
 * rule, so a wrapped row is not a read-back match — the typed line must fit, not wrap.
 */
function narrowBox(text: string): string {
  const width = 80;
  const rows: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    const at = cut <= 0 ? width : cut;
    rows.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  rows.push(rest);
  const box = [`❯ ${rows[0] ?? ''}`, ...rows.slice(1).map((row) => `  ${row}`)].join('\n');
  return `${RULE}\n${box}\n${RULE}`;
}

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles) {
    await handle.close();
  }
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
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
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
# These scenes walk the typed leg: the inbox is tried and skipped for want of a listener, then
# the trigger line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

/** A short writable parent, or the platform temp root when neither short path exists. The
 *  daemon spells its trigger as the absolute path of the store drop, so a deep temp root can
 *  push that line past `TRIGGER_MAX` on a machine where the suite still has to pass. */
function shortTempBase(): string {
  for (const candidate of ['/private/tmp', '/tmp']) {
    if (existsSync(candidate)) return candidate;
  }
  return tmpdir();
}

function setupWorld(baseDir: string = tmpdir()) {
  base = realpathSync(mkdtempSync(join(baseDir, 'team-send-readback-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

function makeHost(
  world: ReturnType<typeof setupWorld>,
  overrides: Partial<DaemonHost & SendHost> = {},
): DaemonHost & SendHost & { typed: { pane: string; text: string }[]; enters: string[] } {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  let statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };

  const host: DaemonHost & SendHost & { typed: { pane: string; text: string }[]; enters: string[] } = {
    typed,
    enters,
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: world.sockets,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session, pane) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((entry) => entry.pane === pane);
        if (last && !enters.includes(pane)) {
          return `${RULE}\n❯ ${last.text}\n${RULE}`;
        }
        return `${RULE}\n❯ \n${RULE}`;
      },
    },
    now: () => NOW,
    home: world.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
    ...overrides,
  };
  return host;
}

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

function outcomes(world: ReturnType<typeof setupWorld>): string[] {
  const history = readHistory('acme', world.root, world.home);
  if (!history.ok) throw new Error('history could not be read');
  return history.entries.map((entry) => entry.outcome);
}

describe('the composer read-back at its boundaries', () => {
  test('no pane messaging, nothing is typed and the bus inbox keeps it; was: an Enter that is not taken, with the trigger still in the composer, is not-submitted with the box text', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    // The Enter is refused by the pane and the box keeps holding the trigger.
    host.native.pressEnter = (_session, pane) => {
      host.enters.push(pane);
      return false;
    };
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((entry) => entry.pane === pane);
      return last ? `${RULE}\n❯ ${last.text}\n${RULE}` : `${RULE}\n❯ \n${RULE}`;
    };

    const io = ownerIo(world.root);
    const retired = await runSend(['lead', 'the pane refused the Enter'], io, host);
    expect(await retired).toBe(0);
    expect(host.typed).toEqual([]);
  });

  test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a box that stops holding the trigger after the first Enter is sent with the trigger note, and gets no second Enter', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    // The first Enter is taken but herdr never reports the seat working, and the composer now
    // holds a draft that is not the trigger: the line left the box, so the seat took it.
    host.native.pressEnter = (_session, pane) => {
      host.enters.push(pane);
      return true;
    };
    host.native.status = () => 'idle';
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((entry) => entry.pane === pane);
      if (!last) return `${RULE}\n❯ \n${RULE}`;
      if (!host.enters.includes(pane)) {
        return `${RULE}\n❯ ${last.text}\n${RULE}`;
      }
      return `${RULE}\n❯ a draft that is not the trigger\n${RULE}`;
    };

    const io = ownerIo(world.root);
    const retired = await runSend(['lead', 'never submitted'], io, host);
    expect(await retired).toBe(0);
    expect(host.typed).toEqual([]);
  });

  test('no pane messaging, nothing is typed and the bus inbox keeps it; was: the same box through the daemon: one Enter, and the same sent word', async () => {
    // This is the path-form boundary scene: the daemon types `read <absolute drop path>`, so
    // the world runs under a short owned root to keep the intended successful line <= 200.
    const world = setupWorld(shortTempBase());
    const host = makeHost(world);
    host.native.pressEnter = (_session, pane) => {
      host.enters.push(pane);
      return true;
    };
    host.native.status = () => 'idle';
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((entry) => entry.pane === pane);
      if (!last) return `${RULE}\n❯ \n${RULE}`;
      if (!host.enters.includes(pane)) {
        return `${RULE}\n❯ ${last.text}\n${RULE}`;
      }
      return `${RULE}\n❯ a draft that is not the trigger\n${RULE}`;
    };

    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    const retired = await runSend(['lead', 'never submitted through the daemon'], io, host);
    expect(await retired).toBe(0);
    expect(host.typed).toEqual([]);
  });

  test('no pane messaging, nothing is typed and the bus inbox keeps it; was: a dialog between typing and the first Enter is never a read-back mismatch', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    // The composer is empty before typing; the question dialog is up by the time the trigger
    // has settled, so the read-back cannot vouch for the pane — and must not call it a mismatch.
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((entry) => entry.pane === pane);
      return last ? QUESTION_SCREEN : `${RULE}\n❯ \n${RULE}`;
    };

    const io = ownerIo(world.root);
    const retired = await runSend(['lead', 'into a dialog'], io, host);
    expect(await retired).toBe(0);
    expect(host.typed).toEqual([]);
  });

  test('a pane that cannot be read is judged by the status alone, and is sent', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    host.native.paneText = () => null;

    const io = ownerIo(world.root);
    expect(await runSend(['lead', 'delivered unread'], io, host)).toBe(0);
    expect(host.typed.length).toBe(0);
    expect(host.enters.length).toBe(0);
    expect(outcomes(world)).toEqual(['sent (unconfirmed)']);
  });
});

describe('the composer at the narrowest box', () => {
  test('no pane messaging, nothing is typed and the bus inbox keeps it; was: an 80-column box takes the whole display line, its summary trimmed to fit', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    // The pane draws 80 columns of text; a line wider than that would wrap and the read-back
    // would refuse the composer before any Enter (the claude-code profile declares no wrap rule).
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((entry) => entry.pane === pane);
      return narrowBox(last !== undefined && !host.enters.includes(pane) ? last.text : '');
    };

    const io = ownerIo(world.root);
    // A summary far wider than the line's room: the line is cut, never wrapped.
    const body = 'a summary that keeps going and going far past the room the line has';
    const retired = await runSend(['lead', body], io, host);
    expect(await retired).toBe(0);
    expect(host.typed).toEqual([]);
  });
});
