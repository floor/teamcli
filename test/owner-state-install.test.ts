// `team owner-seat install`: the one administrator step that sets up a shared Linux machine's
// owner state. Run against a fake system that records every command: nothing here makes a user,
// a folder outside the test's own, or a privilege rule.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOwnerState, sudoersText, type InstallSystem } from '../src/client/owner-state-install.ts';
import { runOwnerSeat } from '../src/commands/owner-seat.ts';
import { testIo } from './helpers.ts';

type Fake = InstallSystem & { ran: string[][]; written: Map<string, string>; removed: string[] };

function fakeSystem(options: { uid?: number; platform?: NodeJS.Platform; users?: Record<string, string>; fail?: string } = {}): Fake {
  const users: Record<string, string> = { floor: 'floor:x:1001:1001::/home/floor:/bin/bash', studio: 'studio:x:1002:1002::/home/studio:/bin/bash', root: 'root:x:0:0:root:/root:/bin/bash', ...options.users };
  const ran: string[][] = [];
  const written = new Map<string, string>();
  const removed: string[] = [];
  const fake: Fake = {
    platform: options.platform ?? 'linux',
    uid: () => options.uid ?? 0,
    ran,
    written,
    removed,
    run: (argv) => {
      ran.push([...argv]);
      if (argv[0] === '/usr/bin/getent') {
        const line = users[argv[2]!];
        return line === undefined ? { status: 2, stdout: '', stderr: '' } : { status: 0, stdout: `${line}\n`, stderr: '' };
      }
      if (argv[0] === '/usr/sbin/useradd') users['teamcli-owner'] = 'teamcli-owner:x:998:998::/var/lib/teamcli-owner:/usr/sbin/nologin';
      if (options.fail !== undefined && argv.includes(options.fail)) return { status: 1, stdout: '', stderr: 'no space left' };
      return { status: 0, stdout: '', stderr: '' };
    },
    bun: '/opt/bun/bin/bun',
    bundle: async () => '// bundled helper\n',
    staging: () => '/staging',
    write: (path, text) => { written.set(path, text); },
    remove: (path) => { removed.push(path); },
  };
  return fake;
}

const commands = (fake: Fake) => fake.ran.filter((argv) => argv[0] !== '/usr/bin/getent');

