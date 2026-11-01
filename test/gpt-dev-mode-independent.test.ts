// Independent synthetic client entrances; the selected source root can be the unchanged base.
import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Caller } from '../src/caller.ts';
import type { Io } from '../src/io.ts';
import { fixtureBase } from './helpers.ts';

const subject = process.env.TEAM_GPT_SUBJECT_ROOT ?? resolve(import.meta.dir, '..');
const load = (path: string) => import(pathToFileURL(join(subject, 'src', path)).href);
const { runClient } = await load('commands/client.ts');
const { runGrant } = await load('commands/grant.ts');
const { runClientSend } = await load('client/send.ts');
const { runClientMessages } = await load('client/inbox.ts');
const { verifyClientUp } = await load('client/up-grant.ts');
const { generalDoor } = await load('client/general-door.ts');
const { issueOwnerGeneralGrant, readGeneralGrant, admitGeneral } = await load('client/general-grant.ts');
const records = await load('client/records.ts');
const { keyOf } = await load('store/keys.ts');
const { writeDevelopmentMode, readDevelopmentMode } = await load('development_mode.ts');
const { devModeState, devModeOwnerLift } = await load('dev_mode.ts');
const { approvalOf } = await load('approve/approval.ts');
const { loadTeamFile } = await load('file/load.ts');
const { storePath, writeApproval } = await load('store/store.ts');
const { registerAgent } = await load('registry/agents.ts');
const { upsertTeam, teamIdOf } = await load('registry/teams.ts');
const { emptySession, updateState } = await load('state.ts');
const { readArgs } = await load('args.ts');

const configSource = process.env.TEAM_CONFIG_SOURCE;
process.env.TEAM_CONFIG_SOURCE = 'file';
afterAll(() => { if (configSource === undefined) delete process.env.TEAM_CONFIG_SOURCE; else process.env.TEAM_CONFIG_SOURCE = configSource; });
// Real key hygiene is exercised: fixture homes sit outside the host's temporary directory and
// outside the fixture checkout. No process HOME or real owner store is changed or read.
const base = fixtureBase('gpt-dev-fixtures-');
let serial = 0;
const modes = ['env-on', 'env-off', 'machine-on', 'machine-off'] as const;
type Mode = typeof modes[number];
const pane: Caller = { kind: 'seat', name: 'lead', pane: 'fixture-pane-lead', session: 'fixture' };
const external: Caller = { kind: 'unplaced', reason: 'fixture external agent' };
const DAY = 86_400_000;

function ioAt(root: string, home: string, mode: Mode, caller: Caller = pane) {
  const io: Io & { out: string; err: string } = {
    cwd: root, env: { HOME: home, ...(mode === 'env-on' || mode === 'machine-off' ? { TEAMCLI_DEV_MODE: '1' } : {}) },
    stdinIsTTY: false, stdoutIsTTY: false, caller, out: '', err: '',
    stdout: (text) => { io.out += text; }, stderr: (text) => { io.err += text; },
  };
  if (caller === external || (caller.kind === 'unplaced' && caller.reason === 'it runs under herdr')) {
    delete io.caller;
    io.callerSources = () => ({
      ancestors: () => caller === external
        ? [{ pid: 701, name: 'codex' }, { pid: 1, name: 'init' }]
        : [{ pid: 701, name: 'fixture-child' }, { pid: 700, name: 'herdr' }, { pid: 1, name: 'init' }],
      agents: () => [], paneRootPid: () => null, env: {}, stdinIsTTY: false,
    });
  }
  return io;
}

