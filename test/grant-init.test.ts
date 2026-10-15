import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { runInit } from '../src/commands/init.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { grantGate } from '../src/grant.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const noLogin = { loggedIn: () => false };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function teamFile(root: string, scope: string[] | null = ['init']): string {
  const grantBlock = scope === null
    ? ''
    : `grant:\n  session: acme\n  seat: lead\n  scope:\n${scope.map((item) => `    - ${item}`).join('\n')}\n`;
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
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
${grantBlock}`;
}

let base: string;
let home: string;
let project: string;

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'acme\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'first');
}

function approveRepo(root: string, text: string): string {
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
  return file;
}

function recordSeat(root: string, pane = 'lead-pane', launchedFile?: string): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    if (launchedFile) session.launched_file = launchedFile;
    session.seats.lead = { stage: 'ready', pane };
  });
}

const leadSeat: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' };
const otherSeat: Caller = { kind: 'seat', name: 'worker', pane: 'worker-pane', session: 'acme' };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-init-')));
  home = join(base, 'home');
  project = join(base, 'acme');
  mkdirSync(home);
  makeRepo(project);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('grant-gated team init', () => {
  test('the granted seat restores a removed team file, logs the grant line, and leaves approval verified', async () => {
    const text = teamFile(project, ['init']);
    const file = approveRepo(project, text);
    recordSeat(project, 'lead-pane', file);
    rmSync(file);

    const io = testIo(project, leadSeat);
    const code = await runInit(['--restore'], io, home, undefined, noLogin);
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('Restored .agents/team.yaml from the copy you last approved on this machine.');
    expect(readFileSync(file, 'utf8')).toBe(text);

    const log = readFileSync(join(project, '.agents', 'team.log'), 'utf8');
    expect(log).toMatch(/ grant \[grant\] lead init\n/);
    expect(log).toMatch(/ init \[lead\] restored the approved copy as \.agents\/team\.yaml/);
    expect(approvalStanding(project, home).kind).toBe('verified');
  });

  test('the granted seat writes a skeleton when the team file was removed and never signs the skeleton', async () => {
    const text = teamFile(project, ['init']);
    const file = approveRepo(project, text);
    recordSeat(project, 'lead-pane', file);
    rmSync(file);

    const before = approvalStanding(project, home);
    expect(before.kind).toBe('verified');

    const io = testIo(project, leadSeat);
    const code = await runInit([], io, home, undefined, noLogin);
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('Wrote .agents/team.yaml: a skeleton with one seat.');
    expect(io.out).toContain('team approve');

    expect(existsSync(file)).toBe(true);
    const loaded = loadTeamFile(project, { file, home });
    expect(loaded.ok).toBe(true);

    // Grant-gated init never re-signs or overwrites the approval record.
    expect(approvalStanding(project, home)).toEqual(before);

    const log = readFileSync(join(project, '.agents', 'team.log'), 'utf8');
    expect(log).toMatch(/ grant \[grant\] lead init\n/);
    expect(log).toMatch(/ init \[lead\] wrote a skeleton as \.agents\/team\.yaml/);
  });

  test('without a grant block, a non-owner caller is refused with init.not-owner', async () => {
    approveRepo(project, teamFile(project, null));
    recordSeat(project);
    rmSync(join(project, '.agents', 'team.yaml'));

    const io = testIo(project, leadSeat);
    const code = await runInit(['--restore'], io, home, undefined, noLogin);
    expect(code).toBe(1);
    expect(io.err).toBe('team init: only the owner runs init, from a terminal outside herdr; this call is lead\n');
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('every grant refusal stops init before writing .agents/team.yaml or .agents/team.log', async () => {
    // 1. Unapproved grant (init.grant-approval)
    mkdirSync(join(project, '.agents'), { recursive: true });
    writeFileSync(join(project, '.agents', 'team.yaml'), teamFile(project, ['init']));
    {
      const io = testIo(project, leadSeat);
      expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
      expect(io.err).toBe(
        'team init: a grant needs a verified approval: the file was never approved on this machine: run `team approve`\n',
      );
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }

    // 2. Unreadable approved copy (init.grant-approved-copy)
    approveRepo(project, teamFile(project, ['init']));
    recordSeat(project);
    {
      const io = testIo(project, leadSeat);
      const code = await runInit([], io, home, undefined, {
        ...noLogin,
        grantGate: (input) => grantGate({ ...input, sources: { approvedCopy: () => null } }),
      });
      expect(code).toBe(1);
      expect(io.err).toBe('team init: a grant needs a readable approved copy: run `team approve`\n');
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }

    // 3. Drifted file (init.grant-drift)
    writeFileSync(
      join(project, '.agents', 'team.yaml'),
      teamFile(project, ['init']).replace('label: lead', 'label: renamed'),
    );
    {
      const io = testIo(project, leadSeat);
      expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
      expect(io.err).toContain('team init: a grant needs the approved file: the file is not the approved one');
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }

    // Restore approved file on disk for caller/pane/scope checks
    approveRepo(project, teamFile(project, ['init']));

    // 4. Wrong seat caller (init.grant-caller)
    recordSeat(project, 'lead-pane');
    {
      const io = testIo(project, otherSeat);
      expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
      expect(io.err).toBe('team init: only the seat the grant names runs this: this call is worker\n');
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }

    // 5. Missing pane in state (init.grant-no-pane)
    updateState(join(project, '.agents'), (state) => {
      state.sessions.acme = emptySession();
    });
    {
      const io = testIo(project, leadSeat);
      expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
      expect(io.err).toBe(`team init: ${noPaneRefusal('lead')}\n`);
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }

    // 6. Another pane in state (init.grant-another-pane)
    recordSeat(project, 'other-pane');
    {
      const io = testIo(project, leadSeat);
      expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
      expect(io.err).toBe(`team init: ${anotherPaneRefusal('lead', 'other-pane')}\n`);
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }

    // 7. Grant scope omits init (init.grant-scope)
    approveRepo(project, teamFile(project, ['up', 'down']));
    recordSeat(project, 'lead-pane');
    {
      const io = testIo(project, leadSeat);
      expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
      expect(io.err).toBe('team init: the grant does not list `init`\n');
      expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    }
  });
});
