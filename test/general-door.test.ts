// The general door (src/client/general-door.ts): every command but the grant-issuing one accepts
// `--general <grant.json> --key <client.key>` through the dispatcher, admitted as the owner with no
// terminal; every refusal is the door's own, before the command runs.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commands, main } from '../src/cli.ts';
import { GENERAL_OPS, issueOwnerGeneralGrant, type GrantOp } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import type { Io } from '../src/io.ts';
import { installKey } from '../src/store/keys.ts';

const base = realpathSync(mkdtempSync(join(process.cwd(), '.gg-test-door-')));
const home = join(base, 'home');
const cwd = join(base, 'plain');
const savedHome = process.env.HOME;
beforeAll(() => { process.env.HOME = home; });
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(base, { recursive: true, force: true });
});
require('node:fs').mkdirSync(cwd, { recursive: true });
require('node:fs').mkdirSync(home, { recursive: true });
installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
function key(name: string) {
  const pair = newClientKeyPair();
  const w = writeClientKeyFiles(join(home, '.config', 'team-client', name), pair);
  if (!w.ok) throw new Error(w.why);
  return { pub: pair.publicKey, path: w.keyPath };
}
const a = key('a');
const b = key('b');
const day = 86_400_000;
function grant(ops: GrantOp[], entities: string[] = ['*'], expires = new Date(Date.now() + day), now?: Date): string {
  const g = issueOwnerGeneralGrant(home, { clientId: 'a', publicKey: a.pub, entities, ops, mayIssue: false, expires }, now);
  if (!g.ok) throw new Error(g.why);
  return g.path;
}
const all = grant(['*']);

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd, env: { ...process.env, HOME: home }, stdinIsTTY: false };
  const code = await main(argv, io);
  return { code, out, err };
}

const lines: [string, string[]][] = [
  ['send', ['send', 'worker', 'Reply pong']],
  ['messages', ['messages']],
  ['reply', ['reply', 'r_1', 'pong']],
  ['restart', ['restart', 'worker']],
  ['down', ['down']],
  ['down --abandon', ['down', '--abandon']],
  ['status', ['status']],
  ['daemon status', ['daemon', 'status']],
];
for (const [label, argv] of lines) {
  test(`${label}: a wildcard grant admits it with no terminal, as the owner`, async () => {
    const ran = await run([...argv, '--general', all, '--key', a.path]);
    expect(ran.err).toContain('admitted by general grant');
    expect(`${ran.err}${ran.out}`).not.toContain('from a terminal outside herdr');
    expect(`${ran.err}${ran.out}`).not.toContain('--general');
    expect(`${ran.err}${ran.out}`).not.toContain('--key');
  });
}

const inPane = { kind: 'seat', name: 'builder-5', pane: 'pane1' } as const;

test('a seat inside a team pane is admitted, dev mode on or off: an owner tool applies changes under a general grant', async () => {
  for (const env of [{}, { TEAMCLI_DEV_MODE: '1' }] as Record<string, string>[]) {
    let out = '';
    let err = '';
    const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd, env: { ...process.env, HOME: home, ...env }, stdinIsTTY: false, caller: inPane };
    const code = await main(['daemon', 'status', '--general', all, '--key', a.path], io);
    expect(code).toBe(0);
    expect(`${err}${out}`).toContain('admitted by general grant');
    expect(`${err}${out}`).not.toContain('a client key is not used from inside a team pane');
  }
});

test('an unplaced caller (parent chain unreadable) is admitted as the owner too', async () => {
  const { generalDoor } = await import('../src/client/general-door.ts');
  const io: Io = { stdout: () => {}, stderr: () => {}, cwd, env: { ...process.env, HOME: home }, stdinIsTTY: false, caller: { kind: 'unplaced', reason: "its parent processes can't be read to the top" } };
  const door = generalDoor('daemon', ['install', '--general', all, '--key', a.path], io);
  expect(door.kind).toBe('admitted');
  if (door.kind === 'admitted') { expect(door.io.caller).toEqual({ kind: 'owner' }); expect(door.argv).toEqual(['install']); }
});

test('the --general=<file> and --key=<file> forms are read too', async () => {
  const ran = await run(['status', `--general=${all}`, `--key=${a.path}`]);
  expect(ran.err).toContain('admitted by general grant');
});

test('an op the grant does not cover is refused before the command runs', async () => {
  const ran = await run(['status', '--general', grant(['send']), '--key', a.path]);
  expect(ran.code).toBe(1);
  expect(ran.err).toContain('does not cover status');
});

test('another key is refused', async () => {
  const ran = await run(['send', 'worker', 'hi', '--general', all, '--key', b.path]);
  expect(ran.code).toBe(1);
  expect(ran.err).toContain('the key does not match');
});

test('an expired grant is refused', async () => {
  const then = new Date(Date.now() - 3 * day);
  const ran = await run(['messages', '--general', grant(['*'], ['*'], new Date(then.getTime() + day), then), '--key', a.path]);
  expect(ran.code).toBe(1);
  expect(ran.err).toContain('has expired');
});

