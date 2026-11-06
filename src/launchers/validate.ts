// Schema validation for one launcher definition: shape, kinds, references' *form* (never
// their resolution), argument boundaries and the no-secrets rule. Unknown keys are errors
// at every level of the document. Nothing here reads a credential store, the process
// environment or a CLI home; the input is the parsed file's value and nothing else.
import { readSettingsObject, stringHoldsSecret } from './settings.ts';
import {
  ARG_CLASSES,
  ARG_POLICIES,
  LAUNCHER_KINDS,
  MERGEABLE_CLASSES,
  RESUME_MODES,
  type ArgClass,
  type ArgPolicy,
  type Diagnostic,
  type LauncherDefinition,
  type SecretRef,
} from './types.ts';

export { looksLikeCredentialValue } from './settings.ts';

const NAME_WORD = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NAME_MAX = 48;
const STORE_WORD = /^[a-z][a-z0-9_-]*$/;
const PLACEHOLDER = /\{([a-z][a-z0-9-]*)\}/g;
const KNOWN_PLACEHOLDERS = new Set(['root', 'team-home', 'cwd', 'inbox', 'session']);
const SHELL_SYNTAX = /\$\(|`/;

/** Values that look like a credential materialize nowhere: the same rule family the config
 *  store applies (`looksLikeCredential` in src/config/sources.ts). The helpers live in
 *  settings.ts so the settings walker and this validator share one rule; names (env keys)
 *  are exempt, values and free strings are not. */

const COMMON_KEYS = ['format', 'name', 'kind', 'summary', 'writable_folders', 'source'] as const;
const KIND_KEYS: Record<LauncherDefinition['kind'], readonly string[]> = {
  identity: ['env'],
  endpoint: ['harness', 'prefix', 'provider', 'executable', 'args', 'arg_policy', 'env', 'env_policy', 'harness_settings'],
  preset: ['harness', 'base', 'executable', 'args', 'arg_policy', 'resume', 'env', 'env_policy', 'cwd', 'harness_settings', 'caller_args'],
  custom: ['argv', 'args_mode', 'env', 'env_policy', 'cwd'],
};
const PROVIDER_KEYS = ['name', 'base_url', 'token', 'models', 'context_window', 'effort', 'extra_env'] as const;
const SOURCE_KEYS = ['path', 'sha256', 'bytes', 'mtime', 'adopted_at'] as const;
const RESUME_KEYS = ['mode', 'path', 'precedence'] as const;
const ENV_POLICY_KEYS = ['mode', 'keep'] as const;
const WRITABLE_KEYS = ['path', 'note'] as const;

/** Names a launcher may never take: `team` subcommands and config keys, so a reference can
 *  never be misread as a command or a setting. */
export const RESERVED_LAUNCHER_NAMES: readonly string[] = [
  'up', 'down', 'send', 'reply', 'ack', 'config', 'check', 'status', 'seats', 'list',
  'launcher', 'launchers', 'launch', 'model', 'effort', 'nickname', 'delivery_order',
  'human', 'launchers_home',
];

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((one) => typeof one === 'string');
}

type Sink = Diagnostic[];
type Ctx = { file?: string; level?: string; launcher?: string };

function fail(sink: Sink, ctx: Ctx, code: string, field: string, message: string): void {
  sink.push({ code, severity: 'error', field, message, ...(ctx.file !== undefined ? { file: ctx.file } : {}), ...(ctx.level !== undefined ? { level: ctx.level } : {}), ...(ctx.launcher !== undefined ? { launcher: ctx.launcher } : {}) });
}

function warn(sink: Sink, ctx: Ctx, code: string, field: string, message: string): void {
  sink.push({ code, severity: 'warning', field, message, ...(ctx.file !== undefined ? { file: ctx.file } : {}), ...(ctx.level !== undefined ? { level: ctx.level } : {}), ...(ctx.launcher !== undefined ? { launcher: ctx.launcher } : {}) });
}

function unknownKeys(sink: Sink, ctx: Ctx, map: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(map)) {
    if (!known.includes(key)) fail(sink, ctx, 'E_UNKNOWN_KEY', where === '' ? key : `${where}.${key}`, `unknown key "${key}" in ${where === '' ? 'definition' : where}`);
  }
}

function checkPlaceholders(sink: Sink, ctx: Ctx, value: string, field: string): void {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const word = match[1] ?? '';
    if (!KNOWN_PLACEHOLDERS.has(word)) {
      fail(sink, ctx, 'E_PLACEHOLDER_UNKNOWN', field, `unknown placeholder {${word}} (known: ${[...KNOWN_PLACEHOLDERS].join(', ')})`);
    }
  }
}

function checkWord(sink: Sink, ctx: Ctx, value: string, field: string): void {
  if (value === '') {
    fail(sink, ctx, 'E_ARG_EMPTY', field, 'an argument word may not be empty');
    return;
  }
  checkPlaceholders(sink, ctx, value, field);
  if (SHELL_SYNTAX.test(value)) {
    warn(sink, ctx, 'W_SHELL_SYNTAX', field, 'the word carries $(...) or backticks; TeamCLI execs without a shell, so it stays literal — use a { secret: ... } reference instead');
  }
}

function checkSecretRef(sink: Sink, ctx: Ctx, value: unknown, field: string): SecretRef | null {
  if (!isMap(value)) {
    fail(sink, ctx, 'E_SECRET_REF_SHAPE', field, 'a secret reference is a map { store, item }');
    return null;
  }
  unknownKeys(sink, ctx, value, ['store', 'item'], field);
  const { store, item } = value as { store?: unknown; item?: unknown };
  let ok = true;
  if (typeof store !== 'string' || !STORE_WORD.test(store)) {
    fail(sink, ctx, 'E_SECRET_REF_SHAPE', `${field}.store`, 'store is a lowercase word naming where the secret lives; TeamCLI texts name no particular system');
    ok = false;
  }
  if (typeof item !== 'string' || !STORE_WORD.test(item)) {
    fail(sink, ctx, 'E_SECRET_REF_SHAPE', `${field}.item`, 'item is a lowercase word naming the entry in the store');
    ok = false;
  }
  return ok ? { store: store as string, item: item as string } : null;
}

function checkEnv(sink: Sink, ctx: Ctx, env: unknown, field: string): void {
  if (!isMap(env)) {
    fail(sink, ctx, 'E_ENV_SHAPE', field, 'env is a map of NAME to a literal or { secret: { store, item } }');
    return;
  }
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(sink, ctx, 'E_ENV_NAME', `${field}.${name}`, `env name "${name}" is not a shell-variable name`);
      continue;
    }
    if (typeof value === 'string') {
      if (stringHoldsSecret(value)) {
        fail(sink, ctx, 'E_SECRET_LITERAL', `${field}.${name}`, 'env values hold no secret material; use { secret: { store, item } }');
      }
      checkWord(sink, ctx, value, `${field}.${name}`);
    } else if (isMap(value)) {
      unknownKeys(sink, ctx, value, ['secret'], `${field}.${name}`);
      checkSecretRef(sink, ctx, value.secret, `${field}.${name}.secret`);
    } else {
      fail(sink, ctx, 'E_ENV_SHAPE', `${field}.${name}`, 'an env value is a literal string or { secret: { store, item } }');
    }
  }
}

function checkArgs(sink: Sink, ctx: Ctx, args: unknown, field: string): void {
  if (!isStringList(args)) {
    fail(sink, ctx, 'E_ARG_SHAPE', field, 'args is a list of literal words (an argv array, never a shell string)');
    return;
  }
  args.forEach((word, i) => checkWord(sink, ctx, word, `${field}[${i}]`));
}

function checkArgPolicy(sink: Sink, ctx: Ctx, policy: unknown, field: string): void {
  if (!isMap(policy)) {
    fail(sink, ctx, 'E_ARG_POLICY', field, 'arg_policy is a map of argument class to policy');
    return;
  }
  for (const [cls, value] of Object.entries(policy)) {
    if (!(ARG_CLASSES as readonly string[]).includes(cls)) {
      fail(sink, ctx, 'E_UNKNOWN_KEY', `${field}.${cls}`, `unknown argument class "${cls}" (known: ${ARG_CLASSES.join(', ')})`);
      continue;
    }
    if (!(ARG_POLICIES as readonly string[]).includes(value as string)) {
      fail(sink, ctx, 'E_ARG_POLICY', `${field}.${cls}`, `unknown policy "${String(value)}" (known: ${ARG_POLICIES.join(', ')})`);
      continue;
    }
    if (value === 'merge' && !(MERGEABLE_CLASSES as readonly string[]).includes(cls)) {
      fail(sink, ctx, 'E_ARG_POLICY', `${field}.${cls}`, `merge applies to ${MERGEABLE_CLASSES.join(', ')} only`);
    }
  }
}

function checkWritable(sink: Sink, ctx: Ctx, folders: unknown, field: string): void {
  if (!Array.isArray(folders)) {
    fail(sink, ctx, 'E_WRITABLE_PATH', field, 'writable_folders is a list of { path, note? }');
    return;
  }
  folders.forEach((entry, i) => {
    const at = `${field}[${i}]`;
    if (!isMap(entry)) {
      fail(sink, ctx, 'E_WRITABLE_PATH', at, 'a writable folder is a map { path, note? }');
      return;
    }
    unknownKeys(sink, ctx, entry, WRITABLE_KEYS, at);
    const path = entry.path;
    if (typeof path !== 'string' || path === '') {
      fail(sink, ctx, 'E_WRITABLE_PATH', `${at}.path`, 'a writable folder needs a path');
      return;
    }
    checkPlaceholders(sink, ctx, path, `${at}.path`);
    if (!path.startsWith('/') && !path.startsWith('{')) {
      fail(sink, ctx, 'E_WRITABLE_PATH', `${at}.path`, 'a writable folder is an absolute path or starts from a placeholder ({root}, {team-home}, {cwd})');
    }
  });
}

/** D2: harness settings are JSON literals, checked recursively. Every diagnostic names the
 *  key path, never the value; credential-shaped strings and unsafe keys are refused. */
function checkHarnessSettings(sink: Sink, ctx: Ctx, value: unknown, field: string): void {
  const read = readSettingsObject(value, field);
  for (const issue of read.issues) {
    fail(sink, ctx, issue.code, issue.path, issue.message);
  }
}

function checkEnvPolicy(sink: Sink, ctx: Ctx, policy: unknown, field: string): void {
  if (!isMap(policy)) {
    fail(sink, ctx, 'E_ENV_POLICY', field, 'env_policy is a map { mode, keep? }');
    return;
  }
  unknownKeys(sink, ctx, policy, ENV_POLICY_KEYS, field);
  if (policy.mode !== 'inherit' && policy.mode !== 'scrub') {
    fail(sink, ctx, 'E_ENV_POLICY', `${field}.mode`, 'mode is inherit or scrub');
  }
  if (policy.keep !== undefined && !isStringList(policy.keep)) {
    fail(sink, ctx, 'E_ENV_POLICY', `${field}.keep`, 'keep is a list of variable names');
  }
  if (policy.mode === 'scrub' && Array.isArray(policy.keep)) {
    for (const name of policy.keep as string[]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        fail(sink, ctx, 'E_ENV_POLICY', `${field}.keep`, `"${name}" is not a variable name`);
      }
    }
  }
}

/**
 * Validates one parsed launcher file. Returns the definition when no error-severity
 * diagnostic was produced (warnings do not block), plus every diagnostic in field order.
 */
export function validateDefinition(
  raw: unknown,
  ctx: { file?: string; level?: string; reservedNames?: readonly string[] } = {},
): { def: LauncherDefinition | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const base: Ctx = { ...(ctx.file !== undefined ? { file: ctx.file } : {}), ...(ctx.level !== undefined ? { level: ctx.level } : {}) };
  if (!isMap(raw)) {
    fail(diagnostics, base, 'E_FORMAT', '', 'a launcher file holds one map');
    return { def: null, diagnostics };
  }
  const withName: Ctx = typeof raw.name === 'string' ? { ...base, launcher: raw.name } : base;
  const ctxN = withName;

  if (raw.format !== 1) fail(diagnostics, ctxN, 'E_FORMAT', 'format', 'format must be the integer 1');
  if (typeof raw.name !== 'string' || !NAME_WORD.test(raw.name) || raw.name.length > NAME_MAX) {
    fail(diagnostics, ctxN, 'E_NAME_SYNTAX', 'name', `name is ^[a-z][a-z0-9]*(-[a-z0-9]+)*$, at most ${NAME_MAX} characters`);
  } else {
    const reserved = ctx.reservedNames ?? RESERVED_LAUNCHER_NAMES;
    if (reserved.includes(raw.name)) fail(diagnostics, ctxN, 'E_NAME_RESERVED', 'name', `"${raw.name}" is a team command or config key`);
    if (ctx.file !== undefined) {
      const stem = ctx.file.replace(/\.(yaml|yml|json)$/, '');
      if (stem !== raw.name) fail(diagnostics, ctxN, 'E_NAME_FILE_MISMATCH', 'name', `the file "${ctx.file}" declares name "${raw.name}"`);
    }
  }
  if (typeof raw.kind !== 'string' || !(LAUNCHER_KINDS as readonly string[]).includes(raw.kind)) {
    fail(diagnostics, ctxN, 'E_KIND_UNKNOWN', 'kind', `kind is one of: ${LAUNCHER_KINDS.join(', ')}`);
    return { def: null, diagnostics };
  }
  const kind = raw.kind as LauncherDefinition['kind'];
  unknownKeys(diagnostics, ctxN, raw, [...COMMON_KEYS, ...KIND_KEYS[kind]], '');

  if (raw.summary !== undefined && typeof raw.summary !== 'string') {
    fail(diagnostics, ctxN, 'E_FORMAT', 'summary', 'summary is one line of text');
  }
  if (raw.summary !== undefined && typeof raw.summary === 'string' && stringHoldsSecret(raw.summary)) {
    fail(diagnostics, ctxN, 'E_SECRET_LITERAL', 'summary', 'text fields hold no secret material');
  }
  if (raw.writable_folders !== undefined) checkWritable(diagnostics, ctxN, raw.writable_folders, 'writable_folders');
  if (raw.source !== undefined) {
    if (!isMap(raw.source)) {
      fail(diagnostics, ctxN, 'E_SOURCE_SHAPE', 'source', 'source is the adoption pin map');
    } else {
      unknownKeys(diagnostics, ctxN, raw.source, SOURCE_KEYS, 'source');
      const pin = raw.source as { path?: unknown; sha256?: unknown };
      if (typeof pin.path !== 'string' || pin.path === '') fail(diagnostics, ctxN, 'E_SOURCE_SHAPE', 'source.path', 'an adoption pin names the script path');
      if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
        fail(diagnostics, ctxN, 'E_SOURCE_SHAPE', 'source.sha256', 'an adoption pin carries the script\'s lowercase sha256');
      }
    }
  }
  if (raw.env !== undefined) checkEnv(diagnostics, ctxN, raw.env, 'env');
  if (raw.env_policy !== undefined) checkEnvPolicy(diagnostics, ctxN, raw.env_policy, 'env_policy');
  // D1: harness_settings belongs to endpoint and preset only; identity and custom carrying
  // it are refused as E_UNKNOWN_KEY by the kind key lists above.
  if ((kind === 'endpoint' || kind === 'preset') && raw.harness_settings !== undefined) {
    checkHarnessSettings(diagnostics, ctxN, raw.harness_settings, 'harness_settings');
  }

  switch (kind) {
    case 'identity':
      break;
    case 'endpoint': {
      if (typeof raw.harness !== 'string' || raw.harness === '') {
        fail(diagnostics, ctxN, 'E_HARNESS_UNKNOWN', 'harness', 'an endpoint names its harness (a CLI profile name)');
      }
      if (raw.prefix !== undefined && (typeof raw.prefix !== 'string' || !NAME_WORD.test(raw.prefix))) {
        fail(diagnostics, ctxN, 'E_REF_SHAPE', 'prefix', 'prefix is one launcher name');
      }
      if (raw.executable !== undefined) {
        if (typeof raw.executable !== 'string' || !raw.executable.startsWith('/')) {
          fail(diagnostics, ctxN, 'E_EXECUTABLE_PATH', 'executable', 'a pinned executable is an absolute path');
        } else {
          checkPlaceholders(diagnostics, ctxN, raw.executable, 'executable');
        }
      }
      if (!isMap(raw.provider)) {
        fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', 'provider', 'an endpoint declares its provider block');
      } else {
        unknownKeys(diagnostics, ctxN, raw.provider, PROVIDER_KEYS, 'provider');
        const provider = raw.provider as { name?: unknown; base_url?: unknown; token?: unknown; models?: unknown; context_window?: unknown; extra_env?: unknown };
        if (typeof provider.name !== 'string' || provider.name === '') fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', 'provider.name', 'the provider needs a name');
        if (typeof provider.base_url !== 'string' || !/^https:\/\//.test(provider.base_url)) {
          fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', 'provider.base_url', 'the provider base_url is an https URL');
        }
        if (provider.token === undefined) {
          fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', 'provider.token', 'the provider key is a { store, item } reference');
        } else {
          checkSecretRef(diagnostics, ctxN, provider.token, 'provider.token');
        }
        if (!isMap(provider.models) || typeof provider.models.default !== 'string' || provider.models.default === '') {
          fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', 'provider.models', 'models is a map with a default model id');
        } else {
          for (const [alias, id] of Object.entries(provider.models)) {
            if (typeof id !== 'string' || id === '') fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', `provider.models.${alias}`, 'a model id is a non-empty string');
          }
        }
        if (provider.context_window !== undefined && (typeof provider.context_window !== 'number' || !Number.isInteger(provider.context_window) || provider.context_window < 1)) {
          fail(diagnostics, ctxN, 'E_PROVIDER_FIELD', 'provider.context_window', 'context_window is a positive integer');
        }
        if (provider.extra_env !== undefined) checkEnv(diagnostics, ctxN, provider.extra_env, 'provider.extra_env');
      }
      if (raw.args !== undefined) checkArgs(diagnostics, ctxN, raw.args, 'args');
      if (raw.arg_policy !== undefined) checkArgPolicy(diagnostics, ctxN, raw.arg_policy, 'arg_policy');
      break;
    }
    case 'preset': {
      if (typeof raw.harness !== 'string' || raw.harness === '') {
        fail(diagnostics, ctxN, 'E_HARNESS_UNKNOWN', 'harness', 'a preset names its harness (a CLI profile name)');
      }
      if (raw.base !== undefined && (typeof raw.base !== 'string' || !NAME_WORD.test(raw.base))) {
        fail(diagnostics, ctxN, 'E_REF_SHAPE', 'base', 'base is one launcher name');
      }
      if (raw.executable !== undefined) {
        if (typeof raw.executable !== 'string' || !raw.executable.startsWith('/')) {
          fail(diagnostics, ctxN, 'E_EXECUTABLE_PATH', 'executable', 'a pinned executable is an absolute path');
        } else {
          checkPlaceholders(diagnostics, ctxN, raw.executable, 'executable');
        }
      }
      if (raw.args !== undefined) checkArgs(diagnostics, ctxN, raw.args, 'args');
      if (raw.arg_policy !== undefined) checkArgPolicy(diagnostics, ctxN, raw.arg_policy, 'arg_policy');
      if (raw.resume !== undefined) {
        if (!isMap(raw.resume)) {
          fail(diagnostics, ctxN, 'E_RESUME_SHAPE', 'resume', 'resume is a map { mode, path?, precedence }');
        } else {
          unknownKeys(diagnostics, ctxN, raw.resume, RESUME_KEYS, 'resume');
          const resume = raw.resume as { mode?: unknown; path?: unknown; precedence?: unknown };
          if (typeof resume.mode !== 'string' || !(RESUME_MODES as readonly string[]).includes(resume.mode)) {
            fail(diagnostics, ctxN, 'E_RESUME_SHAPE', 'resume.mode', `mode is one of: ${RESUME_MODES.join(', ')}`);
          }
          if (resume.mode === 'state_file' && (typeof resume.path !== 'string' || resume.path === '')) {
            fail(diagnostics, ctxN, 'E_RESUME_SHAPE', 'resume.path', 'state_file needs the path of the resume state');
          }
          if (resume.path !== undefined && typeof resume.path === 'string') checkPlaceholders(diagnostics, ctxN, resume.path, 'resume.path');
          if (resume.precedence !== undefined && resume.precedence !== 'teamcli_wins' && resume.precedence !== 'preset_wins') {
            fail(diagnostics, ctxN, 'E_RESUME_SHAPE', 'resume.precedence', 'precedence is teamcli_wins or preset_wins');
          }
        }
      }
      if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || raw.cwd === '')) {
        fail(diagnostics, ctxN, 'E_WRITABLE_PATH', 'cwd', 'cwd is a path or placeholder');
      }
      if (raw.caller_args !== undefined && raw.caller_args !== 'append' && raw.caller_args !== 'refuse') {
        fail(diagnostics, ctxN, 'E_CALLER_ARGS', 'caller_args', 'caller_args is append or refuse');
      }
      break;
    }
    case 'custom': {
      if (!isStringList(raw.argv) || raw.argv.length === 0) {
        fail(diagnostics, ctxN, 'E_CUSTOM_ARGV', 'argv', 'a custom launcher is its verbatim argv, first word the executable');
      } else {
        raw.argv.forEach((word, i) => checkWord(diagnostics, ctxN, word, `argv[${i}]`));
      }
      if (raw.args_mode !== undefined && raw.args_mode !== 'append' && raw.args_mode !== 'refuse') {
        fail(diagnostics, ctxN, 'E_CUSTOM_ARGV', 'args_mode', 'args_mode is append or refuse');
      }
      if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || raw.cwd === '')) {
        fail(diagnostics, ctxN, 'E_WRITABLE_PATH', 'cwd', 'cwd is a path or placeholder');
      }
      break;
    }
  }

  const errors = diagnostics.some((d) => d.severity === 'error');
  return { def: errors ? null : (raw as unknown as LauncherDefinition), diagnostics };
}
