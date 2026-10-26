import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { realSources as downReal, runDown, stateOf, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { realSources as upReal, runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { delegateGate } from '../../src/delegate.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { sessionState, setHerdrRun, workspacePanes, type HerdrAgent, type HerdrWorkspace } from '../../src/herdr.ts';
import { upFingerprint, OWNER_APPROVAL_ENV } from '../../src/approve/owner-token.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../../src/store/store.ts';
import { readState } from '../../src/state.ts';
import { writeGrant } from '../../src/permissions/grants.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { parseMemoryPressure, parseSwapUsage, type Machine } from '../../src/watch/machine.ts';
import type { Key } from '../../src/launch/terminal.ts';
import { seatLockPath } from '../../src/launch/seat-lock.ts';
import { RULES_ENTER_TRIES } from '../../src/launch/deliver.ts';
import { defaultFs } from '../../src/lobby/gate.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { beginSession, readStoreSessions, sessionsPath } from '../../src/sessions/registry.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { watchLabel } from '../../src/watch/pane.ts';
import { GENERAL_BRIEF_SHA256, currentBriefClaim, generalBriefBody, generalBriefId } from '../../src/launch/general-brief.ts';
import { agyMismatchedFrame, CLAUDE_IDLE, claudeBox, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9, pressure: 'normal' };
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = CLAUDE_IDLE;

// The captured Codex home names Terra 5.6. The example file says GPT Sol 6, so a launch test
// that should get past the model check shows the file's model on that same status row.
function fileModel(text: string): string {
  return text.replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
}
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';
const CLOSING_MESSAGE = 'These are standing rules, not a task: reply ready and wait for your brief.';
const CLOSING_OPTION = 'These are standing rules, not a task.';

let base: string;
let root: string;
let home: string;

function makeExample(basePath: string, rootPath: string, text: string = EXAMPLE): string {
  return text.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-live-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
});

afterEach(() => {
  setHerdrRun(null);
  rmSync(base, { recursive: true, force: true });
});

const store = () => storePath('acme-web', root, home);

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home });
  expect(code).toBe(0);
}

/** An admitted run that is not the owner at a terminal: the token, on a seat. `up` launches and
 *  does not prompt. A run placed with no terminal is refused before this path. */
function quietIo() {
  const standing = approvalStanding(root, home);
  if (standing.kind !== 'verified') throw new Error('the no-prompt run needs a verified approval');
  const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'acme-web' });
  io.env[OWNER_APPROVAL_ENV] = upFingerprint(standing.record.approval.fingerprints, standing.generation);
  return io;
}

function agent(name: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
}

function doctor(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

type World = {
  launch: Launch;
  starts: number;
  creates: string[];
  runs: { pane: string; command: string }[];
  renames: string[];
  closes: string[];
  /** Sessions `up` cleared because the state recorded them and herdr listed them stopped. */
  deletes: string[];
  /** The workspaces this run created, as herdr's list would return them: id and label. */
  workspaceList(): HerdrWorkspace[];
  /** The injected owner's terminal: the pause's keys are queued here, never read from stdin. */
  terminal: { keys: Key[]; reads: number; drains: number; key(ms: number): Promise<Key>; drain(): void };
  session: 'absent' | 'running' | 'stopped';
  seed(pane: string, text: string, agent: boolean): void;
};

function world(text: string | ((pane: string, label: string) => string) = IDLE): World {
  const state: World = {
    launch: {} as Launch,
    starts: 0,
    creates: [],
    runs: [],
    renames: [],
    closes: [],
    deletes: [],
    workspaceList: () => [...spaces].map(([id, label]) => ({ id, label })),
    terminal: {
      keys: [],
      reads: 0,
      drains: 0,
      async key() {
        state.terminal.reads += 1;
        const next = state.terminal.keys.shift();
        // No test may reach the pause without queueing what its owner would type: a silent
        // fallback would hide an unexpected prompt.
        if (next === undefined) throw new Error('the pause read the terminal, and no key was queued');
        return next;
      },
      drain() {
        // Type-ahead never answers a prompt: the pause drains before each one, and once on the
        // way out. The World's terminal has nothing buffered to discard; the count is the proof.
        state.terminal.drains += 1;
      },
    },
    session: 'absent',
    seed(pane, shown, agent) {
      panes.set(pane, { text: shown, agent });
    },
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean }>();
  // The label each created workspace carries: what `up` passed to createWorkspace, as herdr
  // would report it back in its workspace list.
  const spaces = new Map<string, string>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.starts++;
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      const shown = typeof text === 'string' ? text : text(pane, label);
      panes.set(pane, { text: shown, agent: false });
      spaces.set(`w${n}`, label);
      state.creates.push(label);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      state.runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      state.renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      state.closes.push(workspace);
      return true;
    },
    agentPanes() {
      return [...panes].filter(([, pane]) => pane.agent).map(([id]) => id);
    },
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText(_session, pane) {
      return panes.get(pane)?.text ?? '';
    },
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    // The pause's focus: it changes nothing in the pane, and the fake records that it ran.
    focus: () => true,
    deleteSession(session) {
      state.deletes.push(session);
      state.session = 'absent';
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return state;
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    // The workspaces herdr lists, as herdr would: what this run created, with its labels. Tests
    // whose recorded seats live in workspaces an earlier run made pass their own list.
    workspaces: () => made.workspaceList(),
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    terminal: () => made.terminal,
    ...extra,
  };
}

/** The one line as a box the pane would draw: wrapped at `width`, broken after a `/` or a
 *  space where one falls, mid-word otherwise, so no row break hides a character. */
function wrappedRows(text: string, width = 50): string[] {
  const rows: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const cut = rest.slice(0, width + 1);
    const slash = cut.lastIndexOf('/');
    const space = cut.lastIndexOf(' ');
    const at = Math.max(slash, space, 0) || width;
    rows.push(rest.slice(0, at + 1));
    rest = rest.slice(at + 1);
  }
  rows.push(rest);
  return rows;
}

