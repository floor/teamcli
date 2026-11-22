// Restart paths seen on 2026-11-16, after the machine restarted. Synthetic frames and readings
// only: no CLI is started, no herdr session is touched.
//   1. Codex's "open in another app" notice stays the owner's: no key is sent for it, whatever
//      herdr lists (the idle wait in src/launch/execute.ts).
//   2. A Jules pane herdr does not list as an agent is declared one, then named, only when the
//      pane is proven this seat's (the naming step in src/launch/execute.ts).
//   3. A wait recorded at a provider error that the pane has since left: see
//      test/check-stuck-prompts.test.ts.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { SeatState } from '../../src/state.ts';

// The notice as codex-cli 0.167.0 draws it (the layout test/provider-error-gaps.test.ts keeps).
const LOCKED = [
  '■ This conversation is read-only or unavailable; no operation was sent.',
  '',
  '  🔒 This conversation is open in another app                                  r to retry',
  '     Close it there and press R to continue here.',
  '',
  '  r retry   f fork   ←/esc command center   ^c/q exit   ^t transcript',
].join('\n');

describe('Codex "open in another app" on a resume is left to the owner', () => {
  test('no key is sent, and the wait stops at the dialog, even with no herdr holder', async () => {
    const keys: string[] = [];
    const said: string[] = [];
    let clock = 0;
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'w27:p1', workspace: 'w27' }),
      paneRun: () => true,
      typeLine: () => { throw new Error('unexpected typing'); },
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => { throw new Error('unexpected process signal'); },
      agentPanes: () => ['w27:p1'],
      agentList: () => [],
      classify: () => 'provider error',
      paneText: () => LOCKED,
      foreground: () => ['codex'],
      sendKey: (_s, _p, key) => { keys.push(key); return true; },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (text) => { said.push(text); },
      log: () => {},
    };
    const steps: Step[] = [{
      kind: 'wait',
      text: 'until operator shows its idle prompt',
      do: {
        do: 'idle', seat: 'operator', label: 'operator', cli: 'codex', seconds: 5,
        command: 'codex resume 01a1c017-0000-7000-8000-000000000001', pane: 'w27:p1', workspace: 'w27',
        repairLine: 'synthetic repair',
      },
    }];
    await executePlan(steps, 'acme', host);
    expect(keys).toEqual([]);
    expect(said.join('')).toContain('provider error');
  });
});

type JulesScene = {
  foreground: string[];
  /** The agent list herdr gives the naming step; null: unreadable. Declared panes are added. */
  agents: HerdrAgent[] | null;
  /** The pane list the wait reads; null: unreadable. Defaults to the agent list's panes. */
  panes?: string[] | null;
  /** The session's seat records; null: unreadable; absent: a host with no record reading. */
  records?: Record<string, SeatState> | null;
  offerReport?: boolean;
};

const PANE = 'w4B:p1';
const SEAT = 'tester-1';

async function nameJules(scene: JulesScene) {
  let declared = false;
  let named = false;
  let clock = 0;
  const reports: { pane: string; agent: string }[] = [];
  const renames: string[] = [];
  const records: unknown[] = [];
  const listed = (): HerdrAgent[] | null => {
    if (scene.agents === null) return null;
    const ours: HerdrAgent[] = declared
      ? [{ name: named ? SEAT : null, agent: 'jules', pane: PANE, workspace: 'w4B', status: 'idle', cwd: null }]
      : [];
    return [...scene.agents, ...ours];
  };
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: 'w4B' }),
    paneRun: () => true,
    typeLine: () => { throw new Error('unexpected typing'); },
    renameAgent: (_s, pane, name) => {
      renames.push(`${pane}=${name}`);
      if (declared) named = true;
      return declared;
    },
    ...(scene.offerReport === false
      ? {}
      : {
          reportAgent: (_s: string, pane: string, agentName: string) => {
            reports.push({ pane, agent: agentName });
            declared = true;
            return true;
          },
        }),
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => { throw new Error('unexpected process signal'); },
    agentPanes: () => (scene.panes !== undefined ? scene.panes : (listed()?.map((one) => one.pane) ?? null)),
    agentList: () => listed(),
    ...(scene.records === undefined ? {} : { seatStates: () => scene.records ?? null }),
    classify: () => 'idle',
    foreground: () => scene.foreground,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    allow: () => null,
    record: (_seat, patch) => { records.push(patch); },
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
  };
  const steps: Step[] = [{
    kind: 'wait',
    text: `name ${SEAT}`,
    do: { do: 'rename', seat: SEAT, label: 'Tester · tester 1', cli: 'jules', seconds: 10, rules: 'option', pane: PANE },
  }];
  const report = await executePlan(steps, 'teamcli', host);
  return { reports, renames, records, report };
}

const OWN_RECORD: Record<string, SeatState> = { [SEAT]: { stage: 'launched', pane: PANE, workspace: 'w4B' } };

describe('a Jules pane herdr does not list is declared an agent only once proven this seat\'s', () => {
  test('readable lists, no other seat names the pane, jules in front: declared once, then named', async () => {
    const run = await nameJules({ foreground: ['bash', 'jules'], agents: [], records: OWN_RECORD });
    expect(run.reports).toEqual([{ pane: PANE, agent: 'jules' }]);
    expect(run.renames[0]).toBe(`${PANE}=${SEAT}`);
    expect(run.records).toContainEqual({ stage: 'named', pane: PANE });
    expect(run.report.dropped).toEqual([]);
  });

  test('another seat\'s record names the pane: nothing is declared or named', async () => {
    const run = await nameJules({
      foreground: ['jules'],
      agents: [],
      records: { ...OWN_RECORD, 'tester-2': { stage: 'ready', pane: PANE, workspace: 'w4B' } },
    });
    expect(run.reports).toEqual([]);
    expect(run.records).not.toContainEqual({ stage: 'named', pane: PANE });
    expect(run.report.dropped).toEqual([SEAT]);
  });

  test('the pane list is unreadable and the agent list names another seat there: no report, no rename', async () => {
    const run = await nameJules({
      foreground: ['jules'],
      panes: null,
      agents: [{ name: 'tester-2', agent: 'jules', pane: PANE, workspace: 'w4B', status: 'idle', cwd: null }],
      records: OWN_RECORD,
    });
    expect(run.reports).toEqual([]);
    expect(run.renames).toEqual([]);
    expect(run.report.dropped).toEqual([SEAT]);
  });

  test('an unreadable agent list or seat record is never absence: nothing is declared', async () => {
    const noList = await nameJules({ foreground: ['jules'], agents: null, panes: [], records: OWN_RECORD });
    expect(noList.reports).toEqual([]);
    const noRecords = await nameJules({ foreground: ['jules'], agents: [], records: null });
    expect(noRecords.reports).toEqual([]);
    const noReader = await nameJules({ foreground: ['jules'], agents: [] });
    expect(noReader.reports).toEqual([]);
  });

  test('a shell in front, or a host with no report: the old refusal stands', async () => {
    const shell = await nameJules({ foreground: ['zsh'], agents: [], records: OWN_RECORD });
    expect(shell.reports).toEqual([]);
    expect(shell.renames).toEqual([]);
    expect(shell.report.dropped).toEqual([SEAT]);
    const noReport = await nameJules({ foreground: ['jules'], agents: [], records: OWN_RECORD, offerReport: false });
    expect(noReport.reports).toEqual([]);
    expect(noReport.report.dropped).toEqual([SEAT]);
  });
});
