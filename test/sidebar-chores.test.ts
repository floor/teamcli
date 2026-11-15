import { execText, DEFAULT_CHILD_TIMEOUT_MS } from '../src/child.ts';
import { createChildSteps, childStepsAt, traceChildStep } from '../src/diagnostics/child-steps.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  serveChoresChild,
  type ChoresSlices,
} from '../src/daemon/chores/child.ts';
import type {
  ChoresChildConfig,
  ChoresChildMessage,
  ChoresChildRoute,
} from '../src/daemon/chores/protocol.ts';
import { createSidebarPass } from '../src/daemon/chores/sidebar.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  SIDEBAR_TTL_CAP_MS,
  setHerdrRun,
  workspacePaneDisplays,
  sessionPaneDisplaysAsync,
  reportDisplayAgentAsync,
  setHerdrCapture,
} from '../src/herdr.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { SeatState } from '../src/state.ts';

const DEFAULT_SIDEBAR_TTL_MS = SIDEBAR_TTL_CAP_MS;
const DEFAULT_SIDEBAR_REFRESH_MS = 21_600_000;

const TEAM_YAML = `format: 1
entity: acme
project: acme-app
session: acme-dev
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.7"
    effort: max
    launch: claude --model claude-opus-4-7 --effort max
  - name: builder-1
    role: builder
    cli: codex
    vendor: openai
    model: Codex
    version: "5.3"
    effort: high
    launch: codex -m gpt-5.3-codex
  - name: builder-2
    role: builder
    cli: gemini
    vendor: google
    model: Gemini Pro
    version: "3"
    launch: gemini
`;

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const AT = new Date(NOW).toISOString();

const openSlices: ChoresSlices = {
  sliceMs: 2000,
  stopping: () => false,
  yield: async () => true,
};

const dirs: string[] = [];

afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorld(): { base: string; home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sidebar-chores-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  upsertTeam(home, teamIdOf(root), {
    project: 'acme-app',
    entity: 'acme',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_lead00000000', seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  return { base, home, root };
}

function makeTeam(): TeamFile {
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function makeConfig(home: string, route: ChoresChildRoute): ChoresChildConfig {
  return {
    version: 1,
    home,
    beatMs: 100,
    sliceMs: 2000,
    since: AT,
    routes: [route],
  };
}

describe('workspacePaneDisplays adapter reader', () => {
  test('reads pane_id, workspace_id, and optional display_agent from pane list --workspace', () => {
    const calls: { args: string[]; session?: string }[] = [];
    setHerdrRun((args, session) => {
      calls.push({ args, ...(session !== undefined ? { session } : {}) });
      return {
        panes: [
          {
            pane_id: 'pane-1',
            workspace_id: 'ws-1',
            display_agent: 'Claude Opus 4.7 · max',
          },
          {
            pane_id: 'pane-2',
            workspace_id: 'ws-1',
          },
          {
            pane_id: 'pane-3',
            workspace_id: 'ws-1',
            display_agent: '',
          },
        ],
      };
    });

    const panes = workspacePaneDisplays('ws-1', 'acme-dev');
    expect(calls).toEqual([
      { args: ['pane', 'list', '--workspace', 'ws-1'], session: 'acme-dev' },
    ]);
    expect(panes).toEqual([
      {
        pane: 'pane-1',
        workspace: 'ws-1',
        displayAgent: 'Claude Opus 4.7 · max',
      },
      {
        pane: 'pane-2',
        workspace: 'ws-1',
      },
      {
        pane: 'pane-3',
        workspace: 'ws-1',
      },
    ]);
  });

  test('returns null when the host throws or answers with a mismatched workspace', () => {
    setHerdrRun(() => ({
      panes: [{ pane_id: 'pane-1', workspace_id: 'ws-other' }],
    }));
    expect(workspacePaneDisplays('ws-1', 'acme-dev')).toBeNull();

    setHerdrRun(() => {
      throw new Error('socket closed');
    });
    expect(workspacePaneDisplays('ws-1', 'acme-dev')).toBeNull();
  });
});

describe('createSidebarPass — chores metadata refresh', () => {
  test('reports every declared seat with a recorded pane using displayAgent(seat) and resolved daemon.sidebar-ttl-ms, skipping seats without a pane', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    const seats: Record<string, SeatState> = {
      lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' },
      'builder-1': { stage: 'ready' }, // no recorded pane -> skipped
      'builder-2': { stage: 'ready', pane: 'pane-b2', workspace: 'ws-b2' },
    };
    const reports: { pane: string; text: string; session: string; ttlMs: number }[] = [];
    const reads: { session: string; pane: string; workspace?: string }[] = [];

    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => seats,
      paneDisplay: (session, pane, workspace) => {
        reads.push({ session, pane, ...(workspace !== undefined ? { workspace } : {}) });
        return undefined;
      },
      reportDisplay: (pane, text, session, ttlMs) => {
        reports.push({ pane, text, session, ttlMs });
        return true;
      },
    });

    const notes = await pass({ route, at: new Date(NOW), slices: openSlices });
    expect(notes).toEqual([]);
    expect(reads).toEqual([
      { session: 'acme-dev', pane: 'pane-lead', workspace: 'ws-lead' },
      { session: 'acme-dev', pane: 'pane-b2', workspace: 'ws-b2' },
    ]);
    expect(reports).toEqual([
      {
        pane: 'pane-lead',
        text: 'Claude Opus 4.7 max',
        session: 'acme-dev',
        ttlMs: DEFAULT_SIDEBAR_TTL_MS,
      },
      {
        pane: 'pane-b2',
        text: 'Gemini Pro 3',
        session: 'acme-dev',
        ttlMs: DEFAULT_SIDEBAR_TTL_MS,
      },
    ]);

    // Configure a custom team-level TTL and run at the next refresh window.
    const setTtl = writePolicySet(
      home,
      {
        level: 'team',
        target: root,
        teamRoot: root,
        name: 'daemon.sidebar-ttl-ms',
        value: 43_200_000,
      },
      { now: new Date(NOW) },
    );
    expect(setTtl.ok).toBe(true);

    reports.length = 0;
    await pass({
      route,
      at: new Date(NOW + DEFAULT_SIDEBAR_REFRESH_MS),
      slices: openSlices,
    });
    expect(reports).toEqual([
      {
        pane: 'pane-lead',
        text: 'Claude Opus 4.7 max',
        session: 'acme-dev',
        ttlMs: 43_200_000,
      },
      {
        pane: 'pane-b2',
        text: 'Gemini Pro 3',
        session: 'acme-dev',
        ttlMs: 43_200_000,
      },
    ]);
  });

  test('read-back guard: reports absent or equal display lines, and skips + notes a pane holding a different live observation', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    const seats: Record<string, SeatState> = {
      lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-1' },
      'builder-1': { stage: 'ready', pane: 'pane-b1', workspace: 'ws-1' },
      'builder-2': { stage: 'ready', pane: 'pane-b2', workspace: 'ws-2' },
    };

    const workspaceCalls: string[] = [];
    const reports: { pane: string; text: string; ttlMs: number }[] = [];

    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => seats,
      workspacePanes: (workspace) => {
        workspaceCalls.push(workspace);
        if (workspace === 'ws-1') {
          return [
            // Absent (expired or never reported) -> should be reported
            { pane: 'pane-lead', workspace: 'ws-1' },
            // Different live observation (e.g. effort changed on screen) -> should be skipped and noted
            { pane: 'pane-b1', workspace: 'ws-1', displayAgent: 'Codex 5.3 xhigh' },
          ];
        }
        return [
          // Present and equal -> should be re-reported to extend TTL
          { pane: 'pane-b2', workspace: 'ws-2', displayAgent: 'Gemini Pro 3' },
        ];
      },
      reportDisplay: (pane, text, _session, ttlMs) => {
        reports.push({ pane, text, ttlMs });
        return true;
      },
    });

    const notes = await pass({ route, at: new Date(NOW), slices: openSlices });

    // Workspace ws-1 holds two seats but is queried only once in the pass.
    expect(workspaceCalls).toEqual(['ws-1', 'ws-2']);
    expect(reports).toEqual([
      {
        pane: 'pane-lead',
        text: 'Claude Opus 4.7 max',
        ttlMs: DEFAULT_SIDEBAR_TTL_MS,
      },
      {
        pane: 'pane-b2',
        text: 'Gemini Pro 3',
        ttlMs: DEFAULT_SIDEBAR_TTL_MS,
      },
    ]);
    expect(notes).toEqual([
      'sidebar refresh: builder-1 (pane-b1): skipped; live display "Codex 5.3 xhigh" differs from declared "Codex 5.3 high"',
    ]);
  });

  test('skips the pass with a note and makes 0 host calls when daemon.chores is inline', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    const wrote = writePolicySet(
      home,
      {
        level: 'team',
        target: root,
        teamRoot: root,
        name: 'daemon.chores',
        value: 'inline',
      },
      { now: new Date(NOW) },
    );
    expect(wrote.ok).toBe(true);

    let hostCalls = 0;
    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => ({
        lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-1' },
      }),
      paneDisplay: () => {
        hostCalls += 1;
        return undefined;
      },
      workspacePanes: () => {
        hostCalls += 1;
        return [];
      },
      reportDisplay: () => {
        hostCalls += 1;
        return true;
      },
    });

    const notes = await pass({ route, at: new Date(NOW), slices: openSlices });
    expect(hostCalls).toBe(0);
    expect(notes).toEqual([
      `sidebar refresh: skipped for ${root} (daemon.chores is inline)`,
    ]);
  });

  test('runs again at daemon.sidebar-refresh-ms cadence under a fake clock, and not before', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    const refreshMs = 600_000;
    const wrote = writePolicySet(
      home,
      {
        level: 'team',
        target: root,
        teamRoot: root,
        name: 'daemon.sidebar-refresh-ms',
        value: refreshMs,
      },
      { now: new Date(NOW) },
    );
    expect(wrote.ok).toBe(true);

    let reports = 0;
    let reads = 0;
    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => ({
        lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-1' },
      }),
      paneDisplay: () => {
        reads += 1;
        return 'Claude Opus 4.7 max';
      },
      reportDisplay: () => {
        reports += 1;
        return true;
      },
    });

    // Initial pass at NOW: runs and reports.
    expect(await pass({ route, at: new Date(NOW), slices: openSlices })).toEqual([]);
    expect(reads).toBe(1);
    expect(reports).toBe(1);

    // Before refreshMs has elapsed: neither reads nor reports.
    expect(await pass({ route, at: new Date(NOW + 1_000), slices: openSlices })).toEqual([]);
    expect(await pass({ route, at: new Date(NOW + refreshMs - 1), slices: openSlices })).toEqual([]);
    expect(reads).toBe(1);
    expect(reports).toBe(1);

    // Exactly at NOW + refreshMs: runs again.
    expect(await pass({ route, at: new Date(NOW + refreshMs), slices: openSlices })).toEqual([]);
    expect(reads).toBe(2);
    expect(reports).toBe(2);

    // Before the second window closes: quiet again.
    expect(await pass({ route, at: new Date(NOW + refreshMs * 2 - 1), slices: openSlices })).toEqual([]);
    expect(reads).toBe(2);
    expect(reports).toBe(2);

    // At the second window: runs a third time.
    expect(await pass({ route, at: new Date(NOW + refreshMs * 2), slices: openSlices })).toEqual([]);
    expect(reads).toBe(3);
    expect(reports).toBe(3);
  });

  test('records a host refusal as a note without throwing, and retries the failed seat on the next pass', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    const seats: Record<string, SeatState> = {
      lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-1' },
      'builder-1': { stage: 'ready', pane: 'pane-b1', workspace: 'ws-2' },
    };

    let failReadLead = true;
    let failReportBuilder = true;
    const reported: string[] = [];

    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => seats,
      paneDisplay: (_session, pane) => {
        if (pane === 'pane-lead' && failReadLead) return null;
        return undefined;
      },
      reportDisplay: (pane) => {
        if (pane === 'pane-b1' && failReportBuilder) return false;
        reported.push(pane);
        return true;
      },
    });

    // First pass: lead fails read-back, builder-1 fails report; both emit notes and neither throws.
    const firstNotes = await pass({ route, at: new Date(NOW), slices: openSlices });
    expect(firstNotes).toEqual([
      'sidebar refresh: lead (pane-lead): the terminal host did not answer for the workspace panes',
      'sidebar refresh: builder-1 (pane-b1): display was not reported',
    ]);
    expect(reported).toEqual([]);

    // Next pass 5 seconds later (well before the 6 h refresh cadence): both failed seats retry!
    // This time lead succeeds while builder-1 still refuses.
    failReadLead = false;
    const secondNotes = await pass({ route, at: new Date(NOW + 5_000), slices: openSlices });
    expect(secondNotes).toEqual([
      'sidebar refresh: builder-1 (pane-b1): display was not reported',
    ]);
    expect(reported).toEqual(['pane-lead']);

    // Third pass 5 seconds later: lead is within its refresh window so only builder-1 retries.
    failReportBuilder = false;
    const thirdNotes = await pass({ route, at: new Date(NOW + 10_000), slices: openSlices });
    expect(thirdNotes).toEqual([]);
    expect(reported).toEqual(['pane-lead', 'pane-b1']);
  });

  test('stops cleanly between seats when the slice stops mid-pass, leaving remaining seats due', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    const seats: Record<string, SeatState> = {
      lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-1' },
      'builder-1': { stage: 'ready', pane: 'pane-b1', workspace: 'ws-1' },
      'builder-2': { stage: 'ready', pane: 'pane-b2', workspace: 'ws-1' },
    };

    const reported: string[] = [];
    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => seats,
      paneDisplay: () => undefined,
      reportDisplay: (pane) => {
        reported.push(pane);
        return true;
      },
    });

    let stopping = false;
    let yields = 0;
    const stoppingSlices: ChoresSlices = {
      sliceMs: 250,
      stopping: () => stopping,
      yield: async () => {
        yields += 1;
        stopping = true;
        return false;
      },
    };

    // Stops at the first yield boundary after the first seat ('lead').
    const notes = await pass({ route, at: new Date(NOW), slices: stoppingSlices });
    expect(notes).toEqual([]);
    expect(yields).toBe(1);
    expect(reported).toEqual(['pane-lead']);

    // A subsequent pass with open slices picks up the two seats that had not run yet.
    const nextNotes = await pass({ route, at: new Date(NOW + 1_000), slices: openSlices });
    expect(nextNotes).toEqual([]);
    expect(reported).toEqual(['pane-lead', 'pane-b1', 'pane-b2']);
  });

  test('rides the chores child pass frame alongside the fallback sweep', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };
    const config = makeConfig(home, route);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const messages: ChoresChildMessage[] = [];
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') messages.push(JSON.parse(line) as ChoresChildMessage);
      }
    });

    const reported: string[] = [];
    const sidebar = createSidebarPass(config, {
      readSeats: () => ({
        lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-1' },
        'builder-1': { stage: 'ready', pane: 'pane-b1', workspace: 'ws-1' },
      }),
      paneDisplay: (_session, pane) =>
        pane === 'pane-b1' ? 'Codex 5.3 xhigh' : undefined,
      reportDisplay: (pane) => {
        reported.push(pane);
        return true;
      },
    });

    const served = serveChoresChild({
      config,
      stdin,
      stdout,
      now: () => new Date(NOW),
      pass: async () => [],
      sidebar,
    });

    stdin.write(`${JSON.stringify({ type: 'tick', id: 'tick-1', at: AT })}\n`);
    const deadline = Date.now() + 5_000;
    while (!messages.some((msg) => msg.type === 'pass') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stdin.write(`${JSON.stringify({ type: 'stop', why: 'done' })}\n`);
    expect(await served).toBe(0);

    expect(reported).toEqual(['pane-lead']);
    const passFrame = messages.find((msg) => msg.type === 'pass');
    expect(passFrame).toMatchObject({
      type: 'pass',
      passes: [
        {
          root,
          at: AT,
          notes: [
            'sidebar refresh: builder-1 (pane-b1): skipped; live display "Codex 5.3 xhigh" differs from declared "Codex 5.3 high"',
          ],
          chore: 'fallback',
        },
      ],
    });
  });

  test('discovers the workspace when a seat record omits it, and reports the declared line once a live observation lapses', async () => {
    const { home, root } = makeWorld();
    const team = makeTeam();
    const route: ChoresChildRoute = {
      root,
      team: 'acme-app',
      session: 'acme-dev',
      teamFile: team,
    };

    let liveDisplay: string | undefined = 'Codex 5.3 xhigh';
    const reports: { pane: string; text: string }[] = [];

    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => ({
        'builder-1': { stage: 'ready', pane: 'pane-b1' }, // workspace omitted
      }),
      workspaces: () => [{ id: 'ws-discovered' }],
      workspacePanes: (workspace) => [
        {
          pane: 'pane-b1',
          workspace,
          ...(liveDisplay !== undefined ? { displayAgent: liveDisplay } : {}),
        },
      ],
      reportDisplay: (pane, text) => {
        reports.push({ pane, text });
        return true;
      },
    });

    // First window: live display differs, so the pass skips and notes it.
    const first = await pass({ route, at: new Date(NOW), slices: openSlices });
    expect(first).toEqual([
      'sidebar refresh: builder-1 (pane-b1): skipped; live display "Codex 5.3 xhigh" differs from declared "Codex 5.3 high"',
    ]);
    expect(reports).toEqual([]);

    // Next window after the live display's TTL has lapsed: the pass reports the declared line.
    liveDisplay = undefined;
    const second = await pass({
      route,
      at: new Date(NOW + DEFAULT_SIDEBAR_REFRESH_MS),
      slices: openSlices,
    });
    expect(second).toEqual([]);
    expect(reports).toEqual([{ pane: 'pane-b1', text: 'Codex 5.3 high' }]);
  });
});


