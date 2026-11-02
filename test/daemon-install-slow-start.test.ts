// The install's cold-start window. A daemon the service manager starts may take 18-30 seconds
// to bind and answer with five hosted checkouts under load, and the window this lane replaced
// held eight probes over about 4.5 seconds — it called such a daemon absent while it was still
// coming up. These synthetic scenes stand in for the service manager's commands and the daemon's
// health reading, so nothing here starts a process, opens a socket or sleeps for real. They
// prove three answers: a daemon that answers after the measured cold start is a successful
// install; one whose process is alive but has not answered by the end of the window is reported
// as still starting and left alone; one that no process stands behind is taken back out.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { runDaemon } from '../src/commands/daemon.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { refreshFixture } from './adapters/service-refresh-fixture.ts';
import { testIo } from './helpers.ts';

type Fixture = ReturnType<typeof refreshFixture>;
type ErrorDocument = { error: { id: string; message: string; repair: string | null } };

async function install(fixture: Fixture, flags: string[] = []) {
  const io = testIo(fixture.root, { kind: 'owner' });
  const code = await runDaemon(['install', ...flags], io, {
    home: fixture.home,
    program: fixture.program,
    service: fixture.manager,
    health: fixture.health,
    sleep: fixture.healthSleep,
  });
  return { code, io };
}

test('a daemon that answers after the measured cold start is still a successful install', async () => {
  const fixture = refreshFixture();
  // The first nine health reads find a live process that has not answered yet: the cold starts
  // this lane was opened for ran 18-30 seconds, and the old window gave up at about 4.5.
  fixture.setProbeDelay(9);

  const { code, io } = await install(fixture, ['--json']);

  expect(code, io.out + io.err).toBe(0);
  const document = JSON.parse(io.out) as { installed: boolean };
  expect(document.installed).toBe(true);
  expect(fixture.healthReads).toHaveLength(10);
  // The waits reach 39.75 seconds, past the top of the measured cold start, and no more.
  expect(fixture.healthWaits.reduce((sum, wait) => sum + wait, 0)).toBe(39_750);
  // The install never treated the starting daemon as a failure: nothing was stopped and the
  // definition it wrote is the one in place.
  expect(fixture.events.filter((event) => event.kind === 'stop')).toHaveLength(0);
  expect(existsSync(fixture.unitPath)).toBe(true);
  expect(fixture.running()).toBe('next');
});

test('a daemon no process stands behind is taken back out, and the empty machine is named', async () => {
  const fixture = refreshFixture();
  // The manager takes the load but starts no process: the state a unit whose program cannot
  // start leaves, which is the one kind of silence an undo is for.
  fixture.setPolicy('accept-dead');

  const { code, io } = await install(fixture, ['--json']);

  expect(code).toBe(1);
  const document = JSON.parse(io.out) as ErrorDocument;
  expect(document.error.id).toBe('daemon.install-failed');
  expect(document.error.message).toContain('did not answer the health probe');
  expect(document.error.repair).toContain('team daemon install');
  // The definition the install wrote is removed again, and nothing runs.
  expect(existsSync(fixture.unitPath)).toBe(false);
  expect(fixture.running()).toBeNull();
  // The bounded window was used: sixteen probes over 87.75 seconds of waits, no more.
  expect(fixture.healthReads).toHaveLength(16);
  expect(fixture.healthWaits.reduce((sum, wait) => sum + wait, 0)).toBe(87_750);
  // The log carries the statement the one-line report has no room for, and it is true here.
  expect(readFileSync(daemonLogPath(fixture.home), 'utf8')).toContain('no earlier unit was installed, so no daemon is running');
});

for (const json of [false, true]) {
  test(`a daemon still alive at the end of the window is reported as starting, never as absent (${json ? 'structured' : 'plain'})`, async () => {
    const fixture = refreshFixture();
    fixture.setProbeDelay(Infinity);

    const { code, io } = await install(fixture, json ? ['--json'] : []);

    expect(code).toBe(1);
    const error = json ? (JSON.parse(io.out) as ErrorDocument).error : null;
    if (error !== null) {
      expect(error.id).toBe('daemon.install-failed');
      expect(error.message).toContain('may still be starting');
      expect(error.message).not.toContain('no daemon is running');
      expect(error.repair).toBeNull();
    }
    const message = error === null ? io.err : error.message;
    expect(message).toContain('may still be starting');
    expect(message).not.toContain('no daemon is running');
    if (!json) expect(io.err).toContain('check `team status`');
    // The unit stays, the daemon it started is still the one the manager holds, and nothing
    // stopped it: it may still come up, so taking it back out would be the bug this fixes.
    expect(existsSync(fixture.unitPath)).toBe(true);
    expect(fixture.running()).toBe('next');
    expect(fixture.events.filter((event) => event.kind === 'stop')).toHaveLength(0);
    expect(fixture.healthReads).toHaveLength(16);
    expect(readFileSync(daemonLogPath(fixture.home), 'utf8')).toContain('the new daemon is still starting and has not answered the health probe');
  });
}
