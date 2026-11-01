// Independent refresh scenes. All homes, binaries and manager responses are synthetic.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDaemon } from '../src/commands/daemon.ts';
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
  });
  return { code, io };
}

function contractMatches(id: string, code: number) {
  const contract = JSON.parse(readFileSync(new URL('../contract/exit-codes.json', import.meta.url), 'utf8')) as {
    rows: { command: string; id: string; code: number; meaning: string }[];
  };
  const rows = contract.rows.filter((row) => row.command === 'daemon' && row.id === id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.code).toBe(code);
  return rows[0]?.meaning ?? '';
}

function snapshot(home: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path] = readFileSync(path).toString('base64');
    }
  }
  return files;
}

test('one refused load gets exactly one further offer and exits successfully', async () => {
  const fixture = refreshFixture();
  fixture.seedPrevious();

  const { code, io } = await install(fixture, ['--json']);

  expect(code).toBe(0);
  expect(JSON.parse(io.out)).toMatchObject({ installed: true, dry_run: false });
  expect(io.err).toBe('');
  expect(fixture.events.map((event) => [event.kind, event.accepted])).toEqual([
    ['load', false], ['stop', true], ['load', true],
  ]);
  expect(fixture.running()).toBe('next');
  expect(fixture.waits).toEqual([]);
});

test('persistent replacement refusal starts the previous binary from the restored unit and matches its exit row', async () => {
  const fixture = refreshFixture();
  const original = fixture.seedPrevious();
  const binary = readFileSync(fixture.previousEntry);
  fixture.setPolicy('reject-new');

  const { code, io } = await install(fixture, ['--json']);

  expect(fixture.running()).toBe('previous');
  expect(readFileSync(fixture.unitPath, 'utf8')).toBe(original);
  expect(readFileSync(fixture.previousEntry)).toEqual(binary);
  expect(fixture.events.at(-1)).toMatchObject({ kind: 'load', unit: original, accepted: true });
  expect(fixture.events.some((event) => event.kind === 'load' && event.unit.includes(fixture.nextEntry) && event.accepted)).toBe(false);
  expect(code).toBe(1);
  const document = JSON.parse(io.out) as ErrorDocument;
  expect(document.error.id).toBe('daemon.install-rolled-back');
  expect(document.error.message).toMatch(/previous.*(put back|restor).*start/i);
  expect(contractMatches(document.error.id, code)).toMatch(/previous.*start/i);
});

test('a refused rollback reports the empty running state and its own nonzero exit row', async () => {
  const fixture = refreshFixture();
  const original = fixture.seedPrevious();
  fixture.setPolicy('reject-all');

  const { code, io } = await install(fixture, ['--json']);

  expect(fixture.running()).toBeNull();
  expect(readFileSync(fixture.unitPath, 'utf8')).toBe(original);
  expect(code).toBe(1);
  const document = JSON.parse(io.out) as ErrorDocument;
  expect(document.error.id).toBe('daemon.install-rollback-failed');
  expect(document.error.message).toMatch(/no daemon (?:is running|was started)/i);
  expect(contractMatches(document.error.id, code)).toMatch(/no daemon/i);
});

for (const json of [false, true]) {
  test(`a refused rollback gives an actionable recovery instruction (${json ? 'structured' : 'plain'})`, async () => {
    const fixture = refreshFixture();
    fixture.seedPrevious();
    fixture.setPolicy('reject-all');

    const { code, io } = await install(fixture, json ? ['--json'] : []);

    expect(code).toBe(1);
    const document = json ? JSON.parse(io.out) as ErrorDocument : null;
    const message = document === null ? io.err : `${document.error.message} ${document.error.repair ?? ''}`;
    expect(message).toMatch(/no daemon (?:is running|was started)/i);
    // A diagnosis alone does not tell the operator how to get a daemon running again.
    expect(message).toMatch(/(?:run|retry|repeat|reinstall|start|recover)[^\n]*team daemon (?:install|run)|team daemon (?:install|run)[^\n]*(?:retry|again|recover)/i);
  });
}