describe('first-cycle step diagnostics', () => {
  test('records pending work before a block and preserves outcomes, counts and throws', () => {
    let clock = NOW;
    const notes: string[] = [];
    const work = createChildSteps((text) => notes.push(text), () => clock);
    try {
      const returned = traceChildStep('sidebar pane-list', () => {
        // Existing watch_start_limit default (src/file/sections/watch.ts); virtual time only.
        const pending = childStepsAt(notes.at(-1)!, clock + 120_000);
        expect(pending).toContain('sidebar pane-list=120000.0ms pending');
        // Existing synchronous read bound in src/herdr.ts: run(), not a new wait.
        clock += 10_000;
        return ['pane-1', 'pane-2'];
      });
      expect(returned).toEqual(['pane-1', 'pane-2']);
      expect(traceChildStep('sidebar metadata-report', () => false)).toBe(false);
      const failure = new Error('synthetic host failure');
      expect(() => traceChildStep('terminal-host pane list', () => { throw failure; })).toThrow(failure);
      const summary = childStepsAt(notes.at(-1)!, clock)!;
      expect(summary).toContain('sidebar pane-list=10000.0ms/1calls/2items');
      expect(summary).toContain('"false":1');
      expect(summary).toContain('"threw":1');
      expect(summary).not.toContain('pending');
    } finally { work.stop(); }
    const count = notes.length;
    traceChildStep('after first cycle', () => true);
    expect(notes.length).toBe(count);
  });

  test('preserves promise identity and reports rejection without changing it', async () => {
    const notes: string[] = [];
    const work = createChildSteps((text) => notes.push(text), () => NOW);
    try {
      const failure = new Error('synthetic async failure');
      const promise = Promise.reject(failure);
      expect(traceChildStep('readings async', () => promise)).toBe(promise);
      await expect(promise).rejects.toBe(failure);
      expect(childStepsAt(notes.at(-1)!, NOW)).toContain('"rejected":1');
    } finally { work.stop(); }
  });

  test('a diagnostic sink failure cannot change a measured result', () => {
    const work = createChildSteps(() => { throw new Error('closed pipe'); });
    try { expect(traceChildStep('readings', () => 42)).toBe(42); }
    finally { work.stop(); }
    expect(childStepsAt('ordinary note', NOW)).toBeNull();
    expect(childStepsAt('first-cycle steps: broken json', NOW)).toBeNull();
  });
});


