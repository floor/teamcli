// A restart drops a seat's state entry when it stops it, and records the seat again only once the
// relaunched pane runs. A managed Codex seat's launch mints its presence binding in between, so
// the mint must create the entry rather than write into nothing; and what would stop the managed
// endpoint from starting is read before the old CLI is exited, never after (the seat must not be
// left a bare shell). Folders are scratch, processes and panes synthetic.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexEndpointPreflight, launchCodexEndpoint } from '../src/launch/codex-endpoint.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { shortSocketBase } from './helpers.ts';

const SESSION = 'bind-scene';
const SEAT = 'operator';
const PANE = 'w9:p1';
const WORKSPACE = 'w9';

function scratch(): string {
  return mkdtempSync(join(shortSocketBase(), 'crb-'));
}

test('a stopped seat with no state entry gets one holding a fresh binding, and its endpoint starts', async () => {
  const dir = scratch();
  try {
    // The state a restart leaves between its stop and the relaunch: the session, no seat entry.
    updateState(dir, (state) => {
      state.sessions[SESSION] ??= emptySession();
    });
    expect(readState(dir).sessions[SESSION]?.seats[SEAT]).toBeUndefined();
    let listening = false;
    const answer = await launchCodexEndpoint({
      dir, session: SESSION, seat: SEAT,
      deps: {
        spawn: () => { listening = true; return { pid: 9031 }; },
        alive: () => true,
        isPlainDir: () => true,
        isSocket: () => listening,
        sleep: async () => {},
      },
    });
    const entry = readState(dir).sessions[SESSION]?.seats[SEAT];
    expect(entry?.stage).toBe('launched');
    expect(typeof entry?.presence_binding).toBe('string');
    expect(answer.kind).toBe('up');
    if (answer.kind === 'up') expect(answer.url).toContain(`${entry?.presence_binding as string}.sock`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session with no entry at all is created for the mint too', async () => {
  const dir = scratch();
  try {
    updateState(dir, () => {});
    let listening = false;
    const answer = await launchCodexEndpoint({
      dir, session: SESSION, seat: SEAT,
      deps: {
        spawn: () => { listening = true; return { pid: 9032 }; },
        alive: () => true,
        isPlainDir: () => true,
        isSocket: () => listening,
        sleep: async () => {},
      },
    });
    expect(answer.kind).toBe('up');
    expect(typeof readState(dir).sessions[SESSION]?.seats[SEAT]?.presence_binding).toBe('string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight names nothing for a state folder whose socket fits, and writes nothing', () => {
  const dir = scratch();
  try {
    updateState(dir, (state) => {
      state.sessions[SESSION] ??= emptySession();
    });
    expect(codexEndpointPreflight({ dir, session: SESSION, seat: SEAT, runtimeRoot: dir })).toBeNull();
    expect(readState(dir).sessions[SESSION]?.seats[SEAT]).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight names a socket path no folder can bind', () => {
  const dir = scratch();
  try {
    const deep = join(dir, 'd'.repeat(120), 'e'.repeat(120));
    const answer = codexEndpointPreflight({ dir: deep, session: SESSION, seat: SEAT, runtimeRoot: deep });
    expect(answer).not.toBeNull();
    expect(answer as string).toContain('this build binds at most');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seeded(): string {
  const dir = scratch();
  updateState(dir, (state) => {
    state.sessions[SESSION] ??= emptySession();
  });
  return dir;
}

test('the preflight refuses an endpoint folder that is already a regular file', () => {
  const dir = seeded();
  try {
    mkdirSync(join(dir, 'run', SESSION), { recursive: true });
    writeFileSync(join(dir, 'run', SESSION, SEAT), '');
    expect(codexEndpointPreflight({ dir, session: SESSION, seat: SEAT, runtimeRoot: dir })).toBe('the endpoint folder is not a plain directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight refuses an endpoint folder whose parent is a regular file', () => {
  const dir = seeded();
  try {
    writeFileSync(join(dir, 'run'), '');
    expect(codexEndpointPreflight({ dir, session: SESSION, seat: SEAT, runtimeRoot: dir })).toBe('the endpoint folder is not a plain directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight refuses an endpoint folder that is a link, even to a directory', () => {
  const dir = seeded();
  try {
    mkdirSync(join(dir, 'elsewhere'));
    mkdirSync(join(dir, 'run', SESSION), { recursive: true });
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'run', SESSION, SEAT));
    expect(codexEndpointPreflight({ dir, session: SESSION, seat: SEAT, runtimeRoot: dir })).toBe('the endpoint folder is not a plain directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight passes an existing plain endpoint folder', () => {
  const dir = seeded();
  try {
    mkdirSync(join(dir, 'run', SESSION, SEAT), { recursive: true });
    expect(codexEndpointPreflight({ dir, session: SESSION, seat: SEAT, runtimeRoot: dir })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight refuses a runtime root that is a regular file when the socket moves there', () => {
  const base = scratch();
  try {
    // A state folder too deep for its own socket sends the endpoint to the runtime folder.
    const dir = join(base, 'd'.repeat(90));
    mkdirSync(dir, { recursive: true });
    updateState(dir, (state) => {
      state.sessions[SESSION] ??= emptySession();
    });
    const runtime = join(base, 'rt');
    writeFileSync(runtime, '');
    expect(codexEndpointPreflight({ dir, session: SESSION, seat: SEAT, runtimeRoot: runtime })).toBe('the runtime folder is not a plain directory');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a relaunch whose endpoint folder is blocked on disk is refused before any exit, close or key', async () => {
  const dir = seeded();
  try {
    mkdirSync(join(dir, 'run', SESSION), { recursive: true });
    writeFileSync(join(dir, 'run', SESSION, SEAT), '');
    const made = world(null);
    made.host.codexEndpointProblem = (input) => codexEndpointPreflight({ ...input, runtimeRoot: dir });
    const steps = relaunchThenLaunch().map((step) => (step.do?.do === 'launch' ? { ...step, do: { ...step.do, codexEndpoint: { dir } } } : step)) as Step[];
    await executePlan(steps, SESSION, made.host);
    expect(made.effects).toEqual([]);
    expect(made.said.join('')).toContain('the endpoint folder is not a plain directory; left running, nothing typed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function relaunchThenLaunch(): Step[] {
  return [
    { kind: 'run', argv: [], do: { do: 'relaunch', seat: SEAT, cli: 'codex', pane: PANE, workspace: WORKSPACE,
      launched: { shell: 100, cli: [200] }, endpoint: true } },
    { kind: 'run', argv: [], do: { do: 'launch', seat: SEAT, label: SEAT, command: 'codex', pane: PANE, cli: 'codex',
      cwd: '/fixture/seat', rulesCarried: false, recordLine: 'codex', codexEndpoint: { dir: '/fixture/state' } } },
  ];
}

function world(problem: string | null) {
  const effects: string[] = [];
  const said: string[] = [];
  const asked: { dir: string; seat: string }[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => { effects.push('create'); return { pane: PANE, workspace: WORKSPACE }; },
    paneRun: () => { effects.push('run'); return true; },
    typeLine: async () => { effects.push('type'); return false; },
    typeText: () => { effects.push('type'); return false; },
    sendKey: () => { effects.push('key'); return false; },
    pressEnter: () => { effects.push('enter'); return false; },
    renameAgent: () => true,
    agentList: () => [{ name: SEAT, agent: 'codex', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: '/fixture/seat' }],
    closeWorkspace: () => { effects.push('close'); return true; },
    stopSession: () => true,
    kill: () => { effects.push('kill'); return true; },
    agentPanes: () => [PANE],
    foreground: () => ['codex'],
    processInfo: () => ({ shell: 100, foreground: [200] }),
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    codexEndpointProblem: (input) => { asked.push({ dir: input.dir, seat: input.seat }); return problem; },
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => { said.push(line); },
    log: () => {},
  };
  return { host, effects, said, asked };
}

test('a relaunch whose managed endpoint could not start exits nothing: the seat keeps running', async () => {
  const made = world('the seat records no valid presence binding');
  await executePlan(relaunchThenLaunch(), SESSION, made.host);
  expect(made.asked).toEqual([{ dir: '/fixture/state', seat: SEAT }]);
  expect(made.effects).toEqual([]);
  expect(made.said.join('')).toContain('left running, nothing typed');
});

test('a relaunch with no managed launch in the plan never asks the endpoint preflight', async () => {
  const made = world('would refuse');
  const steps = relaunchThenLaunch().slice(0, 1);
  await executePlan(steps, SESSION, made.host);
  expect(made.asked).toEqual([]);
});
