import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callerOf,
  callerStanding,
  callerVerdict,
  judgeCallerOf,
  placeCaller,
  standingOf,
  walkCaller,
  type CallerSources,
  type Process,
} from '../src/caller.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-12T20:00:00Z');
const SEAT = 'claude-coordinator-acme';

function fakeAgent(name: string | null, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? 'ws2', status: 'idle', cwd: null };
}

// Handoff process chain: the pane root shell (pid 1400) was re-parented to pid 1 (launchd/init)
// when the previous herdr server exited during `herdr update --handoff`. No `herdr` process
// appears anywhere in the ancestor chain.
const HANDOFF_SEAT_CHAIN: Process[] = [
  { pid: 1420, name: 'bun' },
  { pid: 1410, name: 'claude' },
  { pid: 1400, name: 'zsh' },
  { pid: 1, name: 'launchd' },
];

// Handoff process chain for an agentless shell pane (no agent CLI in ancestors, parented to pid 1).
const HANDOFF_SHELL_CHAIN: Process[] = [
  { pid: 1510, name: 'zsh' },
  { pid: 1, name: 'launchd' },
];

// Classic process chain with `herdr` above the pane root shell.
const CLASSIC_SEAT_CHAIN: Process[] = [
  { pid: 2420, name: 'claude' },
  { pid: 2400, name: 'zsh' },
  { pid: 2000, name: 'herdr' },
  { pid: 1, name: 'launchd' },
];

function makeHandoffSources(overrides: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => HANDOFF_SEAT_CHAIN,
    agents: () => [
      fakeAgent('codex-builder-acme', 'pane3'),
      fakeAgent(SEAT, 'pane2'),
    ],
    paneRootPid: (pane) => {
      if (pane === 'pane2') return 1400;
      if (pane === 'pane3') return 1900;
      return null;
    },
    env: { HERDR_PANE_ID: 'pane2' },
    stdinIsTTY: false,
    ...overrides,
  };
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeProjectDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-caller-handoff-ind-')));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents', 'team.yaml'), example);
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: 'pane2', workspace: 'ws2' };
  });
  return dir;
}