describe('team up, live', () => {
  test('rules are not typed into a pane the CLI never appears in', async () => {
    const path = join(root, '.agents/team.yaml');
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'codex-acme · implementer' ? fileModel(capture('idle')) : IDLE));
    const sent: string[] = [];
    made.launch.agentStatus = () => 'idle';
    // A shell holds the pane and never hands it to the CLI: the delivery waits it out, types
    // nothing into the shell, and gives up at the deadline saying the CLI never appeared.
    made.launch.foreground = () => ['zsh'];
    made.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(sent).toEqual([]);
    expect(io.out).toContain(
      'codex-acme: left out: rules not typed: the CLI never appeared as its pane\'s foreground process '
        + '(the screen read idle); check the seat\'s launch line — the wrapper it starts through, '
        + 'or the command itself — then run up again\n',
    );
  });

  test.each(['accepted', 'trust', 'startup', 'swallowed'] as const)('Codex first-message rules: %s', async (outcome) => {
    const path = join(root, '.agents/team.yaml');
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => label === 'codex-acme · implementer'
      ? fileModel(capture(outcome === 'trust' || outcome === 'startup' ? outcome : 'idle')) : IDLE);
    let codexPane = '';
    let status = 'idle';
    const sent: string[] = [];
    const read = made.launch.paneText;
    let pasted = false;
    let typed = '';
    // The pane with the line rendered: the idle frame's placeholder row replaced by the line's
    // first row, its continuation rows at the prompt's own column, wrapped as the pane wraps.
    const boxed = () => {
      const [first = '', ...rest] = wrappedRows(typed);
      return capture('idle').replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.agentStatus = () => status;
    // Herdr's list and the pane's process, as a terminal-less owner's close reads them: the
    // pane this run launched is on the list, and its process is the one the dialog was found
    // with — so the no-terminal close of the trust dialog can be proven and happens.
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'codex',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 700, foreground: [700, 701] });
    made.launch.typeText = (_session, pane, text) => { codexPane = pane; typed = text; sent.push(text); pasted = true; return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); if (outcome === 'accepted') { status = 'working'; pasted = false; } return true; };
    made.launch.paneText = (session, pane) => pane === codexPane
      ? (pasted ? boxed() : capture('working')) : read(session, pane);
    // The idle wait's polls: a dialog or a vendor notice is the first read's, never waited out.
    let naps = 0;
    const napping = made.launch.sleep;
    made.launch.sleep = async (ms) => { naps++; return napping(ms); };
    // §2: the trust dialog and the vendor notice are exactly what a caller with no terminal
    // cannot be asked about — its workspace is closed without input and the record says so.
    const dialogs = outcome === 'trust' || outcome === 'startup';
    const io = dialogs ? quietIo() : testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'];
    if (outcome === 'accepted') {
      expect(code).toBe(0);
      expect(seat).toMatchObject({ stage: 'ready', rules: 'message' });
      // The pane sees the one line: the file's path and its hash, never the rules themselves.
      expect(sent[0]).toStartWith('Read ');
      expect(sent[0]).toContain(`rules/codex-acme.md`);
      expect(sent[0]).toMatch(/\(sha256 [0-9a-f]{12}\)/);
      expect(sent[0]).toEndWith('your standing rules for this session; reply ready and wait for your brief.');
      expect(sent[1]).toBe('Enter');
      // The rules travel in the file the line points at, owner-only, the approved text itself.
      const file = readFileSync(join(store(), 'rules', 'codex-acme.md'), 'utf8');
      expect(file).toContain('Agent: GPT-6 Sol · implementer');
      expect(file).toEndWith(CLOSING_MESSAGE);
      expect(made.runs.some(({ command }) => command.startsWith('Rules for this session'))).toBe(false);
    } else if (outcome === 'swallowed') {
      expect(code).toBe(1);
      expect(seat?.stage).toBe('named');
      expect(seat?.rules).toBeUndefined();
      // The line was typed and Enter was pressed, and the box still holds it: the report says
      // the rules sit unsent and names what to do, instead of a generic failure.
      expect(io.out).toContain('codex-acme: left out: rules typed, not sent: its box still holds the line after Enter; '
        + 'press Enter in its pane to send it, or clear the box (Ctrl+U), then run up again\n');
    } else {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(seat).toBeUndefined();
      expect(made.closes).toContain('w2');
      expect(made.renames).toContain('codex-acme');
      expect(made.terminal.reads).toBe(0);
      // The record names the reading and why it closed; the close follows it on stderr, and the
      // log keeps the record alone.
      const line = outcome === 'trust'
        ? 'codex-acme: left out: trust (no terminal for owner)'
        : 'codex-acme: left out: vendor notice (no terminal for owner)';
      expect(io.out).toContain(`${line}\n`);
      expect(io.err).toContain('  its workspace was closed without input\n');
      expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(line);
      // The wait ended at the first read — a dialog and a vendor notice alike are never polled.
      expect(naps).toBe(0);
    }
    // Whatever the outcome, a redirected stdout holds records alone: the final ones, one per
    // seat, in the record's own grammar — no provisional text, and nothing else.
    const lines = io.out.split('\n').filter((entry) => entry !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of lines) {
      expect(entry).toMatch(/^.+: (ready|left out: .+|waiting for owner \(.+\))$/);
    }
  });

  test.each(['accepted', 'trust', 'swallowed'] as const)('Antigravity first-message rules: %s', async (outcome) => {
    const path = join(root, '.agents/team.yaml');
    const gemini = [
      '  - role: implementer',
      '    name: gemini-acme',
      '    cli: antigravity',
      '    vendor: google',
      '    model: Gemini Flash',
      '    version: "3.8"',
      '    display: Gemini 3.8 Flash',
      '    launch: agy',
      '    parked: true',
    ].join('\n');
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace(/  - role: implementer\n    name: codex-acme[\s\S]*?stopped: true\n/, `${gemini}\n`)));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/antigravity/1.2.16/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'gemini-acme · implementer'
      ? capture(outcome === 'trust' ? outcome : 'idle') : IDLE));
    let geminiPane = '';
    let status = 'idle';
    const sent: string[] = [];
    const read = made.launch.paneText;
    let pasted = false;
    let typed = '';
    // The pane with the paste rendered: the idle frame's bare prompt row replaced by the typed
    // message, later lines at the prompt's own column, as the fixtures README describes.
    const boxed = () => {
      const [first = '', ...rest] = wrappedRows(typed);
      const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
      return capture('idle').replace('\n>\n', `\n${body}\n`);
    };
    made.launch.agentStatus = () => status;
    // Herdr's list and the pane's process, as a terminal-less owner's close reads them: the
    // pane this run launched is on the list, and its process is the one the dialog was found
    // with — so the no-terminal close of the trust dialog can be proven and happens.
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'agy',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 700, foreground: [700, 701] });
    made.launch.typeText = (_session, pane, text) => { geminiPane = pane; typed = text; sent.push(text); pasted = true; return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); if (outcome === 'accepted') { status = 'working'; pasted = false; } return true; };
    made.launch.paneText = (session, pane) => (pane === geminiPane
      ? (pasted ? boxed() : capture('working')) : read(session, pane));
    // The trust dialog under §2: a caller with no terminal is never asked; it closes the
    // workspace without input and says so. The other outcomes run with the owner at a terminal.
    const io = outcome === 'trust' ? quietIo() : testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['gemini-acme'];
    if (outcome === 'accepted') {
      expect(code).toBe(0);
      expect(seat).toMatchObject({ stage: 'ready', rules: 'message' });
      // The pane sees the one line; the rules travel in the file it points at.
      expect(sent[0]).toStartWith('Read ');
      expect(sent[0]).toContain(`rules/gemini-acme.md`);
      expect(sent[0]).toMatch(/\(sha256 [0-9a-f]{12}\)/);
      expect(sent[0]).toEndWith('your standing rules for this session; reply ready and wait for your brief.');
      expect(sent[1]).toBe('Enter');
      const file = readFileSync(join(store(), 'rules', 'gemini-acme.md'), 'utf8');
      expect(file).toContain('Agent: Gemini 3.8 Flash · implementer');
      expect(file).toEndWith(CLOSING_MESSAGE);
      expect(made.runs.some(({ command }) => command.startsWith('Rules for this session'))).toBe(false);
    } else if (outcome === 'swallowed') {
      expect(code).toBe(1);
      expect(seat?.stage).toBe('named');
      expect(seat?.rules).toBeUndefined();
      // Same reading as the Codex case: the box still shows the line, unsent. Enter was
      // pressed, so the clearing key is named and not sent.
      expect(io.out).toContain('gemini-acme: left out: rules typed, not sent: its box still holds the line after Enter; '
        + 'press Enter in its pane to send it, or clear the box (Ctrl+U), then run up again\n');
    } else {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(seat).toBeUndefined();
      expect(made.closes).toContain('w2');
      expect(made.renames).toContain('gemini-acme');
      expect(made.terminal.reads).toBe(0);
      expect(io.out).toContain('gemini-acme: left out: trust (no terminal for owner)\n');
      expect(io.err).toContain('  its workspace was closed without input\n');
    }
  });

  test('launches each claude-code seat, names it, and starts the watch', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(made.starts).toBe(1);
    expect(made.creates).toEqual([
      'claude-coordinator-acme · project coordinator',
      'deepseek-acme · implementer',
      'deepseek-acme-2 · implementer',
      // Last, the watch's own workspace: the pane that runs the watch.
      watchLabel('acme-web'),
    ]);
    expect(made.renames).toEqual(['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2']);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.err).toContain('watch: started\n');
    expect(io.err).toContain('skip codex-acme:');
    expect(io.err).toContain('skip grok-acme:');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
    expect(seats['claude-coordinator-acme']?.rules).toBe('option');
    expect(seats['deepseek-acme-2']?.pane).toBe('w3:p1');
    // The system-prompt option stays in force on every later turn: it closes without asking for a reply.
    const launches = made.runs.filter(({ command }) => command.includes('--append-system-prompt'));
    expect(launches).toHaveLength(3);
    for (const { command } of launches) {
      // The rules stay whole, and the seat's own state hook rides after them on a settings file
      // this run wrote, aimed at that seat's state file.
      expect(command).toContain(`--append-system-prompt '`);
      expect(command).toContain(`\n${CLOSING_OPTION}' --settings ${join(root, '.agents', 'hooks', 'acme-web')}/`);
      expect(command).not.toContain('reply ready and wait for your brief');
      // The launch appends its session id after the settings flag, so the path is the next word.
      const settingsPath = command.slice(command.lastIndexOf(' --settings ') + ' --settings '.length).split(' ')[0] ?? '';
      expect(settingsPath).toMatch(/\/\.agents\/hooks\/acme-web\/[A-Za-z0-9._-]+\.json$/);
      expect(existsSync(settingsPath)).toBe(true);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(settingsPath, 'utf8')).toContain('UserPromptSubmit');
    }
    // What the record keeps is the file's line, never the typed one with the hook's flag.
    for (const seat of Object.values(seats)) {
      expect(seat.launch_line ?? '').not.toContain('--settings');
    }
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain('watch: started');
  });

  test('records the CLI each seat was launched with', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    await runUp(FILE, io, sources({}, made));
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.cli).toBe('claude-code');
    expect(seats['deepseek-acme']?.cli).toBe('claude-code');
    expect(seats['deepseek-acme-2']?.cli).toBe('claude-code');
  });

  test('a pane herdr lists only after the rename is named by its process, not waited out', async () => {
    // herdr 0.7.1 lists a jules pane as an agent only after `agent rename`; the agent list alone
    // would leave the seat unnamed until the 90 s idle deadline. The pane's foreground process
    // is the CLI the profile names, so the rename goes by pane id at once.
    const julesIdle = readFileSync(join(import.meta.dir, '../fixtures/jules/0.1.42/idle.txt'), 'utf8');
    const file = makeExample(
      base,
      root,
      EXAMPLE.replace('parked: true', 'stopped: true')
        + '\n  - role: implementer\n'
        + '    name: jules-acme\n'
        + '    cli: jules\n'
        + '    vendor: google\n'
        + '    model: Jules\n'
        + '    version: "0.1.42"\n'
        + '    launch: jules\n',
    );
    writeFileSync(join(root, '.agents/team.yaml'), file);
    await approve();
    const made = world((_pane, label) => (label === 'jules-acme · implementer' ? julesIdle : IDLE));
    let julesPane: string | null = null;
    const renamed = new Set<string>();
    const create = made.launch.createWorkspace.bind(made.launch);
    made.launch.createWorkspace = (session, cwd, label) => {
      const space = create(session, cwd, label);
      if (space && label === 'jules-acme · implementer') julesPane = space.pane;
      return space;
    };
    // Herdr's agent list: every launched pane but the jules one, which appears only once named.
    const listed = made.launch.agentPanes.bind(made.launch);
    made.launch.agentPanes = (session) => (listed(session) ?? []).filter((pane) => pane !== julesPane || renamed.has(pane));
    const rename = made.launch.renameAgent.bind(made.launch);
    made.launch.renameAgent = (session, pane, name) => {
      renamed.add(pane);
      return rename(session, pane, name);
    };
    const foreground = made.launch.foreground.bind(made.launch);
    made.launch.foreground = (session, pane) => (pane === julesPane ? ['jules'] : foreground(session, pane));
    const typed: string[] = [];
    made.launch.typeText = (_session, pane, text) => { typed.push(`${pane}:${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { typed.push(`${pane}:Enter`); return true; };

    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));

    expect(code).toBe(0);
    expect(julesPane).not.toBeNull();
    expect(renamed.has(julesPane!)).toBe(true);
    expect(made.renames).toContain('jules-acme');
    expect(io.out).toContain('jules-acme: ready\n');
    // Named at once, not after a poll: the old wait would have slept 90 s and left it out.
    expect(made.launch.now().getTime() - NOW.getTime()).toBeLessThan(2000);
    // Rules are prepended on this profile: nothing was typed into the pane.
    expect(typed).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['jules-acme']?.stage).toBe('ready');
    expect(seats['jules-acme']?.rules).toBe('prepend');
  });

  test('a permission prompt without a terminal closes that workspace and leaves the others', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    // Herdr's list and the pane's process: what the fresh launch's own dialog reads leave behind
    // for the close. The pane is unnamed in herdr (the rename never happened), on the list, and
    // its process is the one the dialog was found with — so the close is proven and happens.
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'claude',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    // §2: an owner whose stdin is not a terminal never prompts — the dialog's workspace is
    // closed without input, the record says why, and the other seats carry on.
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: permission (no terminal for owner)\n');
    expect(io.err).toContain('  its workspace was closed without input\n');
    // The record is what the log keeps; the close is its detail on stderr, never written.
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(
      'claude-coordinator-acme: left out: permission (no terminal for owner)',
    );
    expect(made.closes).toEqual(['w1']);
    expect(made.terminal.reads).toBe(0);
    expect(made.renames).toContain('claude-coordinator-acme');
    expect(made.renames).toContain('deepseek-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
    expect(seats['deepseek-acme']?.stage).toBe('ready');
  });

  test('the same close with no terminal is refused when the process changed under it', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'claude',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    // Every read sees another process: the one the dialog was found with is never the one the
    // close reads back, so the close can prove nothing and does not happen.
    let n = 0;
    made.launch.processInfo = () => ({ shell: 700 + ++n, foreground: [700 + n, 701 + n] });
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // §3: a workspace whose pane's process is not the one the dialog was found with is left
    // as it is — not closed, its record not cleared — and the reason is the stop pass's.
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('claude-coordinator-acme: left out: left as it is: its process changed\n');
    expect(made.terminal.reads).toBe(0);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    // The refusal keeps the launch's own reading — the first read, taken when the dialog was
    // found — so the record holds an identity to compare, never the changed read, which would
    // bless the replacement.
    expect(seats['claude-coordinator-acme']).toMatchObject({
      pane: 'w1:p1',
      workspace: 'w1',
      launched: { shell: 701, cli: [702] },
      waiting: { state: 'waiting-owner', classification: 'permission' },
    });
    // A later `up` whose recorded process is gone launches a fresh workspace and leaves this
    // one. That run is the leftover tests below; this one stops at the close the dialog refused.
  });

  // The state a refused close leaves behind, as the next `up` reads it. The waiting record keeps
  // the reading that stopped the close and the identity recorded at launch — never the fresh
  // read of the changed process, which would bless the replacement. Without the record the pane
  // falls to the ordinary paths again: an unnamed agent is refused session-wide, and a named one
  // that sits idle is adopted.
  test('the leftover of a refused close, its pane unnamed: the next up launches a fresh workspace', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w9:p1',
              workspace: 'w9',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'permission' },
            },
          },
          worktrees: {},
        },
      },
    }));
    const made = world();
    made.session = 'running';
    // The pane is unnamed, as a launch's pane is before its rename; herdr lists it, and only the
    // record's waiting entry makes it known. It holds the replacement process, not the launch's.
    made.seed('w9:p1', PERMISSION, true);
    made.launch.processInfo = () => ({ shell: 900, foreground: [900, 901] });
    const listed = (): HerdrAgent[] => [
      { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null },
    ];
    made.launch.agents = listed;
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      agents: listed,
      workspaces: () => [{ id: 'w9', label: 'claude-coordinator-acme · project coordinator' }],
    }, made));
    expect(code, io.out + io.err).toBe(0);
    // The recorded process is not the one in the pane. The old workspace is left, and the seat
    // is launched again; the old pids are not the new record.
    expect(io.out + io.err).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced');
    expect(io.out).not.toContain('left out: its waiting pane is gone');
    expect(made.terminal.reads).toBe(0);
    expect(made.closes).not.toContain('w9');
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat?.pane).not.toBe('w9:p1');
    expect(seat?.waiting).toBeUndefined();
    expect(seat?.launched).not.toEqual({ shell: 400, cli: [401] });
  });

  test('the same leftover, its pane named and idle and its record naming the launch: the next up launches fresh and does not adopt it', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w9:p1',
              workspace: 'w9',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'permission' },
            },
          },
          worktrees: {},
        },
      },
    }));
    const made = world();
    made.session = 'running';
    // The pane carries the seat's name and sits at its prompt, but its process is not the
    // launch's: the record's identity refuses it, and nothing here adopts it.
    made.seed('w9:p1', IDLE, true);
    made.launch.processInfo = () => ({ shell: 900, foreground: [900, 901] });
    const typed: string[] = [];
    made.launch.typeText = (_session, pane, text) => { typed.push(`${pane}:${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { typed.push(`${pane}:Enter`); return true; };
    const listed = (): HerdrAgent[] => [
      { name: 'claude-coordinator-acme', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null },
    ];
    made.launch.agents = listed;
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      agents: listed,
      workspaces: () => [{ id: 'w9', label: 'claude-coordinator-acme · project coordinator' }],
    }, made));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out + io.err).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced');
    expect(io.out).not.toContain('holds another process');
    expect(typed.filter((line) => line.startsWith('w9:'))).toEqual([]);
    expect(made.closes).not.toContain('w9');
    expect(made.terminal.reads).toBe(0);
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat?.pane).not.toBe('w9:p1');
    expect(seat?.waiting).toBeUndefined();
    expect(seat?.launched).not.toEqual({ shell: 400, cli: [401] });
  });

  test('the leftover of a refused close, its pane named and idle: the next up reads the record, never adopts it', async () => {
    await approve();
    // A launch whose process could not be read keeps no identity — the read the close would be
    // judged by gave nothing — so the record is the waiting entry alone. The pane carries the
    // seat's name and sits at its prompt: without the record the next `up` would finish it as a
    // live seat.
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w9:p1',
              workspace: 'w9',
              createdWorkspace: true,
              waiting: { state: 'waiting-owner', classification: 'permission' },
            },
          },
          worktrees: {},
        },
      },
    }));
    const made = world();
    made.session = 'running';
    made.seed('w9:p1', IDLE, true);
    const typed: string[] = [];
    made.launch.typeText = (_session, pane, text) => { typed.push(`${pane}:${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { typed.push(`${pane}:Enter`); return true; };
    const listed = (): HerdrAgent[] => [
      { name: 'claude-coordinator-acme', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null },
    ];
    made.launch.agents = listed;
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      agents: listed,
      workspaces: () => [{ id: 'w9', label: 'claude-coordinator-acme · project coordinator' }],
    }, made));
    expect(code).toBe(1);
    // The record's waiting entry is read before any idle reading: the seat is refused by the
    // proof, never adopted — nothing renames it, types into it or closes it, and it is not ready.
    expect(io.out).toContain('claude-coordinator-acme: left out: its waiting record has no process identity\n');
    expect(io.out).not.toContain('claude-coordinator-acme: ready');
    expect(io.err).toContain('  answer or close its dialog in its pane, then run `team down` then `team up` (to restart the whole team), to establish one by a run\n');
    expect(io.err).not.toContain('team remove');
    expect(made.renames).not.toContain('claude-coordinator-acme');
    expect(typed).toEqual([]);
    expect(made.closes).not.toContain('w9');
    expect(made.terminal.reads).toBe(0);
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat).toMatchObject({
      stage: 'launched',
      pane: 'w9:p1',
      workspace: 'w9',
      waiting: { state: 'waiting-owner', classification: 'permission' },
    });
    expect(seat?.rules).toBeUndefined();
  });

  test('a trust dialog without a terminal closes that workspace without an answer and leaves the seat out', async () => {
    await approve();
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? trust : IDLE));
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'claude',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // The record names the reading; the close is its stderr detail; the log keeps the record.
    const line = 'claude-coordinator-acme: left out: trust (no terminal for owner)';
    expect(io.out).toContain(`${line}\n`);
    expect(io.err).toContain('  its workspace was closed without input\n');
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(line);
    expect(made.closes).toEqual(['w1']);
    expect(made.terminal.reads).toBe(0);
    expect(made.renames).toContain('claude-coordinator-acme');
    expect(made.runs.some((run) => run.command.includes('Yes'))).toBe(false);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
  });

  // A close that fails is not a close: no line may claim one, and the seat keeps its state.
  test.each([
    ['trust', 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n', 'trust'],
    ['permission', PERMISSION, 'permission'],
    ['question', 'Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n', 'question'],
  ] as const)('a %s reading whose close fails leaves the seat as it is', async (_reading, screen, reading) => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? screen : IDLE));
    const closed: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => {
      closed.push(workspace);
      return false;
    };
    // Herdr's agent list names every pane whose CLI is running, renamed or not (the unrenamed
    // ones with a null name); the world's pane map is its source, so the pane this run just
    // launched is on it. The pause verifies the pane is still the seat's before `s` closes it.
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'claude',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    // The identity the pause's entry write records, and the process its close reads back: the
    // same one, so the close is proven — it is the closeWorkspace below that fails.
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    // At a terminal the run asks first and closes nothing alone (§3, safety rule); the owner
    // chooses skip, and only the close that follows is allowed to fail.
    made.terminal.keys.push('s');
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.err).toContain(`claude-coordinator-acme is waiting at ${reading}: [o] open pane, [s] skip seat, [q] stop cleanly\n`);
    // The record names the reading and the failed close; the log keeps the record alone.
    const line = `claude-coordinator-acme: left out: ${reading}; its workspace did not close; left as it is`;
    expect(io.out).toContain(`${line}\n`);
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(line);
    // It tried; nothing else claims the workspace was closed.
    expect(closed).toEqual(['w1']);
    expect(io.out).not.toContain('was closed');
    expect(io.err).not.toContain('was closed');
    // The seat's state is kept as it is — still recorded as waiting for its owner, exactly what
    // §5 exists to find — so a later `up` resumes the seat on its pane.
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toMatchObject({
      stage: 'launched',
      pane: 'w1:p1',
      workspace: 'w1',
      waiting: { state: 'waiting-owner', classification: reading },
    });
  });

  test('a seat that never idles stays launched, with the reading and the pane lines', async () => {
    await approve();
    // The screen of the capture this report is built from: the launch line's own echo, the
    // shell's failure, and the prompt back.
    const shown = "❯ zsh ../tools/launcher.sh\nzsh: can't open input file: ../tools/launcher.sh\n~ ❯\n";
    const made = world(shown);
    // §2, no terminal: a timeout is not a dialog, so the seat keeps today's record and nothing
    // is closed. (At a terminal the owner is asked about the timeout — its own tests.)
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: timeout\n');
    expect(io.err).toContain(
      '  timed out after 90 s waiting for its idle prompt; ' +
        'the screen last read unknown; left at launched\n',
    );
    expect(io.err).toContain('  | ❯ zsh ../tools/launcher.sh\n');
    expect(io.err).toContain("  | zsh: can't open input file: ../tools/launcher.sh\n");
    expect(io.err).toContain('  run `team up` again to resume it\n');
    expect(made.closes).toEqual([]);
    expect(made.renames).toEqual(['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2']);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
    // The log keeps the record only: the detail and the pane's text are said on the terminal,
    // never written.
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).toContain('claude-coordinator-acme: left out: timeout');
    expect(log).not.toContain('zsh');
  });

  test('a launch command that ended under the shell is reported once the bound elapses', async () => {
    await approve();
    const made = world();
    made.launch.shellBack = () => true;
    // Each pane shows the line that was run into it, the shell's failure, and the prompt back.
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      // The echo is cut to its first line, as the pane shows it when the command wraps.
      return command ? `❯ ${command.split('\n')[0]}\nzsh: command not found\n~ ❯\n` : read(session, pane);
    };
    let naps = 0;
    const napping = made.launch.sleep;
    made.launch.sleep = async (ms) => { naps++; return napping(ms); };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain(
      'claude-coordinator-acme: left out: its pane has been back at its shell for 24 s and shows no CLI prompt; left at launched\n',
    );
    // Twelve pauses per ended seat, three such seats — the twelve full polls the stretch takes —
    // not the 90-second deadline's worth of them.
    expect(naps).toBeLessThanOrEqual(36);
    expect(io.err).toContain('  | ❯ AGENT_UNATTENDED=1 claude --model claude-opus-5-5 ');
    expect(io.err).toContain('  | zsh: command not found\n');
    expect(io.err).toContain('  run `team up` again to resume it\n');
    expect(io.out).not.toContain('timed out');
    expect(io.err).not.toContain('timed out');
    // Left at launched, workspace kept: a later `up` resumes the seat.
    expect(made.closes).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
  });

  test('the captured stall: a shell holding the typed line is waited out to the CLI', async () => {
    await approve();
    // The captured race: a fresh pane's shell leaves the typed launch line unread for seconds
    // while the tty's echo sits on the screen — measured 8.9 s to 10.3 s across 7 of 24
    // synthetic trials, one verdict firing 60 ms before the pane's process appeared. The screen
    // drawn here is the capture's, not an accepted line: the command's echo with no shell-prompt
    // prefix, the continuation the capture shows, the shell's prompt row, and a bare `❯` — the
    // rig's reads of exactly these rows classified `unknown` through this repo's readScreen. The
    // stall is the longest captured one (10 265 ms) rounded down to the 2 s poll grid; the wait
    // must outlast it and see the CLI's idle screen instead of saying the end at the old bound.
    const made = world();
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const polls = new Map<string, number>();
    made.launch.shellBack = () => true;
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      if (!command) return read(session, pane);
      const n = (polls.get(pane) ?? 0) + 1;
      polls.set(pane, n);
      return n <= 5
        ? `${command.split('\n')[0]}\n… Protected checkouts, relative to the project root: .\n${home}/.config/team/lobby 16:16:23\n❯\n`
        : IDLE;
    };
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(io.err).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
  });

  test('a shell-back reading with no echo of the launch line is waited out', async () => {
    await approve();
    // The shell is back on every poll, but the screen never holds the launch line's echo: the
    // line may not have arrived, or the screen may be a fresh shell. That is not evidence the
    // launch ran and ended, so the wait goes to the deadline and the reading is a timeout.
    const made = world('restarted\n~ ❯\n');
    made.launch.shellBack = () => true;
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: timeout\n');
    expect(io.err).toContain('timed out after 90 s waiting for its idle prompt');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(io.err).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
  });

  test('the reviewed probe: two shell-back readings a poll apart, then idle, is not an end', async () => {
    await approve();
    // The review's own sample sequence at 7ede9fb4: unknown with the shell back at t=0 and
    // t=2000, then idle at t=4000, the pane still drawing and the launch line's echo nowhere on
    // it. The wait used to call the second reading an end, at clock 2000 and two reads in; it
    // must instead go on, so the CLI that was still starting is seen when it arrives.
    const made = world();
    const polls = new Map<string, number>();
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      if (pane !== 'w1:p1') return read(session, pane);
      const n = (polls.get(pane) ?? 0) + 1;
      polls.set(pane, n);
      return n <= 2 ? 'startup still drawing\n' : IDLE;
    };
    made.launch.shellBack = (_session, pane) => pane === 'w1:p1' && (polls.get(pane) ?? 0) <= 2;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(io.err).not.toContain('shows no CLI prompt');
    // The CLI arrived, so the seat is the state's ready — not left at launched by an early end.
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
  });

  test('one shell-back reading, even with the echo, never ends the wait', async () => {
    await approve();
    // The mutation the review found uncaught: letting a single shell-back sample end the wait.
    // One reading is not a stretch — a pane can show its shell for a moment between the launch
    // and the CLI's first draw — so the sample is only a start, and the deadline is the report.
    const made = world();
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      return command ? `❯ ${command.split('\n')[0]}\nstartup still drawing\n` : read(session, pane);
    };
    const seen = new Map<string, number>();
    made.launch.shellBack = (_session, pane) => {
      const n = (seen.get(pane) ?? 0) + 1;
      seen.set(pane, n);
      return n === 1;
    };
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: timeout\n');
    expect(io.err).toContain('timed out after 90 s waiting for its idle prompt');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(io.err).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
  });

  test('the wrapper that draws its CLI on the fourth poll is not reported as ended', async () => {
    await approve();
    // A slow start: a wrapper keeps the shell in front for three polls and the CLI draws on the
    // fourth. The shell-back reading must hold through the fourth reading —
    // three full poll intervals — before an end is said; two readings ended it at the second.
    const made = world();
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const polls = new Map<string, number>();
    made.launch.shellBack = (_session, pane) => {
      const n = (polls.get(pane) ?? 0) + 1;
      polls.set(pane, n);
      return n <= 3;
    };
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      if (!command) return read(session, pane);
      return (polls.get(pane) ?? 0) <= 3 ? `❯ ${command.split('\n')[0]}\nstartup still drawing\n` : IDLE;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(io.err).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
  });

  test('a shell-back reading that clears is not an end, and a herdr that cannot say waits', async () => {
    await approve();
    const made = world('');
    const seen = new Map<string, number>();
    // The first poll after the launch may still report the shell — captured on herdr 0.7.1 —
    // and later polls report nothing readable at all.
    made.launch.shellBack = (_session, pane) => {
      const n = (seen.get(pane) ?? 0) + 1;
      seen.set(pane, n);
      return n === 1 ? true : null;
    };
    const io = quietIo();
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: timeout\n');
    expect(io.err).toContain('timed out after 90 s waiting for its idle prompt');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(io.err).not.toContain('shows no CLI prompt');
    expect(made.closes).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
  });

  test('a recorded pane that is gone is launched again', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'claude-coordinator-acme': { stage: 'launched', pane: 'w9:p1', workspace: 'w9' } },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    const io = testIo(root, { kind: 'owner' });
    await runUp(FILE, io, sources({ sessionState: () => 'running', workspaces: () => [] }, made));
    expect(made.starts).toBe(0);
    expect(made.creates).toContain('claude-coordinator-acme · project coordinator');
    expect(made.runs.some((run) => run.pane === 'w9:p1')).toBe(false);
    expect(made.runs.some((run) => run.pane === 'w1:p1')).toBe(true);
  });

  test('a ready seat is left alone, and a launched one with a live pane is finished', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w8:p1', workspace: 'w8' },
              'deepseek-acme': { stage: 'launched', pane: 'w7:p1', workspace: 'w7' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, true);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [agent('claude-coordinator-acme', 'w8:p1'), agent('deepseek-acme', 'w7:p1')],
          workspaces: () => [{ id: 'w8', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w7', label: 'deepseek-acme · implementer' }],
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    // The state records no process for it, so the detail names the one per-seat register run
    // that records it — the coordinator's own seat included, and nothing relaunched.
    expect(io.err).toContain(
      '  already ready; left as it is; its process was never recorded: ' +
        'run team register claude-coordinator-acme to record it, nothing relaunched\n',
    );
    expect(made.creates).toEqual(['deepseek-acme-2 · implementer', watchLabel('acme-web')]);
    expect(made.renames).toContain('deepseek-acme');
    expect(made.renames).not.toContain('claude-coordinator-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['deepseek-acme']?.stage).toBe('ready');
  });

  // A record from 0.2.1 names the pane and not the process. The multiplexer restored that pane
  // as a shell, or as another model. `up` reports it and names the repair; it does not close
  // the pane and it does not launch the seat again.
  test('a ready seat with no process identity whose pane is a shell is left, and names abandon', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'claude-coordinator-acme': { stage: 'ready', pane: 'w8:p1', workspace: 'w8' } },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.launch.processInfo = () => ({ shell: 400, foreground: [400] });
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [agent('claude-coordinator-acme', 'w8:p1')],
          workspaces: () => [{ id: 'w8', label: 'claude opus 5.5' }],
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.err).toContain(
      '  its pane runs no CLI and its process was never recorded (team down --abandon, then team up)\n',
    );
    expect(io.err).not.toContain('its process was never recorded: run team register');
    expect(io.out).not.toContain('team up (it resumes the launch)');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
    expect(seats['claude-coordinator-acme']?.workspace).toBe('w8');
  });

  test('a ready seat with no process identity whose screen is another model is left, and names abandon', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'claude-coordinator-acme': { stage: 'ready', pane: 'w8:p1', workspace: 'w8' } },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w8:p1', `❯ \n${'─'.repeat(40)}\n  main · …/acme · Fable 5.1 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`, true);
    made.launch.processInfo = () => ({ shell: 400, foreground: [401] });
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [agent('claude-coordinator-acme', 'w8:p1')],
          workspaces: () => [{ id: 'w8', label: 'claude opus 5.5' }],
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.err).toContain(
      '  its screen runs Claude Fable 5.1; the file says Claude Opus 5.5; its process was never recorded (team down --abandon, then team up)\n',
    );
    expect(io.err).not.toContain('its process was never recorded: run team register');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
  });

  test('a launched seat with no process identity whose pane is a shell is not waited out', async () => {
    const path = join(root, '.agents/team.yaml');
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace('stopped: true\n', '')));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'codex-acme': { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w2:p1', 'user@host % \n', true);
    made.launch.processInfo = (_session, pane) =>
      pane === 'w2:p1' ? { shell: 400, foreground: [400] } : { shell: 900, foreground: [901] };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [agent('codex-acme', 'w2:p1', 'idle', 'codex')],
          workspaces: () => [{ id: 'w2', label: 'gpt sol 6' }],
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.out).toContain(
      'codex-acme: left out: its pane runs no CLI and its process was never recorded (team remove codex-acme --abandon, then team up)\n',
    );
    expect(io.out).not.toContain('timeout');
    expect(io.out).not.toContain('the screen last read unknown');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('gpt sol 6');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['codex-acme']?.stage).toBe('launched');
    expect(seats['codex-acme']?.pane).toBe('w2:p1');
  });

  // §3: the interrupted launch. `up` made the workspace and recorded the pane at `launched`, then
  // stopped before the rename, so herdr lists an agent with no name on the pane the state records.
  // That agent is the run's own half-finished seat, not a stranger: the filter knows it by the
  // recorded pane the way it knows `add`'s waiting pane, and the seat is finished — idle wait,
  // rename — the way the named one above is, instead of refusing the whole team.
  test('an unnamed agent on the pane a seat was left at launched with is finished, not refused', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w8:p1', workspace: 'w8' },
              'deepseek-acme': { stage: 'launched', pane: 'w7:p1', workspace: 'w7' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, true);
    // Herdr's list as the interruption leaves it: the agent on the recorded pane carries no name,
    // so the state's record is the only thing that knows the pane is this run's own.
    const listed = (): HerdrAgent[] => [
      agent('claude-coordinator-acme', 'w8:p1'),
      { name: null, agent: 'deepseek', pane: 'w7:p1', workspace: 'w7', status: 'idle', cwd: null },
    ];
    const passed = {
      sessionState: () => 'running' as const,
      agents: listed,
      workspaces: () => [{ id: 'w8', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w7', label: 'deepseek-acme · implementer' }],
    };
    const plan = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run', ...FILE], plan, sources(passed, made))).toBe(0);
    expect(plan.out).not.toContain("doesn't record");
    // The plan carries the wait and the rename for that seat: it is resumed, not left out.
    expect(plan.out).toContain('  wait until deepseek-acme shows its idle prompt');
    expect(plan.out).toContain('+ herdr --session acme-web agent rename w7:p1 deepseek-acme\n');
    // The run finishes it the same way: the rename happens, and the record ends `ready`.
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources(passed, made))).toBe(0);
    expect(io.out + io.err).not.toContain("doesn't record");
    expect(made.renames).toContain('deepseek-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['deepseek-acme']?.stage).toBe('ready');
    expect(seats['deepseek-acme']?.pane).toBe('w7:p1');
  });

  // The incident's session, ready to resume: the Codex seat at `named` with its pane and workspace
  // recorded and its box showing `screen`, the coordinator ready. The file puts the DeepSeek pair out.
  function incident(screen: string): World {
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(
        base,
        root,
        EXAMPLE.replace('    stopped: true\n', '')
          .replace(
            '    count: 2                   # deepseek-acme, deepseek-acme-2\n',
            '    count: 2                   # deepseek-acme, deepseek-acme-2\n    stopped: true\n',
          ),
      ),
    );
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(namedState()));
    const made = world();
    made.session = 'running';
    made.seed('w2:p1', screen, true);
    return made;
  }

  /** The seats the fixture's file declares: its own four, and the counted second deepseek. */
  const BRIEFED_SEATS = ['claude-coordinator-acme', 'codex-acme', 'deepseek-acme', 'deepseek-acme-2', 'grok-acme'];

  /** The session's `briefs` map as a session delivered under this build leaves it: a current
   *  claim per seat, its id derived from the text, and the run's own time. */
  function briefs() {
    const incarnation = 'inc_0123456789ab';
    const epoch = 'run_0123456789ab';
    const id = generalBriefId(incarnation, generalBriefBody());
    return Object.fromEntries(BRIEFED_SEATS.map((seat) => [seat, {
      id,
      at: NOW.toISOString(),
      incarnation,
      epoch,
      sha256: GENERAL_BRIEF_SHA256,
      attempt: 0,
      stage: 'ready' as const,
    }]));
  }

  /** The scene's state after the run: the incident seat's own record is held still, and every
   *  seat holds a current claim — a delivery mints a fresh lifetime, so the claims are read as
   *  claims rather than compared byte for byte. */
  function expectStateHeld(): void {
    const after = JSON.parse(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')) as {
      sessions: Record<string, { seats: unknown; worktrees: unknown; watch: unknown }>;
    };
    const expected = JSON.parse(JSON.stringify(namedState())) as { sessions: Record<string, { seats: unknown; worktrees: unknown; watch: unknown }> };
    expect(after.sessions['acme-web']?.seats).toEqual(expected.sessions['acme-web']?.seats);
    expect(after.sessions['acme-web']?.worktrees).toEqual(expected.sessions['acme-web']?.worktrees);
    expect(after.sessions['acme-web']?.watch).toEqual(expected.sessions['acme-web']?.watch);
    const claims = readState(join(root, '.agents')).sessions['acme-web']?.briefs ?? {};
    for (const seat of BRIEFED_SEATS) {
      expect(currentBriefClaim(claims[seat])).not.toBeNull();
    }
  }

  function namedState() {
    return {
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
            'codex-acme': { stage: 'named', pane: 'w2:p1', workspace: 'w2', start_cwd: '.' },
          },
          briefs: briefs(),
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    };
  }

  function resumed(made: World): UpSources {
    return sources(
      {
        sessionState: () => 'running',
        agents: () => [agent('claude-coordinator-acme', 'w1:p1'), agent('codex-acme', 'w2:p1')],
        workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'codex-acme · implementer' }],
        alive: () => true,
        watchCommand: () => 'team watch',
      },
      made,
    );
  }

  const captureCodex = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');

  test('the incident: a named seat whose box holds an unsent message is left as it is on the next up', async () => {
    const made = incident(captureCodex('unsent'));
    await approve();
    const sent: string[] = [];
    made.launch.agentStatus = () => 'idle';
    made.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(made));
    // The box reads `unsent` and does not hold the rules line: nothing is typed, no key is
    // sent, no workspace is closed, and the seat's state is left byte for byte as it was.
    expect(code).toBe(1);
    expect(io.out).toContain(
      'codex-acme: left out: rules not typed: its box already holds text that is not the rules line; '
      + 'press Enter in its pane to send what is there, or clear its box (Ctrl+U), then run up again\n',
    );
    expect(sent).toEqual([]);
    expect(made.closes).toEqual([]);
    expectStateHeld();
  });

  test("the incident's other face: a box holding the CLI's own exit text is named, not typed onto", async () => {
    // The same shape one step further: the unsent text is exactly the CLI's exit text, typed
    // by an earlier stop that never confirmed it. Enter would send the exit and a clearing key
    // is the owner's press, not this run's — nothing is sent, and the line names the text and
    // the one key for it.
    const made = incident(captureCodex('exit-typed'));
    await approve();
    const sent: string[] = [];
    made.launch.agentStatus = () => 'idle';
    made.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(made));
    expect(code).toBe(1);
    expect(io.out).toContain(
      "codex-acme: left out: rules not typed: its box already holds this CLI's exit text (/exit), "
      + 'unsent from an earlier stop; press Ctrl+U in its pane to clear it, then run up again\n',
    );
    expect(sent).toEqual([]);
    expect(made.closes).toEqual([]);
    expectStateHeld();
  });

  test('a named seat whose box is empty and idle is delivered to on the next up', async () => {
    const made = incident(captureCodex('idle'));
    await approve();
    const calls: string[] = [];
    let typedPane = '';
    let typed = '';
    let pasted = false;
    let status = 'idle';
    const read = made.launch.paneText;
    // The pane with the paste rendered: the idle frame's placeholder row replaced by the typed
    // message, later lines at the prompt's own column, as the fixtures README describes.
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return captureCodex('idle').replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.foreground = (_session, pane) => { calls.push(`foreground ${pane}`); return ['codex']; };
    made.launch.agentStatus = (_session, pane) => { calls.push(`agentStatus ${pane}`); return pane === typedPane ? status : 'idle'; };
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText ${pane}`);
      return pane === typedPane ? (pasted ? boxed() : captureCodex('working')) : read(session, pane);
    };
    made.launch.typeText = (_session, pane, text) => { calls.push(`typeText ${pane}`); typedPane = pane; typed = text; pasted = true; return true; };
    made.launch.pressEnter = (_session, pane) => { calls.push(`pressEnter ${pane}`); pasted = false; status = 'working'; return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(made));
    expect(code).toBe(0);
    expect(io.out).toContain('codex-acme: ready');
    expect(made.closes).toEqual([]);
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'];
    expect(seat).toMatchObject({ stage: 'ready', rules: 'message', pane: 'w2:p1', workspace: 'w2' });
    // The delivery's order of host calls: the pane's program, its status — one read, the
    // mid-turn gate and freedom together — and its box; the line is typed into the empty box,
    // the status and the box are read again before the re-check, the re-check reads the
    // program, the status and the box again, the file gets its last look, one Enter is sent,
    // then the closing readings.
    expect(calls).toEqual([
      'foreground w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'typeText w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'foreground w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'pressEnter w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
    ]);
  });

  test('a named seat whose box holds exactly what team would type now is sent, never typed onto', async () => {
    const made = incident(captureCodex('idle'));
    await approve();
    // The message team would type now, taken from team itself: the empty box is delivered to once.
    let typed = '';
    let typedPane = '';
    let pasted = false;
    let status = 'idle';
    const read = made.launch.paneText;
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return captureCodex('idle').replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.agentStatus = (_session, pane) => (pane === typedPane ? status : 'idle');
    made.launch.typeText = (_session, pane, text) => { typedPane = pane; typed = text; pasted = true; return true; };
    made.launch.pressEnter = () => { pasted = false; status = 'working'; return true; };
    made.launch.paneText = (session, pane) => (pane === typedPane ? (pasted ? boxed() : captureCodex('working')) : read(session, pane));
    expect(await runUp(FILE, testIo(root, { kind: 'owner' }), resumed(made))).toBe(0);
    expect(typed).not.toBe('');

    // The seat is at `named` again, its box holding exactly the message team just typed.
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(namedState()));
    const again = world();
    again.session = 'running';
    again.seed('w2:p1', boxed(), true);
    const calls: string[] = [];
    const sent: string[] = [];
    again.launch.foreground = (_session, pane) => { calls.push(`foreground ${pane}`); return ['codex']; };
    again.launch.agentStatus = (_session, pane) => { calls.push(`agentStatus ${pane}`); return 'idle'; };
    const reread = again.launch.paneText;
    again.launch.paneText = (session, pane) => { calls.push(`paneText ${pane}`); return reread(session, pane); };
    again.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    again.launch.pressEnter = (_session, pane) => { calls.push(`pressEnter ${pane}`); sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(again));
    expect(code).toBe(1);
    expect(io.out).toContain(
      'codex-acme: left out: rules typed, not sent: its box still holds the line after Enter; '
      + 'press Enter in its pane to send it, or clear the box (Ctrl+U), then run up again\n',
    );
    // The resume verifies the box and presses Enter; this stub's pane never takes the key, so
    // the submit is retried while the box still reads back as the line — RULES_ENTER_TRIES
    // presses in all — and nothing else is ever typed.
    expect(sent).toEqual(Array<string>(RULES_ENTER_TRIES).fill('Enter'));
    expect(again.closes).toEqual([]);
    expectStateHeld();
    const enter = calls.indexOf('pressEnter w2:p1');
    expect(enter).toBeGreaterThan(-1);
    expect(calls.slice(0, enter + 1)).toEqual([
      'foreground w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'paneText w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'foreground w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'pressEnter w2:p1',
    ]);
    const after = calls.slice(enter + 1);
    expect(after).not.toContain('typeText w2:p1');
    expect(after.filter((call) => call === 'pressEnter w2:p1').length).toBe(RULES_ENTER_TRIES - 1);
    expect([...new Set(after)].sort()).toEqual(['agentStatus w2:p1', 'foreground w2:p1', 'paneText w2:p1', 'pressEnter w2:p1']);
  });

  test('a resumed seat is checked where its pane runs, not where the file would put it; its record and log hold no folder', async () => {
    // The file's deepseek seats work in worktrees and would start in the lobby; their recorded
    // panes run in the project root, where `../tools/x.sh` is a file. Only the state's `start_cwd`
    // says so, and the reading names that folder — the same line, a different folder, a different end.
    writeFileSync(
      join(root, '.agents/team.yaml'),
      EXAMPLE
        .replace('launch: team-deepseek\n    count: 2', 'launch: zsh ../tools/x.sh\n    count: 2')
        .replace(/trust:.*\n(?:  - .*\n)+/, `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n`),
    );
    await approve();
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const lobby = join(base, 'worktrees', 'acme-web', '.lobby');
    const run = async (start_cwd?: string) => {
      const recorded = (pane: string, workspace: string) => ({
        stage: 'launched',
        pane,
        workspace,
        ...(start_cwd ? { start_cwd } : {}),
      });
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: {
            'acme-web': {
              seats: { 'deepseek-acme': recorded('w7:p1', 'w7'), 'deepseek-acme-2': recorded('w6:p1', 'w6') },
              worktrees: {},
            },
          },
        }),
      );
      const made = world();
      made.session = 'running';
      made.seed('w7:p1', IDLE, false);
      made.seed('w6:p1', IDLE, false);
      const io = testIo(root, { kind: 'owner' });
      const code = await runUp(
        FILE,
        io,
        sources(
          {
            sessionState: () => 'running',
            agents: () => [],
            workspaces: () => [{ id: 'w7', label: 'deepseek-acme · implementer' }, { id: 'w6', label: 'GPT-6 Sol' }],
            doctor: doctor(),
          },
          made,
        ),
      );
      return { code, out: io.out, err: io.err };
    };
    // The root is where the panes run: the line resolves, the seats are resumed, nothing is refused.
    const atRoot = await run(root);
    expect(atRoot.code).toBe(0);
    expect(atRoot.out).toContain('deepseek-acme: ready');
    expect(atRoot.out).not.toContain('would refuse');
    expect(atRoot.err).not.toContain('launch line was not checked');
    // The lobby — where the file's own seats would start — is where it does not resolve: refused at
    // the recorded folder, with the file that is at the project root named for the line to use.
    const atLobby = await run(lobby);
    expect(atLobby.code).toBe(1);
    // The record holds the finding in words; the full sentence — the folder the check looked
    // in and the path to write — is stderr detail, for the owner's terminal alone.
    const words = 'its launch line runs `../tools/x.sh`, not found from its start folder';
    expect(atLobby.out).toContain(`deepseek-acme: left out: refused: ${words}\n`);
    expect(atLobby.err).toContain(
      `  ${words} ${lobby}; the same file is at \`${join(base, 'tools', 'x.sh')}\` from the project root — write that path\n`,
    );
    // The log's bytes: the record's words and no folder — not the one the check looked in, not
    // the one to write — because the folder is terminal detail alone, whatever the terminal
    // prints just above.
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).toContain(`deepseek-acme: left out: refused: ${words}`);
    expect(log).not.toContain(lobby);
    expect(log).not.toContain(join(base, 'tools'));
  });

  test('a launch-line miss is cleaned once, before the log and the writer: no control, escape or bidi byte is logged', async () => {
    // A launch word holding ESC and U+202E — both written as YAML escapes in a double-quoted
    // scalar, so the file holds them. The record, the log line and the terminal line are the
    // same cleaned words; before this, the log was written from the raw record, and its bytes
    // held `1b` (and `e2 80 ae`).
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(base, root, EXAMPLE.replace('launch: claude --model claude-opus-5-5', 'launch: "./aa\\ebb\\u202ecc"')),
    );
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ doctor: doctor() }, made));
    expect(code).toBe(1);
    // The record the seat's machine printed, and the terminal line: the same words.
    expect(io.out).toContain(
      'claude-coordinator-acme: left out: refused: its launch line starts `./aabcc`, not found from its start folder\n',
    );
    expect(io.err).toContain('  its launch line starts `./aabcc`, not found from its start folder .\n');
    expect(io.out).not.toContain('\x1b');
    expect(io.err).not.toContain('\x1b');
    expect(io.err).not.toContain('\u202e');
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).toContain('up [owner] claude-coordinator-acme: left out: refused: its launch line starts `./aabcc`, not found from its start folder\n');
    expect(log).not.toContain('\x1b');
    expect(log).not.toContain('\u202e');
    for (const byte of Buffer.from(log, 'utf8')) expect(byte === 0x0a || byte >= 0x20).toBe(true);
  });

  test('the launch-line note is the writer’s detail line: an escape byte in the word is cleaned at the writer', async () => {
    // The note carries the file's own word (an argument this time, so the line is told, never
    // refused). The word reaches the terminal only through the writer's detail line, cleaned.
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(base, root, EXAMPLE.replace('launch: claude --model claude-opus-5-5', 'launch: "claude --model claude-opus-5-5 ./aa\\ebb"')),
    );
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ doctor: doctor() }, made));
    expect(code).toBe(0);
    expect(io.err).toContain(
      '  note claude-coordinator-acme: its launch line runs `./aab`, not found from its start folder .; not checked: the command may create it\n',
    );
    expect(io.err).not.toContain('\x1b');
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).not.toContain('\x1b');
    expect(log).not.toContain('./aab');
  });

  test('a file error carries the file\'s own string cleaned: no escape byte reaches the terminal', async () => {
    // The coordinator names no declared seat, refused while the file is loaded. The name the file
    // holds carries ESC — a YAML escape inside the double-quoted scalar — and the sentence the
    // terminal shows is the name cleaned: the writers clean by construction, not by what the
    // message's own caller remembered to do.
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(base, root, EXAMPLE.replace('coordinator: claude-coordinator-acme', 'coordinator: "x\\u001b[31my"')),
    );
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ doctor: doctor() }, world()));
    expect(code).toBe(2);
    expect(io.err).toBe('team up: line 5: coordinator "xy" names no declared seat\n');
    expect(io.err).not.toContain('\x1b');
    expect(io.out).toBe('');
  });

  test('a dry run plan carries the file\'s own launch word cleaned: no escape byte in the plan', async () => {
    // The launch line's last word holds ESC (again a YAML escape) and is only an argument, so the
    // seat launches and the plan prints its `pane run` command: the plan holds the word cleaned.
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(base, root, EXAMPLE.replace('launch: claude --model claude-opus-5-5', 'launch: "claude --model claude-opus-5-5 ./aa\\ebb"')),
    );
    await approve();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--dry-run', ...FILE], io, sources({ doctor: doctor() }, world()));
    expect(code).toBe(0);
    expect(io.out).toContain('./aab');
    expect(io.out).not.toContain('\x1b');
    expect(io.out).toContain('dry run: nothing was run\n');
  });

  test('a resumed seat whose state records no start folder is not checked at all', async () => {
    writeFileSync(
      join(root, '.agents/team.yaml'),
      EXAMPLE
        .replace('launch: team-deepseek\n    count: 2', 'launch: zsh ../tools/x.sh\n    count: 2')
        .replace(/trust:.*\n(?:  - .*\n)+/, `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n`),
    );
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'deepseek-acme': { stage: 'launched', pane: 'w7:p1', workspace: 'w7' },
              'deepseek-acme-2': { stage: 'launched', pane: 'w6:p1', workspace: 'w6' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, false);
    made.seed('w6:p1', IDLE, false);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [],
          workspaces: () => [{ id: 'w7', label: 'deepseek-acme · implementer' }, { id: 'w6', label: 'GPT-6 Sol' }],
          doctor: doctor(),
        },
        made,
      ),
    );
    // The file's folder is not where those panes are, so the lines are not read against either:
    // they are said to be unchecked, and the seats resume as they always did.
    expect(code).toBe(0);
    expect(io.err).toContain(
      '  note deepseek-acme: its launch line was not checked: the seat is resumed and its state records no start folder\n',
    );
    expect(io.out).toContain('deepseek-acme: ready');
    expect(io.out).not.toContain('would refuse');
  });

  test('a stopped session is refused and no server is started', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'stopped' }, made));
    expect(code).toBe(1);
    expect(io.err).toBe('team up: session acme-web is stopped\n');
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
  });

  // A stopped session the state does not record is refused, and the line names that session.
  test('a stopped session the state does not record is refused by its name', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--session', 'beta-team', ...FILE], io, sources(
      { sessionState: (session) => (session === 'beta-team' ? 'stopped' : 'absent') },
      made,
    ));
    expect(code).toBe(1);
    expect(io.err).toBe('team up: session beta-team is stopped\n');
    expect(made.starts).toBe(0);
  });

  // Whatever sits in a `stopped` field — a shape `down` once wrote, or anything else — is not
  // what decides the clear. The session key in this team's state does: `up` deletes that
  // stopped session and starts it.
  test.each([
    ['the shape a stop once wrote', { at: NOW.toISOString(), by: 'owner' }],
    ['a boolean', true],
    ['a string', 'stopped'],
  ] as [string, unknown][])('a state file whose stopped field is %s is cleared and started', async (_what, stopped) => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({ format: 1, sessions: { 'acme-web': { seats: {}, worktrees: {}, stopped } } }),
    );
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'stopped' }, made));
    expect(code).toBe(0);
    expect(made.deletes).toEqual(['acme-web']);
    expect(made.starts).toBe(1);
    expect(io.err).not.toContain('herdr session delete');
  });

  test.each([
    { name: 'a lower seat limit', stored: { seats: 6, vendor: 3 }, live: { seats: 1, vendor: 3 }, count: 1, refusal: 'the file allows 1 seats; 2 would be running' },
    { name: 'a higher seat limit', stored: { seats: 1, vendor: 3 }, live: { seats: 6, vendor: 3 }, count: 3, refusal: null },
    { name: 'a seat limit without a record', stored: null, live: { seats: 1, vendor: 3 }, count: 1, refusal: 'the file allows 1 seats; 2 would be running' },
    { name: 'a lower vendor limit', stored: { seats: 6, vendor: 3 }, live: { seats: 6, vendor: 1 }, count: 2, refusal: 'the file allows 1 deepseek seats; 2 would be running' },
    { name: 'a higher vendor limit', stored: { seats: 6, vendor: 1 }, live: { seats: 6, vendor: 3 }, count: 3, refusal: null },
    { name: 'a vendor limit without a record', stored: null, live: { seats: 6, vendor: 1 }, count: 2, refusal: 'the file allows 1 deepseek seats; 2 would be running' },
  ])('up follows the live file: $name', async ({ stored, live, count, refusal }) => {
    const path = join(root, '.agents/team.yaml');
    const fileWith = (limits: { seats: number; vendor: number }) => makeExample(base, root)
      .replace('~/.config/team/lobby', join(home, '.config/team/lobby'))
      .replace('  seats: 6 ', `  seats: ${limits.seats} `)
      .replace('deepseek: 3', `deepseek: ${limits.vendor}`);
    if (stored) {
      writeFileSync(path, fileWith(stored));
      await approve();
    }
    writeFileSync(path, fileWith(live));
    const before = readApproval(store());
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code, io.err + io.out).toBe(refusal ? 1 : 0);
    const names = ['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2'];
    const labels = ['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer'];
    expect(made.creates.filter((label) => label !== watchLabel('acme-web'))).toEqual(labels.slice(0, count));
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    for (const name of names.slice(0, count)) expect(seats[name]?.stage, name).toBe('ready');
    for (const name of names.slice(count)) expect(seats[name]?.stage, name).not.toBe('ready');
    if (refusal) expect(io.out).toContain(refusal);
    else expect(io.out).not.toContain('the file allows');
    expect(readFileSync(path, 'utf8')).toBe(fileWith(live));
    expect(readApproval(store())).toEqual(before);
  });

  test('a machine past the file refuses before any server starts', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          machine: () => ({ loadPerCore: 9, memoryFree: 80, diskFree: 1e12, swapTotal: 2e12, swapFree: 1e12, swapUsed: 0 }),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.err).toContain('the load is 9.0 per core, above 3');
    expect(made.starts).toBe(0);
  });

  test('each start limit refuses with its figure, and a dry run prints that refusal', async () => {
    await approve();
    const cases: { machine: Machine; text: string }[] = [
      { machine: { ...fine, memoryFree: 10 }, text: 'free memory is 10%, below 25%' },
      { machine: { ...fine, pressure: 'critical' }, text: 'memory pressure is critical' },
      { machine: { ...fine, diskFree: 5e9 }, text: 'free disk is 5.0 GB, below 10.0 GB' },
    ];
    for (const item of cases) {
      const dry = testIo(root, { kind: 'owner' });
      await runUp(['--dry-run', ...FILE], dry, sources({ machine: () => item.machine, sessionRunning: () => false }, world()));
      expect(dry.out).toContain(`! up would refuse: ${item.text}`);
      const made = world();
      const io = testIo(root, { kind: 'owner' });
      expect(await runUp(FILE, io, sources({ machine: () => item.machine }, made))).toBe(1);
      expect(io.err).toContain(item.text);
      expect(made.starts).toBe(0);
    }
  });

  test('a machine refusal writes one line with the printed refusal and its readings', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const machine: Machine = { loadPerCore: 1, memoryFree: 69, diskFree: 200e9, swapTotal: 8.2e9, swapFree: 1.2e9, swapUsed: 7e9, pressure: 'critical' };
    expect(await runUp(FILE, io, sources({ machine: () => machine }, made))).toBe(1);
    expect(io.err).toContain('memory pressure is critical');
    const lines = readFileSync(join(root, '.agents', 'team.log'), 'utf8').split('\n')
      .filter((line) => line.includes('refused: memory pressure is critical'));
    expect(lines).toEqual([
      '2026-10-03T14:02:00.000Z up [owner] refused: memory pressure is critical — readings: load 1.0/core, memory 69%, disk 200000000000 B free, pressure critical, swap used 7000000000 B of 8200000000 B (free 1200000000 B)',
    ]);
  });

  test('a caller refused before the gate writes nothing, and a dry run writes nothing', async () => {
    await approve();
    const refusing = { ...fine, pressure: 'critical' as const };
    // A seat may not run `up`; the machine gate below the caller gate still reads and refuses —
    // and this call leaves the files as they were, so the log gains nothing.
    const seat = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1' });
    expect(await runUp(FILE, seat, sources({ machine: () => refusing }, world()))).toBe(1);
    expect(seat.err).toBe('deny\n');
    let log = existsSync(join(root, '.agents', 'team.log')) ? readFileSync(join(root, '.agents', 'team.log'), 'utf8') : '';
    expect(log).not.toContain('readings:');
    // A dry run decides nothing — its refused run exits as the real one, and it writes nothing.
    const dry = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run', ...FILE], dry, sources({ machine: () => refusing }, world()))).toBe(1);
    expect(dry.out).toContain('! up would refuse: memory pressure is critical');
    log = existsSync(join(root, '.agents', 'team.log')) ? readFileSync(join(root, '.agents', 'team.log'), 'utf8') : '';
    expect(log).not.toContain('readings:');
  });

  test('a reading that crosses mid-up writes its line at that refusal too', async () => {
    await approve();
    let reads = 0;
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      machine: () => {
        reads += 1;
        return { ...fine, swapUsed: reads >= 4 ? 3e9 : 1e9 };
      },
    }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('swap grew by 2.0 GB in 10 minutes, above 1.0 GB');
    // Every seat this reading left out is one refusal — and so exactly one line, no more.
    const printed = io.out.split('\n').filter((line) => line.includes('left out: swap grew by '));
    expect(printed.length).toBeGreaterThan(0);
    const lines = readFileSync(join(root, '.agents', 'team.log'), 'utf8').split('\n')
      .filter((line) => line.includes('refused: swap grew by '));
    expect(lines).toHaveLength(printed.length);
    for (const line of lines) {
      // The sentence byte for byte; the stamp is the run's own clock, so only its shape is pinned.
      const [stamp, ...rest] = line.split(' ');
      expect(stamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(rest.join(' ')).toBe('up [owner] refused: swap grew by 2.0 GB in 10 minutes, above 1.0 GB — readings: load 1.0/core, memory 50%, disk 200000000000 B free, pressure normal, swap used 3000000000 B of 9000000000 B (free 8000000000 B)');
    }
  });

  test('a log that cannot be written changes nothing: the refusal prints and the exit stands', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const machine: Machine = { loadPerCore: 1, memoryFree: 69, diskFree: 200e9, swapTotal: 8.2e9, swapFree: 1.2e9, swapUsed: 7e9, pressure: 'critical' };
    // The approval wrote its own team.log line; replace the file with a directory, so the
    // readings write can only fail — and the command's own work must be untouched by the log's
    // trouble: the refusal prints, the exit is the refusal's.
    rmSync(join(root, '.agents', 'team.log'), { force: true });
    mkdirSync(join(root, '.agents', 'team.log'), { recursive: true });
    expect(await runUp(FILE, io, sources({ machine: () => machine }, made))).toBe(1);
    expect(io.err).toContain('memory pressure is critical');
    expect(made.starts).toBe(0);
  });

  test('a reading that crosses mid-up stops before the next seat', async () => {
    await approve();
    let reads = 0;
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      machine: () => {
        reads += 1;
        return { ...fine, swapUsed: reads >= 4 ? 3e9 : 1e9 };
      },
    }, made));
    expect(code).toBe(1);
    expect(made.creates).toContain('claude-coordinator-acme · project coordinator');
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    expect(made.creates).not.toContain('deepseek-acme-2 · implementer');
    expect(io.out).toContain('deepseek-acme: left out: swap grew by 2.0 GB in 10 minutes, above 1.0 GB');
  });

  test('readings inside every limit launch the seats', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({ machine: () => fine }, made))).toBe(0);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', watchLabel('acme-web')]);
  });

  test('free swap under the file does not refuse up on its own', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({ machine: () => ({ ...fine, swapFree: 1.2e9 }) }, made))).toBe(0);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', watchLabel('acme-web')]);
  });

  test("a doctor miss refuses, and the watch's missing heartbeat does not", async () => {
    await approve();
    const missingIo = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run', ...FILE], missingIo, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctor({ version: () => null }),
    });
    expect(missingIo.out).toContain('! up would refuse: install `claude`: it is not on the PATH');

    const heartbeatIo = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run', ...FILE], heartbeatIo, {
      sessionRunning: () => true,
      agents: () => [],
      home,
      doctor: doctor({ sessionRunning: () => true }),
    });
    expect(heartbeatIo.out).not.toContain('! up would refuse');
    expect(heartbeatIo.out).not.toContain('no watch has run');
  });
});

