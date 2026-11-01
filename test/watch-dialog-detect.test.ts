// A seat held at a dialog is its own state in the watch, never idle and never a screen no profile
// reads: the agent's question, a plan it waits to execute, and a confirmation the CLI or the agent
// raises before acting. The question the dialog shows is read off the pane and carried with the
// seat — in the pass's report and in the status engine's at-prompt event — so the orchestrator and
// the operator learn what is being asked, once per occurrence. Read-only throughout: nothing here
// types into a pane, and a screen no profile reads stays the unknown the watch already reports.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { watchReportEvent } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { CheckContext, SeatObservation } from '../src/watch/check.ts';
import { attention } from '../src/watch/checks/attention.ts';
import type { Machine } from '../src/watch/machine.ts';
import { readDialog } from '../src/watch/dialog.ts';
import { attentionOf, newMemory, pass } from '../src/watch/pass.ts';
import { questionText, readScreen } from '../src/watch/screen.ts';
import { classifyPromptKind, createSeatStatusEngine, herdrStatusSource } from '../src/watch/status-events.ts';

const fixture = (path: string): string => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');

// The captured dialogs, as each CLI drew them.
const PLAN = fixture('claude-code/2.1.289/permission-plan-wide-plain.txt');
const HELD = fixture('claude-code/2.1.302/held.txt');
const ASKED = fixture('claude-code/2.1.302/question.txt');
const ASKED_OLDER = fixture('claude-code/2.1.289/question-plain.txt');
const CURSOR_SWITCH = fixture('cursor/2026.10.01/permission-plan.txt');
const CURSOR_ASKED = fixture('cursor/2026.10.16/question.txt');
const CODEX_PLAN = fixture('codex/0.161.0/plan-approval.txt');
const CODEX_PLAN_ANSI = fixture('codex/0.161.0/plan-approval-ansi.txt');
const CODEX_ASKED = fixture('codex/0.161.0/question.txt');
const CODEX_ASKED_ANSI = fixture('codex/0.161.0/question-ansi.txt');
const CODEX_IDLE = fixture('codex/0.161.0/idle.txt');
const CODEX_WORKING = fixture('codex/0.161.0/working.txt');
const GEMINI_ASKED = fixture('gemini/0.64.0/question.txt');
const GROK_ASKED = fixture('grok/1.0.52/question.txt');
const AGY_UNSENT = fixture('antigravity/1.2.16/question-unsent-54.txt');
const AGY_ASKED = fixture('antigravity/1.4.2/question.txt');
const IDLE = fixture('claude-code/2.1.302/idle.txt');
const QUOTED = fixture('claude-code/quoted-dialog.txt');

const PLAN_TEXT = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';
const HELD_TEXT = 'Held message from another session';
const ASKED_TEXT = 'Which name do you want to use?';
const ASKED_OLDER_TEXT = 'Which filename should I use for the file?';
const SWITCH_TEXT = 'Switch to Plan mode?';
const UNSENT_TEXT = 'You have unsent comments. Ready to send?';
const CODEX_PLAN_TEXT = 'Implement this plan?';
const CODEX_ASKED_TEXT = 'What should the new README line say?';

