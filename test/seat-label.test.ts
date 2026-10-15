// Line 1 is the seat's written label, or `<name> · <role>` when the file writes none. The
// stored label (written, or the lowercase model and version) stays what the seat digest hashes.
// Line 2 is `displayAgent`: the display, a space, and the effort, or `default` when the file sets none.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runApprove } from '../src/approve/command.ts';
import { runDoctor, seatNameFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
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

// A roster with one seat of each shape: a written label, no label, a display the file writes,
// a counted entry, and a stopped seat.
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

describe('the workspace title of a seat', () => {
  test('a seat with no written label is titled with its name and role', () => {
    expect(workspaceLabel(seatNamed(valid(minimal), 'lead'))).toBe('lead · coordinator');
  });

  test('line 2 is the display, a space, and the effort or default', () => {
    expect(displayAgent({ display: 'Grok 4.7', effort: 'high' })).toBe('Grok 4.7 high');
    expect(displayAgent(seatNamed(valid(minimal), 'lead'))).toBe('Claude Opus 5.5 default');
  });

  test('a written label titles the workspace, and the file still loads', () => {
    const team = valid(withLabel('builder1.Grok7'));
    expect(workspaceLabel(seatNamed(team, 'lead'))).toBe('builder1.Grok7');
    expect(team.seats[0]?.label).toBe('builder1.Grok7');
    expect(workspaceLabel(seatNamed(valid(mixed), 'lead'))).toBe('builder1.Grok7');
  });

  test('every seat of a mixed roster is titled from its label or its name and role', () => {
    expect(valid(mixed).seats.map((seat) => [seat.name, workspaceLabel(seat)])).toEqual([
      ['lead', 'builder1.Grok7'],
      ['researcher', 'researcher · researcher'],
      ['implementer', 'implementer · implementer'],
      ['maker', 'maker · implementer'],
      ['maker-2', 'maker-2 · implementer'],
      ['reviewer', 'reviewer · reviewer'],
    ]);
  });

  test('line 1 never carries the model', () => {
    for (const seat of valid(mixed).seats) {
      const title = workspaceLabel(seat);
      expect(title.includes(seat.model)).toBe(false);
      expect(title.includes(seat.display)).toBe(false);
    }
  });

  // A counted entry's instances must not share line 1. With no written label the names already
  // differ; a written label keeps the `-<n>` the stored label has always carried.
  test('a counted entry gives each instance its own line 1', () => {
    const counted = valid(mixed).seats.filter((seat) => seat.declared === 'maker');
    expect(counted.map((seat) => workspaceLabel(seat))).toEqual(['maker · implementer', 'maker-2 · implementer']);
  });

  // The stored `label` — the one `seatDigest` hashes, not the title — keeps the `-N` a counted
  // entry's instances have always carried, so an approval recorded before the derived label
  // still keys the instances apart. The title above shares one string; this field does not,
  // whether it is the lowercase default or a word the file writes.
  test('the stored label of a counted entry keeps its instance suffix', () => {
    const counted = valid(mixed).seats.filter((seat) => seat.declared === 'maker');
    expect(counted.map((seat) => seat.label)).toEqual(['deepseek flash v4.1', 'deepseek flash v4.1-2']);
    const written = valid(mixed.replace('    count: 2', '    label: desk\n    count: 2'));
    expect(written.seats.filter((seat) => seat.declared === 'maker').map((seat) => seat.label)).toEqual(['desk', 'desk-2']);
  });

  test('a display the file writes is line 2, and still needs the version as its own token', () => {
    expect(displayAgent(seatNamed(valid(mixed), 'implementer'))).toBe('GPT-6 Sol default');
    expect(workspaceLabel(seatNamed(valid(mixed), 'implementer'))).toBe('implementer · implementer');
    const refused = validateTeamFile(minimal.replace('    launch:', '    display: GPT Sol Six\n    launch:'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors.some((error) => error.message.includes('must contain the version'))).toBe(true);
    }
  });

  test('the readme example titles every seat from its name and role', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const fence = readme.split('```yaml\n')[1]?.split('\n```')[0] ?? '';
    const team = valid(fence);
    expect(team.seats.map((seat) => [seat.name, workspaceLabel(seat)])).toEqual([
      ['coordinator', 'coordinator · coordinator'],
      ['implementer', 'implementer · implementer'],
      ['implementer-deepseek', 'implementer-deepseek · implementer'],
      ['implementer-deepseek-2', 'implementer-deepseek-2 · implementer'],
      ['reviewer', 'reviewer · reviewer'],
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
    expect(up.out).toContain('--label coordinator');
    expect(up.out).toContain(`--display-agent 'Claude Opus 5.5 default'`);
    expect(up.out).not.toContain(`--label 'Claude Opus 5.5'`);
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
    expect(up.out).toContain('--label builder1.Grok7');
    expect(up.out).toContain(`--label 'researcher · researcher'`);
    expect(up.out).toContain(`--display-agent 'Grok 4.7 default'`);
    expect(up.out).toContain(`--display-agent 'GPT-6 Sol default'`);
    expect(up.out).toContain(`--display-agent 'DeepSeek V4.1 Flash default'`);
    expect(up.out).toContain('<pane of researcher>');
    expect(up.out).toContain('<pane of maker-2>');
    expect(up.out).not.toContain(`--label 'Claude Opus 5.5'`);
    expect(up.out).not.toContain(`--label 'Grok 4.7'`);
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
