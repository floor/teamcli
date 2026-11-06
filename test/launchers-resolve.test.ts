// Discovery and resolution coverage: inheritance across launcher homes, ambiguous names,
// reference chains and their failures, argv construction without a shell, caller-arg
// policies, resume precedence, scrubbed environments, and the sandbox verdicts including
// the fail-closed setup contract. Every fixture is synthetic; the parent environment and
// the existing-paths set are explicit inputs.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, toValue } from '../src/yaml.ts';
import { discover, resolveLaunch, type LauncherHome, type ResolveContext } from '../src/launchers/resolve.ts';
import { checkSandbox } from '../src/launchers/sandbox.ts';
import { validateDefinition } from '../src/launchers/validate.ts';
import type { Diagnostic } from '../src/launchers/types.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'launchers');

function homeFromDisk(level: LauncherHome['level'], dir: string): LauncherHome {
  const files: Record<string, unknown> = {};
  for (const file of readdirSync(join(FIXTURES, dir)).sort()) {
    files[file] = toValue(parseYaml(readFileSync(join(FIXTURES, dir, file), 'utf8')));
  }
  return { level, files };
}

const CTX: ResolveContext = {
  teamRoot: '/srv/example/repo',
  teamHome: '/srv/example/team-home',
  cwd: '/srv/example/repo',
  parentEnv: { PATH: '/usr/bin', HOME: '/home/example', TERM: 'xterm', LANG: 'en_US.UTF-8', EXAMPLE_TOKEN: 'parent-value', UNRELATED: 'x' },
  existingPaths: ['/opt/example/cli-builds/2.1.296/claude', '/srv/example/team-home/lead-session'],
};

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

const VALID = homeFromDisk('team', 'home-valid');

