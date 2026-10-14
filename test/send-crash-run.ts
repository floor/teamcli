// A daemon that dies mid-delivery dies for real: a native call that throws rejects the queue
// worker's promise, and under `bun test` that rejection fails the test run, not the daemon. So
// this scene runs as its own process: the daemon serves, the Enter throws, the process observes
// its own rejection, and reports what the pane, the drop file, the history and the log hold
// afterwards. The pane must hold only the trigger line, never the body.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { daemonDropDir, requestDaemon, startSendDaemon, type DaemonHost } from '../src/send/daemon.ts';
import { readHistory } from '../src/send/history.ts';
import { triggerLine } from '../src/send/native.ts';
import { LOG_FILE } from '../src/state.ts';

const NOW = new Date('2026-10-14T17:00:00.000Z');
const RULE = '─'.repeat(30);
const BODY = 'the body that must never reach the composer';
const ID = '11111111-1114-4111-8111-111111111111';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-crash-')));
const root = join(base, 'acme');
const dir = join(root, '.agents');
const sockets = join(base, 'sockets');
const home = join(base, 'home');
mkdirSync(dir, { recursive: true });
mkdirSync(sockets, { recursive: true });
mkdirSync(lobbyDir(home), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
writeFileSync(join(dir, 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
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
`);
const loaded = loadTeamFile(root, { home });
if (!loaded.ok) throw new Error('fixture team.yaml failed to load');

const typed: { pane: string; text: string }[] = [];
const host: DaemonHost = {
  agents: () => [{ name: 'lead', pane: 'pane-lead' }],
  processInfo: () => ({ shell: 111, foreground: [222] }),
  socketsDir: sockets,
  deliver: async () => ({ ok: true }),
  native: {
    typeText: (_session, pane, text) => {
      typed.push({ pane, text });
      return true;
    },
    pressEnter: () => {
      throw new Error('the daemon died between the trigger and the Enter');
    },
    status: () => 'idle',
    wait: async () => {},
    paneText: (_session, pane) => {
      const last = [...typed].reverse().find((item) => item.pane === pane);
      return last ? `${RULE}\n❯ ${last.text}\n${RULE}` : `${RULE}\n❯ \n${RULE}`;
    },
  },
  now: () => NOW,
  home,
  deliverWaitMs: 50,
  pollReadyMs: 5,
};

// The listener goes in before the request: the crash's rejection is the observed event, and
// without a listener the process would die without reporting anything.
const rejections: string[] = [];
process.on('unhandledRejection', (reason) => { rejections.push(String(reason)); });

const started = await startSendDaemon({ root, dir, team: loaded.team, host });
if (started.kind !== 'serving') throw new Error(started.kind);
const response = await requestDaemon(
  started.handle.socketPath,
  { v: 1, op: 'send', id: ID, from: 'owner', to: 'lead', body: BODY },
  400,
);
await started.handle.close();
await new Promise((resolve) => setTimeout(resolve, 50));

const dropPath = join(daemonDropDir(loaded.team.project, root, home, loaded.team.session, 'lead'), ID);
const line = triggerLine(dropPath);
const history = readHistory(loaded.team.session, root, home);
const log = existsSync(join(dir, LOG_FILE)) ? readFileSync(join(dir, LOG_FILE), 'utf8') : '';
console.log(JSON.stringify({
  response,
  rejections,
  typed,
  triggerFits: line !== null,
  triggerHeld: line !== null && typed[0]?.text === line,
  bodyNeverTyped: typed.every((item) => !item.text.includes(BODY)),
  dropContent: readFileSync(dropPath, 'utf8'),
  dropMode: lstatSync(dropPath).mode & 0o777,
  historyIds: history.ok ? history.entries.map((entry) => entry.id) : null,
  logHasDelivered: log.includes('delivered'),
}));
rmSync(base, { recursive: true, force: true });