// The session mutator lock: one session-mutating run per session at a time. `up` takes it — the
// seat-lock file under the name no seat can have, a leading dot — held for exactly the length of
// a run that has effects, so a second run in another terminal is told instead of both reading
// the same state and launching over each other. `add`, `down` and `remove` take the same lock
// (their own tests), so a dry run and a refused run never take it, a live holder's lock is never
// touched, and a lock a killed run left is taken over by the next one.
describe('team up, one run at a time', () => {
  const lockFile = () => seatLockPath(join(root, '.agents'), 'acme-web', '.run');
  const hold = (token: string): void => {
    mkdirSync(join(root, '.agents', 'seat-locks', 'acme-web'), { recursive: true });
    writeFileSync(lockFile(), token);
  };

  test("a second run is refused, with the holder's pid, before any effect", async () => {
    await approve();
    hold(`${process.pid} 0a1b2c3d\n`);
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({}, made))).toBe(1);
    expect(io.err).toBe(
      `team up: another session-mutating run is holding session acme-web (pid ${process.pid}); try again when it is done\n`,
    );
    expect(io.out).toBe('');
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
    // A live holder's lock is left exactly as it was: dropping it is never the refused run's.
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('a dry run plans while another run holds the lock: it takes nothing', async () => {
    await approve();
    hold(`${process.pid} 0a1b2c3d\n`);
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run', ...FILE], io, sources({}, made))).toBe(0);
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(io.out).not.toContain('would refuse');
    expect(made.starts).toBe(0);
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('a dry run beside a held run lock exits 0 with its plan while the real run exits with the lock refusal', async () => {
    await approve();
    const token = `${process.pid} 0a1b2c3d\n`;
    hold(token);
    const real = world();
    const realIo = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, realIo, sources({}, real))).toBe(1);
    expect(realIo.err).toBe(
      `team up: another session-mutating run is holding session acme-web (pid ${process.pid}); try again when it is done\n`,
    );
    expect(real.starts).toBe(0);
    const dryMade = world();
    const dryIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run', ...FILE], dryIo, sources({}, dryMade))).toBe(0);
    expect(dryIo.out).toContain('dry run: nothing was run\n');
    expect(dryIo.out).not.toContain('another session-mutating run');
    expect(dryIo.err).toBe('');
    expect(dryMade.starts).toBe(0);
    expect(readFileSync(lockFile(), 'utf8')).toBe(token);
  });

  test('a lock that cannot be read refuses with the file to clear', async () => {
    await approve();
    hold('not a token\n');
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({}, made))).toBe(1);
    // An unreadable lock is held, never stale (`seat-lock.ts`), so the owner is the only way
    // out and the message names the file.
    expect(io.err).toBe(
      'team up: another session-mutating run may be holding session acme-web, and its lock cannot be read; '
        + `if no run is using it, delete ${lockFile()}\n`,
    );
    expect(made.starts).toBe(0);
  });

  test('a lock left by a dead run is taken over, held through the run, and released by it', async () => {
    await approve();
    const dead = spawnSync('sh', ['-c', 'exit 0']).pid;
    expect(typeof dead).toBe('number');
    hold(`${dead} 0a1b2c3d\n`);
    const made = world();
    // What a second run would find at each effect of this one: the lock file, held.
    const held: boolean[] = [];
    const create = made.launch.createWorkspace;
    made.launch.createWorkspace = (session, cwd, label) => {
      held.push(existsSync(lockFile()));
      return create(session, cwd, label);
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({}, made))).toBe(0);
    expect(made.starts).toBe(1);
    expect(held.length).toBeGreaterThan(0);
    expect(held).not.toContain(false);
    // Taken over for the run, and gone the moment the run is: the next run takes it again.
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a second run with the lobby absent is refused by the lock before it makes anything', async () => {
    await approve();
    const made = world();
    hold(`${process.pid} 0a1b2c3d\n`);
    // The winner lands between this run's read-only look at the lobby and any make of this
    // run's own: the lobby appears, 0700 as the gate makes it, the moment it is read absent.
    // While the make sat before the lock, this losing run made the component itself and met
    // the winner's lobby — `failed to create …: EEXIST`, a refusal it never earned, with no
    // lock and no other run named. Now the lock is the only thing this run can meet first.
    const lobby = join(home, '.config', 'team', 'lobby');
    let read = false;
    let makes = 0;
    const fs = {
      ...defaultFs,
      lstat: (path: string) => {
        if (!read && path === lobby) {
          read = true;
          mkdirSync(lobby, { mode: 0o700 });
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        }
        return defaultFs.lstat(path);
      },
      mkdir: (path: string, opts?: { mode?: number }) => {
        makes += 1;
        defaultFs.mkdir(path, opts);
      },
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({ fs }, made))).toBe(1);
    expect(io.err).toBe(
      `team up: another session-mutating run is holding session acme-web (pid ${process.pid}); try again when it is done\n`,
    );
    expect(io.err).not.toContain('failed to create');
    // The refused run made nothing: the lock's refusal came before the run's first write.
    expect(makes).toBe(0);
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
  });

  test('a run that has to make the lobby makes it under the lock', async () => {
    await approve();
    const made = world();
    // `.config` and `team` are the approval store's own folders; the lobby is the one component
    // a fresh run must make. Each make of this run's records whether its own run lock is on the
    // file at that moment.
    const lobby = join(home, '.config', 'team', 'lobby');
    const held: boolean[] = [];
    const fs = {
      ...defaultFs,
      mkdir: (path: string, opts?: { mode?: number }) => {
        held.push(existsSync(lockFile()));
        defaultFs.mkdir(path, opts);
      },
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({ fs }, made))).toBe(0);
    expect(held.length).toBeGreaterThan(0);
    expect(held).not.toContain(false);
    expect(existsSync(lobby)).toBe(true);
  });

  test('a stop started while this run is mid-flight is refused by the very lock it holds', async () => {
    await approve();
    const made = world();
    const during: Promise<number>[] = [];
    let seen = '';
    const create = made.launch.createWorkspace;
    made.launch.createWorkspace = (session, cwd, label) => {
      // `up` is inside its effects here, its lock on disk under its own pid — so a `down` started
      // now is refused by the same file this run took, naming this process. `down`'s refusal is
      // reached before its first await, so it has already happened when it is awaited below. The
      // stub launch is never called: the refusal comes first.
      const io2 = testIo(root, { kind: 'owner' });
      during.push(runDown(FILE, io2, {
        sessionRunning: () => true,
        agents: () => [],
        alive: () => false,
        screen: () => ({ kind: 'idle' }),
        screenText: () => '',
        status: () => 'idle',
        foreground: () => [],
        now: () => NOW,
        home,
        launch: {
          typeText: () => false, sendKey: () => false, pressEnter: () => false,
          agentPanes: () => null, closeWorkspace: () => false, stopSession: () => false,
          deleteSession: () => false, kill: () => false, sleep: async () => {}, now: () => NOW,
        },
      }));
      seen = io2.err;
      return create(session, cwd, label);
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({}, made))).toBe(0);
    expect(during.length).toBeGreaterThan(0);
    expect(await during[0]).toBe(1);
    expect(seen).toBe(
      `team down: another session-mutating run is holding session acme-web (pid ${process.pid}); try again when it is done\n`,
    );
  });
});

