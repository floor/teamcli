// Independent scenes for the launcher composition: settings fold from the
// lowest layer to the caller, a fixed resume holds or yields by precedence,
// a blank caller session is refused before a resume is built, and argv is the
// executable, the endpoint's fixed words, the preset's fixed words, then the caller.
// Synthetic fixtures only: nothing executes a launch or reads the environment.
import { expect, test } from 'bun:test';
import { discover, resolveLaunch, type LauncherHome, type ResolveContext } from '../src/launchers/resolve.ts';
import { validateDefinition } from '../src/launchers/validate.ts';
import type { Diagnostic, JsonValue } from '../src/launchers/types.ts';

const CTX: ResolveContext = {
  teamRoot: '/srv/example/repo',
  teamHome: '/srv/example/team-home',
  cwd: '/srv/example/repo',
  parentEnv: {},
};

const PROVIDER = {
  name: 'acme',
  base_url: 'https://api.acme.invalid/anthropic',
  token: { store: 'example-store', item: 'example-item' },
  models: { default: 'acme-large-1' },
};

function home(defs: Record<string, unknown>[]): LauncherHome {
  const files: Record<string, unknown> = {};
  for (const def of defs) files[`${String(def.name)}.yaml`] = def;
  return { level: 'team', files };
}

function resolve(defs: Record<string, unknown>[], args: string[] = [], ctx: Partial<ResolveContext> = {}) {
  const launcher = String(defs[defs.length - 1]?.name);
  return resolveLaunch({ launcher, ...(args.length > 0 ? { args } : {}) }, discover([home(defs)]), { ...CTX, ...ctx });
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

function endpoint(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1, name: 'acme-endpoint', kind: 'endpoint', harness: 'claude-code',
    writable_folders: [{ path: '{root}' }],
    provider: { ...PROVIDER },
    ...extra,
  };
}

function preset(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1, name: 'seat-preset', kind: 'preset', harness: 'claude-code',
    base: 'acme-endpoint',
    writable_folders: [{ path: '{root}' }],
    ...extra,
  };
}

test('settings merge folds defaults, then the endpoint, the preset and the caller', () => {
  const defaults = {
    shared: { from: 'defaults', keep: true },
    list: ['default'],
    onlyDefault: 1,
  };
  const out = resolve(
    [
      endpoint({
        harness_settings: { shared: { from: 'endpoint' }, onlyEndpoint: true },
        args: ['--settings', '{"endpointFlag":true,"shared":{"flag":"endpoint"}}'],
      }),
      preset({
        harness_settings: { shared: { from: 'preset' }, onlyPreset: 1 },
        arg_policy: { settings: 'merge' },
      }),
    ],
    ['--settings', '{"shared":{"from":"caller"},"onlyCaller":true}'],
    { settingsDefaults: defaults as unknown as Record<string, JsonValue> },
  );
  expect(out.ok).toBe(true);
  expect(out.settings).toEqual({
    shared: { from: 'caller', keep: true, flag: 'endpoint' },
    list: ['default'],
    onlyDefault: 1,
    onlyEndpoint: true,
    endpointFlag: true,
    onlyPreset: 1,
    onlyCaller: true,
  });
  expect(out.argv).toEqual(['claude-code']);
  const overrides = out.diagnostics.filter((d) => d.code === 'W_SETTINGS_OVERRIDE');
  expect(overrides.some((d) => d.message.includes('shared.from') && d.message.includes('preset "seat-preset"'))).toBe(true);
  expect(overrides.some((d) => d.message.includes('shared.from') && d.message.includes('caller settings'))).toBe(true);
  expect(JSON.stringify(overrides)).not.toContain('onlyDefault');
  expect(JSON.stringify(overrides)).not.toContain('onlyCaller');
  expect(JSON.stringify(overrides)).not.toContain('endpointFlag');
  expect(defaults).toEqual({ shared: { from: 'defaults', keep: true }, list: ['default'], onlyDefault: 1 });
});

