// `watch.checks`: the owner-only section that turns a watch check off. Four checks can't be
// turned off at all (RFC 0002 § 4.2): the schema refuses them, so `team approve` does too, and
// the core holds even for a file that reached memory another way.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, watchInForce } from '../src/approve/approval.ts';
import { compare, describe as describeDifference, fingerprints, OWNER_SECTIONS, WATCH_CHECKS_CHANGED } from '../src/approve/fingerprint.ts';
import { runApprove } from '../src/approve/command.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { readApproval, storePath } from '../src/store/store.ts';
import { ALWAYS_ON, CHECK_NAMES } from '../src/watch/check.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass, SEAT_CHECKS, TEAM_CHECKS } from '../src/watch/pass.ts';
import { testIo, withWas } from './helpers.ts';

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

// The example's watch section, with a `checks` tail written where a real file writes one: after
// `unsent_after`, at the section's own indentation.
const MARK = '  unsent_after: 1m';

function source(tail = ''): string {
  return example.replace(MARK, tail ? `${MARK}\n${tail}` : MARK);
}

function teamFile(tail = ''): TeamFile {
  const result = validateTeamFile(source(tail));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function refused(tail: string) {
  const result = validateTeamFile(source(tail));
  if (result.ok) throw new Error('the file was accepted');
  return result.errors;
}

// The line the tail's offending entry sits on, so a test pins the line number without counting.
const lineOf = (tail: string, entry: string) => source(tail).split('\n').indexOf(entry) + 1;

// Screens of Claude Code, as the live team shows them.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const permission = 'Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n';

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const tight: Machine = { loadPerCore: 6.5, memoryFree: 10, diskFree: 5e9, swapTotal: 23.3e9, swapFree: 0.3e9, swapUsed: 23e9 };

function agent(name: string | null, workspace: string, status: string, kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team, everyone working, the operator at an empty prompt.
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

const texts = (result: { reports: { text: string }[] }) => result.reports.map((report) => report.text);

describe('watch.checks, the section', () => {
  test('is optional, and a file without it turns nothing off', () => {
    expect(teamFile().watch.checks).toEqual([]);
    expect(teamFile('  checks:\n').watch.checks).toEqual([]);
  });

  test('names the checks to turn off, in block or flow form', () => {
    expect(teamFile('  checks:\n    disk: off\n').watch.checks).toEqual(['disk']);
    expect(teamFile('  checks:\n    disk: off\n    memory: off\n').watch.checks).toEqual(['disk', 'memory']);
    expect(teamFile('  checks: { disk: off }\n').watch.checks).toEqual(['disk']);
  });

  test('a name that is not a check is refused, with its line', () => {
    const tail = '  checks:\n    disks: off\n';
    expect(refused(tail)).toEqual([
      { line: lineOf(tail, '    disks: off'), message: `unknown check "disks" in watch.checks: the checks are ${CHECK_NAMES.join(', ')}` },
    ]);
  });

  test.each([...ALWAYS_ON])('%s is refused: it can\'t be turned off, with its line', (name) => {
    const tail = `  checks:\n    ${name}: off\n`;
    expect(refused(tail)).toEqual([
      { line: lineOf(tail, `    ${name}: off`), message: `watch.checks can't turn off ${name}: ${ALWAYS_ON.join(', ')} always run` },
    ]);
  });

  test('the only setting is off', () => {
    for (const value of ['on', 'true', '1']) {
      const tail = `  checks:\n    disk: ${value}\n`;
      expect(refused(tail)).toEqual([
        { line: lineOf(tail, `    disk: ${value}`), message: 'watch.checks.disk must be off: the only setting is off' },
      ]);
    }
  });

  test('the section itself is a map', () => {
    expect(refused('  checks: [disk]\n')).toEqual([
      { line: lineOf('  checks: [disk]\n', '  checks: [disk]'), message: 'watch.checks must be a map: a check named, and set off' },
    ]);
  });

  test('every registered check is named, and the six always-on ones are the RFC\'s', () => {
    expect([...new Set(CHECK_NAMES)]).toEqual([...CHECK_NAMES]);
    expect([...SEAT_CHECKS, ...TEAM_CHECKS].map((check) => check.name)).toEqual([...CHECK_NAMES]);
    expect([...ALWAYS_ON].sort()).toEqual(['approval', 'attention', 'missing', 'model-drift', 'model-rule', 'prompt-escalation']);
    for (const name of ALWAYS_ON) expect(CHECK_NAMES).toContain(name as (typeof CHECK_NAMES)[number]);
  });
});

describe('a pass with checks turned off', () => {
  // The file's checks are in effect once the owner has approved them: the approval says so.
  const APPROVED: string[] = [];

  test('a disabled check reports nothing; the others report as usual', () => {
    expect(texts(pass({ team: teamFile(), watch: teamFile().watch, state: emptySession(), live: live(), machine: tight, now: 0, memory: newMemory(), approval: APPROVED }))).toEqual([
      'the load is 6.5 per core, above 6',
      'free memory is 10%, below 15%',
      'free disk is 5.0 GB, below 10.0 GB',
      'free swap is 0.3 GB, below 2.0 GB',
    ]);
    const off = teamFile('  checks:\n    disk: off\n');
    expect(texts(pass({ team: off, watch: off.watch, state: emptySession(), live: live(), machine: tight, now: 0, memory: newMemory(), approval: APPROVED }))).toEqual([
      'the load is 6.5 per core, above 6',
      'free memory is 10%, below 15%',
      'free swap is 0.3 GB, below 2.0 GB',
    ]);
    const both = teamFile('  checks:\n    disk: off\n    memory: off\n');
    expect(texts(pass({ team: both, watch: both.watch, state: emptySession(), live: live(), machine: tight, now: 0, memory: newMemory(), approval: APPROVED }))).toEqual([
      'the load is 6.5 per core, above 6',
      'free swap is 0.3 GB, below 2.0 GB',
    ]);
  });

  test('the list in force is what turns a check off, even while `watch.checks` is the difference', () => {
    const off = teamFile('  checks:\n    disk: off\n');
    const reported = (approval: string[] | null) => texts(pass({
      team: off, watch: off.watch, state: emptySession(), live: live(), machine: tight, now: 0, memory: newMemory(), approval,
    }));
    // The caller passed this file's own list. Naming the checks as a difference does not turn
    // that list back on: disk stays off, and the difference is still the owner's to answer.
    expect(reported([WATCH_CHECKS_CHANGED])).not.toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(reported([WATCH_CHECKS_CHANGED])).toContain('the file has changed since the last approval: `watch.checks` changed');
    // A file that was never approved turns nothing off, and is no report of its own — the
    // difference above is the reading's, not the watch's.
    expect(reported(null)).toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(reported(null)).not.toContain('the file was never approved on this machine');
    // Approved: the check is off. A difference in another section leaves the list in force off.
    expect(reported(APPROVED)).not.toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(reported(['`rules` changed'])).not.toContain('free disk is 5.0 GB, below 10.0 GB');
  });

  test('a check turned off and back on reports again: its condition cleared while it was off', () => {
    const memory = newMemory();
    const off = teamFile('  checks:\n    disk: off\n');
    expect(texts(pass({
      team: off, watch: off.watch, state: emptySession(), live: live(), machine: tight, now: 0, memory, approval: APPROVED,
    }))).not.toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(texts(pass({
      team: teamFile(), watch: teamFile().watch, state: emptySession(), live: live(), machine: tight, now: 60_000, memory, approval: APPROVED,
    }))).toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(texts(pass({
      team: off, watch: off.watch, state: emptySession(), live: live(), machine: tight, now: 2 * 60_000, memory, approval: APPROVED,
    }))).not.toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(texts(pass({
      team: teamFile(), watch: teamFile().watch, state: emptySession(), live: live(), machine: tight, now: 3 * 60_000, memory, approval: APPROVED,
    }))).toContain('free disk is 5.0 GB, below 10.0 GB');
  });

  test('a cached reading carrying a point moves no report of the pass', () => {
    // § 5: this file pins the pass's texts; a cache whose own reading carries a point leaves
    // every one of them — and the budget line the cached figure itself drives — as it was. The
    // point rides the reading the pass carries forward, and reaches no report.
    const marks = '  marks: [50, 75, 90]          # percent used, per account and window';
    const text = source().replace(marks, `${marks}\n  accounts:\n    openai: { kind: subscription, reserve: 20%, sources: [status_line] }\n`);
    const parsed = validateTeamFile(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const cached = {
      account: 'openai', window: 'weekly' as const, left: 5, used: 95,
      changedAt: 5 * 60_000, resetsAt: 60 * 60_000,
      seat: 'codex-acme', source: 'status_line' as const, confirmed: true,
    };
    const run = (points: boolean) => texts(pass({
      team: parsed.team, watch: parsed.team.watch, state: emptySession(), live: live(), machine: tight,
      now: 10 * 60_000, memory: newMemory(), approval: APPROVED,
      readings: [points ? withWas(cached) : cached],
    }));
    const plain = run(false);
    // Non-vacuity: the cached reading's own figure drives a line this pass prints, the point
    // beside it is real and distinct from the figure, and the machine's checks still report.
    expect(plain).toContain('openai weekly left 5%, inside its 20% reserve');
    expect(plain).toContain('free disk is 5.0 GB, below 10.0 GB');
    expect(withWas(cached).was).toEqual({ left: 12, at: -25 * 60_000 });
    expect(run(true)).toEqual(plain);
  });

  test('the six always-on checks run for a file that lists them anyway', () => {
    // Only a hand-made file can list them: the schema refuses them, and approve validates. The
    // core holds regardless — the off list is in effect here, and they still run.
    const smuggled = teamFile();
    smuggled.watch.checks = [...ALWAYS_ON];
    const now = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    now.agents = now.agents.filter((one) => one.name !== 'deepseek-acme-2');
    now.screens['w1:p1'] = busy.replace('Opus 5.5', 'Fable 5.1');
    const reported = texts(pass({ team: smuggled, watch: smuggled.watch, state: emptySession(), live: now, machine: fine, now: 0, memory: newMemory(), approval: ['`rules` changed'] }));
    expect(reported).toContain('deepseek-acme-2 is in the file and is not running');
    expect(reported).toContain('claude-coordinator-acme runs Claude Fable 5.1; the registry says Claude Opus 5.5: it signs with the wrong model — team down, then team up (to restart the whole team)');
    expect(reported).toContain("deepseek-acme waits at a permission prompt: its owner's to answer");
    expect(reported).toContain('the file has changed since the last approval: `rules` changed');
  });
});

describe('watch.checks and the approval', () => {
  test('turning a check off is a section of its own', () => {
    expect(OWNER_SECTIONS).toContain('watch.checks');
    const before = fingerprints(teamFile());
    const after = fingerprints(teamFile('  checks:\n    disk: off\n'));
    expect(after.sections['watch.checks']).not.toBe(before.sections['watch.checks']);
    expect(compare(before, after)).toEqual([{ kind: 'section', name: 'watch.checks' }]);
    // The line the approval report prints. pass does not read it; the list in force does.
    expect(compare(before, after).map(describeDifference)).toEqual([WATCH_CHECKS_CHANGED]);
  });

  test('an approval recorded before the section existed turns nothing off', () => {
    const current = fingerprints(teamFile());
    const old = { sections: { ...current.sections }, seats: { ...current.seats } };
    delete old.sections['watch.checks'];
    expect(compare(old, current)).toEqual([]);
    expect(compare(old, fingerprints(teamFile('  checks:\n    disk: off\n')))).toEqual([{ kind: 'section', name: 'watch.checks' }]);
  });
});

describe('team approve and watch.checks', () => {
  let base: string;
  let root: string;
  let home: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-checks-')));
    root = join(base, 'acme-web');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const write = (text: string) => writeFileSync(join(root, '.agents/team.yaml'), text);

  async function approve() {
    const io = testIo(root, { kind: 'owner' });
    const code = await runApprove(['--file', '.agents/team.yaml'], io, {
      ask: async () => '6',
      waiting: () => 'empty',
      now: () => new Date('2026-10-04T00:00:00Z'),
      home,
    });
    return { code, err: io.err };
  }

  test('a file that turns off one of the six is refused, and nothing is written', async () => {
    write(source('  checks:\n    attention: off\n'));
    const run = await approve();
    expect(run.code).toBe(2);
    expect(run.err).toContain(`line ${lineOf('  checks:\n    attention: off\n', '    attention: off')}: watch.checks can't turn off attention`);
    expect(existsSync(storePath('acme-web', root, home))).toBe(false);
  });

  test('a name that is not a check stops the approval with its line', async () => {
    write(source('  checks:\n    disks: off\n'));
    const run = await approve();
    expect(run.code).toBe(2);
    expect(run.err).toContain('unknown check "disks" in watch.checks');
    expect(readApproval(storePath('acme-web', root, home))).toBeNull();
  });

  test('a live checks: { idle: off } edit takes effect immediately', async () => {
    write(source());
    expect((await approve()).code).toBe(0);
    write(source('  checks:\n    idle: off\n'));
    const edited = teamFile('  checks:\n    idle: off\n');
    // The real approval, not a list built by hand: a checks-only edit is this one line.
    expect(approvalDifferences(edited, root, home)).toEqual([WATCH_CHECKS_CHANGED]);
    const inForce = watchInForce(edited, root, home);
    expect(inForce.checks).toEqual(['idle']);
    expect(inForce.idleFirst).toBe(edited.watch.idleFirst);
    const quiet = live({ 'deepseek-acme': { status: 'done', screen: idle } });
    const memory = newMemory();
    const at = (minute: number) => texts(pass({
      team: edited, state: emptySession(), live: quiet, machine: fine, now: minute * 60_000, memory,
      approval: approvalDifferences(edited, root, home), watch: inForce,
    }));
    expect(at(0)).toContain('the file has changed since the last approval: `watch.checks` changed');
    expect(at(10)).not.toContain('deepseek-acme has been idle since the watch started');
  });

  test('an approved check stays off when a later edit adds another', async () => {
    write(source('  checks:\n    disk: off\n'));
    expect((await approve()).code).toBe(0);
    const edited = teamFile('  checks:\n    disk: off\n    idle: off\n');
    const inForce = watchInForce(edited, root, home);
    expect(inForce.checks).toEqual(['disk', 'idle']);
    const reported = texts(pass({
      team: edited, state: emptySession(), live: live(), machine: tight, now: 0, memory: newMemory(),
      approval: approvalDifferences(edited, root, home), watch: inForce,
    }));
    expect(reported).toContain('the file has changed since the last approval: `watch.checks` changed');
    expect(reported).not.toContain('free disk is 5.0 GB, below 10.0 GB');
  });

  test('a check turned off approves, and editing it later is the owner\'s difference', async () => {
    write(source('  checks:\n    disk: off\n'));
    expect((await approve()).code).toBe(0);
    const same = validateTeamFile(readFileSync(join(root, '.agents/team.yaml'), 'utf8'));
    if (!same.ok) throw new Error(JSON.stringify(same.errors));
    expect(approvalDifferences(same.team, root, home)).toEqual([]);
    const edited = teamFile('  checks:\n    disk: off\n    memory: off\n');
    expect(approvalDifferences(edited, root, home)).toEqual(['`watch.checks` changed']);
  });
});

describe('a seat stopped on a provider error or a rate limit', () => {
  const lost = `API Error: Connection lost mid-response. The response above may be incomplete.\n${idle}`;
  // The wall's own frame: the rejected line sits directly above the box, as the capture draws
  // it. A later turn row between the two is a quote of the wall, not the wall.
  const limit = `● Done.\n\nAPI Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
  const team = () => teamFile();
  const run = (memory: ReturnType<typeof newMemory>, now: number, screen: string) => texts(pass({
    team: team(),
    watch: team().watch,
    state: emptySession(),
    live: live({ 'deepseek-acme': { status: 'done', screen } }),
    machine: fine,
    now,
    memory,
    approval: [],
  }));

  test('is reported once to the operator and the owner, and is not called idle', () => {
    const memory = newMemory();
    const first = run(memory, 0, lost);
    expect(first.filter((line) => line.includes('provider error'))).toEqual([
      'deepseek-acme shows a provider error: connection lost, and no capture names a retry',
      'deepseek-acme shows a provider error: connection lost, and no capture names a retry',
    ]);
    expect(first.some((line) => line.includes('has been idle'))).toBe(false);
    // Long enough that an idle seat would have been reported. This one is a prompt.
    expect(run(memory, 11 * 60_000, lost).some((line) => line.includes('has been idle') || line.includes('provider error'))).toBe(false);
  });

  test('a rate limit carries the reset time, and leaving the screen clears the report', () => {
    const memory = newMemory();
    // The pool is the account the seat spends: its own `account:` when the file names one, its
    // vendor otherwise — deepseek-acme has none, so its vendor.
    expect(run(memory, 0, limit)).toContain('deepseek-acme is out of quota on deepseek: usage limit, resets at 11:00');
    expect(run(memory, 11 * 60_000, idle).some((line) => line.includes('rate limit'))).toBe(false);
    expect(run(memory, 12 * 60_000, limit)).toContain('deepseek-acme is out of quota on deepseek: usage limit, resets at 11:00');
  });
});

describe('a label change is not a check', () => {
  test('a screen that would change the label still produces only the model-drift report', () => {
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8');
    const scene = live({ 'codex-acme': { status: 'working', screen } });
    const result = pass({ team: teamFile(), watch: teamFile().watch, state: emptySession(), live: scene, machine: fine, now: 0, memory: newMemory() });
    expect(result.reports.map((report) => report.text)).toEqual([
      'codex-acme runs GPT Terra 5.6; the registry says GPT Sol 6: it signs with the wrong model — team remove codex-acme --keep, then team add codex-acme',
    ]);
    expect(result.labels.find((label) => label.name === 'codex-acme')?.displayAgent).toBe('GPT Terra 5.6 medium');
    expect(result.reports.some((report) => report.text.includes('display'))).toBe(false);
  });
});