describe('discovery and inheritance', () => {
  test('the on-disk valid home discovers five launchers with no error', () => {
    const { launchers, diagnostics } = discover([VALID]);
    expect([...launchers.keys()].sort()).toEqual(['claude-on-acme', 'lead-preset', 'legacy-tool', 'org-identity', 'pinned-console']);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  test('nearest level wins per name; the shadowed definition warns', () => {
    const machine: LauncherHome = { level: 'machine', files: { 'org-identity.yaml': VALID.files['org-identity.yaml'] } };
    const { launchers, diagnostics } = discover([VALID, machine]);
    expect(launchers.get('org-identity')?.level).toBe('team');
    const shadow = diagnostics.find((d) => d.code === 'W_SHADOWED');
    expect(shadow?.level).toBe('machine');
    expect(shadow?.message).toContain('team');
  });

  test('two files of one name at the same level are refused together', () => {
    const consoleDef = { format: 1, name: 'console', kind: 'custom', argv: ['/bin/true'] };
    const dup: LauncherHome = { level: 'team', files: { 'console.yaml': consoleDef, 'console.json': consoleDef } };
    const { launchers, diagnostics } = discover([dup]);
    expect(codes(diagnostics)).toContain('E_NAME_DUP');
    expect(launchers.has('console')).toBe(false);
  });

  test('an invalid file at a nearer level does not expose the shadowed one silently', () => {
    const seat: LauncherHome = { level: 'seat', files: { 'org-identity.yaml': { format: 1, name: 'org-identity', kind: 'endpoint' } } };
    const { launchers, diagnostics } = discover([seat, VALID]);
    // The seat-level file is invalid (no harness/provider): its errors are reported and
    // the team-level definition still resolves, with the shadow order intact.
    expect(diagnostics.some((d) => d.severity === 'error' && d.level === 'seat')).toBe(true);
    expect(launchers.get('org-identity')?.level).toBe('team');
  });
});

describe('reference chains', () => {
  const { launchers } = discover([VALID]);
  const discovery = { launchers, diagnostics: [] as Diagnostic[] };

  test('seat → preset → endpoint → identity resolves the full chain', () => {
    const out = resolveLaunch({ launcher: 'lead-preset' }, discovery, CTX);
    expect(out.ok).toBe(true);
    expect(out.chain).toEqual(['lead-preset', 'claude-on-acme', 'org-identity']);
  });

  test('unknown reference and wrong-kind prefix/base refuse; cycles are unreachable by construction', () => {
    expect(resolveLaunch({ launcher: 'nope' }, discovery, CTX).diagnostics.map((d) => d.code)).toContain('E_REF_UNKNOWN');

    // A preset basing on another preset is the only shape that could ever cycle; the kind
    // rule refuses it at the first hop, before any cycle can form (the resolver keeps a
    // defensive E_REF_CYCLE guard regardless).
    const cycle: LauncherHome = {
      level: 'team',
      files: {
        'a.yaml': { format: 1, name: 'a', kind: 'preset', harness: 'claude-code', base: 'b', writable_folders: [{ path: '{root}' }] },
        'b.yaml': { format: 1, name: 'b', kind: 'preset', harness: 'claude-code', base: 'a', writable_folders: [{ path: '{root}' }] },
      },
    };
    const cyc = discover([cycle]);
    expect(resolveLaunch({ launcher: 'a' }, cyc, CTX).diagnostics.map((d) => d.code)).toContain('E_REF_KIND');

    const badPrefix: LauncherHome = {
      level: 'team',
      files: {
        'e.yaml': { format: 1, name: 'e', kind: 'endpoint', harness: 'claude-code', prefix: 'p', writable_folders: [{ path: '{root}' }], provider: { name: 'p', base_url: 'https://p.invalid', token: { store: 's', item: 'i' }, models: { default: 'm' } } },
        'p.yaml': { format: 1, name: 'p', kind: 'preset', harness: 'claude-code', writable_folders: [{ path: '{root}' }] },
      },
    };
    expect(resolveLaunch({ launcher: 'e' }, discover([badPrefix]), CTX).diagnostics.map((d) => d.code)).toContain('E_REF_KIND');

    const bareIdentity = discover([{ level: 'team' as const, files: { 'org-identity.yaml': VALID.files['org-identity.yaml'] } }]);
    expect(resolveLaunch({ launcher: 'org-identity' }, bareIdentity, CTX).diagnostics.map((d) => d.code)).toContain('E_REF_KIND');
  });

  test('a launcher named like a seat warns, never blocks', () => {
    const out = resolveLaunch({ launcher: 'legacy-tool' }, discovery, { ...CTX, seatNames: ['legacy-tool'] });
    expect(out.ok).toBe(true);
    expect(codes(out.diagnostics)).toContain('W_NAME_COLLIDES_SEAT');
  });
});

describe('argv construction without a shell', () => {
  const { launchers } = discover([VALID]);
  const discovery = { launchers, diagnostics: [] as Diagnostic[] };

  test('argv is an array: executable, fixed args (the inline settings fold as data), then admitted caller args', () => {
    const out = resolveLaunch({ launcher: 'claude-on-acme', args: ['--verbose'] }, discovery, CTX);
    expect(out.ok).toBe(true);
    expect(out.argv[0]).toBe('claude-code');
    // The one inline --settings object folds into the resolved settings object and leaves
    // argv: a merged result never coexists with a stale contradictory flag (D5).
    expect(out.argv).not.toContain('--settings');
    expect(out.settings).toEqual({ crossSessionInbound: 'accept' });
    expect(out.argv[out.argv.length - 1]).toBe('--verbose');
    expect(out.argv.every((word) => typeof word === 'string')).toBe(true);
  });

  test('caller words with shell metacharacters survive byte-identical as single elements', () => {
    const nasty = 'run $(rm -rf ~) && echo `whoami`; "quoted"';
    const out = resolveLaunch({ launcher: 'claude-on-acme', args: ['--append-system-prompt', nasty] }, discovery, CTX);
    expect(out.ok).toBe(true);
    expect(out.argv[out.argv.length - 1]).toBe(nasty);
  });

  test('refuse: a caller settings arg fails against the endpoint policy', () => {
    const out = resolveLaunch({ launcher: 'claude-on-acme', args: ['--settings', '{"evil":true}'] }, discovery, CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_ARG_REFUSED');
  });

  test('strip removes caller args of the class only, never the fixed args', () => {
    const stripHome: LauncherHome = {
      level: 'team',
      files: {
        's.yaml': {
          format: 1, name: 's', kind: 'preset', harness: 'claude-code',
          args: ['--model', 'fixed-model'], arg_policy: { model: 'strip' },
          writable_folders: [{ path: '{root}' }],
        },
      },
    };
    const out = resolveLaunch({ launcher: 's', args: ['--model', 'caller-model'] }, discover([stripHome]), CTX);
    expect(out.ok).toBe(true);
    expect(out.argv).toEqual(['claude-code', '--model', 'fixed-model']);
    expect(codes(out.diagnostics)).toContain('W_ARG_STRIPPED');
  });

  test('override: the caller model replaces the fixed one', () => {
    const out = resolveLaunch({ launcher: 'lead-preset', args: ['--model', 'caller-model'] }, discovery, CTX);
    expect(out.ok).toBe(true);
    expect(out.argv).not.toContain('acme-large-1');
    expect(out.argv).toContain('caller-model');
  });

  test('custom: verbatim argv, args refused, cwd honored', () => {
    const out = resolveLaunch({ launcher: 'legacy-tool', args: ['--extra'] }, discovery, CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_ARG_REFUSED');

    const bare = resolveLaunch({ launcher: 'legacy-tool' }, discovery, CTX);
    expect(bare.ok).toBe(true);
    expect(bare.argv).toEqual(['/bin/zsh', '/opt/example/wrappers/legacy.sh', '--fixed flag with spaces']);
    expect(bare.cwd).toBe('/srv/example/seats/legacy');
    // The escape hatch declares no folders: the warning records the absent boundary.
    expect(codes(bare.diagnostics)).toContain('W_SANDBOX_UNENFORCED');
  });

  test('a preset with caller_args: refuse rejects every caller arg (wrapper forwarded none)', () => {
    const out = resolveLaunch({ launcher: 'pinned-console', args: ['--verbose'] }, discovery, CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_ARG_REFUSED');
    expect(out.diagnostics.find((d) => d.code === 'E_ARG_REFUSED')?.message).toContain('caller_args');
  });
});

describe('environment resolution', () => {
  const { launchers } = discover([VALID]);
  const discovery = { launchers, diagnostics: [] as Diagnostic[] };

  test('secrets stay references: the provider token resolves to a { secret } entry', () => {
    const out = resolveLaunch({ launcher: 'claude-on-acme' }, discovery, CTX);
    const token = out.env.find((e) => e.name === 'ANTHROPIC_AUTH_TOKEN');
    expect(token).toEqual({ name: 'ANTHROPIC_AUTH_TOKEN', secret: { store: 'example-store', item: 'acme-api-key' } });
    // The parent's synthetic variables are inherited (env_policy defaults to inherit);
    // the only secret-shaped entry is the reference itself, never a value.
    expect(out.env.find((e) => e.name === 'EXAMPLE_TOKEN')).toEqual({ name: 'EXAMPLE_TOKEN', value: 'parent-value' });
    expect(out.env.filter((e) => 'secret' in e).map((e) => e.name).sort()).toEqual(['ANTHROPIC_AUTH_TOKEN', 'EXAMPLE_ORG_TOKEN']);
    expect(out.env.find((e) => e.name === 'ANTHROPIC_BASE_URL')).toEqual({ name: 'ANTHROPIC_BASE_URL', value: 'https://api.acme.invalid/anthropic' });
    expect(out.env.find((e) => e.name === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toEqual({ name: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', value: '262144' });
  });

  test('inherit passes the parent env through; scrub keeps only the keep list plus launcher env', () => {
    const inherited = resolveLaunch({ launcher: 'claude-on-acme' }, discovery, CTX);
    expect(inherited.env.find((e) => e.name === 'UNRELATED')).toEqual({ name: 'UNRELATED', value: 'x' });

    const scrubbed = resolveLaunch({ launcher: 'pinned-console' }, discovery, CTX);
    const names = scrubbed.env.map((e) => e.name).sort();
    expect(names).toEqual(['EXAMPLE_SEAT', 'HOME', 'LANG', 'PATH', 'TERM']);
    expect(scrubbed.env.find((e) => e.name === 'UNRELATED')).toBeUndefined();
    expect(scrubbed.env.find((e) => e.name === 'EXAMPLE_SEAT')).toEqual({ name: 'EXAMPLE_SEAT', value: 'console' });
  });

  test('an override across layers names the variable, never the value', () => {
    const clashHome: LauncherHome = {
      level: 'team',
      files: {
        'i.yaml': { format: 1, name: 'i', kind: 'identity', env: { SHARED: 'from-identity' } },
        'e.yaml': {
          format: 1, name: 'e', kind: 'endpoint', harness: 'claude-code', prefix: 'i',
          env: { SHARED: 'from-endpoint' },
          writable_folders: [{ path: '{root}' }],
          provider: { name: 'p', base_url: 'https://p.invalid', token: { store: 's', item: 'k' }, models: { default: 'm' } },
        },
      },
    };
    const out = resolveLaunch({ launcher: 'e' }, discover([clashHome]), CTX);
    expect(out.env.find((e) => e.name === 'SHARED')).toEqual({ name: 'SHARED', value: 'from-endpoint' });
    const override = out.diagnostics.find((d) => d.code === 'W_ENV_OVERRIDE');
    expect(override?.message).toContain('SHARED');
    expect(override?.message).not.toContain('from-identity');
  });

  test('an endpoint on a harness with no documented provider route refuses honestly', () => {
    const codexHome: LauncherHome = {
      level: 'team',
      files: {
        'cdx.yaml': {
          format: 1, name: 'cdx', kind: 'endpoint', harness: 'codex',
          writable_folders: [{ path: '{root}' }],
          provider: { name: 'acme', base_url: 'https://api.acme.invalid', token: { store: 's', item: 'k' }, models: { default: 'm' } },
        },
      },
    };
    const out = resolveLaunch({ launcher: 'cdx' }, discover([codexHome]), CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_PROVIDER_UNSUPPORTED');
  });
});

describe('resume precedence and restore behavior', () => {
  const { launchers } = discover([VALID]);
  const discovery = { launchers, diagnostics: [] as Diagnostic[] };

  test('teamcli_wins: a TeamCLI session argument beats the preset state file', () => {
    const out = resolveLaunch({ launcher: 'lead-preset' }, discovery, { ...CTX, sessionArg: 'sess-123' });
    expect(out.resume).toEqual({ kind: 'teamcli', session: 'sess-123' });
  });

  test('without a session argument the existing state file resumes', () => {
    const out = resolveLaunch({ launcher: 'lead-preset' }, discovery, CTX);
    expect(out.resume).toEqual({ kind: 'preset_state_file', path: '/srv/example/team-home/lead-session' });
  });

  test('a missing state file after a restore warns and launches fresh', () => {
    const out = resolveLaunch({ launcher: 'lead-preset' }, discovery, { ...CTX, existingPaths: [] });
    expect(out.resume).toEqual({ kind: 'none' });
    expect(codes(out.diagnostics)).toContain('W_RESUME_STATE_MISSING');
  });

  test('a missing pinned executable warns and falls back to the harness binary', () => {
    const out = resolveLaunch({ launcher: 'pinned-console' }, discovery, { ...CTX, existingPaths: [] });
    expect(out.executable).toBe('claude-code');
    expect(codes(out.diagnostics)).toContain('W_EXECUTABLE_MISSING');
  });

  test('without a host checker the pin and the state file are unverified, never probed', () => {
    const { existingPaths: _drop, ...staticCtx } = CTX;
    const out = resolveLaunch({ launcher: 'pinned-console' }, discovery, staticCtx);
    expect(out.ok).toBe(true);
    expect(out.executable).toBe('/opt/example/cli-builds/2.1.296/claude');
    expect(codes(out.diagnostics)).toContain('W_EXECUTABLE_UNVERIFIED');
    expect(codes(out.diagnostics)).not.toContain('W_EXECUTABLE_MISSING');

    const resumed = resolveLaunch({ launcher: 'lead-preset' }, discovery, staticCtx);
    expect(resumed.resume).toEqual({ kind: 'preset_state_file', path: '/srv/example/team-home/lead-session' });
    expect(codes(resumed.diagnostics)).toContain('W_RESUME_STATE_UNVERIFIED');
    expect(codes(resumed.diagnostics)).not.toContain('W_RESUME_STATE_MISSING');
  });
});

describe('fixed resume identity', () => {
  const identity = 'example conversation Ω; $(literal)';
  function definition(path: unknown, precedence?: string) {
    return {
      format: 1, name: 'fixed-example', kind: 'preset', harness: 'claude-code',
      writable_folders: [{ path: '{root}' }], args: ['--model', 'example-model'],
      resume: { mode: 'fixed', ...(path === undefined ? {} : { path }),
        ...(precedence === undefined ? {} : { precedence }) },
    };
  }
  function run(path: unknown, precedence?: string, sessionArg?: string) {
    return resolveLaunch({ launcher: 'fixed-example', args: ['--effort', 'high'] },
      discover([{ level: 'team', files: { 'fixed-example.yaml': definition(path, precedence) } }]),
      { ...CTX, ...(sessionArg === undefined ? {} : { sessionArg }) });
  }

  for (const precedence of [undefined, 'teamcli_wins', 'preset_wins']) {
    for (const caller of [undefined, 'example-caller']) {
      test(`fixed identity and argv: ${precedence ?? 'default'}, caller ${caller === undefined ? 'absent' : 'present'}`, () => {
        const out = run(identity, precedence, caller);
        expect(out.ok).toBe(true);
        expect(out.resume).toEqual(caller !== undefined && precedence !== 'preset_wins'
          ? { kind: 'teamcli', session: caller }
          : { kind: 'preset_fixed', session: identity });
        expect(out.argv).toEqual(['claude-code', '--model', 'example-model', '--effort', 'high']);
        expect(JSON.stringify(out.diagnostics)).not.toContain(identity);
      });
    }
  }

  for (const path of [undefined, '', '   ', 42, null, false, [], {}, 'example\u0000word',
    '{session}', '{root}', '{inbox}', 'example-{unknown-private-word}', 'example-{unfinished']) {
    test(`invalid fixed identity refuses before caller precedence: case ${JSON.stringify(path)?.length ?? 0}/${typeof path}`, () => {
      const checked = validateDefinition(definition(path, 'teamcli_wins'));
      expect(checked.def).toBeNull();
      expect(codes(checked.diagnostics)).toContain('E_RESUME_SHAPE');
      const out = run(path, 'teamcli_wins', 'example-caller');
      expect(out.ok).toBe(false);
      expect(out.resume).toEqual({ kind: 'none' });
      if (typeof path === 'string' && path.trim() !== '') {
        expect(JSON.stringify(checked.diagnostics)).not.toContain(path);
        expect(JSON.stringify(out.diagnostics)).not.toContain(path);
      }
    });
  }

  test('other literal resume modes retain their decisions without argv synthesis', () => {
    for (const [mode, expected] of [['none', { kind: 'none' }], ['inline', { kind: 'preset_inline' }]] as const) {
      const raw = { ...definition(undefined, 'preset_wins'), resume: { mode, precedence: 'preset_wins' } };
      const out = resolveLaunch({ launcher: 'fixed-example' },
        discover([{ level: 'team', files: { 'fixed-example.yaml': raw } }]), CTX);
      expect(out.ok).toBe(true);
      expect(out.resume).toEqual(expected);
      expect(out.argv).toEqual(['claude-code', '--model', 'example-model']);
    }
  });
});

describe('sandbox verdicts', () => {
  const { launchers } = discover([VALID]);
  const discovery = { launchers, diagnostics: [] as Diagnostic[] };

  test('supported harness with the worktree declared resolves clean', () => {
    const out = resolveLaunch({ launcher: 'claude-on-acme' }, discovery, CTX);
    expect(out.ok).toBe(true);
    expect(out.sandbox.mechanism).toContain('sandbox.filesystem.allowWrite');
    expect(out.sandbox.folders).toContain('/srv/example/repo');
  });

  test('the worktree missing from the writable set refuses the seat', () => {
    const bare: LauncherHome = {
      level: 'team',
      files: {
        'nowt.yaml': {
          format: 1, name: 'nowt', kind: 'preset', harness: 'claude-code',
          writable_folders: [{ path: '{team-home}' }],
        },
      },
    };
    const out = resolveLaunch({ launcher: 'nowt' }, discover([bare]), CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_SANDBOX_EXCLUDES_WORKTREE');
  });

  test('workspace-only harness: a folder outside the workspace refuses (antigravity)', () => {
    const agy: LauncherHome = {
      level: 'team',
      files: {
        'agy-seat.yaml': {
          format: 1, name: 'agy-seat', kind: 'preset', harness: 'antigravity',
          writable_folders: [{ path: '{root}' }, { path: '{team-home}' }],
        },
      },
    };
    const out = resolveLaunch({ launcher: 'agy-seat' }, discover([agy]), CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_SANDBOX_UNSUPPORTED');
  });

  test('unenforced harness: declared folders refuse, undeclared warns (jules)', () => {
    const declared = checkSandbox({ harness: 'jules', cwd: '/srv/example/repo', teamRoot: '/srv/example/repo', folders: ['/srv/example/repo'] });
    expect(codes(declared)).toEqual(['E_SANDBOX_UNSUPPORTED']);
    const undeclared = checkSandbox({ harness: 'jules', cwd: '/srv/example/repo', teamRoot: '/srv/example/repo', folders: [] });
    expect(codes(undeclared)).toEqual(['W_SANDBOX_UNENFORCED']);
  });

  test('a custom command declaring writable folders refuses (declared but unenforceable)', () => {
    const custom: LauncherHome = {
      level: 'team',
      files: {
        'c.yaml': {
          format: 1, name: 'c', kind: 'custom', argv: ['/bin/true'],
          writable_folders: [{ path: '{root}' }],
        },
      },
    };
    const out = resolveLaunch({ launcher: 'c' }, discover([custom]), CTX);
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_SANDBOX_UNSUPPORTED');
  });

  test('fail-closed setup: a failed profile write refuses the launch with the reason', () => {
    const out = resolveLaunch({ launcher: 'claude-on-acme' }, discovery, { ...CTX, sandboxSetup: 'failed', sandboxSetupReason: 'profile file not writable' });
    expect(out.ok).toBe(false);
    const refusal = out.diagnostics.find((d) => d.code === 'E_SANDBOX_SETUP');
    expect(refusal?.message).toContain('profile file not writable');
    expect(refusal?.message).toContain('never an unsandboxed fallback');
  });

  test('a linked repository\'s .git outside the writable set warns (inference-flagged)', () => {
    const out = resolveLaunch({ launcher: 'claude-on-acme' }, discovery, { ...CTX, gitDirs: ['/srv/example/repo-main/.git'] });
    expect(codes(out.diagnostics)).toContain('W_GIT_STORAGE_UNCOVERED');
    const covered = resolveLaunch({ launcher: 'claude-on-acme' }, discovery, { ...CTX, gitDirs: ['/srv/example/repo/.git'] });
    expect(codes(covered.diagnostics)).not.toContain('W_GIT_STORAGE_UNCOVERED');
  });

  test('unknown harnesses refuse rather than launching unvalidated', () => {
    const diagnostics = checkSandbox({ harness: 'never-heard-of-it', cwd: '/x', teamRoot: '/x', folders: ['/x'] });
    expect(codes(diagnostics)).toEqual(['E_SANDBOX_UNSUPPORTED']);
  });
});
