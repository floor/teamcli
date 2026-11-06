// A failed sandbox write refuses the seat. The host write is injected before the launcher is
// imported, so the profile writer binds the injected one and the pane's command never runs.
// Every folder here is synthetic; nothing reads the machine's own Grok home.
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Host } from '../../src/launch/execute.ts';

const realWriteSync = realFs.writeSync;
mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  Object.assign(wrapped, {
    writeSync: (): number => {
      throw new Error('injected writer');
    },
  });
  return wrapped as typeof realFs;
});
afterAll(() => { mock.module('node:fs', () => ({ ...realFs, writeSync: realWriteSync })); });

let executePlan: (typeof import('../../src/launch/execute.ts'))['executePlan'];
let grokSandboxOf: (typeof import('../../src/launch/grok-sandbox.ts'))['grokSandboxOf'];
beforeAll(async () => {
  ({ executePlan } = await import('../../src/launch/execute.ts'));
  ({ grokSandboxOf } = await import('../../src/launch/grok-sandbox.ts'));
});

test('an injected writer error refuses the seat and launches nothing', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'grok-refuse-')));
  const home = join(base, 'home');
  const root = join(base, 'project');
  const start = join(root, 'seat');
  const grokHome = join(base, 'grok-home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(start, { recursive: true });
  mkdirSync(join(root, '.agents', 'send-drops', 'acme', 'grok-seat'), { recursive: true });
  mkdirSync(join(root, '.agents', 'messages', 'grok-seat'), { recursive: true });
  mkdirSync(join(root, '.agents', 'seat-state', 'acme'), { recursive: true });
  writeFileSync(join(root, '.agents', 'seat-state', 'acme', 'grok-seat.json'), '{"state":"idle","since":"2026-11-06T00:00:00Z"}\n', { mode: 0o600 });
  mkdirSync(grokHome, { recursive: true });
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = grokHome;
  const sandbox = grokSandboxOf({ home, root, project: 'acme', seat: 'grok-seat', session: 'acme', cwd: start });
  const runs: string[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-grok', workspace: 'ws-grok' }),
    paneRun: (_session, _pane, command) => { runs.push(command); return true; },
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [],
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => { said.push(line); },
    log: () => {},
  };
  try {
    await executePlan([
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'launch', seat: 'grok-seat', label: 'grok-seat', cli: 'grok', cwd: start,
          command: `grok --sandbox ${sandbox.profile}`,
          pane: 'pane-grok', grokSandbox: sandbox,
        },
      },
    ], 'acme', host);
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
  expect(runs).toEqual([]);
  const text = said.join('');
  expect(text).toContain('left out: its sandbox profile was not written: injected writer; nothing was launched. Repair the sandbox file, then launch the seat again');
  expect(text).not.toContain('launched without it');
});
