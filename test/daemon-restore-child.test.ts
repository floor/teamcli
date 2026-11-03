// The restore child: the daemon runs each route's restore pass in a second process, and the
// child's authority is the one-use token the daemon writes under the machine folder. These
// scenes pin that authority (the token is 0600 and one-use; no token, a name this program never
// writes, and a replayed token all refuse and run nothing) and the real pass through the
// spawner. The last scene is the reason the child exists: with a terminal host that answers in
// five seconds, the daemon's heartbeat keeps its cadence, because the pass's synchronous reads
// hold the child alone.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { DAEMON_LABEL, machineConfigDir, restoreInheritPath } from '../src/daemon/paths.ts';
import { restoreEntryOf, runRestoreSweepInChild } from '../src/daemon/restore/spawn.ts';
import { acceptRestoreDoor, discardRestoreInherit, restoreDoorText, writeRestoreDoor } from '../src/daemon/restore/token.ts';
import { readDaemonState } from '../src/daemon/state.ts';

/** The timed scene runs under /private/tmp where a bun child starts quickly; elsewhere the
 *  system temporary folder. */
const BASE = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

// Known for 0.5.12.1: the real restore child entry verifies its parent through
// systemServiceManager(), which is implemented for macOS launchctl only.
const offDarwin = process.platform !== 'darwin';

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
const ORIGINAL_PATH = process.env.PATH;

/** Liveness answers come from the scene, never the machine: these scenes plant no claimed copy,
 *  so the sweep has nothing to ask about. */
const noneAlive = (): boolean => false;

