import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { delegateGate } from '../../src/delegate.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../../src/store/store.ts';
import { rulesFileHash, rulesFilePathOf, writeRulesFile } from '../../src/launch/rules-file.ts';
import { seatLockPath } from '../../src/launch/seat-lock.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { testIo, claudeBox } from '../helpers.ts';

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  # stays above lead
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const owner = { kind: 'owner' as const };
const lead = { kind: 'seat' as const, name: 'lead', pane: 'w0:p1', session: 'acme' };

let dir: string;
let file: string;
let home: string;
let clock: number;

function world(screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources;
  typed: string[];
  keys: string[];
  closed: string[];
  agents: HerdrAgent[];
  running: boolean[];
} {
  const typed: string[] = [];
  const keys: string[] = [];
  const closed: string[] = [];
  let sent = false;
  // What the pane shows: the empty idle box before any typing, the box with the typed text
  // after one, as the CLI renders it.
  let box: string | undefined = claudeBox('');
  const agents: HerdrAgent[] = [];
  const running: boolean[] = [];
  clock = 0;
  const launch: DownLaunch = {
    typeText: (_session, _pane, text) => { typed.push(text); box = claudeBox(text); return true; },
    sendKey: (_session, _pane, key) => { keys.push(key); box = claudeBox(''); return true; },
    pressEnter: () => { sent = true; return true; },
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const sources: RemoveSources = {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    screenText: () => box,
    status: () => status,
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    launch,
    foreground: () => (running[0] === true ? ['claude'] : sent || running[0] === false ? [] : ['claude']),
  };
  return { sources, typed, keys, closed, agents, running };
}

// The state `team up` writes for the coordinator's seat: the caller check judges a seat on the
// pane the state records for it, so a coordinator caller needs this record to stand as one.
// Without it the check fails closed — that refusal has its own tests in coordinator-session.
function approveCurrent(): void {
  const loaded = loadTeamFile(dir);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: readFileSync(file, 'utf8') },
    loaded.team.seats,
    home,
  );
}

