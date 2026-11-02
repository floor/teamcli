// `team daemon install` never writes a client key or a general grant into the unit. The grant and
// key may admit the install itself, but the service-started run is admitted by its own
// `--started-by service-manager`, so a definition that named either would keep a credential on
// disk for no reason. Every home, program, unit and manager response here is synthetic: no scene
// reads a real unit, a real key or a real grant.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { keyOf } from '../src/store/keys.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { refreshFixture } from './adapters/service-refresh-fixture.ts';
import { testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');
type Fixture = ReturnType<typeof refreshFixture>;

function sources(fixture: Fixture) {
  return {
    home: fixture.home,
    program: fixture.program,
    service: fixture.manager,
    health: fixture.health,
    sleep: fixture.healthSleep,
  };
}

async function install(fixture: Fixture, argv: string[], caller: Caller = { kind: 'owner' }): Promise<{ code: number; io: TestIo }> {
  const io = testIo(fixture.root, caller);
  const code = await runDaemon(['install', ...argv], io, sources(fixture));
  return { code, io };
}

/** Writes an earlier unit at the adapter's path, in the shape a version that persisted the
 *  install's authorization left behind. */
function seedUnit(fixture: Fixture, named: { grant?: boolean; key?: boolean }): { grant: string; key: string } {
  const grant = join(fixture.home, 'synthetic-old-grant.json');
  const key = join(fixture.home, 'synthetic-old-client.key');
  const extra: string[] = [];
  if (named.grant === true) extra.push('--general', grant);
  if (named.key === true) extra.push('--key', key);
  const unit = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/synthetic/runtime</string>
    <string>${fixture.nextEntry}</string>
    <string>daemon</string>
    <string>run</string>
    <string>--started-by</string>
    <string>service-manager</string>
${extra.map((argument) => `    <string>${argument}</string>`).join('\n')}
  </array>
</dict>
</plist>
`;
  mkdirSync(dirname(fixture.unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(fixture.unitPath, unit, { mode: 0o600 });
  return { grant, key };
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

test('a fresh install writes no client key or general grant into the unit', async () => {
  const fixture = refreshFixture();
  const key = join(fixture.home, 'synthetic-client.key');
  const grant = join(fixture.home, 'synthetic-grant.json');
  const keyMaterial = 'synthetic-private-key-material-DO-NOT-PRINT';
  writeFileSync(key, keyMaterial, { mode: 0o600 });
  writeFileSync(grant, JSON.stringify({ synthetic: true, proof: 'synthetic-grant-proof-DO-NOT-PRINT' }), { mode: 0o600 });
  const io = testIo(fixture.root, { kind: 'owner' });
  io.general = { key, grant, grantId: 'gg_synthetic', clientId: 'synthetic-client' };

  const code = await runDaemon(['install', '--json'], io, sources(fixture));

  expect(code).toBe(0);
  const unit = readFileSync(fixture.unitPath, 'utf8');
  expect(unit).not.toContain(key);
  expect(unit).not.toContain(grant);
  expect(unit).not.toContain('--general');
  expect(unit).not.toContain('--key');
  const document = JSON.parse(io.out) as { program: string[]; dropped_authorization?: boolean };
  expect(document.program).not.toContain('--general');
  expect(document.program).not.toContain('--key');
  expect(document.program).not.toContain(key);
  expect(document.program).not.toContain(grant);
  // Nothing was written before either: the install never reads the key or the grant it was
  // admitted with, and never prints their contents.
  expect(io.out).not.toContain('synthetic-private-key-material');
  expect(io.out).not.toContain('synthetic-grant-proof');
  expect(readFileSync(key, 'utf8')).toBe(keyMaterial);
  expect(document.dropped_authorization).toBeUndefined();
});

test('an earlier unit that named a grant and a key is rewritten without them, and the run says so', async () => {
  const fixture = refreshFixture();
  const seeded = seedUnit(fixture, { grant: true, key: true });

  const { code, io } = await install(fixture, []);

  expect(code).toBe(0);
  const unit = readFileSync(fixture.unitPath, 'utf8');
  expect(unit).not.toContain(seeded.grant);
  expect(unit).not.toContain(seeded.key);
  expect(unit).not.toContain('--general');
  expect(unit).not.toContain('--key');
  expect(io.out).toContain('the earlier unit named a client key or a general grant; this unit was rewritten without either');
  expect(io.out).not.toContain(seeded.grant);
  expect(io.out).not.toContain(seeded.key);
});

test('an earlier unit that named only one of them is rewritten too, and a structured run says it in a field', async () => {
  for (const named of [{ grant: true, key: false }, { grant: false, key: true }]) {
    const fixture = refreshFixture();
    const seeded = seedUnit(fixture, named);

    const { code, io } = await install(fixture, ['--json']);

    expect(code).toBe(0);
    const document = JSON.parse(io.out) as { program: string[]; dropped_authorization?: boolean };
    expect(document.dropped_authorization).toBe(true);
    expect(document.program).not.toContain(seeded.grant);
    expect(document.program).not.toContain(seeded.key);
    const unit = readFileSync(fixture.unitPath, 'utf8');
    expect(unit).not.toContain(seeded.grant);
    expect(unit).not.toContain(seeded.key);
    expect(unit).not.toContain('--general');
    expect(unit).not.toContain('--key');
  }
});

test('a fresh install has nothing to say about authorization', async () => {
  const fixture = refreshFixture();

  const { code, io } = await install(fixture, ['--json']);

  expect(code).toBe(0);
  expect((JSON.parse(io.out) as { dropped_authorization?: boolean }).dropped_authorization).toBeUndefined();
});

test('machine dev mode admits the placed orchestrator to install with no grant, and the unit stays clean', async () => {
  const fixture = refreshFixture();
  seedMachine(fixture);
  recordSeat(fixture, 'clerk', 'pane1');

  const { code, io } = await install(fixture, [], { kind: 'seat', name: 'clerk', pane: 'pane1', session: 'sample' });

  expect(code).toBe(0);
  expect(io.err).toContain('warning: only the owner, a general grant naming daemon, or a lead in development mode installs, restarts or removes the machine daemon; this call is clerk; dev mode continues');
  expect(io.err).toContain('dev-mode on at machine level');
  expect(io.out).toContain('installed for');
  const unit = readFileSync(fixture.unitPath, 'utf8');
  expect(unit).not.toContain('--general');
  expect(unit).not.toContain('--key');
});

test('machine dev mode does not admit an operator that is not the team lead', async () => {
  // The team file names op-1 the operator, and its resolved lead is clerk. The owner widening is
  // the one placed orchestrator's, so the operator alone is refused and nothing is written.
  const fixture = refreshFixture();
  seedMachine(fixture);
  recordSeat(fixture, 'op-1', 'pane2');

  const { code, io } = await install(fixture, [], { kind: 'seat', name: 'op-1', pane: 'pane2', session: 'sample' });

  expect(code).toBe(1);
  expect(io.err).toContain('only the owner, a general grant naming daemon, or a lead in development mode installs, restarts or removes the machine daemon; this call is op-1');
  expect(existsSync(fixture.unitPath)).toBe(false);
});
