import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// The second scene is `test.failing`: it pins the guarantee the brief states — a grant of
// another project never authorizes init in this root — as the behavior to reach.
import { approvalOf } from '../src/approve/approval.ts';
import { type Caller } from '../src/caller.ts';
import { runInit } from '../src/commands/init.ts';
import { noteLaunchedPane } from '../src/file/launched-file.ts';
import { loadTeamFile } from '../src/file/load.ts';
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

function teamFile(root: string, project: string, session: string, scope: string[] | null = ['init']): string {
  const grantBlock = scope === null
    ? ''
    : `grant:\n  session: ${session}\n  seat: lead\n  scope:\n${scope.map((item) => `    - ${item}`).join('\n')}\n`;
  return `format: 1
project: ${project}
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

function recordSeat(root: string, session: string, pane = 'lead-pane', launchedFile?: string): void {
  updateState(join(root, '.agents'), (state) => {
    const s = (state.sessions[session] ??= emptySession());
    if (launchedFile) s.launched_file = launchedFile;
    s.seats.lead = { stage: 'ready', pane };
  });
}

const leadSeat: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-init-b-')));
  home = join(base, 'home');
  project = join(base, 'acme');
  mkdirSync(home);
  makeRepo(project);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('grant-init boundaries', () => {
  test('a grant file that was never approved is not a first approval: --restore refuses and signs nothing', async () => {
    const text = teamFile(project, 'acme', 'acme', ['init']);
    mkdirSync(join(project, '.agents'), { recursive: true });
    writeFileSync(join(project, '.agents', 'team.yaml'), text);

    const io = testIo(project, leadSeat);
    const code = await runInit(['--restore'], io, home, undefined, noLogin);
    expect(code).toBe(1);
    expect(io.err).toBe('team init: a grant needs a verified approval: the file was never approved on this machine: run `team approve`\n');

    // The planted file is left byte-identical, no approval record appears, nothing is logged.
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(text);
    expect(approvalStanding(project, home)).toEqual({ kind: 'none' });
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test.failing('a grant of another project never authorizes init in this root', async () => {
    // This root: a team approved here, but its file and approved copy carry no grant.
    approveRepo(project, teamFile(project, 'acme', 'acme', null));
    rmSync(join(project, '.agents', 'team.yaml'));

    // Another project: its team is approved and its grant names this caller's seat, verified.
    const beta = join(base, 'beta');
    makeRepo(beta);
    const betaFile = approveRepo(beta, teamFile(beta, 'beta', 'beta', ['init']));
    recordSeat(beta, 'beta', 'lead-pane', betaFile);
    noteLaunchedPane(home, betaFile, 'lead-pane', 'beta');

    // The caller is beta's granted seat, standing in the acme root.
    const betaLead: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'beta' };
    const io = testIo(project, betaLead);
    const code = await runInit(['--restore'], io, home, undefined, noLogin);

    expect(code).toBe(1);
    expect(io.err).not.toBe('');
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('with no file, no approved copy and no launched pointer, a seat is refused and nothing is created', async () => {
    const io = testIo(project, leadSeat);
    const code = await runInit(['--restore'], io, home, undefined, noLogin);
    expect(code).toBe(1);
    expect(io.err).toBe('team init: only the owner runs init, from a terminal outside herdr; this call is lead\n');
    expect(existsSync(join(project, '.agents'))).toBe(false);
  });

  test('a seat of another session is refused, even on the same name and pane the grant records', async () => {
    const text = teamFile(project, 'acme', 'acme', ['init']);
    approveRepo(project, text);
    recordSeat(project, 'acme', 'lead-pane');

    const otherSession: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'beta' };
    const io = testIo(project, otherSession);
    const code = await runInit([], io, home, undefined, noLogin);
    expect(code).toBe(1);
    expect(io.err).toBe('team init: only the seat the grant names runs this: this call is lead\n');

    // The approved file on disk is left byte-identical and nothing is logged.
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(text);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });
});
