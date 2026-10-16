// A create-grant naming a registry identity: the two commands that only read a team or stop one,
// for a team whose root is under the record's `paths`. `status` admits the holder to the reading,
// and `down` admits it to the stop — the detached refusal and the ordinary caller rule both stand
// aside for the record, exactly as `init` and `up` ask it. The grant buys that one thing and no
// other: `--file` and `--session` stay the owner's, and a granted reading keeps no `last_valid`
// copy. Every refusal around it holds — another seat, a record naming another agent id, a caller
// outside herdr (no registry record), a root outside the granted paths, a record past its expiry,
// and no record at all.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { grantsDir } from '../src/grant.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { readState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T11:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T10:59:59Z';
const TEAM = 'aaaaaaaaaaaa';

const NOT_YOURS = 'team status: this team is not yours to read\n';
const DETACHED = 'team down: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane\n';
const FILE_OWNER = 'team status: --file is the owner\'s, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n';
const SESSION_OWNER = 'team status: --session is the owner\'s, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n';

const SEAT = (role: string, name: string, leads = false) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${leads ? '\n    leads: true' : ''}
`;

/** The record the scenes hold: one agent, by its registry id. */
const agentRecord = (id: string, expires: string): string =>
  `entity: beacon\nagent: ${id}\npaths:\n  - ~/Code/beacon\nexpires: "${expires}"\n`;

function teamText(project: string, root: string, home: string, session?: string): string {
  const lobby = join(home, '.config', 'team', 'lobbies', 'beacon');
  return `format: 1