function fixture(mode: Mode) {
  const folder = join(base, String(++serial)), root = join(folder, 'project'), home = join(folder, 'home');
  const dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  const env = { ...process.env };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'EMAIL']) delete env[key];
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(join(root, 'README.md'), 'fixture\n'); git('add', 'README.md'); git('commit', '-q', '-m', 'fixture');
  const text = `format: 1
project: fixture
entity: fixture
session: fixture
coordinator: lead
operator: operator
workspace:
  mode: shared
clients:
  issuer:
    seats: [lead]
  child:
    seats: [lead]
seats:
${['lead', 'operator', 'worker'].map((name) => `  - name: ${name}
    role: ${name === 'lead' ? 'coordinator' : 'implementer'}
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
`).join('')}`;
  const file = join(dir, 'team.yaml'); fs.writeFileSync(file, text);
  const loaded = loadTeamFile(root, { home, file });
  if (!loaded.ok) throw Error('independent team fixture is invalid: ' + JSON.stringify(loaded.errors));
  const now = new Date();
  writeApproval(storePath('fixture', root, home), { approval: approvalOf(loaded.team, root, now), file: text }, loaded.team.seats, home);
  const agent = registerAgent(home, { name: 'lead', signing: { model: 'Fixture', version: '1', role: 'coordinator' }, lab: 'fixture', cli: 'codex', launcher: null, launch: 'codex', seat_handle: 'seat_123456789abc', reach: { team: teamIdOf(root), seat: 'lead', session: 'fixture', pane: 'fixture-pane-lead', address: null, agent_session: null }, mcp: [], skills: [], lifecycle: 'running', by: 'fixture' });
  upsertTeam(home, teamIdOf(root), { project: 'fixture', entity: 'fixture', root, session: 'fixture', lifecycle: 'running', roster: [{ seat: 'lead', agent: agent.id, role: 'coordinator', leads: true }], by: 'fixture' });
  updateState(dir, (state: any) => { const session = state.sessions.fixture ??= emptySession(); session.seats.lead = { id: 'seat_123456789abc', stage: 'ready', cli: 'codex', pane: 'fixture-pane-lead' }; });
  const entities = join(home, '.config', 'team', 'entities.yaml');
  fs.writeFileSync(entities, `fixture:\n  roots:\n    - ${root}\n  clients:\n    issuer:\n      seats: [lead]\n    child:\n      seats: [lead]\n`);
  const issuer = records.newClientKeyPair(), child = records.newClientKeyPair();
  const issuerDir = records.clientKeyDir(home, 'issuer'), childDir = records.clientKeyDir(home, 'child');
  const issuerFiles = records.writeClientKeyFiles(issuerDir, issuer), childFiles = records.writeClientKeyFiles(childDir, child);
  if (!issuerFiles.ok || !childFiles.ok) throw Error('fixture client keys could not be written');
  if (records.clientKeyPlacementProblem(home, issuerDir) !== null) throw Error('fixture client key placement is invalid');
  const master = records.writeClientGrant(home, { clientId: 'issuer', entity: 'fixture', seat: 'lead', publicKey: issuer.publicKey, keyId: issuer.keyId, keyDir: issuerDir, inbox: true, grantScope: { entities: ['fixture'], projects: [], teams: [] } }, { now });
  if (!master.ok) throw Error('fixture master grant is invalid: ' + master.why);
  const parent = issueOwnerGeneralGrant(home, { clientId: 'issuer', publicKey: issuer.publicKey, entities: ['*'], ops: ['*'], mayIssue: true, expires: new Date(now.getTime() + 2 * DAY) }, now);
  if (!parent.ok) throw Error('fixture general grant is invalid: ' + parent.why);
  keyOf(home);
  if (mode.startsWith('machine')) {
    const written = writeDevelopmentMode({ home, mode: mode === 'machine-on' ? 'local-fast' : 'off', now, caller: 'fixture' });
    if (!written.ok || readDevelopmentMode(home).kind !== 'set') throw Error('fixture machine setting is invalid');
  }
  const io = ioAt(root, home, mode);
  const state = devModeState(io, { home, root, team: loaded.team, now });
  expect(state.on).toBe(mode.endsWith('-on'));
  expect(state.by).toBe(mode === 'env-on' ? 'env' : mode === 'machine-on' ? 'machine' : null);
  const lift = devModeOwnerLift(io, { command: 'fixture-admission', refusal: 'fixture', home, root, dir, team: loaded.team, now });
  expect(lift.lifted).toBe(mode.endsWith('-on'));
  return { folder, root, home, dir, now, io, mode, issuerFiles, childFiles, parent, master };
}
type Fixture = ReturnType<typeof fixture>;