// A restored session: herdr lists the names, and the processes behind them are not the ones team
// launched. A pane back at its shell is closed with no key and no text and the seat launched
// fresh, even when herdr still lists the seat's name. A pane held by another program is left,
// unless its agent session is the one stored at launch, in which case the seat is kept and the
// stored pids become the ones the pane holds now. A seat still holding its recorded process is
// skipped as ready.
describe('team up, a session that was restored', () => {
  test('four seats: one same, one gone, one replaced, one whose pane is missing', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    // Every seat was ready before the power went. codex-acme is the one whose recorded process is
    // still in its pane; the coordinator's runs no CLI; deepseek-acme's runs another CLI; and
    // deepseek-acme-2's pane is gone from herdr altogether.
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
              'codex-acme': { stage: 'ready', pane: 'w92:p1', workspace: 'w92', launched: { shell: 410, cli: [411] } },
              'deepseek-acme': { stage: 'ready', pane: 'w93:p1', workspace: 'w93', launched: { shell: 430, cli: [431] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'w94:p1', workspace: 'w94', launched: { shell: 440, cli: [441] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    // The readings as herdr gives them: pids only. w92 is the recorded process; w91's shell is in
    // front with no CLI; w93's shell is the recorded one and a stranger's CLI is in front; w94
    // can't be read at all.
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      if (pane === 'w93:p1') return { shell: 430, foreground: [500] };
      if (pane === 'w94:p1') return null;
      // A pane this run made: the CLI it has just launched.
      return { shell: 700, foreground: [700, 701] };
    };
    // The repair re-reads herdr immediately before the shell's close. The pane that holds
    // another program has no stored session, so it is left.
    const agents = [
      agent('claude-coordinator-acme', 'w91:p1', 'idle'),
      agent('codex-acme', 'w92:p1', 'idle', 'codex'),
      agent('deepseek-acme', 'w93:p1', 'idle'),
    ];
    made.launch.agents = () => { calls.push('agents'); return agents; };
    // The ordered host calls: the workspaces closed, the workspaces made, the lines run.
    const calls: string[] = [];
    const keys: string[] = [];
    const close = made.launch.closeWorkspace.bind(made.launch);
    made.launch.closeWorkspace = (session, workspace) => { calls.push(`close ${workspace}`); return close(session, workspace); };
    const create = made.launch.createWorkspace.bind(made.launch);
    made.launch.createWorkspace = (session, cwd, label) => {
      const madeWs = create(session, cwd, label);
      calls.push(`create ${label} ${madeWs?.pane ?? '-'}`);
      return madeWs;
    };
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => { calls.push(`run ${pane}`); return run(session, pane, command); };
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => { calls.push(`process ${pane}`); return read(session, pane); };
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText ${pane}`);
      return pane === 'w93:p1' ? IDLE : text(session, pane);
    };
    made.launch.typeText = (_session, pane, text) => { keys.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { keys.push(`enter ${pane}`); return true; };

    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [{ id: 'w91', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w92', label: 'codex-acme · implementer' }, { id: 'w93', label: 'deepseek-acme · implementer' }],
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme', 'w93:p1', 'idle'),
          ],
          doctor: doctor(),
        },
        made,
      ),
    );

    expect(code).toBe(1);
    // The shell is closed before its fresh launch. The pane that holds another program, with no
    // stored session, is not closed and is never typed or run into. The coordinator's name is
    // still in the agent list; that does not keep a shell.
    expect(made.closes).toEqual(['w91']);
    const before = (at: string, n: number) => calls.slice(0, calls.indexOf(at)).slice(-n);
    expect(before('close w91', 2)).toEqual(['agents', 'process w91:p1']);
    expect(calls.indexOf('close w91')).toBeLessThan(calls.indexOf('run w1:p1'));
    expect(calls).not.toContain('close w93');
    expect(keys).toEqual([]);
    expect(made.runs.filter(({ pane }) => ['w91:p1', 'w92:p1', 'w93:p1', 'w94:p1'].includes(pane))).toEqual([]);
    expect(made.runs.find(({ pane }) => pane === 'w1:p1')?.command).toContain('--append-system-prompt');
    expect(made.runs.find(({ pane }) => pane === 'w1:p1')?.command).toContain('Agent: Claude Opus 5.5 · project coordinator');
    expect(io.out).toContain('codex-acme: ready\n');
    expect(io.err).toContain('  already ready; left as it is\n');
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.err).toContain('  its pane held no CLI; closed without input and launched again\n');
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('1 seat repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    expect(io.err).not.toContain('its pane held a process team did not launch');
    expect(io.out).toContain('deepseek-acme-2: ready\n');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['codex-acme']).toMatchObject({ stage: 'ready', pane: 'w92:p1', launched: { shell: 410, cli: [411] } });
    expect(seats['claude-coordinator-acme']).toMatchObject({ stage: 'ready', pane: 'w1:p1', launched: { shell: 700, cli: [701] } });
    expect(seats['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] } });
    expect(seats['deepseek-acme-2']).toMatchObject({ stage: 'ready', pane: 'w2:p1', launched: { shell: 700, cli: [701] } });
  });

  test('a matching agent session on its own model is not closed, and one on another model is repaired', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'codex-acme': { stage: 'ready', pane: 'w92:p1', workspace: 'w92', launched: { shell: 410, cli: [411] }, agent_session: 'kept' },
              'deepseek-acme': { stage: 'ready', pane: 'w93:p1', workspace: 'w93', launched: { shell: 430, cli: [431] }, agent_session: 'kept' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const terra = readFileSync(join(import.meta.dir, '../fixtures/codex/0.161.0/idle.txt'), 'utf8');
    const settled = fileModel(readFileSync(join(import.meta.dir, '../fixtures/codex/0.157.0/idle.txt'), 'utf8'));
    // The repaired codex seat's new pane reads the codex idle box; every other new pane reads
    // the claude-code one. The recorded panes read their own screens.
    const made = world((_pane, label) => (label.startsWith('codex-acme ') ? settled : IDLE));
    made.seed('w92:p1', terra, true);
    made.seed('w93:p1', IDLE, true);
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w92:p1') return { shell: 800, foreground: [801] };
      if (pane === 'w93:p1') return { shell: 900, foreground: [901] };
      return { shell: 700, foreground: [700, 701] };
    };
    // The repaired codex seat's rules arrive as a typed first message: the box holds the line
    // while it is typed, the Enter submits it, and herdr reports the turn as working. The old
    // pane was already at its idle box, so nothing else in this scene is typed into.
    const keys: string[] = [];
    let codexPane = '';
    let typedLine = '';
    let holding = false;
    let status = 'idle';
    const boxed = () => {
      const [first = '', ...rest] = wrappedRows(typedLine);
      return settled.replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    const read = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === codexPane && holding ? boxed() : read(session, pane));
    made.launch.typeText = (_session, pane, text) => {
      codexPane = pane;
      typedLine = text;
      holding = true;
      keys.push('type');
      return true;
    };
    made.launch.pressEnter = () => { holding = false; status = 'working'; keys.push('enter'); return true; };
    made.launch.agentStatus = (_session, pane) => (pane === codexPane ? status : 'idle');
    // The execute pass re-reads the host's agent list directly before the close; once w92 is
    // closed the seat is gone from it, as herdr would report.
    made.launch.agents = () => (made.closes.includes('w92')
      ? []
      : [
          { ...agent('codex-acme', 'w92:p1', 'idle', 'codex'), session: 'kept' },
          { ...agent('deepseek-acme', 'w93:p1', 'idle'), session: 'kept' },
        ]);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [{ id: 'w92', label: 'GPT-6 Sol' }, { id: 'w93', label: 'DeepSeek V4.1 Flash' }],
          agents: () => [
            { ...agent('codex-acme', 'w92:p1', 'idle', 'codex'), session: 'kept' },
            { ...agent('deepseek-acme', 'w93:p1', 'idle'), session: 'kept' },
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    // The codex seat's screen names another model: its recorded conversation is proven
    // (`kept`), so it is closed without input and relaunched through the file's line with
    // that conversation resumed — never a blank one.
    expect(made.closes).toEqual(['w92']);
    const relaunched = made.runs.filter(({ command }) => command.includes('codex -m gpt-6-sol'));
    expect(relaunched).toHaveLength(1);
    expect(relaunched[0]?.command).toContain('resume kept');
    expect(keys).toEqual(['type', 'enter']);
    // The deepseek seat's own model is not readable from a Claude Code screen: nothing is
    // closed and the record takes the pids the pane holds now.
    expect(io.err).toContain('  restored; left as it is\n');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['codex-acme']).toMatchObject({ stage: 'ready' });
    expect(seats['codex-acme']?.pane).not.toBe('w92:p1');
    expect(seats['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 900, cli: [901] }, agent_session: 'kept' });
  });

  test('a different agent session is not closed', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
              'codex-acme': { stage: 'ready', pane: 'w92:p1', workspace: 'w92', launched: { shell: 410, cli: [411] } },
              'deepseek-acme': { stage: 'ready', pane: 'w93:p1', workspace: 'w93', launched: { shell: 430, cli: [431] }, agent_session: 'kept' },
              'deepseek-acme-2': { stage: 'ready', pane: 'w94:p1', workspace: 'w94', launched: { shell: 440, cli: [441] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      if (pane === 'w93:p1') return { shell: 900, foreground: [901] };
      if (pane === 'w94:p1') return { shell: 440, foreground: [440, 441] };
      return { shell: 700, foreground: [700, 701] };
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [
            { id: 'w91', label: 'Claude Opus 5.5' },
            { id: 'w92', label: 'GPT-6 Sol' },
            { id: 'w93', label: 'DeepSeek V4.1 Flash' },
            { id: 'w94', label: 'DeepSeek V4.1 Flash' },
          ],
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            { ...agent('deepseek-acme', 'w93:p1', 'idle'), session: 'other' },
            agent('deepseek-acme-2', 'w94:p1', 'idle'),
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('0 seats repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['deepseek-acme']).toMatchObject({ pane: 'w93:p1', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  test('a workspace that does not close leaves the seat out with a line', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.launch.processInfo = () => ({ shell: 420, foreground: [420] });
    made.launch.agents = () => [agent('claude-coordinator-acme', 'w91:p1', 'idle')];
    made.launch.closeWorkspace = () => false;
    // The parked codex seat launched here never idles on its screen and its wait times out.
    // §2, no terminal: the timeout keeps today's record — this run never prompts.
    const io = quietIo();
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [{ id: 'w91', label: 'claude-coordinator-acme · project coordinator' }],
          agents: () => [agent('claude-coordinator-acme', 'w91:p1', 'idle')],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its workspace did not close; left as it is\n');
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    // Nothing was cleared: the seat's record still names the pane whose process is not the seat's.
    expect((readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {})['claude-coordinator-acme'])
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  // The four recorded seats the close-path tests start from: each with its pane, workspace and
  // identity, and every reading `same`, so only the seat a test breaks takes the repair path.
  const restoredState = {
    'claude-coordinator-acme': { pane: 'w91:p1', workspace: 'w91', label: 'claude-coordinator-acme · project coordinator', shell: 420, cli: 421 },
    'codex-acme': { pane: 'w92:p1', workspace: 'w92', label: 'codex-acme · implementer', shell: 410, cli: 411 },
    'deepseek-acme': { pane: 'w93:p1', workspace: 'w93', label: 'deepseek-acme · implementer', shell: 430, cli: 431 },
    'deepseek-acme-2': { pane: 'w94:p1', workspace: 'w94', label: 'deepseek-acme-2 · implementer', shell: 440, cli: 441 },
  } as const;
  const restoredList = () =>
    Object.entries(restoredState).map(([name, seat]) => agent(name, seat.pane, 'idle', name === 'codex-acme' ? 'codex' : 'claude'));
  function restored(): World {
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: Object.fromEntries(
              Object.entries(restoredState).map(([name, seat]) => [
                name,
                { stage: 'ready', pane: seat.pane, workspace: seat.workspace, launched: { shell: seat.shell, cli: [seat.cli] } },
              ]),
            ),
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    for (const seat of Object.values(restoredState)) made.seed(seat.pane, IDLE, true);
    // The readings as herdr gives them now: every recorded process is still in its pane.
    made.launch.processInfo = (_session, pane) => {
      const seat = Object.values(restoredState).find((item) => item.pane === pane);
      return seat ? { shell: seat.shell, foreground: [seat.shell, seat.cli] } : { shell: 700, foreground: [700, 701] };
    };
    made.launch.agents = restoredList;
    return made;
  }
  const restoredSources = (): Partial<UpSources> => ({
    sessionState: () => 'running',
    workspaces: () => Object.values(restoredState).map((seat) => ({ id: seat.workspace, label: seat.label })),
    agents: restoredList,
    doctor: doctor(),
  });
  // The file the four-seat test writes: codex-acme parked back in, so only grok-acme stays stopped.
  const restoredFile = () => writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
  const seatState = (name: string) => (readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {})[name];

  test('the owner restarts the CLI between the plan and the close: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    // The plan's reading says the coordinator's pane runs no CLI; by the close herdr reads the
    // recorded process again — the owner restarted it between the two. `same` is not an error:
    // the seat is skipped as ready, and nothing is closed or launched for it.
    const read = made.launch.processInfo!;
    let seen = 0;
    made.launch.processInfo = (session, pane) => {
      if (pane !== 'w91:p1') return read(session, pane);
      seen += 1;
      return seen === 1 ? { shell: 420, foreground: [420] } : { shell: 420, foreground: [420, 421] };
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(0);
    expect(io.out).toContain("claude-coordinator-acme: left out: its pane is the seat's again; left as it is\n");
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('herdr no longer names the seat on its recorded pane: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    // The name is listed, on a pane team did not record: a reused id, or another agent renamed.
    made.launch.agents = () => [{ ...agent('claude-coordinator-acme', 'w95:p1', 'idle') }, ...restoredList().slice(1)];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: herdr no longer shows this seat on its recorded pane; nothing closed; run team status\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('the recorded workspace now belongs to another pane: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    // herdr knows the seat on its pane, but the pane's workspace is no longer the recorded one:
    // the id was reused for something else, and closing it would close a stranger.
    made.launch.agents = () => [{ ...agent('claude-coordinator-acme', 'w91:p1', 'idle'), workspace: 'w99' }, ...restoredList().slice(1)];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: herdr no longer shows this seat on its recorded pane; nothing closed; run team status\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('the recorded workspace also holds another pane: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    // The recorded workspace holds another pane beside the seat's pane.
    made.seed('w91:p2', '', false);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its workspace holds other panes; nothing closed (close its pane there, then run team up)\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with the right pane id under another workspace id: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: [{ pane_id: 'w91:p1', workspace_id: 'w92' }] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes under no workspace id: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: [{ pane_id: 'w91:p1' }] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with a non-object entry: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: ['w91:p1'] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with a pane id that is not a string: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: [{ pane_id: 123, workspace_id: 'w91' }] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with the right entry plus one malformed entry: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({
      panes: [
        { pane_id: 'w91:p1', workspace_id: 'w91' },
        { pane_id: 'w91:p2' },
      ],
    }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with an empty listing: nothing is closed and line is unreadable', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    made.launch.workspacePanes = () => [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('a replaced pane whose screen reads working is never closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w93:p1' ? { shell: 430, foreground: [500] } : read(session, pane));
    // A process team did not launch is in the pane, and it is working: up never closes that,
    // whoever started it.
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w93:p1' ? 'esc to interrupt' : text(session, pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    // A working seat is skipped, not refused: nothing is closed, the record stays ready, and
    // the run does not fail on it (the restore sweep reports it as skipped working).
    expect(code).toBe(0);
    expect(io.err).toContain('  the process in its pane is working; nothing closed (stop it there, or run team remove deepseek-acme)\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    expect(made.creates).not.toContain('deepseek-acme-2 · implementer');
    expect(seatState('deepseek-acme')).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] } });
  });

  test('a replaced pane whose screen reads unsent is never closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w93:p1' ? { shell: 430, foreground: [500] } : read(session, pane));
    // A process team did not launch is in the pane, and its screen reads unsent:
    // up never closes that, preserving the owner's draft.
    const unsentText = readFileSync(join(import.meta.dir, '../fixtures/claude-code/2.1.289/unsent-typed-ansi.txt'), 'utf8');
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w93:p1' ? unsentText : text(session, pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('deepseek-acme: left out: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove deepseek-acme)\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    expect(made.creates).not.toContain('deepseek-acme-2 · implementer');
    expect(seatState('deepseek-acme')).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] } });
  });

  test('the process reading fails at the close: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    // gone at the plan, unreadable at the close: a failed read is not a free pane.
    const read = made.launch.processInfo!;
    let seen = 0;
    made.launch.processInfo = (session, pane) => {
      if (pane !== 'w91:p1') return read(session, pane);
      seen += 1;
      return seen === 1 ? { shell: 420, foreground: [420] } : null;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('a seat left at named records the process identity too', async () => {
    // Its idle prompt was read — the identity's moment — and the rename went through, but the
    // rules never landed: the record that stands is the named one, and the identity rides in it.
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'codex-acme · implementer' ? fileModel(capture('idle')) : IDLE));
    made.launch.agentStatus = () => 'idle';
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    // The first message is never typed: the seat stays at named, with the identity recorded.
    made.launch.typeText = () => false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // The reading is the delivery's own — the pane took no text — and the seat it leaves at
    // named is the record the identity rides in.
    expect(io.out).toContain(
      'codex-acme: left out: rules not typed: the pane took no text (the screen read idle); run up again\n',
    );
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'])
      .toMatchObject({ stage: 'named', launched: { shell: 400, cli: [401] } });
  });

  test('a seat left at launched records the process identity too', async () => {
    // Its idle prompt was read, but the rename never went through: the seat stays at launched,
    // and the record still names the process, so a later read of the pane compares with it.
    await approve();
    const made = world();
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    made.launch.renameAgent = () => false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: was not named in time; left at launched\n');
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'])
      .toMatchObject({ stage: 'launched', launched: { shell: 400, cli: [401] } });
  });

  test('a recorded waiting seat with no recorded identity is left out, not closed, by a no-terminal up', async () => {
    // §1/§5 and the safety rule: the state is a hint, never an authority. This record names a
    // pane but holds no process identity — nothing can prove the pane is still this seat's, so
    // the seat is not resumed, opened, skipped or closed from the record: the run fails closed,
    // names the repair, and leaves the pane, the workspace and the record exactly as they are.
    const calls: string[] = [];
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': {
                stage: 'launched',
                pane: 'w1:p1',
                workspace: 'w1',
                waiting: { state: 'waiting-owner', classification: 'trust' },
              },
              'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
              'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? trust : IDLE));
    made.session = 'running';
    made.launch.agentPanes = () => ['w1:p1', 'w2:p1', 'w3:p1'];
    const listed = [
      agent('claude-coordinator-acme', 'w1:p1', 'idle'),
      agent('deepseek-acme', 'w2:p1', 'idle'),
      agent('deepseek-acme-2', 'w3:p1', 'idle'),
    ];
    made.launch.agents = () => listed;
    const origClose = made.launch.closeWorkspace;
    made.launch.closeWorkspace = (session, ws) => {
      calls.push(`close:${ws}`);
      return origClose(session, ws);
    };
    const origPaneText = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText:${pane}`);
      return pane === 'w1:p1' ? trust : origPaneText(session, pane);
    };
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
    }, made));
    expect(code).toBe(1);
    // The refusal comes from the record itself, before any pane is read or judged: the screen
    // is never read, nothing is closed, nothing typed or focused, nothing read from a terminal.
    expect(io.out).toContain('claude-coordinator-acme: left out: its waiting record has no process identity\n');
    expect(io.err).toContain(
      '  answer or close its dialog in its pane, then run `team down` then `team up` (to restart the whole team), to establish one by a run\n',
    );
    expect(calls).toEqual([]);
    expect(made.closes).toEqual([]);
    expect(made.terminal.reads).toBe(0);
    // Nothing was created for the recorded seat, and its record — waiting with it — stays.
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'])
      .toMatchObject({ stage: 'launched', pane: 'w1:p1', workspace: 'w1', waiting: { state: 'waiting-owner', classification: 'trust' } });
  });

  test('a record that copies another seat\'s pane is refused: nothing adopted, renamed or closed', async () => {
    // §1 and the review's repro: the state is a hint, never an authority. This waiting record was
    // forged to name another seat's pane, workspace and process — copied whole — with that pane
    // idle. (a) alone refuses it: another seat's record of this session names that pane, so the
    // pane is never adopted, never renamed to this seat, never recorded ready — and never read.
    const calls: string[] = [];
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': {
                stage: 'launched',
                pane: 'w2:p1',
                workspace: 'w2',
                launched: { shell: 500, cli: [501] },
                waiting: { state: 'waiting-owner', classification: 'trust' },
              },
              'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world(IDLE);
    made.session = 'running';
    made.launch.agentPanes = () => ['w2:p1', 'w3:p1'];
    const listed = [agent('deepseek-acme', 'w2:p1'), agent('deepseek-acme-2', 'w3:p1')];
    made.launch.agents = () => listed;
    const origRename = made.launch.renameAgent;
    made.launch.renameAgent = (session, pane, name) => { calls.push(`rename:${pane}:${name}`); return origRename(session, pane, name); };
    const origPaneText = made.launch.paneText;
    made.launch.paneText = (session, pane) => { calls.push(`read:${pane}`); return origPaneText(session, pane); };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [{ id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
    }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its waiting pane is gone\n');
    // The pane is never read, nothing is renamed and nothing is closed — the refusal is the
    // whole of what happens. The forged record and the seat that really owns the pane both
    // stand exactly as the file had them.
    expect(calls).toEqual([]);
    expect(made.renames).toEqual([]);
    expect(made.closes).toEqual([]);
    expect(made.terminal.reads).toBe(0);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toMatchObject({ stage: 'launched', pane: 'w2:p1', waiting: { state: 'waiting-owner' } });
    expect(seats['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w2:p1' });
  });

  test('a recorded recovery is left as it is by a no-terminal up: nothing closed, nothing sent', async () => {
    // The safety rule is state × caller: `trust-sent-recovery` is a recorded waiting seat too.
    // A terminal `up` never closes it — the owner is asked first. This caller has no terminal,
    // so the waiting-owner rule above applies to it unchanged: the pane is verified against the
    // recorded process, its screen read fresh, and the workspace closed without input.
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': {
                stage: 'launched',
                pane: 'w1:p1',
                workspace: 'w1',
                launched: { shell: 400, cli: [401] },
                waiting: {
                  state: 'trust-sent-recovery',
                  classification: 'trust',
                  sentAt: '2026-10-03T14:01:00.000Z',
                },
              },
              'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? trust : IDLE));
    made.session = 'running';
    const listed = [
      agent('claude-coordinator-acme', 'w1:p1', 'idle'),
      agent('deepseek-acme', 'w2:p1', 'idle'),
      agent('deepseek-acme-2', 'w3:p1', 'idle'),
    ];
    made.launch.agents = () => listed;
    made.launch.agentPanes = () => ['w1:p1', 'w2:p1', 'w3:p1'];
    const calls: string[] = [];
    made.launch.processInfo = (_session, pane) => {
      calls.push(`process:${pane}`);
      return pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] } :
        pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
        { shell: 510, foreground: [510, 511] };
    };
    const origPaneText = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText:${pane}`);
      return pane === 'w1:p1' ? trust : origPaneText(session, pane);
    };
    const origClose = made.launch.closeWorkspace;
    made.launch.closeWorkspace = (session, ws) => {
      calls.push(`close:${ws}`);
      return origClose(session, ws);
    };
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
    }, made));
    expect(code).toBe(1);
    // The recorded process was verified before anything was closed, its screen read between
    // the check and the close, and the close's own process read comes directly before it —
    // nothing is typed, focused or asked of a terminal. The two reads before that are the
    // plan's model read of the ready seats, taken while the plan is built.
    expect(calls).toEqual([
      'process:w1:p1', 'process:w2:p1', 'process:w3:p1',
      'paneText:w2:p1', 'paneText:w3:p1',
      'process:w1:p1', 'paneText:w1:p1',
    ]);
    expect(made.terminal.reads).toBe(0);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(io.out).toContain('claude-coordinator-acme: left out: a run with no terminal does not close a waiting seat; left as it is\n');
    expect(made.closes).toEqual([]);
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']?.waiting?.state).toBe('trust-sent-recovery');
  });

  test('a no-terminal up does not close a resumed waiting seat', async () => {
    // The identity mutation's resumed half: the record's own identity ({shell 400, cli [401]})
    // proves the pane through the resume's proof, but between that proof and the close the
    // pane's process changes. The close must be judged against the launch's identity — the one
    // the record holds — never against the identity read from the changed process: judged by
    // that read the close would proceed and drop a record whose seat is not provably this seat's.
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': {
                stage: 'launched',
                pane: 'w1:p1',
                workspace: 'w1',
                launched: { shell: 400, cli: [401] },
                waiting: { state: 'waiting-owner', classification: 'trust' },
              },
              'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? trust : IDLE));
    made.session = 'running';
    const listed = [
      agent('claude-coordinator-acme', 'w1:p1', 'idle'),
      agent('deepseek-acme', 'w2:p1', 'idle'),
      agent('deepseek-acme-2', 'w3:p1', 'idle'),
    ];
    made.launch.agents = () => listed;
    made.launch.agentPanes = () => ['w1:p1', 'w2:p1', 'w3:p1'];
    const calls: string[] = [];
    let reads = 0;
    made.launch.processInfo = (_session, pane) => {
      calls.push(`process:${pane}`);
      if (pane !== 'w1:p1') return pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } : { shell: 510, foreground: [510, 511] };
      // The resume's own proof reads the recorded process; the close's read, directly before
      // it, finds another one — the seat cannot be proven this seat's any more.
      reads += 1;
      return reads <= 2 ? { shell: 400, foreground: [400, 401] } : { shell: 900, foreground: [900, 901] };
    };
    const origPaneText = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText:${pane}`);
      return pane === 'w1:p1' ? trust : origPaneText(session, pane);
    };
    const origClose = made.launch.closeWorkspace;
    made.launch.closeWorkspace = (session, ws) => {
      calls.push(`close:${ws}`);
      return origClose(session, ws);
    };
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
    }, made));
    expect(code).toBe(1);
    // The refusal names the launch's identity as what changed under it and keeps the record —
    // nothing is closed, nothing typed, nothing asked of a terminal. The two reads before the
    // resume's own proof are the plan's model read of the ready seats.
    expect(calls).toEqual([
      'process:w1:p1', 'process:w2:p1', 'process:w3:p1',
      'paneText:w2:p1', 'paneText:w3:p1',
      'process:w1:p1', 'paneText:w1:p1',
    ]);
    expect(io.out).toContain('claude-coordinator-acme: left out: a run with no terminal does not close a waiting seat; left as it is\n');
    expect(calls.some((call) => call.startsWith('close:'))).toBe(false);
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude-coordinator-acme · project coordinator');
    expect(made.terminal.reads).toBe(0);
    // The change under the close writes nothing: the record keeps the launch's identity, so the
    // next `up` can still tell what it is looking at.
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']).toMatchObject({
      stage: 'launched',
      pane: 'w1:p1',
      workspace: 'w1',
      launched: { shell: 400, cli: [401] },
      waiting: { state: 'waiting-owner', classification: 'trust' },
    });
  });

  test('a resumed wait reads herdr\'s named agent, not the pane the state records', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w9:p9',
              workspace: 'w9',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
        },
      },
    }));
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? trust : IDLE));
    made.session = 'running';
    const listed = [
      agent('claude-coordinator-acme', 'w1:p1', 'idle'),
      agent('deepseek-acme', 'w2:p1', 'idle'),
      agent('deepseek-acme-2', 'w3:p1', 'idle'),
    ];
    made.launch.agents = () => listed;
    const reads: string[] = [];
    made.launch.paneText = (_session, pane) => {
      reads.push(pane);
      return pane === 'w1:p1' ? trust : IDLE;
    };
    made.launch.processInfo = (_session, pane) =>
      pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] }
        : pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] }
          : pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const io = quietIo();
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [
        { id: 'w1', label: 'claude-coordinator-acme · project coordinator' },
        { id: 'w2', label: 'deepseek-acme · implementer' },
        { id: 'w3', label: 'deepseek-acme · implementer' },
      ],
    }, made));
    expect(code).toBe(1);
    expect(reads).toContain('w1:p1');
    expect(reads).not.toContain('w9:p9');
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('claude-coordinator-acme: left out: a run with no terminal does not close a waiting seat; left as it is\n');
  });
});