project: ${project}
entity: beacon
${session === undefined ? '' : `session: ${session}\n`}operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'orchestrator', true)}${SEAT('builder', 'builder-1')}`;
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
  const base = realpathSync(mkdtempSync('/tmp/gsd-'));
  const home = join(base, 'home');
  mkdirSync(grantsDir(home), { recursive: true });
  const covered = join(home, 'Code', 'beacon', 'v1');
  const outside = join(home, 'Code', 'other', 'v1');
  initGitRepo(covered);
  initGitRepo(outside);
  return { base, home, covered, outside };
}

function writeGrant(home: string, name: string, body: string): void {
  mkdirSync(grantsDir(home), { recursive: true });
  writeFileSync(join(grantsDir(home), name), body);
}

/** The seat the record names, registered where herdr places it: pane `w1:p1`, in `floor`. */
function registerSeat(home: string, name = 'scout', pane = 'w1:p1', session = 'floor'): string {
  return registerAgent(home, {
    name,
    signing: { model: 'Claude Opus', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: TEAM, seat: name, session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  }).id;
}

/** The team file a directory carries. `session` is the herdr session the file names, and the
 *  one a walk of it places a caller in; left out, the file names no session and the section's
 *  default stands — this fixture names an entity, so that default is `<entity>-<project>`. */
function teamAt(root: string, home: string, session?: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText('beacon-v1', root, home, session));
}

/** The walk of a herdr seat: herdr above it, the pane root among the ancestors, and only the
 *  session the seat stands in listing the pane under the seat's name. A walk with no session
 *  asked reads herdr's current session, which is the one the caller stands in; a walk asked
 *  about any other session finds no agent there, as a session that doesn't hold the pane
 *  answers. */
function seatIo(cwd: string, name = 'scout', session = 'floor', pane = 'w1:p1') {
  const root = 4242;
  const io = testIo(cwd);
  io.callerSources = (asked?: string) => ({
    ancestors: () => [{ pid: root, name: 'zsh' }, { pid: 1, name: 'herdr' }],
    agents: () => (asked === undefined || asked === session ? [{ pane, name, agent: null, workspace: '', status: '', cwd }] : []),
    paneRootPid: (askedPane: string) => (askedPane === pane ? root : null),
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  });
  return io;
}

/** A caller outside herdr with no terminal: no registry record, so no record admits it. */
function outsideIo(cwd: string) {
  const io = testIo(cwd);
  io.stdinIsTTY = false;
  io.callerSources = () => ({
    ancestors: () => [{ pid: 900, name: 'zsh' }, { pid: 1, name: 'launchd' }],
    agents: () => null,
    paneRootPid: () => null,
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  });
  return io;
}

const quiet = { running: false, agents: [], workspaces: [], screens: {} };

function statusSources(home: string, over: Partial<StatusSources> = {}): StatusSources {
  return {
    live: () => quiet,
    branch: () => null,
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home,
    gate: { standing: () => ({ kind: 'none' }) },
    ...over,
  };
}

/** A stop whose every read is quiet: a running session with no agent in it, and no approval
 *  record, so the run is decided by the caller alone. */
function downSources(home: string): DownSources {
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

describe('a create-grant covers the read and the stop', () => {
  test('status reads as the agent the record names, for a root under the granted paths', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      // The scene is about the grant, not the default's entity naming: the file names its own
      // session, so the expectation reads the session under the project's own name.
      teamAt(sb.covered, sb.home, 'beacon-v1');
      const io = seatIo(sb.covered);
      const code = await runStatus([], io, statusSources(sb.home));
      expect(io.err).not.toContain('this team is not yours to read');
      expect(io.out).toContain('team beacon-v1, session "beacon-v1"');
      expect(code).not.toBe(2);
      // The record buys the reading alone: an admitted run keeps no copy of the file.
      expect(readState(join(sb.covered, '.agents')).last_valid).toBeUndefined();
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down stops as that agent: a dry run plans the stop instead of refusing it', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home);
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).not.toContain('would refuse');
      expect(io.out.endsWith('dry run: nothing was run\n')).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('the flags stay the owner\'s, granted or not', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home);
      const file = join(sb.covered, '.agents', 'team.yaml');
      const aimed = seatIo(sb.covered);
      expect(await runStatus(['--file', file], aimed, statusSources(sb.home))).toBe(1);
      expect(aimed.err).toBe(FILE_OWNER);
      expect(aimed.out).toBe('');
      const sessioned = seatIo(sb.covered);
      expect(await runStatus(['--session', 'beacon-v1'], sessioned, statusSources(sb.home))).toBe(1);
      expect(sessioned.err).toBe(SESSION_OWNER);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

describe('every other caller and path still refuses', () => {
  const refuseStatus = async (sb: ReturnType<typeof makeSandbox>, make: (root: string) => ReturnType<typeof seatIo>, where = 'covered') => {
    const root = where === 'covered' ? sb.covered : sb.outside;
    teamAt(root, sb.home);
    const io = make(root);
    const code = await runStatus([], io, statusSources(sb.home));
    expect(io.err).toBe(NOT_YOURS);
    expect(io.out).toBe('');
    expect(code).toBe(2);
  };

  test('status refuses a seat no record names', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      await refuseStatus(sb, (root) => seatIo(root, 'co-worker'));
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a record naming another agent id', async () => {
    const sb = makeSandbox();
    try {
      registerSeat(sb.home);
      const other = registerSeat(sb.home, 'co-worker', 'w2:p2');
      writeGrant(sb.home, 'beacon.yaml', agentRecord(other, FUTURE));
      await refuseStatus(sb, (root) => seatIo(root));
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a caller outside herdr: it has no registry record', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      await refuseStatus(sb, (root) => outsideIo(root));
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a root outside the granted paths', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      await refuseStatus(sb, (root) => seatIo(root), 'outside');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a record past its expiry', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, PAST));
      await refuseStatus(sb, (root) => seatIo(root));
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a team with no record at all', async () => {
    const sb = makeSandbox();
    try {
      registerSeat(sb.home);
      await refuseStatus(sb, (root) => seatIo(root));
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  // `down` refuses a caller outside herdr before it reads anything: the detached sentence,
  // exit 1, no plan.
  test('down refuses a caller outside herdr with the detached sentence', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home);
      const io = outsideIo(sb.covered);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe(DETACHED);
      expect(io.out).toBe('');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses a root outside the granted paths', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.outside, sb.home, 'floor');
      const io = seatIo(sb.outside);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is scout\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses a record past its expiry', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, PAST));
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is scout\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses another seat by the ordinary caller rule', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered, 'co-worker');
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is co-worker\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

describe('a create-grant names a seat of another team', () => {
  test('status reads as the seat the record names, in the session it stands in', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      const code = await runStatus([], io, statusSources(sb.home));
      expect(io.err).not.toContain('this team is not yours to read');
      expect(io.out).toContain('team beacon-v1, session "floor"');
      expect(code).not.toBe(2);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down stops as that seat: a dry run plans the stop instead of refusing it', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).not.toContain('would refuse');
      expect(io.out.endsWith('dry run: nothing was run\n')).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses another seat of the same session', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered, 'co-worker');
      expect(await runStatus([], io, statusSources(sb.home))).toBe(2);
      expect(io.err).toBe(NOT_YOURS);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses another seat of the same session, in the dry run\'s own words', async () => {
    const sb = makeSandbox();
    try {
      const scout = registerSeat(sb.home);
      writeGrant(sb.home, 'beacon.yaml', agentRecord(scout, FUTURE));
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered, 'co-worker');
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is co-worker\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
