// The herdr title of a seat is derived from the seat's own configuration — its `display`, and
// its `effort` when it has one — never from a hand-written `label:`, which the file still
// accepts so every file written so far loads, checks, approves and runs unchanged. A written
// label repeated the seat's name and drifted ("builder1.Grok7"); herdr already shows the seat's
// name on its own line, so the title must not carry it.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runApprove } from '../src/commands/approve.ts';
import { runDoctor, seatNameFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-12T12:00:00Z');

const minimal = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

// A roster with one seat of each shape the label is derived from: no effort, an effort, a
// display the file writes, a counted entry, a written label that must not decide anything.
const mixed = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: builder1.Grok7
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: researcher
    name: researcher
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    effort: high
    launch: grok --model grok-4.7
  - role: implementer
    name: implementer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol
    launch: codex -m gpt-6-sol
  - role: implementer
    name: maker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
    count: 2
  - role: reviewer
    name: reviewer
    cli: antigravity
    vendor: google
    model: Gemini
    version: "3"
    launch: agy
    stopped: true
`;

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.team;
}

function seatNamed(team: ReturnType<typeof valid>, name: string) {
  const seat = team.seats.find((candidate) => candidate.name === name);
  if (!seat) throw new Error(`fixture has no seat ${name}`);
  return seat;
}

function withLabel(label: string): string {
  return minimal.replace('    launch:', `    label: ${label}\n    launch:`);
}

// Seat digests as the code at origin/main (89e0dfe) wrote them, for the seat of `minimal` with
// the label omitted and with "coordinator" written. An approval recorded before the derived
// label keeps matching the same file after it: these literals are that approval.
const DIGEST_OMITTED = '9680f5f846ed89d816396590ff3883fd44ce864808fabd4c91a0482350db8c1a';
const DIGEST_WRITTEN = '21a216ffade36f87249b66e39ada2b3fdc849a73543e320e3ce5e1a5ceac3e2f';

describe('the derived label of a seat', () => {
  // The title `up` and `add` give the workspace is `workspaceLabel(seat)`; the seat's stored
  // `label` keeps what the file wrote (or the lowercase default) and no longer titles anything.
  test('is the display alone when the seat has no effort, in the display\'s own case', () => {
    expect(workspaceLabel(seatNamed(valid(minimal), 'lead'))).toBe('Claude Opus 5.5');
  });

  test('is the display and the effort, spaced by a middle dot', () => {
    expect(workspaceLabel(seatNamed(valid(mixed), 'researcher'))).toBe('Grok 4.7 · high');
  });

  test('a written label no longer decides the title, and the file still loads', () => {
    const team = valid(withLabel('builder1.Grok7'));
    expect(workspaceLabel(seatNamed(team, 'lead'))).toBe('Claude Opus 5.5');
    expect(team.seats[0]?.label).toBe('builder1.Grok7');
    expect(workspaceLabel(seatNamed(valid(mixed), 'lead'))).toBe('Claude Opus 5.5');
  });

  test('every seat of a mixed roster is titled from its own configuration', () => {
    expect(valid(mixed).seats.map((seat) => [seat.name, workspaceLabel(seat)])).toEqual([
      ['lead', 'Claude Opus 5.5'],
      ['researcher', 'Grok 4.7 · high'],
      ['implementer', 'GPT-6 Sol'],
      ['maker', 'DeepSeek V4.1 Flash'],
      ['maker-2', 'DeepSeek V4.1 Flash'],
      ['reviewer', 'Gemini 3'],
    ]);
  });

  test('carries no seat\'s name and no seat\'s role', () => {
    for (const seat of valid(mixed).seats) {
      const title = workspaceLabel(seat);
      expect(title.includes(seat.name)).toBe(false);
      expect(title.includes(seat.role)).toBe(false);
      expect(title.toLowerCase().includes(seat.name.toLowerCase())).toBe(false);
    }
  });

  // Nothing keys two seats apart by their label: `execute.ts` looks every pane up by the seat's
  // name ("the display label may be shared; the seat's name is the only key"), the waiting proof
  // finds the workspace by its id and then compares the label, and herdr 0.7.1 itself took two
  // `workspace create --label "Grok 4.7 · high"` calls in one scratch session and listed both
  // workspaces side by side (run of 2026-10-12, quoted in the pull request). So a counted entry
  // needs no `-N` on the label: both instances carry the same title.
  test('a counted entry shares one label across its instances, with no number', () => {
    const counted = valid(mixed).seats.filter((seat) => seat.declared === 'maker');
    expect(counted.map((seat) => workspaceLabel(seat))).toEqual(['DeepSeek V4.1 Flash', 'DeepSeek V4.1 Flash']);
  });

  test('a display the file writes is the label verbatim, and still needs the version as its own token', () => {
    expect(workspaceLabel(seatNamed(valid(mixed), 'implementer'))).toBe('GPT-6 Sol');
    const refused = validateTeamFile(minimal.replace('    launch:', '    display: GPT Sol Six\n    launch:'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors.some((error) => error.message.includes('must contain the version'))).toBe(true);
    }
  });

  test('the readme example titles every seat from its display', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const fence = readme.split('```yaml\n')[1]?.split('\n```')[0] ?? '';
    const team = valid(fence);
    expect(team.seats.map((seat) => [seat.name, workspaceLabel(seat)])).toEqual([
      ['coordinator', 'Meridian 1'],
      ['implementer', 'GPT-6 Sol'],
      ['implementer-deepseek', 'DeepSeek V4.1 Flash'],
      ['implementer-deepseek-2', 'DeepSeek V4.1 Flash'],
      ['reviewer', 'Gemini 3'],
    ]);
    expect(seatNameFindings(team, team.session)).toEqual([]);
  });
});

describe('an approval from before the derived label', () => {
  // The record the code at origin/main (89e0dfe) wrote for the file: only the seat digests are
  // pinned, the rest — the sections, the ceilings — the new code recomputes the same.
  function approveAsMain(text: string, seats: Record<string, string>, home: string, root: string) {
    const team = valid(text);
    const approval = approvalOf(team, root, NOW);
    approval.fingerprints = { ...approval.fingerprints, seats };
    writeApproval(storePath(team.project, root, home), { approval, file: text }, team.seats, home);
  }

  const place = () => {
    const base = mkdtempSync(join(tmpdir(), 'team-seat-derived-'));
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    return { base, root, home };
  };

  test('a file that omitted the label keeps the key its approval recorded', () => {
    const { base, root, home } = place();
    writeFileSync(join(root, '.agents/team.yaml'), minimal);
    const team = valid(minimal);
    approveAsMain(minimal, { lead: DIGEST_OMITTED }, home, root);
    expect(approvalDifferences(team, root, home)).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  test('a file that already wrote a label keeps the key its approval recorded', () => {
    const { base, root, home } = place();
    const text = withLabel('coordinator');
    writeFileSync(join(root, '.agents/team.yaml'), text);
    const team = valid(text);
    approveAsMain(text, { lead: DIGEST_WRITTEN }, home, root);
    expect(approvalDifferences(team, root, home)).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('check, approve and up on a file from before the change', () => {
  // `up` refuses a file whose trust is empty or legacy (up.ts:586); the block it prints asks for
  // the lobby under "~" and the project root, absolute — the same shape budget-refusals uses.
  const trusted = (text: string, root: string) =>
    text.replace('workspace:', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:`);

  const place = () => {
    // `/tmp` is a symbolic link on macOS and a trust entry may not cross one.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-commands-')));
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    return { base, root, home };
  };

  const doctor = (home: string): DoctorSources => ({
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  });

  test('team check reads it, team approve re-approves it, and team up plans it, all without the written label', async () => {
    const { base, root, home } = place();
    const text = trusted(withLabel('coordinator'), root);
    writeFileSync(join(root, '.agents/team.yaml'), text);
    const team = valid(text);
    const approval = approvalOf(team, root, NOW);
    approval.fingerprints = { ...approval.fingerprints, seats: { lead: DIGEST_WRITTEN } };
    writeApproval(storePath(team.project, root, home), { approval, file: text }, team.seats, home);

    const check = testIo(root, { kind: 'owner' });
    const checkCode = runTeamCheck({ file: '.agents/team.yaml' }, check, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    // "check must never fail because of a written label" — the exit code is the whole claim; a
    // notice about the field would be the builder's to print, not a failure.
    expect(checkCode, `${check.out}${check.err}`).not.toBe(2);

    const approve = testIo(root, { kind: 'owner' });
    const approveCode = await runApprove(['--file', '.agents/team.yaml'], approve, {
      ask: async () => null,
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approveCode, `${approve.out}${approve.err}`).toBe(0);
    expect(approvalDifferences(valid(text), root, home)).toEqual([]);

    const up = testIo(root, { kind: 'owner' });
    const upCode = await runUp(['--dry-run', '--file', '.agents/team.yaml'], up, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctor(home),
    } satisfies Partial<UpSources> as UpSources);
    expect(upCode, `${up.out}${up.err}`).toBe(0);
    expect(up.out).toContain(`--label 'Claude Opus 5.5'`);
    expect(up.out).not.toContain('--label coordinator');
    rmSync(base, { recursive: true, force: true });
  });

  test('the plan\'s workspace create carries the derived label, and the seat keeps its name for the pane', async () => {
    const { base, root, home } = place();
    const text = trusted(mixed, root);
    writeFileSync(join(root, '.agents/team.yaml'), text);
    const team = valid(text);
    writeApproval(storePath(team.project, root, home), { approval: approvalOf(team, root, NOW), file: text }, team.seats, home);
    const up = testIo(root, { kind: 'owner' });
    const upCode = await runUp(['--dry-run', '--file', '.agents/team.yaml'], up, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctor(home),
    } satisfies Partial<UpSources> as UpSources);
    expect(upCode, `${up.out}${up.err}`).toBe(0);
    expect(up.out).toContain(`--label 'Grok 4.7 · high'`);
    expect(up.out).toContain(`--label 'Claude Opus 5.5'`);
    expect(up.out).toContain('<pane of researcher>');
    expect(up.out).toContain('<pane of maker-2>');
    expect(up.out).not.toContain('builder1.Grok7');
    expect(up.out).not.toContain('--label researcher');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('team doctor', () => {
  const file = `format: 1
project: acme
session: web
coordinator: acme-lead
operator: acme-lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: acme-lead
    label: web-tab
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: reviewer
    name: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

  test('warns once per seat when the name repeats the project or the session, and still exits 0', async () => {
    const base = mkdtempSync(join(tmpdir(), 'team-seat-names-'));
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), file);
    const parsed = validateTeamFile(file);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, root, home), {
      approval: approvalOf(parsed.team, root),
      file,
    }, parsed.team.seats, home);
    const sources: DoctorSources = {
      version: () => '2.1.288 (Claude Code)',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => new Date('2026-10-04T12:00:00Z'),
      home,
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDoctor(['--file', '.agents/team.yaml'], io, sources);
    expect(code).toBe(0);
    // The fixture still spells the lead `coordinator:`, on line 4: doctor prints the file's
    // notice before the seat's own warning, and counts both. The seat's warning reads the
    // stored fields — the name repeats the project "acme", and the written `web-tab`, kept on
    // the seat, repeats the session "web" — while the workspace title, derived from the
    // display, repeats neither.
    expect(io.out).toContain('warn  the file, line 4: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read\n');
    expect(io.out).toContain('warn  acme-lead: its name repeats "acme" and its label repeats "web"; the session already carries it\n');
    expect(io.out).not.toContain('reviewer:');
    expect(io.out).toContain('team doctor: nothing missing, 2 warnings\n');
    rmSync(base, { recursive: true, force: true });
  });
});
