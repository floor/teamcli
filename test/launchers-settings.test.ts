// The unified settings merge (proposal §3 D1–D7): placement, recursive JSON-literal
// validation, layer precedence, recursive non-mutating merge, fixed and caller settings
// words, and the resolution output. Every fixture is synthetic; nothing reads a file, a
// credential store or the process environment.
import { describe, expect, test } from 'bun:test';
import { discover, resolveLaunch, type LauncherHome, type ResolveContext } from '../src/launchers/resolve.ts';
import { validateDefinition } from '../src/launchers/validate.ts';
import type { Diagnostic, JsonValue, SeatLaunchRef } from '../src/launchers/types.ts';

const CTX: ResolveContext = {
  teamRoot: '/srv/example/repo',
  teamHome: '/srv/example/team-home',
  cwd: '/srv/example/repo',
  parentEnv: {},
};

const PROVIDER = {
  name: 'acme',
  base_url: 'https://api.acme.invalid/anthropic',
  token: { store: 'example-store', item: 'acme-api-key' },
  models: { default: 'acme-large-1' },
};

function endpoint(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1, name, kind: 'endpoint', harness: 'claude-code',
    writable_folders: [{ path: '{root}' }],
    provider: { ...PROVIDER },
    ...extra,
  };
}

function preset(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1, name, kind: 'preset', harness: 'claude-code',
    writable_folders: [{ path: '{root}' }],
    ...extra,
  };
}

function home(...defs: Record<string, unknown>[]): LauncherHome {
  const files: Record<string, unknown> = {};
  for (const def of defs) files[`${String(def.name)}.yaml`] = def;
  return { level: 'team', files };
}

function resolve(files: LauncherHome, ref: SeatLaunchRef, ctx: Partial<ResolveContext> = {}) {
  return resolveLaunch(ref, discover([files]), { ...CTX, ...ctx });
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe('D1 — where harness_settings may sit', () => {
  test('endpoint and preset accept it; identity and custom refuse it as an unknown key', () => {
    expect(validateDefinition(endpoint('e', { harness_settings: { a: 1 } })).def).not.toBeNull();
    expect(validateDefinition(preset('p', { harness_settings: { a: 1 } })).def).not.toBeNull();
    const identity = { format: 1, name: 'i', kind: 'identity', harness_settings: { a: 1 } };
    expect(codes(validateDefinition(identity).diagnostics)).toContain('E_UNKNOWN_KEY');
    const custom = { format: 1, name: 'c', kind: 'custom', argv: ['/bin/true'], harness_settings: { a: 1 } };
    expect(codes(validateDefinition(custom).diagnostics)).toContain('E_UNKNOWN_KEY');
  });
});

describe('D2 — values are JSON literals, checked recursively', () => {
  test('nested objects and arrays pass', () => {
    const def = preset('p', { harness_settings: { a: { b: [1, 'x', null, true, { c: 2.5 }] } } });
    expect(validateDefinition(def).diagnostics).toEqual([]);
  });

  test('non-JSON values fail and the diagnostic names the key path', () => {
    const values: [string, unknown][] = [
      ['u', undefined], ['f', () => 1], ['n', Number.NaN], ['i', Number.POSITIVE_INFINITY], ['d', new Date(0)],
    ];
    for (const [key, value] of values) {
      const { def, diagnostics } = validateDefinition(preset('p', { harness_settings: { [key]: value } }));
      expect(def).toBeNull();
      const issue = diagnostics.find((d) => d.code === 'E_HARNESS_SETTINGS_VALUE');
      expect(issue?.field).toBe(`harness_settings.${key}`);
    }
    const nested = validateDefinition(preset('p', { harness_settings: { a: { b: [undefined] } } })).diagnostics;
    expect(nested.find((d) => d.code === 'E_HARNESS_SETTINGS_VALUE')?.field).toBe('harness_settings.a.b[0]');
  });

  test('credential-shaped strings are refused and never echoed', () => {
    const secret = 'sk-abcdefghijklmnop';
    const { def, diagnostics } = validateDefinition(preset('p', { harness_settings: { nested: { key: secret } } }));
    expect(def).toBeNull();
    expect(diagnostics.find((d) => d.code === 'E_SECRET_LITERAL')?.field).toBe('harness_settings.nested.key');
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  test('a cyclic explicit object is refused, not recursed', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { def, diagnostics } = validateDefinition(preset('p', { harness_settings: cyclic }));
    expect(def).toBeNull();
    expect(diagnostics.find((d) => d.code === 'E_HARNESS_SETTINGS_VALUE')?.field).toBe('harness_settings.self');
    expect(JSON.stringify(diagnostics)).toContain('cyclic');
    const fromDefaults = resolve(home(preset('p', {})), { launcher: 'p' }, {
      settingsDefaults: cyclic as unknown as Record<string, JsonValue>,
    });
    expect(fromDefaults.ok).toBe(false);
    expect(codes(fromDefaults.diagnostics)).toContain('E_HARNESS_SETTINGS_VALUE');
  });

  test('nesting deeper than the bound is refused, not recursed', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i += 1) deep = { level: deep };
    const { def, diagnostics } = validateDefinition(preset('p', { harness_settings: deep }));
    expect(def).toBeNull();
    expect(diagnostics.find((d) => d.code === 'E_HARNESS_SETTINGS_VALUE')?.message).toContain('deeper than');
  });

  test('__proto__, constructor and prototype are refused at any depth', () => {
    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const top = validateDefinition(preset('p', { harness_settings: unsafe }));
    expect(top.def).toBeNull();
    expect(top.diagnostics.find((d) => d.code === 'E_SETTINGS_KEY_UNSAFE')?.field).toBe('harness_settings.__proto__');
    const nested = validateDefinition(preset('p', { harness_settings: { ok: { constructor: { x: 1 } } } }));
    expect(nested.diagnostics.find((d) => d.code === 'E_SETTINGS_KEY_UNSAFE')?.field).toBe('harness_settings.ok.constructor');
    const deep = validateDefinition(preset('p', { harness_settings: { a: [{ prototype: 1 }] } }));
    expect(deep.diagnostics.find((d) => d.code === 'E_SETTINGS_KEY_UNSAFE')?.field).toBe('harness_settings.a[0].prototype');
  });
});

