// The neutral secret store: the Keychain adapter reads exactly what it read before the store was
// neutral, and the encrypted-dotenv adapter maps a store name to its env form, refuses the
// pay-per-use names, and never lets a value reach a reason, an argument or a launch line. Every
// scene runs a fake runner, except the last, which runs the launch line's own words through real
// shells against a fake store tool that prints a fixed fixture.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShellWords } from '../src/launch/shell-words.ts';
import { darwinSecretStore, keychainLookupCommand } from '../src/secrets/store-darwin.ts';
import { envNameOf, linuxSecretStore } from '../src/secrets/store-linux.ts';
import { systemSecretStore, type SecretRunOptions, type SecretRunResult, type SecretStoreOptions } from '../src/secrets/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

type Call = { command: string; args: string[]; options: SecretRunOptions };

/** A runner that records every call and answers with `answer`. */
function fakeRunner(answer: SecretRunResult): { calls: Call[]; runner: (command: string, args: string[], options: SecretRunOptions) => Promise<SecretRunResult> } {
  const calls: Call[] = [];
  return { calls, runner: async (command, args, options) => { calls.push({ command, args, options }); return answer; } };
}

const HOME = '/home/owner';
// One file per entity: the entity is the file, never part of a key's name.
const FILE = `${HOME}/.config/sops/acme.env.sops`;
const KEY = `${HOME}/.config/sops/age/keys.txt`;
const SOPS = `${HOME}/.local/bin/sops`;
const VALUE = 'sk-fixture-0123456789';
const DOTENV = `# a comment\nOTHER_DEEPSEEK_API_KEY=not-this-one\nDEEPSEEK_API_KEY=${VALUE}\nGITHUB_TOKEN=ghp-fixture\n`;

/** A Linux store on a synthetic machine: the file, the key and the tool are where `files` and
 *  `tools` say, and nothing else exists. */
function linux(runner: SecretStoreOptions['runner'], over: Partial<SecretStoreOptions> & { files?: string[]; tools?: string[] } = {}) {
  const files = new Set(over.files ?? [FILE, KEY]);
  const tools = new Set(over.tools ?? [SOPS]);
  return linuxSecretStore({
    ...(runner === undefined ? {} : { runner }),
    env: over.env ?? { PATH: '/usr/bin:/bin', HOME },
    home: over.home ?? HOME,
    ...('entity' in over ? (over.entity === undefined ? {} : { entity: over.entity }) : { entity: 'acme' }),
    isFile: (path) => files.has(path) || tools.has(path),
    isExecutable: (path) => tools.has(path),
  });
}

describe('the Keychain adapter reads what it always read', () => {
  test('the lookup is find-generic-password by service name, the key from stdout, one line feed removed', async () => {
    const fake = fakeRunner({ ok: true, stdout: `${VALUE}\n` });
    const read = await darwinSecretStore({ runner: fake.runner }).read('floor-github-token');
    expect(read).toEqual({ ok: true, value: VALUE });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toBe('/usr/bin/security');
    expect(fake.calls[0]!.args).toEqual(['find-generic-password', '-s', 'floor-github-token', '-w']);
    expect(fake.calls[0]!.options).toEqual({ cap: 4096, timeoutMs: 5000 });
  });

  test('its reasons are the ones team git and team gh have always printed', async () => {
    expect(await darwinSecretStore({ runner: fakeRunner({ ok: false }).runner }).read('x')).toEqual({ ok: false, reason: 'the lookup failed' });
    expect(await darwinSecretStore({ runner: fakeRunner({ ok: true, stdout: '\n' }).runner }).read('x')).toEqual({ ok: false, reason: 'the lookup printed nothing' });
    expect(await darwinSecretStore({ runner: fakeRunner({ ok: true, stdout: 'two words\n' }).runner }).read('x')).toEqual({ ok: false, reason: 'the lookup printed an illegal key' });
  });

  test('the launch line\'s lookup is the words it has always been', () => {
    expect(keychainLookupCommand('deepseek-api-key')).toBe('/usr/bin/security find-generic-password -s deepseek-api-key -w');
    expect(darwinSecretStore().lookupCommand('deepseek-api-key')).toEqual({ ok: true, command: '/usr/bin/security find-generic-password -s deepseek-api-key -w' });
    expect(darwinSecretStore().lookupCommand('two words').ok).toBe(false);
  });
});