// §3/§4/§5: the pause at the owner's terminal — the prompt and its keys, what `o` waits on,
// what `s` and `q` close, the resume of a recorded waiting seat, and the coordinator's tick.
// A fake host and an injected terminal throughout: no real session, no pane.
describe('team up, the pause', () => {
  /** A pane herdr's agent list names before the seat's rename: the pane id, and no name yet. */
  const listedPane = (pane: string): HerdrAgent => ({
    name: null,
    agent: 'claude',
    pane,
    workspace: pane.split(':')[0] ?? pane,
    status: 'idle',
    cwd: null,
  });

  /** What herdr would list now: every pane this run has run a command in (or a test has seeded
   *  as an agent), minus the workspaces closed since. The watchdog pane is absent — it runs no
   *  agent, as a pane running `node -e …` was absent from `herdr agent list` on 0.7.1. */
  function agentListOf(made: World): () => HerdrAgent[] {
    return () =>
      (made.launch.agentPanes('acme-web') ?? [])
        .filter((pane) => !made.closes.includes(pane.split(':')[0] ?? pane))
        .map(listedPane);
  }

  const prompt = (seat: string, classification: string) =>
    `${seat} is waiting at ${classification}: [o] open pane, [s] skip seat, [q] stop cleanly\n`;

  /** Every way the run may touch a pane, in order, plus what it typed and whether the seat lock
   *  was held while the pause waited — for a key, or for a poll's sleep. The lock is a file:
   *  held here means it exists at that instant. */
  function trace(made: World): { calls: string[]; typed: string[]; lockedWhileWaiting: boolean[] } {
    const calls: string[] = [];
    const typed: string[] = [];
    const lockedWhileWaiting: boolean[] = [];
    const held = () => existsSync(seatLockPath(join(root, '.agents'), 'acme-web', 'claude-coordinator-acme'));
    const createWorkspace = made.launch.createWorkspace;
    made.launch.createWorkspace = (session, cwd, label) => { calls.push(`create:${label}`); return createWorkspace(session, cwd, label); };
    const paneRun = made.launch.paneRun;
    made.launch.paneRun = (session, pane, command) => { calls.push(`run:${pane}`); return paneRun(session, pane, command); };
    const renameAgent = made.launch.renameAgent;
    made.launch.renameAgent = (session, pane, name) => { calls.push(`rename:${pane}:${name}`); return renameAgent(session, pane, name); };
    const closeWorkspace = made.launch.closeWorkspace;
    made.launch.closeWorkspace = (session, workspace) => { calls.push(`close:${workspace}`); return closeWorkspace(session, workspace); };
    const agentPanes = made.launch.agentPanes;
    made.launch.agentPanes = (session) => { calls.push('agent-panes'); return agentPanes(session); };
    const workspacePanes = made.launch.workspacePanes;
    made.launch.workspacePanes = (session, workspace) => { calls.push(`panes:${workspace}`); return workspacePanes?.(session, workspace) ?? null; };
    const agents = made.launch.agents;
    made.launch.agents = (session) => { calls.push('agents'); return agents(session); };
    const paneText = made.launch.paneText;
    made.launch.paneText = (session, pane) => { calls.push(`read:${pane}`); return paneText(session, pane); };
    const processInfo = made.launch.processInfo;
    made.launch.processInfo = (session, pane) => { calls.push(`process:${pane}`); return processInfo?.(session, pane) ?? null; };
    const focus = made.launch.focus;
    made.launch.focus = (session, pane) => { calls.push(`focus:${pane}`); return focus?.(session, pane) ?? false; };
    made.launch.typeText = (_session, pane, text) => { typed.push(`type:${pane}:${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { typed.push(`enter:${pane}`); return true; };
    const sleep = made.launch.sleep;
    made.launch.sleep = async (ms) => { calls.push(`sleep:${ms}`); lockedWhileWaiting.push(held()); return sleep(ms); };
    const key = made.terminal.key.bind(made.terminal);
    made.terminal.key = async (ms) => { const read = await key(ms); calls.push(`key:${read}`); lockedWhileWaiting.push(held()); return read; };
    return { calls, typed, lockedWhileWaiting };
  }

  /** The owner's live grant: the coordinator may answer trust dialogs for this project. */
  function grantCoordinatorTrust(): void {
    const written = writeGrant(home, {
      name: `team-${teamIdOf(root)}`,
      kind: 'team',
      grantee: teamIdOf(root),
      capabilities: ['dialogs.trust'],
      roots: [root],
      scope: [root],
    });
    if (!written.ok) throw new Error(`the scene's grant was refused: ${written.why}`);
  }

  /** A seat under coordination whose trust dialog the coordinator may answer mid-prompt. */
  function coordinated(mutate?: (seat: { stage?: string; waiting?: unknown }) => void) {
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? trust : IDLE));
    made.launch.agents = agentListOf(made);
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const typed: string[] = [];
    made.launch.typeText = (_session, _pane, text) => { typed.push(text); return true; };
    made.launch.pressEnter = () => { typed.push('Enter'); return true; };
    // The change between polls: written while the prompt waits for its tick, exactly where a
    // concurrent `team answer` would write it.
    let maybe = mutate;
    const key = made.terminal.key.bind(made.terminal);
    made.terminal.key = async (ms) => {
      if (maybe) {
        const file = JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8'));
        maybe(file.sessions['acme-web'].seats['claude-coordinator-acme']);
        writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(file));
        maybe = undefined;
      }
      return key(ms);
    };
    made.terminal.keys.push('timeout', 'q');
    return { made, typed };
  }

  test('the prompt is exact, a key it does not know changes nothing, and q closes and stops cleanly', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.launch.agents = agentListOf(made);
    // The process identity read at the moment the waiting record is written, in the same write.
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const stopped: string[] = [];
    made.launch.stopSession = (session) => { stopped.push(session); return true; };
    const typed: string[] = [];
    made.launch.typeText = (_session, _pane, text) => { typed.push(text); return true; };
    made.launch.pressEnter = () => { typed.push('Enter'); return true; };
    // The state exactly as it stands when each key is read: between the unknown key and the q
    // nothing may have changed.
    const snapshots: string[] = [];
    const key = made.terminal.key.bind(made.terminal);
    made.terminal.key = async (ms) => {
      snapshots.push(readFileSync(join(root, '.agents/team.state.json'), 'utf8'));
      return key(ms);
    };
    made.terminal.keys.push('other', 'q');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // The prompt, twice: the entry's, and the one the unknown key drew again.
    expect(io.err.split(prompt('claude-coordinator-acme', 'permission')).length - 1).toBe(2);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBe(snapshots[0]);
    // Type-ahead never answers a prompt: one drain before each prompt, and one on the way out.
    expect(made.terminal.drains).toBe(3);
    const waiting = JSON.parse(snapshots[0] ?? '').sessions['acme-web'].seats['claude-coordinator-acme'];
    expect(waiting.waiting).toEqual({ state: 'waiting-owner', classification: 'permission' });
    expect(waiting.launched).toEqual({ shell: 400, cli: [401] });
    // The record is provisional on the seat's own line while the prompt is open.
    expect(io.out).toContain('\r\x1b[Kclaude-coordinator-acme: waiting for owner (permission)');
    // Nothing was ever sent into the pane: neither the unknown key nor q types or presses.
    expect(typed).toEqual([]);
    // q: the workspace this run created is closed without input, and its state goes with it.
    expect(made.closes).toEqual(['w1']);
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']).toBeUndefined();
    // The seat and every later configured seat get their one record, in file order.
    const at = (text: string) => io.out.indexOf(text);
    expect(at('claude-coordinator-acme: left out: stopped cleanly\n')).toBeGreaterThanOrEqual(0);
    expect(at('claude-coordinator-acme: left out: stopped cleanly\n'))
      .toBeLessThan(at('deepseek-acme: left out: stopped cleanly\n'));
    expect(at('deepseek-acme: left out: stopped cleanly\n'))
      .toBeLessThan(at('deepseek-acme-2: left out: stopped cleanly\n'));
    // The session this run created holds nothing any more, and is stopped.
    expect(stopped).toEqual(['acme-web']);
    expect(io.err).toContain('session acme-web: stopped\n');
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).toContain('up [owner] claude-coordinator-acme: waiting for owner (permission)');
    expect(log).toContain('up [owner] claude-coordinator-acme: stopped cleanly');
  });

  test('the stop pass reads herdr, the workspace and the process directly before the close', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.launch.agents = agentListOf(made);
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    // The three reads the stop pass makes, and the close, each on its own label — the World's
    // agent list happens to be built from its pane list, so instrumenting `agents` alone keeps
    // one call per read.
    const calls: string[] = [];
    const agents = made.launch.agents;
    made.launch.agents = (session) => { calls.push('agents'); return agents(session); };
    const workspacePanes = made.launch.workspacePanes;
    made.launch.workspacePanes = (session, workspace) => { calls.push(`panes:${workspace}`); return workspacePanes?.(session, workspace) ?? null; };
    const processInfo = made.launch.processInfo;
    made.launch.processInfo = (session, pane) => { calls.push(`process:${pane}`); return processInfo?.(session, pane) ?? null; };
    const closeWorkspace = made.launch.closeWorkspace;
    made.launch.closeWorkspace = (session, workspace) => { calls.push(`close:${workspace}`); return closeWorkspace(session, workspace); };
    made.terminal.keys.push('q');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(made.closes).toEqual(['w1']);
    // §3: the four calls that end in the close, consecutive and in order — the multiplexer's
    // list, the workspace's panes, the process identity, the close — with nothing between the
    // last read and the close. Dropping any one of the three reads breaks this exact tail.
    const at = calls.indexOf('close:w1');
    expect(calls.slice(at - 3, at + 1)).toEqual(['agents', 'panes:w1', 'process:w1:p1', 'close:w1']);
  });

  test('the stop pass never closes a workspace whose process changed while the prompt was open', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.launch.agents = agentListOf(made);
    // The identity this run started with, until the owner presses q; every read after that sees
    // another process in the pane — it was replaced while the prompt sat open.
    let replaced = false;
    made.launch.processInfo = () => (replaced ? { shell: 900, foreground: [900, 901] } : { shell: 400, foreground: [400, 401] });
    const key = made.terminal.key.bind(made.terminal);
    made.terminal.key = async (ms) => {
      const next = await key(ms);
      if (next === 'q') replaced = true;
      return next;
    };
    made.terminal.keys.push('q');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // §3: the q is the owner's, but this workspace is not this run's to close any more — the
    // stop pass's own read, directly before the close, sees a process it never started.
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('claude-coordinator-acme: left out: left as it is: its process changed\n');
    // Nothing claims a close that did not happen: the waiting record stands, and the session,
    // holding the pane that was not closed, is not stopped.
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat?.waiting).toEqual({ state: 'waiting-owner', classification: 'permission' });
    expect(io.err).toContain('session acme-web: not stopped, something was left in it\n');
  });

  test('o carries the seat to ready: the ordered host calls, and nothing sent before the pane reads idle', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.launch.agents = agentListOf(made);
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const read = made.launch.paneText.bind(made.launch);
    // The owner answers in the pane while the poll sleeps: the sleep is the moment the dialog
    // goes away, and every read of that pane after it sees the idle prompt.
    let flipped = false;
    made.launch.paneText = (session, pane) => (pane === 'w1:p1' ? (flipped ? IDLE : PERMISSION) : read(session, pane));
    const nap = made.launch.sleep.bind(made.launch);
    made.launch.sleep = async (ms) => { flipped = true; return nap(ms); };
    const { calls, typed, lockedWhileWaiting } = trace(made);
    made.terminal.keys.push('o');
    // A redirected stdout: the prompt is shown on stderr, and stdout carries the final records
    // alone — no carriage return, no provisional text.
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(calls).toEqual([
      // The fresh reading that stopped the seat, the identity read when the dialog was found
      // (nothing is recorded for the seat yet), and the entry write's identity read.
      'create:claude-coordinator-acme · project coordinator', 'rename:w1:p1:claude-coordinator-acme', 'run:w1:p1', 'read:w1:p1', 'process:w1:p1', 'process:w1:p1',
      // o: the key, then the lock's own reads (the pane is still the seat's — herdr's list,
      // then the process), the manual write with its identity read, and the focus. No key,
      // no text.
      'key:o', 'agents', 'agent-panes', 'process:w1:p1', 'process:w1:p1', 'focus:w1:p1',
      // The first poll: the sleep (the owner answers), then fresh reads — the pane is idle.
      'sleep:2000', 'agents', 'agent-panes', 'process:w1:p1', 'read:w1:p1',
      // The ordinary path from the idle prompt: the model read, the identity, the agent list
      // (so the session id can be stored with it), the rename.
      'read:w1:p1', 'process:w1:p1', 'agents', 'agent-panes', 'agent-panes',
      // Then the later seats, the same way.
      'create:deepseek-acme · implementer', 'rename:w2:p1:deepseek-acme', 'run:w2:p1', 'read:w2:p1', 'read:w2:p1', 'process:w2:p1', 'agents', 'agent-panes', 'agent-panes',
      'create:deepseek-acme-2 · implementer', 'rename:w3:p1:deepseek-acme-2', 'run:w3:p1', 'read:w3:p1', 'read:w3:p1', 'process:w3:p1', 'agents', 'agent-panes', 'agent-panes',
      // Then the watch's workspace and its command line, the plan's last step.
      'create:Watch · acme-web', 'run:w4:p1',
    ]);
    expect(typed).toEqual([]);
    expect(lockedWhileWaiting.length).toBeGreaterThanOrEqual(2);
    expect(lockedWhileWaiting).not.toContain(true);
    expect(io.out).toBe('claude-coordinator-acme: ready\ndeepseek-acme: ready\ndeepseek-acme-2: ready\n');
    expect(io.out).not.toContain('\r');
    expect(io.err).toContain(prompt('claude-coordinator-acme', 'permission'));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat).toMatchObject({ stage: 'ready', pane: 'w1:p1', launched: { shell: 400, cli: [401] } });
    expect(seat?.waiting).toBeUndefined();
  });

  test('s closes that seat alone: without input, its state cleared, and the later seats reach ready', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.launch.agents = agentListOf(made);
    // The pane's process: the pause's entry write records it as the waiting identity, and the
    // skip's close reads the same one back — the proof the close is made of.
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    let stopped = 0;
    made.launch.stopSession = () => { stopped++; return true; };
    const typed: string[] = [];
    made.launch.typeText = (_session, _pane, text) => { typed.push(text); return true; };
    made.terminal.keys.push('s');
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.err).toContain(prompt('claude-coordinator-acme', 'permission'));
    expect(made.closes).toEqual(['w1']);
    expect(made.renames).toEqual(['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2']);
    expect(io.out).toContain('claude-coordinator-acme: left out: skipped by owner\n');
    expect(io.out).toContain('deepseek-acme: ready\n');
    expect(io.out).toContain('deepseek-acme-2: ready\n');
    // No q was pressed: the session stays, ready seats and all.
    expect(stopped).toBe(0);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
    expect(seats['deepseek-acme']?.stage).toBe('ready');
    expect(seats['deepseek-acme-2']?.stage).toBe('ready');
    expect(typed).toEqual([]);
  });

  test("q keeps a ready seat's workspace and the session that holds it", async () => {
    await approve();
    const made = world((_pane, label) => (label === 'deepseek-acme · implementer' || label === 'deepseek-acme-2 · implementer' ? PERMISSION : IDLE));
    made.launch.agents = agentListOf(made);
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    let stopped = 0;
    made.launch.stopSession = () => { stopped++; return true; };
    made.terminal.keys.push('q');
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.err).toContain(prompt('deepseek-acme', 'permission'));
    // The paused seat's workspace alone is closed; the ready seat's stays, state and all.
    expect(made.closes).toEqual(['w2']);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
    expect(seats['deepseek-acme']).toBeUndefined();
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).toContain('deepseek-acme: left out: stopped cleanly\n');
    expect(io.out).toContain('deepseek-acme-2: left out: stopped cleanly\n');
    // The session still holds the ready seat: it is not stopped, and the line says what it is.
    expect(stopped).toBe(0);
    expect(io.err).toContain('session acme-web: not stopped, something is left in it\n');
  });

  test('q never stops a session that existed before the run, nor touches its watchdog', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {},
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? PERMISSION : IDLE));
    made.session = 'running';
    made.launch.agents = agentListOf(made);
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    let stopped = 0;
    made.launch.stopSession = () => { stopped++; return true; };
    made.terminal.keys.push('q');
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'running', alive: () => true }, made));
    expect(code).toBe(1);
    expect(io.err).toContain(prompt('claude-coordinator-acme', 'permission'));
    // The run's own seat's workspace is closed; the session it did not start is not stopped,
    // and no second watch is started into it.
    expect(made.closes).toEqual(['w1']);
    expect(stopped).toBe(0);
    expect(made.creates).not.toContain(watchLabel('acme-web'));
    expect(io.err).not.toContain('session acme-web');
  });

  test('a seat that never idles pauses at the timeout, with the timeout classification', async () => {
    await approve();
    // The screen of the capture §2's timeout report is built from: the launch line's own echo,
    // the shell's failure, the prompt back. The wait runs out and the owner is asked.
    const shown = "❯ zsh ../tools/launcher.sh\nzsh: can't open input file: ../tools/launcher.sh\n~ ❯\n";
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? shown : IDLE));
    made.launch.agents = agentListOf(made);
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const snapshots: string[] = [];
    const key = made.terminal.key.bind(made.terminal);
    made.terminal.key = async (ms) => {
      snapshots.push(readFileSync(join(root, '.agents/team.state.json'), 'utf8'));
      return key(ms);
    };
    made.terminal.keys.push('q');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.err).toContain(prompt('claude-coordinator-acme', 'timeout'));
    expect(io.out).toContain('\r\x1b[Kclaude-coordinator-acme: waiting for owner (timeout)');
    const waiting = JSON.parse(snapshots[0] ?? '').sessions['acme-web'].seats['claude-coordinator-acme'];
    expect(waiting.waiting).toEqual({ state: 'waiting-owner', classification: 'timeout' });
    // q from the timeout prompt is the same stop: closed without input, one record per seat.
    expect(made.closes).toEqual(['w1']);
    expect(io.out).toContain('claude-coordinator-acme: left out: stopped cleanly\n');
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8'))
      .toContain('up [owner] claude-coordinator-acme: waiting for owner (timeout)');
  });

  test('under coordination, a seat answered ready between polls is this run\'s ready', async () => {
    grantCoordinatorTrust();
    await approve();
    // What `team answer` leaves on its success: the seat ready, its waiting record gone.
    const { made, typed } = coordinated((seat) => { seat.stage = 'ready'; delete seat.waiting; });
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(io.out).toContain('\r\x1b[Kclaude-coordinator-acme: ready\n');
    expect(io.err).toContain('  claude-coordinator-acme was answered while its prompt was open; it is ready\n');
    // No trust key was sent by `up`, and no text into any pane: the run only ever asked.
    expect(typed).toEqual([]);
    expect(made.terminal.reads).toBe(1);
  });

  test('under coordination, a recovery left between polls is shown, and the owner still chooses', async () => {
    grantCoordinatorTrust();
    await approve();
    const { made, typed } = coordinated((seat) => {
      seat.waiting = { state: 'trust-sent-recovery', classification: 'trust', sentAt: '2026-10-03T14:01:00.000Z' };
    });
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // The record says it is a recovery, and the prompt asks the owner again: the entry's prompt
    // (still at the dialog's own classification), then the one the recovery drew — which says
    // what the record says, not the classification alone.
    expect(io.out).toContain('\r\x1b[Kclaude-coordinator-acme: waiting for owner (trust sent; recovery required)');
    expect(io.err.split(prompt('claude-coordinator-acme', 'trust')).length - 1).toBe(1);
    expect(io.err.split(prompt('claude-coordinator-acme', 'trust sent; recovery required')).length - 1).toBe(1);
    expect(typed).toEqual([]);
    expect(made.terminal.reads).toBe(2);
  });

  test('the same recovery prompt reaches a redirected stdout: what the record says, on stderr', async () => {
    grantCoordinatorTrust();
    await approve();
    const { made, typed } = coordinated((seat) => {
      seat.waiting = { state: 'trust-sent-recovery', classification: 'trust', sentAt: '2026-10-03T14:01:00.000Z' };
    });
    const io = testIo(root, { kind: 'owner' });
    // stdout is a pipe: nothing provisional is drawn there, ever — and the prompt, which goes to
    // stderr, still says what the record says.
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.err).toContain(prompt('claude-coordinator-acme', 'trust sent; recovery required'));
    expect(io.out).not.toContain('\x1b[');
    expect(io.out).toContain('claude-coordinator-acme: left out: stopped cleanly\n');
    expect(typed).toEqual([]);
  });

  test('under coordination, an unchanged state re-prompts from the fresh reading, no key sent', async () => {
    grantCoordinatorTrust();
    await approve();
    const { made, typed } = coordinated();
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.err.split(prompt('claude-coordinator-acme', 'trust')).length - 1).toBe(2);
    expect(io.out.split('\r\x1b[Kclaude-coordinator-acme: waiting for owner (trust)').length - 1).toBe(2);
    expect(typed).toEqual([]);
    expect(made.terminal.reads).toBe(2);
  });

  test("a later up resumes the recorded waiting seat on its own pane: the prompt first, nothing created", async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    let flipped = false;
    const made = world(IDLE);
    made.seed('w1:p1', trust, true);
    made.seed('w2:p1', IDLE, true);
    made.seed('w3:p1', IDLE, true);
    made.session = 'running';
    const listed = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] } :
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => (pane === 'w1:p1' ? (flipped ? IDLE : trust) : read(session, pane));
    const nap = made.launch.sleep.bind(made.launch);
    made.launch.sleep = async (ms) => { flipped = true; return nap(ms); };
    const { calls, typed } = trace(made);
    made.terminal.keys.push('o');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
      agents: listed,
    }, made));
    expect(code).toBe(0);
    // The fresh read of the recorded pane comes first — the pane's presence, its process, its
    // screen — and only then the prompt: nothing is created, run, typed or focused before the
    // owner has chosen. (The three `process` reads before it are the run's own pre-pass over
    // the recorded seats, at up.ts, and the two `read`s after them are the plan's model read
    // of the ready seats.)
    expect(calls).toEqual([
      'process:w1:p1', 'process:w2:p1', 'process:w3:p1',
      'read:w2:p1', 'read:w3:p1',
      'agents', 'process:w1:p1', 'read:w1:p1', 'key:o',
      'agents', 'process:w1:p1', 'process:w1:p1', 'focus:w1:p1',
      'sleep:2000', 'agents', 'process:w1:p1', 'read:w1:p1',
      'read:w1:p1', 'process:w1:p1', 'agents', 'agent-panes', 'rename:w1:p1:claude-coordinator-acme',
    ]);
    expect(made.creates).toEqual([]);
    expect(made.runs).toEqual([]);
    expect(made.renames).toEqual(['claude-coordinator-acme']);
    expect(typed).toEqual([]);
    expect(io.err).toContain(prompt('claude-coordinator-acme', 'trust'));
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
  });

  test('end of input leaves the waiting seat exactly as it is: workspace kept, record kept, exit 1', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world(IDLE);
    made.seed('w1:p1', trust, true);
    made.seed('w2:p1', IDLE, true);
    made.seed('w3:p1', IDLE, true);
    made.session = 'running';
    const listed = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] } :
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const { typed } = trace(made);
    made.terminal.keys.push('eof');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
      agents: listed,
    }, made));
    // End of input is not `q`: the run stops asking, leaves the seat as it is and exits 1.
    // Nothing is closed — not the seat's workspace, not the session — and no key is ever sent.
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its input ended; left as it is\n');
    expect(made.closes).toEqual([]);
    expect(made.terminal.reads).toBe(1);
    // One drain before the one prompt, one on the way out.
    expect(made.terminal.drains).toBe(2);
    expect(typed).toEqual([]);
    // The waiting record survives exactly as it was: the seat is still waiting, for the next run.
    const kept = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(kept?.waiting).toEqual({ state: 'waiting-owner', classification: 'trust' });
    expect(kept?.pane).toBe('w1:p1');
  });

  test('a waiting log line takes its classification from the validated read, never the stored bytes', async () => {
    await approve();
    // A stored classification a hand-edited or corrupted file can hold — an escape sequence and
    // a forged line. The log line `entering()` writes is built from the record read through the
    // state's one door, so it carries `unknown`, never the bytes.
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust\x1b[2J\r\ninjected' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    // The pane reads working, so the fresh read has no classification of its own to offer and the
    // stored one — the probe — is what the record hands on. The log line carries the validated
    // `unknown`, never the bytes.
    const working = readFileSync(new URL('../fixtures/claude-code/2.1.289/unsent-typing-while-running-ansi.txt', import.meta.url), 'utf8');
    const made = world(IDLE);
    made.seed('w1:p1', working, true);
    made.seed('w2:p1', IDLE, true);
    made.seed('w3:p1', IDLE, true);
    made.session = 'running';
    const listed = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] } :
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    made.terminal.keys.push('eof');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
      agents: listed,
    }, made));
    expect(code).toBe(1);
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).toContain('up [owner] claude-coordinator-acme: waiting for owner (unknown)');
    expect(log).not.toContain('injected');
  });

  test('a recorded waiting seat whose pane is gone is launched in a fresh workspace', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world(IDLE);
    made.seed('w1:p1', trust, true);
    made.seed('w2:p1', IDLE, true);
    made.seed('w3:p1', IDLE, true);
    made.session = 'running';
    // herdr no longer lists claude's pane: it is gone, whatever the record says. The other
    // seats' panes are still there, so only that seat is launched again.
    const listed = () => [agent('deepseek-acme', 'w2:p1'), agent('deepseek-acme-2', 'w3:p1')];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    made.terminal.keys.push('o');
    const io = testIo(root, { kind: 'owner' });
    io.stdoutIsTTY = true;
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [{ id: 'w1', label: 'claude-coordinator-acme · project coordinator' }, { id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
      agents: listed,
    }, made));
    expect(code).toBe(0);
    // The recorded pane is not in herdr's list, so the seat is launched in a fresh workspace.
    // Nothing is closed, and the terminal is not read.
    expect(`${io.out}${io.err}`).toContain('claude-coordinator-acme: its recorded pane w1:p1 was gone and was replaced; its workspace w1 was left\n');
    expect(io.out).not.toContain('left out: its waiting pane is gone');
    expect(made.closes).toEqual([]);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator']);
    expect(made.terminal.reads).toBe(0);
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']?.waiting)
      .toBeUndefined();
  });

  test.each(['launched', 'named', 'ready'] as const)(
    'a waiting %s seat whose recorded pane is gone is launched in a fresh workspace',
    async (stage) => {
      await approve();
      writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': {
                stage,
                pane: 'w9:p1',
                workspace: 'w9',
                launched: { shell: 400, cli: [401] },
                waiting: { state: 'waiting-owner', classification: 'trust' },
              },
              'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
            },
            worktrees: {},
            watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
          },
        },
      }));
      const made = world(IDLE);
      made.session = 'running';
      const others = () => [agent('deepseek-acme', 'w2:p1'), agent('deepseek-acme-2', 'w3:p1')];
      made.launch.agents = others;
      made.launch.processInfo = (_session, pane) =>
        pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
        pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
      const host = {
        sessionState: () => 'running' as const,
        alive: () => true,
        workspaces: () => [
          { id: 'w9', label: 'Claude Opus 5.5' },
          { id: 'w2', label: 'DeepSeek V4.1 Flash' },
          { id: 'w3', label: 'DeepSeek V4.1 Flash' },
        ],
        agents: others,
      };
      const io = testIo(root, { kind: 'owner' });
      const code = await runUp(FILE, io, sources(host, made));
      expect(code).toBe(0);
      expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator']);
      expect(made.closes).toEqual([]);
      expect(made.runs.map((run) => run.pane)).toEqual(['w1:p1']);
      expect(`${io.out}${io.err}`).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced; its workspace w9 was left\n');
      const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
      expect(seat?.waiting).toBeUndefined();
      expect(seat?.pane).toBe('w1:p1');
      expect(seat?.stage).toBe('ready');
      expect(readState(join(root, '.agents')).sessions['acme-web']?.watch?.pid).toBe(4242);

      const again = () => [
        agent('claude-coordinator-acme', 'w1:p1'),
        agent('deepseek-acme', 'w2:p1'),
        agent('deepseek-acme-2', 'w3:p1'),
      ];
      made.launch.agents = again;
      const second = testIo(root, { kind: 'owner' });
      const code2 = await runUp(FILE, second, sources({ ...host, agents: again }, made));
      expect(code2).toBe(0);
      expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator']);
      expect(made.closes).toEqual([]);
      expect(made.runs.map((run) => run.pane)).toEqual(['w1:p1']);
      expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
    },
  );

  test('a waiting seat whose recorded pane the host still lists is not replaced', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w9:p1',
              workspace: 'w9',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const made = world(IDLE);
    made.session = 'running';
    const listed = (): HerdrAgent[] => [
      { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null },
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [{ id: 'w9', label: 'claude-coordinator-acme · project coordinator' }],
      agents: listed,
    }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its waiting pane could not be read\n');
    expect(io.err).toContain(
      '  its record still names it; `team down` then `team up` (to restart the whole team), clears it\n',
    );
    expect(made.creates).toEqual([]);
    expect(made.closes).toEqual([]);
    expect(made.runs).toEqual([]);
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']?.pane).toBe('w9:p1');
  });

  test('a coordinator, an operator and the implementers whose waiting panes are gone are launched again', async () => {
    const team = makeExample(base, root, EXAMPLE
      .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
      .replace('  seats: 6', '  seats: 8')
      .replace(
        '    mode: shared               # the coordinator reads; it never implements\n',
        `    mode: shared               # the coordinator reads; it never implements

  - role: operator
    name: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`,
      ));
    writeFileSync(join(root, '.agents/team.yaml'), team);
    await approve();
    const waiting = {
      stage: 'launched',
      launched: { shell: 400, cli: [401] },
      waiting: { state: 'waiting-owner', classification: 'trust' },
    };
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': { ...waiting, pane: 'w9:p1', workspace: 'w9' },
            'claude-operator-acme': { ...waiting, pane: 'w8:p1', workspace: 'w8' },
            'deepseek-acme': { ...waiting, pane: 'w7:p1', workspace: 'w7' },
            'deepseek-acme-2': { ...waiting, pane: 'w6:p1', workspace: 'w6' },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const made = world(IDLE);
    made.session = 'running';
    made.launch.agents = () => [];
    const host = {
      sessionState: () => 'running' as const,
      alive: () => true,
      workspaces: () => [
        { id: 'w9', label: 'Claude Opus 5.5' },
        { id: 'w8', label: 'Claude Opus 5.5' },
        { id: 'w7', label: 'DeepSeek V4.1 Flash' },
        { id: 'w6', label: 'DeepSeek V4.1 Flash' },
      ],
      agents: () => [],
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(host, made));
    const report = `${io.out}${io.err}`;
    expect(code).toBe(0);
    expect(report).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced; its workspace w9 was left\n');
    expect(report).toContain('claude-operator-acme: its recorded pane w8:p1 was gone and was replaced; its workspace w8 was left\n');
    expect(report).toContain('deepseek-acme: its recorded pane w7:p1 was gone and was replaced; its workspace w7 was left\n');
    expect(report).toContain('deepseek-acme-2: its recorded pane w6:p1 was gone and was replaced; its workspace w6 was left\n');
    expect(report).not.toContain('left out: its waiting pane is gone');
    expect(report).not.toContain('its record still names it');
    expect(report).not.toContain('`team down` then `team up`');
    expect(report).not.toContain('`team remove deepseek-acme --keep` then `team add deepseek-acme`');
    expect(report).not.toContain('`team remove deepseek-acme-2 --keep` then `team add deepseek-acme-2`');
    expect(made.creates).toEqual([
      'claude-coordinator-acme · project coordinator',
      'claude-operator-acme · operator',
      'deepseek-acme · implementer',
      'deepseek-acme-2 · implementer',
    ]);
    expect(made.closes).toEqual([]);
    expect(made.runs.map((run) => run.pane)).toEqual(['w1:p1', 'w2:p1', 'w3:p1', 'w4:p1']);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats;
    expect(seats?.['claude-coordinator-acme']?.pane).toBe('w1:p1');
    expect(seats?.['claude-operator-acme']?.pane).toBe('w2:p1');
    expect(seats?.['deepseek-acme']?.pane).toBe('w3:p1');
    expect(seats?.['deepseek-acme-2']?.pane).toBe('w4:p1');
    for (const name of ['claude-coordinator-acme', 'claude-operator-acme', 'deepseek-acme', 'deepseek-acme-2']) {
      expect(seats?.[name]?.waiting).toBeUndefined();
      expect(seats?.[name]?.stage).toBe('ready');
    }
    expect(readState(join(root, '.agents')).sessions['acme-web']?.watch?.pid).toBe(4242);

    const again = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('claude-operator-acme', 'w2:p1'),
      agent('deepseek-acme', 'w3:p1'),
      agent('deepseek-acme-2', 'w4:p1'),
    ];
    made.launch.agents = again;
    const second = testIo(root, { kind: 'owner' });
    const code2 = await runUp(FILE, second, sources({ ...host, agents: again }, made));
    expect(code2).toBe(0);
    expect(`${second.out}${second.err}`).not.toContain('was gone and was replaced');
    expect(`${second.out}${second.err}`).not.toContain('its record still names it');
    expect(made.creates).toEqual([
      'claude-coordinator-acme · project coordinator',
      'claude-operator-acme · operator',
      'deepseek-acme · implementer',
      'deepseek-acme-2 · implementer',
    ]);
    expect(made.closes).toEqual([]);
    expect(made.runs.map((run) => run.pane)).toEqual(['w1:p1', 'w2:p1', 'w3:p1', 'w4:p1']);
    const kept = readState(join(root, '.agents')).sessions['acme-web']?.seats;
    expect(kept?.['claude-coordinator-acme']?.pane).toBe('w1:p1');
    expect(kept?.['claude-operator-acme']?.pane).toBe('w2:p1');
    expect(kept?.['deepseek-acme']?.pane).toBe('w3:p1');
    expect(kept?.['deepseek-acme-2']?.pane).toBe('w4:p1');
  });

  test('a gone waiting pane whose workspace the host does not list is replaced without naming one', async () => {
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w9:p1',
              workspace: 'w9',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    }));
    const made = world(IDLE);
    made.session = 'running';
    const others = () => [agent('deepseek-acme', 'w2:p1'), agent('deepseek-acme-2', 'w3:p1')];
    made.launch.agents = others;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [
        { id: 'w2', label: 'DeepSeek V4.1 Flash' },
        { id: 'w3', label: 'DeepSeek V4.1 Flash' },
      ],
      agents: others,
    }, made));
    expect(code).toBe(0);
    expect(`${io.out}${io.err}`).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced\n');
    expect(`${io.out}${io.err}`).not.toContain('was left');
    expect(`${io.out}${io.err}`).not.toContain('workspace w9');
    expect(made.closes).toEqual([]);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator']);
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat?.waiting).toBeUndefined();
    expect(seat?.pane).toBe('w1:p1');
  });
});

  test.each([
    ['another model', 'gpt-sol-idle', 'drift'],
    ['the file\'s model', 'idle', 'equal'],
    ['a family the grammar does not know', 'unknown-family', 'refused'],
    ['an output line where the footer was', 'spoof', 'refused'],
    ['a full status row where the footer was', 'full-row', 'drift'],
    ['a row whose version is not a token, and one log line for the seat', 'unreadable', 'unchecked'],
  ] as const)('cursor launch, screen shows %s', async (_label, screen, expectCase) => {
    const path = join(root, '.agents/team.yaml');
    const cursorSeat = [
      '  - role: implementer',
      '    name: cursor-acme',
      '    cli: cursor',
      '    vendor: xai',
      '    model: Grok',
      '    version: "4.7"',
      '    launch: cursor-agent',
      '    mode: shared',
    ].join('\n');
    writeFileSync(path, makeExample(base, root, EXAMPLE
      .replace(
        '    count: 2                   # deepseek-acme, deepseek-acme-2\n',
        '    count: 2\n    stopped: true\n',
      )
      .replace(/  - role: implementer\n    name: codex-acme[\s\S]*?stopped: true\n/, `${cursorSeat}\n`)));
    await approve();
    const home = readFileSync(join(import.meta.dir, '../fixtures/cursor/2026.10.01/idle.txt'), 'utf8');
    const footer = '  Grok 4.7 256K High                 Run Everything';
    // Muse Spark is a family the closed grammar does not know, and `  GPT-5.6 Sol 272K High`
    // without `Run Everything` is output shaped like a row: both screens read `unknown`, the
    // idle wait times out, and the seat is never renamed. A row that keeps every token —
    // `Run Everything` included — is a real row by every test the screen offers, so it is
    // accepted and the model check reads it. `  Grok 4x …` is a row whose version is not a
    // token: the screen reads idle, the model check finds nothing to read, and the seat
    // continues with a line that says so.
    const shown = screen === 'idle'
      ? home
      : screen === 'gpt-sol-idle'
        ? readFileSync(join(import.meta.dir, '../fixtures/cursor/2026.10.01/gpt-sol-idle.txt'), 'utf8')
        : screen === 'unknown-family'
          ? home.replace(footer, '  Muse Spark 1.3                    Run Everything')
          : screen === 'unreadable'
            ? home.replace(footer, '  Grok 4x 256K High                 Run Everything')
            : screen === 'spoof'
              ? home.replace(footer, '  GPT-5.6 Sol 272K High')
              : home.replace(footer, '  GPT-5.6 Sol 272K High              Run Everything');
    const made = world((_pane, label) => (label === 'cursor-acme · implementer' ? shown : IDLE));
    const sent: string[] = [];
    let cursorPane = '';
    let pasted = false;
    let typed = '';
    let status = 'idle';
    // In the unreadable case the cursor pane renders the typed rules the way the delivery tests'
    // panes do — the typed text's rows in the composer's box — and reports the agent working
    // after the Enter, so the delivery completes like any other seat's.
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return shown.replace('  → Plan, search, build anything', [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n'));
    };
    // Herdr's own status is the last word on a screen the profile cannot read
    // (`src/launch/unread.ts`): the two screens the grammar refuses report the pane working, so
    // the wait itself reads them as unknown and times out, as this scene pins. Every other case
    // reads its own screen, where the status makes no difference.
    const unread = screen === 'unknown-family' || screen === 'spoof';
    made.launch.agentStatus = () => (unread ? 'working' : status);
    // The order the run's host calls are made in, recorded so the unreadable case can pin it.
    const calls: string[] = [];
    const makeWorkspace = made.launch.createWorkspace;
    made.launch.createWorkspace = (session, cwd, label) => { calls.push(`create:${label}`); return makeWorkspace(session, cwd, label); };
    const runInPane = made.launch.paneRun;
    made.launch.paneRun = (session, pane, command) => { calls.push(`paneRun:${command.split(' ')[0]}`); return runInPane(session, pane, command); };
    const readPane = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push('paneText');
      return pane === cursorPane && pasted ? boxed() : readPane(session, pane);
    };
    const panesOf = made.launch.agentPanes;
    made.launch.agentPanes = (session) => { calls.push('agentPanes'); return panesOf(session); };
    const renameSeat = made.launch.renameAgent;
    made.launch.renameAgent = (session, pane, name) => { calls.push('renameAgent'); return renameSeat(session, pane, name); };
    made.launch.typeText = (_session, pane, text) => {
      sent.push(text); calls.push('typeText');
      if (screen === 'unreadable') { cursorPane = pane; typed = text; pasted = true; }
      return true;
    };
    made.launch.pressEnter = () => {
      sent.push('Enter'); calls.push('pressEnter');
      if (screen === 'unreadable') { status = 'working'; pasted = false; }
      return true;
    };
    // The two screens the grammar does not accept run out the idle wait. §2, no terminal: a
    // timeout keeps today's record instead of asking the owner; the accepted screens never
    // reach a dialog, so the caller changes nothing for them.
    const io = quietIo();
    const say = io.stdout;
    io.stdout = (text: string) => { calls.push('report'); say(text); };
    const detail = io.stderr;
    io.stderr = (text: string) => { calls.push(text.includes('not checked') ? 'not-checked' : 'detail'); detail(text); };
    const code = await runUp(FILE, io, sources({}, made));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['cursor-acme'];
    if (expectCase === 'drift') {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(made.renames).toContain('cursor-acme');
      expect(seat?.stage).toBe('launched');
      expect(io.out).toContain(
        'cursor-acme: left out: runs GPT Sol 5.6; the file says Grok 4.7; left at launched, not named. Add --model grok-4.7-high to its launch, or correct the file\'s model and version\n',
      );
      return;
    }
    if (expectCase === 'refused') {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(made.renames).toContain('cursor-acme');
      expect(seat?.stage).toBe('launched');
      expect(io.out).toContain('cursor-acme: left out: timeout\n');
      expect(io.err).toContain('timed out after 90 s waiting for its idle prompt; the screen last read unknown; left at launched');
      return;
    }
    if (expectCase === 'unchecked') {
      // The screen read idle and the model check found nothing to read: the seat is not left
      // unnamed — it is renamed and given its rules like any other seat, and the report says the
      // model was not checked.
      expect(code).toBe(0);
      expect(seat).toMatchObject({ stage: 'ready', rules: 'message' });
      expect(made.renames).toContain('cursor-acme');
      expect(sent.length).toBeGreaterThan(0);
      expect(io.err).toContain("cursor-acme: its screen doesn't show a model this version knows; not checked\n");
      // The note is stderr detail, not a record: the log holds the seat's one line, the record
      // itself — `ready` — and nothing of the note.
      const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
      const mine = log.split('\n').filter((line) => line.includes('cursor-acme'));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain('cursor-acme: ready');
      expect(log).not.toContain("doesn't show a model");
      // The seat's own calls, in order: the wait's read and the model check's read of the
      // screen, the rename, then the delivery — read, typed, read back, entered — and the ready
      // report after it. The not-checked note was held when the check made it (before the
      // rename, so the seat is named only after the check has had its say) and is written after
      // the record, as the record's stderr detail.
      const from = calls.indexOf('create:cursor-acme · implementer');
      expect(calls.slice(from, from + 14)).toEqual([
        'create:cursor-acme · implementer',
        'renameAgent',
        'paneRun:AGENT_UNATTENDED=1',
        'paneText',
        'paneText',
        'agentPanes',
        'paneText',
        'typeText',
        'paneText',
        'paneText',
        'pressEnter',
        'paneText',
        'report',
        'not-checked',
      ]);
      return;
    }
    expect(made.renames).toContain('cursor-acme');
    expect(sent.length).toBeGreaterThan(0);
    expect(io.out).not.toContain('left at launched, not named');
    expect(io.out).not.toContain('not checked');
  });

