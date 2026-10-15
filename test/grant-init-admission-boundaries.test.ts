// Adversarial coverage for the grant-gated `team init` (feat/grant-init): the store states
// and the real placement walk its own rows leave open. A record is signed over whatever text
// it was given, so a verified standing can carry a copy that does not validate — the two
// halves of that state, on either side of grantForInit's own validation, answer differently.
// The caller is placed through callerSources on every row here: no handed-in Caller, so the
// gate's placement reads (it re-aims io.cwd at the grant's root) are exercised as they run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { anotherPaneRefusal } from '../src/caller.ts';
import { runInit } from '../src/commands/init.ts';
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

function teamText(root: string, scope: string[] | null): string {
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

/** Approves `text` and returns the file path written. */
function approve(root: string, text: string): string {
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

/** A verified record whose stored copy does not validate: the signature covers what was
 *  stored, and `writeApproval` signs the text it is given, so the standing stays verified
 *  over a copy no reader can load. The approval is computed from the valid team that stands
 *  at .agents/team.yaml; only the stored copy text is garbage. */
function corruptApproval(root: string): void {
  const loaded = loadTeamFile(root, { file: join(root, '.agents', 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: 'not a team file\n' },
    loaded.team.seats,
    home,
    NOW,
  );
}

function recordSeat(root: string, pane = 'lead-pane'): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane };
  });
}

/** An io whose caller is placed by the real walk: herdr ancestry, an agent entry for the
 *  seat, and the pane's root pid matching that ancestry. The sources answer for whatever
 *  session the command asks about — the gate asks in the grant's session, the not-owner
 *  walk asks without one — so the pane is listed on every ask. */
function placeIo(root: string, pane = 'lead-pane'): ReturnType<typeof testIo> {
  const io = testIo(root);
  io.env = {};
  io.callerSources = (session: string | undefined) => ({
    ancestors: () => [{ pid: 1, name: 'herdr' }, { pid: 100, name: 'step-100' }],
    agents: () => [{ pane, name: 'lead', agent: null, workspace: '', status: '', cwd: null }],
    paneRootPid: (at: string) => (at === pane ? 100 : null),
    env: io.env,
    stdinIsTTY: false,
  });
  return io;
}

const NOT_OWNER = 'team init: only the owner runs init, from a terminal outside herdr; this call is lead\n';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-init-adm-')));
  home = join(base, 'home');
  project = join(base, 'acme');
  mkdirSync(home);
  makeRepo(project);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('grant-init admission boundaries', () => {
  test('a verified record over a copy that does not validate: with the grant file on disk the copy refuses; with it gone, no grant is in play and the ordinary refusal stands', async () => {
    // The grant file stands on disk, never approved; the store holds a verified record
    // whose copy is not a team file. The gate reaches its copy check before any drift.
    const text = teamText(project, ['init']);
    mkdirSync(join(project, '.agents'), { recursive: true });
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    corruptApproval(project);
    recordSeat(project);

    const io = placeIo(project);
    const code = await runInit([], io, home, undefined, noLogin);
    expect(code).toBe(1);
    expect(io.err).toBe('team init: a grant needs a readable approved copy: run `team approve`\n');
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(text);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);

    // The same store record with the file removed: grantForInit's own validation of the
    // copy fails before the gate is asked, so the caller meets the ordinary not-owner
    // refusal, and the corrupt record is left exactly as it was.
    rmSync(join(project, '.agents', 'team.yaml'));
    const io2 = placeIo(project);
    const code2 = await runInit([], io2, home, undefined, noLogin);
    expect(code2).toBe(1);
    expect(io2.err).toBe(NOT_OWNER);
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    expect(approvalStanding(project, home).kind).toBe('verified');
  });

  test('a caller placed by the real walk: the lead on its recorded pane restores, and the same seat from a pane the state no longer records is refused in the gate\'s own words', async () => {
    const text = teamText(project, ['init']);
    const file = approve(project, text);
    recordSeat(project, 'lead-pane');
    rmSync(file);

    const io = placeIo(project, 'lead-pane');
    const code = await runInit(['--restore'], io, home, undefined, noLogin);
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toMatch(/ grant \[grant\] lead init\n/);

    // The state now records another pane for the seat; the caller still walks from
    // lead-pane. The gate's placement read names the recorded pane, nothing is written.
    const text2 = teamText(project, ['init']);
    approve(project, text2);
    rmSync(join(project, '.agents', 'team.yaml'));
    rmSync(join(project, '.agents', 'team.log'));
    recordSeat(project, 'moved-pane');

    const io2 = placeIo(project, 'lead-pane');
    const code2 = await runInit(['--restore'], io2, home, undefined, noLogin);
    expect(code2).toBe(1);
    expect(io2.err).toBe(`team init: ${anotherPaneRefusal('lead', 'moved-pane')}\n`);
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
  });

  test('an on-disk file without a grant decides before the store is asked: a verified grant-carrying approval admits nobody', async () => {
    const granted = teamText(project, ['init']);
    approve(project, granted);
    recordSeat(project);

    // The live file on disk is the same team without the grant block. Branch one loads it,
    // finds no grant, and returns before the store's grant-carrying copy is ever read.
    const grantless = teamText(project, null);
    writeFileSync(join(project, '.agents', 'team.yaml'), grantless);

    const io = placeIo(project);
    const code = await runInit([], io, home, undefined, noLogin);
    expect(code).toBe(1);
    expect(io.err).toBe(NOT_OWNER);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(grantless);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    expect(approvalStanding(project, home).kind).toBe('verified');
  });
});
