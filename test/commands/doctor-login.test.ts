import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkLogin,
  doctorLoginFindings,
  realCommandRunner,
  runDoctor,
  type CommandRunner,
  type DoctorSources,
} from '../../src/commands/doctor.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { profileFor } from '../../src/profiles/index.ts';
import type { Profile } from '../../src/profiles/profile.ts';
import { testIo } from '../helpers.ts';

const example = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');

describe('checkLogin with fake command results', () => {
  test('cursor-agent status: exit 0 is signed in, exit non-zero is not, missing is null', () => {
    const profile = profileFor('cursor');
    if (!profile) throw new Error('cursor profile must exist');
    expect(profile.binary).toBe('cursor-agent');
    expect(profile.loginCheck).toEqual(['status']);

    const calls: { binary: string; args: string[] }[] = [];
    const runner: CommandRunner = (binary, args) => {
      calls.push({ binary, args });
      return { status: 0, stdout: 'Logged in as user@example.com\n' };
    };

    expect(checkLogin(profile, runner)).toBe(true);
    expect(calls).toEqual([{ binary: 'cursor-agent', args: ['status'] }]);

    expect(checkLogin(profile, () => ({ status: 1, stdout: 'Not logged in\n' }))).toBe(false);
    expect(checkLogin(profile, () => null)).toBeNull();
  });

  test('agy models: exit 0 is signed in, exit non-zero is not, missing is null', () => {
    const profile = profileFor('antigravity');
    if (!profile) throw new Error('antigravity profile must exist');
    expect(profile.binary).toBe('agy');
    expect(profile.loginCheck).toEqual(['models']);

    const calls: { binary: string; args: string[] }[] = [];
    const runner: CommandRunner = (binary, args) => {
      calls.push({ binary, args });
      return { status: 0, stdout: 'gemini-2.5-pro\ngemini-2.5-flash\n' };
    };

    expect(checkLogin(profile, runner)).toBe(true);
    expect(calls).toEqual([{ binary: 'agy', args: ['models'] }]);

    expect(checkLogin(profile, () => ({ status: 1, stdout: 'Not authenticated\n' }))).toBe(false);
    expect(checkLogin(profile, () => null)).toBeNull();
  });

  test('codex login status: exit 0 is signed in, exit non-zero is not, missing is null', () => {
    const profile = profileFor('codex');
    if (!profile) throw new Error('codex profile must exist');
    expect(profile.binary).toBe('codex');
    expect(profile.loginCheck).toEqual(['login', 'status']);

    const calls: { binary: string; args: string[] }[] = [];
    const runner: CommandRunner = (binary, args) => {
      calls.push({ binary, args });
      return { status: 0, stdout: 'Logged in using ChatGPT\n' };
    };

    expect(checkLogin(profile, runner)).toBe(true);
    expect(calls).toEqual([{ binary: 'codex', args: ['login', 'status'] }]);

    expect(checkLogin(profile, () => ({ status: 1, stdout: 'Logged out\n' }))).toBe(false);
    expect(checkLogin(profile, () => null)).toBeNull();
  });

  test('claude auth status: exit 0 is signed in, exit non-zero is not, missing is null', () => {
    const profile = profileFor('claude-code');
    if (!profile) throw new Error('claude-code profile must exist');
    expect(profile.binary).toBe('claude');
    expect(profile.loginCheck).toEqual(['auth', 'status']);

    const calls: { binary: string; args: string[] }[] = [];
    const runner: CommandRunner = (binary, args) => {
      calls.push({ binary, args });
      return { status: 0, stdout: 'Logged in as user@example.com\n' };
    };

    expect(checkLogin(profile, runner)).toBe(true);
    expect(calls).toEqual([{ binary: 'claude', args: ['auth', 'status'] }]);

    expect(checkLogin(profile, () => ({ status: 1, stdout: 'Not logged in\n' }))).toBe(false);
    expect(checkLogin(profile, () => null)).toBeNull();
  });

  test('profile with no loginCheck returns null and never runs commands', () => {
    const noCheckProfile: Profile = {
      cli: 'custom',
      processNames: ['custom'],
      binary: 'custom',
      tested: { from: '1.0', to: '1.0' },
      unattended: [],
      rulesOption: null,
      rulesMode: 'message',
      standingRules: [],
      herdrStatus: 'reliable',
      loginCheck: null,
      loginHint: 'custom login',
      exit: '/exit',
      exitKeys: [],
      exitClear: null,
      exitConfirm: null,
      input: null,
      compose: null,
      lobbyFiles: [],
      startupReads: [],
      mcpInbox: null,
      idleTimeout: 30,
      exitTimeout: 10,
      lastUsedModel: false,
      unreadModel: null,
      modelOf: () => null,
      modelIdOf: () => null,
      startsOnLastModel: false,
      modelFlag: () => ({ option: '--model', id: null }),
      answers: [],
    };
    let ran = false;
    expect(checkLogin(noCheckProfile, () => { ran = true; return { status: 0, stdout: '' }; })).toBeNull();
    expect(ran).toBe(false);
  });

  test('realCommandRunner handles missing binaries gracefully without throwing', () => {
    const result = realCommandRunner('nonexistent-binary-that-does-not-exist-12345', ['--version']);
    expect(result).toBeNull();
  });
});

