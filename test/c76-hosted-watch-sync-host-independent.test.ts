import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { hostedWatchSources } from '../src/daemon/watch-run.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import { markTaken, readTaken, TAKEN_IDLE_GRACE_MS } from '../src/send/taken.ts';
import type { Live } from '../src/status/compare.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import { wakePath } from '../src/watch/unread.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const SCREEN = readFileSync(new URL('./fixtures/codex/0.161.0/interrupted-idle.txt', import.meta.url), 'utf8');
const SEATS = ['alpha', 'beta'] as const;
const TEAM = `format: 1
project: acme
session: crew
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
${SEATS.map(name => `  - name: ${name}
    role: worker
    cli: codex
    vendor: openai
    model: GPT
    version: "5.4"
    launch: codex`).join('\n')}
`;
let base: string;
let savedXdg: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-sync-independent-')));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(base, 'config');
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(base, { recursive: true, force: true });
});

function world() {
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const dirs = new Map<string, string>();
  const taken = new Map<string, string[]>();
  for (const [index, name] of SEATS.entries()) {
    const dir = join(root, '.agents', 'send-drops', 'crew', name);
    dirs.set(name, dir);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const id = `12345678-0000-4000-8000-${String(index * 10 + n + 1).padStart(12, '0')}`;
      const at = new Date(NOW - TAKEN_IDLE_GRACE_MS - 15_000);
      const record = signRecord({ kind: 'message', id, to: name, to_id: null,
        root, session: 'crew', at: at.toISOString(), body: 'Synthetic work.',
        from: 'owner', from_id: null, rule: 'the owner', thread: id }, home);
      dropMessage(dir, id, JSON.stringify(record)+'\n');
      utimesSync(join(dir, id), at, at);
      if (n < 2) {
        ids.push(id);
        markTaken(dir, { id, from: 'owner', to: name, body: 'Synthetic work.', ts: at.toISOString(), before: index === 0 ? 'idle' : 'done' });
        // These two messages already had a wake, but have not been read. The third is due.
        writeFileSync(wakePath(dir, id), '{}\n');
      }
    }
    taken.set(name, ids);
  }
  return { root, home, dirs, taken };
}

type Scenario = 'snapshot' | 'missing' | 'no fallback';
type ScreenOptions = Parameters<NonNullable<WatchSources['screenAsync']>>[2];

