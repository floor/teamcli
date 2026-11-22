// `team daemon restart` and the general-grant admission of the daemon's install and restart
// verbs, measured on synthetic homes. A restart stops the daemon the service manager holds under
// the installed unit and loads that same unit again; nothing is written, and success is reported
// only after the daemon answers the health reading. A verified general grant whose ops name
// `daemon` admits install and restart with no owner caller and no terminal; a worker is refused.
// Every home, grant, key, program, unit and manager response here is synthetic: no scene reads a
// real unit, key or grant, and no scene runs a service manager command.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { generalDoor } from '../src/client/general-door.ts';
import { type GrantOp, issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { keyOf } from '../src/store/keys.ts';
import { refreshFixture } from './adapters/service-refresh-fixture.ts';
import { testIo, type TestIo } from './helpers.ts';

// One fixed clock: the grant is issued and verified before its expiry under both this clock and
// the door's own (the real one), so every scene reads the same chain.
const NOW = new Date('2026-11-02T12:00:00.000Z');
const ISSUED = new Date('2026-11-02T00:00:00.000Z');
const EXPIRES = new Date('2027-01-01T00:00:00.000Z');
type Fixture = ReturnType<typeof refreshFixture>;

/** The fixture's base sits under this checkout, not the OS temp folder: the scenes that write a
 *  client key go through the key's own placement rule, which refuses a folder overlapping it. */
const scratch: string[] = [];
function fixtureScene(inPlace = false): Fixture {
  const fixture = refreshFixture(false, inPlace, process.cwd());
  scratch.push(fixture.base);
  return fixture;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function sourcesOf(fixture: Fixture) {
  return {
    home: fixture.home,
    program: fixture.program,
    service: fixture.manager,
    health: fixture.health,
    sleep: fixture.healthSleep,
    now: () => NOW,
  };
}

/** One synthetic client principal and the owner's grant naming it, with these ops. */
function grantFor(home: string, ops: GrantOp[]): { grant: string; key: string; grantId: string; clientId: string } {
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-a'), pair);
  if (!written.ok) throw new Error(written.why);
  const issued = issueOwnerGeneralGrant(home, {
    clientId: 'client-a',
    publicKey: pair.publicKey,
    entities: ['*'],
    ops,
    mayIssue: false,
    expires: EXPIRES,
  }, ISSUED);
  if (!issued.ok) throw new Error(issued.why);
  return { grant: issued.path, key: written.keyPath, grantId: issued.grant.grant_id, clientId: 'client-a' };
}

/** A caller the walk cannot place and that runs with no terminal: a grant holder the owner's
 *  grant alone must admit. */
const grantCaller: Caller = { kind: 'unplaced', reason: 'its stdin is not a terminal' };

function sceneIo(fixture: Fixture, caller: Caller = grantCaller): TestIo {
  const io = testIo(fixture.root, caller);
  // The door reads HOME for the grant chain; the command's home is the same synthetic one.
  io.env = { HOME: fixture.home };
  return io;
}

/** The owner's machine switch, written the way the command writes it, in a synthetic home. */
function seedMachine(fixture: Fixture): void {
  keyOf(fixture.home);
  const written = writeDevelopmentMode({ home: fixture.home, mode: 'local-fast', now: NOW, caller: 'test' });
  if (!written.ok) throw new Error(written.why);
}

/** One seat in the session state the placement check reads. */
function recordSeat(fixture: Fixture, name: string, pane: string): void {
  writeFileSync(
    join(fixture.root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { sample: { seats: { [name]: { stage: 'ready', pane } }, worktrees: {} } } }, null, 2)}\n`,
  );
}

test('a verified general grant admits daemon install with no owner caller and no terminal', async () => {
  const fixture = fixtureScene();
  const named = grantFor(fixture.home, ['daemon']);
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['install', '--json'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(0);
  const document = JSON.parse(io.out) as { installed: boolean; program: string[] };
  expect(document.installed).toBe(true);
  expect(io.err).not.toContain('only the owner');
  // The grant and the key admitted the run; neither is ever written into the unit.
  const unit = readFileSync(fixture.unitPath, 'utf8');
  expect(unit).not.toContain(named.grant);
  expect(unit).not.toContain(named.key);
  expect(document.program).not.toContain('--general');
  expect(document.program).not.toContain('--key');
});

test('the door refuses a grant whose ops do not name daemon, and install never runs', () => {
  const fixture = fixtureScene();
  const named = grantFor(fixture.home, ['status']);
  const scene = sceneIo(fixture);

  const result = generalDoor('daemon', ['install', '--dry-run', '--general', named.grant, '--key', named.key], scene);

  expect(result.kind).toBe('refused');
  if (result.kind === 'refused') expect(result.why).toContain('does not cover daemon');
  expect(scene.out).toBe('');
  expect(scene.err).toBe('');
  expect(fixture.events).toEqual([]);
});

test('a grant recorded on the run is verified again by the command, and an op it lacks is refused', async () => {
  const fixture = fixtureScene();
  const named = grantFor(fixture.home, ['status']);
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['install', '--dry-run', '--json'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(1);
  const document = JSON.parse(io.out) as { error: { id: string; rule?: string } };
  expect(document.error.id).toBe('daemon.grant-refused');
  expect(document.error.rule).toBe('general-grant');
  expect(JSON.parse(io.out).error.message).toContain('does not cover daemon');
  expect(fixture.events).toEqual([]);
});

test('a seat that is not the owner and holds no grant is refused install and restart, and the manager is never called', async () => {
  const fixture = fixtureScene();
  fixture.seedPrevious();
  const worker: Caller = { kind: 'seat', name: 'op-1', pane: 'pane2' };
  const io = testIo(fixture.root, worker);

  const install = await runDaemon(['install', '--dry-run'], io, sourcesOf(fixture));
  expect(install, io.out + io.err).toBe(1);
  expect(io.err).toContain('only the owner, a general grant naming daemon, or a lead in development mode installs, restarts or removes the machine daemon; this call is op-1');

  const restart = await runDaemon(['restart'], io, sourcesOf(fixture));
  expect(restart, io.out + io.err).toBe(1);
  expect(fixture.events).toEqual([]);
});

test('a verified grant admits restart through the door, which stops and starts the installed unit and writes nothing', async () => {
  const fixture = fixtureScene(true);
  const named = grantFor(fixture.home, ['*']);
  fixture.seedPrevious();
  const unitBefore = readFileSync(fixture.unitPath, 'utf8');
  const scene = sceneIo(fixture);

  const result = generalDoor('daemon', ['restart', '--json', '--general', named.grant, '--key', named.key], scene);
  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') return;
  const code = await runDaemon(result.argv, result.io, sourcesOf(fixture));

  expect(code, scene.out + scene.err).toBe(0);
  expect(fixture.events.map((one) => one.kind)).toEqual(['stop', 'load']);
  expect(fixture.events[1]?.accepted).toBe(true);
  expect(fixture.events[1]?.identity).toBe('previous');
  expect(fixture.running()).toBe('previous');
  const document = JSON.parse(scene.out) as { restarted: boolean; command: string };
  expect(document.command).toBe('restart');
  expect(document.restarted).toBe(true);
  // The installed definition is the one that ran: a restart never rewrites it.
  expect(readFileSync(fixture.unitPath, 'utf8')).toBe(unitBefore);
});

test('a restart after a new build refreshes the runtime copy, so the daemon runs the installed program', async () => {
  // The unit was installed from the previous program; the installed program is now the next one.
  // Reloading the same unit would run the old copy: the restart refreshes it as an install does.
  const fixture = fixtureScene();
  const named = grantFor(fixture.home, ['*']);
  fixture.seedPrevious();
  const scene = sceneIo(fixture);

  const result = generalDoor('daemon', ['restart', '--json', '--general', named.grant, '--key', named.key], scene);
  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') return;
  const code = await runDaemon(result.argv, result.io, sourcesOf(fixture));

  expect(code, scene.out + scene.err).toBe(0);
  expect(fixture.running()).toBe('next');
  const document = JSON.parse(scene.out) as { restarted: boolean; refreshed?: boolean };
  expect(document.restarted).toBe(true);
  expect(document.refreshed).toBe(true);
});

test('restart --dry-run prints the plan and stops or starts nothing', async () => {
  const fixture = fixtureScene();
  const named = grantFor(fixture.home, ['daemon']);
  fixture.seedPrevious();
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['restart', '--dry-run', '--json'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(0);
  const document = JSON.parse(io.out) as { dry_run: boolean; restarted: boolean };
  expect(document.dry_run).toBe(true);
  expect(document.restarted).toBe(false);
  expect(fixture.events).toEqual([]);
});

test('restart on a machine with no installed unit is refused and stops nothing', async () => {
  const fixture = fixtureScene();
  const named = grantFor(fixture.home, ['daemon']);
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['restart', '--json'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(1);
  const document = JSON.parse(io.out) as { error: { id: string; repair: string } };
  expect(document.error.id).toBe('daemon.not-installed');
  expect(document.error.repair).toContain('team daemon install');
  expect(fixture.events).toEqual([]);
});

test('a restarted daemon that answers late is restarted, never stopped again', async () => {
  // A daemon hosting several checkouts on a loaded machine answers seconds after its load: the
  // restart waits the cold-start window an install gives, and the late answer is a restart.
  const fixture = fixtureScene(true);
  const named = grantFor(fixture.home, ['daemon']);
  fixture.seedPrevious();
  fixture.setProbeDelay(8);
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['restart'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(0);
  expect(io.out).toContain('restarted');
  expect(fixture.events.filter((one) => one.kind === 'stop').length).toBe(1);
  expect(fixture.running()).toBe('previous');
});

test('a restarted daemon alive and silent through the window is reported starting, and left running', async () => {
  const fixture = fixtureScene(true);
  const named = grantFor(fixture.home, ['daemon']);
  fixture.seedPrevious();
  fixture.setProbeDelay(100);
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['restart', '--json'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(0);
  const document = JSON.parse(io.out) as { restarted: boolean; starting?: boolean };
  expect(document.restarted).toBe(true);
  expect(document.starting).toBe(true);
  expect(fixture.events.filter((one) => one.kind === 'stop').length).toBe(1);
  expect(fixture.running()).toBe('previous');
});

test('a restarted daemon whose process is gone leaves no daemon, says so and names the install', async () => {
  const fixture = fixtureScene(true);
  const named = grantFor(fixture.home, ['daemon']);
  fixture.seedPrevious();
  // Every load is taken and starts nothing: the restarted daemon and the one started again are dead.
  fixture.setPolicy('accept-dead');
  const io = sceneIo(fixture);
  io.general = named;

  const code = await runDaemon(['restart', '--json'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(1);
  const document = JSON.parse(io.out) as { error: { id: string; message: string; repair: string } };
  expect(document.error.id).toBe('daemon.restart-rollback-failed');
  expect(document.error.message).toContain('no daemon is running');
  expect(document.error.repair).toContain('team daemon install');
});

test('the owner\'s dev-mode lift admits a placed lead to restart', async () => {
  const fixture = fixtureScene();
  fixture.seedPrevious();
  seedMachine(fixture);
  recordSeat(fixture, 'clerk', 'pane1');
  const io = testIo(fixture.root, { kind: 'seat', name: 'clerk', pane: 'pane1', session: 'sample' });

  const code = await runDaemon(['restart'], io, sourcesOf(fixture));

  expect(code, io.out + io.err).toBe(0);
  expect(io.err).toContain('warning: only the owner, a general grant naming daemon, or a lead in development mode installs, restarts or removes the machine daemon');
  expect(io.err).toContain('dev mode continues');
  expect(io.out).toContain('team daemon: restarted');
  expect(existsSync(join(fixture.root, '.agents', 'team.state.json'))).toBe(true);
});