function scratch(): { base: string; root: string; home: string; bin: string } {
  const base = realpathSync(mkdtempSync(join(BASE, 'team-restore-child-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  mkdirSync(bin, { recursive: true });
  // Place a synthetic service-manager unit and shim first on PATH so subprocess scenes never
  // reach the live system service manager and always report this test runner process as the
  // daemon job loaded from `home`'s own unit path.
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const unitFile = join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  writeFileSync(
    unitFile,
    `<plist version="1.0"><dict><key>Label</key><string>${DAEMON_LABEL}</string></dict></plist>\n`,
    { mode: 0o600 },
  );
  const unitRealpath = realpathSync(unitFile);
  const launchctl = join(bin, 'launchctl');
  writeFileSync(
    launchctl,
    `#!/bin/sh\nprintf 'path = %s\\npid = %s\\nprogram = %s\\n' "${unitRealpath}" "${String(process.pid)}" "${process.execPath}"\n`,
    { mode: 0o755 },
  );
  chmodSync(launchctl, 0o755);
  process.env.PATH = `${bin}:${ORIGINAL_PATH ?? '/usr/bin:/bin'}`;
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { base, root, home, bin };
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
function runEntry(
  home: string,
  args: string[],
  cwd: string,
  doorText?: string,
): { status: number | null; stdout: string; stderr: string } {
  if (doorText === undefined) {
    const ran = spawnSync(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
  }
  const ran = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    input: doorText,
  });
  return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

/** The same child started without waiting, so two can be started with one token at once. */
function runEntryInBackground(
  home: string,
  args: string[],
  cwd: string,
  doorText?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: doorText === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const door = child.stdio[3];
    if (doorText !== undefined && door && 'end' in door) {
      door.on('error', () => {});
      door.end(doorText);
    }
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const tokenFiles = (home: string): string[] => {
  const dir = machineConfigDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('restore.inherit.'));
};

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

describe("the restore child's authority is the one-use token", () => {
  const daemonPid = process.pid;
  const service = { job: () => ({ pid: daemonPid, program: process.execPath }) };

  test('the daemon writes it 0600 and reading it consumes it', () => {
    const { root, home } = scratch();
    const { nonce, secret } = writeRestoreDoor({ version: 1, home, root, daemonPid }, { isAlive: noneAlive });
    const path = restoreInheritPath(home, nonce);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      acceptRestoreDoor({
        home,
        nonce,
        text: restoreDoorText(nonce, secret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({ kind: 'ok', request: { version: 1, home, root } });
    // One token starts one pass: the read unlinked it.
    expect(existsSync(path)).toBe(false);
    expect(
      acceptRestoreDoor({
        home,
        nonce,
        text: restoreDoorText(nonce, secret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({ kind: 'refused', why: 'no one-use token names this child' });
  });

  test('a name this program never writes, and a name with no token, are both refused', () => {
    const { root, home } = scratch();
    const dummySecret = 'a'.repeat(64);
    expect(
      acceptRestoreDoor({
        home,
        nonce: 'not-a-token',
        text: restoreDoorText('not-a-token', dummySecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'the token name is not one this daemon writes',
    });
    expect(
      acceptRestoreDoor({
        home,
        nonce: '../daemon.state.json',
        text: restoreDoorText('../daemon.state.json', dummySecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'the token name is not one this daemon writes',
    });
    expect(
      acceptRestoreDoor({
        home,
        nonce: 'a'.repeat(32),
        text: restoreDoorText('a'.repeat(32), dummySecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'no one-use token names this child',
    });
    // Nothing was consumed by the refusals: a real token still reads.
    const { nonce, secret } = writeRestoreDoor({ version: 1, home, root, daemonPid }, { isAlive: noneAlive });
    expect(
      acceptRestoreDoor({
        home,
        nonce,
        text: restoreDoorText(nonce, secret),
        parentPid: daemonPid,
        service,
      }).kind,
    ).toBe('ok');
  });

  test('a token whose content is not a request this child can run is refused, and consumed', () => {
    const { root, home } = scratch();
    const dummySecret = 'b'.repeat(64);
    mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
    const unknown = 'b'.repeat(32);
    writeFileSync(restoreInheritPath(home, unknown), `${JSON.stringify({ version: 2, home, root })}\n`, { mode: 0o600 });
    expect(
      acceptRestoreDoor({
        home,
        nonce: unknown,
        text: restoreDoorText(unknown, dummySecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({ kind: 'refused', why: 'the token names an unknown format' });
    expect(existsSync(restoreInheritPath(home, unknown))).toBe(false);
    const unparseable = 'c'.repeat(32);
    writeFileSync(restoreInheritPath(home, unparseable), 'not json\n', { mode: 0o600 });
    expect(
      acceptRestoreDoor({
        home,
        nonce: unparseable,
        text: restoreDoorText(unparseable, dummySecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({ kind: 'refused', why: 'the token is not readable JSON' });
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

  test.skipIf(offDarwin)('a replayed token starts no second pass', async () => {
    const { root, home } = scratch();
    const { nonce, secret } = writeRestoreDoor({ version: 1, home, root, daemonPid }, { isAlive: noneAlive });
    const first = await runEntryInBackground(home, ['--inherited', nonce], root, restoreDoorText(nonce, secret));
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout.trim())).toEqual({ ok: true, result: { kind: 'no-recorded-session' } });
    // The token was spent by the first child: the same command line now refuses.
    const replayed = await runEntryInBackground(home, ['--inherited', nonce], root, restoreDoorText(nonce, secret));
    expect(replayed.status).toBe(2);
    expect(replayed.stdout).toBe('');
    expect(replayed.stderr).toContain('no one-use token names this child');
    expect(tokenFiles(home)).toEqual([]);
  });

  test.skipIf(offDarwin)('two children started with one token at once: exactly one runs the pass', async () => {
    const { root, home } = scratch();
    for (let round = 0; round < 4; round += 1) {
      const { nonce, secret } = writeRestoreDoor({ version: 1, home, root, daemonPid }, { isAlive: noneAlive });
      const doorText = restoreDoorText(nonce, secret);
      // Both start before either can finish: the claim is the file system's rename, which admits
      // one mover, so the race cannot hand the same token to both.
      const pair = await Promise.all([
        runEntryInBackground(home, ['--inherited', nonce], root, doorText),
        runEntryInBackground(home, ['--inherited', nonce], root, doorText),
      ]);
      const ran = pair.filter((one) => one.status === 0);
      const refused = pair.filter((one) => one.status === 2);
      expect(ran).toHaveLength(1);
      expect(JSON.parse(ran[0]!.stdout.trim())).toEqual({ ok: true, result: { kind: 'no-recorded-session' } });
      expect(refused).toHaveLength(1);
      expect(refused[0]!.stdout).toBe('');
      expect(refused[0]!.stderr).toContain('no one-use token names this child');
    }
    expect(tokenFiles(home)).toEqual([]);
  }, 30_000);

  test.skipIf(offDarwin)('a machine folder this child cannot claim in refuses the token', async () => {
    const { root, home } = scratch();
    const { nonce, secret } = writeRestoreDoor({ version: 1, home, root, daemonPid }, { isAlive: noneAlive });
    const dir = machineConfigDir(home);
    // Traversal and reading stay possible for this uid; only the claim (a rename in the folder)
    // is not. The token starts nothing.
    chmodSync(dir, 0o500);
    try {
      const ran = await runEntryInBackground(home, ['--inherited', nonce], root, restoreDoorText(nonce, secret));
      expect(ran.status).toBe(2);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain('no one-use token names this child');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test.skipIf(offDarwin)('the spawner runs the real pass and leaves no token behind', async () => {
    const { root, home } = scratch();
    expect(restoreEntryOf()).toBe(ENTRY);
    expect(await runRestoreSweepInChild({ home, root, timeoutMs: 60_000 })).toEqual({ kind: 'no-recorded-session' });
    expect(tokenFiles(home)).toEqual([]);
  }, 30_000);
});

describe("the daemon's beat while a restore pass runs", () => {
  test.skipIf(offDarwin)('a terminal host answering in five seconds holds the child, never the heartbeat', async () => {
    const { base, root, home } = scratch();
    // The route records a seat, so the pass reads the session's state and reaches the terminal
    // host. The fake answers every call after five seconds and logs the call first, so a landed
    // `session list` names the window the pass was inside.
    recordSeat(root);
    const bin = join(base, 'bin');
    const herdrLog = join(base, 'herdr.log');
    mkdirSync(bin, { recursive: true });
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

describe('independent adversarial checks: restore spawn abort, deadline, spawn error, early exit, and slow-host close', () => {
  test('abort before the listener, in the pre-check-to-listener window, and after the listener all discard the token and reject', async () => {
    const { base, root, home } = scratch();
    const sleeperEntry = join(base, 'sleeper-entry.ts');
    // A child entry that sleeps without claiming its token, so only the parent's discard removes the token.
    writeFileSync(
      sleeperEntry,
      `await new Promise((resolve) => setTimeout(resolve, 10_000));\n`,
    );

    // 1. Abort before the listener (`AbortSignal.abort()`): refuses before writing a token.
    await expect(
      runRestoreSweepInChild({
        home,
        root,
        entry: sleeperEntry,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('the restore pass was not started because the daemon is closing');
    expect(tokenFiles(home)).toEqual([]);

    // 2. Abort in the window between the pre-check (line 104) and the post-listener check (line 216):
    //    `aborted` reads false on the first read and true on the second read without firing an event.
    let abortedReads = 0;
    const windowSignal = {
      get aborted(): boolean {
        abortedReads += 1;
        return abortedReads >= 2;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      runRestoreSweepInChild({
        home,
        root,
        entry: sleeperEntry,
        signal: windowSignal,
      }),
    ).rejects.toThrow('the restore pass was ended because the daemon is closing');
    expect(abortedReads).toBeGreaterThanOrEqual(2);
    expect(tokenFiles(home)).toEqual([]);

    // 3. Abort after the listener while the child is running: rejects and discards the token.
    const controller = new AbortController();
    const running = runRestoreSweepInChild({
      home,
      root,
      entry: sleeperEntry,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    await expect(running).rejects.toThrow('the restore pass was ended because the daemon is closing');
    expect(tokenFiles(home)).toEqual([]);
  }, 20_000);

  test('deadline, spawn error, early exit, fabricated kind, and oversized frame all discard the token and never make up a result', async () => {
    const { base, root, home } = scratch();

    // 1. Deadline (`timeoutMs`): child never answers and does not claim the token -> parent discards token and rejects.
    const hangEntry = join(base, 'hang-entry.ts');
    writeFileSync(hangEntry, `await new Promise((resolve) => setTimeout(resolve, 10_000));\n`);
    await expect(
      runRestoreSweepInChild({ home, root, entry: hangEntry, timeoutMs: 120 }),
    ).rejects.toThrow(/did not answer within 0 s and was ended/);
    expect(tokenFiles(home)).toEqual([]);

    // 2. Spawn error (`cwd` does not exist -> asynchronous `'error'` event or missing stdio on child): discards token and rejects.
    const missingCwd = join(base, 'no-such-cwd');
    await expect(
      runRestoreSweepInChild({ home, root: missingCwd, entry: hangEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow(/the restore child (?:failed|could not be started|could not open its inherited door descriptor)/);
    expect(tokenFiles(home)).toEqual([]);

    // 3. Early exit without claiming token (exits 1 with stderr diagnostic): discards token and includes last stderr line.
    const earlyExitEntry = join(base, 'early-exit-entry.ts');
    writeFileSync(
      earlyExitEntry,
      `process.stderr.write('first line\\nfatal child diagnostic\\n');\nprocess.exit(1);\n`,
    );
    await expect(
      runRestoreSweepInChild({ home, root, entry: earlyExitEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow('the restore child left before it reported (code 1): fatal child diagnostic');
    expect(tokenFiles(home)).toEqual([]);

    // 4. Child writes non-protocol stdout or an unknown `result.kind` and exits 0: never resolves with a made-up result.
    const bogusKindEntry = join(base, 'bogus-kind-entry.ts');
    writeFileSync(
      bogusKindEntry,
      [
        `process.stdout.write('not json\\n');`,
        `process.stdout.write(JSON.stringify({ ok: true, result: { kind: 'made-up-kind' } }) + '\\n');`,
        `process.exit(0);`,
      ].join('\n'),
    );
    await expect(
      runRestoreSweepInChild({ home, root, entry: bogusKindEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow('the restore child left before it reported (code 0)');
    expect(tokenFiles(home)).toEqual([]);

    // 5. Child reports `{ ok: false, reason }` (and `{ ok: false }` without reason): rejects with the reported reason.
    const failReportEntry = join(base, 'fail-report-entry.ts');
    writeFileSync(
      failReportEntry,
      [
        `import { discardRestoreInherit } from ${JSON.stringify(fileURLToPath(new URL('../src/daemon/restore/token.ts', import.meta.url)))};`,
        `const at = process.argv.indexOf('--inherited');`,
        `discardRestoreInherit(process.env.HOME ?? '', process.argv[at + 1] ?? '');`,
        `process.stdout.write(JSON.stringify({ ok: false, reason: 'synthetic pass failure' }) + '\\n');`,
      ].join('\n'),
    );
    await expect(
      runRestoreSweepInChild({ home, root, entry: failReportEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow('the restore child reported: synthetic pass failure');
    expect(tokenFiles(home)).toEqual([]);

    // 6. Oversized stdout line (> 64 KiB without newline): rejects with frame limit error and never fabricates a result.
    const oversizedEntry = join(base, 'oversized-entry.ts');
    writeFileSync(
      oversizedEntry,
      [
        `import { discardRestoreInherit } from ${JSON.stringify(fileURLToPath(new URL('../src/daemon/restore/token.ts', import.meta.url)))};`,
        `const at = process.argv.indexOf('--inherited');`,
        `discardRestoreInherit(process.env.HOME ?? '', process.argv[at + 1] ?? '');`,
        `process.stdout.write('x'.repeat(70 * 1024));`,
        `await new Promise((resolve) => setTimeout(resolve, 1_000));`,
      ].join('\n'),
    );
    await expect(
      runRestoreSweepInChild({ home, root, entry: oversizedEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow('the restore child wrote a line over the frame limit and was not understood');
    expect(tokenFiles(home)).toEqual([]);
  }, 30_000);

  test.skipIf(offDarwin)('a token for one root never touches a second root, and closing the daemon during a slow herdr call keeps the beat live and leaves no token behind', async () => {
    const { base, root: rootA, home } = scratch();
    const rootB = join(base, 'repo-b');
    mkdirSync(join(rootB, '.agents'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: rootB });
    writeFileSync(join(rootB, '.agents', 'team.yaml'), TEAM.replace('project: restore-child', 'project: restore-child-b').replace('session: sweep', 'session: sweep-b'));
    recordSeat(rootA);
    recordSeat(rootB);

    const bin = join(base, 'bin');
    const herdrLog = join(base, 'herdr.log');
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'herdr');
    writeFileSync(
      shim,
      `#!/bin/sh
printf '%s|%s\\n' "$(pwd)" "$*" >> "$TEAM_TEST_HERDR_LOG"
sleep 2
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
    try {
      // 1. Running a child token scoped to `rootA` only touches `rootA` and never `rootB`.
      const resultA = await runRestoreSweepInChild({ home, root: rootA, timeoutMs: 15_000 });
      expect(resultA).toEqual({ kind: 'not-running', state: 'absent' });
      const logAfterA = existsSync(herdrLog) ? readFileSync(herdrLog, 'utf8') : '';
      expect(logAfterA).toContain(`${rootA}|session list`);
      expect(logAfterA).not.toContain(rootB);
      expect(tokenFiles(home)).toEqual([]);

      // 2. Starting the machine daemon while `herdr` sleeps 2s keeps the beat ticking, and closing the
      //    daemon mid-call aborts the in-flight restore child cleanly with no leftover token.
      writeFileSync(herdrLog, '');
      const started = await startMachineDaemon({
        home,
        roots: [rootA],
        startedBy: 'test',
        version: '0.6.0-test',
        heartbeatMs: 150,
        choresHosting: false,
      });
      expect(started.kind).toBe('serving');
      if (started.kind !== 'serving') return;

      const beats: number[] = [];
      let last = '';
      const sampleUntil = Date.now() + 900;
      while (Date.now() < sampleUntil) {
        const read = readDaemonState(home);
        if (read.kind === 'ok' && read.state.heartbeatAt !== last) {
          last = read.state.heartbeatAt;
          beats.push(Date.parse(last));
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Beat ticked multiple times while the child was inside the 2s `herdr` sleep.
      expect(beats.length).toBeGreaterThanOrEqual(3);
      await started.daemon.close();
      expect(tokenFiles(home)).toEqual([]);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedLog === undefined) delete process.env.TEAM_TEST_HERDR_LOG;
      else process.env.TEAM_TEST_HERDR_LOG = savedLog;
    }
  }, 40_000);
});