test('an unload still in flight is allowed to finish before the next unit starts', async () => {
  const fixture = refreshFixture();
  fixture.seedPrevious();
  fixture.setPolicy('slow-stop');

  const { code } = await install(fixture);

  expect(code).toBe(0);
  expect(fixture.running()).toBe('next');
  const loads = fixture.events.filter((event) => event.kind === 'load');
  expect(loads.filter((event) => !event.accepted).length).toBeGreaterThanOrEqual(2);
  expect(loads.at(-1)?.at).toBeGreaterThanOrEqual(250);
  expect(fixture.events.filter((event) => event.kind === 'stop')).toHaveLength(1);
  expect(fixture.waits.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(6_000);
});

for (const json of [false, true]) {
  test(`dry run explains bounded retries and rollback without changing the existing files or running state (${json ? 'structured' : 'plain'})`, async () => {
    const fixture = refreshFixture();
    fixture.seedPrevious();
    fixture.setPolicy('reject-all');
    const before = snapshot(fixture.home);

    const { code, io } = await install(fixture, ['--dry-run', ...(json ? ['--json'] : [])]);

    expect(code).toBe(0);
    expect(fixture.events).toEqual([]);
    expect(fixture.waits).toEqual([]);
    expect(fixture.running()).toBe('previous');
    expect(snapshot(fixture.home)).toEqual(before);
    const text = json ? (JSON.parse(io.out) as { steps: string[] }).steps?.join('\n') ?? '' : io.out;
    expect(text).toMatch(/bounded.*wait/i);
    expect(text).toMatch(/previous unit.*put back.*start/i);
  });
}

test('permanent refusal bounds both forward and rollback effort', async () => {
  const fixture = refreshFixture();
  fixture.seedPrevious();
  fixture.setPolicy('reject-all');

  const { code } = await install(fixture);

  expect(code).toBe(1);
  expect(fixture.events.some((event) => event.kind === 'load' && event.unit.includes(fixture.previousEntry))).toBe(true);
  expect(fixture.events.filter((event) => event.kind === 'load').length).toBeLessThanOrEqual(20);
  expect(fixture.waits.length).toBeGreaterThan(0);
  expect(fixture.waits.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(12_000);
  expect(fixture.running()).toBeNull();
});

test('a first install whose load never succeeds finishes within six seconds of waits', () => {
  const worker = fileURLToPath(new URL('./adapters/service-refresh-fixture.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker], {
    cwd: dirname(worker), encoding: 'utf8', timeout: 9_000,
  });

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const document = JSON.parse(child.stdout) as { result: { ok: boolean }; elapsed: number; loads: number };
  expect(document.result.ok).toBe(false);
  expect(document.loads).toBeGreaterThan(2);
  expect(document.loads).toBeLessThanOrEqual(10);
  expect(document.elapsed).toBeLessThan(7_000);
}, 12_000);

for (const json of [false, true]) {
  test(`recovery output keeps synthetic grant and key contents private (${json ? 'structured' : 'plain'})`, async () => {
    const fixture = refreshFixture();
    fixture.seedPrevious();
    fixture.setPolicy('reject-all');
    const key = join(fixture.home, 'synthetic-client.key');
    const grant = join(fixture.home, 'synthetic-grant.json');
    const keyMaterial = 'synthetic-private-key-material-DO-NOT-PRINT';
    const grantContents = JSON.stringify({ synthetic: true, proof: 'synthetic-grant-proof-DO-NOT-PRINT' });
    writeFileSync(key, keyMaterial, { mode: 0o600 });
    writeFileSync(grant, grantContents, { mode: 0o600 });
    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runDaemon(['install', '--root', fixture.root, '--presence', '--watch', ...(json ? ['--json'] : [])], {
      ...io, general: { key, grant },
    }, { home: fixture.home, program: fixture.program, service: fixture.manager });

    expect(code).toBe(1);
    expect(fixture.events.some((event) => event.unit.includes(key) && event.unit.includes(grant))).toBe(true);
    const output = io.out + io.err;
    expect(output).not.toContain(keyMaterial);
    expect(output).not.toContain(grantContents);
    expect(output).not.toContain('synthetic-grant-proof-DO-NOT-PRINT');
    const recovery = json ? (JSON.parse(io.out) as ErrorDocument).error.repair ?? '' : io.err;
    expect(recovery).toContain('team daemon install');
    expect(recovery).toContain(fixture.root);
    expect(recovery).toContain('--presence');
    expect(recovery).toContain('--watch');
    expect(readFileSync(key, 'utf8')).toBe(keyMaterial);
    expect(readFileSync(grant, 'utf8')).toBe(grantContents);
  });
}