describe('team owner-seat install', () => {
  test('dry run: lists every step and runs nothing that changes the machine', async () => {
    const fake = fakeSystem({ uid: 1000 });
    const outcome = await installOwnerState(fake, ['floor'], true);
    expect(outcome.ok).toBe(true);
    expect(commands(fake)).toEqual([]);
    expect(fake.written.size).toBe(0);
    const argv = outcome.steps.map((step) => step.argv.join(' '));
    expect(argv[0]).toBe('/usr/sbin/useradd --system --user-group --home-dir /var/lib/teamcli-owner --no-create-home --shell /usr/sbin/nologin teamcli-owner');
    expect(argv).toContain('/usr/bin/install -d -m 0755 -o root -g root /etc/teamcli');
    expect(argv).toContain('/usr/bin/install -d -m 0755 -o teamcli-owner -g teamcli-owner /var/lib/teamcli-owner /var/lib/teamcli-owner/ledger');
    expect(argv).toContain('/usr/bin/install -m 0755 -o root -g root /opt/bun/bin/bun /usr/local/teamcli-owner/bin/bun');
    expect(argv.at(-2)).toBe('/usr/sbin/visudo -cf <staging>/teamcli-owner.sudoers');
    expect(argv.at(-1)).toBe('/usr/bin/install -m 0440 -o root -g root <staging>/teamcli-owner.sudoers /etc/sudoers.d/teamcli-owner');
    // Every folder and file is made with install, never by changing a mode after.
    expect(argv.every((line) => !/\bchmod\b|\bchown\b/.test(line))).toBe(true);
  });

  test('a real run: the helper user, folders, program, record and the checked rule, in order', async () => {
    const fake = fakeSystem();
    const outcome = await installOwnerState(fake, ['studio', 'floor'], false);
    expect(outcome.ok, outcome.ok ? '' : outcome.why).toBe(true);
    const run = commands(fake).map((argv) => argv[0]);
    expect(run[0]).toBe('/usr/sbin/useradd');
    expect(run.indexOf('/usr/sbin/visudo')).toBe(run.length - 2);
    expect(fake.written.get('/staging/owner-spend.js')).toBe('// bundled helper\n');
    expect(JSON.parse(fake.written.get('/staging/owner-helper.json')!)).toEqual({ format: 'team-owner-helper-v1', user: 'teamcli-owner', uid: 998 });
    const rule = fake.written.get('/staging/teamcli-owner.sudoers')!;
    expect(rule).toBe(sudoersText(['floor', 'studio']));
    expect(rule).toContain('floor, studio ALL = (teamcli-owner) CWD=/ NOPASSWD: TEAMCLI_OWNER_SPEND');
    expect(rule).toContain('Cmnd_Alias TEAMCLI_OWNER_SPEND = /usr/local/teamcli-owner/bin/bun /usr/local/teamcli-owner/app/owner-spend.js\n');
    expect(fake.removed).toEqual(['/staging']);
  });

  test('again: the helper user it made is kept, and nothing else differs', async () => {
    const fake = fakeSystem({ users: { 'teamcli-owner': 'teamcli-owner:x:998:998::/var/lib/teamcli-owner:/usr/sbin/nologin' } });
    const outcome = await installOwnerState(fake, ['floor'], false);
    expect(outcome.ok).toBe(true);
    expect(commands(fake).some((argv) => argv[0] === '/usr/sbin/useradd')).toBe(false);
  });

  test('refusals: off Linux, without the administrator, an unknown or privileged account, a foreign helper user, a failing step', async () => {
    const why = (outcome: Awaited<ReturnType<typeof installOwnerState>>) => (outcome.ok ? 'installed' : outcome.why);
    expect(why(await installOwnerState(fakeSystem({ platform: 'darwin' }), ['floor'], false))).toContain('Linux');
    expect(why(await installOwnerState(fakeSystem({ uid: 1000 }), ['floor'], false))).toContain('sudo');
    expect(why(await installOwnerState(fakeSystem(), [], false))).toContain('--account');
    expect(why(await installOwnerState(fakeSystem(), ['nobody-here'], false))).toContain('not in the user database');
    expect(why(await installOwnerState(fakeSystem(), ['root'], false))).toContain('administrator');
    expect(why(await installOwnerState(fakeSystem(), ['Floor;rm'], false))).toContain('not an entity account name');
    const foreign = fakeSystem({ users: { 'teamcli-owner': 'teamcli-owner:x:1500:1500::/home/teamcli-owner:/bin/bash' } });
    expect(why(await installOwnerState(foreign, ['floor'], false))).toContain('did not make');
    expect(commands(foreign)).toEqual([]);
    const failing = fakeSystem({ fail: '/usr/local/teamcli-owner/bin/bun' });
    const failed = await installOwnerState(failing, ['floor'], false);
    expect(why(failed)).toContain('no space left');
    expect(commands(failing).some((argv) => argv[0] === '/usr/sbin/visudo')).toBe(false);
    expect(failing.removed).toEqual(['/staging']);
  });

  test('the command prints the plan; --dry-run changes nothing; --account and --dry-run belong to install', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'owner-install-')));
    try {
      const fake = fakeSystem({ uid: 1000 });
      const io = testIo(cwd);
      expect(await runOwnerSeat(['install', '--account', 'floor', '--dry-run'], io, { home: cwd, installSystem: fake })).toBe(0);
      expect(io.out).toContain('would run, as the administrator');
      expect(io.out).toContain('/etc/sudoers.d/teamcli-owner');
      expect(io.out).toContain('nothing was changed');
      expect(commands(fake)).toEqual([]);
      const refused = testIo(cwd);
      expect(await runOwnerSeat(['install', '--account', 'floor'], refused, { home: cwd, installSystem: fake })).toBe(1);
      expect(refused.err).toContain('sudo');
      const stray = testIo(cwd);
      expect(await runOwnerSeat(['status', '--dry-run'], stray, { home: cwd, installSystem: fake })).toBe(2);
      const bare = testIo(cwd);
      expect(await runOwnerSeat(['install'], bare, { home: cwd, installSystem: fake })).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('the helper program the install bundles is this build\'s own entry', () => {
    const entry = readFileSync(join(import.meta.dir, '..', 'src', 'client', 'owner-spend-main.ts'), 'utf8');
    expect(entry).toContain('runOwnerSpend');
    expect(entry).toContain('passwdNameOf');
  });
});