describe('D3 — layers fold lowest to highest', () => {
  test('defaults, endpoint, preset and caller settings compose with named overrides', () => {
    const files = home(
      endpoint('acme', {
        harness_settings: { sandbox: { network: 'allow' }, model: 'endpoint-model' },
        args: ['--settings', '{"endpoint":true,"sandbox":{"enabled":false}}'],
      }),
      preset('lead', {
        base: 'acme',
        harness_settings: { theme: 'light' },
        args: ['--settings', '{"preset":1}'],
        arg_policy: { settings: 'merge' },
      }),
    );
    const out = resolve(files, { launcher: 'lead', args: ['--settings', '{"caller":{"deep":true}}'] }, {
      settingsDefaults: { theme: 'dark', sandbox: { enabled: true, network: 'deny', extra: 'default' } },
    });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({
      theme: 'light',
      sandbox: { enabled: false, network: 'allow', extra: 'default' },
      model: 'endpoint-model',
      endpoint: true,
      preset: 1,
      caller: { deep: true },
    });
    expect(out.argv).toEqual(['claude-code']);
    const overrides = out.diagnostics.filter((d) => d.code === 'W_SETTINGS_OVERRIDE');
    expect(overrides.some((d) => /theme/.test(d.message) && /preset "lead"/.test(d.message))).toBe(true);
    expect(overrides.some((d) => /sandbox\.network/.test(d.message) && /endpoint "acme"/.test(d.message))).toBe(true);
    expect(overrides.some((d) => /sandbox\.enabled/.test(d.message) && /endpoint "acme"/.test(d.message))).toBe(true);
    // Diagnostics name the key path and the winning layer, never a value.
    expect(JSON.stringify(overrides)).not.toContain('dark');
    expect(JSON.stringify(overrides)).not.toContain('deny');
    expect(JSON.stringify(overrides)).not.toContain('allow');
  });
});

