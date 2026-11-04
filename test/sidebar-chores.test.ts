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
