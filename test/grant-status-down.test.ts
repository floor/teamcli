// A create-grant's `runner`: the two commands that only read a team or stop one, for a team
// whose root is under the record's `paths`. `status` admits the holder's runner to the reading,
// and `down` admits it to the stop — the detached refusal and the ordinary caller rule both
// stand aside for the record, exactly as `init` and `up` ask it. The grant buys that one thing
// and no other: `--file` and `--session` stay the owner's, and a granted reading keeps no
// `last_valid` copy. Every refusal around it holds — a name not in the ancestry, a caller under
// herdr, a root outside the granted paths, a record past its expiry, and no record at all.
// The commands are driven through the walker: the fake parents are the real `callerSources`, so
// `callerOf`/`walkCaller` place the call exactly as they would a live one.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Process } from '../src/caller.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { grantsDir } from '../src/grant.ts';
import { readState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T11:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const PAST = '2026-10-16T10:59:59Z';

// The record's runner: no CLI profile name and no server name, so its presence alone says
// nothing — only the record may name it.
const RUNNER = 'gemini-beacon';
const CLI_RUNNER = 'claude';

/** Fake parents, nearest first, as `ps` would walk them. */
const parents = (...names: string[]): Process[] => names.map((name, i) => ({ pid: 900 - i, name }));

const OUTSIDE_HERDR = parents('zsh', RUNNER, 'launchd');
const WITHOUT_RUNNER = parents('zsh', 'launchd');
const UNDER_HERDR = parents('zsh', RUNNER, 'herdr', 'launchd');

const NOT_YOURS = 'team status: this team is not yours to read\n';
const DETACHED = 'team down: only the owner runs this, from a terminal outside herdr\n';
const FILE_OWNER = 'team status: only the owner runs this, from a terminal outside herdr\n';

const SEAT = (role: string, name: string, leads = false) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${leads ? '\n    leads: true' : ''}
`;

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

const recordWith = (expires: string, extra = ''): string =>
  `entity: beacon\nsession: dispatch\nagent: beacon-runner\npaths:\n  - ~/Code/beacon\nexpires: "${expires}"\n${extra}`;
const WITH_RUNNER = recordWith(FUTURE, `runner: ${RUNNER}\n`);

/** The team file a directory carries. `session` is the herdr session the file names, and the
 *  one a walk of it places a caller in; left out, the file names no session and the project
 *  name stands in for it. */
function teamAt(root: string, home: string, session?: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText('beacon-v1', root, home, session));
}

/** The commands driven through the walker: the fake parents are the whole caller source. */
function walkIo(cwd: string, ancestors: Process[]) {
  const io = testIo(cwd);
  io.callerSources = () => ({
    ancestors: () => ancestors,
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
  test('status reads as the runner the record names, for a root under the granted paths', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      teamAt(sb.covered, sb.home);
      const io = walkIo(sb.covered, OUTSIDE_HERDR);
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

  test('down stops as that runner: a dry run plans the stop instead of refusing it', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      teamAt(sb.covered, sb.home);
      const io = walkIo(sb.covered, OUTSIDE_HERDR);
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
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      teamAt(sb.covered, sb.home);
      const file = join(sb.covered, '.agents', 'team.yaml');
      const aimed = walkIo(sb.covered, OUTSIDE_HERDR);
      expect(await runStatus(['--file', file], aimed, statusSources(sb.home))).toBe(1);
      expect(aimed.err).toBe(FILE_OWNER);
      expect(aimed.out).toBe('');
      const sessioned = walkIo(sb.covered, OUTSIDE_HERDR);
      expect(await runStatus(['--session', 'beacon-v1'], sessioned, statusSources(sb.home))).toBe(1);
      expect(sessioned.err).toBe(FILE_OWNER);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

describe('every other caller and path still refuses', () => {
  const refuseStatus = async (sb: ReturnType<typeof makeSandbox>, home: string, ancestors: Process[], where = 'covered') => {
    const root = where === 'covered' ? sb.covered : sb.outside;
    teamAt(root, home);
    const io = walkIo(root, ancestors);
    const code = await runStatus([], io, statusSources(home));
    expect(io.err).toBe(NOT_YOURS);
    expect(io.out).toBe('');
    expect(code).toBe(2);
  };

  test('status refuses a caller whose ancestry does not carry the runner', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      await refuseStatus(sb, sb.home, WITHOUT_RUNNER);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a caller under herdr whose ancestry happens to carry the runner', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      await refuseStatus(sb, sb.home, UNDER_HERDR);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a root outside the granted paths', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      await refuseStatus(sb, sb.home, OUTSIDE_HERDR, 'outside');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a record past its expiry', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', recordWith(PAST, `runner: ${RUNNER}\n`));
      await refuseStatus(sb, sb.home, OUTSIDE_HERDR);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a team with no record at all', async () => {
    const sb = makeSandbox();
    try {
      await refuseStatus(sb, sb.home, OUTSIDE_HERDR);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  // `down` refuses these before it reads anything: the detached sentence, exit 1, no plan.
  const refuseDown = async (sb: ReturnType<typeof makeSandbox>, home: string, ancestors: Process[], where = 'covered') => {
    const root = where === 'covered' ? sb.covered : sb.outside;
    teamAt(root, home);
    const io = walkIo(root, ancestors);
    const code = await runDown(['--dry-run'], io, downSources(home));
    expect(io.err).toBe(DETACHED);
    expect(io.out).toBe('');
    expect(code).toBe(1);
  };

  test('down refuses a caller whose ancestry does not carry the runner', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      await refuseDown(sb, sb.home, WITHOUT_RUNNER);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses a root outside the granted paths', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      await refuseDown(sb, sb.home, OUTSIDE_HERDR, 'outside');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses a record past its expiry', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', recordWith(PAST, `runner: ${RUNNER}\n`));
      await refuseDown(sb, sb.home, OUTSIDE_HERDR);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses a team with no record at all', async () => {
    const sb = makeSandbox();
    try {
      await refuseDown(sb, sb.home, OUTSIDE_HERDR);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  // Under herdr the walk places nobody: the refusal is the ordinary caller rule's, in the dry
  // run's own words, and the record is never consulted for it.
  test('down refuses a caller under herdr by the ordinary caller rule', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', WITH_RUNNER);
      teamAt(sb.covered, sb.home);
      const io = walkIo(sb.covered, UNDER_HERDR);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe('');
      // The sentence is the walk's own, from the run this test makes: under herdr with no agent
      // list to read, the placement says so, and the record is never consulted for it.
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is unplaced (it runs under herdr, and herdr doesn\'t answer)\n');
      expect(io.out.endsWith('dry run: nothing was run\n')).toBe(true);
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});

// The same record, held by a seat: `agent` names the seat, `session` the herdr session it
// stands in. A seat the record names is the holder it was written for. The team file these
// scenes read names the seat's own session, so the walk places the caller — the reading and
// the stop are the record's to admit or refuse, not the placement's.
const SEAT_GRANT = `entity: beacon\nsession: floor\nagent: scout\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`;
/** The same record, naming a session the seat doesn't stand in. */
const ELSEWHERE_GRANT = `entity: beacon\nsession: elsewhere\nagent: scout\npaths:\n  - ~/Code/beacon\nexpires: "${FUTURE}"\n`;
const PAST_GRANT = `entity: beacon\nsession: floor\nagent: scout\npaths:\n  - ~/Code/beacon\nexpires: "${PAST}"\n`;

/** The walk of a herdr seat: herdr above it, the pane root among the ancestors, and the one
 *  session the seat stands in — and only it — listing the pane under the seat's name. A walk
 *  asked about any other session finds no agent there, as a session that doesn't hold the pane
 *  answers. */
function seatIo(cwd: string, name = 'scout', session = 'floor', pane = 'w1:p1') {
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

describe('a create-grant names a seat of another team', () => {
  test('status reads as the seat the record names, in the session it names', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', SEAT_GRANT);
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
      writeGrant(sb.home, 'beacon.yaml', SEAT_GRANT);
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

  // Every other seat, session and path still refuses: the record names one seat, in one
  // session, under one path, until one expiry. The caller is placed as the seat it is, so the
  // refusal's own sentence names it — the walk's words, from the run the test makes.
  test('status refuses another seat of the same session', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', SEAT_GRANT);
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered, 'co-worker');
      expect(await runStatus([], io, statusSources(sb.home))).toBe(2);
      expect(io.err).toBe(NOT_YOURS);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses the named seat in a session the record does not name', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', ELSEWHERE_GRANT);
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      expect(await runStatus([], io, statusSources(sb.home))).toBe(2);
      expect(io.err).toBe(NOT_YOURS);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses a root outside the granted paths', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', SEAT_GRANT);
      teamAt(sb.outside, sb.home, 'floor');
      const io = seatIo(sb.outside);
      expect(await runStatus([], io, statusSources(sb.home))).toBe(2);
      expect(io.err).toBe(NOT_YOURS);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('status refuses the named seat on a record past its expiry', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', PAST_GRANT);
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      expect(await runStatus([], io, statusSources(sb.home))).toBe(2);
      expect(io.err).toBe(NOT_YOURS);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses another seat of the same session, in the dry run\'s own words', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', SEAT_GRANT);
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

  test('down refuses the named seat in a session the record does not name', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', ELSEWHERE_GRANT);
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.err).toBe('');
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is scout\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses a root outside the granted paths', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', SEAT_GRANT);
      teamAt(sb.outside, sb.home, 'floor');
      const io = seatIo(sb.outside);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is scout\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('down refuses the named seat on a record past its expiry', async () => {
    const sb = makeSandbox();
    try {
      writeGrant(sb.home, 'beacon.yaml', PAST_GRANT);
      teamAt(sb.covered, sb.home, 'floor');
      const io = seatIo(sb.covered);
      const code = await runDown(['--dry-run'], io, downSources(sb.home));
      expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is scout\n');
      expect(code).toBe(1);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
