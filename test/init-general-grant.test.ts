// Under the working folder, not the OS temp folder: a client key never sits under the temp folder.
// `team init --general`: an owner-signed general grant covering `init` admits a create with no
// owner terminal, for an entity the grant covers; everything else is refused, fail-closed.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { issueHeldGeneralGrant, issueOwnerGeneralGrant, type GrantOp } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { installKey } from '../src/store/keys.ts';
import { gitEnv, testIo } from './helpers.ts';

let base: string;
let home: string;
let project: string;
const detached = { kind: 'owner-no-tty' } as const;
const noLogin = { loggedIn: () => false };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(process.cwd(), '.gg-init-test-')));
  home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), `floor:\n  roots: [${join(base, 'floor')}]\nmaterial:\n  roots: [${join(base, 'material')}]\n`);
  project = join(base, 'floor', 'acme');
  mkdirSync(project, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...a], { cwd: project, stdio: 'ignore', env: gitEnv() });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function holder(name: string) {
  const pair = newClientKeyPair();
  const w = writeClientKeyFiles(join(home, '.config', 'team-client', name), pair);
  if (!w.ok) throw new Error(w.why);
  return { pub: pair.publicKey, path: w.keyPath };
}
function grant(entities: string[], ops: GrantOp[], who = holder('iris'), expires = new Date(Date.now() + 86_400_000)) {
  const g = issueOwnerGeneralGrant(home, { clientId: 'iris', publicKey: who.pub, entities, ops, mayIssue: true, expires });
  if (!g.ok) throw new Error(g.why);
  return { path: g.path, key: who.path, who };
}
async function run(argv: string[], now?: Date) {
  const io = testIo(project, detached);
  const code = await runInit(argv, io, home, undefined, { ...noLogin, registryHome: home, ...(now ? { now: () => now } : {}) });
  return { code, out: io.out, err: io.err };
}

test('a detached run with no grant is refused init.detached', async () => {
  const r = await run([]);
  expect(r.code).toBe(1);
  expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
});

test('a general grant covering init on this entity admits the create with no owner terminal', async () => {
  const g = grant(['floor'], ['*']);
  const r = await run(['--general', g.path, '--key', g.key]);
  expect(r.err).toContain('admitted by general grant');
  expect(r.code).toBe(0);
});

test('a general grant listing init (not the wildcard) admits too', async () => {
  const g = grant(['*'], ['init']);
  expect((await run(['--general', g.path, '--key', g.key])).code).toBe(0);
});

test('a general grant without init is refused init.general-refused, nothing written', async () => {
  const g = grant(['*'], ['config', 'restart', 'up', 'down', 'abandon', 'send', 'messages', 'reply']);
  const r = await run(['--general', g.path, '--key', g.key, '--json']);
  expect(r.code).toBe(1);
  expect(r.out + r.err).toContain('init.general-refused');
  expect(r.out + r.err).toContain('does not cover init');
  expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
});

test('a general grant for another entity is refused', async () => {
  const g = grant(['material'], ['*']);
  const r = await run(['--general', g.path, '--key', g.key]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('does not cover entity "floor"');
});

test('the wrong key, a tampered grant and a missing --key are refused', async () => {
  const g = grant(['floor'], ['init']);
  expect((await run(['--general', g.path, '--key', holder('other').path])).code).toBe(1);
  expect((await run(['--general', g.path])).code).toBe(1);
  const disk = JSON.parse(readFileSync(g.path, 'utf8'));
  disk.general_grant.ops = ['*'];
  disk.general_grant.entities = ['*'];
  writeFileSync(g.path, JSON.stringify(disk));
  expect((await run(['--general', g.path, '--key', g.key])).code).toBe(1);
});

test('self-grant is still refused: a holder never issues init to itself', () => {
  const g = grant(['floor'], ['*']);
  const self = issueHeldGeneralGrant(home, g.path, g.key, { clientId: 'iris', publicKey: g.who.pub, entities: ['floor'], ops: ['init'], mayIssue: false, expires: new Date(Date.now() + 3_600_000) });
  expect(self.ok).toBe(false);
});

test('the all-ops all-entities grant admits init', async () => {
  const g = grant(['*'], ['*']);
  const r = await run(['--general', g.path, '--key', g.key]);
  expect(r.code).toBe(0);
  expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(true);
});

test('init under a fake clock: admitted just before expiry, refused after, nothing written', async () => {
  const exp = new Date(Date.now() + 3_600_000);
  const g = grant(['*'], ['*'], holder('iris'), exp);
  const late = await run(['--general', g.path, '--key', g.key], new Date(exp.getTime() + 1000));
  expect(late.code).toBe(1);
  expect(late.out + late.err).toContain('expired');
  expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(false);
  const early = await run(['--general', g.path, '--key', g.key], new Date(exp.getTime() - 1000));
  expect(early.code).toBe(0);
});

test('a child wildcard grant from a wildcard holder admits init; one from a listed holder is never issued', async () => {
  const g = grant(['*'], ['*']);
  const kid = holder('kid');
  const child = issueHeldGeneralGrant(home, g.path, g.key, { clientId: 'kid', publicKey: kid.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: new Date(Date.now() + 3_600_000) });
  if (!child.ok) throw new Error(child.why);
  expect((await run(['--general', child.path, '--key', kid.path])).code).toBe(0);
  const listed = grant(['*'], ['init', 'up'], holder('iris2'));
  expect(issueHeldGeneralGrant(home, listed.path, listed.key, { clientId: 'kid', publicKey: kid.pub, entities: ['*'], ops: ['*'], mayIssue: false, expires: new Date(Date.now() + 3_600_000) }).ok).toBe(false);
});
