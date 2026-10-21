// Evidence for the mailbox channel. The harness writes the record. `team messages` runs in a pane
// of a scratch herdr session this process creates, stops and deletes. The watch pass types through
// the real pane and decides from a fixture screen, so a shell pane is not claimed to be a composer.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { plantMessage, receiptFile, type MessagePayload } from '../src/commands/messages.ts';
import { findRoot } from '../src/file/load.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { ringText } from '../src/watch/pass.ts';
import { testIo } from './helpers.ts';

const SESSION = 'mailbox-evidence';
const BODY = 'mailbox evidence body';
const OTHER = 'other text left in the box';

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const CURSOR_UNSENT = readFileSync(new URL('./fixtures/cursor/2026.10.01/unsent.txt', import.meta.url), 'utf8');

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent
`;

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

function herdr(...args: string[]): string {
  return execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' }).trim();
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitReady(): void {
  const start = Date.now();
  for (;;) {
    try {
      execFileSync('herdr', ['--session', SESSION, 'workspace', 'list'], { stdio: 'ignore' });
      return;
    } catch {
      if (Date.now() - start > 20_000) throw new Error('the scratch server did not answer');
      pause(200);
    }
  }
}

function paneId(created: string): string {
  const match = created.match(/(?:pane\s+)?(%\d+|\w+:p\d+)/);
  if (match?.[1]) return match[1];
  const listed = herdr('pane', 'list');
  const ids = [...listed.matchAll(/(?:^|\s)(%\d+|[A-Za-z0-9_-]+:p\d+)\b/g)].map((item) => item[1] as string);
  const id = ids.at(-1);
  if (!id) throw new Error(`no pane id in:\n${created}\n${listed}`);
  return id;
}

const base = mkdtempSync(join(tmpdir(), 'team-messages-run-'));
const root = join(base, 'acme');
const home = join(base, 'home');
mkdirSync(join(root, '.agents'), { recursive: true });
mkdirSync(home);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
const checkout = findRoot(root);
if (!checkout) throw new Error('the evidence checkout has no root');

let server: ChildProcess | undefined;
const typed: string[] = [];

function record(id: string, seat: string, body: string): MessagePayload {
  const payload: MessagePayload = {
    kind: 'message', id, to: seat, root: checkout as string, session: 'acme',
    at: '2026-10-08T08:00:00.000Z', body, from: 'harness',
  };
  plantMessage(home, checkout as string, seat, id, payload);
  return payload;
}

try {
  server = spawn('herdr', ['--session', SESSION, 'server'], { stdio: 'ignore' });
  waitReady();
  const leadCreated = herdr('workspace', 'create', '--cwd', root, '--label', 'lead', '--no-focus');
  const workerCreated = herdr('workspace', 'create', '--cwd', root, '--label', 'worker', '--no-focus');
  const leadPane = paneId(leadCreated);
  const workerPane = paneId(workerCreated);
  herdr('pane', 'send-text', workerPane, OTHER);
  pause(500);

  record('m1', 'lead', BODY);
  const command = `cd ${JSON.stringify(root)} && HOME=${JSON.stringify(home)} bun ${JSON.stringify(join(import.meta.dir, '..', 'src', 'cli.ts'))} messages; echo "exit:$?"`;
  herdr('pane', 'run', leadPane, command);
  let pane = '';
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    pane = herdr('pane', 'read', leadPane, '--source', 'recent', '--lines', '40');
    if (pane.includes(BODY) && pane.includes('exit')) break;
    pause(300);
  }
  const receipt = readFileSync(receiptFile(checkout, 'lead', 'm1'), 'utf8');

  record('m2', 'lead', 'second body stays put');
  record('m3', 'worker', 'third body stays put');
  const screens: Record<string, string> = { [leadPane]: IDLE, [workerPane]: CURSOR_UNSENT };
  const live: Live = {
    running: true,
    agents: [
      { name: 'lead', agent: 'claude', pane: leadPane, workspace: 'w1', status: 'idle', cwd: root },
      { name: 'worker', agent: 'cursor', pane: workerPane, workspace: 'w2', status: 'idle', cwd: root },
    ],
    workspaces: [{ id: 'w1', label: 'lead' }, { id: 'w2', label: 'worker' }],
    screens,
  };
  const sources: WatchSources = {
    live: () => live,
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: (pane) => screens[pane] ?? null,
    status: () => 'idle',
    foreground: () => ['claude', 'cursor-agent'],
    typeText: (pane, text) => {
      typed.push(`${pane} ${text}`);
      herdr('pane', 'send-text', pane, text);
      return true;
    },
    pressEnter: (pane) => {
      typed.push(`${pane} <enter>`);
      herdr('pane', 'send-keys', pane, 'enter');
      return true;
    },
    sleep: async (ms) => pause(ms),
    notify: () => {},
    now: () => new Date('2026-10-08T08:10:00.000Z'),
    wait: async () => false,
    alive: () => false,
    pid: process.pid,
    home,
  };
  const io = testIo(root, { kind: 'owner' });
  const code = await runWatch(['--file', join(root, '.agents', 'team.yaml')], io, sources);
  const leadAfter = herdr('pane', 'read', leadPane, '--source', 'recent', '--lines', '30');
  const workerAfter = herdr('pane', 'read', workerPane, '--source', 'recent', '--lines', '40');
  const report = {
    code,
    body: BODY,
    pane,
    receipt,
    typed,
    ring: ringText('lead', 'acme'),
    leadAfter,
    leadCreated,
    workerCreated,
    leadPane,
    workerPane,
    workerAfter,
    other: OTHER,
    m2: readFileSync(join(checkout, '.agents', 'messages', 'lead', 'm2.json'), 'utf8').includes('second body stays put'),
    m3: readFileSync(join(checkout, '.agents', 'messages', 'worker', 'm3.json'), 'utf8').includes('third body stays put'),
    m2Receipt: false,
    m3Receipt: false,
  };
  try {
    readFileSync(receiptFile(checkout, 'lead', 'm2'));
    report.m2Receipt = true;
  } catch { /* the watch does not write a receipt */ }
  try {
    readFileSync(receiptFile(checkout, 'worker', 'm3'));
    report.m3Receipt = true;
  } catch { /* the watch does not write a receipt */ }
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* already stopped */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { server?.kill(); } catch { /* the session stop owns the process */ }
  rmSync(base, { recursive: true, force: true });
}
