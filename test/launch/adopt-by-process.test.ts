// The naming step's second reading. herdr lists an agent only for a CLI whose process it knows:
// Muse execs `muse-bin-<version>-<build>`, so its pane is never in the agent list, and a seat
// waited on that list alone was left at launched — renamed never, rules never. The pane's own
// foreground process is what stands in: the same reading the rules delivery and the exit key
// already use (`reportedLiveAgent` over the profile's process names). These scenes run a muse
// seat's steps against a host whose agent list never names the pane, and pin the three answers:
// the CLI in the foreground is adopted, anything else is left out exactly as it was, and a host
// that reports no foregrounds keeps today's behaviour.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import { progressWriter, type ProgressSink } from '../../src/launch/progress.ts';

// The name herdr reported for a live Muse pane, captured in a scratch session: the pane's
// foreground argv0 is the binary itself, uncut, and only the process list names it.
const MUSE_ARGV0 = 'muse-bin-1.4.9-R6297.1';

function sink(): { out: string[]; err: string[]; sink: ProgressSink } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY: false } };
}

function museSteps(name: string, seconds = 6): Step[] {
  const repairLine = `\`team remove ${name} --keep\` then \`team add ${name}\``;
  return [
    { kind: 'run', argv: [], do: { do: 'create', seat: name, label: name, cwd: '.', repairLine } },
    { kind: 'run', argv: [], do: { do: 'launch', seat: name, label: name, command: 'muse' } },
    {
      kind: 'wait',
      text: `until ${name} shows its idle prompt`,
      do: { do: 'idle', seat: name, label: name, cli: 'muse', seconds, command: 'muse', repairLine },
    },
    { kind: 'run', argv: [], do: { do: 'rename', seat: name, label: name, seconds, rules: 'message', cli: 'muse' } },
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'deliver',
        seat: name,
        label: name,
        cli: 'muse',
        rules: 'Rules.',
        path: `/x/rules/${name}.md`,
        line: `Read /x/rules/${name}.md`,
        seconds,
      },
    },
  ];
}

// A host whose agent list holds what it is handed, and whose pane answers `foreground` with the
// argv0s it is handed. Everything the naming step does is recorded.
function world(options: { listed?: string[]; foreground?: string[] | null }) {
  let t = 0;
  const renames: { pane: string; name: string }[] = [];
  const delivered: string[] = [];
  const asked: string[] = [];
  const read: string[] = [];
  const { out, err, sink: s } = sink();
  const records = progressWriter(s);
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
    paneRun: () => true,
    typeLine: () => true,
    deliverRules: async (_session, pane) => {
      delivered.push(pane);
      return true;
    },
    renameAgent: (_session, pane, name) => {
      renames.push({ pane, name });
      return true;
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => {
      asked.push('agentPanes');
      return options.listed ?? [];
    },
    classify: (): ScreenKind => 'idle',
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => err.push(line),
    log: () => {},
    progress: (seat, state) => records.progress(seat, state),
    final: (seat, record) => records.final(seat, record),
    detail: (line) => records.detail(line),
    ...(options.foreground === undefined
      ? {}
      : {
          foreground: (_session: string, pane: string) => {
            read.push(pane);
            return options.foreground ?? null;
          },
        }),
  };
  return { host, renames, delivered, asked, read, out, err, now: () => t };
}

describe('naming a seat herdr does not list as an agent', () => {
  test('a pane whose foreground is the CLI is adopted, named, and given its rules', async () => {
    const made = world({ foreground: [MUSE_ARGV0] });
    const report = await executePlan(museSteps('muse'), 'acme', made.host);
    expect(report.dropped).toEqual([]);
    // The name landed on the pane herdr's list never named, and the rules went there too.
    expect(made.renames).toEqual([{ pane: 'muse-pane', name: 'muse' }]);
    expect(made.delivered).toEqual(['muse-pane']);
    expect(made.out.join('')).toBe('muse: ready\n');
    expect(made.err.join('')).toBe('');
    // The list is asked first, the pane's process second — the reading that adopted it.
    expect(made.asked.length).toBeGreaterThan(0);
    expect(made.read).toEqual(['muse-pane']);
  });

  test('a pane herdr does name is renamed off the list, with no process read at all', async () => {
    const made = world({ listed: ['muse-pane'], foreground: [MUSE_ARGV0] });
    const report = await executePlan(museSteps('muse'), 'acme', made.host);
    expect(report.dropped).toEqual([]);
    expect(made.renames).toEqual([{ pane: 'muse-pane', name: 'muse' }]);
    expect(made.read).toEqual([]);
  });

  test('a pane whose foreground is not the CLI is left out, and the wait runs its whole course', async () => {
    const made = world({ foreground: ['zsh'] });
    const report = await executePlan(museSteps('muse', 4), 'acme', made.host);
    expect(report.dropped).toEqual(['muse']);
    expect(made.renames).toEqual([]);
    // The pane was read once per poll — 0 s, 2 s, and the reading that meets the deadline — and
    // the wait ran its whole 4 s: nothing about it was adopted early.
    expect(made.read).toEqual(['muse-pane', 'muse-pane', 'muse-pane']);
    expect(made.now()).toBe(4000);
    expect(made.out.join('')).toBe('muse: left out: was not in the agent list in time; left at launched\n');
  });

  test('a host that reports no foregrounds keeps the reading it had', async () => {
    const made = world({});
    const report = await executePlan(museSteps('muse', 4), 'acme', made.host);
    expect(report.dropped).toEqual(['muse']);
    expect(made.renames).toEqual([]);
    expect(made.out.join('')).toBe('muse: left out: was not in the agent list in time; left at launched\n');
  });
});
