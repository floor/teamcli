// A seat's webhook row is resolved when the bus starts (src/bus/webhook.ts). This scene changes
// the row in the root's registry record while the bus is running: the next arrival must take the
// new row, a delivery already in flight must keep the row it started on, and another root's bus
// must keep its own rows. Every receiver is a synthetic listener on a loopback port; the registry
// lives in the scene's own temp home, never the real one.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { readArgs } from '../src/args.ts';
import { startBus } from '../src/bus/server.ts';
import { runTeamImport } from '../src/commands/migrate.ts';
import { canonicalTeam, readTeamConfig } from '../src/file/team-config.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readStoredTeamConfig, sha256, teamConfigRecordPath } from '../src/registry/team-config-store.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = () => new Date('2026-11-02T00:00:00.000Z');
const made: string[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];
const buses: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-webhook-reload-')));
  made.push(base);
  return base;
}

type Hit = { path: string; authorization: string; body: string };
type Receiver = { url: string; hits: Hit[]; respond: (hit: Hit) => Response | Promise<Response> };

/** A loopback routine that records every POST and answers with `respond`. */
function receiver(respond: (hit: Hit) => Response | Promise<Response> = () => new Response('ok', { status: 200 })): Receiver {
  const hits: Hit[] = [];
  const seen = { hits, respond, url: '' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const hit: Hit = {
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization') ?? '',
        body: await request.text(),
      };
      hits.push(hit);
      return seen.respond(hit);
    },
  });
  servers.push(server);
  seen.url = `http://127.0.0.1:${server.port}/routine`;
  return seen;
}

/** The two files a webhook row names: the routine's URL, and the secret only the POST may carry. */
function hookFiles(base: string, name: string, url: string, secret = 'synthetic-secret-value'): { urlFile: string; secretFile: string } {
  const urlFile = join(base, `${name}-url`);
  const secretFile = join(base, `${name}-secret`);
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

function teamText(row: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: remote
    name: iris
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${row}`;
}

function webhookRow(hook: { urlFile: string; secretFile: string }): string {
  return `    webhook:
      url_file: ${JSON.stringify(hook.urlFile)}
      secret_file: ${JSON.stringify(hook.secretFile)}
`;
}

type Scene = { base: string; home: string; root: string; file: string };

/** A root whose team is migrated into the scene's own registry home, so an edit replaces the
 *  record the running bus is watching. Two scenes may share a base and home to sit in one
 *  registry, each under its own root. */
async function scene(row: (base: string) => string = () => '', share?: { base: string; home: string; name: string }): Promise<Scene> {
  const base = share?.base ?? scratch();
  const home = share?.home ?? join(base, 'home');
  const root = join(base, share?.name ?? 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, teamText(row(base)));
  const io = testIo(root, { kind: 'owner' });
  const ended = await runTeamImport('migrate', ['--keep-file'], readArgs(['--keep-file'], [], ['json', 'dry-run', 'keep-file']), io, { home, now: NOW });
  expect(ended, io.out + io.err).toBe('done');
  return { base, home, root, file };
}

function teamOf(at: Scene): TeamFile {
  const loaded = readTeamConfig(at.root, { home: at.home, source: 'registry' });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
  return loaded.team;
}

async function start(at: Scene, stderr: string[] = []): Promise<{ close(): Promise<void>; reconcileNow(): Promise<unknown> }> {
  const started = await startBus({
    root: at.root,
    team: teamOf(at),
    home: at.home,
    stderr: (text) => stderr.push(text),
    reconcileIntervalMs: 0,
  });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') throw new Error(started.kind);
  buses.push(started.handle);
  return started.handle;
}

/** The seat's drop folder, as a send writes it before the bus's next pass. */
function drop(at: Scene, id: string): void {
  const dir = join(at.root, '.agents', 'send-drops', 'acme', 'iris');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), `from lead\n\nhello from ${id}\n`);
}

/** Replace the team's registry record with a row, as the owner's edit writes it, and approve the
 *  new copy: the bus reloads only the record the owner's approval is signed over. */
function setRow(at: Scene, hook: { urlFile: string; secretFile: string } | null): void {
  const text = teamText(hook === null ? '' : webhookRow(hook));
  const wrote = writeTeamText(at.file, text, {
    home: at.home,
    source: 'registry',
    command: 'team config set',
    now: NOW,
  });
  expect(wrote).toEqual({ ok: true, target: 'registry' });
  const parsed = validateTeamFile(text, { home: at.home, root: at.root });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  writeApproval(
    storePath(parsed.team.project, at.root, at.home),
    { approval: approvalOf(parsed.team, at.root, NOW()), file: text },
    parsed.team.seats,
    at.home,
    NOW(),
  );
}

/** The owner's approval of the team's current registry record, as `team approve` writes it. */
function approveCurrent(at: Scene): void {
  const stored = readStoredTeamConfig(at.home, teamIdOf(at.root));
  if (stored === null) throw new Error('the scene has no registry record to approve');
  const parsed = validateTeamFile(stored.text, { home: at.home, root: at.root });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  writeApproval(
    storePath(parsed.team.project, at.root, at.home),
    { approval: approvalOf(parsed.team, at.root, NOW()), file: stored.text },
    parsed.team.seats,
    at.home,
    NOW(),
  );
}

async function waitFor(what: () => boolean, whatText: string, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!what()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${whatText}`);
    await Bun.sleep(10);
  }
}

