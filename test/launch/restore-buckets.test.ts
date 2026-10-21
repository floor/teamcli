import { describe, expect, test } from 'bun:test';
import {
  executePlan,
  restoreSummaryOf,
  type Host,
  type Report,
  type SeatRestoreBucket,
} from '../../src/launch/execute.ts';
import type { Step, UpSeat } from '../../src/launch/plan.ts';
import { progressWriter, type ProgressSink } from '../../src/launch/progress.ts';

function sink(): { out: string[]; err: string[]; sink: ProgressSink } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY: false } };
}

/** The smallest host the plan-record and repair paths read: a world where nothing exists and
 *  every act succeeds, with the readings a scene cares about passed in. */
function hostWith(overrides: Partial<Host> = {}): Host {
  let t = 0;
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'ws' }),
    paneRun: () => true,
    typeLine: () => true,
    deliverRules: async () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [],
    classify: () => 'idle',
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
    progress: () => {},
    final: () => {},
    detail: () => {},
    ...overrides,
  };
}

function seat(name: string, extra: Partial<UpSeat> = {}): UpSeat {
  return {
    name,
    cli: 'claude-code',
    launch: 'claude',
    cwd: '.',
    label: name,
    repairLine: `\`team remove ${name} --keep\` then \`team add ${name}\``,
    stopped: false,
    rules: '',
    ...extra,
  };
}

const launched = { shell: 700, cli: [701] };

/** A ready record the plan wrote for a seat it left as it is. */
function readyRecord(name: string, extra: Partial<Extract<Step['do'], { do: 'record' }>> = {}): Step {
  return {
    kind: 'skip',
    text: `${name}: ready`,
    do: { do: 'record', seat: name, record: { kind: 'ready' }, ...extra },
  };
}

async function bucketsOf(seats: readonly UpSeat[], steps: readonly Step[], overrides: Partial<Host> = {}): Promise<Report> {
  const { sink: s } = sink();
  const records = progressWriter(s);
  return executePlan(steps, 'acme', hostWith({
    progress: (who, state) => records.progress(who, state),
    final: (who, record) => records.final(who, record),
    detail: (line) => records.detail(line),
    ...overrides,
  }), { restoreSeats: seats });
}

describe('restoreSummaryOf', () => {
  const bucket = (outcome: SeatRestoreBucket['outcome'], name: string): SeatRestoreBucket =>
    outcome === 'refused'
      ? { seat: name, outcome, reason: 'its model drifted; lead seat is not cycled in place (team down, then team up)' }
      : outcome === 'skipped_working'
        ? { seat: name, outcome, detail: 'its model drifted; left as it is (team remove a --abandon)' }
        : { seat: name, outcome };

  test('a sweep with nothing to do still says so', () => {
    const summary = restoreSummaryOf([]);
    expect(summary.line).toBe('0 seats repaired, 0 skipped (working), 0 refused');
    expect(summary.repaired).toBe(0);
    expect(summary.skipped_working).toBe(0);
    expect(summary.refused).toBe(0);
    expect(summary.repaired_seats).toEqual([]);
    expect(summary.refused_seats).toEqual([]);
  });

  test('counts one seat in the singular', () => {
    const summary = restoreSummaryOf([bucket('repaired', 'a')]);
    expect(summary.line).toBe('1 seat repaired, 0 skipped (working), 0 refused');
    expect(summary.repaired_seats).toEqual(['a']);
  });

  test('names every refused seat with the reason it was refused in', () => {
    const summary = restoreSummaryOf([
      bucket('repaired', 'a'),
      bucket('skipped_working', 'b'),
      bucket('refused', 'orchestrator'),
    ]);
    expect(summary.line).toBe(
      '1 seat repaired, 1 skipped (working), 1 refused (orchestrator: its model drifted; lead seat is not cycled in place (team down, then team up))',
    );
    expect(summary.refused_seats).toEqual([
      { seat: 'orchestrator', reason: 'its model drifted; lead seat is not cycled in place (team down, then team up)' },
    ]);
  });
});