// The file names a model the running CLI is not. The pane stays, unnamed. The record has to
// name that pane and the process in it, and say what clears it; once the file names the model
// the screen shows, the next up finishes the seat and down stops the session.
test('a mismatched model leaves its pane recorded, and the corrected file lets up and down finish', async () => {
  const path = join(root, '.agents/team.yaml');
  const cursorSeat = [
    '  - role: implementer',
    '    name: cursor-acme',
    '    cli: cursor',
    '    vendor: xai',
    '    model: Grok',
    '    version: "4.7"',
    '    launch: cursor-agent',
    '    mode: shared',
  ].join('\n');
  writeFileSync(path, makeExample(base, root, EXAMPLE
    .replace(
      '    count: 2                   # deepseek-acme, deepseek-acme-2\n',
      '    count: 2\n    stopped: true\n',
    )
    .replace(/  - role: implementer\n    name: codex-acme[\s\S]*?stopped: true\n/, `${cursorSeat}\n`)));
  await approve();
  const shown = readFileSync(join(import.meta.dir, '../fixtures/cursor/2026.10.01/gpt-sol-idle.txt'), 'utf8');
  const made = world((_pane, label) => (label === 'cursor-acme · implementer' ? shown : IDLE));
  made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
  const labels = new Map<string, string>();
  const createWorkspace = made.launch.createWorkspace;
  made.launch.createWorkspace = (session, cwd, label) => {
    const created = createWorkspace(session, cwd, label);
    if (created) labels.set(created.pane, label);
    return created;
  };
  const pasted = new Map<string, string>();
  const working = new Set<string>();
  const readPane = made.launch.paneText;
  made.launch.agentStatus = (_session, id) => (working.has(id) ? 'working' : 'idle');
  made.launch.paneText = (session, id) => {
    const text = pasted.get(id);
    if (text === undefined) return readPane(session, id);
    if (labels.get(id) === 'cursor-acme · implementer') {
      const [first = '', ...rest] = text.split('\n');
      return shown.replace('  → Plan, search, build anything', [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n'));
    }
    return claudeBox(text);
  };
  made.launch.typeText = (_session, id, text) => { pasted.set(id, text); return true; };
  made.launch.pressEnter = (_session, id) => { pasted.delete(id); working.add(id); return true; };
  const io = quietIo();
  const code = await runUp(FILE, io, sources({}, made));
  const held = readState(join(root, '.agents')).sessions['acme-web']?.seats['cursor-acme'];
  const pane = held?.pane ?? '';
  const workspace = held?.workspace ?? '';
  expect(code).toBe(1);
  expect(pane).not.toBe('');
  expect(workspace).not.toBe('');
  expect(made.renames).toContain('cursor-acme');
  expect(io.out).toContain('left at launched, not named');

  writeFileSync(path, readFileSync(path, 'utf8').replace(
    '    name: cursor-acme\n    cli: cursor\n    vendor: xai\n    model: Grok\n    version: "4.7"\n',
    '    name: cursor-acme\n    cli: cursor\n    vendor: xai\n    model: GPT Sol\n    version: "5.6"\n',
  ));
  await approve();
  const seats = () => readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
  const listed = (): HerdrAgent[] => Object.entries(seats()).flatMap(([name, seat]) => {
    if (!seat.pane || !seat.workspace) return [];
    const titled = seat.stage === 'ready' || seat.stage === 'named' ? name : null;
    return [{
      name: titled,
      agent: name.includes('cursor') ? 'cursor' : 'claude',
      pane: seat.pane,
      workspace: seat.workspace,
      status: 'idle',
      cwd: null,
    }];
  });
  const seen = listed();
  made.launch.agents = () => seen;
  const next = quietIo();
  const code2 = await runUp(FILE, next, sources({
    agents: () => seen,
    sessionState: () => 'running',
  }, made));
  const after = seats()['cursor-acme'];

  const closed: string[] = [];
  const stopped: string[] = [];
  const downLaunch: DownLaunch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => listed().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    stopSession(session) {
      stopped.push(session);
      return true;
    },
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const downIo = testIo(root, { kind: 'owner' });
  const code3 = await runDown(FILE, downIo, {
    sessionRunning: () => stopped.length === 0,
    agents: listed,
    alive: () => false,
    screen: () => ({ kind: 'unknown' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => ['zsh'],
    shellBack: () => true,
    now: () => NOW,
    home,
    launch: downLaunch,
  });

  expect(next.out + next.err).not.toContain("doesn't record");
  expect({ code: code2, out: next.out, err: next.err, stage: after?.stage ?? null }).toMatchObject({ code: 0, stage: 'ready' });
  expect(downIo.out).not.toContain('not stopped');
  expect(code3).toBe(0);
  expect(stopped).toEqual(['acme-web']);
  expect(closed).toContain(workspace);
  expect(held?.launched).toEqual({ shell: 400, cli: [401] });
  expect(io.err).toContain(`  pane ${pane}; `);
  expect(io.err).toContain(', clears it\n');
});

describe('team up, delegated', () => {
  // A caller in a pane of another session, as the `delegates` section names one. The gate is
  // faked everywhere here — its preflights are its own file's tests; these pin what `up` does
  // with either verdict. Every run's stdin is a terminal, the one caller that would prompt
  // today, because a delegated run takes the no-terminal path whatever its stdin is.
  const delegateFile = () => {
    writeFileSync(join(root, '.agents/team.yaml'), `${makeExample(base, root)}\ndelegates:\n  - pane: main/w1:p1\n    commands: [up]\n`);
  };
  const delegatedIo = () => {
    const io = testIo(root, { kind: 'seat', name: 'work', pane: 'w1:p1', session: 'main' });
    io.stdinIsTTY = true;
    return io;
  };
  const passed = { delegateGate: () => ({ kind: 'passed' as const, pane: 'main/w1:p1' }) };
  // The audit line, captured — with the server count at the moment it was written, the proof
  // it lands before the run's first effect.
  const auditsOf = (made?: World) => {
    const audits: { dir: string; pane: string; command: string; now?: Date; starts?: number }[] = [];
    return {
      audits,
      logDelegated: (dir: string, pane: string, command: string, now?: Date) => {
        audits.push({ dir, pane, command, now, ...(made ? { starts: made.starts } : {}) });
      },
    };
  };

  test('a file with no delegates keeps the ordinary refusal: the gate is never asked', async () => {
    await approve();
    const made = world();
    let asked = 0;
    const io = testIo(root, { kind: 'seat', name: 'work', pane: 'w1:p1', session: 'main' });
    const code = await runUp(FILE, io, sources({
      delegateGate: () => {
        asked++;
        return { kind: 'passed', pane: 'main/w1:p1' };
      },
    }, made));
    expect(code).toBe(1);
    expect(asked).toBe(0);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(made.creates).toEqual([]);
  });

  // The flag is the owner's, so its target is not looked at.
  test('with no delegates a non-owner\'s --file is the owner refusal, gate never asked', async () => {
    await approve();
    const made = world();
    let asked = 0;
    const caller = testIo(root, { kind: 'seat', name: 'work', pane: 'w1:p1', session: 'main' });
    const code = await runUp(['--file', join(root, 'missing.yaml')], caller, sources({
      delegateGate: () => {
        asked++;
        return { kind: 'passed', pane: 'main/w1:p1' };
      },
    }, made));
    expect(code).toBe(1);
    expect(asked).toBe(0);
    expect(caller.out).toBe('');
    expect(caller.err).toBe('deny\n');
  });

  test('the owner\'s missing --file stays exit 2 even with a delegates section: gate never asked', async () => {
    delegateFile();
    await approve();
    const made = world();
    let asked = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', join(root, 'missing.yaml')], io, sources({
      delegateGate: () => {
        asked++;
        return { kind: 'passed', pane: 'main/w1:p1' };
      },
    }, made));
    expect(code).toBe(2);
    expect(asked).toBe(0);
    expect(io.err).toBe(`team up: no team file at ${join(root, 'missing.yaml')}\n`);
  });

  // The review's reproduction: an unplaced caller, a valid default file with a `delegates`
  // section, `team up --file <missing>`. Eligibility is read from the DEFAULT file — the gate
  // sees its team and the flag — and the flagged target is never read: the gate's refusal
  // answers, not today's exit 2. A dry run returns that same refusal before a plan, so the
  // host is not asked and the flagged file stays unread.
  test('an unplaced caller with a delegates file and a missing --file gets the gate\'s refusal, not exit 2', async () => {
    delegateFile();
    await approve();
    const made = world();
    let asked = 0;
    let seen: { team: { delegates: unknown }; root: string; flags: readonly string[] } | undefined;
    const io = testIo(root, { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    const code = await runUp(['--file', join(root, 'missing.yaml')], io, sources({
      delegateGate: (input) => {
        asked++;
        seen = input;
        return {
          kind: 'refused',
          id: 'up.delegate',
          text: 'only the owner or the approved delegate runs `up`; this call is unplaced (its parent processes can\'t be read to the top)',
        };
      },
    }, made));
    expect(code).toBe(1);
    expect(asked).toBe(1);
    expect(seen?.root).toBe(root);
    expect(seen?.team.delegates).not.toBeNull();
    expect(seen?.flags).toContain('file');
    expect(io.err).toBe(
      'team up: only the owner or the approved delegate runs `up`; this call is unplaced (its parent processes can\'t be read to the top)\n',
    );
    expect(io.err).not.toContain('no team file');
    expect(made.starts).toBe(0);
  });

  test('the same caller on a dry run: the gate\'s refusal, before a plan', async () => {
    delegateFile();
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    const code = await runUp(['--dry-run', '--file', join(root, 'missing.yaml')], io, sources({
      delegateGate: () => ({
        kind: 'refused',
        id: 'up.delegate-flag',
        text: "--file is the owner's; the approved delegate cannot use it",
      }),
    }, made));
    expect(code).toBe(1);
    expect(io.err).toBe("team up: --file is the owner's; the approved delegate cannot use it\n");
    expect(io.out).toBe('');
    expect(io.out + io.err).not.toContain('no team file');
    expect(made.starts).toBe(0);
  });

  // The delegate's own prohibited flags reach the gate with the run still unread: `--session`
  // is refused exactly as `--file` is, and the session the caller tried to name is not adopted.
  test('a delegated run\'s --session is the gate\'s to refuse, and never adopted', async () => {
    delegateFile();
    await approve();
    const made = world();
    let seen: { flags: readonly string[] } | undefined;
    const io = delegatedIo();
    const code = await runUp(['--session', 'elsewhere'], io, sources({
      delegateGate: (input) => {
        seen = input;
        return { kind: 'refused', id: 'up.delegate-flag', text: "--session is the owner's; the approved delegate cannot use it" };
      },
    }, made));
    expect(code).toBe(1);
    expect(seen?.flags).toContain('session');
    expect(io.err).toBe("team up: --session is the owner's; the approved delegate cannot use it\n");
    expect(made.starts).toBe(0);
  });

  test('the owner is never gated: a delegates section changes nothing for the owner at a terminal', async () => {
    delegateFile();
    await approve();
    const made = world();
    let asked = 0;
    const { audits, logDelegated } = auditsOf();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      delegateGate: () => {
        asked++;
        return { kind: 'passed', pane: 'main/w1:p1' };
      },
      logDelegated,
    }, made));
    expect(code).toBe(0);
    expect(asked).toBe(0);
    expect(audits).toEqual([]);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
  });

  test('a live delegates entry for up runs even when the gate refuses', async () => {
    delegateFile();
    await approve();
    const made = world();
    const { audits, logDelegated } = auditsOf();
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({
      delegateGate: () => ({
        kind: 'refused',
        id: 'up.delegate-flag',
        text: "--file is the owner's; the approved delegate cannot use it",
      }),
      logDelegated,
    }, made));
    expect(code).toBe(0);
    expect(io.err).not.toContain("--file is the owner's");
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(made.starts).toBe(1);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', watchLabel('acme-web')]);
    expect(audits).toEqual([]);
  });

  test('a live delegates entry for up dry-runs even when the gate refuses', async () => {
    delegateFile();
    await approve();
    const made = world();
    const { audits, logDelegated } = auditsOf();
    const io = delegatedIo();
    const code = await runUp(['--dry-run', ...FILE], io, sources({
      delegateGate: () => ({
        kind: 'refused',
        id: 'up.delegate-command',
        text: 'the delegate pane main/w1:p1 runs only what its commands list names, and up is not in it',
      }),
      logDelegated,
    }, made));
    expect(code).toBe(0);
    expect(io.out).not.toContain('would refuse');
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(made.starts).toBe(0);
    expect(audits).toEqual([]);
  });

  test('a passed gate runs the team and writes the audit line once, before its first effect', async () => {
    delegateFile();
    await approve();
    const made = world();
    const { audits, logDelegated } = auditsOf(made);
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({ ...passed, logDelegated }, made));
    expect(code).toBe(0);
    expect(made.starts).toBe(1);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', watchLabel('acme-web')]);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(made.terminal.reads).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ dir: join(root, '.agents'), pane: 'main/w1:p1', command: 'up' });
    expect(audits[0]?.now).toBeInstanceOf(Date);
    // The line is on the record before the run reached herdr at all.
    expect(audits[0]?.starts).toBe(0);
  });

  test("a delegated run takes the same run lock: refused with the holder's pid, no audit line", async () => {
    delegateFile();
    await approve();
    mkdirSync(join(root, '.agents', 'seat-locks', 'acme-web'), { recursive: true });
    writeFileSync(seatLockPath(join(root, '.agents'), 'acme-web', '.run'), `${process.pid} 0a1b2c3d\n`);
    const made = world();
    const { audits, logDelegated } = auditsOf(made);
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({ ...passed, logDelegated }, made));
    expect(code).toBe(1);
    expect(io.err).toBe(
      `team up: another session-mutating run is holding session acme-web (pid ${process.pid}); try again when it is done\n`,
    );
    // The delegation is not on the record either: the run lock comes before the audit line.
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
    expect(audits).toEqual([]);
  });

  test('a passed gate on a dry run plans only: no effects and no audit line', async () => {
    delegateFile();
    await approve();
    const made = world();
    const { audits, logDelegated } = auditsOf();
    const io = delegatedIo();
    const code = await runUp(['--dry-run', ...FILE], io, sources({ ...passed, logDelegated }, made));
    expect(code).toBe(0);
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(io.out).not.toContain('would refuse');
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
    expect(audits).toEqual([]);
  });

  // The RFC's table: every dialog a delegated run can find is closed without input and the
  // record carries the classification with `(no terminal for owner)` — the path an owner
  // without a terminal takes — even though this caller's stdin is a terminal. Never a prompt,
  // never a focus, never a key or a text sent.
  test.each([
    ['trust', 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n'],
    ['permission', PERMISSION],
    ['question', 'Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'],
  ] as const)('a delegated run at a %s dialog closes without input and never prompts', async (classification, screen) => {
    delegateFile();
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme · project coordinator' ? screen : IDLE));
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'claude',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const focused: string[] = [];
    made.launch.focus = (_session, pane) => {
      focused.push(pane);
      return true;
    };
    const { audits, logDelegated } = auditsOf(made);
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({ ...passed, logDelegated }, made));
    expect(code).toBe(1);
    expect(io.out).toContain(`claude-coordinator-acme: left out: ${classification} (no terminal for owner)\n`);
    expect(io.err).toContain('  its workspace was closed without input\n');
    expect(io.out + io.err).not.toContain('[o] open pane');
    expect(made.terminal.reads).toBe(0);
    expect(focused).toEqual([]);
    expect(made.closes).toEqual(['w1']);
    // The run began, so the delegation is on the record before the first effect.
    expect(audits).toHaveLength(1);
    expect(audits[0]?.starts).toBe(0);
  });

  test('a vendor notice closes the same way: a delegated run never answers it', async () => {
    writeFileSync(
      join(root, '.agents/team.yaml'),
      `${makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n'))}\ndelegates:\n  - pane: main/w1:p1\n    commands: [up]\n`,
    );
    await approve();
    const startup = readFileSync(join(import.meta.dir, '../fixtures/codex/0.157.0/startup.txt'), 'utf8');
    const made = world((_pane, label) => (label === 'codex-acme · implementer' ? fileModel(startup) : IDLE));
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'codex',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 700, foreground: [700, 701] });
    const { logDelegated } = auditsOf();
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({ ...passed, logDelegated }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('codex-acme: left out: vendor notice (no terminal for owner)\n');
    expect(io.err).toContain('  its workspace was closed without input\n');
    expect(made.closes).toEqual(['w2']);
    expect(made.terminal.reads).toBe(0);
  });

  test("a delegated run's idle timeout is a dialog too: closed without input, never left at launched", async () => {
    delegateFile();
    await approve();
    // A screen that never idles and never reads as a dialog: only the deadline ends the wait.
    const made = world("❯ zsh ../tools/launcher.sh\nzsh: can't open input file: ../tools/launcher.sh\n~ ❯\n");
    made.launch.agents = (session) =>
      (made.launch.agentPanes(session) ?? []).map((pane) => ({
        name: null,
        agent: 'claude',
        pane,
        workspace: pane.split(':')[0] ?? pane,
        status: 'idle',
        cwd: null,
      }));
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    const { logDelegated } = auditsOf();
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({ ...passed, logDelegated }, made));
    expect(code).toBe(1);
    // The delegated record carries the no-terminal suffix — not the plain `timeout` an owner
    // without a terminal is left with today, which leaves the seat at launched.
    expect(io.out).toContain('claude-coordinator-acme: left out: timeout (no terminal for owner)\n');
    expect(io.out).not.toContain('claude-coordinator-acme: left out: timeout\n');
    expect(io.err).toContain('  its workspace was closed without input\n');
    expect(io.err).not.toContain('left at launched');
    expect(made.closes).toContain('w1');
    expect(made.terminal.reads).toBe(0);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
  });

  // Amendment 3's role-path hold, for `up`: the ordinary rule reads kinds, not names, so a
  // delegate carrying the coordinator's own name is gated all the same — and a delegated run,
  // whatever it is named, never reaches the owner's prompt path.
  test('a delegate named like the coordinator is gated all the same, and never the owner path', async () => {
    delegateFile();
    await approve();
    const made = world();
    let asked = 0;
    const { audits, logDelegated } = auditsOf(made);
    const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'main' });
    io.stdinIsTTY = true;
    const code = await runUp(FILE, io, sources({
      delegateGate: () => {
        asked++;
        return { kind: 'passed', pane: 'main/w1:p1' };
      },
      logDelegated,
    }, made));
    expect(code).toBe(0);
    expect(asked).toBe(1);
    expect(audits).toHaveLength(1);
    // Named like the lead or not, the run is a delegated one: it never reads the terminal.
    expect(made.terminal.reads).toBe(0);
    expect(io.out + io.err).not.toContain('[o] open pane');
  });

  // A run with no terminal is not admitted, so it never enters the delegate branch. The gate
  // is not asked, the one sentence is the refusal, and nothing is launched.
  test('a run with no terminal never enters the delegate branch', async () => {
    delegateFile();
    await approve();
    const made = world("❯ zsh ../tools/launcher.sh\nzsh: can't open input file: ../tools/launcher.sh\n~ ❯\n");
    let asked = 0;
    const { audits, logDelegated } = auditsOf();
    const io = testIo(root, { kind: 'owner-no-tty' });
    const code = await runUp(FILE, io, sources({
      delegateGate: () => {
        asked++;
        return { kind: 'passed', pane: 'main/w1:p1' };
      },
      logDelegated,
    }, made));
    expect(code).toBe(1);
    expect(asked).toBe(0);
    expect(audits).toEqual([]);
    expect(io.err).toContain('team up: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane\n');
    expect(io.out).not.toContain('left out:');
    expect(made.closes).toEqual([]);
  });

  // The classifications a fresh seat's polls never produce reach the same close through a
  // resumed waiting seat — and the fresh read names the stop, never the stored classification.
  test.each([
    ['unsent', `${'─'.repeat(40)}\n❯ left unsent in the box\n${'─'.repeat(40)}\n  main · Opus 5.5\n`],
    ['unknown', 'a screen no shape matches\n'],
  ] as const)('a resumed waiting seat reading %s is left as it is on a run with no terminal', async (_classification, screen) => {
    delegateFile();
    await approve();
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'vendor notice' },
            },
            'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
            'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
          },
          worktrees: {},
        },
      },
    }));
    const made = world();
    made.session = 'running';
    made.seed('w1:p1', screen, true);
    const listed = [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = () => listed;
    made.launch.agentPanes = () => ['w1:p1', 'w2:p1', 'w3:p1'];
    made.launch.processInfo = (_session, pane) =>
      pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] }
        : pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] }
          : { shell: 510, foreground: [510, 511] };
    const { logDelegated } = auditsOf();
    const io = delegatedIo();
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [
        { id: 'w1', label: 'claude-coordinator-acme · project coordinator' },
        { id: 'w2', label: 'deepseek-acme · implementer' },
        { id: 'w3', label: 'deepseek-acme · implementer' },
      ],
      ...passed,
      logDelegated,
    }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: a run with no terminal does not close a waiting seat; left as it is\n');
    expect(made.closes).toEqual([]);
    expect(made.terminal.reads).toBe(0);
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme']?.waiting?.state).toBe('waiting-owner');
  });

  // The three states a target session can be in, with the REAL gate: only its two herdr reads
  // about the team's session are faked, with the answers herdr 0.7.1 really gives — an absent or
  // stopped session fails `agent list` while `session list` still reports it, running false, and
  // an unreachable herdr answers neither. Everything else the gate reads is real: the approval
  // `approve()` wrote into `home`, the approved copy, the drift and the state.
  type GateInput = Parameters<typeof delegateGate>[0];
  const gateReading = (running: boolean | null) => (input: GateInput) =>
    delegateGate({
      ...input,
      sources: {
        agents: (session) => (session === 'acme-web' ? null : []),
        sessionRunning: () => running,
      },
    });
  const STATES = [
    {
      name: 'stopped',
      live: () => 'stopped' as const,
      running: false,
      real: ['session acme-web is stopped'],
      starts: 0,
    },
    { name: 'absent', live: () => 'absent' as const, running: false, real: [], starts: 1 },
    {
      name: 'unreachable',
      live: () => null,
      running: null,
      real: [`herdr doesn't answer`],
      starts: 1,
    },
  ] as const;

  test('a pane the grant names dry-runs up', async () => {
    delegateFile();
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'pane', pane: 'w1:p1', session: 'main' });
    io.stdinIsTTY = true;
    const code = await runUp(['--dry-run'], io, sources({
      sessionState: () => 'absent',
      delegateGate: gateReading(false),
      machine: () => fine,
    }, made));
    expect(code).toBe(0);
    expect(io.out).not.toContain('unplaced');
    expect(io.out).not.toContain('would refuse');
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(made.starts).toBe(0);
  });

  test('a pane no grant lists is refused by name', async () => {
    delegateFile();
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'pane', pane: 'w9:p1', session: 'main' });
    io.stdinIsTTY = true;
    const code = await runUp(['--dry-run'], io, sources({
      sessionState: () => 'absent',
      delegateGate: gateReading(false),
      machine: () => fine,
    }, made));
    expect(code).toBe(1);
    // A dry run is never answered with the bare word: it names the reason and the owner's own
    // command, and the refusal leaves through the real run's exit — the plan, nothing run.
    expect(io.err).toBe('');
    expect(io.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is it runs in pane main/w9:p1, which no grant lists\n');
    expect(io.out).toContain('! to unblock: a `leads` seat runs `team up` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
  });

  for (const state of STATES) {
    test(`a delegated up with the session ${state.name}: the gate's answer, then the run's`, async () => {
      delegateFile();
      await approve();
      const made = world();
      const io = delegatedIo();
      const code = await runUp([], io, sources({
        sessionState: state.live,
        delegateGate: gateReading(state.running),
        machine: () => fine,
      }, made));
      const said = io.err.split('\n').filter((line) => line.startsWith('team up: ')).map((line) => line.slice('team up: '.length));
      expect(said).toEqual([...state.real]);
      if (state.real.length === 0) {
        expect(code).toBe(0);
        expect(made.starts).toBe(1);
        expect(made.creates.length).toBeGreaterThan(0);
      } else {
        expect(code).toBe(1);
        expect(made.creates).toEqual([]);
      }
      expect(io.out).not.toContain('would refuse');
    });

    test(`a delegated up --dry-run with the session ${state.name}: the same refusals, the plan, the real run's status`, async () => {
      delegateFile();
      await approve();
      const made = world();
      const io = delegatedIo();
      const code = await runUp(['--dry-run'], io, sources({
        sessionState: state.live,
        delegateGate: gateReading(state.running),
        machine: () => fine,
      }, made));
      const would = io.out
        .split('\n')
        .filter((line) => line.startsWith('! up would refuse: '))
        .map((line) => line.slice('! up would refuse: '.length));
      expect(code).toBe(state.real.length === 0 ? 0 : 1);
      expect(would).toEqual([...state.real]);
      expect(made.starts).toBe(0);
      expect(made.creates).toEqual([]);
    });
  }

  test('the dry run and the real run agree on every refusal, in all three states', async () => {
    delegateFile();
    await approve();
    for (const state of STATES) {
      const realMade = world();
      const realIo = delegatedIo();
      const real = await runUp([], realIo, sources({
        sessionState: state.live,
        delegateGate: gateReading(state.running),
        machine: () => fine,
      }, realMade));
      const dryMade = world();
      const dryIo = delegatedIo();
      const dry = await runUp(['--dry-run'], dryIo, sources({
        sessionState: state.live,
        delegateGate: gateReading(state.running),
        machine: () => fine,
      }, dryMade));
      const said = realIo.err.split('\n').filter((line) => line.startsWith('team up: ')).map((line) => line.slice('team up: '.length));
      const would = dryIo.out
        .split('\n')
        .filter((line) => line.startsWith('! up would refuse: '))
        .map((line) => line.slice('! up would refuse: '.length));
      expect(would).toEqual(said);
      expect(dry).toBe(real);
      expect(real).toBe(state.real.length === 0 ? 0 : 1);
    }
  });
});

