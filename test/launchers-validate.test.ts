// Schema-validation coverage for declarative launchers: unknown keys at every depth,
// name rules, kind-specific fields, secret-reference shape, the no-secrets rule and
// argument boundaries. All fixtures are synthetic; nothing resolves a secret or touches
// a store, a CLI home or the process environment.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, toValue } from '../src/yaml.ts';
import { validateDefinition } from '../src/launchers/validate.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'launchers');

function loadYaml(dir: string, file: string): unknown {
  return toValue(parseYaml(readFileSync(join(FIXTURES, dir, file), 'utf8')));
}

function codes(raw: unknown, ctx: Parameters<typeof validateDefinition>[1] = {}): string[] {
  return validateDefinition(raw, ctx).diagnostics.map((d) => d.code);
}

const VALID_ENDPOINT = {
  format: 1,
  name: 'claude-on-acme',
  kind: 'endpoint',
  harness: 'claude-code',
  writable_folders: [{ path: '{root}' }],
  provider: {
    name: 'acme',
    base_url: 'https://api.acme.invalid/anthropic',
    token: { store: 'example-store', item: 'acme-api-key' },
    models: { default: 'acme-large-1' },
  },
};

describe('launcher files on disk parse and validate', () => {
  test('every fixture in home-valid validates with no error', () => {
    for (const file of readdirSync(join(FIXTURES, 'home-valid')).sort()) {
      const { def, diagnostics } = validateDefinition(loadYaml('home-valid', file), { file });
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(def).not.toBeNull();
    }
  });

  test('unknown-key fixture reports each unknown key by path', () => {
    const { def, diagnostics } = validateDefinition(loadYaml('home-invalid', 'unknown-key.yaml'), { file: 'unknown-key.yaml' });
    expect(def).toBeNull();
    const fields = diagnostics.filter((d) => d.code === 'E_UNKNOWN_KEY').map((d) => d.field);
    expect(fields).toContain('surprise');
    expect(fields).toContain('provider.region');
    expect(fields).toContain('provider.token.value');
  });

  test('secret-literal fixture fails the no-secrets rule on both shapes', () => {
    const diagnostics = validateDefinition(loadYaml('home-invalid', 'secret-literal.yaml')).diagnostics;
    const fields = diagnostics.filter((d) => d.code === 'E_SECRET_LITERAL').map((d) => d.field);
    expect(fields).toContain('env.EXAMPLE_API_KEY');
    expect(fields).toContain('env.EXAMPLE_PAIR');
  });
});

describe('format, name and kind', () => {
  test('a valid endpoint definition passes', () => {
    expect(codes(VALID_ENDPOINT)).toEqual([]);
  });

  test('format must be the integer 1', () => {
    expect(codes({ ...VALID_ENDPOINT, format: 2 })).toContain('E_FORMAT');
    expect(codes({ ...VALID_ENDPOINT, format: '1' })).toContain('E_FORMAT');
  });

  test('name syntax, length, reserved words and filename mismatch', () => {
    expect(codes({ ...VALID_ENDPOINT, name: 'Claude-On-Acme' })).toContain('E_NAME_SYNTAX');
    expect(codes({ ...VALID_ENDPOINT, name: '-lead' })).toContain('E_NAME_SYNTAX');
    expect(codes({ ...VALID_ENDPOINT, name: `a${'-b'.repeat(30)}` })).toContain('E_NAME_SYNTAX');
    expect(codes({ ...VALID_ENDPOINT, name: 'send' })).toContain('E_NAME_RESERVED');
    expect(codes(VALID_ENDPOINT, { file: 'other-name.yaml' })).toContain('E_NAME_FILE_MISMATCH');
    expect(codes(VALID_ENDPOINT, { file: 'claude-on-acme.yaml' })).toEqual([]);
  });

  test('an unknown kind refuses before kind keys are read', () => {
    expect(codes({ ...VALID_ENDPOINT, kind: 'endpoint-ish' })).toContain('E_KIND_UNKNOWN');
  });

  test('unknown keys error at every level of the document', () => {
    expect(codes({ ...VALID_ENDPOINT, wat: 1 })).toContain('E_UNKNOWN_KEY');
    expect(codes({ ...VALID_ENDPOINT, provider: { ...VALID_ENDPOINT.provider, region: 'x' } })).toContain('E_UNKNOWN_KEY');
    expect(codes({ ...VALID_ENDPOINT, arg_policy: { model: 'override', vibe: 'merge' } })).toContain('E_UNKNOWN_KEY');
    expect(
      codes({ format: 1, name: 'x', kind: 'identity', env: { A: { secret: { store: 's', item: 'i', hint: 'no' } } } }),
    ).toContain('E_UNKNOWN_KEY');
  });
});

