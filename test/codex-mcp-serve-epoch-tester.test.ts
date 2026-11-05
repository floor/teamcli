// Independent check of the managed Codex endpoint placement (src/caller.ts) and the
// in-place relaunch that allowSame opens (src/launch/execute.ts). The process list, the
// agent list and the endpoint record are synthetic. No live host or CLI runs.
import { expect, test } from 'bun:test';
import type { CallerSources } from '../src/caller.ts';
import { placeCaller } from '../src/caller.ts';
import { seatOfManagedEndpoint } from '../src/launch/codex-endpoint.ts';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Step } from '../src/launch/plan.ts';

const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const MOVED = 'fixture-pane-two';
const SPACE = 'fixture-space';
const PID = 40;

function agent(name: string | null, pane: string, kind = 'codex'): HerdrAgent {
  return { name, agent: kind, pane, workspace: SPACE, status: 'idle', cwd: null };
}

function sources(over: {
  served?: { session: string; seat: string; pane?: string } | null;
  agents?: HerdrAgent[] | null;
  root?: number | null;
  name?: string;
}): CallerSources {
  return {
    ancestors: () => [{ pid: PID, name: over.name ?? 'codex' }],
    agents: () => over.agents === undefined ? [agent(null, PANE)] : over.agents,
    paneRootPid: () => over.root === undefined ? null : over.root,
    env: {},
    stdinIsTTY: false,
    managedEndpointSeat: () => over.served === undefined
      ? { session: SESSION, seat: SEAT, pane: PANE }
      : over.served,
  };
}

function placed(over: Parameters<typeof sources>[0], session: string | undefined = SESSION) {
  return placeCaller(sources(over), session);
}

test('a managed endpoint is the seat when its pane is unnamed or not yet listed', () => {
  expect(placed({ agents: [agent(null, PANE)] })).toEqual({ kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
  expect(placed({ agents: [], root: 11 })).toEqual({ kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
  expect(placed({ agents: [agent(SEAT, PANE)] })).toEqual({ kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
});

test('a process that is not that endpoint is not placed as the seat', () => {
  expect(placed({ served: null }).kind).not.toBe('seat');
  expect(placed({ name: 'claude' }).kind).not.toBe('seat');
  expect(placed({ served: { session: 'side', seat: SEAT, pane: PANE } }).kind).not.toBe('seat');
  expect(placed({ agents: [agent('other-seat', PANE)] }).kind).not.toBe('seat');
  expect(placed({ served: { session: SESSION, seat: SEAT, pane: 'fixture-pane-forged' }, agents: [], root: null }).kind).not.toBe('seat');
  expect(placed({ agents: null }).kind).not.toBe('seat');

  const forged = seatOfManagedEndpoint(PID, {
    commandOf: () => 'codex app-server --listen unix:///tmp/fixture-codex-epoch-forged.sock',
    alive: () => true,
    startOf: () => null,
  });
  expect(forged).toBeNull();
});

test('an unnamed pane running another program is not this seat', () => {
  expect(placed({ agents: [agent(null, PANE, 'claude')] }).kind).not.toBe('seat');
});

test('a pane left behind after the seat moved is not this seat', () => {
  const moved = placed({
    served: { session: SESSION, seat: SEAT, pane: PANE },
    agents: [agent(null, PANE), agent(SEAT, MOVED)],
  });
  expect(moved.kind === 'seat' && moved.pane === PANE).toBe(false);
});

test('an allowSame relaunch leaves a working pane untyped', async () => {
  const typed: string[] = [];
  const keys: string[] = [];
  const killed: number[] = [];
  const finals: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: () => true,
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    agentPanes: () => [PANE],
    agentList: () => [agent(SEAT, PANE)],
    processInfo: () => ({ shell: 100, foreground: [200] }),
    foreground: () => ['codex'],
    paneText: () => null,
    classify: (): ScreenKind => 'working',
    typeText: (_session, _pane, text) => {
      typed.push(text);
      return true;
    },
    pressEnter: () => {
      keys.push('enter');
      return true;
    },
    sendKey: (_session, _pane, key) => {
      keys.push(key);
      return true;
    },
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: () => {},
    final: (seat, record) => finals.push(`${seat}: ${record.kind} ${'reason' in record ? record.reason : ''}`),
    log: () => {},
  };
  const steps: Step[] = [{
    kind: 'run',
    argv: [],
    do: {
      do: 'relaunch',
      seat: SEAT,
      cli: 'codex',
      pane: PANE,
      workspace: SPACE,
      launched: { shell: 100, cli: [200] },
      endpoint: true,
    },
  }];
  await executePlan(steps, SESSION, host);
  expect(typed).toEqual([]);
  expect(keys).toEqual([]);
  expect(killed).toEqual([]);
  expect(finals.join('\n')).toContain('working');
});