function recordLead(pane = lead.pane): void {
  updateState(join(dir, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane };
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-remove-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, FILE);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  // The approval in force every test runs under: `remove` refuses to stop a seat or edit the
  // file without one. The tests that write their own record point `sources.home` at theirs.
  home = join(dir, 'home');
  const loaded = loadTeamFile(dir);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: FILE },
    loaded.team.seats,
    home,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('team remove', () => {
  test('a free seat is exited, then taken out, and the comment above the next seat stays', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual(['w1']);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('name: worker');
    expect(text).toContain('# stays above lead');
    expect(text).toContain('name: lead');
  });

  test('a pane with no live agent is not typed into', async () => {
    const made = world();
    made.running.push(false);
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('no live agent in its pane; its exit was not typed (team remove worker --abandon closes it)');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('an owner sees a seat whose CLI exited closed and removed, not refused', async () => {
    // The bare-shell case for `remove`: the pane's own shell is back in front and no `claude`
    // process is in its readable foreground list, so the owner's ordinary run — no `--abandon` —
    // closes the workspace, says why on the seat's line, and takes the seat out of the file.
    const made = world({ kind: 'unknown' }, 'idle');
    made.running.push(false);
    made.sources.shellBack = () => true;
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(io.out).toContain('worker: its CLI had exited; its workspace was closed\n');
    expect(io.out).toContain('removed worker\n');
    expect(io.err).toBe('');
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('an allowed seat finds an exited pane closed as a free one is, not left', async () => {
    // An exited seat needs nothing typed and no key; closing it is the same authority the same
    // caller already has on a free seat, so the leave path is not taken for it.
    const made = world({ kind: 'unknown' }, 'idle');
    made.running.push(false);
    made.sources.shellBack = () => true;
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(io.out).toContain('worker: its CLI had exited; its workspace was closed\n');
    expect(io.out).toContain('removed worker\n');
  });

  test('a live CLI or an unreadable list keeps the owner refusal, byte for byte', async () => {
    // A CLI still listed is never closed, whatever the shell pid reading says — both facts are
    // required — and an unreadable foreground list is not an exited seat either.
    for (const foreground of [() => ['claude'], () => null] as const) {
      writeFileSync(file, FILE);
      const made = world({ kind: 'unknown' }, 'idle');
      made.sources.foreground = foreground;
      made.sources.shellBack = () => true;
      made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
      const io = testIo(dir, owner);
      expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
      expect(io.err).toBe('team remove: worker shows a screen the profile does not recognise; left as it is (team remove worker --abandon closes its workspace without typing)\n');
      expect(made.typed).toEqual([]);
      expect(made.closed).toEqual([]);
      expect(readFileSync(file, 'utf8')).toContain('name: worker');
    }
  });

  test('a seat already at the framed exit question is not asked, and only ordinary abandon closes it', async () => {
    const raw = readFileSync(new URL('../fixtures/exit-typing/claude-code-shell-question-ansi.txt', import.meta.url), 'utf8');
    const screen = readScreen('claude-code', raw);
    expect(screen.kind).toBe('exit question');
    const made = world(screen, 'idle');
    made.sources.screenText = () => raw;
    const entered: string[] = [];
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    const press = launch.pressEnter.bind(launch);
    launch.pressEnter = (session, pane) => {
      entered.push('enter');
      return press(session, pane);
    };
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(entered).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.err).toBe('team remove: worker sits at its own exit question; left as it is (team remove worker --abandon closes it)\n');
    expect(io.out).not.toContain('its exit was not typed');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');

    const again = testIo(dir, owner);
    expect(await runRemove(['worker', '--abandon', '--file', file], again, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(entered).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(again.out).toContain('worker: stopped\n');
    expect(again.out).not.toContain('its exit was not typed');
    expect(again.out).not.toContain('its workspace was closed');
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('abandon closes a free seat whose exit could not be typed, and the seat is taken out', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = () => false;
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--abandon', '--file', file], io, made.sources)).toBe(0);
    expect(made.closed).toEqual(['w1']);
    expect(io.out).toContain('worker: its exit was not typed; its workspace was closed\n');
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('a pinned Codex permission after the exit text gets no Enter', async () => {
    const pinnedRaw = readFileSync(new URL('../fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    const pinned = readScreen('codex', pinnedRaw);
    // The seat is Codex's, so its pane reads through Codex's own screen data.
    writeFileSync(file, FILE.replace(
      `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
      `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high`,
    ));
    approveCurrent();
    const made = world();
    let screen: Screen = { kind: 'idle' };
    made.sources.screen = () => screen;
    made.sources.foreground = () => ['codex'];
    // The pane is idle before the typing; the dialog is what it shows after it.
    let raw = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    made.sources.screenText = () => raw;
    const entered: string[] = [];
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      screen = pinned;
      raw = pinnedRaw;
      return true;
    };
    launch.pressEnter = () => {
      entered.push('enter');
      return true;
    };
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(entered).toEqual([]);
    expect(made.closed).toEqual([]);
    // The dialog hides the box, not the text typed a moment ago: the run reports what the screen
    // was reading — not "its exit was not typed", which the typed text in the box contradicts.
    expect(io.out).toContain('worker: its exit was not confirmed; the screen was reading permission before the Enter; left running (team remove worker --abandon closes it)');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a box that holds someone else\'s text gets no Enter', async () => {
    const made = world();
    let raw = claudeBox('');
    made.sources.screenText = () => raw;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      raw = claudeBox('half a sentence, not this exit');
      return true;
    };
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(io.out).toContain('worker: its exit was not confirmed; its box holds text that is not only the exit text (first row that differs: half a sentence, not this exit); nothing more was sent; left running (team remove worker --abandon closes it)');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a leftover exit text is cleared inside the stop, and the removal proceeds', async () => {
    // An earlier stop typed `/exit` and never confirmed it: the box is emptied with the
    // profile's one key, the exit is typed fresh, and the seat is removed as on an empty box.
    const made = world({ kind: 'unsent' });
    let raw = claudeBox('/exit');
    made.sources.screenText = () => raw;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      raw = claudeBox(text);
      return true;
    };
    launch.sendKey = (_session, _pane, key) => {
      made.keys.push(key);
      raw = claudeBox('');
      return true;
    };
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(made.keys).toEqual(['ctrl+c']);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual(['w1']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('a CLI with no clearing key keeps its leftover exit text, named for the owner', async () => {
    // Antigravity has no key that empties the box, so the seat is not asked again: the refusal
    // names the exit text the box holds instead of the generic unsent line, and nothing is
    // typed, keyed or closed.
    writeFileSync(file, FILE.replace(
      `    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  # stays above lead`,
      `    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
  # stays above lead`,
    ));
    approveCurrent();
    const raw = readFileSync(new URL('../fixtures/antigravity/1.2.16/exit-typed.txt', import.meta.url), 'utf8');
    const made = world(readScreen('antigravity', raw));
    made.sources.screenText = () => raw;
    made.agents.push({ name: 'worker', agent: 'agy', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.err).toBe('team remove: worker holds this CLI\'s exit text (/exit) unsent in its input box; left as it is (the owner sends it or clears it in its pane)\n');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a prompt-glyph continuation row after the exit text gets no Enter', async () => {
    // The round-6 reproduction on the remove path: the box holds the person's own text and
    // then a continuation row carrying only the prompt glyph, and the pane appends `/exit`
    // after the glyph. The input row is the box's first row under its opening rule, so the box
    // does not read back as the exit text — read by glyph it did, and the exit and the
    // person's text were submitted together. The exit is typed, and not sent.
    const made = world();
    let box = claudeBox('');
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      box = claudeBox(`person text\n❯ ${text}`);
      return true;
    };
    made.sources.screenText = () => box;
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('worker: its exit was not confirmed; its box holds text that is not only the exit text (first row that differs: person text); nothing more was sent; left running (team remove worker --abandon closes it)');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a second glyph row at the prompt column after the exit text gets no Enter', async () => {
    // The 0.2.1 boundary on the remove path, in Codex's shape (the worker seat below is
    // Codex's): the pane holds the person's own text and then a row carrying the prompt at the
    // input row's own column, and the read-back before 0.2.1 took that lowest row for the
    // input — the exit text read back, the Enter went in, and the person's text was submitted
    // with it. No capture draws a person's continuation at the prompt column (Codex's are
    // indented two columns), so the shape fails closed: the exit is typed, and not sent.
    const codexIdle = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    writeFileSync(file, FILE.replace(
      `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
      `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high`,
    ));
    approveCurrent();
    const made = world();
    let shown = codexIdle;
    let gone = false;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      shown = codexIdle.replace('› Ask Codex to do anything', `› person text\n› ${text}`);
      return true;
    };
    launch.pressEnter = () => {
      gone = true;
      return true;
    };
    made.sources.screenText = () => shown;
    made.sources.foreground = () => (gone ? [] : ['codex']);
    made.agents.push({ name: 'worker', agent: 'codex', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('worker: its exit was not typed; left as it is (team remove worker --abandon closes it)');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test.each([
    ['codex', '  person-owned visible continuation\n›'],
    ['codex', '› person text\n›'],
    ['cursor', '    person-owned visible continuation\n  →'],
    ['cursor', '  → person text\n  →'],
  ] as const)('a %s box that is not the one the captures draw after the exit text gets no Enter (%j)', async (cli, shape) => {
    // The refused shapes on the remove path, on both CLIs: a window starting inside the box
    // with a visible continuation above the prompt, and a second prompt row pressed against
    // the one above it with no blank row between them. The pane read is not free, so the seat
    // is left running and nothing is typed: the exit never reaches the pane. The transcript's
    // echo above the blank frame is not refused — it is `idle`, as main reads it.
    const idle = readFileSync(new URL(`../fixtures/${cli}/${cli === 'codex' ? '0.157.0' : '2026.10.01'}/idle.txt`, import.meta.url), 'utf8');
    const placeholder = cli === 'codex' ? '› Ask Codex to do anything' : '  → Plan, search, build anything';
    writeFileSync(file, FILE.replace(
      `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
      cli === 'codex'
        ? `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high`
        : `  - role: implementer
    name: worker
    label: worker
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent`,
    ));
    approveCurrent();
    const pane = idle.replace(placeholder, shape);
    const made = world();
    let gone = false;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      return true;
    };
    launch.pressEnter = () => {
      gone = true;
      return true;
    };
    made.sources.screen = () => readScreen(cli, pane);
    made.sources.screenText = () => pane;
    made.sources.foreground = () => (gone ? [] : [cli === 'codex' ? 'codex' : 'cursor-agent']);
    made.agents.push({ name: 'worker', agent: cli, pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.err).toContain('team remove: worker shows a screen the profile does not recognise');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a seat that is not running is taken out without typing', async () => {
    recordLead();
    const made = world();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('--keep of the lead is refused, and --lead moves the role in one write', async () => {
    const made = world();
    const refused = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep'], refused, made.sources)).toBe(2);
    expect(refused.err).toContain('can\'t be a stopped seat');
    expect(readFileSync(file, 'utf8')).toBe(FILE);
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--lead', 'worker'], io, made.sources)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('format: 1\nproject: acme\ncoordinator: worker\noperator: worker\n')).toBe(true);
    expect(text).toContain('operator: worker\n');
    expect(text).toContain('# stays above lead');
    expect(text).toContain(`  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
    expect(text).toMatch(/name: lead\n(?:    .*\n)*    stopped: true\n/);
    const workerBlock = text.slice(text.indexOf('name: worker'), text.indexOf('# stays above lead'));
    expect(workerBlock).not.toContain('stopped:');
    expect(io.out).toBe('stopped lead\nteam add worker\n');
    const loaded = loadTeamFile(dir, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    expect(loaded.team.orchestrator).toBe('worker');
    expect(loaded.team.operator).toBe('worker');
    const record = readApproval(storePath(loaded.team.project, loaded.root, home));
    expect(record?.file).toBe(text);
    expect(approvalDifferences(loaded.team, loaded.root, home)).toEqual([]);
    expect(record?.generation).toBe(2);
  });

  test('--lead from a seat that is not the owner writes nothing', async () => {
    recordLead();
    const made = world();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker', '--keep', '--lead', 'lead'], io, made.sources)).toBe(1);
    expect(io.err).toContain('only the owner moves the lead');
    expect(readFileSync(file, 'utf8')).toBe(FILE);
  });

  test('--lead refuses a stopped replacement and a seat that is not the lead', async () => {
    const stopped = FILE.replace('    name: worker\n', '    name: worker\n    stopped: true\n');
    writeFileSync(file, stopped);
    approveCurrent();
    const made = world();
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--lead', 'worker'], io, made.sources)).toBe(1);
    expect(io.err).toContain('worker can\'t take the lead');
    expect(readFileSync(file, 'utf8')).toBe(stopped);
    writeFileSync(file, FILE);
    approveCurrent();
    const ordinary = testIo(dir, owner);
    expect(await runRemove(['worker', '--keep', '--lead', 'lead'], ordinary, made.sources)).toBe(1);
    expect(ordinary.err).toContain('worker is not the lead');
    expect(readFileSync(file, 'utf8')).toBe(FILE);
  });

  test('a leads mark moves onto the replacement and the old seat is the one that stops', async () => {
    const marked = FILE.replace('    name: lead\n', '    name: lead\n    leads: true\n');
    writeFileSync(file, marked);
    approveCurrent();
    const made = world();
    expect(await runRemove(['lead', '--keep', '--lead', 'worker'], testIo(dir, owner), made.sources)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n    leads: true\n');
    expect(text).not.toMatch(/name: lead\n(?:    .*\n)*    leads: true\n/);
    expect(text).toMatch(/name: lead\n(?:    .*\n)*    stopped: true\n/);
    const loaded = loadTeamFile(dir, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    expect(loaded.team.orchestrator).toBe('worker');
    expect(approvalDifferences(loaded.team, loaded.root, home)).toEqual([]);
  });

  test('an operator who is not the orchestrator moves only operator', async () => {
    const split = FILE
      .replace('operator: lead\n', 'operator: ops\n')
      .replace(
        '  - role: implementer\n    name: worker\n',
        `  - role: implementer
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
`,
      );
    writeFileSync(file, split);
    approveCurrent();
    const made = world();
    const io = testIo(dir, owner);
    expect(await runRemove(['ops', '--keep', '--lead', 'worker'], io, made.sources)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('format: 1\nproject: acme\ncoordinator: lead\noperator: worker\n')).toBe(true);
    expect(text).toMatch(/name: ops\n(?:    .*\n)*    stopped: true\n/);
    expect(text).not.toMatch(/name: lead\n(?:    .*\n)*    stopped: true\n/);
    const loaded = loadTeamFile(dir, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    expect(loaded.team.orchestrator).toBe('lead');
    expect(loaded.team.operator).toBe('worker');
    expect(approvalDifferences(loaded.team, loaded.root, home)).toEqual([]);
  });

  test('the old pane closes after the file names the replacement', async () => {
    const made = world();
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    let fileAtClose = '';
    launch.closeWorkspace = () => {
      fileAtClose = readFileSync(file, 'utf8');
      made.closed.push('w0');
      return true;
    };
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--lead', 'worker'], io, made.sources)).toBe(0);
    expect(fileAtClose.startsWith('format: 1\nproject: acme\ncoordinator: worker\noperator: worker\n')).toBe(true);
    expect(fileAtClose).toMatch(/name: lead\n(?:    .*\n)*    stopped: true\n/);
    expect(made.closed).toEqual(['w0']);
    expect(io.out.endsWith('team add worker\n')).toBe(true);
  });

  test('a replacement that is already ready is not named for add', async () => {
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'w1:p2' };
    });
    const made = world();
    const io = testIo(dir, owner);
    expect(await runRemove(['lead', '--keep', '--lead', 'worker'], io, made.sources)).toBe(0);
    expect(io.out).toBe('stopped lead\n');
  });

  test('--keep leaves the seat stopped', async () => {
    const made = world();
    expect(await runRemove(['worker', '--keep', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('name: worker');
    expect(text).toContain('stopped: true');
    expect(text).toContain('name: lead');
  });

  test('--keep retains the seat id and last_active while a full remove clears them', async () => {
    const id = 'seat_0123456789ab';
    const lastActive = '2026-10-14T10:00:00.000Z';
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        id,
        stage: 'ready',
        pane: 'pane-1',
        workspace: 'ws-1',
        last_active: lastActive,
      };
    });
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'pane-1', workspace: 'ws-1', status: 'idle', cwd: null });
    expect(await runRemove(['worker', '--keep', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const afterKeep = readState(join(dir, '.agents')).sessions.acme;
    expect(afterKeep?.seats.worker).toBeUndefined();
    expect(afterKeep?.retained_seats?.worker).toEqual({ id, last_active: lastActive });

    made.agents.length = 0;
    expect(await runRemove(['worker', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const afterFull = readState(join(dir, '.agents')).sessions.acme;
    expect(afterFull?.seats.worker).toBeUndefined();
    expect(afterFull?.retained_seats?.worker).toBeUndefined();
  });

  test('remove --keep by the coordinator leaves a hand-edited launch line as drift', async () => {
    const parsed = validateTeamFile(FILE);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, dir, dir), {
      approval: approvalOf(parsed.team, dir),
      file: FILE,
    }, parsed.team.seats, dir);
    const edited = FILE.replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-opus-5-5 --yolo');
    writeFileSync(file, edited);
    recordLead();
    const made = world();
    made.sources.home = dir;
    expect(await runRemove(['worker', '--keep'], testIo(dir, lead), made.sources)).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    expect(readFileSync(file, 'utf8')).toContain('--yolo');
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(approvalDifferences(after.team, dir, dir)).toEqual(['seat worker changed']);
  });

  test('remove --keep does not approve a hand-written parked line', async () => {
    const parsed = validateTeamFile(FILE);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, dir, dir), {
      approval: approvalOf(parsed.team, dir),
      file: FILE,
    }, parsed.team.seats, dir);
    writeFileSync(file, FILE.replace('    name: worker', '    name: worker\n    parked: true'));
    recordLead();
    const made = world();
    made.sources.home = dir;
    expect(await runRemove(['worker', '--keep'], testIo(dir, lead), made.sources)).toBe(0);
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(after.team.seats.find((seat) => seat.name === 'worker')?.parked).toBe(true);
    expect(approvalDifferences(after.team, dir, dir)).toEqual(['seat worker changed']);
  });

  test('--keep by the owner leaves no drift, and a seat-made parked line is drift', async () => {
    const parsed = validateTeamFile(FILE);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, dir, dir), {
      approval: approvalOf(parsed.team, dir),
      file: FILE,
    }, parsed.team.seats, dir);
    const parked = FILE.replace('    name: worker', '    name: worker\n    parked: true');
    const hand = validateTeamFile(parked);
    if (!hand.ok) throw new Error('parked fixture');
    expect(approvalDifferences(hand.team, dir, dir)).toEqual(['seat worker changed']);

    const made = world();
    made.sources.home = dir;
    expect(await runRemove(['worker', '--keep', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(approvalDifferences(after.team, dir, dir)).toEqual([]);
  });

  test('working, blocked, unknown and unsent change nothing', async () => {
    for (const [status, screen, phrase] of [
      ['working', { kind: 'idle' }, 'is working'],
      ['idle', { kind: 'permission' }, 'is blocked'],
      ['idle', { kind: 'unknown' }, 'does not recognise'],
      ['idle', { kind: 'unsent' }, 'unsent'],
    ] as const) {
      writeFileSync(file, FILE);
      const made = world(screen, status);
      made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null });
      const io = testIo(dir, owner);
      expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
      expect(io.err).toContain(phrase);
      expect(made.typed).toEqual([]);
      expect(readFileSync(file, 'utf8')).toContain('name: worker');
    }
  });

  test('the unknown refusal names the way out to the owner', async () => {
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const ownerIo = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], ownerIo, made.sources)).toBe(1);
    expect(ownerIo.err).toBe('team remove: worker shows a screen the profile does not recognise; left as it is (team remove worker --abandon closes its workspace without typing)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test("the owner's --keep on an unknown screen is refused and names abandon", async () => {
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const before = readFileSync(file, 'utf8');
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--keep', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: worker shows a screen the profile does not recognise; left as it is (team remove worker --abandon closes its workspace without typing)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('a working seat on an unknown screen is refused, not left', async () => {
    // The one thing a non-owner never takes out: herdr reports the seat mid-turn. The screen
    // shape does not enter it — the status alone refuses — and the way out the line names is the
    // caller's own, not the owner's `--abandon`.
    const made = world({ kind: 'unknown' }, 'working');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'working', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, name) => { renamed.push([session, pane, name]); return true; };
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: worker shows a screen the profile does not recognise; left as it is (run this again once herdr reports the seat idle or done)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(renamed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a working seat holding unsent text is refused too: the status alone is the gate', async () => {
    const made = world({ kind: 'unsent' }, 'working');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'working', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, name) => { renamed.push([session, pane, name]); return true; };
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: worker holds unsent text in its input box; left as it is\n');
    expect(made.typed).toEqual([]);
    expect(renamed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('an unreadable pane on an idle seat is taken out, not refused', async () => {
    // `unknown` collapses a failed read with a read that matched nothing, and herdr's word is the
    // gate either way: idle says the seat is not mid-turn, so the delegate force-close reaches it
    // — the case this path exists for.
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    made.sources.screenText = () => undefined;
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, name) => { renamed.push([session, pane, name]); return true; };
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(io.out).toBe('removed worker (its pane w1:p1 was left running; nothing was typed; it now reads as worker-left)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(renamed).toEqual([['acme', 'w1:p1', 'worker-left']]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('an idle seat holding unsent text is taken out, not refused', async () => {
    // The idle seat whose box holds text no profile calls its exit text: herdr says idle, so a
    // delegate cycles it — nothing typed, the pane left as it is.
    const made = world({ kind: 'unsent' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, name) => { renamed.push([session, pane, name]); return true; };
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(io.out).toBe('removed worker (its pane w1:p1 was left running; nothing was typed; it now reads as worker-left)\n');
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(renamed).toEqual([['acme', 'w1:p1', 'worker-left']]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('a done seat on an unknown screen is taken out: idle and done are both the gate', async () => {
    const made = world({ kind: 'unknown' }, 'done');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'done', cwd: null });
    made.sources.renameAgent = (_session, _pane, name) => name === 'worker-left';
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(io.out).toBe('removed worker (its pane w1:p1 was left running; nothing was typed; it now reads as worker-left)\n');
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('a coordinator on an unknown screen leaves the pane and takes the seat out', async () => {
    // The seat has a state record — the incident's shape — and the record goes with it, so the
    // pane can be cycled into a fresh temporary seat through the ordinary `team add`.
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'w1:p1' };
    });
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    // `worker-left` is held by another agent of the session: the rename steps to the next free name.
    made.agents.push({ name: 'worker-left', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, name) => { renamed.push([session, pane, name]); return true; };
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(renamed).toEqual([['acme', 'w1:p1', 'worker-left-2']]);
    expect(io.out).toBe('removed worker (its pane w1:p1 was left running; nothing was typed; it now reads as worker-left-2)\n');
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.worker).toBeUndefined();
  });

  test('a leave whose rename does not take still removes the seat, and says the pane keeps the name', async () => {
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    made.sources.renameAgent = () => false;
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(io.out).toBe("removed worker (its pane w1:p1 was left running; nothing was typed; it still carries the seat's name)\n");
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('--keep on an unknown screen: the entry stays stopped, the pane is left running', async () => {
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    made.sources.renameAgent = (_session, _pane, name) => name === 'worker-left';
    recordLead();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker', '--keep'], io, made.sources)).toBe(0);
    expect(io.out).toBe('stopped worker (its pane w1:p1 was left running; nothing was typed; it now reads as worker-left)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
  });

  test('--abandon closes an unknown screen without typing; a coordinator may not', async () => {
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    recordLead();
    const seat = testIo(dir, lead);
    expect(await runRemove(['worker', '--abandon'], seat, made.sources)).toBe(1);
    expect(seat.err).toContain('only the owner abandons');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    const ownerIo = testIo(dir, owner);
    expect(await runRemove(['worker', '--abandon', '--file', file], ownerIo, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('a Cursor queue screen is working: the seat is left and nothing is typed', async () => {
    // The screen is a real queue fixture, read through the profile: a turn with
    // follow-ups waiting on it is working, so its pane never gets the exit text.
    const queued = readScreen(
      'cursor',
      readFileSync(new URL('../fixtures/cursor/2026.10.01/follow-up-queue-two.txt', import.meta.url), 'utf8'),
    );
    expect(queued.kind).toBe('working');
    const made = world(queued, 'idle');
    made.agents.push({ name: 'worker', agent: 'cursor', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toContain('is working');
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a time-out leaves the seat and the file', async () => {
    const made = world();
    made.running.push(true);
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.out).toContain('left as it is');
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('only the owner removes the orchestrator, and only the owner abandons', async () => {
    recordLead();
    const made = world();
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const seat = testIo(dir, lead);
    expect(await runRemove(['lead'], seat, made.sources)).toBe(1);
    expect(seat.err).toContain('only the owner');
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
    const abandon = testIo(dir, lead);
    expect(await runRemove(['worker', '--abandon'], abandon, world({ kind: 'permission' }, 'idle').sources)).toBe(1);
    expect(abandon.err).toContain('only the owner abandons');
  });

  test('--abandon closes a blocked seat without typing, and taking out the coordinator is refused', async () => {
    const made = world({ kind: 'permission' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    expect(await runRemove(['worker', '--abandon', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    const leadRun = world();
    leadRun.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const leadIo = testIo(dir, owner);
    expect(await runRemove(['lead', '--file', file], leadIo, leadRun.sources)).toBe(2);
    expect(leadIo.err).toContain('names no declared seat');
    expect(leadRun.typed).toEqual([]);
    expect(leadRun.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
  });

  test('a temporary seat is stopped, its rules file goes with it, and it is not written into the file', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:done.md' } };
    });
    const made = world();
    // The writer and the remover both build the path from the approval this fixture already holds.
    const standing = approvalStanding(dir, home);
    const rulesFile = rulesFilePathOf(standing, 'worker-tmp-1', dir, home) as string;
    expect(writeRulesFile(standing, 'worker-tmp-1', dir, home, 'Rules.\n', rulesFileHash('Rules.\n'))).toEqual({ ok: true });
    made.agents.push({ name: 'worker-tmp-1', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null });
    const left = testIo(dir, owner);
    expect(await runRemove(['worker-tmp-1', '--file', file], left, made.sources)).toBe(1);
    expect(left.err).toContain('worker-tmp-1: its record is not an approved seat; left as it is (the owner cleans it: team remove worker-tmp-1 --abandon)');
    expect(made.typed).toEqual([]);
    expect(existsSync(rulesFile)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('tmp');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeDefined();
    const abandoned = testIo(dir, owner);
    expect(await runRemove(['worker-tmp-1', '--abandon', '--file', file], abandoned, made.sources)).toBe(0);
    expect(abandoned.out).toContain('removed temporary worker-tmp-1');
    expect(made.typed).toEqual([]);
    expect(existsSync(rulesFile)).toBe(false);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeUndefined();
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:done.md' } };
    });
    const kept = testIo(dir, owner);
    expect(await runRemove(['worker-tmp-1', '--keep', '--file', file], kept, world().sources)).toBe(1);
    expect(kept.err).toContain('nothing to keep');
  });

  // A record the file does not hold, and the approved copy does not either. Not temporary.
  // `cli` is the one the record carries, when the screen must be read under it.
  function strayRecord(name = 'stray', cli?: string): void {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: lead.pane };
      session.seats[name] = {
        stage: 'ready',
        pane: name === 'lead' ? lead.pane : 'w9:p1',
        ...(cli !== undefined ? { cli } : {}),
      };
    });
  }

  // The running turn `test/watch.test.ts` classifies as working for claude-code, and unknown
  // for a cli the profiles do not carry.
  const RUNNING_RULE = '─'.repeat(40);
  const RUNNING_STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  const RUNNING_CAPTURE_TEXT = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RUNNING_RULE}\n❯ \n${RUNNING_RULE}\n${RUNNING_STATUS}\n`;

  test('an idle leftover is left running by a non-owner: the record drops, nothing is typed', async () => {
    strayRecord();
    const made = world({ kind: 'idle' }, 'idle');
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, to) => { renamed.push([session, pane, to]); return true; };
    const before = readFileSync(file, 'utf8');
    const io = testIo(dir, lead);
    expect(await runRemove(['stray'], io, made.sources)).toBe(0);
    expect(io.out).toBe('removed stray (its pane w9:p1 was left running; nothing was typed; it now reads as stray-left)\n');
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(renamed).toEqual([['acme', 'w9:p1', 'stray-left']]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeUndefined();
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.lead).toBeDefined();
  });

  test('a working leftover stays out, and the line names the non-owner\'s way', async () => {
    strayRecord();
    const made = world({ kind: 'idle' }, 'working');
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'working', cwd: null });
    const io = testIo(dir, lead);
    expect(await runRemove(['stray'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: stray is working; left as it is (run this again once herdr reports the seat idle or done)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeDefined();
  });

  test('a leftover whose screen shows a running turn stays out too', async () => {
    strayRecord();
    const made = world({ kind: 'working' }, 'idle');
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });
    const io = testIo(dir, lead);
    expect(await runRemove(['stray'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: stray is working; left as it is (run this again once herdr reports the seat idle or done)\n');
    expect(made.closed).toEqual([]);
  });

  test('a leftover whose recorded cli shows a running turn stays out, and the arm reads that cli', async () => {
    strayRecord('stray', 'claude-code');
    const received: string[] = [];
    const made = world({ kind: 'idle' }, 'idle');
    made.sources.screen = (_session, _pane, cli) => {
      received.push(cli);
      return readScreen(cli, RUNNING_CAPTURE_TEXT);
    };
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, to) => { renamed.push([session, pane, to]); return true; };
    const io = testIo(dir, lead);
    expect(await runRemove(['stray'], io, made.sources)).toBe(1);
    expect(received).toEqual(['claude-code']);
    expect(io.err).toBe('team remove: stray is working; left as it is (run this again once herdr reports the seat idle or done)\n');
    expect(renamed).toEqual([]);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeDefined();
  });

  test('a name the live file declares and the approved copy does not keeps today\'s refusal', async () => {
    writeFileSync(file, `${FILE}  - role: implementer
    name: stray
    label: stray
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
    strayRecord();
    const before = readFileSync(file, 'utf8');
    const made = world({ kind: 'idle' }, 'idle');
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, to) => { renamed.push([session, pane, to]); return true; };
    const io = testIo(dir, lead);
    expect(await runRemove(['stray'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: stray: its record is not an approved seat; left as it is (the owner cleans it: team remove stray --abandon)\n');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeDefined();
    expect(renamed).toEqual([]);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
  });

  test('a leftover with no live agent keeps today\'s refusal', async () => {
    strayRecord();
    const made = world();
    const io = testIo(dir, lead);
    expect(await runRemove(['stray'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: stray: its record is not an approved seat; left as it is (the owner cleans it: team remove stray --abandon)\n');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeDefined();
  });

  test('the owner meeting an idle leftover keeps today\'s refusal', async () => {
    strayRecord();
    const made = world({ kind: 'idle' }, 'idle');
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['stray', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: stray: its record is not an approved seat; left as it is (the owner cleans it: team remove stray --abandon)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeDefined();
  });

  test('a leftover named as the orchestrator stays the owner\'s', async () => {
    strayRecord('lead');
    const made = world({ kind: 'idle' }, 'idle');
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const io = testIo(dir, lead);
    expect(await runRemove(['lead'], io, made.sources)).toBe(1);
    expect(io.err).toBe('team remove: only the owner removes the orchestrator\'s or the operator\'s seat; this call is lead\n');
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
  });

  test('a name the approved copy carries keeps its rules file when the state still marks it temporary', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', temporary: { like: 'lead', until: 'result:done.md' } };
    });
    const made = world();
    const standing = approvalStanding(dir, home);
    const rulesFile = rulesFilePathOf(standing, 'worker', dir, home) as string;
    expect(writeRulesFile(standing, 'worker', dir, home, 'Rules.\n', rulesFileHash('Rules.\n'))).toEqual({ ok: true });
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--abandon', '--file', file], io, made.sources)).toBe(0);
    expect(io.out).toContain('removed worker');
    expect(io.out).not.toContain('removed temporary');
    expect(existsSync(rulesFile)).toBe(true);
  });

  test('a caller who may not change the team changes nothing', async () => {
    const io = testIo(dir, { kind: 'seat', name: 'worker', pane: 'w1:p1' });
    expect(await runRemove(['worker'], io, world().sources)).toBe(1);
    expect(io.err).toContain('only the owner, the orchestrator or the operator');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });
});

// The delegated runs: the file names a delegate — a pane outside the team's session — and the
// caller is a named agent standing on that pane, a seat of another session the ordinary rule
// refuses. The gate itself is faked here (the contract's verdicts, handed in through
// `sources.delegateGate`); its own tests cover what the real one reads to decide.
const DELEGATES = `delegates:
  - pane: main/w1:p1
    commands: [add, remove]
`;
const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w1:p1', session: 'main' };
const passed = { kind: 'passed' as const, pane: 'main/w1:p1' };
// A gate that fails the test the moment it is asked where the run must not ask it: the ordinary
// rule's own callers never reach the delegate branch, and neither does a file with no delegates.
const THROWING_GATE: NonNullable<RemoveSources['delegateGate']> = () => {
  throw new Error('the gate is asked only after the ordinary rule refused, and only when the file names a delegate');
};

// The file and the approval in force for it, together: a delegated run needs both, and the
// `delegates` section they carry is the one the gate reads. Returns the record's own path, so a
// test reads the store the load itself resolved — never a path rebuilt from `dir`.
function rootOf(cwd: string): string {
  const loaded = loadTeamFile(cwd);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.root;
}

function approveFile(text: string): string {
  writeFileSync(file, text);
  const loaded = loadTeamFile(dir);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const store = storePath(loaded.team.project, loaded.root, home);
  writeApproval(
    store,
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
    home,
  );
  return store;
}

describe('team remove delegated', () => {
  test('no delegates in the file: the refusal is today\'s and the gate is never asked', async () => {
    const made = world();
    const io = testIo(dir, pilot);
    let asked = 0;
    const code = await runRemove(['worker'], io, {
      ...made.sources,
      delegateGate: () => { asked += 1; return passed; },
    });
    expect(code).toBe(1);
    expect(io.err).toBe('team remove: only the owner, the orchestrator or the operator runs it; this call is pilot\n');
    expect(asked).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a refused verdict takes the ordinary refusal\'s place, and nothing is stopped or written', async () => {
    const store = approveFile(FILE + DELEGATES);
    const made = world();
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(dir, pilot);
    const code = await runRemove(['worker', '--keep'], io, {
      ...made.sources,
      delegateGate: () => ({
        kind: 'refused' as const,
        id: 'remove.delegate-flag',
        text: '--keep is the owner\'s; the approved delegate cannot use it',
      }),
    });
    expect(code).toBe(1);
    expect(io.err).toBe('team remove: --keep is the owner\'s; the approved delegate cannot use it\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
  });

  test('the gate is asked once, with the live file, the project and the flags the caller passed', async () => {
    approveFile(FILE + DELEGATES);
    const made = world();
    const io = testIo(dir, pilot);
    const asked: Parameters<NonNullable<RemoveSources['delegateGate']>>[0][] = [];
    const code = await runRemove(['worker', '--keep'], io, {
      ...made.sources,
      delegateGate: (input) => {
        asked.push(input);
        return { kind: 'refused' as const, id: 'remove.delegate-flag', text: '--keep is the owner\'s; the approved delegate cannot use it' };
      },
    });
    expect(code).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.command).toBe('remove');
    expect(asked[0]!.team.delegates).toEqual([{ pane: 'main/w1:p1', commands: ['add', 'remove'] }]);
    expect(asked[0]!.root).toBe(rootOf(dir));
    expect(asked[0]!.dir).toBe(join(rootOf(dir), '.agents'));
    expect(asked[0]!.flags).toEqual(['keep']);
    expect(asked[0]!.io).toBe(io);
  });

  test('a delegated removal stops the seat, edits the file, signs nothing, and is logged', async () => {
    const store = approveFile(FILE + DELEGATES);
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(dir, pilot);
    const code = await runRemove(['worker'], io, { ...made.sources, delegateGate: () => passed });
    expect(code).toBe(0);
    expect(io.out).toContain('removed worker\n');
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual(['w3']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
    // The audit line is the log's first line: the run is attributed before its effects.
    expect(readFileSync(join(dir, '.agents', 'team.log'), 'utf8').startsWith(
      '1970-01-01T00:00:00.000Z delegate [delegate] main/w1:p1 remove\n',
    )).toBe(true);
  });

  test('a delegated removal of an idle leftover leaves the pane and logs the audit line', async () => {
    const store = approveFile(FILE + DELEGATES);
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).seats.stray = { stage: 'ready', pane: 'w9:p1' };
    });
    const made = world({ kind: 'idle' }, 'idle');
    made.agents.push({ name: 'stray', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null });
    const renamed: [string, string, string][] = [];
    made.sources.renameAgent = (session, pane, to) => { renamed.push([session, pane, to]); return true; };
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const before = readFileSync(file, 'utf8');
    const io = testIo(dir, pilot);
    expect(await runRemove(['stray'], io, { ...made.sources, delegateGate: () => passed })).toBe(0);
    expect(io.out).toBe('removed stray (its pane w9:p1 was left running; nothing was typed; it now reads as stray-left)\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(renamed).toEqual([['acme', 'w9:p1', 'stray-left']]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
    expect(readState(join(dir, '.agents')).sessions.acme?.seats.stray).toBeUndefined();
    expect(readFileSync(join(dir, '.agents', 'team.log'), 'utf8').startsWith(
      '1970-01-01T00:00:00.000Z delegate [delegate] main/w1:p1 remove\n',
    )).toBe(true);
  });

  test('a delegated removal on an unknown screen leaves the pane, takes the seat out and signs nothing', async () => {
    const store = approveFile(FILE + DELEGATES);
    const made = world({ kind: 'unknown' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(dir, pilot);
    const code = await runRemove(['worker'], io, { ...made.sources, delegateGate: () => passed });
    expect(code).toBe(0);
    // This world's sources carry no rename: the removal stands and the line says the pane keeps
    // the seat's name.
    expect(io.out).toBe("removed worker (its pane w3:p1 was left running; nothing was typed; it still carries the seat's name)\n");
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
    expect(readFileSync(join(dir, '.agents', 'team.log'), 'utf8').startsWith(
      '1970-01-01T00:00:00.000Z delegate [delegate] main/w1:p1 remove\n',
    )).toBe(true);
  });

  test('a delegated remove still refuses the coordinator and the operator, and --abandon', async () => {
    approveFile(FILE + DELEGATES);
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
    const io = testIo(dir, pilot);
    const code = await runRemove(['lead'], io, { ...made.sources, delegateGate: () => passed });
    expect(code).toBe(1);
    expect(io.err).toBe('team remove: only the owner removes the orchestrator\'s or the operator\'s seat; this call is pilot\n');
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
    const abandoning = testIo(dir, pilot);
    const again = await runRemove(['worker', '--abandon'], abandoning, { ...made.sources, delegateGate: () => passed });
    expect(again).toBe(1);
    expect(abandoning.err).toBe('team remove: only the owner abandons a seat, from a terminal outside herdr\n');
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('even a gate that passed --keep finds no signing: the record is not the delegate\'s to write', async () => {
    // The real gate refuses `--keep` for a delegate; this run pins the invariant at the command
    // layer — the one signing site a `remove` has is closed to a delegated run, so nothing a
    // mistaken gate lets through can re-anchor the approval.
    const store = approveFile(FILE + DELEGATES);
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(dir, pilot);
    const code = await runRemove(['worker', '--keep'], io, { ...made.sources, delegateGate: () => passed });
    expect(code).toBe(0);
    expect(io.out).toContain('stopped worker\n');
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
  });

  test('the coordinator\'s ordinary --keep runs as today, and the gate is never asked for it', async () => {
    // Amendment 3, with the reviewer's finding on it: a caller the ordinary rule accepts never
    // enters the delegate branch — the injected gate throws the moment it is asked, so the run
    // below passes only because it never reached it. The coordinator's `--keep` is the role path
    // that re-signs the approval — it must keep working with a `delegates` section in the file,
    // unreachable from the delegate branch.
    const store = approveFile(FILE + DELEGATES);
    const before = readFileSync(join(store, 'approval.json'), 'utf8');
    recordLead();
    const made = world();
    const io = testIo(dir, lead);
    const code = await runRemove(['worker', '--keep'], io, { ...made.sources, delegateGate: THROWING_GATE });
    expect(code).toBe(0);
    expect(io.out).toContain('stopped worker\n');
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    // The role path re-signed the seat digest, exactly as today: the record moved, and the file
    // in force is the approved one again.
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).not.toBe(before);
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(approvalDifferences(after.team, rootOf(dir), home)).toEqual([]);
  });

  test('the owner\'s ordinary --keep runs as today too: the gate is not for it', async () => {
    // The finding's own words: the ordinary owner, coordinator or operator rule runs first. The
    // owner's `--keep` is the widest of those paths, and it too must run with a `delegates`
    // section in the file as though the section were not there.
    const store = approveFile(FILE + DELEGATES);
    const before = readFileSync(join(store, 'approval.json'), 'utf8');
    const made = world();
    const io = testIo(dir, owner);
    const code = await runRemove(['worker', '--keep'], io, { ...made.sources, delegateGate: THROWING_GATE });
    expect(code).toBe(0);
    expect(io.out).toContain('stopped worker\n');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).not.toBe(before);
  });

  test('a delegate\'s --file and --session are the gate\'s to refuse, before either is read', async () => {
    // The reviewer's finding on down and up, checked here: once the file names a delegate, the
    // owner-only flags are the gate's too, and the refusal still comes before the flagged file
    // or the flag's session is read — the `--file` below names a path that does not exist, so a
    // run that opened it would print the loader's refusal, not the gate's. Eligibility is the
    // default live file's, never the flagged one's.
    const store = approveFile(FILE + DELEGATES);
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const asked: Parameters<NonNullable<RemoveSources['delegateGate']>>[0][] = [];
    const gate: NonNullable<RemoveSources['delegateGate']> = (input) => {
      asked.push(input);
      const flag = input.flags.includes('file') ? 'file' : 'session';
      return { kind: 'refused' as const, id: 'remove.delegate-flag', text: `--${flag} is the owner's; the approved delegate cannot use it` };
    };
    for (const argv of [['worker', '--file', join(dir, 'elsewhere.yaml')], ['worker', '--session', 'other']] as const) {
      const made = world();
      const io = testIo(dir, pilot);
      const code = await runRemove([...argv], io, { ...made.sources, delegateGate: gate });
      expect(code).toBe(1);
      expect(io.err).toBe(`team remove: --${argv[2] === 'other' ? 'session' : 'file'} is the owner's; the approved delegate cannot use it\n`);
      expect(made.typed).toEqual([]);
      expect(made.closed).toEqual([]);
    }
    expect(asked).toHaveLength(2);
    expect(asked[0]!.team.delegates).toEqual([{ pane: 'main/w1:p1', commands: ['add', 'remove'] }]);
    expect(asked[0]!.root).toBe(rootOf(dir));
    expect(asked[0]!.dir).toBe(join(rootOf(dir), '.agents'));
    expect(asked[0]!.flags).toContain('file');
    expect(asked[1]!.flags).toContain('session');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
  });

  test('with no delegates in the default file, a non-owner\'s --file and --session are today\'s, byte for byte', async () => {
    // The finding's other half: eligibility is the default live file's alone. The flagged file
    // below names a delegate and is never read for it; the refusals stay today's sentences, in
    // today's order, and the gate is never asked.
    approveFile(FILE);
    writeFileSync(join(dir, 'elsewhere.yaml'), FILE + DELEGATES);
    for (const [argv, text] of [
      [['worker', '--file', join(dir, 'elsewhere.yaml')], '--file is the owner\'s, from a terminal outside herdr; this call is pilot'],
      [['worker', '--session', 'other'], '--session is the owner\'s, from a terminal outside herdr; this call is pilot'],
    ] as const) {
      const made = world();
      const io = testIo(dir, pilot);
      const code = await runRemove([...argv], io, { ...made.sources, delegateGate: THROWING_GATE });
      expect(code).toBe(1);
      expect(io.err).toBe(`team remove: ${text}\n`);
      expect(made.typed).toEqual([]);
      expect(readFileSync(file, 'utf8')).toContain('name: worker');
    }
  });

  test('a delegate named like the coordinator gets none of the coordinator\'s --keep', async () => {
    // Amendment 3: a delegate does not reach the role path by being named like a lead. This
    // caller carries the coordinator's name but stands on the delegate's pane, in another
    // session: the ordinary rule refuses it, the gate places it, and the run is a delegated one
    // — the record is not the delegate's to write, whatever name it brought.
    const store = approveFile(FILE + DELEGATES);
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
    const record = readFileSync(join(store, 'approval.json'), 'utf8');
    const io = testIo(dir, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'main' });
    let asked = 0;
    const code = await runRemove(['worker', '--keep'], io, {
      ...made.sources,
      delegateGate: () => { asked += 1; return passed; },
    });
    expect(code).toBe(0);
    expect(asked).toBe(1);
    expect(io.out).toContain('stopped worker\n');
    expect(readFileSync(join(store, 'approval.json'), 'utf8')).toBe(record);
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(approvalDifferences(after.team, rootOf(dir), home)).toEqual(['seat worker changed']);
  });

  // The three states a target session can be in, with the REAL gate. Only its two herdr reads
  // about the team's session are faked, with the answers herdr 0.7.1 gives — a stopped or absent
  // session fails `agent list` while `session list` still reports it, running false, and an
  // unreachable herdr answers neither. `remove` asks the gate without a home, so the test hands
  // it the one its own approval was written into; every other read is the gate's own.
  type GateInput = Parameters<NonNullable<RemoveSources['delegateGate']>>[0];
  const gateReading = (running: boolean | null) => (input: GateInput) =>
    delegateGate({ ...input, home, sources: { agents: () => null, sessionRunning: () => running } });

  test('a delegated remove on a stopped or absent session passes the gate and takes the seat out', async () => {
    for (const state of ['stopped', 'absent']) {
      const store = approveFile(FILE + DELEGATES);
      const made = world();
      const io = testIo(dir, pilot);
      const code = await runRemove(['worker'], io, {
        ...made.sources,
        sessionRunning: () => false,
        delegateGate: gateReading(false),
      });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      expect(io.out).toBe('removed worker\n');
      // Nothing was stopped: with no session there is no seat to exit.
      expect(made.typed).toEqual([]);
      expect(made.keys).toEqual([]);
      // A delegated run, attributed at its effects.
      expect(readFileSync(join(dir, '.agents', 'team.log'), 'utf8')).toContain(`delegate [delegate] main/w1:p1 remove\n`);
      // The file edit landed and no approval was re-signed.
      expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
      expect(existsSync(store)).toBe(true);
    }
  });

  test('a delegated remove with herdr not answering is the gate\'s refusal, and nothing is changed', async () => {
    approveFile(FILE + DELEGATES);
    const made = world();
    const io = testIo(dir, pilot);
    const before = readFileSync(file, 'utf8');
    const code = await runRemove(['worker'], io, {
      ...made.sources,
      sessionRunning: () => null,
      delegateGate: gateReading(null),
    });
    expect(code).toBe(1);
    expect(io.err).toBe(`team remove: delegation cannot verify its placement or seats: herdr doesn't answer\n`);
    expect(io.out).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
  });
});

// The session mutator lock, `remove`'s side: the same `.run` under `seat-locks/<session>/` that
// `up`, `add` and `down` take — one file per session, shared by every mutator — taken after
// every refusal and held through the stop, the file edit and the state drops. A refused run
// never takes one; a lock a killed run left is taken over by the next one.
describe('team remove, the session mutator lock', () => {
  const lockFile = (): string => seatLockPath(join(dir, '.agents'), 'acme', '.run');
  const hold = (token: string): void => {
    mkdirSync(join(dir, '.agents', 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(lockFile(), token);
  };

  test("a held lock refuses the removal, with the holder's pid, before any effect", async () => {
    hold(`${process.pid} 0a1b2c3d\n`);
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toBe(
      `team remove: another session-mutating run is holding session acme (pid ${process.pid}); try again when it is done\n`,
    );
    expect(io.out).toBe('');
    expect(made.typed).toEqual([]);
    expect(made.keys).toEqual([]);
    expect(made.closed).toEqual([]);
    // Nothing was written: the seat's line is still in the file, and the lock a live holder owns
    // is left as it was.
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${process.pid} 0a1b2c3d\n`);
  });

  test('the lock is held through the stop and released at the end', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const held: boolean[] = [];
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    const typeText = launch.typeText;
    launch.typeText = (session, pane, text) => {
      held.push(existsSync(lockFile()));
      return typeText(session, pane, text);
    };
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(held).toEqual([true]);
    expect(held).not.toContain(false);
    // The edit went in under the same lock, and the lock is gone with the run: the next session
    // command takes it again.
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a lock left by a dead run is taken over and released by this one', async () => {
    const dead = spawnSync('sh', ['-c', 'exit 0']).pid;
    expect(typeof dead).toBe('number');
    hold(`${dead} 0a1b2c3d\n`);
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(made.typed).toEqual(['/exit']);
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a refusal decided above the lock leaves no lock behind', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    // No approval under this home: `remove.never-approved` is decided before the lock site, so
    // the refused run must not leave a lock file the next real run would meet.
    made.sources.home = join(dir, 'nowhere');
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toContain('never approved');
    expect(made.typed).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  test('a lock that cannot be read refuses with the file to clear', async () => {
    hold('not a token\n');
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    // An unreadable lock is held, never stale (`seat-lock.ts`), so the owner is the only way
    // out and the message names the file.
    expect(io.err).toBe(
      'team remove: another session-mutating run may be holding session acme, and its lock cannot be read; '
        + `if no run is using it, delete ${lockFile()}\n`,
    );
    expect(made.typed).toEqual([]);
  });
});
