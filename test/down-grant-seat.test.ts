// A create-grant names a seat of another team: `agent` is the seat's name and `session` the
// herdr session it stands in, while the team's file names the session the team runs in — the
// two differ. The walk places the caller in the session it stands in (the record's own
// question) and finds no agent of it in the team's session, so the judged caller is unplaced
// there and the ordinary rule refuses it; the record is the run's admission anyway, exactly
// as it is for `init` and `up`, and a granted `down` stops the whole team — the orchestrator's
// seat included, since no seat of it is the caller. The stop's log line names the caller the
// walk judged, unplaced — the record's name is nowhere in it. Every other seat, session, path
// and expiry still refuses, in the dry run's own words. The commands are driven through the
// walker: the fake parents are the real `callerSources`, so `callerOf`/`walkCaller` place the
// call exactly as they would a live one — no caller is handed in.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Process } from '../src/caller.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { grantsDir } from '../src/grant.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T11:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T10:59:59Z';

/** The record the scenes hold: one seat, in the herdr session it stands in. */
const SEAT_GRANT = `entity: beacon\nsession: floor\nagent: iris\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`;
/** The same record, naming a session the seat doesn't stand in. */
const ELSEWHERE_GRANT = `entity: beacon\nsession: dispatch\nagent: iris\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`;
/** The same record, past its expiry. */
const PAST_GRANT = `entity: beacon\nsession: floor\nagent: iris\npaths:\n  - ~/Code/beacon\nexpires: "${PAST}"\n`;

/** The refusal every scene here that isn't admitted answers with: the walk judged the caller in
 *  the team's session, found no agent of it there, and the record didn't cover it. */
const REFUSAL = '! down would refuse: only the owner or `leads` stops the team; this call is unplaced (it runs in a herdr pane without an agent)\n';

const SEAT = (role: string, name: string, leads = false) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${leads ? '\n    leads: true' : ''}
`;

/** The team's file: it names the session the team runs in — `acceptance-test` — and one
 *  orchestrator, the seat the stop scene has running. */
function teamText(project: string, root: string, home: string): string {
  const lobby = join(home, '.config', 'team', 'lobbies', 'beacon');
  return `format: 1
project: ${project}
entity: beacon
session: acceptance-test
operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}`;
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
}

/** A home with a grants directory, a granted tree under it (`~/Code/beacon`), and one
 *  repository the record does not cover (`~/Code/other`). */
function makeSandbox() {
  const base = realpathSync(mkdtempSync('/tmp/dgs-'));
  const home = join(base, 'home');
  mkdirSync(grantsDir(home), { recursive: true });
  const covered = join(home, 'Code', 'beacon', 'v1');
  const outside = join(home, 'Code', 'other', 'v1');
  initGitRepo(covered);
  initGitRepo(outside);
  return { base, home, covered, outside };
}

function writeGrant(home: string, body: string): void {
  mkdirSync(grantsDir(home), { recursive: true });
  writeFileSync(join(grantsDir(home), 'beacon.yaml'), body);
}

/** The team's state as `up` left it: the team's session recorded, and — in the stop scene —
 *  the orchestrator's seat with the pane and workspace it runs on. */
function teamAt(root: string, home: string, seats: Record<string, { pane: string; workspace: string }> = {}): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  updateState(join(root, '.agents'), (file) => {
    file.sessions['acceptance-test'] = {
      ...emptySession(),
      seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [
        name,
        { stage: 'ready' as const, pane: seat.pane, workspace: seat.workspace },
      ])),
    };
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText('beacon-v1', root, home));
}

/** The walk of the seat the record names: herdr above it, the pane root among the ancestors,
 *  and only the session the seat stands in listing the pane under the seat's name. A walk
 *  asked about any other session finds no agent there, as a session that doesn't hold the
 *  pane answers. The team's file names `acceptance-test`; the seat stands in `floor`. */
function seatIo(cwd: string, name = 'iris', session = 'floor', pane = 'w1:p1') {
  const root = 4242;
  const io = testIo(cwd);
  io.callerSources = (asked?: string) => ({
    ancestors: () => [{ pid: root, name: 'zsh' }, { pid: 1, name: 'herdr' }],
    agents: () => (asked === session ? [{ pane, name, agent: null, workspace: '', status: '', cwd }] : []),
    paneRootPid: (askedPane: string) => (askedPane === pane ? root : null),
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  });
  return io;
}

/** A dry run whose every machine read is quiet: a running session with no agent in it, so
 *  the run is decided by the caller and the record alone. */
function drySources(home: string): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    home,
    standing: () => ({ kind: 'none' }),
  };
}

describe('the record admits the seat whose team file names another session', () => {
  test('down stops the team, the orchestrator\'s seat included', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, SEAT_GRANT);
      teamAt(sb.covered, sb.home, { orchestrator: { pane: 'orch-pane', workspace: 'orch-ws' } });
      const closed: string[] = [];
      let box = claudeBox('');
      let live = true;
      const people = (): HerdrAgent[] => (live
        ? [{ name: 'orchestrator', agent: 'claude', pane: 'orch-pane', workspace: 'orch-ws', status: 'idle', cwd: null }]
        : []);
      const launch: DownLaunch = {
        typeText(_session, _pane, text) {
          box = claudeBox(text);
          return true;
        },
        sendKey: () => true,
        pressEnter() {
          live = false;
          return true;
        },
        agentPanes: () => people().map((agent) => agent.pane),
        closeWorkspace(_session, workspace) {
          closed.push(workspace);
          return true;
        },
        stopSession: () => true,
        deleteSession: () => true,
        kill: () => true,
        sleep: async () => {},
        now: () => NOW,
      };
      const io = seatIo(sb.covered);
      const code = await runDown([], io, {
        ...drySources(sb.home),
        agents: people,
        screenText: () => box,
        foreground: () => (live ? ['claude'] : ['zsh']),
        launch,
      });
      expect(io.err).toBe('');
      expect(code).toBe(0);
      // The orchestrator's seat is not kept back: no seat of this team is the caller.
      expect(closed).toEqual(['orch-ws']);
      // The log names the caller the walk judged — unplaced in the team's session — and the
      // seat the run stopped; the record's own name is nowhere in the line.
      const log = readFileSync(join(sb.covered, '.agents', LOG_FILE), 'utf8');
      expect(log).toContain('down [unplaced (it runs in a herdr pane without an agent)] orchestrator: stopped\n');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a dry run plans the stop instead of refusing it', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, SEAT_GRANT);
      teamAt(sb.covered, sb.home);
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, drySources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).not.toContain('would refuse');
      expect(io.out.endsWith('dry run: nothing was run\n')).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

describe('every other seat, session and path still refuses', () => {
  test('another seat of the record\'s session is refused', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, SEAT_GRANT);
      teamAt(sb.covered, sb.home);
      const io = seatIo(sb.covered, 'co-worker');
      const code = await runDown(['--dry-run'], io, drySources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain(REFUSAL);
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('the named seat in a session the record does not name is refused', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, ELSEWHERE_GRANT);
      teamAt(sb.covered, sb.home);
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, drySources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain(REFUSAL);
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('a root outside the granted paths is refused', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, SEAT_GRANT);
      teamAt(sb.outside, sb.home);
      const io = seatIo(sb.outside);
      const code = await runDown(['--dry-run'], io, drySources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain(REFUSAL);
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('the named seat on a record past its expiry is refused', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, PAST_GRANT);
      teamAt(sb.covered, sb.home);
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, drySources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain(REFUSAL);
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
