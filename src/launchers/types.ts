// Declarative launcher types: the shapes a launcher file may hold, the diagnostics the
// validator emits, and the resolved launch the resolver returns. Validation is syntax and
// reference shape only: a secret is a {store, item} reference and is never resolved,
// probed or printed here. See the launchers design note (private lab brief).

export type LauncherKind = 'identity' | 'endpoint' | 'preset' | 'custom';

export const LAUNCHER_KINDS: readonly LauncherKind[] = ['identity', 'endpoint', 'preset', 'custom'];

/** A JSON literal: the only shape a harness settings value may take. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A secret by reference: where it lives, never its value. Exactly these two keys. */
export type SecretRef = { store: string; item: string };

/** An environment entry's value: a literal, or a secret reference. */
export type EnvValue = string | { secret: SecretRef };

/** The argument classes a policy speaks about. */
export type ArgClass = 'model' | 'settings' | 'resume' | 'mcp' | 'effort' | 'other';

export const ARG_CLASSES: readonly ArgClass[] = ['model', 'settings', 'resume', 'mcp', 'effort', 'other'];

/** What caller argv of a class may do against the launcher's own fixed args. */
export type ArgPolicy = 'pass_through' | 'override' | 'merge' | 'strip' | 'refuse';

export const ARG_POLICIES: readonly ArgPolicy[] = ['pass_through', 'override', 'merge', 'strip', 'refuse'];

/** The classes `merge` may combine; anything else is E_ARG_POLICY. */
export const MERGEABLE_CLASSES: readonly ArgClass[] = ['settings'];

export type ResumeMode = 'none' | 'inline' | 'state_file' | 'fixed';

export const RESUME_MODES: readonly ResumeMode[] = ['none', 'inline', 'state_file', 'fixed'];

export type ResumePrecedence = 'teamcli_wins' | 'preset_wins';

/** A folder the seat may write, with an optional note. `{root}`, `{team-home}` and `{cwd}`
 *  are the placeholders the resolver expands. */
export type WritableFolder = { path: string; note?: string };

/** The adoption pin a migrated launcher carries: the script it was adopted from. */
export type SourcePin = {
  path: string;
  sha256: string;
  bytes?: number;
  mtime?: string;
  adopted_at?: string;
};

export type ProviderBlock = {
  name: string;
  base_url: string;
  token: SecretRef;
  models: { default: string; [alias: string]: string };
  context_window?: number;
  effort?: string;
  extra_env?: Record<string, string>;
};

export type ResumeBlock = {
  mode: ResumeMode;
  /** state_file: where the preset keeps its resume word. fixed: the word itself. */
  path?: string;
  precedence: ResumePrecedence;
};

export type LauncherDefinition = {
  format: 1;
  name: string;
  kind: LauncherKind;
  summary?: string;
  writable_folders?: WritableFolder[];
  source?: SourcePin;
  /** identity, endpoint (extra), preset (extra): environment literals or secret refs. */
  env?: Record<string, EnvValue>;
  /** terminal kinds (endpoint, preset, custom): the launch environment contract. */
  env_policy?: EnvPolicy;
  /** endpoint, preset: a CLI profile name. */
  harness?: string;
  /** endpoint: exactly one identity launcher name. */
  prefix?: string;
  /** endpoint: provider facts; the harness profile owns how they become env words. */
  provider?: ProviderBlock;
  /** endpoint, preset: fixed harness args. */
  args?: string[];
  /** endpoint, preset: per-class caller-arg policy. */
  arg_policy?: Partial<Record<ArgClass, ArgPolicy>>;
  /** preset: an identity or endpoint launcher name. */
  base?: string;
  /** preset, endpoint: an absolute path overriding the harness's binary (a pinned build, or
   *  a harness that lives outside PATH). */
  executable?: string;
  /** preset: resume behavior. */
  resume?: ResumeBlock;
  /** preset, custom: working directory override; default the seat's cwd. */
  cwd?: string;
  /** endpoint, preset: harness settings keys merged into the harness's one settings object. */
  harness_settings?: Record<string, JsonValue>;
  /** preset: whether seat args may follow the fixed args at all. `refuse` models a preset
   *  whose original wrapper forwarded nothing; default `append`. */
  caller_args?: 'append' | 'refuse';
  /** custom: the verbatim argv, first word the executable. */
  argv?: string[];
  /** custom: whether seat args may follow. */
  args_mode?: 'append' | 'refuse';
};

export type DiagnosticSeverity = 'error' | 'warning';

export type Diagnostic = {
  code: string;
  severity: DiagnosticSeverity;
  /** The discovery level the definition came from, when known. */
  level?: string;
  /** The file the definition was read from, when known. */
  file?: string;
  /** The launcher the diagnostic is about, when known. */
  launcher?: string;
  /** The field path inside the definition, when one is at fault. */
  field?: string;
  message: string;
};

/** The launch environment contract: inherit the parent environment, or scrub it to a keep
 *  list plus the launcher's own env (the one-command-rule seat and the whitelist preset use
 *  `scrub`). The resolver takes the parent environment as explicit input; it never reads
 *  process.env itself. */
export type EnvPolicy = { mode: 'inherit' | 'scrub'; keep?: string[] };

/** One resolved environment entry: a literal value or an unresolved secret reference. */
export type ResolvedEnv = { name: string; value: string } | { name: string; secret: SecretRef };

/** The effective resume decision for one launch. */
export type ResolvedResume =
  | { kind: 'teamcli'; session: string }
  | { kind: 'preset_state_file'; path: string }
  | { kind: 'preset_fixed' }
  | { kind: 'preset_inline' }
  | { kind: 'none' };

/** The resolved launch: argv as an array (never a shell string), env with secrets still
 *  references, and every diagnostic the resolution produced. */
export type ResolvedLaunch = {
  ok: boolean;
  harness: string;
  executable: string;
  argv: string[];
  env: ResolvedEnv[];
  cwd: string;
  /** The merged harness settings object (one per launch): data for the future settings-file
   *  adapter, never an argv word written by this pure core. Empty when nothing declares any. */
  settings: Record<string, JsonValue>;
  resume: ResolvedResume;
  sandbox: { harness: string; mechanism: string; folders: string[] };
  chain: string[];
  diagnostics: Diagnostic[];
};

/** The seat's launch reference: a launcher name and the caller args the record carries. */
export type SeatLaunchRef = { launcher: string; args?: string[] };
