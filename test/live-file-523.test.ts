import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runReload } from '../src/commands/reload.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { grantGate } from '../src/grant.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { watchLabel } from '../src/watch/pane.ts';
import { readScreen, type Screen } from '../src/watch/screen.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const IDLE = CLAUDE_IDLE;
const WORKING = `${'─'.repeat(40)}\n❯ \nesc to interrupt\n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const DRAFT = claudeBox('Owner draft: keep this text until I send it.');
const AMPLE: Machine = {
  loadPerCore: 0.2, memoryFree: 80, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};

let base: string;
let root: string;
let dir: string;
let home: string;
let file: string;

function yaml(seats = 3, vendor = 3): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
workspace:
  mode: shared
seats:
${['lead', 'worker', 'helper'].map((name) => `  - role: ${name === 'lead' ? 'coordinator' : 'builder'}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    effort: high
`).join('')}limits:
  seats: ${seats}
  temporary: 0
  vendors:
    anthropic: ${vendor}
grant:
  session: acme
  seat: lead
  scope: [up, reload, swap]
`;
}

function noApproval(): void {
  expect(approvalStanding(root, home)).toEqual({ kind: 'none' });
  expect(existsSync(join(storePath('acme', root, home), 'approval.json'))).toBe(false);
}

function remember(name: string, effort = 'high'): void {
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 4242, heartbeat: NOW.toISOString() };
    session.seats[name] = {
      stage: 'ready', pane: `${name}-pane`, workspace: `${name}-ws`, cli: 'claude-code',
      launched: { shell: 1, cli: [2] }, model: 'Claude Opus', version: '5.5', effort,
      launch_line: 'claude --model claude-opus-5-5',
    };
  });
}

function agent(name: string, status = 'idle'): HerdrAgent {
  return { name, status, agent: 'claude', pane: `${name}-pane`, workspace: `${name}-ws`, cwd: null };
}

/** Only synthetic panes are reachable. Every destructive operation is recorded. */
function world(existing: HerdrAgent[] = []) {
  const created: string[] = [];
  const commands: string[] = [];
  const effects: string[] = [];
  const panes: string[] = existing.map((item) => item.pane);
  let running = existing.length > 0;
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => running ? 'running' : 'absent',
    startServer: () => { running = true; return true; },
    sessionUp: () => running,
    createWorkspace(_session, _cwd, label) {
      created.push(label);
      const name = `made-${created.length}`;
      panes.push(`${name}-pane`);
      return { pane: `${name}-pane`, workspace: `${name}-ws` };
    },
    paneRun(_session, _pane, command) { commands.push(command); return true; },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) { effects.push(`close ${workspace}`); return true; },
    agentPanes: () => panes,
    agents: () => existing,
    workspacePanes: (_session, workspace) => [workspace.replace(/-ws$/, '-pane')],
    paneText: () => IDLE,
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    typeText(_session, _pane, text) { effects.push(`type ${text}`); return true; },
    pressEnter() { effects.push('enter'); return true; },
    sendKey(_session, _pane, key) { effects.push(`key ${key}`); return true; },
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const up: UpSources = {
    home, launch, sessionRunning: launch.sessionUp, sessionState: launch.sessionState,
    agents: launch.agents, machine: () => AMPLE, now: launch.now, sleep: launch.sleep,
    alive: () => true,
    terminal: () => ({ key: async () => { throw new Error('unexpected terminal prompt'); }, drain() {} }),
  };
  return { launch, up, created, commands, effects };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-live-file-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  file = join(dir, 'team.yaml');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });
  writeFileSync(file, yaml());
  noApproval();
});

afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('up takes launch ceilings from the live file without an approved copy', () => {
  test.each([
    { name: 'total seat cap', seats: 1, vendor: 3, existing: false, launches: 1, reason: 'the file allows 1 seats; 2 would be running' },
    { name: 'vendor cap', seats: 3, vendor: 1, existing: false, launches: 1, reason: 'the file allows 1 anthropic seats; 2 would be running' },
    { name: 'zero vendor cap', seats: 3, vendor: 0, existing: false, launches: 0, reason: 'the file allows 0 anthropic seats; 1 would be running' },
    { name: 'running seats count toward the total', seats: 1, vendor: 3, existing: true, launches: 0, reason: 'the file allows 1 seats; 2 would be running' },
    { name: 'running seats count toward the vendor', seats: 3, vendor: 1, existing: true, launches: 0, reason: 'the file allows 1 anthropic seats; 2 would be running' },
    { name: 'all declared seats fit', seats: 3, vendor: 3, existing: false, launches: 3, reason: '' },
  ])('$name', async ({ seats, vendor, existing, launches, reason }) => {
    const text = yaml(seats, vendor);
    writeFileSync(file, text);
    if (existing) remember('lead');
    const made = world(existing ? [agent('lead')] : []);
    const io = testIo(root, OWNER);
    expect(await runUp([], io, made.up), io.err + io.out).toBe(reason ? 1 : 0);
    // The plan's last steps make the watch's own workspace and run the watch in its pane, so a
    // run that creates seats creates one workspace and one command more. A session whose record
    // already holds a live watch (the `existing` rows) starts none: `up` skips those steps.
    const watchSteps = existing ? 0 : 1;
    expect(made.created, io.err + io.out).toHaveLength(launches + watchSteps);
    expect(made.commands, io.err + io.out).toHaveLength(launches + watchSteps);
    if (watchSteps) {
      expect(made.created[launches], io.err + io.out).toBe(watchLabel('acme'));
      expect(made.commands[launches]).toContain('watch --session acme');
    }
    expect(made.effects).toEqual([]);
    if (reason) expect(io.out).toContain(reason);
    const ready = Object.entries(readState(dir).sessions.acme?.seats ?? {})
      .filter(([, seat]) => seat.stage === 'ready').map(([name]) => name).sort();
    expect(ready).toEqual((launches === 3 ? ['helper', 'lead', 'worker'] : launches || existing ? ['lead'] : []));
    expect(readFileSync(file, 'utf8')).toBe(text);
    noApproval();
  });
});

const protectedScreens: { name: string; status: string; text: string; kind: Screen['kind']; reason: string }[] = [
  { name: 'herdr reports a working turn', status: 'working', text: IDLE, kind: 'idle', reason: 'working' },
  { name: 'the screen shows a working turn', status: 'idle', text: WORKING, kind: 'working', reason: 'working' },
  { name: 'the input box holds owner text', status: 'idle', text: DRAFT, kind: 'unsent', reason: 'unsent text' },
];

function removing(name: string, status: string, text: string) {
  const made = world([agent(name, status)]);
  let clock = NOW.getTime();
  const effects = made.effects;
  const sources: RemoveSources = {
    home, sessionRunning: () => true, agents: made.launch.agents, alive: () => true,
    screen: () => readScreen('claude-code', text), screenText: () => text,
    status: () => status, foreground: () => ['claude'], shellBack: () => false,
    now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
    launch: {
      typeText: (_session, _pane, line) => { effects.push(`type ${line}`); return true; },
      sendKey: (_session, _pane, key) => { effects.push(`key ${key}`); return true; },
      pressEnter: () => { effects.push('enter'); return true; },
      agentPanes: made.launch.agentPanes, closeWorkspace: made.launch.closeWorkspace,
      stopSession: () => { effects.push('stop'); return true; },
      deleteSession: () => { effects.push('delete'); return true; },
      kill: () => { effects.push('kill'); return true; },
      sleep: async (ms) => { clock += ms; }, now: () => new Date(clock),
    },
  };
  return { sources, effects };
}

describe('remove --keep preserves work without an approved copy', () => {
  for (const name of ['lead', 'worker']) {
    test.each(protectedScreens)(`${name}: $name`, async ({ status, text, kind, reason }) => {
      expect(readScreen('claude-code', text).kind).toBe(kind);
      remember(name);
      const before = readFileSync(file, 'utf8');
      const state = readState(dir);
      const made = removing(name, status, text);
      const io = testIo(root, OWNER);
      expect(await runRemove([name, '--keep'], io, made.sources), io.err + io.out).toBe(1);
      expect(io.err).toContain(reason);
      expect(made.effects).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readState(dir)).toEqual(state);
      noApproval();
    });
  }

  test.each(protectedScreens)('an initially idle seat changes before exit typing: $name', async ({ status, text }) => {
    remember('worker');
    const before = readFileSync(file, 'utf8');
    const state = readState(dir);
    const made = removing('worker', 'idle', IDLE);
    // The planning reads see idle; the final exit check sees the current pane.
    made.sources.screenText = () => text;
    made.sources.status = () => status;
    const io = testIo(root, OWNER);
    expect(await runRemove(['worker', '--keep'], io, made.sources), io.err + io.out).toBe(1);
    expect(io.out).toContain('left as it is');
    expect(made.effects).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readState(dir)).toEqual(state);
    noApproval();
  });
});

