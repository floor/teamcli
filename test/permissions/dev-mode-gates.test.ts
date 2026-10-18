// The map's `add` row is the owner's alone in 0.5.0, where no `agree` or `grant` holders
// stand — the operator and the orchestrator are seats like any other here. A seat's `team add`
// has exactly two openings: dev mode's one warning, which says the refusal and continues, and a
// `delegates` entry whose pane the caller stands on. The three scenes are the orchestrator's:
// in dev mode an operator's add passes, with the warning and the log line; without dev mode and
// without a delegate the same run is refused in the row's own words; with a delegate entry for
// `add` the run passes with the real gate — no dev mode — and the same-copy seat it starts
// writes neither the file nor the record.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import type { Caller } from '../../src/caller.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import { delegateGate } from '../../src/delegate.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { readState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-17T12:00:00.000Z');
// The map's own refusal, in the words the add prints it: one sentence for every seat.
const ADD_LINE = 'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is op';

/** The team's operator: a seat of the team's own session, refused `add` by the map's row like
 *  every other seat, whatever its standing. */
const OPERATOR: Caller = { kind: 'seat', name: 'op', pane: 'w2:p1', session: 'acme' };

/** An external pane — a seat of another session: the one shape a `delegates` entry can name. */
const PILOT: Caller = { kind: 'seat', name: 'pilot', pane: 'w1:p1', session: 'main' };

/** The entry the last approval holds: the pilot's pane, and `add` among its words. */
const DELEGATES = `delegates:
  - pane: main/w1:p1
    commands: [add]
`;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Place = { base: string; root: string; home: string; file: string };

/** A repository, a home beside it, and nothing else written yet. */
function layout(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-dev-mode-gates-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { base, root, home, file: join(root, '.agents', 'team.yaml') };
}

/** The team: an orchestrator and an operator, a stopped implementer `worker` — adding it would
 *  edit the file — and a live implementer `helper`, which an add starts without writing a line.
 *  The `delegates` section is the scene's variable. */
function team(place: Place, delegates = ''): string {
  return `format: 1
project: acme
session: acme
coordinator: lead
operator: op
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: op
    label: op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${delegates}`;
}

/** The file the owner approves, written and recorded: the live text with the migrated trust an
 *  add reads before it starts a seat (absolute paths, the lobby among them). */
function approve(place: Place, text: string): void {
  const yaml = text.replace(
    'coordinator: lead\n',
    `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${place.root}\n  - ${join(place.home, 'worktrees')}\n`,
  );
  writeFileSync(place.file, yaml);
  const loaded = loadTeamFile(place.root, { home: place.home, file: place.file });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, place.home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    place.home,
  );
}

/** The launcher: panes start idle, the session starts absent, and the clock moves with the
 *  launch's sleeps. Nothing here reads the machine. */
function world(): { launch: Launch; creates: string[] } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  const held = { launch: {} as Launch, creates: [] as string[] };
  held.launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: CLAUDE_IDLE, agent: false });
      held.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return held;
}

function doctor(home: string): DoctorSources {
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

function addSources(place: Place, made: ReturnType<typeof world>, extra: Partial<AddSources> = {}): AddSources {
  return {
    home: place.home,
    sessionState: () => made.launch.sessionState('acme'),
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(place.home),
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

// The real gate, with herdr's two reads replaced: this team's session is absent, so there are
// no live seats to collide with. Everything else — the approval, the approved copy, the
// entries, the caller's placement on the entry's pane — is the gate's own reading.
const REAL_GATE: NonNullable<AddSources['delegateGate']> = (input) =>
  delegateGate({ ...input, sources: { agents: () => [], sessionRunning: () => false } });

describe('the map\'s add row and the two openings a seat has', () => {
  test('in dev mode the operator\'s add passes: the warning, the log line, and the seat starts', async () => {
    const place = layout();
    approve(place, team(place));
    const made = world();
    const io = testIo(place.root, OPERATOR);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runAdd(['worker'], io, addSources(place, made));
    // Dev mode says the map's sentence once and continues: the run is a full add, from the
    // gate to the launch, and the operator's call is attributed in the project's log.
    expect(code).toBe(0);
    expect(io.err.startsWith(`team add: warning: ${ADD_LINE}; dev mode continues\n`)).toBe(true);
    expect(io.err).toContain('dev mode continues');
    expect(made.creates).toEqual(['worker']);
    expect(readState(join(place.root, '.agents')).sessions.acme?.seats.worker?.stage).toBe('ready');
    expect(readFileSync(place.file, 'utf8')).not.toContain('stopped: true');
    expect(readFileSync(join(place.root, '.agents', 'team.log'), 'utf8').startsWith(
      `${NOW.toISOString()} add [op] warning: ${ADD_LINE}; dev mode continues\n`,
    )).toBe(true);
  });

  test('without dev mode and with no delegate the same run is the map\'s refusal, and nothing is started', async () => {
    const place = layout();
    approve(place, team(place));
    const made = world();
    const io = testIo(place.root, OPERATOR);
    const before = readFileSync(place.file, 'utf8');
    const code = await runAdd(['worker'], io, addSources(place, made));
    expect(code).toBe(1);
    expect(io.err).toBe(`team add: ${ADD_LINE}\n`);
    expect(io.out).toBe('');
    expect(made.creates).toEqual([]);
    expect(readFileSync(place.file, 'utf8')).toBe(before);
    expect(existsSync(join(place.root, '.agents', 'team.log'))).toBe(false);
  });

  test('a delegate entry for `add` needs no dev mode: the real gate passes and the same-copy seat starts', async () => {
    const place = layout();
    approve(place, team(place, DELEGATES));
    const made = world();
    const before = readFileSync(place.file, 'utf8');
    const record = readFileSync(join(storePath('acme', place.root, place.home), 'approval.json'), 'utf8');
    const io = testIo(place.root, PILOT);
    const code = await runAdd(['helper'], io, addSources(place, made, { delegateGate: REAL_GATE }));
    // The entry is the standing grant: the gate passes on the verified approval, the approved
    // copy and the caller standing on its pane, and the run starts `helper` — a stanza the
    // approval already holds, so the add writes neither the file nor the record.
    expect(code).toBe(0);
    expect(io.err).not.toContain('only the owner');
    expect(made.creates).toEqual(['helper']);
    expect(readFileSync(place.file, 'utf8')).toBe(before);
    expect(readFileSync(join(storePath('acme', place.root, place.home), 'approval.json'), 'utf8')).toBe(record);
    // The audit line is the log's first line: the run is attributed before its effects.
    expect(readFileSync(join(place.root, '.agents', 'team.log'), 'utf8').startsWith(
      `${NOW.toISOString()} delegate [delegate] main/w1:p1 add\n`,
    )).toBe(true);
  });
});