describe('secret references and the no-secrets rule', () => {
  test('a reference is exactly { store, item }, both lowercase words', () => {
    const identity = (token: unknown) => ({
      format: 1, name: 'x', kind: 'endpoint', harness: 'claude-code',
      writable_folders: [{ path: '{root}' }],
      provider: { name: 'p', base_url: 'https://p.invalid', token, models: { default: 'm' } },
    });
    expect(codes(identity({ store: 'example-store', item: 'key' }))).toEqual([]);
    expect(codes(identity('example-store/key'))).toContain('E_SECRET_REF_SHAPE');
    expect(codes(identity({ store: 'Keychain', item: 'key' }))).toContain('E_SECRET_REF_SHAPE');
    expect(codes(identity({ store: 's' }))).toContain('E_SECRET_REF_SHAPE');
  });

  test('credential material fails wherever it sits; variable names stay exempt', () => {
    const identity = { format: 1, name: 'x', kind: 'identity', env: { API_TOKEN: 'literal-ok-name' } };
    expect(codes(identity)).toEqual([]);
    expect(codes({ format: 1, name: 'x', kind: 'identity', env: { A: 'ghp_abcdefghijklmnop' } })).toContain('E_SECRET_LITERAL');
    expect(codes({ ...VALID_ENDPOINT, summary: 'runs with sk-abcdefghijklmnop' })).toContain('E_SECRET_LITERAL');
  });

  test('shell substitution in a literal warns: it is never expanded', () => {
    expect(
      codes({ format: 1, name: 'x', kind: 'identity', env: { A: '$(security find-generic-password -s x -w)' } }),
    ).toContain('W_SHELL_SYNTAX');
  });
});