function harness(scenario: Scenario, maxPasses: number) {
  const w = world();
  const controller = new AbortController();
  let cycles = 0;
  const syncCalls: string[] = [];
  const asyncReads: string[] = [];
  const asyncOptions: (ScreenOptions | undefined)[] = [];
  const wakes: string[] = [];
  const checkpoints: { retained: number[]; asyncReads: number; wakes: number }[] = [];
  const forbidden = (name: string): never => { syncCalls.push(name); throw new Error('unexpected synchronous host seam: '+name); };
  function screen(name: string): string {
    return w.taken.get(name)!.map(id => `• Read ${id} from send-drops`).join('\n')+'\n'+SCREEN;
  }
  function snapshot(): Live {
    const agents = [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-work', status: 'idle', cwd: w.root },
      ...SEATS.map((name, i) => ({ name, agent: 'codex', pane: name+'-pane', workspace: name+'-work', status: i === 0 ? 'idle' : 'done', cwd: w.root })),
    ];
    return {
      running: true, agents, workspaces: agents.map(a => ({ id: a.workspace, label: 'old label' })),
      screens: { 'lead-pane': SCREEN, ...(scenario === 'snapshot' ? { 'alpha-pane': screen('alpha'), 'beta-pane': screen('beta') } : {}) },
      processes: Object.fromEntries(agents.map((a, i) => [a.pane, { shell: 100+i*10, foreground: [101+i*10] }])),
      foreground: { 'lead-pane': ['claude'], 'alpha-pane': ['codex'], 'beta-pane': ['codex'] },
    };
  }
  const loop: HostedLoop = {
    signal: controller.signal,
    wait: async () => !controller.signal.aborted,
    standby: why => { throw new Error('unexpected standby: '+why); },
    cycled: () => {
      checkpoints.push({ retained: SEATS.map(name => readTaken(w.dirs.get(name)!).length), asyncReads: asyncReads.length, wakes: wakes.length });
      if (++cycles >= maxPasses) controller.abort();
    },
  };
  const sources: WatchSources = {
    live: () => forbidden('live'),
    liveAsync: async () => ({ live: snapshot(), cut: false, next: 0 }),
    machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
    standing: () => ({ kind: 'none' }), readChecks: () => [],
    screen: () => forbidden('screen'), status: () => forbidden('status'),
    foreground: () => forbidden('foreground'), processes: () => forbidden('processes'),
    ...(scenario === 'no fallback' ? {} : { screenAsync: async (pane: string, _session: string, options: ScreenOptions) => {
      asyncReads.push(pane);
      asyncOptions.push(options);
      await Promise.resolve();
      // Two whole passes cannot read the pane. The third sees evidence, not just an idle status.
      return cycles < 2 ? null : screen(pane.replace('-pane', ''));
    } }),
    renameWorkspace: () => forbidden('renameWorkspace'), reportDisplayAgent: () => forbidden('reportDisplayAgent'),
    typeText: () => forbidden('typeText'), pressEnter: () => forbidden('pressEnter'), sendKey: () => forbidden('sendKey'),
    typedWake: async (pane) => { wakes.push(pane); return { delivered: true, typed: true, tries: 1, reason: 'synthetic acknowledged wake' }; },
    sleep: async () => {}, notify: () => {}, now: () => new Date(NOW+cycles*1000),
    wait: async () => false, alive: () => true, pid: 4244, home: w.home,
    statusSource: { waitStatus: async () => ({ outcome: 'timeout', at: NOW }), promptKind: () => 'unknown' },
  };
  const route = routeOf(w.root, 'acme', 'crew', ['lead', ...SEATS]);
  const wired = hostedWatchSources(route, loop, sources, undefined, 4244);
  async function run() {
    // Restore throwing display seams after binding: runWatch itself must skip them too.
    const code = await runWatch([], {
      cwd: w.root, env: {}, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
      stdout: () => {}, stderr: () => {},
    }, { ...wired, renameWorkspace: sources.renameWorkspace, reportDisplayAgent: sources.reportDisplayAgent });
    expect(code).toBe(0);
    expect(cycles).toBe(maxPasses);
    expect(syncCalls).toEqual([]);
  }
  return { wired, run, syncCalls, asyncReads, asyncOptions, wakes, checkpoints };
}

describe('independent hosted watch snapshot contract', () => {
  test('the hosted binding closes label and display-agent effects without calling the base host', () => {
    const h = harness('snapshot', 1);
    expect(h.wired.renameWorkspace?.('crew', 'alpha-work', 'new label')).toBe(true);
    expect(h.wired.reportDisplayAgent?.('crew', 'alpha-pane', 'model')).toBe(true);
    expect(h.syncCalls).toEqual([]);
  });

  test('a complete snapshot drives taken confirmation and unread wakes without synchronous host calls or painting labels', async () => {
    const h = harness('snapshot', 1);
    await h.run();
    expect(h.checkpoints).toEqual([{ retained: [0, 0], asyncReads: 0, wakes: 2 }]);
    expect(h.wakes.sort()).toEqual(['alpha-pane', 'beta-pane']);
  });

  test('missing panes share one awaited read per pane per pass across taken and unread consumers; unreadable idle/done panes retain all markers', async () => {
    const h = harness('missing', 3);
    await h.run();
    expect(h.checkpoints).toEqual([
      { retained: [2, 2], asyncReads: 2, wakes: 0 },
      { retained: [2, 2], asyncReads: 4, wakes: 0 },
      { retained: [0, 0], asyncReads: 6, wakes: 2 },
    ]);
    expect(h.asyncReads).toEqual(['alpha-pane', 'beta-pane', 'alpha-pane', 'beta-pane', 'alpha-pane', 'beta-pane']);
  });

  test('a missing async reader never falls back to synchronous reads or guesses an unreadable pane is free', async () => {
    const h = harness('no fallback', 1);
    await h.run();
    expect(h.checkpoints).toEqual([{ retained: [2, 2], asyncReads: 0, wakes: 0 }]);
  });

  test('fallback terminal-host reads retain the bounded read options required by the watch source', async () => {
    const h = harness('missing', 1);
    await h.run();
    expect(h.asyncOptions).toHaveLength(2);
    for (const options of h.asyncOptions) {
      expect(options).toBeDefined();
      expect(options!.timeoutMs).toBeGreaterThan(0);
      expect(options!.timeoutMs).toBeLessThanOrEqual(2000);
      expect(options!.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
