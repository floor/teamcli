// The automatic order pass after add/restart: the sidebar tail is the set `team order`
// would move, idle means none of it works or sits at a prompt, and the pass itself is a
// real detached `team order` that re-checks everything. Fakes only — no pane host.
import { describe, expect, test } from 'bun:test';
import type { HerdrAgent } from '../src/herdr.ts';
import {
  AUTO_ORDER_MARKER,
  maybeAutoOrder,
  sidebarTail,
  type AutoOrderInput,
  type AutoOrderSources,
} from '../src/launch/auto-order.ts';

const team = {
  orchestrator: 'lead',
  seats: [{ name: 'lead' }, { name: 'ops' }, { name: 'worker' }],
};

const recorded = {
  seats: {
    lead: { pane: 'p-lead', workspace: 'w-lead' },
    ops: { pane: 'p-ops', workspace: 'w-ops' },
    worker: { pane: 'p-worker', workspace: 'w-worker' },
  },
};

function agent(pane: string, workspace: string, status: string): HerdrAgent {
  return { name: null, agent: null, pane, workspace, status, cwd: null };
}

type World = {
  workspaces: string[];
  statuses: Record<string, string>;
  spawned: string[][];
  reads: number;
  spawnThrows?: boolean;
  hostSilent?: boolean;
};

function world(overrides: Partial<World> = {}): World {
  return {
    workspaces: ['w-lead', 'w-worker', 'w-ops'],
    statuses: { lead: 'idle', ops: 'idle', worker: 'idle' },
    spawned: [],
    reads: 0,
    ...overrides,
  };
}

function sourcesOf(w: World, env: Record<string, string | undefined> = {}): AutoOrderSources {
  return {
    workspaces: () => {
      w.reads += 1;
      return w.hostSilent ? null : w.workspaces.map((id) => ({ id }));
    },
    agents: () => {
      w.reads += 1;
      return w.hostSilent ? null : Object.entries(recorded.seats).map(([name, held]) => agent(held.pane, held.workspace, w.statuses[name] ?? 'idle'));
    },
    state: () => ({ sessions: { acme: recorded } }),
    spawnOrder: (argv) => {
      if (w.spawnThrows) throw new Error('a made-up spawn failure');
      w.spawned.push(argv);
    },
    env: (name) => env[name],
  };
}

const input = (overrides: Partial<AutoOrderInput> = {}): AutoOrderInput => ({
  root: '/fixture/acme',
  dir: '/fixture/acme/.agents',
  team,
  session: 'acme',
  manage: true,
  ...overrides,
});

describe('the automatic order pass', () => {
  test('the tail is the seats from the first divergence, in roster order', () => {
    const w = world();
    const tail = sidebarTail(team, recorded, w.workspaces.map((id) => ({ id })), []);
    expect(tail.inSidebar).toEqual(['lead', 'worker', 'ops']);
    expect(tail.aimed).toEqual(['lead', 'ops', 'worker']);
    expect(tail.tail).toEqual(['ops', 'worker']);
  });

  test('an ordered sidebar spawns nothing and hints nothing', () => {
    const w = world({ workspaces: ['w-lead', 'w-ops', 'w-worker'] });
    expect(maybeAutoOrder(input(), sourcesOf(w))).toBeNull();
    expect(w.spawned).toEqual([]);
  });

  test('an idle tail spawns one detached order pass for the session', () => {
    const w = world();
    expect(maybeAutoOrder(input(), sourcesOf(w))).toBeNull();
    expect(w.spawned).toEqual([['order', '--session', 'acme']]);
    const withFile = world();
    maybeAutoOrder(input({ file: 'ops.yaml' }), sourcesOf(withFile));
    expect(withFile.spawned).toEqual([['order', '--session', 'acme', '--file', 'ops.yaml']]);
  });

  test('a working or blocked tail seat prints the hint instead', () => {
    for (const status of ['working', 'blocked']) {
      const w = world({ statuses: { lead: 'idle', ops: status, worker: 'idle' } });
      const note = maybeAutoOrder(input(), sourcesOf(w));
      expect(note).toContain('team order');
      expect(w.spawned).toEqual([]);
    }
  });

  test('a busy seat outside the tail does not hold the pass', () => {
    const w = world({ statuses: { lead: 'working', ops: 'idle', worker: 'done' } });
    expect(maybeAutoOrder(input(), sourcesOf(w))).toBeNull();
    expect(w.spawned).toHaveLength(1);
  });

  test('manage off: no spawn, no hint, and the host is never read', () => {
    const w = world();
    expect(maybeAutoOrder(input({ manage: false }), sourcesOf(w))).toBeNull();
    expect(w.spawned).toEqual([]);
    expect(w.reads).toBe(0);
  });

  test('inside an order pass the hook is silent', () => {
    const w = world();
    expect(maybeAutoOrder(input(), sourcesOf(w, { [AUTO_ORDER_MARKER]: '1' }))).toBeNull();
    expect(w.spawned).toEqual([]);
  });

  test('a silent host cannot prove idle: the hint prints', () => {
    const w = world({ hostSilent: true });
    expect(maybeAutoOrder(input(), sourcesOf(w))).toContain('team order');
    expect(w.spawned).toEqual([]);
  });

  test('a spawn that throws degrades to the hint', () => {
    const w = world({ spawnThrows: true });
    expect(maybeAutoOrder(input(), sourcesOf(w))).toContain('team order');
    expect(w.spawned).toEqual([]);
  });
});
