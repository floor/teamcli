// Discovery and resolution for declarative launchers. Discovery walks the launcher homes
// (seat > team > project > entity > machine), nearest level winning per name; resolution
// turns a seat's { launcher, args } reference into an argv array, an environment with
// secrets still by reference, a resume decision and a sandbox verdict. Pure: the team
// context (paths, parent environment, existing files) arrives as explicit input. Nothing
// here executes a launch, reads a credential store or inspects process.env.
import { checkSandbox, SANDBOX_CAPABILITIES } from './sandbox.ts';
import { mergeSettingsObject, readSettingsObject, settingsSpans, type SettingsIssue, type SettingsSpan } from './settings.ts';
import { isFixedResumeSession, validateDefinition } from './validate.ts';
import type {
  ArgClass,
  ArgPolicy,
  Diagnostic,
  EnvValue,
  JsonValue,
  LauncherDefinition,
  ResolvedEnv,
  ResolvedLaunch,
  ResolvedResume,
  SeatLaunchRef,
  SecretRef,
} from './types.ts';

export type DiscoveryLevel = 'seat' | 'team' | 'project' | 'entity' | 'machine';

export const DISCOVERY_ORDER: readonly DiscoveryLevel[] = ['seat', 'team', 'project', 'entity', 'machine'];

/** One launcher home: its level and the parsed files it holds (filename → parsed value). */
export type LauncherHome = { level: DiscoveryLevel; files: Record<string, unknown> };

export type DiscoveredLauncher = { def: LauncherDefinition; level: DiscoveryLevel; file: string };

export type Discovery = {
  launchers: Map<string, DiscoveredLauncher>;
  diagnostics: Diagnostic[];
};

/**
 * Validates every file of every home and folds them nearest-first. Two definitions of one
 * name at the same level refuse that level's copies (E_NAME_DUP); a name at two levels
 * resolves to the nearer one with W_SHADOWED.
 */
