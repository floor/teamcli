import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { Key } from '../../src/launch/terminal.ts';
import { readState } from '../../src/state.ts';
import { upFingerprint, OWNER_APPROVAL_ENV } from '../../src/approve/owner-token.ts';
import { approvalStanding, storePath, writeApproval } from '../../src/store/store.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = CLAUDE_IDLE;
const TRUST = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
const FILE = ['--file', '.agents/team.yaml'];
const SESSION = 'acme-web';

const LABEL: Record<string, string> = { 'both-acme': 'both seat', 'coord-acme': 'coord seat', 'ops-acme': 'ops seat', 'dev-acme': 'dev seat' };
const LEAD = new Set(['both-acme', 'coord-acme', 'ops-acme']);

// The kinds of seat the brief names: a seat the file names as both its coordinator and its
// operator (the fixture's own shape), the coordinator and the operator as two seats, and an
// ordinary seat.
const SEATS = {
  both: `  - role: coordinator
    name: both-acme
    label: both seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: dev-acme
    label: dev seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
  split: `  - role: coordinator
    name: coord-acme
    label: coord seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: ops-acme
    label: ops seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: dev-acme
    label: dev seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
};

const TEAM = (root: string, both = false): string => `format: 1
project: acme-web
session: acme-web
coordinator: ${both ? 'both-acme' : 'coord-acme'}
operator: ${both ? 'both-acme' : 'ops-acme'}
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
${both ? SEATS.both : SEATS.split}`;

let base: string;
let root: string;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The team file, its approval, and nothing else: the shape can be rewritten inside a test. */
function setup(both = false): void {
  const text = TEAM(root, both);
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
    home,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-repair-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type Pane = { text: string; box?: string; agent: boolean; name: string | null };

/** One fake host behind `up`, `down`, `remove` and `add` at once: a live herdr the owner can
 *  also change by hand between runs, which is what the repairs must survive. */
function table() {
  const panes = new Map<string, Pane>();
  const spaces = new Map<string, string>();
  const created: string[] = [];
  const closed: string[] = [];
  const stopped: string[] = [];
  const deleted: string[] = [];
  const typed: string[] = [];
  const entered: string[] = [];
  const renames: string[] = [];
  // The watch's pane runs a script, not a CLI: herdr's agent list never carries it.
  const scripts = new Set<string>();
  let session: 'absent' | 'running' = 'absent';
  let clock = NOW.getTime();
  let n = 1;

  const agents = (): HerdrAgent[] =>
    [...panes]
      .filter(([, pane]) => pane.agent)
      .map(([id, pane]) => ({
        name: pane.name,
        agent: 'claude',
        pane: id,
        workspace: id.split(':')[0] ?? id,
        status: 'idle',
        cwd: null,
      }));

  const launch: Launch & DownLaunch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      const id = `w${n}`;
      const pane = `${id}:p1`;
      panes.set(pane, { text: IDLE, agent: false, name: null });
      if (label === 'watchdog') scripts.add(pane);
      spaces.set(id, label);
      created.push(label);
      return { pane, workspace: id };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known && !scripts.has(pane)) known.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const known = panes.get(pane);
      if (known) known.name = name;
      renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      spaces.delete(workspace);
      for (const [id] of panes) if (id.startsWith(`${workspace}:`)) panes.delete(id);
      return true;
    },
    stopSession() {
      stopped.push(SESSION);
      session = 'absent';
      return true;
    },
    deleteSession() {
      deleted.push(SESSION);
      return true;
    },
    kill: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => agents(),
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((id) => id.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    typeText(_session, pane, text) {
      const known = panes.get(pane);
      if (!known || !known.agent) return false;
      typed.push(text);
      known.box = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      const known = panes.get(pane);
      if (!known) return false;
      entered.push(pane);
      const boxed = known.box;
      known.box = undefined;
      // Only the exit empties the pane's CLI: a rules line sent with Enter leaves it running.
      if (boxed === claudeBox('/exit')) {
        known.agent = false;
        known.name = null;
        known.text = '';
      }
      return true;
    },
    foreground(_session, pane) {
      return panes.get(pane)?.agent ? ['claude'] : ['zsh'];
    },
    shellBack: () => null,
    processInfo: () => null,
    focus: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  const terminal = {
    keys: [] as Key[],
    reads: 0,
    drains: 0,
    async key() {
      terminal.reads += 1;
      const next = terminal.keys.shift();
      if (next === undefined) throw new Error('the pause read the terminal, and no key was queued');
      return next;
    },
    drain() {
      terminal.drains += 1;
    },
  };

  const doctor = (): DoctorSources => ({
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => session === 'running',
    now: () => NOW,
    home,
  });

  return {
    launch,
    terminal,
    panes,
    created,
    closed,
    stopped,
    deleted,
    typed,
    entered,
    renames,
    start() {
      session = 'running';
    },
    /** A pane and its workspace as herdr would list them at the start of a run. */
    plant(pane: string, workspace: string, label: string, text: string, name: string | null) {
      panes.set(pane, { text, agent: true, name });
      spaces.set(workspace, label);
    },
    /** The owner's own hand on the pane: answers its dialog, leaving the CLI at its prompt. */
    answer(pane: string) {
      const known = panes.get(pane);
      if (known) known.text = IDLE;
    },
    /** The owner's own hand on the pane: closes it, workspace and all, outside `team`. */
    closeByHand(pane: string) {
      panes.delete(pane);
      spaces.delete(pane.split(':')[0] ?? pane);
    },
    up(): UpSources {
      return {
        sessionRunning: () => session === 'running',
        agents: () => agents(),
        workspaces: () => [...spaces].map(([id, label]) => ({ id, label })),
        home,
        now: () => new Date(clock),
        sleep: launch.sleep,
        launch,
        terminal: () => terminal,
      };
    },
    down(): DownSources {
      return {
        sessionRunning: () => session === 'running',
        agents: () => agents(),
        alive: () => false,
        now: () => new Date(clock),
        screen: (_session, pane, cli) => readScreen(cli, panes.get(pane)?.text),
        screenText: (_session, pane) => panes.get(pane)?.box ?? panes.get(pane)?.text,
        status: () => 'idle',
        foreground: (_session, pane) => (panes.get(pane)?.agent ? ['claude'] : ['zsh']),
        sleep: launch.sleep,
        home,
        launch,
      };
    },
    remove(): RemoveSources {
      return {
        home,
        sessionRunning: () => session === 'running',
        agents: () => agents(),
        alive: () => false,
        now: () => new Date(clock),
        screen: (_session, pane, cli) => readScreen(cli, panes.get(pane)?.text),
        screenText: (_session, pane) => panes.get(pane)?.box ?? panes.get(pane)?.text,
        status: () => 'idle',
        foreground: (_session, pane) => (panes.get(pane)?.agent ? ['claude'] : ['zsh']),
        sleep: launch.sleep,
        launch,
      };
    },
    add(): AddSources {
      return {
        home,
        sessionState: () => session,
        agents: () => agents(),
        workspaces: () => [...spaces].map(([id]) => ({ id })),
        doctor: doctor(),
        now: () => new Date(clock),
        launch,
      };
    },
  };
}

