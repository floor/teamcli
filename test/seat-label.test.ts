import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { runDoctor, seatNameFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writeApproval, storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

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

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.team;
}

function withLabel(label: string): string {
  return minimal.replace('    launch:', `    label: ${label}\n    launch:`);
}

describe('a seat label', () => {
  test('defaults to the model and version, in lowercase', () => {
    expect(valid(minimal).seats[0]?.label).toBe('claude opus 5.5');
  });

  test('a label written in the file wins, and a count numbers the default', () => {
    expect(valid(withLabel('coordinator')).seats[0]?.label).toBe('coordinator');
    const counted = valid(`${minimal.replace('coordinator: lead', 'coordinator: lead').replace(
      '    launch: claude --model claude-opus-5-5\n',
      '    label: coordinator\n    launch: claude --model claude-opus-5-5\n  - role: implementer\n    name: maker\n    cli: claude-code\n    vendor: deepseek\n    model: DeepSeek Flash\n    version: "V4.1"\n    launch: team-deepseek\n    count: 2\n',
    )}`);
    expect(counted.seats.map((seat) => [seat.name, seat.label])).toEqual([
      ['lead', 'coordinator'],
      ['maker', 'deepseek flash v4.1'],
      ['maker-2', 'deepseek flash v4.1-2'],
    ]);
  });

  test('an explicit label keeps the fingerprint it had, and dropping the default does not change it', () => {
    const explicit = valid(withLabel('coordinator'));
    expect(fingerprints(explicit).seats.lead).toBe(
      '21a216ffade36f87249b66e39ada2b3fdc849a73543e320e3ce5e1a5ceac3e2f',
    );
    const writtenDefault = fingerprints(valid(withLabel('claude opus 5.5'))).seats.lead;
    const omitted = fingerprints(valid(minimal)).seats.lead;
    expect(omitted).toBe(writtenDefault);
    expect(fingerprints(explicit).seats.lead).not.toBe(omitted);
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

  let root: string;
  let home: string;

  test('warns once per seat when the name or the label repeats the project or the session, and still exits 0', async () => {
    const base = mkdtempSync(join(tmpdir(), 'team-seat-names-'));
    root = join(base, 'acme');
    home = join(base, 'home');
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
    // notice before the seat's own warning, and counts both.
    expect(io.out).toContain('warn  the file, line 4: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read\n');
    expect(io.out).toContain('warn  acme-lead: its name repeats "acme" and its label repeats "web"; the session already carries it\n');
    expect(io.out).not.toContain('reviewer:');
    expect(io.out).toContain('team doctor: nothing missing, 2 warnings\n');
    rmSync(base, { recursive: true, force: true });
  });

  test('the readme example names a seat by its role and leaves the label to the model', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const fence = readme.split('```yaml\n')[1]?.split('\n```')[0] ?? '';
    const team = valid(fence);
    expect(team.seats.map((seat) => seat.name)).toEqual([
      'coordinator',
      'implementer',
      'implementer-deepseek',
      'implementer-deepseek-2',
      'reviewer',
    ]);
    expect(team.seats.map((seat) => seat.label)).toEqual([
      'meridian 1',
      'gpt sol 6',
      'deepseek flash v4.1',
      'deepseek flash v4.1-2',
      'gemini 3',
    ]);
    expect(seatNameFindings(team, team.session)).toEqual([]);
  });
});

describe('the herdr workspace title', () => {
  test('a seat parsed from a file titles to its display — no name, no role, no label', () => {
    const seat = valid(minimal).seats[0]!;
    expect(workspaceLabel(seat)).toBe('Claude Opus 5.5');
  });

  test('a seat that carries an effort is joined to it with a middle dot', () => {
    // No file can set an effort yet — the field's parsing is another change — so the join is
    // pinned here on the function `up` and `add` read, not through a file.
    expect(workspaceLabel({ display: 'Grok 4.7' })).toBe('Grok 4.7');
    expect(workspaceLabel({ display: 'Grok 4.7', effort: 'high' })).toBe('Grok 4.7 · high');
  });
});