describe('team down, live', () => {
  let liveSeat = 'deepseek-acme';
  beforeEach(() => {
    liveSeat = 'deepseek-acme';
    return approve();
  });

  function seat(status = 'idle'): HerdrAgent {
    return agent(liveSeat, 'w3:p1', status);
  }

  function harness(screen: Screen, status = 'idle') {
    const typed: string[] = [];
    const keys: string[] = [];
    const entered: string[] = [];
    const closed: string[] = [];
    const killed: number[] = [];
    const stopped: string[] = [];
    const deleted: string[] = [];
    let clock = NOW.getTime();
    let gone = false;
    let current = status;
    let onSleep = () => {};
    // What the pane shows: the empty idle box before any typing, the box with the typed
    // text after one, as the CLI renders it.
    let box: string | undefined = claudeBox('');
    let clearFails = false;
    const launch: DownLaunch = {
      typeText(_session, _pane, text) {
        typed.push(text);
        box = claudeBox(text);
        return true;
      },
      sendKey(_session, _pane, key) {
        keys.push(key);
        box = claudeBox('');
        return true;
      },
      pressEnter() {
        entered.push('enter');
        gone = true;
        return true;
      },
      agentPanes: () => (gone ? [] : ['w3:p1']),
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      stopSession(session) {
        stopped.push(session);
        return true;
      },
      deleteSession(session) {
        deleted.push(session);
        return !clearFails;
      },
      kill(pid) {
        killed.push(pid);
        return true;
      },
      sleep: async (ms) => {
        clock += ms;
        onSleep();
      },
      now: () => new Date(clock),
    };
    // Herdr's answer once the stop has run: a session `down` stopped is no longer running.
    const sourcesOf = (overrides: Partial<DownSources> = {}): DownSources => ({
      sessionRunning: () => stopped.length === 0,
      agents: () => [seat(current)],
      alive: () => false,
      screen: () => screen,
      screenText: () => box,
      status: () => current,
      foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
      now: () => new Date(clock),
      sleep: launch.sleep,
      home,
      launch,
      ...overrides,
    });
    return {
      typed,
      keys,
      entered,
      closed,
      killed,
      stopped,
      deleted,
      launch,
      sourcesOf,
      setStatus: (value: string) => {
        current = value;
      },
      onSleep: (hook: () => void) => {
        onSleep = hook;
      },
      failClear: () => {
        clearFails = true;
      },
      // What the pane shows, set from outside the launch calls: a run that arrives at a box
      // already holding text — the leftover exit text of an earlier stop — reads it from the
      // first plan-build read on.
      setBox: (raw: string) => {
        box = raw;
      },
    };
  }

  test('an agent that exits between the text and the Enter is not sent the Enter', async () => {
    const run = harness({ kind: 'idle' });
    let live = true;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      live = false;
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => (live ? ['claude'] : ['zsh']) }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(io.out).toContain('deepseek-acme: no live agent in its pane; its exit was not typed (team down --abandon closes it)\n');
  });

  test('a pane with no live agent is not typed into', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'] }));
    expect(code).toBe(1);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: no live agent in its pane; its exit was not typed (team down --abandon closes it)\n');
  });

  test('a seat whose CLI exited — its shell back in front — is closed by one run, and the session stops', async () => {
    // The bare-shell case: the pane's own shell process is back in front (`shellBack`) and no
    // `claude` process is in its foreground list. The screen draws nothing a profile recognises,
    // which is exactly why the screen alone can never tell this from a live CLI. One run closes
    // the workspace, stops and clears the session, and types nothing — no `--abandon`.
    const run = harness({ kind: 'unknown' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'], shellBack: () => true }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.keys).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(run.deleted).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: its CLI had exited; its workspace was closed\n');
    expect(io.out).toContain('session acme-web: stopped and cleared\n');
    expect(io.out).not.toContain('does not recognise');
    expect(io.err).toBe('');
  });

  test('a stale idle capture over a pane at its shell is closed too: the process reading outranks the screen', async () => {
    // An idle-looking capture cannot make a pane whose shell is back read as a live seat, just
    // as an unrecognised capture cannot make it read as one. The foreground list holds no CLI.
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'], shellBack: () => true }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('deepseek-acme: its CLI had exited; its workspace was closed\n');
  });

  test('a live CLI on an unreadable screen keeps the refusal, byte for byte, even when the shell reading comes back', async () => {
    // Both facts are required: no CLI process in the foreground list *and* the pane's own shell
    // in front. A CLI still listed is never closed, whatever the shell pid reading says.
    const run = harness({ kind: 'unknown' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['claude'], shellBack: () => true }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('deepseek-acme: shows a screen the profile does not recognise; left running\n');
    expect(io.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
  });

  test('an unreadable foreground list keeps today\'s refusal', async () => {
    const run = harness({ kind: 'unknown' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => null, shellBack: () => true }));
    expect(code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: shows a screen the profile does not recognise; left running\n');
  });

  test('without the shell-back reading a pane at its shell keeps today\'s refusal', async () => {
    // The reading is optional on the sources: absent, every classification is the screen's,
    // exactly as before this change.
    const run = harness({ kind: 'unknown' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'] }));
    expect(code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: shows a screen the profile does not recognise; left running\n');
  });

  test('the dry run of a bare-shell close names the close and types nothing', async () => {
    const run = harness({ kind: 'unknown' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--dry-run', ...FILE], io, run.sourcesOf({ foreground: () => ['zsh'], shellBack: () => true }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('+ herdr --session acme-web workspace close w3');
    expect(io.out).toContain('its CLI had exited; closed without typing');
  });

  test('types the exit only when the screen is idle, then closes the workspace', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
    // The close op is `down`'s own purpose, announced by its plan; the line and the log name the seat and the fact.
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain('deepseek-acme: stopped');
  });

  test('a jules seat herdr reports unknown is free at its idle table, and stops on ctrl+c', async () => {
    // herdr 0.7.1 reports a jules pane as no agent, and `unknown` after the rename. The profile
    // says its herdr status is unreliable, so the screen module's idle table is the reading: the
    // seat is free, one ctrl+c is pressed at that table, and the pane's own process says it left.
    const julesIdle = readFileSync(join(import.meta.dir, '../fixtures/jules/0.1.42/idle.txt'), 'utf8');
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(
        base,
        root,
        EXAMPLE
          + '\n  - role: implementer\n'
          + '    name: jules-acme\n'
          + '    cli: jules\n'
          + '    vendor: google\n'
          + '    model: Jules\n'
          + '    version: "0.1.42"\n'
          + '    launch: jules\n',
      ),
    );
    await approve();
    liveSeat = 'jules-acme';
    const run = harness(readScreen('jules', julesIdle), 'unknown');
    run.setBox(julesIdle);
    let sent = false;
    run.launch.sendKey = (_session, _pane, key) => {
      run.keys.push(key);
      sent = true;
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      status: () => 'unknown',
      foreground: () => (sent ? ['zsh'] : ['jules']),
    }));
    expect(code).toBe(0);
    expect(run.keys).toEqual(['ctrl+c']);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('jules-acme: stopped\n');
  });

  test('clears the session it stopped, in the same run, and says so in one line', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.deleted).toEqual(['acme-web']);
    expect(io.out).toContain('session acme-web: stopped and cleared\n');
  });

  test('down then up needs no step in between', async () => {
    await approve();
    const run = harness({ kind: 'idle' });
    const owner = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, owner, run.sourcesOf())).toBe(0);
    expect(run.deleted).toEqual(['acme-web']);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'absent' }, made));
    expect(code).toBe(0);
    expect(made.starts).toBe(1);
    expect(io.out).not.toContain('herdr session delete');
  });

  test('a session herdr still reports running after the stop is not cleared', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ sessionRunning: () => true }));
    expect(code).toBe(0);
    expect(run.stopped).toEqual(['acme-web']);
    expect(run.deleted).toEqual([]);
    expect(io.out).toContain('session acme-web: stopped; it did not clear\n');
  });

  test('a clear that keeps failing is retried, reported, and still exits 0', async () => {
    const run = harness({ kind: 'idle' });
    run.failClear();
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.deleted.length).toBeGreaterThan(1);
    expect(run.deleted.every((name) => name === 'acme-web')).toBe(true);
    expect(io.out).toContain('session acme-web: stopped; it did not clear\n');
    expect(io.out).not.toContain('herdr session delete');
  });

  test('a seat left running clears nothing', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
    expect(io.out).not.toContain('cleared');
  });

  test("a seat's call is refused before anything is stopped or cleared", async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
  });

  test('holds Enter when the status turns working after the text', async () => {
    const run = harness({ kind: 'idle' });
    let looks = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(
      FILE,
      io,
      run.sourcesOf({
        status: () => {
          looks += 1;
          return looks === 1 ? 'idle' : 'working';
        },
      }),
    );
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not typed; left as it is (team down --abandon closes it)\n');
  });

  test('a seat already at the framed exit question is not asked', async () => {
    const raw = readFileSync(new URL('../fixtures/exit-typing/claude-code-shell-question-ansi.txt', import.meta.url), 'utf8');
    const screen = readScreen('claude-code', raw);
    expect(screen.kind).toBe('exit question');
    expect(stateOf('idle', screen)).toBe('blocked');
    const run = harness(screen, 'idle');
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ screenText: () => raw, status: () => 'idle' }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.keys).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('  skip deepseek-acme: sits at its own exit question; left running (team down --abandon closes it)\n');
    expect(io.out).not.toContain('its exit was not typed');
  });

  test('abandon closes a pre-existing exit question only as a seat that cannot be asked', async () => {
    const raw = readFileSync(new URL('../fixtures/exit-typing/claude-code-shell-question-ansi.txt', import.meta.url), 'utf8');
    const screen = readScreen('claude-code', raw);
    expect(screen.kind).toBe('exit question');
    const run = harness(screen, 'idle');
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--abandon', ...FILE], io, run.sourcesOf({ screenText: () => raw, status: () => 'idle' }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.keys).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
    expect(io.out).not.toContain('its exit was not typed');
    expect(io.out).not.toContain('its workspace was closed');
  });

  test('abandon closes a seat whose exit could not be typed, and the session still stops', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.typeText = () => false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--abandon', ...FILE], io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: its exit was not typed; its workspace was closed\n');
    expect(io.out).toContain('session acme-web: stopped and cleared\n');
    expect(io.out).not.toContain('herdr session delete');
  });

  test('a pinned Codex permission after the exit text gets no Enter', async () => {
    const pinnedRaw = readFileSync(new URL('../fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    const codexIdle = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    const run = harness({ kind: 'idle' });
    // The pane is idle before the typing; the dialog is what it shows after it. The dialog hides
    // the box, not the text typed a moment ago, so the run reports what the screen was reading —
    // not "its exit was not typed", which the typed text in the box contradicts.
    let raw = codexIdle;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      raw = pinnedRaw;
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      screen: () => readScreen('codex', raw),
      screenText: () => raw,
      agents: () => [{ ...agent('codex-acme', 'w3:p1', 'idle'), agent: 'codex' }],
    }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('codex-acme: its exit was not confirmed; the screen was reading permission before the Enter; left running (team down --abandon closes it)\n');
  });

  test('a rule-looking row after the exit text gets no Enter', async () => {
    // The pane draws `/exit` and then one more indented row of forty ─ inside the box, before
    // its closing rule. The pane draws content rows at the text's own column, and the closing
    // rule is the window's last rule row, an unbroken run of ─ from the pane's first column
    // (unsent-typed-ansi.txt): the extra row is content the exit text does not have, so the
    // box does not hold it. The exit is typed, and not sent.
    const run = harness({ kind: 'idle' });
    let shown = claudeBox('');
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      shown = claudeBox([text, '─'.repeat(40)].join('\n'));
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ screenText: () => shown }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.keys).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not confirmed; its box holds text that is not only the exit text (first row that differs: ────────────────────────────────────────); nothing more was sent; left running (team down --abandon closes it)\n');
  });

  test('a prompt-glyph continuation row after the exit text gets no Enter', async () => {
    // The round-6 reproduction on the exit path: the box holds the person's own text and then
    // a continuation row carrying only the prompt glyph, and the pane appends `/exit` after
    // the glyph. The input row is the box's first row under its opening rule, so the box does
    // not read back as the exit text — read by glyph it did, and the exit and the person's
    // text were submitted together. The exit is typed, and not sent.
    const run = harness({ kind: 'idle' });
    let shown = claudeBox('');
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      shown = claudeBox(`person text\n❯ ${text}`);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ screenText: () => shown }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.keys).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not confirmed; its box holds text that is not only the exit text (first row that differs: person text); nothing more was sent; left running (team down --abandon closes it)\n');
  });

  test('a second glyph row at the prompt column after the exit text gets no Enter', async () => {
    // The 0.2.1 boundary on the exit path, in Codex's shape: the pane holds the person's own
    // text and then a row carrying the prompt at the input row's own column, and the read-back
    // before 0.2.1 took that lowest row for the input — the exit text read back, the Enter went
    // in, and the person's text was submitted with it. No capture draws a person's continuation
    // at the prompt column (Codex's are indented two columns), so the shape fails closed: the
    // exit is typed, and not sent.
    const codexIdle = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    const run = harness({ kind: 'idle' });
    let shown = codexIdle;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      shown = codexIdle.replace('› Ask Codex to do anything', `› person text\n› ${text}`);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      screenText: () => shown,
      agents: () => [{ ...agent('codex-acme', 'w3:p1', 'idle'), agent: 'codex' }],
    }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('codex-acme: its exit was not typed; left as it is (team down --abandon closes it)\n');
  });

  // The leftover exit text: an earlier `down` typed `/exit`, read it back, and never pressed
  // Enter — a stop mid-sequence leaves the text in the box. This run never types onto it and
  // never sends it: with the profile's one clearing key it empties the box first and types the
  // exit fresh, on the same read-back proof as an empty box; without a key the seat is named
  // and left for its owner.
  test('a box already holding the exit text is cleared with the profile key, typed fresh, and stopped', async () => {
    const run = harness({ kind: 'unsent' });
    run.setBox(claudeBox('/exit'));
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.keys).toEqual(['ctrl+c']);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('a dry run notes the clearing key on the run step, and skips nothing for it', async () => {
    const run = harness({ kind: 'unsent' });
    run.setBox(claudeBox('/exit'));
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--dry-run', ...FILE], io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(io.out).toContain('+ herdr --session acme-web pane run w3:p1 /exit\n');
    expect(io.out).toContain('    (its box already holds this exit text; it is cleared first (ctrl+c))\n');
    expect(io.out).not.toContain('left running');
    expect(io.out).toContain('dry run: nothing was run\n');
  });

  test('a clearing key the pane does not take leaves the leftover text, and nothing is typed onto it', async () => {
    const run = harness({ kind: 'unsent' });
    run.setBox(claudeBox('/exit'));
    // The key is delivered and the pane keeps showing the text: the run gives up before any
    // typing, and the leftover stays for its owner.
    run.launch.sendKey = (_session, _pane, key) => {
      run.keys.push(key);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.keys).toEqual(['ctrl+c']);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its box already held this exit text; the clearing key (ctrl+c) left the screen reading unsent; left running (team down --abandon closes it)\n');
  });

  test('a half-drawn exit text that completes before the clearing key is cleared, and the seat left running', async () => {
    // The pane drew only the first rows of the text by the read-back, and finished the draw
    // while herdr answered the caller check that precedes the key: the key goes to a box that
    // holds exactly the text and empties it. The Enter is not sent after a clearing key — the
    // seat is left running, with the box empty again.
    const run = harness({ kind: 'idle' });
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      run.setBox(claudeBox('exi'));
      return true;
    };
    // The caller check before the clearing key is the fifth read of the foreground — the plan's
    // own opening classification, the opening check, after the typing, after the draw wait,
    // then this one.
    let looks = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      foreground: () => {
        looks += 1;
        if (looks === 5) run.setBox(claudeBox('/exit'));
        return ['claude'];
      },
    }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.keys).toEqual(['ctrl+c']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not confirmed; the text was cleared; left running (team down --abandon closes it)\n');
  });

  test('a text the pane never drew is left empty, and the seat left running', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.keys).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not confirmed; the pane never drew the typed text; its box is empty; left running (team down --abandon closes it)\n');
  });

  test('an undelivered clearing key leaves the text in the box for its owner', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      run.setBox(claudeBox('exi'));
      return true;
    };
    run.launch.sendKey = (_session, _pane, key) => {
      run.keys.push(key);
      return false;
    };
    // The pane finishes the draw at the caller check before the clearing key, as in the test
    // above: the fifth read of the foreground.
    let looks = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      foreground: () => {
        looks += 1;
        if (looks === 5) run.setBox(claudeBox('/exit'));
        return ['claude'];
      },
    }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.keys).toEqual(['ctrl+c']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not confirmed; the clearing key (ctrl+c) was not delivered; the text was left; left running (team down --abandon closes it)\n');
  });

  test('a leftover exit text on Antigravity is cleared with the profile key, typed fresh, and stopped', async () => {
    // The box already holds `/exit`. The profile's one key empties it, the exit is typed
    // fresh, and the seat is stopped as on an empty box.
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace(
      /  - role: implementer\n    name: deepseek-acme[\s\S]*?count: 2[^\n]*\n/,
      ['  - role: implementer', '    name: gemini-acme', '    cli: antigravity', '    vendor: google',
        '    model: Gemini Flash', '    version: "3.8"', '    launch: agy'].join('\n') + '\n',
    ));
    await approve();
    const exitTyped = readFileSync(new URL('../fixtures/antigravity/1.2.16/exit-typed.txt', import.meta.url), 'utf8');
    const idle = readFileSync(new URL('../fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
    const run = harness(readScreen('antigravity', exitTyped));
    run.setBox(exitTyped);
    run.launch.sendKey = (_session, _pane, key) => {
      run.keys.push(key);
      run.setBox(idle);
      return true;
    };
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      run.setBox(exitTyped);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      agents: () => [agent('gemini-acme', 'w3:p1', 'idle')],
    }));
    expect(code).toBe(0);
    expect(run.keys).toEqual(['ctrl+u']);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('gemini-acme: stopped\n');
  });

  // The refused shapes on the exit path, on both CLIs: the read-back before the Enter must
  // fail closed when the window starts inside the box with a visible continuation above the
  // prompt, and when a second prompt row is pressed against the one above it with no blank
  // row between them (the person's own row would otherwise be submitted with the exit). The
  // transcript's echo above the blank frame is not refused — it is `idle`, as main reads it.
  const CURSOR_DS = EXAMPLE.replace(
    `  - role: implementer
    name: deepseek-acme
    cli: claude-code           # DeepSeek's model, run by Claude Code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek`,
    `  - role: implementer
    name: deepseek-acme
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent`,
  );

  test.each([
    ['codex', 'codex-acme', '  person-owned visible continuation\n›'],
    ['codex', 'codex-acme', '› person text\n›'],
    ['cursor', 'deepseek-acme', '    person-owned visible continuation\n  →'],
    ['cursor', 'deepseek-acme', '  → person text\n  →'],
  ] as const)('an exit into a %s box that is not the one the captures draw gets no Enter (%j)', async (cli, seat, shape) => {
    // The seat's CLI is read from the team file by name — Codex's seat is codex-acme's, the
    // cursor case rewrites deepseek-acme's — so each case reads the shape through its own CLI.
    // The pane shows the shape the captures do not draw: the read is not idle, the seat is
    // left running, and nothing is typed or sent.
    const idle = readFileSync(new URL(`../fixtures/${cli}/${cli === 'codex' ? '0.157.0' : '2026.10.01'}/idle.txt`, import.meta.url), 'utf8');
    const placeholder = cli === 'codex' ? '› Ask Codex to do anything' : '  → Plan, search, build anything';
    if (cli === 'cursor') writeFileSync(join(root, '.agents/team.yaml'), CURSOR_DS);
    const pane = idle.replace(placeholder, shape);
    const run = harness({ kind: 'idle' });
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      screen: () => readScreen(cli, pane),
      screenText: () => pane,
      agents: () => [{ ...agent(seat, 'w3:p1', 'idle'), agent: cli }],
    }));
    // The seat is reported left running and the run ends the way any unrecognised screen
    // does — nothing was typed, so nothing failed.
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain(`${seat}: shows a screen the profile does not recognise; left running\n`);
  });

  test('a cursor seat with wrapped workspace path needs matching foregroundCwd to stop', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), CURSOR_DS);
    const wrappedPane = [
      '  Cursor Agent',
      '  v2026.10.01-14929f9',
      '  Tip: Use /plan to plan execution and reach the',
      '  right outcome faster.',
      '',
      '',
      '',
      '  → Plan, search, build anything',
      '',
      '',
      '  Grok 4.7 256K High                  Run Everything',
      '  ~/live/',
      '  dir',
    ].join('\n');

    // Case 1: foregroundCwd returns null -> skips fail-closed
    {
      const run = harness({ kind: 'idle' });
      const io = testIo(root, { kind: 'owner' });
      const code = await runDown(FILE, io, run.sourcesOf({
        foregroundCwd: () => null,
        screen: (_session, _pane, cli, cwd) => readScreen(cli, wrappedPane, { cwd: cwd ?? undefined, home: '/Users/example' }),
        screenText: () => wrappedPane,
        agents: () => [{ ...agent('deepseek-acme', 'w3:p1', 'idle'), agent: 'cursor' }],
      }));
      expect(code).toBe(0);
      expect(run.typed).toEqual([]);
      expect(io.out).toContain('deepseek-acme: shows a screen the profile does not recognise; left running\n');
    }

    // Case 2: foregroundCwd returns differing start directory -> skips fail-closed
    {
      const run = harness({ kind: 'idle' });
      const io = testIo(root, { kind: 'owner' });
      const code = await runDown(FILE, io, run.sourcesOf({
        foregroundCwd: () => '/Users/example/start/dir',
        screen: (_session, _pane, cli, cwd) => readScreen(cli, wrappedPane, { cwd: cwd ?? undefined, home: '/Users/example' }),
        screenText: () => wrappedPane,
        agents: () => [{ ...agent('deepseek-acme', 'w3:p1', 'idle'), agent: 'cursor' }],
      }));
      expect(code).toBe(0);
      expect(run.typed).toEqual([]);
      expect(io.out).toContain('deepseek-acme: shows a screen the profile does not recognise; left running\n');
    }
  });

  test.each(['close-short', 'close-long', 'open-short'] as const)(
    'an Antigravity box whose two rules differ in width gets no exit Enter (%s)',
    async (shape) => {
      // The round-7 reproduction on the exit path: the seat is Antigravity's, and the pane
      // shows a two-rule frame whose rules disagree in width — a frame that cannot be
      // established. Without the width check the window read unsent after the typing, the
      // read-back held, and the Enter was sent with it. The exit is typed, and not sent.
      writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace(
        /  - role: implementer\n    name: deepseek-acme[\s\S]*?count: 2[^\n]*\n/,
        ['  - role: implementer', '    name: gemini-acme', '    cli: antigravity', '    vendor: google',
          '    model: Gemini Flash', '    version: "3.8"', '    launch: agy'].join('\n') + '\n',
      ));
      await approve();
      const run = harness({ kind: 'idle' });
      const idle = readFileSync(new URL('../fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
      let shown = idle;
      run.launch.typeText = (_session, _pane, text) => {
        run.typed.push(text);
        shown = agyMismatchedFrame(shape, text);
        return true;
      };
      const io = testIo(root, { kind: 'owner' });
      const code = await runDown(FILE, io, run.sourcesOf({
        screenText: () => shown,
        agents: () => [agent('gemini-acme', 'w3:p1', 'idle')],
      }));
      expect(code).toBe(1);
      expect(run.typed).toEqual(['/exit']);
      expect(run.entered).toEqual([]);
      expect(run.closed).toEqual([]);
      expect(io.out).toContain('gemini-acme: its exit was not typed; left as it is (team down --abandon closes it)\n');
    });

  test('does not type into a permission prompt', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('is blocked at a prompt');
  });

  test.each(['idle', 'working'])('a captured Codex permission blocks down when herdr says %s', async (status) => {
    const captured = readFileSync(new URL('../fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const run = harness(readScreen('codex', captured), status);
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      agents: () => [{ ...agent('codex-acme', 'w3:p1', status), agent: 'codex' }],
    }));
    expect(code).toBe(0);
    expect(io.out).toContain('is blocked at a prompt');
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
  });

  test('a seat that does not leave is left as it is', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.agentPanes = () => ['w3:p1'];
    run.launch.pressEnter = () => true;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
    expect(io.out).toContain('deepseek-acme: timed out leaving its pane; left as it is (team down --abandon closes it)');
    expect(io.out).toContain('session acme-web: not stopped, something was left in it');
  });

  test('abandon closes a seat that does not leave', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.agentPanes = () => ['w3:p1'];
    run.launch.pressEnter = () => true;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--abandon', ...FILE], io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: timed out leaving its pane; its workspace was closed\n');
    expect(io.out).toContain('session acme-web: stopped and cleared\n');
  });

  test('the owner can abandon a blocked seat without typing', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--abandon', ...FILE], io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('--wait holds a working seat until it is free', async () => {
    const run = harness({ kind: 'idle' }, 'working');
    let waits = 0;
    run.onSleep(() => {
      waits++;
      run.setStatus('idle');
    });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--wait', ...FILE], io, run.sourcesOf());
    expect(waits).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
  });

  // The live file renamed the seat after the copy was approved. The stop list is the live file, so
  // the seat is stopped under the name and CLI the live file carries.
  function renamedSeat(cli?: string) {
    liveSeat = 'relay-acme';
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace('name: deepseek-acme', 'name: relay-acme'));
    const recorded = cli === undefined ? { stage: 'ready' } : { stage: 'ready', cli };
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: { 'acme-web': { seats: { 'relay-acme': recorded }, worktrees: {} } },
      }),
    );
  }

  test('stops a seat the file renamed, under the CLI the state records', async () => {
    renamedSeat('claude-code');
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('relay-acme: stopped\n');
  });

  test('a renamed seat with no live agent in its pane is not typed into', async () => {
    renamedSeat('claude-code');
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'] }));
    expect(code).toBe(1);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('relay-acme: no live agent in its pane; its exit was not typed (team down --abandon closes it)\n');
  });

  test('a renamed seat at a permission prompt is not typed into', async () => {
    renamedSeat('claude-code');
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('relay-acme: is blocked at a prompt');
  });

  test('a seat whose state predates the CLI record is stopped under the copy\'s CLI', async () => {
    renamedSeat();
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('relay-acme: stopped\n');
  });

  test('an agent neither the file nor the state records is left entirely alone', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ agents: () => [agent('stranger', 'w9:p1')] }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('stranger: its record is not an approved seat; left running (the owner cleans it: team remove stranger --abandon)\n');
    expect(io.out).toContain('session acme-web: not stopped, 1 agent left in it');
  });

  // The session mutator lock, `down`'s side: the same `.run` under `seat-locks/<session>/` that
  // `up`, `add` and `remove` take — one file per session, shared by every mutator — held from
  // this run's first effect to its last. A session that is not running, a dry run and every
  // refusal never take one; a lock a killed run left is taken over by the next one.
  const lockFile = (): string => seatLockPath(join(root, '.agents'), 'acme-web', '.run');
  const hold = (token: string): void => {
    mkdirSync(join(root, '.agents', 'seat-locks', 'acme-web'), { recursive: true });
    writeFileSync(lockFile(), token);
  };

  test("a held lock refuses the stop, with the holder's pid, before any effect", async () => {
    const run = harness({ kind: 'idle' });
    hold(`${process.pid} 0a1b2c3d\n`);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, io, run.sourcesOf())).toBe(1);
    expect(io.err).toBe(
      `team down: another session-mutating run is holding session acme-web (pid ${process.pid}); try again when it is done\n`,
    );
    expect(io.out).toBe('');
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
    // A live holder's lock is left exactly as it was: dropping it is never the refused run's.
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('the lock is held from the first effect to the last, and released at the end', async () => {
    const run = harness({ kind: 'idle' });
    const held: boolean[] = [];
    const stopSession = run.launch.stopSession;
    run.launch.stopSession = (session) => {
      held.push(existsSync(lockFile()));
      return stopSession(session);
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, io, run.sourcesOf())).toBe(0);
    expect(held).toEqual([true]);
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a lock left by a dead run is taken over and released by this one', async () => {
    const run = harness({ kind: 'idle' });
    const dead = spawnSync('sh', ['-c', 'exit 0']).pid;
    expect(typeof dead).toBe('number');
    hold(`${dead} 0a1b2c3d\n`);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, io, run.sourcesOf())).toBe(0);
    expect(run.stopped).toEqual(['acme-web']);
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a session that is not running takes no lock while another run holds one', async () => {
    const run = harness({ kind: 'idle' });
    hold(`${process.pid} 0a1b2c3d\n`);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, io, run.sourcesOf({ sessionRunning: () => false }))).toBe(0);
    expect(io.out).toBe('session acme-web is not running: nothing to stop\n');
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('a dry run takes no lock while another run holds one', async () => {
    const run = harness({ kind: 'idle' });
    hold(`${process.pid} 0a1b2c3d\n`);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDown([...FILE, '--dry-run'], io, run.sourcesOf())).toBe(0);
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(run.typed).toEqual([]);
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('a lock that cannot be read refuses with the file to clear', async () => {
    const run = harness({ kind: 'idle' });
    hold('not a token\n');
    const io = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, io, run.sourcesOf())).toBe(1);
    // An unreadable lock is held, never stale (`seat-lock.ts`), so the owner is the only way
    // out and the message names the file.
    expect(io.err).toBe(
      'team down: another session-mutating run may be holding session acme-web, and its lock cannot be read; '
        + `if no run is using it, delete ${lockFile()}\n`,
    );
    expect(run.typed).toEqual([]);
  });
});