function stateOf(seat: string) {
  return readState(join(root, '.agents')).sessions[SESSION]?.seats[seat];
}

function seed(seat: string): void {
  writeFileSync(
    join(root, '.agents/team.state.json'),
    JSON.stringify({
      format: 1,
      sessions: {
        [SESSION]: {
          seats: {
            [seat]: {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
          },
          worktrees: {},
        },
      },
    }),
  );
}

const repair = (seat: string): string =>
  LEAD.has(seat)
    ? '`team down` then `team up` (to restart the whole team)'
    : `\`team remove ${seat} --keep\` then \`team add ${seat}\` (or \`team down\` then \`team up\` for the whole team)`;

/** The step the line prints before the repair, by the state of the pane the record names: a
 *  pane the multiplexer lists under this seat's name is a CLI at its dialog; any other pane
 *  has no name `team` could reach and is closed. */
const step = (pane: 'unnamed' | 'dialog'): string =>
  pane === 'dialog' ? 'answer or close its dialog in its pane' : 'close that pane';

/** A run's exit, with the run's own output printed when the code is not the one the proof needs. */
function exitOf(code: number, want: number, io: { out: string; err: string }, what: string): void {
  if (code !== want) throw new Error(`${what}: exit ${code}, wanted ${want}\n${io.out}${io.err}`);
}

/** The whole proof for one kind of seat and one state of its pane, in the order the brief names:
 *  the refusal by a run, then the printed line's sequence. A dialog is left by `down` until the
 *  owner answers it. A pane with no name that the state records for the seat is closed by
 *  `down` itself. Then the sequence in its order, first step included (the record gone, the
 *  next `up` through). A seat that is both of the file's leads needs its own file; every other
 *  cell uses the two-lead shape. */
/** An admitted run that is not the owner at a terminal, so `up` launches and does not prompt. */
function quietIo() {
  const standing = approvalStanding(root, home);
  if (standing.kind !== 'verified') throw new Error('the no-prompt run needs a verified approval');
  const io = testIo(root, { kind: 'seat', name: 'dev-acme', pane: 'w9:p1', session: SESSION });
  io.env[OWNER_APPROVAL_ENV] = upFingerprint(standing.record.approval.fingerprints, standing.generation);
  return io;
}

async function prove(seat: string, pane: 'unnamed' | 'dialog', both = false): Promise<void> {
  if (both) setup(true);
  seed(seat);
  const made = table();
  made.start();
  made.plant('w1:p1', 'w1', LABEL[seat] ?? 'seat', pane === 'dialog' ? TRUST : IDLE, pane === 'dialog' ? seat : null);

  // 1. The refusal: this seat cannot be resumed, and the line names what comes first — the
  //    dialog answered or the nameless pane closed by hand — then this seat's own repair.
  const first = quietIo();
  const refused = await runUp(FILE, first, made.up());
  exitOf(refused, 1, first, 'the refusal run');
  expect(first.out).toContain(
    pane === 'unnamed'
      ? `${seat}: left out: its waiting pane is gone\n`
      : `${seat}: left out: its waiting record has no process identity\n`,
  );
  expect(first.err).toContain(
    pane === 'unnamed'
      ? `  its record still names it; ${repair(seat)}, clears it\n`
      : `  ${step(pane)}, then run ${repair(seat)}, to establish one by a run\n`,
  );
  if (LEAD.has(seat)) expect(first.err).not.toContain('remove');

  // 2. The sequence without its first step. A dialog stays: `down` never answers a prompt, so
  //    the record stays and the next `up` fails again. A pane with no name is closed when this
  //    seat records that pane and that workspace, and the record goes with the close.
  if (LEAD.has(seat)) {
    const down = testIo(root, { kind: 'owner' });
    exitOf(await runDown(FILE, down, made.down()), 0, down, 'the down without its first step');
    if (pane === 'dialog') {
      expect(down.out).toContain(`  skip ${seat}: is blocked at a prompt, which \`team\` never answers; left running\n`);
      expect(made.stopped).toEqual([]);
      const stuck = quietIo();
      exitOf(await runUp(FILE, stuck, made.up()), 1, stuck, 'the up without its first step');
      expect(stuck.out).toContain(`${seat}: left out: its waiting record has no process identity\n`);
      expect(stateOf(seat)?.waiting).toEqual({ state: 'waiting-owner', classification: 'trust' });
    } else {
      // Down closes a pane with no name when this seat records that pane and workspace, and
      // the next up brings the seat back. The old guarantee was that down left the pane, so
      // the owner closed it by hand before down and up.
      expect(down.out).toContain(`${seat}: created for this seat and never named; its workspace was closed\n`);
      expect(down.out).toContain(`session ${SESSION}: stopped and cleared\n`);
      expect(stateOf(seat)).toBeUndefined();
      const cleared = testIo(root, { kind: 'owner' });
      exitOf(await runUp(FILE, cleared, made.up()), 0, cleared, 'the up after down closed the unnamed pane');
      expect(cleared.out + cleared.err).not.toContain(`${seat}: left out`);
      expect(stateOf(seat)?.waiting).toBeUndefined();
      expect(stateOf(seat)?.pane).not.toBe('w1:p1');
      return;
    }
  } else {
    const remove = testIo(root, { kind: 'owner' });
    const code = await runRemove([seat, '--keep', ...FILE], remove, made.remove());
    if (pane === 'dialog') {
      exitOf(code, 1, remove, 'the remove without its first step');
      expect(remove.err).toContain(`team remove: ${seat} is blocked at a prompt, which team never answers\n`);
      const stuck = quietIo();
      exitOf(await runUp(FILE, stuck, made.up()), 1, stuck, 'the up after the refused remove');
      expect(stuck.out).toContain(`${seat}: left out: its waiting record has no process identity\n`);
      expect(stateOf(seat)?.waiting).toEqual({ state: 'waiting-owner', classification: 'trust' });
    } else {
      exitOf(code, 0, remove, 'the remove of the nameless pane');
      expect(remove.out).toContain(`stopped ${seat}\n`);
      const add = testIo(root, { kind: 'owner' });
      exitOf(await runAdd([seat, ...FILE], add, made.add()), 0, add, 'the add with the pane left open');
      // The nameless pane is still open, so `add` started a second one; the next `up` refuses
      // the whole session for the agent this file's state doesn't record.
      const stuck = quietIo();
      exitOf(await runUp(FILE, stuck, made.up()), 1, stuck, 'the up with the nameless pane left');
      expect(stuck.err).toContain(`team up: session ${SESSION} has 1 agent this file's state doesn't record: \`up\` never touches a running team\n`);
    }
  }

  // 3. The sequence the line names, in its order, first step included: the dialog answered or
  //    the pane closed by the owner's hand on the fake host, then — and only then — this seat's
  //    own repair. A fresh table, seeded again: step 2 left a second pane behind for an
  //    ordinary seat whose pane had no name.
  seed(seat);
  const hand = table();
  hand.start();
  hand.plant('w1:p1', 'w1', LABEL[seat] ?? 'seat', pane === 'dialog' ? TRUST : IDLE, pane === 'dialog' ? seat : null);
  if (pane === 'dialog') hand.answer('w1:p1'); else hand.closeByHand('w1:p1');
  if (LEAD.has(seat)) {
    const down = testIo(root, { kind: 'owner' });
    exitOf(await runDown(FILE, down, hand.down()), 0, down, 'the down with its first step');
    expect(down.out).toContain(`session ${SESSION}: stopped and cleared\n`);
    const up = testIo(root, { kind: 'owner' });
    exitOf(await runUp(FILE, up, hand.up()), 0, up, 'the up after the sequence');
  } else {
    const remove = testIo(root, { kind: 'owner' });
    exitOf(await runRemove([seat, '--keep', ...FILE], remove, hand.remove()), 0, remove, 'the remove with its first step');
    const add = testIo(root, { kind: 'owner' });
    exitOf(await runAdd([seat, ...FILE], add, hand.add()), 0, add, 'the add after the sequence');
  }

  // 4. The record is cleared or replaced, and the next `up` handles the seat.
  const after = stateOf(seat);
  expect(after?.waiting).toBeUndefined();
  expect(after?.pane).not.toBe('w1:p1');
  const next = testIo(root, { kind: 'owner' });
  exitOf(await runUp(FILE, next, hand.up()), 0, next, 'the next up');
  expect(next.out + next.err).not.toContain(`${seat}: left out`);
}

describe('every named repair, proved by a run of the fake host', () => {
  // The old guarantee was that down left this unnamed pane, so the owner closed it by hand before down and up.
  test('the coordinator that is also the operator, whose pane is unnamed: down closes it and up brings it back', async () => {
    await prove('both-acme', 'unnamed', true);
  });

  test('the coordinator that is also the operator, whose pane carries its name at a dialog: answered by hand, then down then up', async () => {
    await prove('both-acme', 'dialog', true);
  });

  // The old guarantee was that down left this unnamed pane, so the owner closed it by hand before down and up.
  test('the coordinator, whose pane is unnamed: down closes it and up brings it back', async () => {
    await prove('coord-acme', 'unnamed');
  });

  test('the coordinator, whose pane carries its name at a dialog: answered by hand, then down then up', async () => {
    await prove('coord-acme', 'dialog');
  });

  // The old guarantee was that down left this unnamed pane, so the owner closed it by hand before down and up.
  test('the operator, whose pane is unnamed: down closes it and up brings it back', async () => {
    await prove('ops-acme', 'unnamed');
  });

  test('the operator, whose pane carries its name at a dialog: answered by hand, then down then up', async () => {
    await prove('ops-acme', 'dialog');
  });

  test('an ordinary seat, whose pane is unnamed: remove --keep then add', async () => {
    await prove('dev-acme', 'unnamed');
  });

  test('an ordinary seat, whose pane carries its name at a dialog: answered by hand, then remove --keep then add', async () => {
    await prove('dev-acme', 'dialog');
  });

  test('an unnamed pane that matches no record is left, and the hand close is still the repair', async () => {
    seed('coord-acme');
    const made = table();
    made.start();
    made.plant('w9:p1', 'w9', 'stray', IDLE, null);
    const down = testIo(root, { kind: 'owner' });
    exitOf(await runDown(FILE, down, made.down()), 0, down, 'the down of a pane no record accounts for');
    expect(down.out).toContain('pane w9:p1: not recorded for a seat of this team; left as it is\n');
    expect(down.out).toContain(`session ${SESSION}: not stopped, 1 agent left in it\n`);
    expect(made.stopped).toEqual([]);
    expect(stateOf('coord-acme')?.pane).toBe('w1:p1');
    made.closeByHand('w9:p1');
    const again = testIo(root, { kind: 'owner' });
    exitOf(await runDown(FILE, again, made.down()), 0, again, 'the down after the hand close');
    expect(again.out).toContain(`session ${SESSION}: stopped and cleared\n`);
    const up = testIo(root, { kind: 'owner' });
    exitOf(await runUp(FILE, up, made.up()), 0, up, 'the up after the hand close');
    expect(up.out + up.err).not.toContain('coord-acme: left out');
  });
});