/** The record id the posted body carries, so a test can tell one arrival from another. */
function postedId(hit: Hit): string {
  return (JSON.parse(hit.body) as { event: { payload: { record_id: string } } }).event.payload.record_id;
}

test('a webhook row added to the registry record while the bus runs applies to the next arrival', async () => {
  const at = await scene();
  const said: string[] = [];
  const bus = await start(at, said);
  const routine = receiver();
  setRow(at, hookFiles(at.base, 'routine', routine.url));

  drop(at, 'msg-1');
  await bus.reconcileNow();
  await waitFor(() => routine.hits.length === 1, 'the arrival to reach the new row');
  expect(routine.hits.length).toBe(1);
  expect(postedId(routine.hits[0]!)).toBe('msg-1');
  expect(routine.hits[0]!.authorization).toBe('Bearer synthetic-secret-value');
  expect(routine.hits[0]!.path).toBe('/routine');
  expect(said).toEqual([]);
});

test('a changed row sends a later arrival to the new routine and the old one gets nothing more', async () => {
  const before = receiver();
  const at = await scene((base) => webhookRow(hookFiles(base, 'before', before.url)));
  const bus = await start(at);
  drop(at, 'msg-1');
  await bus.reconcileNow();
  await waitFor(() => before.hits.length === 1, 'the first arrival at the old row');

  const after = receiver();
  setRow(at, hookFiles(at.base, 'after', after.url));
  drop(at, 'msg-2');
  await bus.reconcileNow();
  await waitFor(() => after.hits.length === 1, 'the second arrival at the new row');
  expect(after.hits.length).toBe(1);
  expect(postedId(after.hits[0]!)).toBe('msg-2');
  expect(before.hits.length).toBe(1);
});

test('a delivery in flight when the row changes still reaches the routine it started on', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const before = receiver(async () => {
    await gate;
    finished = true;
    return new Response('ok', { status: 200 });
  });
  const at = await scene((base) => webhookRow(hookFiles(base, 'before', before.url)));
  const bus = await start(at);
  drop(at, 'msg-1');
  await bus.reconcileNow();
  await waitFor(() => before.hits.length === 1, 'the first arrival to be held by the old routine');

  const after = receiver();
  setRow(at, hookFiles(at.base, 'after', after.url));
  drop(at, 'msg-2');
  await bus.reconcileNow();
  release();
  await waitFor(() => after.hits.length === 1, 'the second arrival at the new row');
  await waitFor(() => finished, 'the held delivery to finish');
  expect(before.hits.length).toBe(1);
  expect(postedId(before.hits[0]!)).toBe('msg-1');
  expect(after.hits.length).toBe(1);
  expect(postedId(after.hits[0]!)).toBe('msg-2');
});