describe('the encrypted-dotenv adapter', () => {
  test('a store name is read under its env form', () => {
    expect(envNameOf('deepseek-api-key')).toEqual({ ok: true, env: 'DEEPSEEK_API_KEY' });
    expect(envNameOf('floor-github-token')).toEqual({ ok: true, env: 'FLOOR_GITHUB_TOKEN' });
    expect(envNameOf('KIMI_API_KEY')).toEqual({ ok: true, env: 'KIMI_API_KEY' });
    expect(envNameOf('a.b').ok).toBe(false);
    expect(envNameOf('1password').ok).toBe(false);
    expect(envNameOf('two words').ok).toBe(false);
  });

  test('a read decrypts the file with the tool and keeps the one entry', async () => {
    const fake = fakeRunner({ ok: true, stdout: DOTENV });
    expect(await linux(fake.runner).read('deepseek-api-key')).toEqual({ ok: true, value: VALUE });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe(SOPS);
    expect(call.args).toEqual(['decrypt', '--input-type', 'dotenv', '--output-type', 'dotenv', FILE]);
    // The age key is named when the environment leaves it unset; the value is never an argument.
    expect(call.options.env?.SOPS_AGE_KEY_FILE).toBe(KEY);
    expect(call.args.join(' ')).not.toContain(VALUE);
  });

  test('a key file the environment names is kept', async () => {
    const fake = fakeRunner({ ok: true, stdout: DOTENV });
    await linux(fake.runner, { env: { PATH: '/usr/bin', HOME, SOPS_AGE_KEY_FILE: '/keys/elsewhere.txt' } }).read('deepseek-api-key');
    expect(fake.calls[0]!.options.env?.SOPS_AGE_KEY_FILE).toBe('/keys/elsewhere.txt');
  });

  test('the pay-per-use names are refused before anything runs', async () => {
    const fake = fakeRunner({ ok: true, stdout: 'ANTHROPIC_API_KEY=x\nGEMINI_API_KEY=y\n' });
    const store = linux(fake.runner);
    for (const name of ['anthropic-api-key', 'ANTHROPIC_API_KEY', 'gemini-api-key']) {
      const read = await store.read(name);
      expect(read.ok, name).toBe(false);
      if (!read.ok) expect(read.reason).toContain('pay-per-use');
      expect(store.lookupCommand(name).ok, name).toBe(false);
    }
    expect(fake.calls).toHaveLength(0);
  });

  test('a missing entry, a doubled one, an empty one and a failed decrypt each say why, never a value', async () => {
    const missing = await linux(fakeRunner({ ok: true, stdout: DOTENV }).runner).read('kimi-api-key');
    expect(missing).toEqual({ ok: false, reason: 'the system\'s secret store holds no entry for it' });
    const doubled = await linux(fakeRunner({ ok: true, stdout: `${DOTENV}DEEPSEEK_API_KEY=${VALUE}2\n` }).runner).read('deepseek-api-key');
    expect(doubled).toEqual({ ok: false, reason: 'the system\'s secret store holds that entry more than once' });
    const empty = await linux(fakeRunner({ ok: true, stdout: 'DEEPSEEK_API_KEY=\n' }).runner).read('deepseek-api-key');
    expect(empty).toEqual({ ok: false, reason: 'its entry in the system\'s secret store is empty' });
    const spaced = await linux(fakeRunner({ ok: true, stdout: `DEEPSEEK_API_KEY=${VALUE} tail\n` }).runner).read('deepseek-api-key');
    expect(spaced.ok).toBe(false);
    if (!spaced.ok) expect(spaced.reason).not.toContain(VALUE);
    const failed = await linux(fakeRunner({ ok: false }).runner).read('deepseek-api-key');
    expect(failed).toEqual({ ok: false, reason: 'the system\'s secret store could not be opened' });
  });

  test('no file, no tool: the reason says so and nothing runs', async () => {
    const fake = fakeRunner({ ok: true, stdout: DOTENV });
    expect(await linux(fake.runner, { files: [KEY] }).read('deepseek-api-key'))
      .toEqual({ ok: false, reason: 'the system\'s secret store is not set up on this machine' });
    expect(await linux(fake.runner, { tools: [] }).read('deepseek-api-key'))
      .toEqual({ ok: false, reason: 'the system\'s secret store cannot be opened: its tool is not installed' });
    expect(fake.calls).toHaveLength(0);
  });

  test('an empty or relative home never places the store in the current folder', async () => {
    const asked: string[] = [];
    const store = linuxSecretStore({
      home: '',
      env: { HOME: 'relative/home' },
      entity: 'acme',
      isFile: (path) => { asked.push(path); return false; },
      isExecutable: () => false,
      runner: fakeRunner({ ok: true, stdout: DOTENV }).runner,
    });
    expect((await store.read('deepseek-api-key')).ok).toBe(false);
    expect(asked.length).toBeGreaterThan(0);
    for (const path of asked) expect(path.startsWith('/'), path).toBe(true);
  });

  test('the file override is used when it is absolute, and refused when it is not', async () => {
    const fake = fakeRunner({ ok: true, stdout: DOTENV });
    const other = '/srv/secrets/team.env.sops';
    const store = linux(fake.runner, { files: [other, KEY], env: { PATH: '/usr/bin', HOME, TEAMCLI_SECRETS_FILE: other } });
    expect(await store.read('deepseek-api-key')).toEqual({ ok: true, value: VALUE });
    expect(fake.calls[0]!.args.at(-1)).toBe(other);
    const relative = linux(fake.runner, { env: { PATH: '/usr/bin', HOME, TEAMCLI_SECRETS_FILE: 'team.env.sops' } });
    expect(await relative.read('deepseek-api-key')).toEqual({ ok: false, reason: 'TEAMCLI_SECRETS_FILE must name an absolute path' });
  });

  test('the tool is found on PATH first, then where a user install puts it; a relative PATH entry is never used', async () => {
    const onPath = fakeRunner({ ok: true, stdout: DOTENV });
    await linux(onPath.runner, { tools: ['/opt/tools/sops', SOPS], env: { PATH: 'bin:/opt/tools', HOME } }).read('deepseek-api-key');
    expect(onPath.calls[0]!.command).toBe('/opt/tools/sops');
    const installed = fakeRunner({ ok: true, stdout: DOTENV });
    await linux(installed.runner, { tools: ['/usr/local/bin/sops'], env: { HOME } }).read('deepseek-api-key');
    expect(installed.calls[0]!.command).toBe('/usr/local/bin/sops');
    const relative = fakeRunner({ ok: true, stdout: DOTENV });
    const read = await linux(relative.runner, { tools: ['bin/sops'], env: { PATH: 'bin', HOME } }).read('deepseek-api-key');
    expect(read.ok).toBe(false);
    expect(relative.calls).toHaveLength(0);
  });

  test('the launch line\'s lookup names every location as found, carries no quote, and escapes its one pattern character', () => {
    const lookup = linux(undefined).lookupCommand('deepseek-api-key');
    expect(lookup).toEqual({
      ok: true,
      command: `SOPS_AGE_KEY_FILE=${KEY} ${SOPS} decrypt --input-type dotenv --output-type dotenv ${FILE} | sed -n s/\\^DEEPSEEK_API_KEY=//p`,
    });
    if (lookup.ok) {
      expect(lookup.command).not.toMatch(/["'`]/);
      expect(lookup.command).not.toContain('/usr/bin/security');
      const read = readShellWords(`TOKEN="$(${lookup.command})" claude`);
      expect('unreadable' in read).toBe(false);
      expect(read.words.map((word) => word.text)).toEqual([`TOKEN=$(${lookup.command})`, 'claude']);
    }
  });

  test('the launch line\'s lookup refuses what it cannot write: no key file, a path a shell would read', () => {
    expect(linux(undefined, { files: [FILE] }).lookupCommand('deepseek-api-key'))
      .toEqual({ ok: false, reason: 'the system\'s secret store cannot be opened: its key is not on this machine' });
    const spaced = '/home/the owner';
    const store = linux(undefined, {
      home: spaced,
      env: { PATH: '/usr/bin', HOME: spaced },
      files: [`${spaced}/.config/sops/acme.env.sops`, `${spaced}/.config/sops/age/keys.txt`],
      tools: [`${spaced}/.local/bin/sops`],
    });
    expect(store.lookupCommand('deepseek-api-key').ok).toBe(false);
  });
});

describe('one file per entity, generic names inside it', () => {
  const ENTRIES = 'GITHUB_SEAT_TOKEN=github_pat_fixture0123\nKIMI_API_KEY=sk-kimi-fixture\nACME_GITHUB_TOKEN=github_pat_owner-entry\n';
  const github = { keychain: 'acme-github-token', secret: 'GITHUB_SEAT_TOKEN', prefix: 'github_pat_' };

  test('the entity names the file; another entity reads its own', async () => {
    const acme = fakeRunner({ ok: true, stdout: ENTRIES });
    await linux(acme.runner).read('kimi-api-key');
    expect(acme.calls[0]!.args.at(-1)).toBe(`${HOME}/.config/sops/acme.env.sops`);
    const beacon = fakeRunner({ ok: true, stdout: ENTRIES });
    const file = `${HOME}/.config/sops/beacon.env.sops`;
    await linux(beacon.runner, { entity: 'beacon', files: [file, KEY] }).read('kimi-api-key');
    expect(beacon.calls[0]!.args.at(-1)).toBe(file);
  });

  test('with no entity and no override no file is opened, and nothing runs', async () => {
    const fake = fakeRunner({ ok: true, stdout: ENTRIES });
    const store = linux(fake.runner, { entity: undefined });
    const reason = 'the system\'s secret store keeps one file per entity, and no entity applies here';
    expect(await store.read('kimi-api-key')).toEqual({ ok: false, reason });
    expect(store.lookupCommand('kimi-api-key')).toEqual({ ok: false, reason });
    expect((await linux(fake.runner, { entity: '../acme' }).read('kimi-api-key')).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
    // The override still names its one file, whatever the entity.
    const other = '/srv/secrets/team.env.sops';
    const named = linux(fake.runner, { entity: undefined, files: [other, KEY], env: { PATH: '/usr/bin', HOME, TEAMCLI_SECRETS_FILE: other } });
    expect(await named.read('kimi-api-key')).toEqual({ ok: true, value: 'sk-kimi-fixture' });
  });

  test('an entry\'s generic name is read, never the owner\'s machine-wide name', async () => {
    expect(await linux(fakeRunner({ ok: true, stdout: ENTRIES }).runner).read(github)).toEqual({ ok: true, value: 'github_pat_fixture0123' });
    const only = await linux(fakeRunner({ ok: true, stdout: 'ACME_GITHUB_TOKEN=github_pat_owner-entry\n' }).runner).read(github);
    expect(only).toEqual({ ok: false, reason: 'the system\'s secret store holds no entry for it' });
    const lookup = linux(undefined).lookupCommand({ keychain: 'kimi-owner-key', secret: 'KIMI_API_KEY' });
    expect(lookup.ok && lookup.command.endsWith('| sed -n s/\\^KIMI_API_KEY=//p')).toBe(true);
  });

  test('a value under a generic name that does not start with its prefix is refused, never shown', async () => {
    const classic = await linux(fakeRunner({ ok: true, stdout: 'GITHUB_SEAT_TOKEN=ghp_classic0123\n' }).runner).read(github);
    expect(classic).toEqual({ ok: false, reason: 'its entry in the system\'s secret store does not start with github_pat_' });
  });

  test('the Keychain reads the owner\'s own entry, as it always has, and checks no prefix', async () => {
    const fake = fakeRunner({ ok: true, stdout: 'ghp_classic0123\n' });
    expect(await darwinSecretStore({ runner: fake.runner, entity: 'acme' }).read(github)).toEqual({ ok: true, value: 'ghp_classic0123' });
    expect(fake.calls[0]!.args).toEqual(['find-generic-password', '-s', 'acme-github-token', '-w']);
    expect(darwinSecretStore().lookupCommand({ keychain: 'kimi-owner-key', secret: 'KIMI_API_KEY' }))
      .toEqual({ ok: true, command: '/usr/bin/security find-generic-password -s kimi-owner-key -w' });
  });
});

describe('the store is chosen by platform', () => {
  test('darwin gets the Keychain, linux the encrypted file, any other platform none', () => {
    expect(systemSecretStore({ platform: 'darwin' })?.lookupCommand('kimi-api-key'))
      .toEqual({ ok: true, command: '/usr/bin/security find-generic-password -s kimi-api-key -w' });
    const linuxStore = systemSecretStore({ platform: 'linux', home: HOME, env: { HOME }, entity: 'acme', isFile: () => true, isExecutable: (path) => path === SOPS });
    const lookup = linuxStore?.lookupCommand('kimi-api-key');
    expect(lookup?.ok).toBe(true);
    if (lookup?.ok) expect(lookup.command).toContain('KIMI_API_KEY=');
    expect(systemSecretStore({ platform: 'win32' })).toBeNull();
    expect(systemSecretStore({ platform: 'freebsd' })).toBeNull();
  });
});

describe('the launch line\'s lookup, run by real shells', () => {
  // A fake store tool that prints the fixture whatever it is asked; the line's own words do the
  // rest. Each shell runs `NAME="$(lookup)"` exactly as a pane's shell runs the launch line.
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((shell) => existsSync(shell));

  test('every shell on this machine hands the CLI the one entry', () => {
    const base = mkdtempSync(join(tmpdir(), 'secret-store-'));
    made.push(base);
    const bin = join(base, 'bin');
    mkdirSync(bin);
    mkdirSync(join(base, '.config', 'sops', 'age'), { recursive: true });
    writeFileSync(join(base, '.config', 'sops', 'acme.env.sops'), 'not read by the fake tool\n', { mode: 0o600 });
    writeFileSync(join(base, '.config', 'sops', 'age', 'keys.txt'), 'not read by the fake tool\n', { mode: 0o600 });
    writeFileSync(join(bin, 'sops'), `#!/bin/sh\nprintf '%s' '${DOTENV}'\n`, { mode: 0o755 });
    const lookup = linuxSecretStore({ home: base, env: { PATH: bin, HOME: base }, entity: 'acme' }).lookupCommand('deepseek-api-key');
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) {
      // zsh's extended_glob reads `^` as a pattern operator: the escaped program must survive it.
      const prelude = shell.endsWith('zsh') ? 'setopt extended_glob; ' : '';
      const ran = spawnSync(shell, ['-c', `${prelude}TOKEN="$(${lookup.command})"; printf '%s' "$TOKEN"`], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base },
      });
      expect(ran.status, shell).toBe(0);
      expect(ran.stdout, shell).toBe(VALUE);
    }
  });
});