describe('live handoff caller placement (independent verification)', () => {
  test('(a) handoff seat: parented to pid 1 with no herdr ancestor, admitted when server root pid for HERDR_PANE_ID is in ancestors', () => {
    const rootQueries: string[] = [];
    const src = makeHandoffSources({
      paneRootPid: (pane) => {
        rootQueries.push(pane);
        return pane === 'pane2' ? 1400 : null;
      },
    });

    const withSession = placeCaller(src, 'acme-web');
    expect(withSession).toEqual({
      kind: 'seat',
      name: SEAT,
      pane: 'pane2',
      session: 'acme-web',
    });
    // The hinted pane's root pid is queried once per placement (reused across the gate and loop).
    expect(rootQueries).toEqual(['pane2']);

    rootQueries.length = 0;
    const withoutSession = placeCaller(src);
    expect(withoutSession).toEqual({
      kind: 'seat',
      name: SEAT,
      pane: 'pane2',
    });
    expect(rootQueries).toEqual(['pane2']);

    // Standing check admits the placed handoff seat against the recorded state pane.
    const dir = makeProjectDir();
    const standing = standingOf(join(dir, '.agents'), 'acme-web', withSession);
    expect(callerVerdict(withSession, SEAT, standing)).toEqual({ kind: 'ok' });
    expect(callerStanding(withSession, SEAT, standing)).toBe(true);
  });

  test('(a) handoff agentless pane: parented to pid 1 with no herdr or agent CLI ancestor, placed as pane (never owner)', () => {
    const rootQueries: string[] = [];
    const src = makeHandoffSources({
      ancestors: () => HANDOFF_SHELL_CHAIN,
      agents: () => [fakeAgent(SEAT, 'pane2')],
      paneRootPid: (pane) => {
        rootQueries.push(pane);
        if (pane === 'pane9') return 1510;
        if (pane === 'pane2') return 1400;
        return null;
      },
      env: { HERDR_PANE_ID: 'pane9' },
      stdinIsTTY: true,
    });

    expect(placeCaller(src, 'acme-web')).toEqual({
      kind: 'pane',
      pane: 'pane9',
      session: 'acme-web',
    });
    expect(placeCaller(src)).toEqual({
      kind: 'pane',
      pane: 'pane9',
    });
    // Each call checks pane9 once at the handoff gate, then pane2 for the listed agent, and reuses pane9 for the pane fallback.
    expect(rootQueries).toEqual(['pane9', 'pane2', 'pane9', 'pane2']);

    // And an agent entry on the hinted pane with an empty name stays unplaced (`has no herdr name`).
    const unnamed = makeHandoffSources({
      agents: () => [fakeAgent('', 'pane2')],
    });
    expect(placeCaller(unnamed, 'acme-web')).toEqual({
      kind: 'unplaced',
      reason: 'it runs in pane pane2, whose agent has no herdr name',
    });
  });

  test('(b) unknown pane id on server: refused as detached without querying agents list', () => {
    let agentsCalled = false;
    const src = makeHandoffSources({
      env: { HERDR_PANE_ID: 'pane99' },
      paneRootPid: () => null,
      agents: () => {
        agentsCalled = true;
        return [fakeAgent(SEAT, 'pane99')];
      },
    });

    const placed = placeCaller(src, 'acme-web');
    expect(placed).toEqual({
      kind: 'unplaced',
      reason:
        'it is run by an agent (claude) outside herdr: its environment names pane pane99, but no herdr server is among its parent processes, so the agent was detached from that pane (for example a Claude Code background session); run the seat in its pane again (team restart <seat>)',
    });
    expect(agentsCalled).toBe(false);
  });

  test('(c) pane root pid is not an ancestor (detached background session or spoofed HERDR_PANE_ID): refused as detached', () => {
    let agentsCalled = false;
    // The server knows pane2 and reports root pid 9876, which is NOT in HANDOFF_SEAT_CHAIN ({1420, 1410, 1400, 1}).
    const detached = makeHandoffSources({
      paneRootPid: (pane) => (pane === 'pane2' ? 9876 : null),
      agents: () => {
        agentsCalled = true;
        return [fakeAgent(SEAT, 'pane2')];
      },
    });

    expect(placeCaller(detached, 'acme-web')).toEqual({
      kind: 'unplaced',
      reason:
        'it is run by an agent (claude) outside herdr: its environment names pane pane2, but no herdr server is among its parent processes, so the agent was detached from that pane (for example a Claude Code background session); run the seat in its pane again (team restart <seat>)',
    });
    expect(agentsCalled).toBe(false);

    // Without HERDR_PANE_ID (or with empty HERDR_PANE_ID), paneRootPid is never called and agent outside herdr is refused.
    let paneRootCalled = false;
    const noHint = makeHandoffSources({
      env: {},
      paneRootPid: () => {
        paneRootCalled = true;
        return 1400;
      },
    });
    expect(placeCaller(noHint, 'acme-web')).toEqual({
      kind: 'unplaced',
      reason: 'it is run by an agent (claude) outside herdr',
    });
    expect(paneRootCalled).toBe(false);

    const emptyHint = makeHandoffSources({
      env: { HERDR_PANE_ID: '' },
      paneRootPid: () => {
        paneRootCalled = true;
        return 1400;
      },
    });
    expect(placeCaller(emptyHint, 'acme-web')).toEqual({
      kind: 'unplaced',
      reason: 'it is run by an agent (claude) outside herdr',
    });
    expect(paneRootCalled).toBe(false);
  });

  test('(d) server read fails: null paneRootPid or null agents() after root pid match keeps the pre-fix detached refusal', () => {
    // 1. Both paneRootPid and agents fail (server down / unreachable).
    const bothNull = makeHandoffSources({
      paneRootPid: () => null,
      agents: () => null,
    });
    expect(placeCaller(bothNull, 'acme-web')).toMatchObject({
      kind: 'unplaced',
      reason: expect.stringMatching(/detached from that pane/),
    });

    // 2. paneRootPid succeeds and matches ancestor 1400, but subsequent agents() read returns null:
    // keeps the pre-fix detached refusal rather than inventing a new refusal.
    const agentsNull = makeHandoffSources({
      paneRootPid: (pane) => (pane === 'pane2' ? 1400 : null),
      agents: () => null,
    });
    expect(placeCaller(agentsNull, 'acme-web')).toMatchObject({
      kind: 'unplaced',
      reason: expect.stringMatching(/detached from that pane/),
    });

    // 3. Ancestor walk fails (returns null or empty): refuses immediately without querying paneRootPid.
    let queriedPane = false;
    const brokenAncestors = makeHandoffSources({
      ancestors: () => null,
      paneRootPid: () => {
        queriedPane = true;
        return 1400;
      },
    });
    expect(placeCaller(brokenAncestors, 'acme-web')).toEqual({
      kind: 'unplaced',
      reason: "its parent processes can't be read to the top",
    });
    expect(queriedPane).toBe(false);
  });

  test('(e) classic path with a herdr ancestor is unchanged and does not pre-read paneRootPid before agents()', () => {
    const events: string[] = [];
    const classic = makeHandoffSources({
      ancestors: () => CLASSIC_SEAT_CHAIN,
      agents: () => {
        events.push('agents');
        return [
          fakeAgent('codex-builder-acme', 'pane3'),
          fakeAgent(SEAT, 'pane2'),
        ];
      },
      paneRootPid: (pane) => {
        events.push(`pane:${pane}`);
        if (pane === 'pane2') return 2400;
        if (pane === 'pane3') return 2900;
        return null;
      },
      env: { HERDR_PANE_ID: 'pane2' },
    });

    expect(placeCaller(classic, 'acme-web')).toEqual({
      kind: 'seat',
      name: SEAT,
      pane: 'pane2',
      session: 'acme-web',
    });
    // Under classic herdr, `agents()` runs first, then `HERDR_PANE_ID` orders pane2 first.
    expect(events).toEqual(['agents', 'pane:pane2']);

    // If agents() returns null under classic herdr, paneRootPid is never called.
    const eventsOnDown: string[] = [];
    const classicDown = makeHandoffSources({
      ancestors: () => CLASSIC_SEAT_CHAIN,
      agents: () => {
        eventsOnDown.push('agents');
        return null;
      },
      paneRootPid: (pane) => {
        eventsOnDown.push(`pane:${pane}`);
        return 2400;
      },
    });
    expect(placeCaller(classicDown, 'acme-web')).toEqual({
      kind: 'unplaced',
      reason: "it runs under herdr, and herdr doesn't answer",
    });
    expect(eventsOnDown).toEqual(['agents']);
  });

  test('session scoping & status command gate: reads only the target session server and admits handoff seat in runStatus', async () => {
    const dir = makeProjectDir();
    const sessionsQueried: Array<{ session: string | undefined; op: string }> = [];

    const io = testIo(dir);
    io.callerSources = (session) => ({
      ancestors: () => HANDOFF_SEAT_CHAIN,
      agents: () => {
        sessionsQueried.push({ session, op: 'agents' });
        if (session === 'acme-web' || session === undefined) {
          return [fakeAgent(SEAT, 'pane2')];
        }
        return [];
      },
      paneRootPid: (pane) => {
        sessionsQueried.push({ session, op: `paneRootPid:${pane}` });
        if ((session === 'acme-web' || session === undefined) && pane === 'pane2') {
          return 1400;
        }
        return null;
      },
      env: { HERDR_PANE_ID: 'pane2' },
      stdinIsTTY: false,
    });

    // 1. Direct callerOf(io, 'acme-web') queries only 'acme-web'
    expect(callerOf(io, 'acme-web')).toEqual({
      kind: 'seat',
      name: SEAT,
      pane: 'pane2',
      session: 'acme-web',
    });
    expect(sessionsQueried).toEqual([
      { session: 'acme-web', op: 'paneRootPid:pane2' },
      { session: 'acme-web', op: 'agents' },
    ]);

    // 2. Querying a foreign session ('other-session') reads only 'other-session' and refuses placement there,
    // while judgeCallerOf falls back to `callerOf(io)` (session === undefined) for `shown`.
    sessionsQueried.length = 0;
    const judgedForeign = judgeCallerOf(io, 'other-session');
    expect(judgedForeign.caller).toMatchObject({
      kind: 'unplaced',
      reason: expect.stringMatching(/detached from that pane/),
    });
    expect(judgedForeign.shown).toEqual({
      kind: 'seat',
      name: SEAT,
      pane: 'pane2',
    });
    expect(sessionsQueried).toEqual([
      { session: 'other-session', op: 'paneRootPid:pane2' },
      { session: undefined, op: 'paneRootPid:pane2' },
      { session: undefined, op: 'agents' },
    ]);

    // 3. walkCaller queries paneRootPid once for the hinted pane (session: undefined) to prove live
    // handoff under herdr, and never queries agents.
    sessionsQueried.length = 0;
    const walked = walkCaller(io);
    expect(walked).toEqual({ kind: 'unplaced', reason: 'it runs under herdr' });
    expect(sessionsQueried).toEqual([{ session: undefined, op: 'paneRootPid:pane2' }]);

    // 4. End-to-end `runStatus` admits the handoff seat on its recorded pane pane2.
    const statusSrc: StatusSources = {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => null,
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
      home: dir,
      gate: { standing: () => ({ kind: 'none' }), agents: () => [] },
    };
    const code = await runStatus([], io, statusSrc);
    expect(code).not.toBe(2);
    expect(io.err).not.toBe('team status: this team is not yours to read\n');
    expect(io.out).toContain('team acme-web, session "acme-web"');

    // 5. End-to-end `runStatus` refuses when server reports a non-ancestor root pid for pane2.
    const detachedIo = testIo(dir);
    detachedIo.callerSources = () =>
      makeHandoffSources({
        paneRootPid: () => 9999,
      });
    const refusedCode = await runStatus([], detachedIo, statusSrc);
    expect(refusedCode).toBe(2);
    expect(detachedIo.err).toBe('team status: this team is not yours to read\n');
    expect(detachedIo.out).toBe('');
  });
});