describe('reload preserves work without an approved copy', () => {
  for (const late of [false, true]) {
    test.each(protectedScreens)(`${late ? 'changes before close' : 'already protected'}: $name`, async ({ status, text, kind, reason }) => {
      expect(readScreen('claude-code', text).kind).toBe(kind);
      remember('worker', 'low');
      const before = readFileSync(file, 'utf8');
      const state = readState(dir);
      const made = world([agent('worker')]);
      let lists = 0;
      let reads = 0;
      made.launch.agents = () => [agent('worker', late && ++lists === 1 ? 'idle' : status)];
      made.launch.paneText = () => late && ++reads === 1 ? IDLE : text;
      const io = testIo(root, OWNER);
      expect(await runReload(['worker'], io, { launch: made.launch, home, now: () => NOW }), io.err + io.out).toBe(1);
      expect(io.err).toContain(late ? 'nothing relaunched' : reason);
      expect(made.effects).toEqual([]);
      expect(made.created).toEqual([]);
      expect(made.commands).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readState(dir)).toEqual(state);
      expect(existsSync(join(dir, 'team.log'))).toBe(false);
      noApproval();
    });
  }
});

describe('the granted caller has no additional unasked-close path', () => {
  for (const command of ['remove', 'reload'] as const) {
    test.each(['working', 'owner text', 'quota', 'team trigger'])(`${command}: %s`, async (kind) => {
      remember('lead');
      remember('worker', 'low');
      const loaded = loadTeamFile(root, { home });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
      // An in-memory verified record exercises the grant path. A successful keep may
      // amend that record in the synthetic home; no approval command is invoked.
      const standing = verifiedOf(loaded.team, readFileSync(file, 'utf8'), root, NOW);
      const text = kind === 'working' ? WORKING : kind === 'owner text' ? DRAFT : kind === 'quota'
        ? readFileSync(new URL('./fixtures/claude-code/rate-limit.txt', import.meta.url), 'utf8')
        : (() => {
          const drops = join(dir, 'send-drops', 'acme', 'worker');
          mkdirSync(drops, { recursive: true });
          const path = join(drops, 'synthetic-brief');
          writeFileSync(path, 'Synthetic task.\n');
          return claudeBox(`Read ${path} and do that.`);
        })();
      expect(readScreen('claude-code', text).kind).toBe(kind === 'working' ? 'working' : kind === 'quota' ? 'rate limit' : 'unsent');
      const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' });
      if (command === 'remove') {
        const made = removing('worker', 'idle', text);
        made.sources.standing = () => standing;
        const code = await runRemove(['worker', '--keep'], io, made.sources);
        expect(code, io.err + io.out).toBe(kind === 'working' ? 1 : 0);
        // An idle non-owner removal can leave the pane running under another name;
        // it still cannot close it or send a key, even for a quota or team trigger.
        expect(made.effects).toEqual([]);
      } else {
        const before = readState(dir);
        const made = world([agent('worker')]);
        made.launch.paneText = () => text;
        const code = await runReload(['worker'], io, {
          launch: made.launch, home, now: () => NOW,
          grantGate: (input) => grantGate({ ...input, sources: { standing: () => standing } }),
        });
        expect(code, io.err + io.out).toBe(1);
        expect(io.err).toContain('nothing closed');
        expect(made.effects).toEqual([]);
        expect(made.created).toEqual([]);
        expect(made.commands).toEqual([]);
        expect(readState(dir)).toEqual(before);
      }
      if (command === 'reload' || kind === 'working') noApproval();
    });
  }
});