describe('D4 — merge is recursive, replaces wholesale, and never mutates', () => {
  test('arrays and null replace wholesale; nested objects merge key by key', () => {
    const files = home(preset('p', { harness_settings: { list: [3], value: null, nested: { keep: 1, win: 2 } } }));
    const out = resolve(files, { launcher: 'p' }, {
      settingsDefaults: { list: [1, 2], value: 'lower', nested: { keep: 9, drop: 4 } },
    });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({ list: [3], value: null, nested: { keep: 1, drop: 4, win: 2 } });
    // null is a value, not a deletion.
    expect(Object.hasOwn(out.settings, 'value')).toBe(true);
    expect(out.settings.value).toBeNull();
  });

  test('frozen inputs resolve, come back unchanged, and the output never aliases them', () => {
    const defaults = Object.freeze({
      nested: Object.freeze({ a: 1 }),
      list: Object.freeze([1, 2]),
    }) as unknown as Record<string, JsonValue>;
    const declaration = Object.freeze({ nested: Object.freeze({ b: 2 }) });
    const out = resolve(home(preset('p', { harness_settings: declaration })), { launcher: 'p' }, { settingsDefaults: defaults });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({ nested: { a: 1, b: 2 }, list: [1, 2] });
    expect(defaults).toEqual({ nested: { a: 1 }, list: [1, 2] });
    expect(declaration).toEqual({ nested: { b: 2 } });
    (out.settings.nested as { b: number }).b = 99;
    expect((defaults.nested as { a: number }).a).toBe(1);
  });
});

describe('D5 — fixed settings words fold or stay by shape', () => {
  test('inline JSON objects fold and leave argv; duplicates fold in document order', () => {
    const out = resolve(home(preset('p', { args: ['--settings', '{"a":1}', '--settings={"a":2,"b":3}'] })), { launcher: 'p' });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({ a: 2, b: 3 });
    expect(out.argv).toEqual(['claude-code']);
  });

  test('malformed and dangling inline words fail as E_SETTINGS_JSON', () => {
    const malformed = resolve(home(preset('p', { args: ['--settings', '{"a":'] })), { launcher: 'p' });
    expect(malformed.ok).toBe(false);
    expect(codes(malformed.diagnostics)).toContain('E_SETTINGS_JSON');
    const dangling = resolve(home(preset('p', { args: ['--settings'] })), { launcher: 'p' });
    expect(dangling.ok).toBe(false);
    expect(codes(dangling.diagnostics)).toContain('E_SETTINGS_JSON');
    const badInline = resolve(home(preset('p', { args: ['--settings', '{"b":[1,}'] })), { launcher: 'p' });
    expect(badInline.ok).toBe(false);
    expect(codes(badInline.diagnostics)).toContain('E_SETTINGS_JSON');
  });

  test('file-valued fixed words stay byte-for-byte and record the pending adapter', () => {
    const files = home(preset('p', {
      harness_settings: { a: 1 },
      args: ['--settings', '/opt/example/console-settings.json', '--verbose'],
    }));
    const out = resolve(files, { launcher: 'p' });
    expect(out.ok).toBe(true);
    expect(out.argv).toEqual(['claude-code', '--settings', '/opt/example/console-settings.json', '--verbose']);
    expect(codes(out.diagnostics)).toContain('W_SETTINGS_FILE_TARGET');
    const empty = resolve(home(preset('p', { args: ['--settings', '/opt/example/console-settings.json'] })), { launcher: 'p' });
    expect(codes(empty.diagnostics)).not.toContain('W_SETTINGS_FILE_TARGET');
  });

  test('a credential-shaped file word stays in argv but is never echoed in diagnostics', () => {
    const secretWord = 'sk-syntheticcredential123456';
    const files = home(preset('p', { harness_settings: { a: 1 }, args: ['--settings', secretWord] }));
    const out = resolve(files, { launcher: 'p' });
    expect(out.ok).toBe(true);
    expect(out.argv).toEqual(['claude-code', '--settings', secretWord]);
    const warning = out.diagnostics.find((d) => d.code === 'W_SETTINGS_FILE_TARGET');
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning)).not.toContain(secretWord);
    expect(JSON.stringify(out.diagnostics)).not.toContain(secretWord);
  });

  test('custom terminals keep their verbatim argv, settings words included', () => {
    const custom = { format: 1, name: 'legacy', kind: 'custom', argv: ['/bin/zsh', '/opt/x.sh', '--settings', '{"a":1}'] };
    const out = resolve(home(custom), { launcher: 'legacy' });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({});
    expect(out.argv).toEqual(['/bin/zsh', '/opt/x.sh', '--settings', '{"a":1}']);
  });
});

