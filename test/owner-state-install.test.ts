// `team owner-seat install`: the one administrator step that sets up a shared Linux machine's
// owner state. Run against a fake system that records every command and answers every path read:
// nothing here makes a user, a folder outside the test's own, or a privilege rule.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOwnerState, launcherText, OWNER_INSTALL_RECORD, OWNER_INSTALL_STAGING, sudoersText, type InstallSystem, type PathStat } from '../src/client/owner-state-install.ts';
import { readFileSync } from 'node:fs';

const RUN = `${OWNER_INSTALL_STAGING}/run-1`;
import { runOwnerSeat } from '../src/commands/owner-seat.ts';
import { testIo } from './helpers.ts';

type Fake = InstallSystem & { ran: string[][]; written: Map<string, string>; removed: string[]; paths: Map<string, PathStat>; files: Map<string, string> };

const HELPER_LINE = 'teamcli-owner:x:998:998::/var/lib/teamcli-owner:/usr/sbin/nologin';
const RECORD = `${JSON.stringify({ format: 'team-owner-install-v1', user: 'teamcli-owner', uid: 998, gid: 998, made_by: 'team owner-seat install' })}\n`;
const rootDir = (mode = 0o755): PathStat => ({ kind: 'present', type: 'dir', uid: 0, mode });

function fakeSystem(options: { uid?: number; platform?: NodeJS.Platform; users?: Record<string, string>; fail?: string; paths?: Record<string, PathStat>; files?: Record<string, string>; stagingMode?: number } = {}): Fake {
  const users: Record<string, string> = { floor: 'floor:x:1001:1001::/home/floor:/bin/bash', studio: 'studio:x:1002:1002::/home/studio:/bin/bash', root: 'root:x:0:0:root:/root:/bin/bash', ...options.users };
  const groups: Record<string, string> = users['teamcli-owner'] === undefined ? {} : { 'teamcli-owner': 'teamcli-owner:x:998:' };
  const paths = new Map<string, PathStat>(Object.entries({ '/': rootDir(), '/etc': rootDir(), '/etc/sudoers.d': rootDir(0o750), '/usr': rootDir(), '/usr/local': rootDir(), '/var': rootDir(), '/var/lib': rootDir(), ...options.paths }));
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const ran: string[][] = [];
  const written = new Map<string, string>();
  const removed: string[] = [];
  const fake: Fake = {
    platform: options.platform ?? 'linux',
    uid: () => options.uid ?? 0,
    ran,
    written,
    removed,
    paths,
    files,
    run: (argv) => {
      ran.push([...argv]);
      if (argv[0] === '/usr/bin/getent') {
        const line = (argv[1] === 'group' ? groups : users)[argv[2]!];
        return line === undefined ? { status: 2, stdout: '', stderr: '' } : { status: 0, stdout: `${line}\n`, stderr: '' };
      }
      if (argv[0] === '/usr/sbin/useradd') {
        users['teamcli-owner'] = HELPER_LINE;
        groups['teamcli-owner'] = 'teamcli-owner:x:998:';
      }
      if (options.fail !== undefined && argv.includes(options.fail)) return { status: 1, stdout: '', stderr: 'no space left' };
      // The staging folder, as `install -d` leaves it.
      if (argv[0] === '/usr/bin/install' && argv.at(-1) === OWNER_INSTALL_STAGING) paths.set(OWNER_INSTALL_STAGING, { kind: 'present', type: 'dir', uid: 0, mode: options.stagingMode ?? 0o700 });
      return { status: 0, stdout: '', stderr: '' };
    },
    lstat: (path) => paths.get(path) ?? { kind: 'absent' },
    read: (path) => files.get(path) ?? null,
    bun: '/opt/bun/bin/bun',
    bundle: async () => '// bundled helper\n',
    staging: (root) => {
      paths.set(`${root}/run-1`, { kind: 'present', type: 'dir', uid: 0, mode: 0o700 });
      return `${root}/run-1`;
    },
    write: (path, text) => { written.set(path, text); },
    remove: (path) => { removed.push(path); },
  };
  return fake;
}