describe('team doctor --login', () => {
  let dir: string;
  let home: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-doctor-login-'));
    home = join(dir, 'home');
    mkdirSync(join(dir, '.agents'));
    mkdirSync(home);
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, example);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeSources(overrides: Partial<DoctorSources> = {}): DoctorSources {
    return {
      version: () => null,
      onPath: () => false,
      loggedIn: () => true,
      herdrVersion: () => null,
      sessionRunning: () => null,
      now: () => NOW,
      home,
      ...overrides,
    };
  }

  test('reports each CLI in the file as logged in and exits 0', async () => {
    const io = testIo(dir);
    const code = await runDoctor(['--file', file, '--login'], io, fakeSources({
      loggedIn: (profile) => (profile.cli === 'claude-code' || profile.cli === 'codex' ? true : null),
    }));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      [
        'ok    claude-code: logged in',
        'ok    codex: logged in',
        'note  grok: the login is not checked in this version',
        'team doctor: nothing missing, 0 warnings',
        '',
      ].join('\n'),
    );
  });

  test('reports not signed in with loginHint and exits 1', async () => {
    const io = testIo(dir);
    const code = await runDoctor(['--file', file, '--login'], io, fakeSources({
      loggedIn: (profile) => {
        if (profile.cli === 'claude-code') return true;
        if (profile.cli === 'codex') return false;
        return null;
      },
    }));

    expect(code).toBe(1);
    expect(io.err).toBe('');
    expect(io.out).toContain('ok    claude-code: logged in\n');
    expect(io.out).toContain('MISS  log in to codex: `codex login`\n');
    expect(io.out).toContain('note  grok: the login is not checked in this version\n');
    expect(io.out).toContain('team doctor: 1 missing, 0 warnings: 1 of them block `up` and `add`\n');
  });

  test('reports unknown when loginCheck cannot tell or profile has none', async () => {
    const io = testIo(dir);
    const code = await runDoctor(['--file', file, '--login'], io, fakeSources({
      loggedIn: (profile) => {
        if (profile.cli === 'claude-code') return null;
        if (profile.cli === 'codex') return true;
        return null;
      },
    }));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('note  claude-code: the login is not checked in this version\n');
    expect(io.out).toContain('ok    codex: logged in\n');
    expect(io.out).toContain('team doctor: nothing missing, 0 warnings\n');
  });

  test('checks only login: unapproved file, silent herdr, missing watch do not block or report', async () => {
    const io = testIo(dir);
    // Sources have version null, onPath false, herdr null, session null - normally 4+ MISS
    const code = await runDoctor(['--file', file, '--login'], io, fakeSources({
      loggedIn: () => true,
    }));

    expect(code).toBe(0);
    expect(io.out).not.toContain('approve');
    expect(io.out).not.toContain('herdr');
    expect(io.out).not.toContain('watch');
    expect(io.out).not.toContain('PATH');
    expect(io.out).toContain('team doctor: nothing missing, 0 warnings\n');
  });

  test('doctorLoginFindings deduplicates CLIs and preserves file seat order', () => {
    const loaded = loadTeamFile(dir, { file });
    if (!loaded.ok) throw new Error('file must load');
    const sources = fakeSources({
      loggedIn: () => true,
    });
    const findings = doctorLoginFindings(loaded.team, sources);
    // example.yaml has claude-coordinator-acme (claude-code), codex-acme (codex),
    // deepseek-acme (claude-code), deepseek-acme-2 (claude-code), grok-acme (grok)
    expect(findings.map((f) => f.text)).toEqual([
      'claude-code: logged in',
      'codex: logged in',
      'grok: logged in',
    ]);
  });

  test('bad option reports usage with [--login]', async () => {
    const io = testIo(dir);
    const code = await runDoctor(['--file', file, '--invalid-flag'], io, fakeSources());
    expect(code).toBe(2);
    expect(io.err).toContain('unknown option --invalid-flag\n');
    expect(io.err).toContain('Usage: team doctor [--session <name>] [--file <path>] [--login] [--json]\n');
  });

  test('--json validates against DOCTOR_OUTPUT_SCHEMA and emits structured error on bad invocation', async () => {
    const { DOCTOR_OUTPUT_SCHEMA } = await import('../../src/output/index.ts');
    const { assertJsonErrorShape, assertMatchesOutputSchema } = await import('../helpers/output.ts');
    const io = testIo(dir);
    const code = await runDoctor(['--file', file, '--login', '--json'], io, fakeSources({
      loggedIn: (profile) => (profile.cli === 'claude-code' ? true : false),
    }));
    expect(code).toBe(1);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      project: string;
      session: string;
      login_only: boolean;
      findings: { level: string; text: string; blocks_launch: boolean }[];
      summary: { missing: number; warnings: number; blockers: number };
    }>(io.out, DOCTOR_OUTPUT_SCHEMA);
    expect(doc.project).toBe('acme-web');
    expect(doc.login_only).toBe(true);
    expect(doc.summary.missing).toBeGreaterThan(0);
    expect(doc.summary.blockers).toBeGreaterThan(0);
    expect(doc.findings.some((f) => f.blocks_launch === true)).toBe(true);

    const badIo = testIo(dir);
    const badCode = await runDoctor(['--file', file, '--json', 'extra'], badIo, fakeSources());
    expect(badCode).toBe(2);
    expect(badIo.err).toBe('');
    assertJsonErrorShape(badIo.out, { id: 'doctor.invocation', messageContains: 'unexpected "extra"', repair: null });

    const nopeIo = testIo(dir);
    expect(await runDoctor(['--nope', '--json'], nopeIo, fakeSources())).toBe(2);
    expect(nopeIo.err).toBe('');
    assertJsonErrorShape(nopeIo.out, { id: 'doctor.invocation', messageContains: 'unknown option --nope', repair: null });

    const inlineIo = testIo(dir);
    expect(await runDoctor(['--json=1'], inlineIo, fakeSources())).toBe(2);
    expect(inlineIo.err).toBe('');
    assertJsonErrorShape(inlineIo.out, { id: 'doctor.invocation', messageContains: 'unknown option --json', repair: null });

    const missingIo = testIo(dir);
    expect(await runDoctor(['--file', join(dir, 'missing.yaml'), '--json'], missingIo, fakeSources())).toBe(2);
    expect(missingIo.err).toBe('');
    assertJsonErrorShape(missingIo.out, { id: 'doctor.file', messageContains: 'no team file', repair: null });
  });
});
