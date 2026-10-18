// A seat the team file marks `human: true` is a human's pane. `team up` never launches into
// it and never types into it; `team down` never types its exit line into it. Both leave the
// seat as it is and say why. Every call that would touch a pane is recorded, and the scenes
// hold each one to nothing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { Key, Terminal } from '../../src/launch/terminal.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-18T09:00:00Z');
const AMPLE: Machine = {
  loadPerCore: 0.2, memoryFree: 80, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};
const OWNER = { kind: 'owner' as const };
const HUMAN_SKIP_UP = "desk: the pane is a human's; nothing is launched into it or typed into it; left as it is";
const HUMAN_SKIP_DOWN = "desk: the pane is a human's; nothing is typed into it; left running";

const FILE = `format: 1
project: acme
coordinator: desk
operator: desk
workspace:
  mode: shared
seats:
  - role: coordinator
    name: desk
    label: desk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    human: true
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-human-seat-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const lobby = join(home, '.config', 'team', 'lobby');
  writeFileSync(join(root, '.agents', 'team.yaml'), FILE.replace('workspace:\n', `trust:\n  - ${lobby}\n  - ${root}\nworkspace:\n`));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function terminal(): Terminal {
  return {
    async key(): Promise<Key> {
      throw new Error('the pause read the terminal');
    },
    drain() {},
  };
}

function agent(name: string, pane: string, workspace: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace, status: 'idle', cwd: null };
}

describe("a seat the file marks as a human's", () => {
  test('team up launches nothing into it and types nothing into it', async () => {
    const calls: string[] = [];
    let session: 'absent' | 'running' = 'absent';
    let n = 0;
    const launch: Launch = {
      sessionState: () => session,
      startServer() {
        session = 'running';
        calls.push('startServer');
        return true;
      },
      sessionUp: () => session === 'running',
      createWorkspace(_session, _cwd, label) {
        n += 1;
        calls.push(`createWorkspace ${label}`);
        return { pane: `w${n}:p1`, workspace: `w${n}` };
      },
      paneRun(_session, _pane, command) {
        calls.push(`paneRun ${command}`);
        return true;
      },
      renameAgent() {
        calls.push('renameAgent');
        return true;
      },
      closeWorkspace() {
        calls.push('closeWorkspace');
        return true;
      },
      agentPanes: () => [],
      agents: () => [],
      paneText: () => '',
      foreground: () => [],
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: UpSources = {
      sessionRunning: () => false,
      agents: () => [],
      home,
      now: () => NOW,
      machine: () => AMPLE,
      terminal,
      standing: () => ({ kind: 'none' }),
      launch,
    };
    const io = testIo(root, OWNER);
    expect(await runUp([], io, sources)).toBe(0);
    // The plan says the skip as it runs, on the progress stream, and the seat is not counted
    // short of ready: the run is a success.
    expect(io.err).toContain(`skip ${HUMAN_SKIP_UP}`);
    // The watch is the only thing started; nothing names the seat or its CLI, and no rule,
    // key or line reaches a pane.
    expect(calls.filter((call) => call.includes('desk') || call.includes('claude'))).toEqual([]);
    expect(calls).toContain('startServer');
  });

  test('team down leaves it running, never typing the exit line, even with --abandon', async () => {
    const calls: string[] = [];
    const launch: DownLaunch = {
      typeText: () => { calls.push('typeText'); return true; },
      sendKey: () => { calls.push('sendKey'); return true; },
      pressEnter: () => { calls.push('pressEnter'); return true; },
      agentPanes: () => ['w1:p1'],
      closeWorkspace: () => { calls.push('closeWorkspace'); return true; },
      stopSession: () => { calls.push('stopSession'); return true; },
      deleteSession: () => { calls.push('deleteSession'); return true; },
      kill: () => { calls.push('kill'); return true; },
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: DownSources = {
      sessionRunning: () => true,
      agents: () => [agent('desk', 'w1:p1', 'w1')],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      home,
      standing: () => ({ kind: 'none' }),
      launch,
    };
    for (const argv of [[], ['--abandon']]) {
      calls.length = 0;
      const io = testIo(root, OWNER);
      expect(await runDown(argv, io, sources)).toBe(0);
      expect(io.out).toContain(HUMAN_SKIP_DOWN);
      expect(io.out).toContain('session acme: not stopped, 1 agent left in it');
      expect(calls).toEqual([]);
    }
  });
});
