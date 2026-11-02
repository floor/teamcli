// The awaited whole-session read: one rotation over the session's agents, one process-info per
// pane, and a deadline. These scenes drive the seam directly with a controlled clock and an
// injected terminal-host read set, so no scene opens a live session: every option the read
// passes down is recorded, and every figure is synthetic.
//
// The claims pinned here are the cut's own: a pane the read did not reach is absent from every
// map (unread, never read as gone), the next call resumes at the cursor, and a stop cuts before
// the next pane without reading it.

import { describe, expect, test } from 'bun:test';
import { liveAsync, type AsyncSessionReads, type AsyncLiveOptions } from '../src/commands/status.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent, HerdrReadOptions, HerdrWorkspace } from '../src/herdr.ts';

const NOW = Date.parse('2026-11-02T09:00:00Z');

const TEAM = `format: 1
project: async-lab
session: async
coordinator: lead
operator: op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: desk
    human: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

function team(): TeamFile {
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function agent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: 'pane-ws', status: 'idle', cwd: null };
}

const INFO = (pane: string): unknown => ({
  process_info: { shell_pid: 500, foreground_processes: [{ pid: 501, argv0: `claude-${pane}` }] },
});

type Harvest = {
  screens: string[];
  infos: string[];
  options: HerdrReadOptions[];
  signals: (AbortSignal | undefined)[];
};

type Seams = {
  running?: boolean | null;
  agents?: HerdrAgent[] | null;
  workspaces?: HerdrWorkspace[] | null;
  /** How long each pane's process-info read takes on the fake clock. */
  stepMs?: number;
  clock: { ms: number };
};

/** A read set that answers from these fixtures and records every pane it was asked for. */
function seamsOf(input: Seams): { reads: AsyncSessionReads; harvest: Harvest } {
  const harvest: Harvest = { screens: [], infos: [], options: [], signals: [] };
  const took = (options: HerdrReadOptions): void => {
    harvest.options.push(options);
    harvest.signals.push(options.signal);
  };
  // One pane's cost is charged once, at its process-info read: the screen read of the same pane
  // is free, so a scene's step is the pane's own cost.
  const advance = (options: HerdrReadOptions): void => {
    took(options);
    input.clock.ms += input.stepMs ?? 0;
  };
  const reads: AsyncSessionReads = {
    running: async (_session, options) => {
      harvest.options.push(options);
      harvest.signals.push(options.signal);
      return input.running === undefined ? true : input.running;
    },
    agents: async (_session, options) => {
      harvest.options.push(options);
      harvest.signals.push(options.signal);
      return input.agents === undefined ? [] : input.agents;
    },
    workspaces: async (_session, options) => {
      harvest.options.push(options);
      harvest.signals.push(options.signal);
      return input.workspaces === undefined ? [] : input.workspaces;
    },
    screen: async (pane, _session, options) => {
      harvest.screens.push(pane);
      took(options);
      return `screen of ${pane}`;
    },
    processInfo: async (pane, _session, options) => {
      harvest.infos.push(pane);
      advance(options);
      return INFO(pane);
    },
  };
  return { reads, harvest };
}

function optionsAt(clock: { ms: number }, extra: Partial<AsyncLiveOptions> = {}): AsyncLiveOptions {
  return { timeoutMs: 2000, until: clock.ms + 10_000, now: () => clock.ms, ...extra };
}

describe('one awaited whole-session read', () => {
  test('a cut leaves the unreached pane out of every map and the next call resumes at the cursor', async () => {
    const clock = { ms: NOW };
    const agents = [agent('lead', 'pane-a'), agent('op', 'pane-b'), agent('worker-1', 'pane-c')];
    // Two panes per budget: 1200 ms each against a 2000 ms deadline reads two, then cuts.
    const { reads, harvest } = seamsOf({ clock, agents, stepMs: 1200 });

    const first = await liveAsync('async', team(), optionsAt(clock, { until: clock.ms + 2000 }), reads);
    expect(first.cut).toBe(true);
    expect(first.live?.running).toBe(true);
    expect(Object.keys(first.live?.screens ?? {}).sort()).toEqual(['pane-a', 'pane-b']);
    expect(Object.keys(first.live?.processes ?? {}).sort()).toEqual(['pane-a', 'pane-b']);
    expect(Object.keys(first.live?.foreground ?? {}).sort()).toEqual(['pane-a', 'pane-b']);
    // Unread is not absent: the pane the cut reached last is in none of the three maps.
    expect(first.live?.screens['pane-c']).toBeUndefined();
    expect(first.live?.processes?.['pane-c']).toBeUndefined();
    expect(first.live?.foreground?.['pane-c']).toBeUndefined();
    expect(first.next).toBe(2);
    expect(harvest.infos).toEqual(['pane-a', 'pane-b']);

    // The next pass starts where the cut stopped and reads a whole rotation.
    clock.ms += 1000;
    const second = await liveAsync('async', team(), optionsAt(clock, { cursor: first.next }), reads);
    expect(second.cut).toBe(false);
    expect(Object.keys(second.live?.screens ?? {}).sort()).toEqual(['pane-a', 'pane-b', 'pane-c']);
    expect(second.next).toBe(2);
    expect(harvest.screens).toEqual(['pane-a', 'pane-b', 'pane-c', 'pane-a', 'pane-b']);
    expect(harvest.infos).toEqual(['pane-a', 'pane-b', 'pane-c', 'pane-a', 'pane-b']);
  });

  test('a human seat takes no screen read, and every pane takes exactly one process-info', async () => {
    const clock = { ms: NOW };
    const agents = [agent('lead', 'pane-a'), agent('desk', 'pane-h'), agent('worker-1', 'pane-w')];
    const { reads, harvest } = seamsOf({ clock, agents });

    const read = await liveAsync('async', team(), optionsAt(clock), reads);
    expect(read.cut).toBe(false);
    expect(read.next).toBe(0);
    // The person's pane is never a screen read; its process identity is still read once.
    expect(harvest.screens).toEqual(['pane-a', 'pane-w']);
    expect(harvest.infos).toEqual(['pane-a', 'pane-h', 'pane-w']);
    expect(read.live?.screens['pane-h']).toBeUndefined();
    expect(read.live?.processes?.['pane-h']).toEqual({ shell: 500, foreground: [501] });
    expect(read.live?.foreground?.['pane-h']).toEqual(['claude-pane-h']);
    // Every call carries the per-call deadline the pass took.
    expect(harvest.options.every((options) => options.timeoutMs === 2000)).toBe(true);
  });

  test('a session read that cannot answer is unread, never a cut', async () => {
    const clock = { ms: NOW };
    for (const fixture of [
      { running: null },
      { agents: null },
      { workspaces: null },
    ] as const) {
      const { reads, harvest } = seamsOf({ clock, agents: [agent('lead', 'pane-a')], ...fixture });
      const read = await liveAsync('async', team(), optionsAt(clock), reads);
      expect(read.live).toBeNull();
      expect(read.cut).toBe(false);
      expect(read.next).toBe(0);
      expect(harvest.screens).toEqual([]);
      expect(harvest.infos).toEqual([]);
    }
    // A session that answers "not running" is a reading, not a cut: no agent, no pane read.
    const { reads, harvest } = seamsOf({ clock, running: false, agents: [agent('lead', 'pane-a')] });
    const stopped = await liveAsync('async', team(), optionsAt(clock), reads);
    expect(stopped.live).toEqual({ running: false, agents: [], workspaces: [], screens: {} });
    expect(stopped.cut).toBe(false);
    expect(harvest.screens).toEqual([]);
    expect(harvest.infos).toEqual([]);
  });

  test('a stop cuts before the next pane and reads none of the panes', async () => {
    const clock = { ms: NOW };
    const controller = new AbortController();
    controller.abort();
    const agents = [agent('lead', 'pane-a'), agent('op', 'pane-b')];
    const { reads, harvest } = seamsOf({ clock, agents });

    const read = await liveAsync(
      'async',
      team(),
      optionsAt(clock, { signal: controller.signal }),
      reads,
    );
    expect(read.cut).toBe(true);
    expect(read.next).toBe(0);
    expect(read.live?.agents).toHaveLength(2);
    expect(harvest.screens).toEqual([]);
    expect(harvest.infos).toEqual([]);
    // The stop is on every child the session read issued, before the cut was taken.
    expect(harvest.signals.every((signal) => signal?.aborted === true)).toBe(true);
  });
});
