// add and up title the workspace with the written label and set display_agent from the
// file's display and effort, not the seat name. The model on the box footer is a separate read.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { statusModelRules } from '../../src/profiles/profile.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-14T12:00:00Z');
const LABEL = 'Lead · first assistant';
const DISPLAY = 'Grok 4.7 high';

function teamYaml(irisStopped: boolean): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: first assistant
    name: iris
    label: "${LABEL}"
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    display: Grok 4.7
    effort: high
    launch: grok --model grok-4.7
${irisStopped ? '    stopped: true\n' : ''}`;
}

function trusted(text: string, root: string): string {
  return text.replace('workspace:', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:`);
}

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grok-title-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return { base, root, home };
}

function approve(text: string, root: string, home: string): void {
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(`refused: ${JSON.stringify(loaded.errors)}`);
  writeApproval(storePath(loaded.team.project, root, home), { approval: approvalOf(loaded.team, root, NOW), file: text }, loaded.team.seats, home);
}

function doctor(home: string): DoctorSources {
  return {
    version: (binary) => (binary === 'grok' ? 'grok 1.0.50' : '2.1.288 (Claude Code)'),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function expectTitle(out: string): void {
  expect(out).toContain(`--label '${LABEL}'`);
  expect(out).toContain(`--display-agent '${DISPLAY}'`);
  expect(out).not.toContain('--label iris');
  expect(out).not.toContain("--label 'iris'");
  expect(out).not.toContain('--display-agent iris');
  expect(out).not.toContain("--display-agent 'iris'");
}

const launch: Launch = {
  sessionState: () => 'absent',
  startServer: () => true,
  sessionUp: () => false,
  createWorkspace: () => { throw new Error('a dry run created a workspace'); },
  paneRun: () => { throw new Error('a dry run ran a pane'); },
  renameAgent: () => { throw new Error('a dry run renamed an agent'); },
  closeWorkspace: () => true,
  agentPanes: () => [],
  agents: () => [],
  paneText: () => '',
  foreground: () => [],
  sleep: async () => {},
  now: () => NOW,
};

describe('a grok seat', () => {
  test('the shipped grok profile can read the file model Grok off the screen', () => {
    expect(statusModelRules('grok').some((rule) => rule.yields.includes('Grok'))).toBe(true);
  });

  test('team add titles the workspace with the written label and reports the file\'s display', async () => {
    const { base, root, home } = place();
    approve(trusted(teamYaml(true), root), root, home);
    const io = testIo(root, { kind: 'owner' });
    const code = await runAdd(['iris', '--dry-run', '--file', '.agents/team.yaml'], io, {
      home,
      sessionState: () => 'absent',
      agents: () => [],
      workspaces: () => [],
      doctor: doctor(home),
      now: () => NOW,
      launch,
    } satisfies AddSources);
    expect(code, `${io.out}${io.err}`).toBe(0);
    expectTitle(io.out);
    rmSync(base, { recursive: true, force: true });
  });

  test('team up titles the workspace with the written label and reports the file\'s display', async () => {
    const { base, root, home } = place();
    approve(trusted(teamYaml(false), root), root, home);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--dry-run', '--file', '.agents/team.yaml'], io, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctor(home),
      now: () => NOW,
    } satisfies Partial<UpSources> as UpSources);
    expect(code, `${io.out}${io.err}`).toBe(0);
    expectTitle(io.out);
    rmSync(base, { recursive: true, force: true });
  });
});