// The example team with an operator of its own (the watch's own fixture shape): the coordinator is
// the orchestrator, so a worker's dialog is a worker's.
const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`).replace('  seats: 6', '  seats: 8');

function team(): TeamFile {
  const result = validateTeamFile(example);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

function agent(name: string, workspace: string, status: string, kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team, everyone working, the operator at an empty prompt; one seat's screen is the
// scene's own.
function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle', idle],
    ['claude-coordinator-acme', 'w1', 'working', busy],
    ['codex-acme', 'w2', 'working', ''],
    ['deepseek-acme', 'w3', 'working', busy],
    ['deepseek-acme-2', 'w4', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, name.startsWith('codex') ? 'codex' : 'claude'));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

const run = (world: Live, memory = newMemory(), now = 0) =>
  pass({ team: team(), watch: team().watch, state: emptySession(), live: world, machine: fine, now, memory });

// A seat as the attention check is handed one: the dialog fields a scene sets are the only ones
// that matter, and the rest are the pass's own defaults for a running worker.
function observation(over: Partial<SeatObservation>): SeatObservation {
  return {
    name: 'worker-1',
    seat: undefined,
    rule: undefined,
    agent: { name: 'worker-1', pane: 's1:p1', workspace: 'w1', status: 'blocked', agent: 'claude', cwd: null },
    herdr: true,
    screen: { kind: 'unknown' },
    cli: 'claude-code',
    vendor: 'anthropic',
    account: 'anthropic',
    quota: [],
    identity: 'unknown',
    launcher: false,
    continuity: 'other',
    running: true,
    recorded: 'ready',
    quiet: false,
    working: false,
    prompt: true,
    lead: false,
    parked: false,
    stopped: false,
    attention: null,
    dialogText: null,
    model: null,
    history: { lastWorking: undefined, idleSince: undefined },
    liveness: { idle_lead_seconds: 300, idle_owner_seconds: 1800, blind_after_seconds: 600 },
    ...over,
  };
}

// The check's context: every `once` reports, so a scene can read the report the first pass makes.
const ctx: CheckContext = {
  now: Date.parse('2026-11-01T12:00:00.000Z'),
  watch: team().watch,
  budgets: team().budgets,
  once: (key, text, to = 'operator') => ({ key, text, to }),
  keep: () => {},
  memory: <T>(_kind: string, init: () => T): T => init(),
};

describe('a dialog is its own attention, read off each CLI’s captured screen', () => {
  test('a plan approval, a held frame and a mode switch are not permission and not unknown', () => {
    expect(attentionOf(readScreen('claude-code', PLAN), 'blocked', false)).toBe('plan approval');
    expect(attentionOf(readScreen('codex', CODEX_PLAN), 'blocked', false)).toBe('plan approval');
    expect(attentionOf(readScreen('claude-code', HELD), 'idle', true)).toBe('confirmation');
    expect(attentionOf(readScreen('cursor', CURSOR_SWITCH), 'blocked', false)).toBe('confirmation');
    expect(attentionOf(readScreen('antigravity', AGY_UNSENT), 'idle', true)).toBe('confirmation');
  });

  test('an empty prompt and a quoted dialog stay no attention at all', () => {
    expect(attentionOf(readScreen('claude-code', IDLE), 'idle', true)).toBeNull();
    expect(attentionOf(readScreen('claude-code', QUOTED), 'idle', true)).toBeNull();
  });

  test('the status adapter names the two kinds, and a login screen keeps its name', () => {
    expect(classifyPromptKind('claude-code', PLAN)).toBe('plan approval');
    expect(classifyPromptKind('codex', CODEX_PLAN)).toBe('plan approval');
    expect(classifyPromptKind('codex', CODEX_ASKED)).toBe('question');
    expect(classifyPromptKind('claude-code', HELD)).toBe('confirmation');
    expect(classifyPromptKind('cursor', CURSOR_SWITCH)).toBe('confirmation');
    expect(classifyPromptKind('antigravity', AGY_UNSENT)).toBe('confirmation');
    expect(classifyPromptKind('claude-code', 'Session expired. Please sign in to authenticate your account.\n')).toBe('login');
    expect(classifyPromptKind('claude-code', IDLE)).toBe('unknown');
  });

  test('one pane read gives the kind and the question together', () => {
    let reads = 0;
    const source = herdrStatusSource({ readPane: () => { reads += 1; return PLAN; } });
    const target = { name: 'worker-1', pane: 'pane1', cli: 'claude-code' };
    expect(source.promptReading!(target)).toEqual({ kind: 'plan approval', text: PLAN_TEXT });
    expect(reads).toBe(1);
    // `promptKind` is the same reading with the text dropped: still one read per call.
    expect(source.promptKind!(target)).toBe('plan approval');
    expect(reads).toBe(2);
  });
});

describe('the watch reports the seat and the question, once per occurrence', () => {
  test('a plan approval at a worker: the plan is quoted, and it is the operator\'s', () => {
    const result = run(live({ 'deepseek-acme': { status: 'blocked', screen: PLAN } }));
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report.key).toMatch(/^plan approval:deepseek-acme:[0-9a-f]{12}$/);
    expect(report.text).toBe(`deepseek-acme waits at a plan approval prompt — "${PLAN_TEXT}": the operator's to act on`);
    expect(report.to).toBe('operator');
  });

  test('a codex seat at its plan approval or its question is reported with the dialog’s own line', () => {
    const plan = run(live({ 'codex-acme': { status: 'blocked', screen: CODEX_PLAN } })).reports;
    expect(plan).toHaveLength(1);
    expect(plan[0]!.key).toMatch(/^plan approval:codex-acme:[0-9a-f]{12}$/);
    expect(plan[0]!.text).toBe(`codex-acme waits at a plan approval prompt — "${CODEX_PLAN_TEXT}": the operator's to act on`);
    expect(plan[0]!.to).toBe('operator');
    const asked = run(live({ 'codex-acme': { status: 'blocked', screen: CODEX_ASKED } })).reports;
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toBe(`codex-acme asked a question — "${CODEX_ASKED_TEXT}": the operator's to act on`);
  });

  test('a held frame is a confirmation with its own headline', () => {
    expect(run(live({ 'deepseek-acme': { status: 'idle', screen: HELD } })).reports.map((report) => report.text))
      .toEqual([`deepseek-acme waits at a confirmation prompt — "${HELD_TEXT}": the operator's to act on`]);
  });

  test('a question carries its own text when the profile places one, and the sentence alone otherwise', () => {
    expect(run(live({ 'deepseek-acme': { status: 'blocked', screen: ASKED } })).reports.map((report) => report.text))
      .toEqual([`deepseek-acme asked a question — "${ASKED_TEXT}": the operator's to act on`]);
    // A question screen with no placed text keeps the operator's line it already had.
    const bare = 'Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
    expect(run(live({ 'deepseek-acme': { status: 'blocked', screen: bare } })).reports)
      .toEqual([{ key: 'question:deepseek-acme', text: "deepseek-acme asked a question: the operator's to act on", to: 'operator' }]);
  });

  test('the same dialog is said once; a new question of the same kind is a new occurrence', () => {
    const memory = newMemory();
    expect(run(live({ 'deepseek-acme': { status: 'blocked', screen: ASKED } }), memory, 0).reports).toHaveLength(1);
    expect(run(live({ 'deepseek-acme': { status: 'blocked', screen: ASKED } }), memory, MIN).reports).toEqual([]);
    // The operator answers the first question and the agent asks another: the text changed, so the
    // seat is at a new occurrence, and the watch says it again.
    const second = run(live({ 'deepseek-acme': { status: 'blocked', screen: ASKED_OLDER } }), memory, 2 * MIN);
    expect(second.reports).toHaveLength(1);
    expect(second.reports[0]!.text).toContain(ASKED_OLDER_TEXT);
  });

  test('codex’s plan approval and question read the same from the plain and the styled capture', () => {
    for (const [screen, kind, text] of [
      [CODEX_PLAN, 'plan approval', CODEX_PLAN_TEXT],
      [CODEX_PLAN_ANSI, 'plan approval', CODEX_PLAN_TEXT],
      [CODEX_ASKED, 'question', CODEX_ASKED_TEXT],
      [CODEX_ASKED_ANSI, 'question', CODEX_ASKED_TEXT],
    ] as [string, 'plan approval' | 'question', string][]) {
      expect(readScreen('codex', screen).kind).toBe(kind);
      expect(questionText('codex', screen)).toBe(text);
      // One read gives the kind and the question together, the shape the status adapter uses.
      expect(readDialog('codex', screen)).toEqual({ dialog: kind, text, complete: true });
    }
    // The composer and a running turn around the same profile stay what they were: neither draws
    // a question, and the approval dialog's footer (`esc to interrupt` is the working row's own
    // phrase) is read from the dialog's header, not a working line.
    for (const screen of [CODEX_IDLE, CODEX_WORKING]) {
      expect(readDialog('codex', screen)).toEqual({ dialog: null });
      expect(attentionOf(readScreen('codex', screen), 'idle', true)).toBeNull();
    }
  });

  test('every CLI the team runs reads its dialog kind and its question off the capture', () => {
    const scenes: [string, string, string, string][] = [
      ['claude-code', ASKED, 'question', ASKED_TEXT],
      ['cursor', CURSOR_ASKED, 'question', 'Which option do you want?'],
      ['cursor', CURSOR_SWITCH, 'confirmation', SWITCH_TEXT],
      ['codex', CODEX_ASKED, 'question', CODEX_ASKED_TEXT],
      ['codex', CODEX_PLAN, 'plan approval', CODEX_PLAN_TEXT],
      ['gemini', GEMINI_ASKED, 'question', 'Which profile target should we validate first?'],
      ['grok', GROK_ASKED, 'question', 'Which name do you choose?'],
      ['antigravity', AGY_ASKED, 'question', 'Do you prefer alpha or beta?'],
      ['antigravity', AGY_UNSENT, 'confirmation', UNSENT_TEXT],
    ];
    for (const [cli, screen, kind, text] of scenes) {
      expect(readScreen(cli, screen).kind).toBe(kind as ReturnType<typeof readScreen>['kind']);
      expect(attentionOf(readScreen(cli, screen), 'blocked', false)).toBe(kind as ReturnType<typeof attentionOf>);
      expect(questionText(cli, screen)).toBe(text);
      // The check says the same line for each CLI: the kind and the question it placed.
      const said = kind === 'question' ? 'worker-1 asked a question' : `worker-1 waits at a ${kind} prompt`;
      expect(attention.run(observation({ cli, attention: attentionOf(readScreen(cli, screen), 'blocked', false), dialogText: questionText(cli, screen) }), ctx)[0]!.text)
        .toBe(`${said} — "${text}": the operator's to act on`);
    }
  });
});