test('a fixed resume holds its literal when the preset wins and yields when TeamCLI passes a session', () => {
  const fixed = (precedence: string) => preset({
    resume: { mode: 'fixed', path: 'example-session', precedence },
  });
  const held = resolve([endpoint(), fixed('preset_wins')], [], { sessionArg: 'seat-session', existingPaths: [] });
  expect(held.ok).toBe(true);
  expect(held.resume).toEqual({ kind: 'preset_fixed', session: 'example-session' });
  expect(codes(held.diagnostics)).not.toContain('W_RESUME_STATE_MISSING');
  expect(JSON.stringify(held.diagnostics)).not.toContain('example-session');

  const yielded = resolve([endpoint(), fixed('teamcli_wins')], [], { sessionArg: 'seat-session', existingPaths: [] });
  expect(yielded.ok).toBe(true);
  expect(yielded.resume).toEqual({ kind: 'teamcli', session: 'seat-session' });

  const alone = resolve([endpoint(), fixed('teamcli_wins')], [], { existingPaths: [] });
  expect(alone.ok).toBe(true);
  expect(alone.resume).toEqual({ kind: 'preset_fixed', session: 'example-session' });
  expect(codes(alone.diagnostics)).not.toContain('W_RESUME_STATE_MISSING');
});

test('an empty session is refused as a resume and as an argument word', () => {
  const emptyPath = validateDefinition(preset({
    resume: { mode: 'state_file', path: '', precedence: 'teamcli_wins' },
  }));
  expect(emptyPath.def).toBeNull();
  expect(codes(emptyPath.diagnostics)).toContain('E_RESUME_SHAPE');

  const emptyWord = validateDefinition(preset({ args: ['--resume', ''] }));
  expect(emptyWord.def).toBeNull();
  expect(codes(emptyWord.diagnostics)).toContain('E_ARG_EMPTY');

  const blank = resolve(
    [endpoint(), preset({ resume: { mode: 'fixed', path: '   ', precedence: 'teamcli_wins' } })],
    [],
    { sessionArg: 'seat-session' },
  );
  expect(blank.ok).toBe(false);
  expect(blank.resume).toEqual({ kind: 'none' });
  expect(codes(blank.diagnostics)).toContain('E_RESUME_SHAPE');

  for (const sessionArg of ['', '   ', '\t']) {
    const out = resolve(
      [endpoint(), preset({
        args: ['--resume', '{session}'],
        resume: { mode: 'fixed', path: 'example-session', precedence: 'teamcli_wins' },
      })],
      [],
      { sessionArg },
    );
    expect(out.ok).toBe(false);
    expect(out.resume).toEqual({ kind: 'none' });
    expect(out.argv).toEqual([]);
    expect(codes(out.diagnostics)).toContain('E_RESUME_SESSION');
    expect(out.diagnostics.some((d) => d.message === 'a supplied caller session is blank; omit it, or pass a session that contains a non-space character')).toBe(true);
  }
});

test('argument order is the executable, the endpoint fixed words, the preset fixed words, then the caller', () => {
  const out = resolve(
    [
      endpoint({ args: ['--endpoint-flag', 'e-value', '--settings', '{"from":"endpoint"}', '--between', 'kept'] }),
      preset({ args: ['--preset-flag', 'p-value', '--model', 'fixed-model', '--after', 'preset'] }),
    ],
    ['--caller-flag', 'c-value'],
  );
  expect(out.ok).toBe(true);
  expect(out.argv).toEqual([
    'claude-code',
    '--endpoint-flag', 'e-value', '--between', 'kept',
    '--preset-flag', 'p-value', '--model', 'fixed-model', '--after', 'preset',
    '--caller-flag', 'c-value',
  ]);
  expect(out.settings).toEqual({ from: 'endpoint' });

  const replaced = resolve(
    [endpoint(), preset({
      args: ['--before', '1', '--model', 'fixed-model', '--after', '2'],
      arg_policy: { model: 'override' },
    })],
    ['--model', 'caller-model'],
  );
  expect(replaced.ok).toBe(true);
  expect(replaced.argv).toEqual(['claude-code', '--before', '1', '--after', '2', '--model', 'caller-model']);
});