describe('kind-specific fields', () => {
  test('endpoint: provider facts are required and shaped', () => {
    const noProvider = { ...VALID_ENDPOINT } as Record<string, unknown>;
    delete noProvider.provider;
    expect(codes(noProvider)).toContain('E_PROVIDER_FIELD');
    expect(codes({ ...VALID_ENDPOINT, provider: { ...VALID_ENDPOINT.provider, base_url: 'http://insecure.invalid' } })).toContain('E_PROVIDER_FIELD');
    expect(codes({ ...VALID_ENDPOINT, provider: { ...VALID_ENDPOINT.provider, models: {} } })).toContain('E_PROVIDER_FIELD');
    expect(codes({ ...VALID_ENDPOINT, harness: '' })).toContain('E_HARNESS_UNKNOWN');
    expect(codes({ ...VALID_ENDPOINT, executable: 'relative/claude' })).toContain('E_EXECUTABLE_PATH');
    expect(codes({ ...VALID_ENDPOINT, executable: '/opt/example/claude' })).toEqual([]);
  });

  test('preset: executable is absolute, resume is shaped, cwd is a path', () => {
    const preset = {
      format: 1, name: 'lead', kind: 'preset', harness: 'claude-code',
      writable_folders: [{ path: '{root}' }],
      resume: { mode: 'state_file', path: '{team-home}/lead-session', precedence: 'teamcli_wins' },
    };
    expect(codes(preset)).toEqual([]);
    expect(codes({ ...preset, executable: 'bin/claude' })).toContain('E_EXECUTABLE_PATH');
    expect(codes({ ...preset, resume: { mode: 'sometimes', precedence: 'teamcli_wins' } })).toContain('E_RESUME_SHAPE');
    expect(codes({ ...preset, resume: { mode: 'state_file', precedence: 'teamcli_wins' } })).toContain('E_RESUME_SHAPE');
    expect(codes({ ...preset, resume: { mode: 'none', precedence: 'whoever' } })).toContain('E_RESUME_SHAPE');
    expect(codes({ ...preset, cwd: '' })).toContain('E_WRITABLE_PATH');
    expect(codes({ ...preset, harness_settings: 'not-a-map' })).toContain('E_HARNESS_SETTINGS');
    expect(codes({ ...preset, caller_args: 'refuse' })).toEqual([]);
    expect(codes({ ...preset, caller_args: 'maybe' })).toContain('E_CALLER_ARGS');
  });

  test('custom: verbatim argv, args_mode, cwd', () => {
    const custom = { format: 1, name: 'legacy', kind: 'custom', argv: ['/bin/zsh', '/opt/example/x.sh'], writable_folders: [{ path: '{root}' }] };
    expect(codes(custom)).toEqual([]);
    expect(codes({ ...custom, argv: [] })).toContain('E_CUSTOM_ARGV');
    expect(codes({ ...custom, argv: 'zsh /opt/example/x.sh' })).toContain('E_CUSTOM_ARGV');
    expect(codes({ ...custom, args_mode: 'maybe' })).toContain('E_CUSTOM_ARGV');
    expect(codes({ ...custom, cwd: '/srv/example/seat' })).toEqual([]);
    expect(codes({ ...custom, cwd: 42 })).toContain('E_WRITABLE_PATH');
  });

  test('env_policy shapes: inherit or scrub with variable-name keep list', () => {
    const base = { format: 1, name: 'x', kind: 'custom', argv: ['/bin/true'], writable_folders: [{ path: '{root}' }] };
    expect(codes({ ...base, env_policy: { mode: 'scrub', keep: ['PATH', 'HOME'] } })).toEqual([]);
    expect(codes({ ...base, env_policy: { mode: 'wipe' } })).toContain('E_ENV_POLICY');
    expect(codes({ ...base, env_policy: { mode: 'scrub', keep: ['1PATH'] } })).toContain('E_ENV_POLICY');
    expect(codes({ ...base, env_policy: { mode: 'inherit', extra: true } })).toContain('E_UNKNOWN_KEY');
  });
});

describe('argument boundaries', () => {
  test('unknown placeholders and empty words fail', () => {
    expect(codes({ ...VALID_ENDPOINT, args: ['--model', '{mdoel}'] })).toContain('E_PLACEHOLDER_UNKNOWN');
    expect(codes({ ...VALID_ENDPOINT, args: ['--model', ''] })).toContain('E_ARG_EMPTY');
    expect(codes({ ...VALID_ENDPOINT, writable_folders: [{ path: '{worktree}' }] })).toContain('E_PLACEHOLDER_UNKNOWN');
  });

  test('arg_policy: known classes and policies; merge only on mergeable classes', () => {
    expect(codes({ ...VALID_ENDPOINT, arg_policy: { model: 'override', settings: 'merge' } })).toEqual([]);
    expect(codes({ ...VALID_ENDPOINT, arg_policy: { model: 'merge' } })).toContain('E_ARG_POLICY');
    expect(codes({ ...VALID_ENDPOINT, arg_policy: { model: 'sometimes' } })).toContain('E_ARG_POLICY');
  });

  test('a writable folder is absolute or placeholder-anchored', () => {
    expect(codes({ ...VALID_ENDPOINT, writable_folders: [{ path: 'relative/folder' }] })).toContain('E_WRITABLE_PATH');
    expect(codes({ ...VALID_ENDPOINT, writable_folders: [{ path: '/abs/folder', rogue: 1 }] })).toContain('E_UNKNOWN_KEY');
  });

  test('metacharacter words are data, never re-parsed: they warn or pass as literals', () => {
    const withMetachars = { ...VALID_ENDPOINT, args: ['--append-system-prompt', 'run `this`; rm -rf ~ && echo $HOME'] };
    const result = validateDefinition(withMetachars);
    expect(result.def).not.toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toContain('W_SHELL_SYNTAX');
  });
});