function snapshot(folder: string): string {
  const rows: string[] = [];
  function visit(path: string) {
    const stat = fs.lstatSync(path), rel = path.slice(folder.length);
    rows.push(rel + ':' + (stat.mode & 0o777).toString(8));
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile()) rows.push(createHash('sha256').update(fs.readFileSync(path)).digest('hex'));
  }
  visit(folder);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

async function traced(at: Fixture, action: () => unknown | Promise<unknown>) {
  const before = snapshot(at.folder), opened: string[] = [];
  const protectedFiles = [at.master.path, at.parent.path, at.issuerFiles.keyPath];
  const actual = fs.readFileSync;
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
    if (protectedFiles.includes(String(args[0]))) opened.push(String(args[0]));
    return (actual as Function)(...args);
  }) as typeof fs.readFileSync);
  let result: unknown;
  try { result = await action(); } finally { spy.mockRestore(); }
  return { result, opened, before, after: snapshot(at.folder) };
}

const issueArgs = (at: Fixture) => ['--client-request', '--client', 'child', '--entity', 'fixture', '--seat', 'lead', '--public-key', at.childFiles.pubPath, '--via', at.master.path, '--key', at.issuerFiles.keyPath, '--json'];
const heldArgs = (at: Fixture) => ['general-grant', '--to', 'child', '--public-key', at.childFiles.pubPath, '--entities', 'fixture', '--ops', 'status', '--days', '1', '--via', at.parent.path, '--key', at.issuerFiles.keyPath, '--json'];

for (const [mi, mode] of modes.entries()) for (const [di, door] of ['send', 'messages', 'keygen', 'bundle', 'issue-client', 'issue-general'].entries()) {
  test(`V${mi + 1}${di + 1}: the client entrance refuses a pane before protected reads or writes`, async () => {
    const at = fixture(mode);
    let expected: string;
    const run = async () => {
      if (door === 'send') {
        expected = 'send.client-pane';
        return runClientSend(readArgs(['--client', at.master.path, '--key', at.issuerFiles.keyPath, 'lead@fixture', 'synthetic note'], ['client', 'key'], []), at.io, { home: at.home, now: () => new Date() }, true);
      }
      if (door === 'messages') {
        expected = 'messages.client-pane';
        return runClientMessages(readArgs(['--client', at.master.path, '--key', at.issuerFiles.keyPath], ['client', 'key'], []), at.io, { home: at.home, now: () => new Date() }, true);
      }
      if (door === 'keygen') { expected = 'client.keygen.pane'; return runClient(['keygen', '--out', records.clientKeyDir(at.home, 'new-client'), '--json'], at.io, at.home); }
      if (door === 'issue-client') { expected = 'grant.refused'; return runGrant(issueArgs(at), at.io, { home: at.home }); }
      if (door === 'issue-general') { expected = 'text'; return runClient(heldArgs(at), at.io, at.home); }
      expected = 'bundle';
      const ops = ['up', 'down', 'status', 'pause', 'resume', 'hold', 'add', 'remove', 'seat', 'seats', 'reload', 'restart', 'sessions'];
      return ops.map((op) => verifyClientUp({ home: at.home, grantFile: at.master.path, keyFile: at.issuerFiles.keyPath, cwd: at.root, now: at.now, op, io: at.io }));
    };
    const observed = await traced(at, run);
    if (expected! === 'bundle') {
      const values = observed.result as { ok: boolean; why?: string }[];
      expect(values.length).toBe(13);
      for (const value of values) expect({ ok: value.ok, pane: value.why?.includes('inside a team pane') }).toEqual({ ok: false, pane: true });
    } else {
      expect(observed.result).toBe(1);
      if (expected! === 'text') expect(at.io.err).toContain('inside a team pane');
      else { const error = JSON.parse(at.io.out).error; expect(error.id ?? error.code).toBe(expected!); }
    }
    expect(observed.opened).toEqual([]);
    expect(observed.after).toBe(observed.before);
  });
}