describe('D6 — caller settings words follow the policy', () => {
  test('pass_through keeps caller words and warns when the merged object is non-empty', () => {
    const withObject = resolve(home(preset('p', { harness_settings: { fixed: 1 } })), {
      launcher: 'p',
      args: ['--settings', '{"caller":2}'],
    });
    expect(withObject.ok).toBe(true);
    expect(withObject.argv).toEqual(['claude-code', '--settings', '{"caller":2}']);
    expect(withObject.settings).toEqual({ fixed: 1 });
    expect(codes(withObject.diagnostics)).toContain('W_SETTINGS_SPLIT');
    const noObject = resolve(home(preset('q', {})), { launcher: 'q', args: ['--settings', '{"caller":2}'] });
    expect(codes(noObject.diagnostics)).not.toContain('W_SETTINGS_SPLIT');
  });

  test('merge folds caller inline JSON as the top layer and removes the words', () => {
    const files = home(preset('p', { harness_settings: { a: 1, nested: { x: 1 } }, arg_policy: { settings: 'merge' } }));
    const out = resolve(files, { launcher: 'p', args: ['--settings={"nested":{"y":2},"a":3}'] });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({ a: 3, nested: { x: 1, y: 2 } });
    expect(out.argv).toEqual(['claude-code']);
  });

  test('merge refuses file values, malformed JSON, unsafe keys and credential strings', () => {
    const policy = { arg_policy: { settings: 'merge' } };
    const file = resolve(home(preset('p', policy)), { launcher: 'p', args: ['--settings', '/opt/example/x.json'] });
    expect(file.ok).toBe(false);
    expect(codes(file.diagnostics)).toContain('E_SETTINGS_FILE');
    const malformed = resolve(home(preset('p', policy)), { launcher: 'p', args: ['--settings', '{oops}'] });
    expect(malformed.ok).toBe(false);
    expect(codes(malformed.diagnostics)).toContain('E_SETTINGS_JSON');
    const unsafe = resolve(home(preset('p', policy)), { launcher: 'p', args: ['--settings', '{"__proto__":{"polluted":true}}'] });
    expect(unsafe.ok).toBe(false);
    expect(codes(unsafe.diagnostics)).toContain('E_SETTINGS_KEY_UNSAFE');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const secret = 'sk-abcdefghijklmnop';
    const credential = resolve(home(preset('p', policy)), { launcher: 'p', args: ['--settings', `{"apiKey":"${secret}"}`] });
    expect(credential.ok).toBe(false);
    expect(codes(credential.diagnostics)).toContain('E_SECRET_LITERAL');
    expect(JSON.stringify(credential.diagnostics)).not.toContain(secret);
  });

  test('override keeps caller words, excludes the fixed settings class, and still folds data', () => {
    const files = home(preset('p', {
      harness_settings: { data: 1 },
      args: ['--settings', '{"fixed":1}', '--settings', '/opt/example/x.json', '--model', 'fixed-model'],
      arg_policy: { settings: 'override' },
    }));
    const out = resolve(files, { launcher: 'p', args: ['--settings', '{"caller":2}'] });
    expect(out.ok).toBe(true);
    expect(out.argv).toEqual(['claude-code', '--model', 'fixed-model', '--settings', '{"caller":2}']);
    expect(out.settings).toEqual({ data: 1 });
    expect(codes(out.diagnostics)).toContain('W_SETTINGS_SPLIT');
    expect(codes(out.diagnostics)).not.toContain('W_SETTINGS_FILE_TARGET');
  });
});

describe('D7 — output shape and untouched arguments', () => {
  test('settings is always present; unrelated words keep order and bytes', () => {
    const weird = 'run $(rm -rf ~) && echo `whoami`; "quoted"';
    const out = resolve(home(preset('p', { harness_settings: { a: 1 } })), {
      launcher: 'p',
      args: ['--model', 'm', '--append-system-prompt', weird],
    });
    expect(out.ok).toBe(true);
    expect(out.settings).toEqual({ a: 1 });
    expect(out.argv).toEqual(['claude-code', '--model', 'm', '--append-system-prompt', weird]);
  });

  test('invalid defaults are refused, not merged', () => {
    const out = resolve(home(preset('p', {})), { launcher: 'p' }, {
      settingsDefaults: { bad: Number.NaN } as unknown as Record<string, JsonValue>,
    });
    expect(out.ok).toBe(false);
    expect(codes(out.diagnostics)).toContain('E_HARNESS_SETTINGS_VALUE');
  });
});
