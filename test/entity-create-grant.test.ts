// Independent scenes for the standing create-grant: a record in the store home's
// `.config/team/grants/` names an agent, its session, a covered path and an expiry. Under
// that record the agent creates and mounts a team below the covered path with no approval
// record anywhere, and every way around it is refused with exit 1 — an empty store, a
// path outside the grant reached through `..` or a symlink, a sibling that shares the
// grant's string prefix, another seat, the grantee's own name in another session, and a
// record whose expiry has passed. The scenes drive the command entry points the way the
// shipped grant tests do,
// with every machine read stubbed and the clock pinned through the sources, so the expiry
// scenes cannot drift with the wall clock. `init` answers a refusal with its owner-only
// message naming the caller; `up` answers with its `deny`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { emptySession, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

// The scenes' clock: the sources hand it to both commands, and the record's expiry is
// judged against it — later than one record, earlier than the other.
const NOW = new Date('2026-10-14T09:00:00Z');
const LATER = '2026-10-22T12:00:00Z';
const EARLIER = '2026-10-13T12:00:00Z';

// The grantee: session `hq`, seat `iris`, standing on the pane its home root's state records.
const IRIS = { kind: 'seat' as const, name: 'iris', pane: 'w1:p1', session: 'hq' };
const COWORKER = { kind: 'seat' as const, name: 'co-worker', pane: 'w1:p1', session: 'hq' };
const IRIS_ELSEWHERE = { kind: 'seat' as const, name: 'iris', pane: 'w1:p1', session: 'other' };

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

let base: string;
let home: string;
let lobby: string;
let hqRoot: string;
let radioRoot: string;
let repoRoot: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function repoAt(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
}

/** The standing create-grant record the scenes vary: one file in the store home's
 * `.config/team/grants/`, naming the agent, its session, the covered path and the expiry. */
function writeGrant(record: { paths: string[]; expires: string }): void {
  const lines = [
    'agent: iris',
    'session: hq',
    'paths:',
    ...record.paths.map((path) => `  - ${path}`),
    `expires: ${record.expires}`,
  ];
  writeFileSync(join(home, '.config', 'team', 'grants', 'create.yaml'), `${lines.join('\n')}\n`);
}

function seat(name: string, role: string, extra = ''): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...(extra ? [extra] : []),
  ].join('\n');
}

/** The team the acceptance path mounts under the granted path: one orchestrator, two
 * builders, two testers — five seats. */
function teamYaml(): string {
  return `format: 1
project: v4
coordinator: orchestrator
operator: orchestrator
session: v4
trust:
  - ${lobby}
  - ${repoRoot}
workspace:
  mode: shared
seats:
${seat('orchestrator', 'orchestrator', '    leads: true')}
${seat('builder', 'builder', '    count: 2')}
${seat('tester', 'tester', '    count: 2')}
`;
}

/** The grantee's own placement, in its home root's state: the pane its session records for
 * the seat, which the mounting command reads through. */
function placeIris(): void {
  updateState(join(hqRoot, '.agents'), (file) => {
    file.sessions.hq = {
      ...emptySession(),
      seats: { iris: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'hq-ws' } },
    };
  });
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

/** The mounting side of the acceptance scene: every machine read stubbed, every workspace
 * the launch makes recorded, so a scene asserts what was mounted without a pane. */
