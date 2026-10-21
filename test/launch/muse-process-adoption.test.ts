// Independent coverage for the shipped process reading that names a pane herdr has not listed
// as an agent yet (fix eb6020df, in main since 0.5.3). Authored from the contract — the rename
// op (src/launch/plan.ts), the host readings and wait in src/launch/execute.ts, the Muse profile
// (src/profiles/muse.yaml) and the name matcher (src/clis.ts) — not from a builder test or the
// historical #557 cases. The scenes supply synthetic live readings: a pane herdr lists or does
// not list, a foreground argv0 list an owner CLI would show, and the rename call. No owner CLI
// home, session or live pane is touched.
//
// The Muse profile records that `~/.local/bin/muse` is a wrapper that execs
// `muse-bin-<version>-<build>`, and that herdr reported the 15-byte cut name `muse-bin-1.4.9-`:
// the profile carries both `muse` and the prefix `muse-bin-*`, which covers later releases
// (src/profiles/muse.yaml, src/clis.ts).
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import { upPlan, type Op, type Step } from '../../src/launch/plan.ts';

const SESSION = 'acme';
const PANE = 'w1:p1';
const SEAT = 'muse-acme';
const RULES_PATH = '/home/owner/.config/team/acme/rules/muse-acme.md';

type RenameOp = Extract<Op, { do: 'rename' }>;
type RenameStep = Step & { do: RenameOp };
type RecordPatch = Parameters<Host['record']>[1];

/** The pane the Muse seat's own up plan names: the op carries the seat's CLI (so the rename
 *  reads that profile's process names) and the profile's first-message rules and idle timeout. */
function plannedRename(): RenameStep {
  const plan = upPlan({
    root: '.',
    session: SESSION,
    sessionRunning: true,
    watchAlive: true,
    watchLabel: 'Watch · acme',
    seats: [
      {
        name: SEAT,
        cli: 'muse',
        launch: 'muse --model muse-wonder-1.0',
        cwd: '.',
        label: 'muse-acme · implementer',
        stopped: false,
        rules: 'Rules.',
        rulesFile: {
          path: RULES_PATH,
          line: `Read ${RULES_PATH} (sha256 0123456789ab): your standing rules.`,
        },
        repairLine: '`team remove muse-acme --keep` then `team add muse-acme`',
      },
    ],
  });
  const found = plan.find((item) => item.do?.do === 'rename');
  if (!found || found.do?.do !== 'rename') throw new Error('the muse plan names no pane');
  return found as RenameStep;
}

type Readings = {
  /** The panes herdr lists as agents. Null: the list cannot be read. */
  listed: string[] | null;
  /** The pane's foreground argv0 names. Null: the pane cannot be read; absent: a host that
   *  predates the process reading. */
  foreground?: string[] | null;
  /** A rename the live command refuses. */
  renameFails?: boolean;
};

/** A host whose only live source is the scene's synthetic readings; every act is recorded. */
function scene(readings: Readings) {
  let clock = 0;
  const calls = {
    renames: [] as { pane: string; name: string }[],
    records: [] as { seat: string; patch: RecordPatch }[],
    drops: [] as string[],
    said: [] as string[],
    logs: [] as { who: string; what: string }[],
    typed: [] as string[],
    sleeps: [] as number[],
    agentReads: 0,
    foregroundReads: 0,
  };
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: 'w1' }),
    paneRun: () => true,
    typeLine: (_session, _pane, text) => {
      calls.typed.push(text);
      return false;
    },
    renameAgent: (_session, pane, name) => {
      calls.renames.push({ pane, name });
      return readings.renameFails !== true;
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => {
      calls.agentReads += 1;
      return readings.listed === null ? null : [...readings.listed];
    },
    classify: () => 'idle',
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    allow: () => null,
    record: (seat, patch) => {
      calls.records.push({ seat, patch });
    },
    running: () => {},
    drop: (seat) => {
      calls.drops.push(seat);
    },
    say: (line) => {
      calls.said.push(line);
    },
    log: (who, what) => {
      calls.logs.push({ who, what });
    },
    ...(readings.foreground === undefined
      ? {}
      : {
          foreground: () => {
            calls.foregroundReads += 1;
            return readings.foreground ?? null;
          },
        }),
  };
  return { host, calls, clock: () => clock };
}

/** Runs the Muse plan's rename step against the scene's readings. The plan leaves the pane to
 *  the create step at execution; the scene names it as the create step would have. */
async function namePane(readings: Readings) {
  const made = scene(readings);
  const step = plannedRename();
  const only: Step = { ...step, do: { ...step.do, pane: PANE } };
  const report = await executePlan([only], SESSION, made.host);
  return { ...made, report };
}