export function discover(homes: readonly LauncherHome[]): Discovery {
  const launchers = new Map<string, DiscoveredLauncher>();
  const diagnostics: Diagnostic[] = [];
  const ordered = DISCOVERY_ORDER.map((level) => homes.find((home) => home.level === level)).filter(
    (home): home is LauncherHome => home !== undefined,
  );
  for (const home of ordered) {
    const seenHere = new Map<string, string>();
    for (const [file, raw] of Object.entries(home.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const { def, diagnostics: fileDiagnostics } = validateDefinition(raw, { file, level: home.level });
      diagnostics.push(...fileDiagnostics);
      if (def === null) continue;
      const earlierFile = seenHere.get(def.name);
      if (earlierFile !== undefined) {
        diagnostics.push({
          code: 'E_NAME_DUP',
          severity: 'error',
          level: home.level,
          file,
          launcher: def.name,
          message: `"${def.name}" is defined twice at level ${home.level} (${earlierFile} and ${file}); the level's copies are refused`,
        });
        launchers.delete(def.name);
        continue;
      }
      seenHere.set(def.name, file);
      const existing = launchers.get(def.name);
      if (existing !== undefined) {
        diagnostics.push({
          code: 'W_SHADOWED',
          severity: 'warning',
          level: home.level,
          file,
          launcher: def.name,
          message: `"${def.name}" at level ${home.level} (${file}) is shadowed by level ${existing.level} (${existing.file})`,
        });
        continue;
      }
      launchers.set(def.name, { def, level: home.level, file });
    }
  }
  return { launchers, diagnostics };
}

/** How one harness turns provider facts into environment entries. The harness owns this
 *  mapping; a harness with no documented provider route refuses the endpoint. Verified
 *  against official docs 2026-11-05 (design note §8). */
export const PROVIDER_ENV_ROUTES: Record<string, { baseUrlVar: string; tokenVar: string; modelVar: string; contextWindowVar?: string } | null> = {
  'claude-code': {
    baseUrlVar: 'ANTHROPIC_BASE_URL',
    tokenVar: 'ANTHROPIC_AUTH_TOKEN',
    modelVar: 'ANTHROPIC_MODEL',
    contextWindowVar: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  },
  // codex's custom providers accept wire_api "responses" only per the current config
  // reference; the chat-completions endpoints the alternate providers expose do not apply.
  codex: null,
};

const ARG_CLASS_FLAGS: [RegExp, ArgClass][] = [
  [/^(--model|-m)$/, 'model'],
  [/^--settings$/, 'settings'],
  [/^(--resume|--session-id|-r|--continue|resume)$/, 'resume'],
  [/^(--mcp-config|--strict-mcp-config)$/, 'mcp'],
  [/^(--effort|--reasoning-effort)$/, 'effort'],
];

/** The class one argv word belongs to; a flag's *value* word inherits the flag's class. */
export function classifyArgs(args: readonly string[]): { word: string; cls: ArgClass }[] {
  const out: { word: string; cls: ArgClass }[] = [];
  let carry: ArgClass | null = null;
  for (const word of args) {
    if (carry !== null) {
      out.push({ word, cls: carry });
      carry = null;
      continue;
    }
    const found = ARG_CLASS_FLAGS.find(([pattern]) => pattern.test(word));
    if (found !== undefined) {
      out.push({ word, cls: found[1] });
      carry = found[1];
    } else if (word.startsWith('--model=')) {
      out.push({ word, cls: 'model' });
    } else if (word.startsWith('--settings=')) {
      out.push({ word, cls: 'settings' });
    } else {
      out.push({ word, cls: 'other' });
    }
  }
  return out;
}

export type ResolveContext = {
  /** Absolute paths the placeholders expand to. */
  teamRoot: string;
  teamHome: string;
  cwd: string;
  inbox?: string;
  /** The TeamCLI session argument, when `team up` passes one. */
  sessionArg?: string;
  /** The parent process environment, as explicit input (never read from process.env). */
  parentEnv?: Record<string, string>;
  /** Paths that exist on this machine (for executable / resume-state checks). */
  existingPaths?: readonly string[];
  /** `.git` directories of linked repositories the seat commits into. */
  gitDirs?: string[];
  /** The sandbox setup outcome, when the harness has a setup step. */
  sandboxSetup?: 'ok' | 'failed';
  sandboxSetupReason?: string;
  /** Seat names and nicknames of the team, for the collision warning. */
  seatNames?: readonly string[];
  /** D3's lowest settings layer: the profile defaults, as explicit input. The core reads no
   *  profile file; this is the whole of the defaults. */
  settingsDefaults?: Record<string, JsonValue>;
};

const PLACEHOLDER_RE = /\{(root|team-home|cwd|inbox|session)\}/g;

function expand(word: string, ctx: ResolveContext): string {
  return word.replace(PLACEHOLDER_RE, (whole, name: string) => {
    switch (name) {
      case 'root': return ctx.teamRoot;
      case 'team-home': return ctx.teamHome;
      case 'cwd': return ctx.cwd;
      case 'inbox': return ctx.inbox ?? whole;
      case 'session': return ctx.sessionArg ?? whole;
      default: return whole;
    }
  });
}

function envEntries(env: Record<string, EnvValue> | undefined): ResolvedEnv[] {
  return Object.entries(env ?? {}).map(([name, value]) =>
    typeof value === 'string' ? { name, value } : { name, secret: value.secret as SecretRef },
  );
}

function policyFor(def: LauncherDefinition, cls: ArgClass): ArgPolicy {
  return def.arg_policy?.[cls] ?? 'pass_through';
}

/**
 * Resolves a seat's launch reference against discovered launchers. The chain is
 * seat → preset? → endpoint? → identity?, depth ≤ 3, exactly one terminal. The result's
 * argv is an array — no shell string is ever built — and its env carries secret
 * references unresolved.
 */
export function resolveLaunch(
  seat: SeatLaunchRef,
  discovery: Discovery,
  ctx: ResolveContext,
): ResolvedLaunch {
  const diagnostics: Diagnostic[] = [...discovery.diagnostics.filter((d) => d.severity === 'error')];
  const fail = (message: string, code: string): ResolvedLaunch => {
    diagnostics.push({ code, severity: 'error', launcher: seat.launcher, message });
    return {
      ok: false, harness: '', executable: '', argv: [], env: [], cwd: ctx.cwd, settings: {},
      resume: { kind: 'none' },
      sandbox: { harness: '', mechanism: '', folders: [] },
      chain: [], diagnostics,
    };
  };

  // Walk the reference chain with cycle detection. The kind rules make cycles unreachable
  // (an endpoint's prefix is checked to be an identity, which has no outgoing reference;
  // a preset's base is checked to be an identity or endpoint, and the endpoint's own
  // outgoing reference is again constrained to an identity) — the check stays as a guard.
  const chain: LauncherDefinition[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = seat.launcher;
  let expectNext: 'identity' | 'identity-or-endpoint' | null = null;
  while (cursor !== undefined) {
    if (seen.has(cursor)) return fail(`reference cycle at "${cursor}"`, 'E_REF_CYCLE');
    seen.add(cursor);
    const found: DiscoveredLauncher | undefined = discovery.launchers.get(cursor);
    if (found === undefined) return fail(`no launcher named "${cursor}" in any home`, 'E_REF_UNKNOWN');
    const def: LauncherDefinition = found.def;
    if (expectNext === 'identity' && def.kind !== 'identity') {
      return fail(`"${cursor}" is a ${def.kind}: an endpoint's prefix is an identity launcher`, 'E_REF_KIND');
    }
    if (expectNext === 'identity-or-endpoint' && def.kind !== 'identity' && def.kind !== 'endpoint') {
      return fail(`"${cursor}" is a ${def.kind}: a preset's base is an identity or endpoint launcher`, 'E_REF_KIND');
    }
    if (expectNext === null && def.kind === 'identity') {
      return fail(`"${cursor}" is an identity launcher: it is a prefix, never a terminal`, 'E_REF_KIND');
    }
    chain.push(def);
    if (def.kind === 'identity' || def.kind === 'custom') break;
    if (def.kind === 'endpoint') {
      cursor = def.prefix;
      expectNext = 'identity';
    } else {
      cursor = def.base;
      expectNext = 'identity-or-endpoint';
    }
  }
  if (chain.length > 3) return fail(`the chain ${chain.map((d) => d.name).join(' → ')} is deeper than 3`, 'E_REF_CYCLE');

  const terminal = chain[0] as LauncherDefinition;
  if (ctx.seatNames?.includes(terminal.name) === true) {
    diagnostics.push({
      code: 'W_NAME_COLLIDES_SEAT',
      severity: 'warning',
      launcher: terminal.name,
      message: `launcher "${terminal.name}" shares its name with a seat or nickname; the launcher: key keeps them unambiguous, the collision is recorded`,
    });
  }

  // Harness and executable.
  const harness = terminal.kind === 'custom' ? 'custom' : (terminal.harness ?? '');
  if (terminal.kind !== 'custom' && !(harness in SANDBOX_CAPABILITIES)) {
    return fail(`harness "${harness}" is not a known CLI profile`, 'E_HARNESS_UNKNOWN');
  }
  let executable = '';
  if (terminal.kind === 'custom') {
    executable = expand((terminal.argv as string[])[0] ?? '', ctx);
  } else if (terminal.executable !== undefined) {
    executable = expand(terminal.executable, ctx);
    if (ctx.existingPaths === undefined) {
      diagnostics.push({
        code: 'W_EXECUTABLE_UNVERIFIED',
        severity: 'warning',
        launcher: terminal.name,
        message: `pinned executable ${executable} is declared but unchecked: no host checker was supplied (pure static resolution, no filesystem probe)`,
      });
    } else if (!ctx.existingPaths.includes(executable)) {
      diagnostics.push({
        code: 'W_EXECUTABLE_MISSING',
        severity: 'warning',
        launcher: terminal.name,
        message: `pinned executable ${executable} is absent on this host (a restore does not keep it); falling back to the harness's PATH binary`,
      });
      executable = harness;
    }
  } else {
    executable = harness;
  }

  // Environment: identity first, then provider facts (harness-owned route), then the
  // terminal's own env. Later layers win per variable; every override is a diagnostic
  // that names the variable and never the value.
  const env = new Map<string, ResolvedEnv>();
  const putEnv = (entries: ResolvedEnv[], from: string): void => {
    for (const entry of entries) {
      if (env.has(entry.name)) {
        diagnostics.push({
          code: 'W_ENV_OVERRIDE',
          severity: 'warning',
          launcher: terminal.name,
          message: `${from} overrides the environment variable ${entry.name} set by an earlier layer`,
        });
      }
      env.set(entry.name, entry);
    }
  };
  const identityLayer = chain.find((d) => d.kind === 'identity');
  const endpointLayer = chain.find((d) => d.kind === 'endpoint');
  if (identityLayer !== undefined) putEnv(envEntries(identityLayer.env), `identity "${identityLayer.name}"`);
  if (endpointLayer?.provider !== undefined) {
    const route = PROVIDER_ENV_ROUTES[harness];
    if (route === null || route === undefined) {
      return fail(
        `harness "${harness}" has no documented provider env route for endpoint "${endpointLayer.name}" (design note §8: codex custom providers are Responses-only)`,
        'E_PROVIDER_UNSUPPORTED',
      );
    }
    const provider = endpointLayer.provider;
    const providerEnv: ResolvedEnv[] = [
      { name: route.baseUrlVar, value: provider.base_url },
      { name: route.tokenVar, secret: provider.token },
      { name: route.modelVar, value: provider.models.default },
    ];
    if (provider.context_window !== undefined && route.contextWindowVar !== undefined) {
      providerEnv.push({ name: route.contextWindowVar, value: String(provider.context_window) });
    }
    putEnv(providerEnv, `provider "${provider.name}"`);
    putEnv(envEntries(provider.extra_env), `provider "${provider.name}" extra env`);
  }
  if (terminal.kind !== 'custom') putEnv(envEntries(terminal.env), `${terminal.kind} "${terminal.name}"`);
  else putEnv(envEntries(terminal.env), `custom "${terminal.name}"`);

  // Launch environment contract: scrub keeps only the keep list plus the launcher's own
  // env; inherit passes the parent environment through underneath.
  const envPolicy = terminal.env_policy ?? { mode: 'inherit' as const };
  const baseEnv: ResolvedEnv[] = [];
  if (envPolicy.mode === 'inherit') {
    for (const [name, value] of Object.entries(ctx.parentEnv ?? {})) baseEnv.push({ name, value });
  } else {
    for (const name of envPolicy.keep ?? []) {
      const value = ctx.parentEnv?.[name];
      if (value !== undefined) baseEnv.push({ name, value });
    }
  }
  const merged = new Map<string, ResolvedEnv>();
  for (const entry of baseEnv) merged.set(entry.name, entry);
  for (const [name, entry] of env) {
    if (merged.has(name)) {
      diagnostics.push({
        code: 'W_ENV_OVERRIDE',
        severity: 'warning',
        launcher: terminal.name,
        message: `the launcher overrides the inherited environment variable ${name}`,
      });
    }
    merged.set(name, entry);
  }

  // Settings merge (D1–D7): one object from the profile defaults, the endpoint layer, the
  // preset layer and — only under arg_policy.settings: merge — the caller's inline JSON.
  // An inline --settings JSON object folds into that object and leaves argv: a merged
  // result never coexists with a stale contradictory flag. A file-valued fixed word stays
  // byte-for-byte (the pure core never reads a file). `custom` terminals are exempt: their
  // argv is verbatim by contract.
  const caller = classifyArgs(seat.args ?? []);
  const settingsPolicy = policyFor(terminal, 'settings');
  const callerHasSettings = caller.some((arg) => arg.cls === 'settings');
  // D6 override: the caller's settings words replace the launcher's fixed settings-class
  // args entirely — excluded from argv and from the fold, while data layers still fold.
  const fixedSettingsExcluded = settingsPolicy === 'override' && callerHasSettings;
  let settingsObject: Record<string, JsonValue> = {};
  let settingsFileWordCount = 0;
  const fixedPlans = new Map<LauncherDefinition, { entries: { word: string; cls: ArgClass }[]; spans: SettingsSpan[] }>();
  const planFor = (def: LauncherDefinition): { entries: { word: string; cls: ArgClass }[]; spans: SettingsSpan[] } => {
    const cached = fixedPlans.get(def);
    if (cached !== undefined) return cached;
    const entries = classifyArgs(def.kind === 'custom' ? (def.argv ?? []).slice(1) : (def.args ?? []));
    const plan = { entries, spans: settingsSpans(entries, 'fixed') };
    fixedPlans.set(def, plan);
    return plan;
  };
  const foldLayer = (name: string, object: Record<string, JsonValue>): void => {
    settingsObject = mergeSettingsObject(settingsObject, object, (path) => {
      diagnostics.push({
        code: 'W_SETTINGS_OVERRIDE',
        severity: 'warning',
        launcher: terminal.name,
        message: `the settings key ${path} is overridden by the ${name} layer`,
      });
    });
  };
  const failIssues = (issues: SettingsIssue[]): ResolvedLaunch =>
    fail(issues[0]?.message ?? 'the settings object is invalid', issues[0]?.code ?? 'E_SETTINGS_JSON');
  const foldDefinitionLayer = (def: LauncherDefinition, name: string): ResolvedLaunch | null => {
    if (def.harness_settings !== undefined) {
      const read = readSettingsObject(def.harness_settings, 'harness_settings');
      if (read.value === null) return failIssues(read.issues);
      foldLayer(name, read.value);
    }
    if (fixedSettingsExcluded) return null;
    for (const span of planFor(def).spans) {
      if (span.kind === 'error') return fail(span.message, span.code);
      if (span.kind === 'inline') foldLayer(name, span.object);
      else if (span.kind === 'file') settingsFileWordCount += 1;
    }
    return null;
  };

  if (terminal.kind !== 'custom') {
    if (ctx.settingsDefaults !== undefined) {
      const read = readSettingsObject(ctx.settingsDefaults, 'settingsDefaults');
      if (read.value === null) return failIssues(read.issues);
      foldLayer('profile settings defaults', read.value);
    }
    if (endpointLayer !== undefined) {
      const stopped = foldDefinitionLayer(endpointLayer, `endpoint "${endpointLayer.name}"`);
      if (stopped !== null) return stopped;
    }
    if (terminal.kind === 'preset') {
      const stopped = foldDefinitionLayer(terminal, `preset "${terminal.name}"`);
      if (stopped !== null) return stopped;
    }
    if (settingsPolicy === 'merge') {
      for (const span of settingsSpans(caller, 'caller')) {
        if (span.kind === 'error') return fail(span.message, span.code);
        if (span.kind === 'inline') foldLayer('caller settings', span.object);
      }
    }
  }
  if (Object.keys(settingsObject).length > 0) {
    for (let i = 0; i < settingsFileWordCount; i += 1) {
      diagnostics.push({
        code: 'W_SETTINGS_FILE_TARGET',
        severity: 'warning',
        launcher: terminal.name,
        // The word itself is never echoed: a fixed settings word is caller-authored text and
        // may be credential-shaped, and D2's no-value-echo rule covers diagnostics too.
        message: 'a fixed settings-file word stays in argv; the merged settings object awaits the settings-file adapter (the word is not echoed)',
      });
    }
  }
  if (
    terminal.kind !== 'custom'
    && callerHasSettings
    && (settingsPolicy === 'pass_through' || settingsPolicy === 'override')
    && Object.keys(settingsObject).length > 0
  ) {
    diagnostics.push({
      code: 'W_SETTINGS_SPLIT',
      severity: 'warning',
      launcher: terminal.name,
      message: 'caller --settings words stay in argv while the merged settings object is non-empty: settings reach the harness from two sources',
    });
  }

  // argv: executable + fixed args (chain order, terminal first) + admitted caller args.
  // Folded settings spans and, under D6 override, the whole settings class are absent; every
  // other word keeps its position and its bytes.
  const argv: string[] = [executable];
  const overriddenClasses = new Set<ArgClass>();
  for (const cls of ['model', 'settings', 'resume', 'mcp', 'effort'] as const) {
    if (policyFor(terminal, cls) === 'override' && caller.some((arg) => arg.cls === cls)) overriddenClasses.add(cls);
  }
  for (const def of chain) {
    if (def.kind === 'custom') {
      for (const entry of classifyArgs((def.argv ?? []).slice(1))) argv.push(expand(entry.word, ctx));
      continue;
    }
    const plan = planFor(def);
    const folded = new Set<number>();
    if (!fixedSettingsExcluded) {
      for (const span of plan.spans) {
        if (span.kind !== 'inline') continue;
        for (let i = span.start; i <= span.end; i += 1) folded.add(i);
      }
    }
    plan.entries.forEach((entry, index) => {
      if (folded.has(index)) return;
      if (overriddenClasses.has(entry.cls)) return;
      argv.push(expand(entry.word, ctx));
    });
  }
  for (const arg of caller) {
    if (terminal.kind === 'custom' && (terminal.args_mode ?? 'append') === 'refuse') {
      return fail(`custom launcher "${terminal.name}" refuses caller arguments (args_mode: refuse)`, 'E_ARG_REFUSED');
    }
    if (terminal.kind === 'preset' && (terminal.caller_args ?? 'append') === 'refuse') {
      return fail(`preset "${terminal.name}" refuses caller arguments (caller_args: refuse; its adopted wrapper forwarded none)`, 'E_ARG_REFUSED');
    }
    const policy = policyFor(terminal, arg.cls);
    switch (policy) {
      case 'pass_through':
      case 'override':
        argv.push(expand(arg.word, ctx));
        break;
      case 'merge':
        // A settings-class word under merge was folded as the top layer above and is never
        // an argv word; merge on any other class is refused at validation (E_ARG_POLICY).
        if (arg.cls !== 'settings') argv.push(expand(arg.word, ctx));
        break;
      case 'strip':
        diagnostics.push({
          code: 'W_ARG_STRIPPED',
          severity: 'warning',
          launcher: terminal.name,
          message: `caller argument of class ${arg.cls} stripped by the launcher's arg_policy (fixed args are never stripped)`,
        });
        break;
      case 'refuse':
        return fail(`caller argument "${arg.word}" is of class ${arg.cls}, which launcher "${terminal.name}" refuses`, 'E_ARG_REFUSED');
    }
  }

  // Resume: teamcli_wins beats the preset's resume state whenever TeamCLI passes a session.
  let resume: ResolvedResume = { kind: 'none' };
  const resumeBlock = terminal.kind === 'preset' ? terminal.resume : undefined;
  // Also guard explicit Discovery inputs before caller precedence can mask invalid data.
  if (resumeBlock?.mode === 'fixed' && !isFixedResumeSession(resumeBlock.path)) {
    return fail('fixed needs a nonblank literal session identity without controls or braces', 'E_RESUME_SHAPE');
  }
  if (ctx.sessionArg !== undefined && (resumeBlock?.precedence ?? 'teamcli_wins') === 'teamcli_wins') {
    resume = { kind: 'teamcli', session: ctx.sessionArg };
  } else if (resumeBlock !== undefined) {
    switch (resumeBlock.mode) {
      case 'none':
        resume = { kind: 'none' };
        break;
      case 'inline':
        resume = { kind: 'preset_inline' };
        break;
      case 'fixed':
        resume = { kind: 'preset_fixed', session: resumeBlock.path as string };
        break;
      case 'state_file': {
        const path = expand(resumeBlock.path ?? '', ctx);
        if (ctx.existingPaths === undefined) {
          diagnostics.push({
            code: 'W_RESUME_STATE_UNVERIFIED',
            severity: 'warning',
            launcher: terminal.name,
            message: `resume state ${path} is declared but unchecked: no host checker was supplied (pure static resolution, no filesystem probe)`,
          });
          resume = { kind: 'preset_state_file', path };
        } else if (!ctx.existingPaths.includes(path)) {
          diagnostics.push({
            code: 'W_RESUME_STATE_MISSING',
            severity: 'warning',
            launcher: terminal.name,
            message: `resume state ${path} is absent on this host (a restore does not keep it); the seat launches fresh`,
          });
          resume = { kind: 'none' };
        } else {
          resume = { kind: 'preset_state_file', path };
        }
        break;
      }
    }
  } else if (ctx.sessionArg !== undefined) {
    resume = { kind: 'teamcli', session: ctx.sessionArg };
  }

  // Writable folders and the sandbox verdict.
  const folders = (terminal.writable_folders ?? []).map((entry) => expand(entry.path, ctx));
  const sandboxDiagnostics = checkSandbox({
    harness,
    cwd: ctx.cwd,
    teamRoot: ctx.teamRoot,
    folders,
    ...(ctx.gitDirs !== undefined ? { gitDirs: ctx.gitDirs } : {}),
    ...(ctx.sandboxSetup !== undefined ? { setup: ctx.sandboxSetup } : {}),
    ...(ctx.sandboxSetupReason !== undefined ? { setupReason: ctx.sandboxSetupReason } : {}),
  });
  diagnostics.push(...sandboxDiagnostics);
  const capability = SANDBOX_CAPABILITIES[harness];
  const mechanism = capability !== undefined && 'mechanism' in capability ? capability.mechanism : '';

  const ok = !diagnostics.some((d) => d.severity === 'error');
  return {
    ok,
    harness,
    executable: argv[0] ?? executable,
    argv,
    env: [...merged.values()],
    cwd: (terminal.kind === 'preset' || terminal.kind === 'custom') && terminal.cwd !== undefined ? expand(terminal.cwd, ctx) : ctx.cwd,
    settings: settingsObject,
    resume,
    sandbox: { harness, mechanism, folders },
    chain: chain.map((d) => d.name),
    diagnostics,
  };
}