describe('restore buckets', () => {
  test('a repair that finishes ready is repaired; the seat is counted only at finishReady', async () => {
    const report = await bucketsOf(
      [seat('a', { repair: { pane: 'p1', workspace: 'ws', launched, cli: 'claude-code' } })],
      [{ kind: 'skip', text: 'a: ready', do: { do: 'ready', seat: 'a', rules: 'option' } }],
    );
    expect(report.restoreBuckets).toEqual([{ seat: 'a', outcome: 'repaired' }]);
    expect(report.held).toBe(false);
  });

  test('a seated held for working is skipped, not refused, and the run exits clean', async () => {
    const report = await bucketsOf(
      [seat('a', { driftHold: 'its model drifted; left as it is (team remove a --abandon)' })],
      [readyRecord('a', { detail: '  its model drifted; left as it is (team remove a --abandon)\n' })],
    );
    expect(report.restoreBuckets).toEqual([
      { seat: 'a', outcome: 'skipped_working', detail: 'its model drifted; left as it is (team remove a --abandon)' },
    ]);
    expect(report.held).toBe(false);
  });

  test('a pre-close re-read that finds the pane working skips the seat and closes nothing', async () => {
    const report = await bucketsOf(
      [seat('a', { repair: { pane: 'p1', workspace: 'ws', launched, cli: 'claude-code' } })],
      [{
        kind: 'run',
        argv: [],
        do: { do: 'repair', seat: 'a', cli: 'claude-code', pane: 'p1', workspace: 'ws', launched },
      }],
      {
        agentList: () => [{ name: 'a', agent: null, pane: 'p1', workspace: 'ws', status: 'idle', cwd: null }],
        workspacePanes: () => ['p1'],
        // The recorded process is no longer the pane's: a program is in front, and its screen
        // is working.
        processInfo: () => ({ shell: 700, foreground: [900] }),
        classify: () => 'working',
      },
    );
    expect(report.restoreBuckets).toEqual([
      {
        seat: 'a',
        outcome: 'skipped_working',
        detail: 'the process in its pane is working; nothing closed (stop it there, or run team remove a)',
      },
    ]);
    expect(report.held).toBe(false);
  });

  test('a repair whose pane cannot be read is refused with the record’s own words', async () => {
    const report = await bucketsOf(
      [seat('a', { repair: { pane: 'p1', workspace: 'ws', launched, cli: 'claude-code' } })],
      [{
        kind: 'run',
        argv: [],
        do: { do: 'repair', seat: 'a', cli: 'claude-code', pane: 'p1', workspace: 'ws', launched },
      }],
      {
        agentList: () => [{ name: 'a', agent: null, pane: 'p1', workspace: 'ws', status: 'idle', cwd: null }],
        workspacePanes: () => ['p1'],
        processInfo: () => null,
      },
    );
    expect(report.restoreBuckets).toEqual([
      { seat: 'a', outcome: 'refused', reason: 'its pane could not be read; nothing closed' },
    ]);
    expect(report.held).toBe(true);
  });

  test('a repair the close proves was already the seat’s is a survivor, counted nowhere', async () => {
    const report = await bucketsOf(
      [seat('a', { repair: { pane: 'p1', workspace: 'ws', launched, cli: 'claude-code' } })],
      [{
        kind: 'run',
        argv: [],
        do: { do: 'repair', seat: 'a', cli: 'claude-code', pane: 'p1', workspace: 'ws', launched },
      }],
      {
        agentList: () => [{ name: 'a', agent: null, pane: 'p1', workspace: 'ws', status: 'idle', cwd: null }],
        workspacePanes: () => ['p1'],
        processInfo: () => ({ shell: 700, foreground: [701] }),
      },
    );
    expect(report.restoreBuckets).toEqual([]);
    expect(report.dropped).toEqual(['a']);
  });

  test('plan-level refusals keep their own reason, and a proven restore counts nowhere', async () => {
    const report = await bucketsOf(
      [
        seat('lead', { driftRefused: 'its model drifted; lead seat is not cycled in place (team down, then team up)' }),
        seat('waiting', { resumeHold: 'its recorded conversation cannot be resumed: its launch line resumes a different conversation; left as it is' }),
        seat('gone', { launchProblem: 'the program is not there' }),
        seat('kept', { restored: { launched, session: 'ses-1', detail: 'restored; left as it is' } }),
      ],
      [
        readyRecord('lead', { held: true }),
        readyRecord('waiting', { held: true }),
        { kind: 'skip', text: 'gone: would refuse', do: { do: 'refuse', seat: 'gone', why: 'the program is not there' } },
        readyRecord('kept', { launched, agentSession: 'ses-1' }),
      ],
    );
    expect(report.restoreBuckets).toEqual([
      { seat: 'lead', outcome: 'refused', reason: 'its model drifted; lead seat is not cycled in place (team down, then team up)' },
      {
        seat: 'waiting',
        outcome: 'refused',
        reason: 'its recorded conversation cannot be resumed: its launch line resumes a different conversation; left as it is',
      },
      { seat: 'gone', outcome: 'refused', reason: 'refused: the program is not there' },
    ]);
  });

  test('a stopped or human seat, and a granted run’s own seat, are not the sweep’s outcomes', async () => {
    const report = await bucketsOf(
      [seat('down', { stopped: true }), seat('human', { human: true }), seat('granted', { grantKeep: 'left as it is' })],
      [],
    );
    expect(report.restoreBuckets).toEqual([]);
  });

  test('a seat this run never settled is refused rather than silently counted out', async () => {
    const report = await bucketsOf([seat('lost', { repair: { pane: 'p1', workspace: 'ws', launched, cli: 'claude-code' } })], []);
    expect(report.restoreBuckets).toEqual([{ seat: 'lost', outcome: 'refused', reason: 'left out' }]);
  });
});