/** A machine an earlier install set up: the helper user, its record, and its folders. */
function installedBefore(extra: Record<string, PathStat> = {}): Fake {
  return fakeSystem({
    users: { 'teamcli-owner': HELPER_LINE },
    files: { [OWNER_INSTALL_RECORD]: RECORD },
    paths: {
      '/etc/teamcli': rootDir(),
      [OWNER_INSTALL_RECORD]: { kind: 'present', type: 'file', uid: 0, mode: 0o644 },
      '/var/lib/teamcli-owner': { kind: 'present', type: 'dir', uid: 998, mode: 0o755 },
      '/var/lib/teamcli-owner/ledger': { kind: 'present', type: 'dir', uid: 998, mode: 0o755 },
      ...extra,
    },
  });
}

const commands = (fake: Fake) => fake.ran.filter((argv) => argv[0] !== '/usr/bin/getent');
const why = (outcome: Awaited<ReturnType<typeof installOwnerState>>) => (outcome.ok ? 'installed' : outcome.why);

describe('team owner-seat install', () => {
  test('dry run: runs every check, lists every step, and runs nothing that changes the machine', async () => {
    const fake = fakeSystem({ uid: 1000 });
    const outcome = await installOwnerState(fake, ['floor'], true);
    expect(outcome.ok).toBe(true);
    expect(commands(fake)).toEqual([]);
    expect(fake.written.size).toBe(0);
    const argv = outcome.steps.map((step) => step.argv.join(' '));
    expect(argv[0]).toBe(`/usr/bin/install -d -m 0700 -o root -g root ${OWNER_INSTALL_STAGING}`);
    expect(argv[1]).toBe('/usr/bin/install -d -m 0755 -o root -g root /etc/teamcli');
    expect(argv[2]).toBe('/usr/sbin/useradd --system --user-group --home-dir /var/lib/teamcli-owner --no-create-home --shell /usr/sbin/nologin teamcli-owner');
    expect(argv[3]).toBe(`/usr/bin/install -m 0644 -o root -g root ${OWNER_INSTALL_STAGING}/<run>/owner-install.json ${OWNER_INSTALL_RECORD}`);
    expect(argv).toContain('/usr/bin/install -d -m 0755 -o teamcli-owner -g teamcli-owner /var/lib/teamcli-owner /var/lib/teamcli-owner/ledger');
    expect(argv).toContain(`/usr/bin/install -m 0755 -o root -g root ${OWNER_INSTALL_STAGING}/<run>/owner-spend.sh /usr/local/teamcli-owner/bin/owner-spend`);
    expect(argv.at(-2)).toBe(`/usr/sbin/visudo -cf ${OWNER_INSTALL_STAGING}/<run>/teamcli-owner.sudoers`);
    expect(argv.at(-1)).toBe(`/usr/bin/install -m 0440 -o root -g root ${OWNER_INSTALL_STAGING}/<run>/teamcli-owner.sudoers /etc/sudoers.d/teamcli-owner`);
    expect(argv.every((line) => !/\bchmod\b|\bchown\b/.test(line))).toBe(true);
  });

  test('a real run: the user, its record at once, the folders, launcher, program and the checked rule, in order', async () => {
    const fake = fakeSystem();
    const outcome = await installOwnerState(fake, ['studio', 'floor'], false);
    expect(outcome.ok, why(outcome)).toBe(true);
    const run = commands(fake).map((argv) => argv.join(' '));
    expect(run[0]).toBe(`/usr/bin/install -d -m 0700 -o root -g root ${OWNER_INSTALL_STAGING}`);
    expect(run[2]).toStartWith('/usr/sbin/useradd');
    expect(run[3]).toEndWith(OWNER_INSTALL_RECORD);
    expect(run.findIndex((line) => line.startsWith('/usr/sbin/visudo'))).toBe(run.length - 2);
    expect(JSON.parse(fake.written.get(`${RUN}/owner-install.json`)!)).toEqual({ format: 'team-owner-install-v1', user: 'teamcli-owner', uid: 998, gid: 998, made_by: 'team owner-seat install' });
    expect(JSON.parse(fake.written.get(`${RUN}/owner-helper.json`)!)).toEqual({ format: 'team-owner-helper-v1', user: 'teamcli-owner', uid: 998 });
    expect(fake.written.get(`${RUN}/owner-spend.js`)).toBe('// bundled helper\n');
    expect(fake.written.get(`${RUN}/owner-spend.sh`)).toBe(launcherText());
    expect(fake.written.get(`${RUN}/teamcli-owner.sudoers`)).toBe(sudoersText(['floor', 'studio']));
    expect(fake.removed).toEqual([RUN]);
  });

  test('the rule names the launcher alone with no arguments, and the launcher writes the whole environment', () => {
    const rule = sudoersText(['floor', 'studio']);
    expect(rule).toContain('Cmnd_Alias TEAMCLI_OWNER_SPEND = /usr/local/teamcli-owner/bin/owner-spend ""\n');
    expect(rule).toContain('Defaults!TEAMCLI_OWNER_SPEND env_reset, !setenv, !env_keep\n');
    expect(rule).toContain('floor, studio ALL = (teamcli-owner) CWD=/ NOPASSWD: TEAMCLI_OWNER_SPEND\n');
    const launcher = launcherText();
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true);
    expect(launcher).toContain('exec /usr/bin/env -i PATH=/usr/bin:/bin ');
    expect(launcher).toContain('HOME=/var/lib/teamcli-owner TMPDIR=/var/lib/teamcli-owner/tmp');
    expect(launcher).toContain('TEAMCLI_CALLER_UID="$SUDO_UID" TEAMCLI_CALLER_USER="$SUDO_USER"');
    expect(launcher).toContain('/usr/local/teamcli-owner/bin/bun --no-env-file /usr/local/teamcli-owner/app/owner-spend.js\n');
    // Nothing of the caller's environment is named but its identity.
    expect(launcher.match(/\$[A-Z_]+/g)).toEqual(['$SUDO_UID', '$SUDO_USER']);
  });

  test('again: the user its record names is kept, and its record is not written again', async () => {
    const fake = installedBefore();
    const outcome = await installOwnerState(fake, ['floor'], false);
    expect(outcome.ok, why(outcome)).toBe(true);
    expect(commands(fake).some((argv) => argv[0] === '/usr/sbin/useradd' || argv.includes(OWNER_INSTALL_RECORD))).toBe(false);
  });

  test('a helper user with no install record, or one that differs from it, is never adopted', async () => {
    const stranger = fakeSystem({ users: { 'teamcli-owner': HELPER_LINE } });
    const refused = await installOwnerState(stranger, ['floor'], false);
    expect(why(refused)).toContain('no install record names');
    expect(why(refused)).toContain('sudo userdel teamcli-owner');
    expect(commands(stranger)).toEqual([]);
    for (const line of ['teamcli-owner:x:999:998::/var/lib/teamcli-owner:/usr/sbin/nologin', 'teamcli-owner:x:998:998::/home/teamcli-owner:/bin/bash']) {
      const fake = fakeSystem({ users: { 'teamcli-owner': line }, files: { [OWNER_INSTALL_RECORD]: RECORD }, paths: { '/etc/teamcli': rootDir(), [OWNER_INSTALL_RECORD]: { kind: 'present', type: 'file', uid: 0, mode: 0o644 } } });
      expect(why(await installOwnerState(fake, ['floor'], false))).toContain('is not the one');
      expect(commands(fake)).toEqual([]);
    }
    // A record whose user is gone, and a record the administrator does not own.
    const gone = fakeSystem({ files: { [OWNER_INSTALL_RECORD]: RECORD }, paths: { '/etc/teamcli': rootDir(), [OWNER_INSTALL_RECORD]: { kind: 'present', type: 'file', uid: 0, mode: 0o644 } } });
    expect(why(await installOwnerState(gone, ['floor'], false))).toContain('no longer holds');
    const forged = installedBefore({ [OWNER_INSTALL_RECORD]: { kind: 'present', type: 'file', uid: 1001, mode: 0o644 } });
    expect(why(await installOwnerState(forged, ['floor'], false))).toContain('only the administrator can write');
    // Stopped right after making the user: the next run says so and names the repair.
    const stopped = fakeSystem({ fail: OWNER_INSTALL_RECORD });
    expect(why(await installOwnerState(stopped, ['floor'], false))).toContain('failed');
    const next = fakeSystem({ users: { 'teamcli-owner': HELPER_LINE }, paths: { '/etc/teamcli': rootDir() } });
    expect(why(await installOwnerState(next, ['floor'], false))).toContain('sudo userdel teamcli-owner');
  });

  test('a link, or a folder above a path that someone else owns or may write, refuses before anything changes', async () => {
    const cases: Array<[Record<string, PathStat>, string]> = [
      // The code folder already a link into an account's home.
      [{ '/usr/local/teamcli-owner': { kind: 'present', type: 'link', uid: 1001, mode: 0o777 } }, '/usr/local/teamcli-owner is a link'],
      // A folder above the code folder that an account owns.
      [{ '/usr/local': { kind: 'present', type: 'dir', uid: 1001, mode: 0o755 } }, '/usr/local is not a folder only the administrator can change'],
      // A folder above the system folder others may write.
      [{ '/etc': rootDir(0o777) }, '/etc is not a folder only the administrator can change'],
      // A code folder an account owns.
      [{ '/usr/local/teamcli-owner': { kind: 'present', type: 'dir', uid: 1001, mode: 0o755 } }, 'owned by uid 1001'],
      // A program file left group-writable.
      [{ '/usr/local/teamcli-owner': rootDir(), '/usr/local/teamcli-owner/bin': rootDir(), '/usr/local/teamcli-owner/bin/bun': { kind: 'present', type: 'file', uid: 0, mode: 0o775 } }, 'its group or others may write it'],
      // The ledger a link, or owned by an account, before any helper user exists.
      [{ '/var/lib/teamcli-owner': rootDir(), '/var/lib/teamcli-owner/ledger': { kind: 'present', type: 'link', uid: 0, mode: 0o777 } }, 'is a link'],
      [{ '/var/lib/teamcli-owner': { kind: 'present', type: 'dir', uid: 1001, mode: 0o755 } }, 'owned by uid 1001'],
      // The rule's folder missing.
      [{ '/etc/sudoers.d': { kind: 'absent' } }, 'does not exist'],
    ];
    for (const [paths, said] of cases) {
      const fake = fakeSystem({ paths });
      const outcome = await installOwnerState(fake, ['floor'], false);
      expect(why(outcome), said).toContain(said);
      expect(why(outcome)).toContain('nothing was changed');
      expect(commands(fake)).toEqual([]);
      expect(fake.written.size).toBe(0);
      // The dry run refuses the same way.
      expect(why(await installOwnerState(fakeSystem({ paths, uid: 1000 }), ['floor'], true))).toContain(said);
    }
  });

  test("files are staged only in the install's own folder, the administrator's alone, never the temporary folder", async () => {
    // A staging folder that is a link, or one an account owns, refuses before anything changes.
    for (const stat of [{ kind: 'present', type: 'link', uid: 1001, mode: 0o777 }, { kind: 'present', type: 'dir', uid: 1001, mode: 0o700 }] as PathStat[]) {
      const fake = fakeSystem({ paths: { [OWNER_INSTALL_STAGING]: stat } });
      expect(why(await installOwnerState(fake, ['floor'], false))).toContain(OWNER_INSTALL_STAGING);
      expect(commands(fake)).toEqual([]);
      expect(fake.written.size).toBe(0);
    }
    // Made, but left open to others (an odd file-creation mask, say): refused before anything is staged.
    const open = fakeSystem({ stagingMode: 0o755 });
    expect(why(await installOwnerState(open, ['floor'], false))).toContain("not a folder of the administrator's alone");
    expect(commands(open).map((argv) => argv.at(-1))).toEqual([OWNER_INSTALL_STAGING]);
    expect(open.written.size).toBe(0);
    // A folder above it that an account owns.
    const above = fakeSystem({ paths: { '/var/lib': { kind: 'present', type: 'dir', uid: 1001, mode: 0o755 } } });
    expect(why(await installOwnerState(above, ['floor'], false))).toContain('/var/lib is not a folder only the administrator can change');
    // Every staged file is in this run's folder.
    const fake = fakeSystem();
    expect((await installOwnerState(fake, ['floor'], false)).ok).toBe(true);
    expect([...fake.written.keys()].every((path) => path.startsWith(`${RUN}/`))).toBe(true);
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'client', 'owner-state-install.ts'), 'utf8');
    expect(source).not.toContain('tmpdir');
  });

  test('refusals: off Linux, without the administrator, an unknown or privileged account, a failing step', async () => {
    expect(why(await installOwnerState(fakeSystem({ platform: 'darwin' }), ['floor'], false))).toContain('Linux');
    expect(why(await installOwnerState(fakeSystem({ uid: 1000 }), ['floor'], false))).toContain('sudo');
    expect(why(await installOwnerState(fakeSystem(), [], false))).toContain('--account');
    expect(why(await installOwnerState(fakeSystem(), ['nobody-here'], false))).toContain('not in the user database');
    expect(why(await installOwnerState(fakeSystem(), ['root'], false))).toContain('administrator');
    expect(why(await installOwnerState(fakeSystem(), ['Floor;rm'], false))).toContain('not an entity account name');
    const failing = fakeSystem({ fail: '/usr/local/teamcli-owner/bin/bun' });
    const failed = await installOwnerState(failing, ['floor'], false);
    expect(why(failed)).toContain('no space left');
    expect(commands(failing).some((argv) => argv[0] === '/usr/sbin/visudo')).toBe(false);
    expect(failing.removed).toEqual([RUN]);
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

  test('the helper program bundles only the leaf rules, and runs: started for no account, it spends nothing', async () => {
    const entry = join(import.meta.dir, '..', 'src', 'client', 'owner-spend-main.ts');
    const built = await Bun.build({ entrypoints: [entry], target: 'bun' });
    expect(built.success).toBe(true);
    const text = await built.outputs[0]!.text();
    const modules = [...new Set(text.match(/^\/\/ src\/[a-z/._-]+$/gm) ?? [])].sort();
    expect(modules).toEqual([
      '// src/client/owner-pin-path.ts',
      '// src/client/owner-pin-verify.ts',
      '// src/client/owner-request-record.ts',
      '// src/client/owner-signature.ts',
      '// src/client/owner-spend-lock.ts',
      '// src/client/owner-spend-main.ts',
      '// src/client/owner-spend.ts',
      '// src/client/owner-state-roots.ts',
      // The send host's effect guard: every file-changing `node:fs` call goes through it, and it
      // is a leaf itself (`node:fs` and the request scope, which imports nothing).
      '// src/host/guarded-fs.ts',
      '// src/host/request-scope.ts',
    ]);
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'owner-helper-')));
    try {
      const program = join(folder, 'owner-spend.js');
      writeFileSync(program, text);
      const run = Bun.spawnSync([process.execPath, '--no-env-file', program], { cwd: '/', stdin: Buffer.from('{}'), env: { PATH: '/usr/bin:/bin' } });
      expect(run.exitCode).toBe(1);
      const verdict = JSON.parse(run.stdout.toString()) as { format: string; ok: boolean; why: string };
      expect(verdict.format).toBe('team-owner-spend-verdict-v1');
      expect(verdict.ok).toBe(false);
      expect(verdict.why).toContain('not started for an account');
      // Input larger than a spend can be is refused while it is read.
      const flood = Bun.spawnSync([process.execPath, '--no-env-file', program], { cwd: '/', stdin: Buffer.alloc(2 * 1024 * 1024, 0x20), env: { PATH: '/usr/bin:/bin' } });
      expect(flood.exitCode).toBe(1);
      expect(JSON.parse(flood.stdout.toString()).why).toContain('larger than one can be');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