test('an entity the grant does not cover is refused', async () => {
  const ran = await run(['status', '--general', grant(['*'], ['material']), '--key', a.path]);
  expect(ran.code).toBe(1);
  expect(ran.err).toContain('entity');
});

test('--general without --key is a usage error', async () => {
  const ran = await run(['status', '--general', all]);
  expect(ran.code).toBe(2);
  expect(ran.err).toContain('--general needs --key');
});

test('the refusal has its structured face under --json', async () => {
  const ran = await run(['status', '--json', '--general', all, '--key', b.path]);
  expect(ran.code).toBe(1);
  expect(JSON.parse(ran.out).error.id).toBe('team.general-refused');
});

test('the grant-issuing command takes no --general', async () => {
  const ran = await run(['client', 'general-grant', '--to', 'x', '--public-key', 'p', '--general', all, '--key', a.path]);
  expect(ran.code).toBe(2);
  expect(ran.err).toContain('issues grants');
});

test('every command of the table is a general-grant op', () => {
  for (const name of Object.keys(commands)) expect(GENERAL_OPS as readonly string[]).toContain(name);
});

test('every command in the contract declares --general and --key, but the grant-issuing one', () => {
  const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', 'contract', 'cli.json'), 'utf8')) as { commands: { name: string; hidden: boolean; flags: { name: string; takesValue: boolean }[]; subcommands: { name: string; flags: { name: string; takesValue: boolean }[] }[] }[] };
  const missing: string[] = [];
  for (const command of contract.commands) {
    if (command.hidden) continue;
    const nodes = [{ name: command.name, flags: command.flags }, ...command.subcommands.map((s) => ({ name: `${command.name} ${s.name}`, flags: s.flags }))];
    for (const node of nodes) {
      if (node.name === 'client general-grant') {
        expect(node.flags.some((f) => f.name === '--general')).toBe(false);
        continue;
      }
      for (const flag of ['--general', '--key']) if (!node.flags.some((f) => f.name === flag && f.takesValue)) missing.push(`${node.name} ${flag}`);
    }
  }
  expect(missing).toEqual([]);
});

test('an admitted run carries the verified grant and key paths to the command (io.general)', async () => {
  const { generalDoor } = await import('../src/client/general-door.ts');
  const io: Io = { stdout: () => {}, stderr: () => {}, cwd, env: { ...process.env, HOME: home }, stdinIsTTY: false };
  const door = generalDoor('daemon', ['install', '--general', all, '--key', a.path], io);
  if (door.kind !== 'admitted') throw new Error(door.kind);
  expect(door.io.general).toEqual({ grant: all, key: a.path });
  const refused = generalDoor('daemon', ['install', '--general', all, '--key', b.path], io);
  expect(refused.kind).toBe('refused');
});

test('a unit installed under a general grant runs the daemon under the same grant, and a plain one does not', async () => {
  const { darwinServiceManager } = await import('../src/daemon/service-darwin.ts');
  const manager = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
  const base = { execPath: '/bin/node', entry: '/x/cli.js', roots: ['/r'], presence: true, watch: true };
  const granted = manager.plan(home, { ...base, general: { grant: all, key: a.path } }).program;
  expect(granted.slice(-4)).toEqual(['--general', all, '--key', a.path]);
  expect(granted).toContain('service-manager');
  expect(manager.plan(home, base).program).not.toContain('--general');
});

test('the service-started run line passes the door while the grant holds, and is refused once it does not', async () => {
  const { generalDoor } = await import('../src/client/general-door.ts');
  const io: Io = { stdout: () => {}, stderr: () => {}, cwd, env: { ...process.env, HOME: home }, stdinIsTTY: false, caller: { kind: 'unplaced', reason: "its parent processes can't be read to the top" } };
  const line = ['run', '--started-by', 'service-manager', '--root', '/r', '--general', all, '--key', a.path];
  const ok = generalDoor('daemon', line, io);
  expect(ok.kind).toBe('admitted');
  const then = new Date(Date.now() - 3 * day);
  const expired = grant(['*'], ['*'], new Date(then.getTime() + day), then);
  expect(generalDoor('daemon', ['run', '--started-by', 'service-manager', '--general', expired, '--key', a.path], io).kind).toBe('refused');
  expect(generalDoor('daemon', ['run', '--general', grant(['send']), '--key', a.path], io).kind).toBe('refused');
});

test('the launchd unit carries the installing PATH, so the service finds herdr (0.5.9)', async () => {
  const { darwinServiceManager } = await import('../src/daemon/service-darwin.ts');
  const manager = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
  const base = { execPath: '/bin/node', entry: '/x/cli.js', roots: ['/r'] };
  expect(manager.install(home, { ...base, path: '/home/x/.local/bin:/usr/bin' }).ok).toBe(true);
  const unit = readFileSync(manager.unitPath(home), 'utf8');
  expect(unit).toContain('<key>EnvironmentVariables</key>');
  expect(unit).toContain('<string>/home/x/.local/bin:/usr/bin</string>');
  expect(manager.install(home, base).ok).toBe(true);
  expect(readFileSync(manager.unitPath(home), 'utf8')).not.toContain('EnvironmentVariables');
});
