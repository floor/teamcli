import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';

// The watch page's row for "is no longer the process team launched" explains the check in three
// promises: what reports (no CLI, or an unlaunched program whose agent session is not the stored
// one), what stays silent (the stored session came back), and what is never reported (no launch
// record, or a pane herdr can't read). These tests hold the page to the binary's own behaviour:
// each promise must name an arm the check really has, and the session-mismatch reading the page
// newly describes must report exactly as the page says.

const PAGE = readFileSync(new URL('../docs/commands/watch.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const RESTORED_SRC = readFileSync(new URL('../src/watch/checks/restored.ts', import.meta.url), 'utf8');
const IDENTITY_SRC = readFileSync(new URL('../src/launch/identity.ts', import.meta.url), 'utf8');

// The report line the check emits, with the seat's name as the page's `<seat>` placeholder.
const template = RESTORED_SRC.match(/ctx\.once\(\s*key,\s*`([^`]+)`/)?.[1] ?? '';

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
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

// The example's team as the watch reads it: everyone working, the seat under test in w3:p1.
function live(): Live {
  const seats: [string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle'],
    ['claude-coordinator-acme', 'w1', 'working'],
    ['codex-acme', 'w2', 'working'],
    ['deepseek-acme', 'w3', 'working'],
    ['deepseek-acme-2', 'w4', 'working'],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status] of seats) {
    const agent: HerdrAgent = { name, agent: name.startsWith('codex') ? 'codex' : 'claude', pane: `${workspace}:p1`, workspace, status, cwd: null };
    agents.push(agent);
    screens[`${workspace}:p1`] = name === 'claude-operator-acme' ? idle : busy;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('the restored row of the watch page', () => {
  test('the page keeps all three promises of the row, word for word', () => {
    // What reports: the pane runs no CLI, or an unlaunched program the stored session does not tie.
    expect(PAGE.includes('the pane runs no CLI, or a program `team` did not launch runs in it and the agent session herdr shows there is not the one stored at launch.'), 'the row lost its report conditions').toBe(true);
    // What stays silent: the stored session came back.
    expect(PAGE.includes('A pane the stored session came back on is the seat again and is not reported;'), 'the row lost its restored clause').toBe(true);
    // What is never reported: no launch record, or a pane herdr can't read.
    expect(PAGE.includes('a seat with no record of its launch, or a pane herdr can\'t read, is not reported either'), 'the row lost its never-reported clause').toBe(true);
  });

  test('the row’s `<seat>` cell is the line the check itself emits, placeholder for placeholder', () => {
    expect(template, 'the check no longer builds its line from the seat name').toMatch(/^\$\{seat\.name\} /);
    const tail = template.replace(/^\$\{seat\.name\} /, '');
    expect(PAGE.includes(`<seat> ${tail}`), 'the page’s report cell drifted from the check’s own line').toBe(true);
  });

  test('each promise names an arm the check really has, in the order the page tells them', () => {
    // The stored session came back: the generic line's arm is gated on it — the seat is the
    // seat again, and only a mismatch that is not a return may report.
    expect(RESTORED_SRC.includes('if (seat.continuity !== \'restored\' && (seat.identity === \'gone\' || seat.identity === \'replaced\')) {'), 'the restored clause has no arm in the check').toBe(true);
    // A pane herdr can't read is not merely silent: the mark survives the failed read, for
    // the generic line and the launcher flag alike.
    expect(RESTORED_SRC.match(/if \(seat\.identity === 'unknown'\) \{\s*ctx\.keep\(key\);\s*ctx\.keep\(launchKey\);\s*return \[\];\s*\}/), 'the can’t-read clause no longer keeps the report-once mark').not.toBeNull();
    // "no record of its launch" and "no CLI"/"a program team did not launch" are the verdict's
    // own arms, not watch-page inventions.
    expect(IDENTITY_SRC.includes('if (!recorded || !pane || pane.foreground.length === 0) return \'unknown\';'), 'no-record no longer reads as unknown').toBe(true);
    expect(IDENTITY_SRC.includes('if (paneHoldsShell(pane)) return \'gone\';'), 'no-CLI no longer reads as gone').toBe(true);
    expect(IDENTITY_SRC.includes('return \'replaced\';'), 'an unlaunched program no longer reads as replaced').toBe(true);
  });

  test('a session mismatch the row describes reports, goes silent when the stored one returns, and reports anew after', () => {
    // The exact reading the row's first promise names: a program team did not launch holds the
    // pane, and the agent session herdr shows is not the one stored at launch.
    const state = emptySession();
    state.seats['deepseek-acme'] = { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 400, cli: [401] }, agent_session: 'kept' };
    const seen = live();
    const seat = seen.agents.find((agent) => agent.name === 'deepseek-acme')!;
    const memory = newMemory();
    const at = (liveSession: string) => {
      seat.session = liveSession;
      return pass({ team: team(), watch: team().watch, state, live: seen, machine: fine, now: 0, memory, processes: { 'w3:p1': { shell: 500, foreground: [501] } } }).reports.map((report) => report.text);
    };
    const restored = 'deepseek-acme is no longer the process team launched (its session was restored, or its CLI was restarted)';
    const launcher = 'deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched — team restart deepseek-acme';
    // Another session under an unlaunched program: the mismatch the page describes, reported —
    // and a launch line that names a launcher (this seat's is `team-deepseek`) is still said
    // beside it, in the order the check pushes them.
    expect(at('other')).toEqual([restored, launcher]);
    // The stored session back on the pane: the seat again, not reported — and the generic mark
    // released, for the next mismatch to be a new change.
    expect(at('kept')).toEqual([]);
    // The new mismatch reports the generic line again: its condition broke when the stored
    // session returned. The launcher flag stays quiet — the pane still never held the process
    // team launched, so its condition never cleared and its report-once mark never released.
    expect(at('other')).toEqual([restored]);
  });
});