for (const [mi, mode] of modes.entries()) test(`V8${mi + 1}: a pane still uses a bounded general grant`, () => {
  const at = fixture(mode), before = snapshot(at.folder);
  const result = generalDoor('status', ['--general', at.parent.path, '--key', at.issuerFiles.keyPath, '--json'], at.io, at.now);
  expect(result.kind).toBe('admitted');
  expect(result.io.caller).toEqual({ kind: 'owner' });
  expect(result.argv).toEqual(['--json']);
  expect(snapshot(at.folder)).toBe(before);
  for (const name of ['up', 'init', 'config']) {
    const argv = ['--general', at.parent.path, '--key', at.issuerFiles.keyPath];
    const own = generalDoor(name, argv, at.io, at.now);
    expect(own.kind).toBe('pass'); expect(own.argv).toEqual(argv); expect(own.io).toBe(at.io);
    expect(admitGeneral(at.home, at.parent.path, at.issuerFiles.keyPath, name, 'fixture', at.now).ok).toBe(true);
  }
});

test('V90: an external client really issues a verified sub-grant and audit record', async () => {
  const at = fixture('env-on'), io = ioAt(at.root, at.home, at.mode, external);
  const observed = await traced(at, () => runGrant(issueArgs(at), io, { home: at.home }));
  expect(observed.result).toBe(0);
  expect(observed.opened).toContain(at.master.path); expect(observed.opened).toContain(at.issuerFiles.keyPath);
  expect(observed.after).not.toBe(observed.before);
  const shown = JSON.parse(io.out), read = records.readClientGrant(at.home, shown.target);
  expect(read.ok).toBe(true);
  expect(read.grant.clientId).toBe('child'); expect(read.grant.issuedBy).toBe(at.master.grant.grantId);
  expect(fs.readdirSync(records.clientGrantAuditFolder(at.home)).length).toBe(1);
});

test('V91: an external holder really issues within its general grant', async () => {
  const at = fixture('machine-on'), io = ioAt(at.root, at.home, at.mode, external);
  const observed = await traced(at, () => runClient(heldArgs(at), io, at.home));
  expect(observed.result).toBe(0);
  expect(observed.opened).toContain(at.parent.path); expect(observed.opened).toContain(at.issuerFiles.keyPath);
  expect(observed.after).not.toBe(observed.before);
  const shown = JSON.parse(io.out), read = readGeneralGrant(at.home, shown.path, new Date());
  expect(read.ok).toBe(true); expect(read.grant.parent).toBe(at.parent.grant.grant_id);
  expect(read.grant.client_id).toBe('child');
  expect(admitGeneral(at.home, shown.path, at.childFiles.keyPath, 'status', 'fixture').ok).toBe(true);
  expect(admitGeneral(at.home, shown.path, at.childFiles.keyPath, 'down', 'fixture').ok).toBe(false);
  expect(admitGeneral(at.home, shown.path, at.childFiles.keyPath, 'status', 'elsewhere').ok).toBe(false);
});

test('V92: an external caller can still generate a real client key', () => {
  const at = fixture('env-off'), io = ioAt(at.root, at.home, at.mode, external), out = records.clientKeyDir(at.home, 'new-client');
  expect(runClient(['keygen', '--out', out, '--json'], io, at.home)).toBe(0);
  const shown = JSON.parse(io.out);
  expect(records.readClientPrivateKey(at.home, shown.key_path).ok).toBe(true);
  expect(fs.existsSync(shown.public_key_path)).toBe(true);
});

test('V93: ordinary seats and agentless pane descendants remain refused', async () => {
  const at = fixture('machine-on');
  for (const caller of [
    { kind: 'seat', name: 'worker', pane: 'fixture-pane-worker', session: 'fixture' },
    { kind: 'pane', pane: 'fixture-pane-empty', session: 'fixture' },
    { kind: 'unplaced', reason: 'it runs under herdr' },
  ] as Caller[]) {
    const io = ioAt(at.root, at.home, at.mode, caller);
    const observed = await traced(at, () => runClient(heldArgs(at), io, at.home));
    expect(observed.result).toBe(1); expect(io.err).toContain('inside a team pane');
    expect(observed.opened).toEqual([]); expect(observed.after).toBe(observed.before);
  }
});