describe('the status engine carries the question in its at-prompt event', () => {
  test('a blocked seat at a plan approval: the lead and operator hear what it waits on', async () => {
    let clock = 1_700_000_000_000;
    const engine = createSeatStatusEngine({
      team: team(),
      source: {
        async waitStatus() {
          return { outcome: 'timeout', at: clock };
        },
        promptReading() {
          return { kind: 'plan approval', text: PLAN_TEXT };
        },
      },
      now: () => clock,
      graceMs: 120_000,
    });
    const step = await engine.observe('deepseek-acme', 'blocked', clock);
    expect(step.events).toHaveLength(1);
    const event = step.events[0]!.input;
    expect(event.kind).toBe('seat.at-prompt');
    expect(event.prompt).toBe('plan approval');
    expect(event.reason).toBe(`deepseek-acme waits at a plan approval prompt — "${PLAN_TEXT}"`);
    expect(step.events[0]!.recipients).toEqual(new Set(['claude-coordinator-acme', 'claude-operator-acme']));
  });
});

describe('the report reaches the bus as an at-prompt with the dialog’s name', () => {
  test('a plan approval report is a seat.at-prompt for the parsed seat, not a seat.blocked', () => {
    const event = watchReportEvent({ key: 'plan approval:deepseek-acme:0123456789ab', text: 'x' }, 'acme', '2026-11-01T12:00:00.000Z');
    expect(event).toMatchObject({ kind: 'seat.at-prompt', seat: 'deepseek-acme', subject: 'deepseek-acme', prompt: 'plan approval' });
    expect(watchReportEvent({ key: 'confirmation:deepseek-acme:0123456789ab', text: 'x' }, 'acme', '2026-11-01T12:00:00.000Z'))
      .toMatchObject({ kind: 'seat.at-prompt', prompt: 'confirmation' });
    expect(watchReportEvent({ key: 'question:deepseek-acme:0123456789ab', text: 'x' }, 'acme', '2026-11-01T12:00:00.000Z'))
      .toMatchObject({ kind: 'seat.at-prompt', prompt: 'question' });
  });
});

