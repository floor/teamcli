// The send daemon's boundaries: it serves only its own team's session and never reads another
// one; a delivery that ends held — a dialog after the trigger, a composer read-back that does
// not hold the trigger — is never reported delivered; the message history and drop files stay
// 0600 under the project's state folder, never in a lobby and never in the repository; and a
// daemon that dies between the trigger and the Enter leaves the pane holding no body text.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import {
  daemonDropDir,
  startSendDaemon,
  type DaemonHost,
  type SendDaemonHandle,
} from '../src/send/daemon.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { triggerLine } from '../src/send/native.ts';
import { readPending } from '../src/send/pending.ts';
import { LOG_FILE } from '../src/state.ts';
import { filed } from './send-native-fixtures.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T17:00:00.000Z');
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
  for (const handle of handles) await handle.close();
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string, session = 'acme'): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: ${session}
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
# These scenes are the daemon's typed boundaries: the inbox is tried and skipped for want of a
# listener, then the trigger line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function setupWorld(session = 'acme') {
  // `/tmp` rather than the platform temp folder: the fixture's paths sit inside the wake line,
  // and the measured 200-character ceiling has room for the sender only on the short base.
  base = realpathSync(mkdtempSync(join('/tmp', 'team-send-boundaries-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home), session));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

type Host = DaemonHost & SendHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
};

function makeHost(world: ReturnType<typeof setupWorld>, overrides: Partial<DaemonHost & SendHost> = {}): Host {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };
  const host: Host = {
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
        const last = [...typed].reverse().find((item) => item.pane === pane);
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

describe('the send daemon\'s boundaries', () => {
});