const SCRATCH = 'team-test-up';
const TRUSTED = join(homedir(), 'team-test-up-trusted');
const TRUSTED_SHOWN = '~/team-test-up-trusted';

// Read only. A test never writes ~/.claude.json; the owner trusts the fixed folder by hand.
function folderTrusted(): boolean {
  let text: string;
  try {
    text = readFileSync(join(homedir(), '.claude.json'), 'utf8');
  } catch {
    return false;
  }
  let projects: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;
  try {
    projects = (JSON.parse(text) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return false;
  }
  const keys = new Set<string>([TRUSTED]);
  try {
    keys.add(realpathSync(TRUSTED));
  } catch {
    // The folder is not there yet. The stored key is the path the owner opens.
  }
  for (const key of keys) {
    if (projects[key]?.hasTrustDialogAccepted === true) return true;
  }
  return false;
}

async function requireMachine(): Promise<void> {
  const uptime = execFileSync('uptime', { encoding: 'utf8' });
  const load = Number(/load averages?: ([\d.]+)/.exec(uptime)?.[1] ?? '99');
  if (!(load < 60)) throw new Error(`load is ${load}; not starting a session`);
  const pressure = execFileSync('memory_pressure', { encoding: 'utf8' });
  const memory = parseMemoryPressure(pressure);
  if (memory === null || memory < 25) throw new Error(`free memory is ${memory}%; not starting a session`);
  const readSwap = () => parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }));
  const first = readSwap();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  const second = readSwap();
  if (!first || !second) throw new Error('swap could not be read; not starting a session');
  if (second.used > first.used) {
    throw new Error(`swap used grew from ${first.used} to ${second.used}; not starting a session`);
  }
  console.log(`gate load ${load} memory ${memory}% swap used ${first.used} then ${second.used}`);
}

function cheapFile(): string {
  const deepseek = [
    '  - role: implementer',
    '    name: deepseek-acme',
    "    cli: claude-code           # DeepSeek's model, run by Claude Code",
    '    vendor: deepseek',
    '    model: DeepSeek Flash',
    '    version: "V4.1"',
    '    display: DeepSeek V4.1 Flash',
    '    launch: team-deepseek',
    '    count: 2                   # deepseek-acme, deepseek-acme-2',
    '',
  ].join('\n');
  const cheap = EXAMPLE.replace('session: acme-web', `session: ${SCRATCH}`)
    .replace('model: Claude Opus', 'model: Claude Haiku')
    .replace('version: "5.5"', 'version: "4.5"')
    .replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-haiku-4-5-20251001')
    .replace('  load_start: 3.0', '  load_start: 60')
    .replace(
      "  disk_min: 10GB               # free on the project's volume; both refuse and report",
      "  disk_min: 10GB               # free on the project's volume; both refuse and report\n  swap_free_min: 1MB",
    )
    .replace(deepseek, '');
  if (cheap.includes('deepseek-acme') || !cheap.includes('claude-haiku-4-5-20251001')) {
    throw new Error('the scratch file is not the one cheap claude-code seat');
  }
  return cheap;
}

function stopScratch() {
  const left = sessionState(SCRATCH);
  if (left !== 'running' && left !== 'stopped') return;
  try {
    execFileSync('herdr', ['session', 'stop', SCRATCH], { stdio: 'ignore' });
  } catch {
    // already stopped
  }
  try {
    execFileSync('herdr', ['session', 'delete', SCRATCH], { stdio: 'ignore' });
  } catch {
    // the test reports the failure above; the session is named so it can be cleared by hand
  }
}

describe('scratch session', () => {
  // Opt-in: CI has no herdr. Never team-test, which is another seat's session.
  // A fresh folder shows Claude's trust question. up leaves the seat out and types nothing.
  test.skipIf(process.env.TEAM_LIVE_UP !== '1')(
    'a fresh folder leaves the seat out: trust question',
    async () => {
      await requireMachine();
      const before = sessionState(SCRATCH);
      if (before !== 'absent') throw new Error(`session ${SCRATCH} is ${before}; not touching it`);

      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'team-scratch-')));
      const project = join(scratch, 'acme-web');
      const scratchHome = join(scratch, 'home');
      mkdirSync(join(project, '.agents'), { recursive: true });
      mkdirSync(scratchHome);
      writeFileSync(join(project, '.agents/team.yaml'), cheapFile());
      const file = ['--file', join(project, '.agents/team.yaml')];
      const owner = testIo(project, { kind: 'owner' });
      try {
        expect(await runApprove(file, owner, { ask: async () => '3', waiting: () => 'empty', now: () => new Date(), home: scratchHome })).toBe(0);
        const doctor = upReal.doctor ? { ...upReal.doctor, home: scratchHome } : undefined;
        const upCode = await runUp(file, owner, { ...upReal, home: scratchHome, doctor });
        expect(upCode).toBe(1);
        if (!owner.out.includes(': left out: trust') || !owner.err.includes('its workspace was closed without an answer and the seat left out')) {
          throw new Error((owner.out + owner.err).split('\n').slice(-20).join('\n'));
        }
        await runDown(file, owner, downReal);
      } finally {
        stopScratch();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    240_000,
  );

  // The idle path runs only in a folder the owner has already trusted. This test never writes that trust.
  const live = process.env.TEAM_LIVE_UP === '1';
  if (live && !folderTrusted()) {
    test.skip(
      `trust ${TRUSTED_SHOWN} once by hand: accept the workspace trust dialog in Claude; this test only reads ~/.claude.json`,
      () => {},
    );
  } else {
    test.skipIf(!live)(
      'launches one cheap seat in the trusted folder and stops it',
      async () => {
        await requireMachine();
        const before = sessionState(SCRATCH);
        if (before !== 'absent') throw new Error(`session ${SCRATCH} is ${before}; not touching it`);
        const scratchHome = mkdtempSync(join(tmpdir(), 'team-trusted-home-'));
        const agentsDir = join(TRUSTED, '.agents');
        const createdAgents = !existsSync(agentsDir);
        const owner = testIo(TRUSTED, { kind: 'owner' });
        try {
          mkdirSync(agentsDir, { recursive: true });
          writeFileSync(join(agentsDir, 'team.yaml'), cheapFile());
          const file = ['--file', join(agentsDir, 'team.yaml')];
          expect(await runApprove(file, owner, { ask: async () => '3', waiting: () => 'empty', now: () => new Date(), home: scratchHome })).toBe(0);
          const doctor = upReal.doctor ? { ...upReal.doctor, home: scratchHome } : undefined;
          const upCode = await runUp(file, owner, { ...upReal, home: scratchHome, doctor });
          expect(upCode).toBe(0);
          const downCode = await runDown(file, owner, downReal);
          if (downCode !== 0) throw new Error(`down left this:\n${owner.out}\n${owner.err}`);
        } finally {
          stopScratch();
          rmSync(scratchHome, { recursive: true, force: true });
          if (createdAgents) rmSync(agentsDir, { recursive: true, force: true });
        }
      },
      240_000,
    );
  }
});

// A ready seat whose screen names a different model from the file. On the base, `up` skips it
// as already ready. The file's model for codex-acme is GPT Sol 6; the 0.161.0 idle capture
// names GPT Terra 5.6.
describe('team up, a ready seat whose model drifted', () => {
  const terra = () => readFileSync(join(import.meta.dir, '../fixtures/codex/0.161.0/idle.txt'), 'utf8');

  function driftYaml(): string {
    return EXAMPLE
      .replace(
        '    count: 2                   # deepseek-acme, deepseek-acme-2\n',
        '    stopped: true\n    count: 2\n',
      )
      .replace(
        '    launch: codex -m gpt-6-sol -c model_reasoning_effort=high\n    stopped: true\n',
        '    launch: codex -m gpt-6-sol -c model_reasoning_effort=high\n',
      );
  }

  function readyState(): void {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, driftYaml()));
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
              'codex-acme': { stage: 'ready', pane: 'w92:p1', workspace: 'w92', launched: { shell: 410, cli: [411] } },
            },
            worktrees: {},
          },
        },
      }),
    );
  }

  const codex = (status = 'idle') => agent('codex-acme', 'w92:p1', status, 'codex');
  const lead = () => agent('claude-coordinator-acme', 'w91:p1', 'idle');

  test('a different model is not left ready', async () => {
    readyState();
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      return { shell: 700, foreground: [700, 701] };
    };
    made.launch.paneText = (_session, pane) => (pane === 'w92:p1' ? terra() : IDLE);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      ['--dry-run', ...FILE],
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('workspace close w92');
    expect(io.out).toContain('closed without input: its model drifted from the file');
    expect(io.out).not.toContain('codex-acme: already ready; left as it is');
    expect(io.out).toContain('skip claude-coordinator-acme: already ready; left as it is');
  });

  function dry(text: string, status = 'idle'): Promise<{ code: number; out: string }> {
    readyState();
    return approve().then(async () => {
      const made = world();
      made.session = 'running';
      made.launch.processInfo = (_session, pane) => {
        if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
        if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
        return { shell: 700, foreground: [700, 701] };
      };
      made.launch.paneText = (_session, pane) => (pane === 'w92:p1' ? text : IDLE);
      const io = testIo(root, { kind: 'owner' });
      const code = await runUp(
        ['--dry-run', ...FILE],
        io,
        sources({ sessionState: () => 'running', agents: () => [lead(), codex(status)], doctor: doctor() }, made),
      );
      return { code, out: io.out };
    });
  }

  test('a matching model is left ready', async () => {
    const ran = await dry(fileModel(terra()));
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('skip codex-acme: already ready; left as it is');
    expect(ran.out).toContain('workspace rename w92');
    expect(ran.out).toContain("display-agent 'GPT-6 Sol default'");
    expect(ran.out).not.toContain('workspace close w92');
  });

  test('an unreadable screen is left ready', async () => {
    const ran = await dry('');
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('skip codex-acme: already ready; left as it is');
    expect(ran.out).not.toContain('workspace close w92');
  });

  test('a working seat is left ready and names the owner\'s way', async () => {
    const screen = terra().replace('To get started', 'esc to interrupt\n\n  To get started');
    const ran = await dry(screen);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('skip codex-acme: its model drifted; left as it is (team remove codex-acme --abandon)');
    expect(ran.out).not.toContain('workspace close w92');
  });

  test('herdr reporting working leaves the seat ready', async () => {
    const ran = await dry(terra(), 'working');
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('skip codex-acme: its model drifted; left as it is (team remove codex-acme --abandon)');
    expect(ran.out).not.toContain('workspace close w92');
  });

  test('a lead whose model drifted is refused, never cycled in place', async () => {
    const sonnet = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Sonnet 4.5\n`;
    readyState();
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      return { shell: 700, foreground: [700, 701] };
    };
    made.launch.paneText = (_session, pane) => (pane === 'w91:p1' ? sonnet : fileModel(terra()));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      ['--dry-run', ...FILE],
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    // A proven difference on a lead is refused with the whole-team repair, not skipped: the
    // plan stays ready, nothing is closed, and a real run exits 1 on this same line.
    expect(io.out).toContain(
      'skip claude-coordinator-acme: its model drifted; lead seat is not cycled in place (team down, then team up (to restart the whole team))',
    );
    expect(io.out).not.toContain('claude-coordinator-acme: already ready');
    expect(io.out).not.toContain('workspace close w91');
    expect(io.out).not.toContain('workspace close w92');
  });

  test('a delegate is told to run up again once the seat is idle or done', async () => {
    writeFileSync(
      join(root, '.agents/team.yaml'),
      `${makeExample(base, root, driftYaml())}\ndelegates:\n  - pane: main/w1:p1\n    commands: [up]\n`,
    );
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'codex-acme': { stage: 'ready', pane: 'w92:p1', workspace: 'w92', launched: { shell: 410, cli: [411] } },
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) =>
      pane === 'w92:p1' ? { shell: 410, foreground: [410, 411] } : { shell: 420, foreground: [420, 421] };
    made.launch.paneText = (_session, pane) => (pane === 'w92:p1' ? terra() : IDLE);
    const io = testIo(root, { kind: 'seat', name: 'work', pane: 'w1:p1', session: 'main' });
    const code = await runUp(
      ['--dry-run', ...FILE],
      io,
      sources({
        sessionState: () => 'running',
        agents: () => [lead(), codex('working')],
        doctor: doctor(),
        delegateGate: () => ({ kind: 'passed', pane: 'main/w1:p1' }),
      }, made),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('skip codex-acme: its model drifted; left as it is (run this again once herdr reports the seat idle or done)');
    expect(io.out).not.toContain('workspace close w92');
  });

  test('a seat whose own model drifted is refused, never closed under itself', async () => {
    readyState();
    writeFileSync(
      join(root, '.agents/team.yaml'),
      `${makeExample(base, root, driftYaml())}\ndelegates:\n  - pane: main/w1:p1\n    commands: [up]\n`,
    );
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) =>
      pane === 'w92:p1' ? { shell: 410, foreground: [410, 411] } : { shell: 420, foreground: [420, 421] };
    made.launch.paneText = (_session, pane) => (pane === 'w92:p1' ? terra() : IDLE);
    const io = testIo(root, { kind: 'seat', name: 'codex-acme', pane: 'w92:p1', session: 'acme-web' });
    const code = await runUp(
      ['--dry-run', ...FILE],
      io,
      sources({
        sessionState: () => 'running',
        agents: () => [lead(), codex()],
        doctor: doctor(),
        delegateGate: () => ({ kind: 'passed', pane: 'main/w1:p1' }),
      }, made),
    );
    expect(code).toBe(0);
    expect(io.out).toContain(
      'skip codex-acme: its model drifted; this run is inside its pane and cannot close itself (run team up from outside this pane)',
    );
    expect(io.out).not.toContain('workspace close w92');
  });

  test('an idle seat holding unsent text is closed without input and launched again', async () => {
    readyState();
    await approve();
    // The open record of the session the repair is about to close: the drift repair replaces a
    // session this run closed on purpose, so the record ends as a swap, never as a crash.
    const parsed = validateTeamFile(makeExample(base, root, driftYaml()), { home, root });
    if (!parsed.ok) throw new Error('the drift scene team does not validate');
    const codexSeat = parsed.team.seats.find((one) => one.name === 'codex-acme');
    if (codexSeat === undefined) throw new Error('the drift scene has no codex seat');
    const seeded = beginSession({
      home, root, team: parsed.team, session: 'acme-web', seat: codexSeat, pane: 'w92:p1', now: NOW,
    });
    if (!('id' in seeded)) throw new Error(seeded.note);
    const unsent = terra().replace('› Ask Codex to do anything', '› hello');
    const captured = readFileSync(join(import.meta.dir, '../fixtures/codex/0.157.0/idle.txt'), 'utf8');
    const matched = fileModel(captured);
    const made = world(() => matched);
    made.session = 'running';
    made.launch.processInfo = (_session, pane) =>
      pane === 'w92:p1' || pane === 'w91:p1'
        ? (pane === 'w91:p1' ? { shell: 420, foreground: [420, 421] } : { shell: 410, foreground: [410, 411] })
        : { shell: 700, foreground: [700, 701] };
    let codexPane = '';
    let pasted = false;
    let typed = '';
    const boxed = () => {
      const [first = '', ...rest] = wrappedRows(typed);
      return matched.replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    let status = 'idle';
    made.launch.agentStatus = () => status;
    made.launch.agents = () => {
      if (made.closes.includes('w92')) {
        return (made.launch.agentPanes('acme-web') ?? []).map((pane) => ({
          name: null, agent: 'codex', pane, workspace: pane.split(':')[0] ?? pane, status: 'idle', cwd: null,
        }));
      }
      return [lead(), codex()];
    };
    const read = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      if (pane === 'w92:p1') return unsent;
      if (pane === 'w91:p1') return IDLE;
      if (pane === codexPane) return pasted ? boxed() : matched;
      return read(session, pane);
    };
    made.launch.typeText = (_session, pane, text) => { codexPane = pane; typed = text; pasted = true; return true; };
    made.launch.pressEnter = () => { status = 'working'; pasted = false; return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual(['w92']);
    expect(io.out).toContain('codex-acme: ready\n');
    expect(io.err).toContain('  its model drifted; closed without input and launched again\n');
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.err).toContain('  already ready; left as it is\n');
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'];
    expect(seat).toMatchObject({ stage: 'ready', pane: 'w1:p1' });
    expect(seat?.pane).not.toBe('w92:p1');
    // The repaired launch replaced a session this run closed on purpose: the old record ends as
    // a swap, with no crash note, and the new record links back to it as its previous.
    const registry = readStoreSessions(sessionsPath(parsed.team, root, home), home);
    expect(registry.ok).toBe(true);
    const records = registry.ok ? registry.sessions.filter((one) => one.seat === 'codex-acme') : [];
    const old = records.find((one) => one.id === seeded.id);
    expect(old?.reason).toBe('swap');
    expect(typeof old?.ended).toBe('string');
    expect(old?.note).toBeUndefined();
    const next = records.find((one) => one.id !== seeded.id);
    expect(next?.previous).toBe(seeded.id);
    expect(next?.ended).toBeUndefined();
  });

  test('a model that matches again before the close is left as it is', async () => {
    readyState();
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      return { shell: 700, foreground: [700, 701] };
    };
    let seen = 0;
    made.launch.paneText = (_session, pane) => {
      if (pane !== 'w92:p1') return IDLE;
      seen += 1;
      return seen === 1 ? terra() : fileModel(terra());
    };
    made.launch.agents = () => [lead(), codex()];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('codex-acme: left out: its model matches the file again; left as it is\n');
  });

  test('a seat that is working at the close is not closed', async () => {
    readyState();
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      return { shell: 700, foreground: [700, 701] };
    };
    made.launch.paneText = (_session, pane) => (pane === 'w92:p1' ? terra() : IDLE);
    made.launch.agents = () => [lead(), codex('working')];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    // Working at the close: nothing is closed, and the run does not fail on it — the seat is
    // skipped working, not refused.
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('codex-acme: left out: its model drifted; left as it is (team remove codex-acme --abandon)\n');
  });

  test('an unreadable screen at the close closes nothing', async () => {
    readyState();
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      return { shell: 700, foreground: [700, 701] };
    };
    let seen = 0;
    made.launch.paneText = (_session, pane) => {
      if (pane !== 'w92:p1') return IDLE;
      seen += 1;
      return seen === 1 ? terra() : null;
    };
    made.launch.agents = () => [lead(), codex()];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('codex-acme: left out: its pane could not be read; nothing closed\n');
  });

  // Text against the input row: the model line still names Terra, and the classifier reads unknown.
  const unknownFrame = () => terra().replace('\n\n› Ask Codex to do anything', '\ntranscript touching the input\n› Ask Codex to do anything');

  test('a screen this version does not classify is left ready', async () => {
    const ran = await dry(unknownFrame());
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('skip codex-acme: already ready; left as it is');
    expect(ran.out).not.toContain('workspace close');
  });

  test('a screen that becomes unclassified before the close is not closed', async () => {
    readyState();
    await approve();
    const made = world();
    made.session = 'running';
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420, 421] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      return { shell: 700, foreground: [700, 701] };
    };
    let seen = 0;
    made.launch.paneText = (_session, pane) => {
      if (pane !== 'w92:p1') return IDLE;
      seen += 1;
      return seen === 1 ? terra() : unknownFrame();
    };
    made.launch.agents = () => [lead(), codex()];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', agents: () => [lead(), codex()], doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(made.renames).toEqual([]);
    expect(made.runs.some((step) => step.command.includes('codex'))).toBe(false);
    expect(io.out).toContain('codex-acme: left out: its screen is not idle or done; nothing closed\n');
  });
});