describe('the plan registers the Muse CLI on the rename', () => {
  test('the rename op carries muse, the profile first-message rules and the 90 s idle timeout', () => {
    const step = plannedRename();
    expect(step.do.cli).toBe('muse');
    expect(step.do.rules).toBe('message');
    expect(step.do.seconds).toBe(90);
  });
});

describe('a Muse pane herdr has not listed is named by its process', () => {
  const matched: { what: string; foreground: string[] }[] = [
    { what: 'the wrapper itself', foreground: ['muse'] },
    { what: 'the 15-byte cut name', foreground: ['muse-bin-1.4.9-'] },
    { what: 'a later release', foreground: ['muse-bin-1.4.10'] },
    { what: 'the cut name beside its shell', foreground: ['zsh', 'muse-bin-1.4.9-'] },
  ];
  test.each(matched)('$what: named at once, before the first poll slept', async ({ foreground }) => {
    const made = await namePane({ listed: [], foreground });
    expect(made.calls.renames).toEqual([{ pane: PANE, name: SEAT }]);
    expect(made.calls.foregroundReads).toBeGreaterThan(0);
    // The old wait slept on the agent list alone: the first poll would put the clock at 2 s.
    expect(made.calls.sleeps).toEqual([]);
    expect(made.clock()).toBe(0);
    expect(made.calls.records).toEqual([{ seat: SEAT, patch: { stage: 'named', pane: PANE } }]);
    expect(made.report.dropped).toEqual([]);
    // Naming never types into the pane; the first-message rules step is a later step.
    expect(made.calls.typed).toEqual([]);
    expect(made.calls.logs).toEqual([]);
  });

  test('an unreadable agent list is read by the pane process too', async () => {
    const made = await namePane({ listed: null, foreground: ['muse-bin-1.4.9-'] });
    expect(made.calls.renames).toEqual([{ pane: PANE, name: SEAT }]);
    expect(made.calls.sleeps).toEqual([]);
    expect(made.calls.records).toEqual([{ seat: SEAT, patch: { stage: 'named', pane: PANE } }]);
  });
});

describe('a pane whose process is not the Muse CLI is left untouched', () => {
  const unmatched: { what: string; foreground?: string[] | null }[] = [
    { what: 'a shell', foreground: ['zsh'] },
    { what: 'a lookalike binary', foreground: ['muse-binary'] },
    { what: 'another binary with the word in it', foreground: ['amuse'] },
    { what: 'an unreadable pane', foreground: null },
    { what: 'a host with no process reading', foreground: undefined },
  ];
  test.each(unmatched)('$what: the wait runs out and nothing is renamed or typed', async ({ foreground }) => {
    const made = await namePane({ listed: [], foreground });
    expect(made.calls.renames).toEqual([]);
    expect(made.report.dropped).toEqual([SEAT]);
    // One poll every 2 s for the profile's 90 s timeout: 45 sleeps, the clock at 90 s.
    expect(made.calls.sleeps).toHaveLength(45);
    expect(made.calls.sleeps.every((ms) => ms === 2000)).toBe(true);
    expect(made.clock()).toBe(90_000);
    expect(made.calls.records).toEqual([]);
    expect(made.calls.typed).toEqual([]);
    expect(made.calls.said.join('')).toContain(
      `${SEAT}: left out: was not in the agent list in time; left at launched\n`,
    );
  });
});

describe('the listed-agent path is unchanged', () => {
  const listed: { what: string; foreground?: string[] | null }[] = [
    { what: 'a shell in front', foreground: ['zsh'] },
    { what: 'an unreadable process', foreground: null },
    { what: 'a host with no process reading', foreground: undefined },
  ];
  test.each(listed)('$what: named at once from the agent list alone', async ({ foreground }) => {
    const made = await namePane({ listed: [PANE], foreground });
    expect(made.calls.renames).toEqual([{ pane: PANE, name: SEAT }]);
    expect(made.calls.sleeps).toEqual([]);
    expect(made.calls.records).toEqual([{ seat: SEAT, patch: { stage: 'named', pane: PANE } }]);
    expect(made.report.dropped).toEqual([]);
    expect(made.calls.typed).toEqual([]);
    // The agent list stays the first reading: the process is not read when the list has the pane.
    expect(made.calls.agentReads).toBeGreaterThan(0);
    expect(made.calls.foregroundReads).toBe(0);
  });
});

describe('a rename that fails after the pane was found', () => {
  test('leaves the seat at launched with its own words, and records no name', async () => {
    const made = await namePane({ listed: [PANE], foreground: ['zsh'], renameFails: true });
    expect(made.calls.renames).toEqual([{ pane: PANE, name: SEAT }]);
    expect(made.report.dropped).toEqual([SEAT]);
    expect(made.calls.records).toEqual([]);
    expect(made.calls.typed).toEqual([]);
    expect(made.calls.said.join('')).toContain(
      `${SEAT}: left out: was not named in time; left at launched\n`,
    );
  });
});
