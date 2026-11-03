// The restore child: the daemon runs each route's restore pass in a second process, and the
// child's authority is the one-use token the daemon writes under the machine folder. These
// scenes pin that authority (the token is 0600 and one-use; no token, a name this program never
// writes, and a replayed token all refuse and run nothing) and the real pass through the
// spawner. The last scene is the reason the child exists: with a terminal host that answers in
// five seconds, the daemon's heartbeat keeps its cadence, because the pass's synchronous reads
// hold the child alone.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { machineConfigDir, restoreInheritPath } from '../src/daemon/paths.ts';
import { restoreEntryOf, runRestoreSweepInChild } from '../src/daemon/restore/spawn.ts';
import { readRestoreInherit, writeRestoreInherit } from '../src/daemon/restore/token.ts';
import { readDaemonState } from '../src/daemon/state.ts';

/** The timed scene runs under /private/tmp where a bun child starts quickly; elsewhere the
 *  system temporary folder. */
const BASE = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

const TEAM = `format: 1
project: restore-child
coordinator: worker
operator: worker
session: sweep
workspace:
  mode: shared
seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const ENTRY = fileURLToPath(new URL('../src/daemon/restore/entry.ts', import.meta.url));

const bases: string[] = [];

function scratch(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(BASE, 'team-restore-child-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { base, root, home };
}

/** The route's record: one seat recorded ready, so a pass proceeds past the recorded-session
 *  check and reads the session's state. */
function recordSeat(root: string): void {
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    JSON.stringify({
      format: 1,
      sessions: {
        sweep: {
          seats: {
            worker: {
              stage: 'ready',
              pane: 'fixture-pane-1',
              workspace: 'fixture-workspace-1',
              launched: { shell: 500, cli: [501] },
            },
          },
          worktrees: {},
        },
      },
    }),
  );
}

/** The child entry run as its own program, the way the daemon starts it. */
function runEntry(home: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

const tokenFiles = (home: string): string[] => {
  const dir = machineConfigDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('restore.inherit.'));
};

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

describe("the restore child's authority is the one-use token", () => {
  test('the daemon writes it 0600 and reading it consumes it', () => {
    const { root, home } = scratch();
    const nonce = writeRestoreInherit({ version: 1, home, root });
    const path = restoreInheritPath(home, nonce);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readRestoreInherit(home, nonce)).toEqual({ kind: 'ok', request: { version: 1, home, root } });
    // One token starts one pass: the read unlinked it.
    expect(existsSync(path)).toBe(false);
    expect(readRestoreInherit(home, nonce)).toEqual({ kind: 'refused', why: 'no one-use token names this child' });
  });

  test('a name this program never writes, and a name with no token, are both refused', () => {
    const { root, home } = scratch();
    expect(readRestoreInherit(home, 'not-a-token')).toEqual({
      kind: 'refused',
      why: 'the token name is not one this daemon writes',
    });
    expect(readRestoreInherit(home, '../daemon.state.json')).toEqual({
      kind: 'refused',
      why: 'the token name is not one this daemon writes',
    });
    expect(readRestoreInherit(home, 'a'.repeat(32))).toEqual({
      kind: 'refused',
      why: 'no one-use token names this child',
    });
    // Nothing was consumed by the refusals: a real token still reads.
    const nonce = writeRestoreInherit({ version: 1, home, root });
    expect(readRestoreInherit(home, nonce).kind).toBe('ok');
  });

  test('a token whose content is not a request this child can run is refused, and consumed', () => {
    const { root, home } = scratch();
    mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
    const unknown = 'b'.repeat(32);
    writeFileSync(restoreInheritPath(home, unknown), `${JSON.stringify({ version: 2, home, root })}\n`, { mode: 0o600 });
    expect(readRestoreInherit(home, unknown)).toEqual({ kind: 'refused', why: 'the token names an unknown format' });
    expect(existsSync(restoreInheritPath(home, unknown))).toBe(false);
    const unparseable = 'c'.repeat(32);
    writeFileSync(restoreInheritPath(home, unparseable), 'not json\n', { mode: 0o600 });
    expect(readRestoreInherit(home, unparseable)).toEqual({ kind: 'refused', why: 'the token is not readable JSON' });
  });

  test('started with no token the child refuses, exits 2, and reports no pass', () => {
    const { root, home } = scratch();
    const ran = runEntry(home, [], root);
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('the token name is not one this daemon writes');
    // A name the program would write, but no token behind it, refuses the same way.
    const forged = runEntry(home, ['--inherited', 'a'.repeat(32)], root);
    expect(forged.status).toBe(2);
    expect(forged.stdout).toBe('');
    expect(forged.stderr).toContain('no one-use token names this child');
  });

  test('a replayed token starts no second pass', () => {
    const { root, home } = scratch();
    const nonce = writeRestoreInherit({ version: 1, home, root });
    const first = runEntry(home, ['--inherited', nonce], root);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout.trim())).toEqual({ ok: true, result: { kind: 'no-recorded-session' } });
    // The token was spent by the first child: the same command line now refuses.
    const replayed = runEntry(home, ['--inherited', nonce], root);
    expect(replayed.status).toBe(2);
    expect(replayed.stdout).toBe('');
    expect(replayed.stderr).toContain('no one-use token names this child');
    expect(tokenFiles(home)).toEqual([]);
  });

  test('the spawner runs the real pass and leaves no token behind', async () => {
    const { root, home } = scratch();
    expect(restoreEntryOf()).toBe(ENTRY);
    expect(await runRestoreSweepInChild({ home, root, timeoutMs: 60_000 })).toEqual({ kind: 'no-recorded-session' });
    expect(tokenFiles(home)).toEqual([]);
  }, 30_000);
});

describe("the daemon's beat while a restore pass runs", () => {
  test('a terminal host answering in five seconds holds the child, never the heartbeat', async () => {
    const { base, root, home } = scratch();
    // The route records a seat, so the pass reads the session's state and reaches the terminal
    // host. The fake answers every call after five seconds and logs the call first, so a landed
    // `session list` names the window the pass was inside.
    recordSeat(root);
    const bin = join(base, 'bin');
    const herdrLog = join(base, 'herdr.log');
    mkdirSync(bin);
    const shim = join(bin, 'herdr');
    writeFileSync(
      shim,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TEAM_TEST_HERDR_LOG"
sleep 5
if [ "$1" = "--version" ]; then
  echo "herdr 0.7.1"
  exit 0
fi
echo '{"result":{"sessions":[]}}'
`,
    );
    chmodSync(shim, 0o755);
    const savedPath = process.env.PATH;
    const savedLog = process.env.TEAM_TEST_HERDR_LOG;
    process.env.PATH = `${bin}:${savedPath ?? '/usr/bin:/bin'}`;
    process.env.TEAM_TEST_HERDR_LOG = herdrLog;
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'test',
      version: '0.6.0-test',
      heartbeatMs: 200,
      // Per-root chores children run the chores loop, as the release default does: they are
      // children too, so they must not hold the beat either.
      choresHosting: true,
    });
    try {
      expect(started.kind).toBe('serving');
      if (started.kind !== 'serving') return;
      const beats: number[] = [];
      let last = '';
      const until = Date.now() + 8_000;
      while (Date.now() < until) {
        const read = readDaemonState(home);
        if (read.kind === 'ok' && read.state.heartbeatAt !== last) {
          last = read.state.heartbeatAt;
          beats.push(Date.parse(last));
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The fake was reached (the pass was inside a five-second call while the beat sampled)…
      expect(existsSync(herdrLog) ? readFileSync(herdrLog, 'utf8') : '').toContain('session list');
      // …the child was authorised by its one-use token, which it consumed before acting…
      expect(tokenFiles(home)).toEqual([]);
      // …and no gap between beats came near that call: an inline pass would freeze the beat for
      // the whole of it. The seam beat is 200 ms; a quarter of the call's five seconds is the
      // honest bound for a loaded machine.
      let gap = 0;
      for (let index = 1; index < beats.length; index += 1) {
        gap = Math.max(gap, beats[index]! - beats[index - 1]!);
      }
      expect(beats.length).toBeGreaterThan(20);
      expect(gap).toBeLessThan(1_250);
    } finally {
      if (started.kind === 'serving') await started.daemon.close();
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedLog === undefined) delete process.env.TEAM_TEST_HERDR_LOG;
      else process.env.TEAM_TEST_HERDR_LOG = savedLog;
    }
  }, 40_000);
});