describe('the attention check says each dialog in its own words', () => {
  test('a plan approval, a confirmation and a question, each with its text', () => {
    const scenes: [SeatObservation['attention'], string, string, string][] = [
      ['plan approval', PLAN_TEXT, 'plan approval', `worker-1 waits at a plan approval prompt — "${PLAN_TEXT}": the operator's to act on`],
      ['confirmation', HELD_TEXT, 'confirmation', `worker-1 waits at a confirmation prompt — "${HELD_TEXT}": the operator's to act on`],
      ['question', ASKED_TEXT, 'question', `worker-1 asked a question — "${ASKED_TEXT}": the operator's to act on`],
    ];
    for (const [kind, text, prefix, said] of scenes) {
      const report = attention.run(observation({ attention: kind, dialogText: text }), ctx)[0]!;
      expect(report.key).toMatch(new RegExp(`^${prefix}:worker-1:[0-9a-f]{12}$`));
      expect(report.text).toBe(said);
      expect(report.to).toBe('operator');
      // The same dialog is named the same occurrence; a different question is a different one.
      const again = attention.run(observation({ attention: kind, dialogText: text }), ctx)[0]!;
      expect(again.key).toBe(report.key);
      const other = attention.run(observation({ attention: kind, dialogText: `${text} (again)` }), ctx)[0]!;
      expect(other.key).not.toBe(report.key);
    }
  });
});