function upSources(): { sources: UpSources; workspaces: { label: string; cwd: string }[] } {
  const panes = new Map<string, string>();
  let n = 0;
  const workspaces: { label: string; cwd: string }[] = [];
  let session: 'absent' | 'running' = 'absent';
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, cwd, label) {
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, IDLE);
      workspaces.push({ label, cwd });
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane) {
      panes.set(pane, IDLE);
      return true;
    },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes.keys()],
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane) ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    workspaces,
    sources: {
      sessionRunning: () => session === 'running',
      agents: () => [],
      home,
      doctor: doctor(),
      launch,
      now: () => NOW,
    },
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-entity-grant-')));
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  hqRoot = join(base, 'hq');
  radioRoot = join(base, 'Code', 'radiooooo');
  repoRoot = join(radioRoot, 'v4');
  mkdirSync(join(home, '.config', 'team', 'grants'), { recursive: true });
  mkdirSync(lobby, { recursive: true });
  // The lobby gate refuses a lobby anyone else can read; a recursive mkdir makes 0755.
  chmodSync(lobby, 0o700);
  mkdirSync(join(hqRoot, '.agents'), { recursive: true });
  repoAt(repoRoot);
  placeIris();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the standing create-grant scenes', () => {
  test('a granted agent creates and mounts a team under the granted path', async () => {
    writeGrant({ paths: [radioRoot], expires: LATER });
    const io = testIo(repoRoot, IRIS);
    const code = await runInit([], io, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect({ code, out: io.out, err: io.err }).toMatchObject({ code: 0 });
    expect(existsSync(join(repoRoot, '.agents', 'team.yaml'))).toBe(true);

    writeFileSync(join(repoRoot, '.agents', 'team.yaml'), teamYaml());
    const { sources, workspaces } = upSources();
    const upIo = testIo(repoRoot, IRIS);
    const up = await runUp([], upIo, sources);
    expect({ code: up, out: upIo.out, err: upIo.err }).toMatchObject({ code: 0 });
    expect(workspaces.length).toBe(5);
  });

  test('a path outside the grant is refused, by `..` and by symlink', async () => {
    writeGrant({ paths: [radioRoot], expires: LATER });
    // `..` walks out of the granted prefix to a sibling the grant never names; the raw
    // string keeps its `..` segments, the way a traversal actually reaches in.
    const stolen = join(base, 'Code', 'stolen');
    repoAt(stolen);
    const dots = testIo(`${radioRoot}/v4/../../stolen`, IRIS);
    const dotsCode = await runInit([], dots, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect(dotsCode).toBe(1);
    expect(dots.out + dots.err).toContain('this call is iris');

    // A symlink inside the granted prefix that resolves outside it.
    const elsewhere = join(base, 'Code', 'elsewhere');
    repoAt(join(elsewhere, 'repo'));
    symlinkSync(elsewhere, join(radioRoot, 'link'));
    const link = testIo(join(radioRoot, 'link', 'repo'), IRIS);
    const linkCode = await runInit([], link, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect(linkCode).toBe(1);
    expect(link.out + link.err).toContain('this call is iris');
  });

  test('another agent is refused: another seat, and the grantee in another session', async () => {
    writeGrant({ paths: [radioRoot], expires: LATER });
    const coworker = testIo(repoRoot, COWORKER);
    const coworkerCode = await runInit([], coworker, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect(coworkerCode).toBe(1);
    expect(coworker.out + coworker.err).toContain('this call is co-worker');

    mkdirSync(join(repoRoot, '.agents'), { recursive: true });
    writeFileSync(join(repoRoot, '.agents', 'team.yaml'), teamYaml());
    const { sources } = upSources();
    const elsewhere = testIo(repoRoot, IRIS_ELSEWHERE);
    const elsewhereCode = await runUp([], elsewhere, sources);
    expect(elsewhereCode).toBe(1);
    expect(elsewhere.out + elsewhere.err).toContain('deny');
  });

  test('a record whose expiry has passed is refused, at init and at mount', async () => {
    writeGrant({ paths: [radioRoot], expires: EARLIER });
    const expired = testIo(repoRoot, IRIS);
    const expiredCode = await runInit([], expired, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect(expiredCode).toBe(1);
    expect(expired.out + expired.err).toContain('this call is iris');

    mkdirSync(join(repoRoot, '.agents'), { recursive: true });
    writeFileSync(join(repoRoot, '.agents', 'team.yaml'), teamYaml());
    const { sources } = upSources();
    const io = testIo(repoRoot, IRIS);
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.out + io.err).toContain('deny');
  });

  test('no grant at all is refused: the store holds no record for anyone', async () => {
    // The store exists and is empty: the same seat at the same path a valid record admits,
    // and with no record the owner-only refusal is the whole answer.
    const io = testIo(repoRoot, IRIS);
    const code = await runInit([], io, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect(code).toBe(1);
    expect(io.out + io.err).toContain('this call is iris');
  });

  test('a sibling that shares the granted prefix but is not under it is refused', async () => {
    writeGrant({ paths: [radioRoot], expires: LATER });
    // `radiooooo-other` begins with the granted path's own string; containment is not a
    // string prefix, and the sibling is outside the grant.
    const sibling = join(base, 'Code', 'radiooooo-other');
    repoAt(sibling);
    const io = testIo(sibling, IRIS);
    const code = await runInit([], io, home, undefined, { loggedIn: () => false, now: () => NOW });
    expect(code).toBe(1);
    expect(io.out + io.err).toContain('this call is iris');
  });
});
