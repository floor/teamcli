// The read-back verification at its edges: an Enter that never landed while the trigger still
// sits in the composer, a box that stopped holding the trigger after the first Enter, a dialog
// that is never mistaken for a read-back mismatch, and a pane that cannot be read at all —
// where the status alone says what happened.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** The runtime temp folder itself, with no deeper folder of our own: the daemon spells its
 *  trigger as the absolute path of the store drop, so this scene keeps the world as shallow as
 *  the platform allows instead of assuming one fixed folder is short enough. */
function shortTempBase(): string {
  return realpathSync(tmpdir());
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

/** The bus record a retired read-back edge leaves: one signed drop for `body` at mode 0600 in
 *  the seat's 0700 folder, the drop-leg marker, and the history line the sender was told about.
 *  These scenes' subjects were the typed leg's edges; the record is what the send keeps now. */
function expectKeptInBus(world: ReturnType<typeof setupWorld>, seat: string, body: string): string {
  const drops = join(world.dir, 'send-drops', 'acme', seat);
  expect(lstatSync(drops).mode & 0o777).toBe(0o700);
  const files = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(files).toHaveLength(1);
  const id = files[0] as string;
  expect(lstatSync(join(drops, id)).mode & 0o777).toBe(0o600);
  expect(recordBody(join(drops, id))).toBe(filed(body));
  expect(JSON.parse(readFileSync(join(drops, `${id}.pending`), 'utf8'))).toMatchObject({
    id,
    from: 'owner',
    to: seat,
    body: filed(body),
    leg: 'drop',
  });
  const history = readHistory('acme', world.root, world.home);
  expect(history.ok).toBe(true);
  if (history.ok) {
    expect(history.entries).toContainEqual(expect.objectContaining({
      id,
      to: seat,
      body: filed(body),
      outcome: 'queued, not woken',
      via: 'drop',
    }));
  }
  return id;
}

describe('the composer read-back at its boundaries', () => {
});

describe('the composer at the narrowest box', () => {
});