describe('bounded sidebar after the first watch cycle', () => {
  test('reads all workspaces through one named session call', async () => {
    const calls: { args: string[]; session?: string }[] = [];
    setHerdrRun((args, session) => {
      calls.push({ args, session });
      return { panes: [
        { pane_id: 'pane-a', workspace_id: 'space-a', display_agent: 'live' },
        { pane_id: 'pane-b', workspace_id: 'space-b' },
      ] };
    });
    expect(await sessionPaneDisplaysAsync('synthetic-session')).toEqual([
      { pane: 'pane-a', workspace: 'space-a', displayAgent: 'live' },
      { pane: 'pane-b', workspace: 'space-b' },
    ]);
    expect(calls).toEqual([{ args: ['pane', 'list'], session: 'synthetic-session' }]);
    setHerdrRun(() => ({ panes: [{ pane_id: 'bad', workspace_id: '' }] }));
    expect(await sessionPaneDisplaysAsync('synthetic-session')).toBeNull();
  });

  test('the async display adapter keeps the same TTL and host-refusal checks', async () => {
    const calls: { args: string[]; session?: string }[] = [];
    setHerdrCapture((args, session) => { calls.push({ args, session }); return '{"result":{"type":"ok"}}'; });
    expect(await reportDisplayAgentAsync('p1', 'label', 'synthetic-session', DEFAULT_SIDEBAR_TTL_MS)).toBe(true);
    expect(calls).toEqual([{ args: ['pane', 'report-metadata', 'p1', '--source', 'team', '--display-agent', 'label', '--ttl-ms', String(DEFAULT_SIDEBAR_TTL_MS)], session: 'synthetic-session' }]);
    expect(await reportDisplayAgentAsync('p1', 'label', 'synthetic-session', SIDEBAR_TTL_CAP_MS + 1)).toBe(false);
    expect(calls).toHaveLength(1);
    setHerdrCapture(() => '{"error":{"code":"pane_not_found"}}');
    expect(await reportDisplayAgentAsync('p1', 'label', 'synthetic-session', DEFAULT_SIDEBAR_TTL_MS)).toBe(false);
    setHerdrCapture(() => null);
    expect(await reportDisplayAgentAsync('p1', 'label', 'synthetic-session', DEFAULT_SIDEBAR_TTL_MS)).toBe(false);
  });

  test('uses one session snapshot across seats and preserves the different-live-display guard', async () => {
    const { home, root } = makeWorld();
    const route: ChoresChildRoute = { root, team: 'acme-app', session: 'acme-dev', teamFile: makeTeam() };
    let lists = 0;
    const reports: string[] = [];
    const pass = createSidebarPass(makeConfig(home, route), {
      readSeats: () => ({ lead: { stage: 'ready', pane: 'p1', workspace: 'w1' },
        'builder-1': { stage: 'ready', pane: 'p2', workspace: 'w2' } }),
      sessionPanes: async (session, options) => {
        expect(session).toBe('acme-dev'); expect(options.signal).toBeDefined(); expect(Number.isInteger(options.timeoutMs)).toBe(true); lists++;
        return [{ pane: 'p1', workspace: 'w1' }, { pane: 'p2', workspace: 'w2', displayAgent: 'other live value' }];
      },
      reportDisplayAsync: async (pane, _text, _session, _ttl, options) => {
        expect(options.timeoutMs).toBeLessThanOrEqual(openSlices.sliceMs); reports.push(pane); return true;
      },
    });
    const notes = await pass({ route, at: new Date(NOW), slices: openSlices });
    expect(lists).toBe(1); expect(reports).toEqual(['p1']);
    expect(notes[0]).toContain('differs from declared');
  });

  test('skips an unresponsive session at the existing slice deadline and aborts its read', async () => {
    const { home, root } = makeWorld();
    const route: ChoresChildRoute = { root, team: 'acme-app', session: 'acme-dev', teamFile: makeTeam() };
    let signal: AbortSignal | undefined;
    let reports = 0;
    const config = makeConfig(home, route);
    // Use this fixture's existing heartbeat interval as its display slice; no new timeout policy.
    const slices = { ...openSlices, sliceMs: config.beatMs };
    const pass = createSidebarPass(config, {
      readSeats: () => ({ lead: { stage: 'ready', pane: 'p1', workspace: 'w1' } }),
      sessionPanes: async (_session, options) => { signal = options.signal; return await new Promise(() => {}); },
      reportDisplayAsync: async () => { reports++; return true; },
    });
    const notes = await pass({ route, at: new Date(NOW), slices });
    expect(signal?.aborted).toBe(true); expect(reports).toBe(0);
    expect(notes).toEqual(['sidebar refresh: skipped; the terminal host did not answer within the display slice (next try in 30 s, backing off)']);
  });

  test('backs off while the terminal host does not answer, quietly, and resumes once it does', async () => {
    const { home, root } = makeWorld();
    const route: ChoresChildRoute = { root, team: 'acme-app', session: 'acme-dev', teamFile: makeTeam() };
    let answering = false;
    let asked = 0;
    const config = makeConfig(home, route);
    const slices = { ...openSlices, sliceMs: config.beatMs };
    const pass = createSidebarPass(config, {
      readSeats: () => ({ lead: { stage: 'ready', pane: 'p1', workspace: 'w1' } }),
      sessionPanes: async () => { asked++; return answering ? [] : null; },
      reportDisplayAsync: async () => true,
    });
    const at = (ms: number) => ({ route, at: new Date(NOW + ms), slices });
    expect((await pass(at(0)))[0]).toContain('backing off');
    // Inside the 30 s wait nothing is asked; the second miss doubles the wait and says nothing.
    expect(await pass(at(10_000))).toEqual([]);
    expect(asked).toBe(1);
    expect(await pass(at(31_000))).toEqual([]);
    expect(asked).toBe(2);
    expect(await pass(at(60_000))).toEqual([]);
    expect(asked).toBe(2);
    // The host answers after the 60 s wait: the refresh runs again and the backoff is cleared.
    answering = true;
    await pass(at(92_000));
    expect(asked).toBe(3);
  });

  test('skips remaining reports when the existing display slice is spent', async () => {
    const { home, root } = makeWorld();
    const route: ChoresChildRoute = { root, team: 'acme-app', session: 'acme-dev', teamFile: makeTeam() };
    let clock = NOW;
    const reported: string[] = [];
    const pass = createSidebarPass(makeConfig(home, route), {
      clock: () => clock,
      readSeats: () => ({ lead: { stage: 'ready', pane: 'p1' }, 'builder-1': { stage: 'ready', pane: 'p2' } }),
      sessionPanes: async () => [{ pane: 'p1', workspace: 'w1' }, { pane: 'p2', workspace: 'w2' }],
      reportDisplayAsync: async (pane) => { reported.push(pane); clock += openSlices.sliceMs; return true; },
    });
    await pass({ route, at: new Date(NOW), slices: openSlices });
    expect(reported).toEqual(['p1']);
  });

  test('defers labels until the first watch cycle and a slow display cannot hold later cycles', async () => {
    const { home, root } = makeWorld();
    const route: ChoresChildRoute = { root, team: 'acme-app', session: 'acme-dev', teamFile: makeTeam(),
      watch: { teamFile: join(root, '.agents', 'team.yaml'), presence: false } };
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const messages: ChoresChildMessage[] = [];
    stdout.setEncoding('utf8'); stdout.on('data', (chunk: string) => {
      for (const line of chunk.trim().split('\n')) if (line) messages.push(JSON.parse(line));
    });
    let cycles!: () => void; let displays = 0; let release!: () => void;
    const pending = new Promise<string[]>((resolve) => { release = () => resolve([]); });
    const served = serveChoresChild({ config: makeConfig(home, route), stdin, stdout,
      pass: async () => [], sidebar: async () => { displays++; return pending; },
      watchFactory: (input) => {
        cycles = () => input.cycle?.(root, new Date(NOW));
        return { beat() {}, fault() {}, stop: async () => {} };
      },
    });
    const until = async (predicate: () => boolean) => {
      // Existing sidebar fixture wait bound and polling seam (the child-frame scene above).
      const deadline = Date.now() + 5_000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    try {
      stdin.write(JSON.stringify({ type: 'tick', id: 'first', at: AT }) + '\n');
      await until(() => messages.some((m) => m.type === 'pass'));
      expect(displays).toBe(0);
      cycles();
      stdin.write(JSON.stringify({ type: 'tick', id: 'second', at: AT }) + '\n');
      await until(() => displays === 1);
      cycles();
      expect(messages.filter((m) => m.type === 'watch-cycle')).toHaveLength(2);
    } finally { release(); stdin.write(JSON.stringify({ type: 'stop', why: 'done' }) + '\n'); await served; }
  });

  test('the awaited process helper force-ends a process that handles the default termination signal', async () => {
    // Existing production child-read bound, exercised with a synthetic process (no host/pane).
    await expect(execText(process.execPath, ['-e',
      'process.on("SIGTERM",()=>{});setInterval(()=>{},' + DEFAULT_CHILD_TIMEOUT_MS + ')'], { timeoutMs: DEFAULT_CHILD_TIMEOUT_MS })).rejects.toMatchObject({ killed: true, signal: 'SIGKILL' });
  }, DEFAULT_CHILD_TIMEOUT_MS + DEFAULT_CHILD_TIMEOUT_MS);
});
