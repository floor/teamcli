// The read-back verification at its edges: an Enter that never landed while the trigger still
// sits in the composer, a box that stopped holding the trigger after the first Enter, a dialog
// that is never mistaken for a read-back mismatch, and a pane that cannot be read at all —
// where the status alone says what happened.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { readHistory } from '../src/send/history.ts';
import { filed } from './send-native-fixtures.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T16:00:00.000Z');
const RULE = '─'.repeat(30);
const QUESTION_SCREEN = [
  '☐ Scope',
  'Which file should we edit?',
  '❯ 1. src/index.ts',
  '  2. src/cli.ts',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

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
`;
}

function setupWorld() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-readback-')));
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
  test('an Enter that is not taken, with the trigger still in the composer, is not-submitted with the box text', async () => {
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
    expect(await runSend(['lead', 'the pane refused the Enter'], io, host)).toBe(1);
    expect(io.err).toContain('not-submitted: the seat did not take the trigger after 0 Enters; the box holds');
    expect(io.err).toContain('Read ');
    expect(host.enters.length).toBe(1);
    expect(outcomes(world)).toEqual(['not-submitted']);

    // The body waits in the drop file, whole, for the seat to pick up, with the retry record
    // the watch reads beside it.
    const drops = join(world.dir, 'send-drops', 'acme', 'lead');
    const files = readdirSync(drops).filter((name) => !name.endsWith('.pending'));
    expect(files.length).toBe(1);
    expect(readFileSync(join(drops, files[0]!), 'utf8')).toBe(filed('the pane refused the Enter'));
    expect(readdirSync(drops).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
  });

  test('a box that stops holding the trigger after the first Enter gets no second Enter', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    // The first Enter is taken but herdr never reports the seat working, and the composer now
    // holds a draft that is not the trigger.
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
    expect(await runSend(['lead', 'never submitted'], io, host)).toBe(1);
    expect(io.err).toContain('not-submitted: the seat did not take the trigger after 1 Enter; the box holds "a draft that is not the trigger"');
    expect(host.enters.length).toBe(1);
    expect(outcomes(world)).toEqual(['not-submitted']);
  });

  test('the same box through the daemon: one Enter, and the same not-submitted word', async () => {
    const world = setupWorld();
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
    expect(await runSend(['lead', 'never submitted through the daemon'], io, host)).toBe(1);
    expect(io.err).toContain('not-submitted: the seat did not take the trigger after 1 Enter; the box holds "a draft that is not the trigger"');
    expect(host.enters.length).toBe(1);
    expect(outcomes(world)).toEqual(['not-submitted']);
  });

  test('a dialog between typing and the first Enter is never a read-back mismatch', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    // The composer is empty before typing; the question dialog is up by the time the trigger
    // has settled, so the read-back cannot vouch for the pane — and must not call it a mismatch.
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((entry) => entry.pane === pane);
      return last ? QUESTION_SCREEN : `${RULE}\n❯ \n${RULE}`;
    };

    const io = ownerIo(world.root);
    expect(await runSend(['lead', 'into a dialog'], io, host)).toBe(1);
    expect(io.err).toContain('unreachable: not reached; the screen reads question');
    // The pane is a dialog by the time the line has settled: no Enter goes to it.
    expect(host.enters.length).toBe(0);
    expect(outcomes(world)).toEqual(['unreachable']);
  });

  test('a pane that cannot be read is judged by the status alone, and delivers', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    host.native.paneText = () => null;

    const io = ownerIo(world.root);
    expect(await runSend(['lead', 'delivered unread'], io, host)).toBe(0);
    expect(host.typed.length).toBe(1);
    expect(host.enters.length).toBe(1);
    expect(outcomes(world)).toEqual(['delivered']);
  });
});
