// The two lines a seat gets, at the command level: line 1 is the written label, or the seat's
// name and role when the file writes none — never the model; line 2 is the display (and the
// effort), set on the pane after the seat is named. `up` and `add` agree on both lines, a
// report that fails is one line and leaves no seat out, and a second `up` changes nothing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-13T19:00:00Z');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

// One seat with a written label and an effort, one with neither: every line of the sidebar is
// decided between them.
const BASE = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: command deck
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    effort: high
    mode: shared
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Grok Four Seven
    version: "4.7"
    launch: grok --model grok-4-7
    mode: shared
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-title-agreement-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  const lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  const yaml = BASE.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ${lobby}\n  - ${root}\n`);
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

/** The launch side: the workspaces it titles, the displays it reports, and whether the report
 *  answers. */
function world(report = true) {
  const panes = new Map<string, { text: string; agent: boolean }>();
  const labels: string[] = [];
  const reported: string[] = [];
  let n = 0;
  let session = 'absent' as 'absent' | 'running';
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      labels.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    reportDisplayAgent: (_session, _pane, text) => {
      reported.push(text);
      return report;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => Object.entries(readState(join(root, '.agents')).sessions.acme?.seats ?? {})
      .filter(([, seat]) => seat.pane !== undefined)
      .map(([name, seat]) => ({ name, agent: 'claude', pane: seat.pane!, workspace: seat.workspace!, status: 'idle' as const, cwd: null })),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'grok'],
    sleep: async () => {},
    now: () => NOW,
  };
  return { launch, labels, reported, agents: () => launch.agents('acme') };
}

async function up(made: ReturnType<typeof world>, over: Partial<UpSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => made.agents(),
    alive: () => true,
    home,
    now: () => NOW,
    launch: made.launch,
    ...over,
  };
  const code = await runUp([...FILE], io, sources);
  return { code, out: io.out, err: io.err, labels: made.labels, reported: made.reported };
}

async function add(made: ReturnType<typeof world>, names: string[]) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
  };
  const code = await runAdd([...names, ...FILE], io, sources);
  return { code, out: io.out, err: io.err, labels: made.labels, reported: made.reported };
}

describe('up titles the two lines', () => {
  test('a written label is line 1, and the display with the effort is line 2', async () => {
    const made = world();
    const run = await up(made);
    expect(run.code).toBe(0);
    expect(run.labels).toEqual(['command deck', 'worker · implementer', 'watchdog']);
    expect(run.reported).toEqual(['Claude Opus 5.5 high', 'Grok Four Seven 4.7 default']);
  });

  test('a seat with no written label falls back to its name and role, never the model', async () => {
    const made = world();
    const run = await up(made);
    expect(run.labels).toContain('worker · implementer');
    for (const label of run.labels) {
      expect(label).not.toContain('Grok Four Seven');
      expect(label).not.toContain('Claude Opus');
    }
    // The display strings are line 2, and only there: the display, a space, and the effort or
    // `default` when the file sets none.
    expect(run.reported).toContain('Grok Four Seven 4.7 default');
    expect(run.reported).toContain('Claude Opus 5.5 high');
  });

  test('a report that fails is one line and leaves no seat out', async () => {
    const made = world(false);
    const run = await up(made);
    expect(run.code).toBe(0);
    expect(run.out).toContain('lead: ready');
    expect(run.out).toContain('worker: ready');
    expect(run.out).not.toContain('left out');
    expect(run.err.match(/its display was not reported/g)).toHaveLength(2);
  });

  test('a second up changes nothing', async () => {
    const made = world();
    const first = await up(made);
    expect(first.code).toBe(0);
    // The settled state the second run reads: the watch the first run started is alive on record.
    updateState(join(root, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).watch = { pid: 4242, heartbeat: NOW.toISOString() };
    });
    made.labels.length = 0;
    made.reported.length = 0;
    const second = await up(made);
    expect(second.code).toBe(0);
    expect(second.labels).toEqual([]);
    expect(second.reported).toEqual([]);
    expect(second.out).not.toContain('left out');
  });
});

describe('add agrees with up', () => {
  test('the same seat gets the same two lines from add', async () => {
    const byUp = world();
    const upRun = await up(byUp);
    expect(upRun.code).toBe(0);

    const byAdd = world();
    const lead = await add(byAdd, ['lead']);
    expect(lead.code).toBe(0);
    const worker = await add(byAdd, ['worker']);
    expect(worker.code).toBe(0);
    expect(byAdd.labels).toEqual(byUp.labels.slice(0, 2));
    expect(byAdd.reported).toEqual(byUp.reported);
  });
});