test('another root keeps its own rows when one root\'s record changes', async () => {
  const base = scratch();
  const home = join(base, 'home');
  const oneRoutine = receiver();
  const twoRoutine = receiver();
  const one = await scene((dir) => webhookRow(hookFiles(dir, 'one', oneRoutine.url)), { base, home, name: 'one' });
  const two = await scene((dir) => webhookRow(hookFiles(dir, 'two', twoRoutine.url)), { base, home, name: 'two' });
  const oneBus = await start(one);
  const twoBus = await start(two);

  const changed = receiver();
  setRow(one, hookFiles(one.base, 'changed', changed.url));

  drop(one, 'one-1');
  drop(two, 'two-1');
  await oneBus.reconcileNow();
  await twoBus.reconcileNow();
  await waitFor(() => changed.hits.length === 1, "the first root's new row");
  await waitFor(() => twoRoutine.hits.length === 1, "the second root's own row");
  expect(postedId(changed.hits[0]!)).toBe('one-1');
  expect(postedId(twoRoutine.hits[0]!)).toBe('two-1');
  expect(oneRoutine.hits.length).toBe(0);
  expect(twoRoutine.hits.length).toBe(1);
});

test('a record rewritten outside the approval chain never moves a running row', async () => {
  const trusted = receiver();
  const at = await scene((base) => webhookRow(hookFiles(base, 'trusted', trusted.url)));
  approveCurrent(at);
  const said: string[] = [];
  const bus = await start(at, said);
  const forged = receiver();
  const stored = readStoredTeamConfig(at.home, teamIdOf(at.root));
  if (stored === null) throw new Error('the scene lost its record');
  // The forged text and both unkeyed digests are recomputed: everything but the approval agrees.
  const replacement = teamText(webhookRow(hookFiles(at.base, 'forged', forged.url)));
  const parsed = validateTeamFile(replacement, { home: at.home, root: at.root });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  writeFileSync(
    teamConfigRecordPath(at.home, teamIdOf(at.root)),
    JSON.stringify({ ...stored, text: replacement, text_sha256: sha256(replacement), record_sha256: sha256(canonicalTeam(parsed.team)) }),
  );

  drop(at, 'msg-1');
  await bus.reconcileNow();
  await waitFor(() => trusted.hits.length === 1, 'the arrival at the approved row');
  expect(forged.hits.length).toBe(0);
  expect(postedId(trusted.hits[0]!)).toBe('msg-1');
  const problems = said.filter((line) => line.includes('webhook rows were not reloaded'));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('not the copy the owner approved');
});

test('a malformed registry record is reported without the text it holds', async () => {
  const at = await scene();
  const said: string[] = [];
  const bus = await start(at, said);
  // The parser's own message quotes the text it refused; the bus must not forward it. The marker
  // stands for anything a malformed record could carry.
  const marker = 'SYNTHETIC_RELOAD_SECRET_DO_NOT_LOG';
  writeFileSync(teamConfigRecordPath(at.home, teamIdOf(at.root)), `{"token":"${marker}"}`);

  await bus.reconcileNow();
  const problems = said.filter((line) => line.includes('webhook rows were not reloaded'));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('the registry record could not be read');
  expect(said.join('\n')).not.toContain(marker);
});

test('a removed registry record is named once and the running rows keep working', async () => {
  const routine = receiver();
  const at = await scene((base) => webhookRow(hookFiles(base, 'stable', routine.url)));
  approveCurrent(at);
  const said: string[] = [];
  const bus = await start(at, said);
  const record = teamConfigRecordPath(at.home, teamIdOf(at.root));
  renameSync(record, `${record}.retained`);

  drop(at, 'msg-1');
  await bus.reconcileNow();
  await bus.reconcileNow();
  await waitFor(() => routine.hits.length === 1, 'the retained row to receive the arrival');
  expect(postedId(routine.hits[0]!)).toBe('msg-1');
  const problems = said.filter((line) => line.includes('webhook rows were not reloaded'));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('holds no record of this team');
});
