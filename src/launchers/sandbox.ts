// The per-harness sandbox capability table and the writable-folder check, per the launchers
// design note §10. Each row was verified against the harness's official documentation on
// 2026-11-05; the mechanism string names the documented route. A harness that cannot map a
// declared folder at launch refuses the seat — the design never narrows silently and never
// disables a sandbox to pass.
import type { Diagnostic } from './types.ts';

export type SandboxCapability =
  | { kind: 'supported'; mechanism: string }
  /** Sandbox exists but writes stay inside the workspace; extra folders cannot be granted
   *  at launch per current docs. */
  | { kind: 'workspace_only'; mechanism: string }
  /** No local filesystem sandbox applies (a cloud agent). */
  | { kind: 'unenforced'; mechanism: string }
  | { kind: 'unknown' };

export const SANDBOX_CAPABILITIES: Record<string, SandboxCapability> = {
  // sandbox.filesystem.allowWrite in the generated settings file TeamCLI appends.
  'claude-code': { kind: 'supported', mechanism: 'settings: sandbox.filesystem.allowWrite' },
  // -c sandbox_mode=workspace-write -c sandbox_workspace_write.writable_roots=[...] launch overrides.
  codex: { kind: 'supported', mechanism: 'launch overrides: sandbox_workspace_write.writable_roots' },
  // TeamCLI-written $GROK_HOME/sandbox.toml profile team-seat-<project>-<seat>, read_write entries.
  grok: { kind: 'supported', mechanism: 'teamcli profile file: read_write entries' },
  // OPENCODE_CONFIG_CONTENT inline JSON: permission.external_directory.
  opencode: { kind: 'supported', mechanism: 'env inline config: permission.external_directory' },
  // Sandboxed commands write the designated workspace only; no extra-path setting documented.
  antigravity: { kind: 'workspace_only', mechanism: '--sandbox (workspace writes only)' },
  // Sandbox grants workspace read/write; extra paths exist only for one-off sandbox runs.
  cursor: { kind: 'workspace_only', mechanism: '--sandbox (workspace writes only)' },
  // -s/--sandbox toggles at launch, but tools.sandboxAllowedPaths lives in settings.json only:
  // no launch flag or documented env var, and a CLI-home edit is out of bounds.
  gemini: { kind: 'workspace_only', mechanism: '-s/--sandbox (extra paths need settings.json: unsupported at launch)' },
  jules: { kind: 'unenforced', mechanism: 'cloud agent; no local filesystem sandbox' },
  // The escape hatch: TeamCLI builds no sandbox config for a custom command; the declared
  // folders are policy the check still measures (worktree coverage included), and the
  // boundary the command enforces is its own.
  custom: { kind: 'unenforced', mechanism: "custom command: the boundary is the command's own" },
  muse: { kind: 'unknown' },
};

/** The default deny entries a grok sandbox profile carries (grok-build-guide §6). */
export const GROK_SANDBOX_DENY: readonly string[] = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'];

export type SandboxContext = {
  /** The seat's working directory (the workspace). */
  cwd: string;
  /** The team's worktree/checkout, already resolved to an absolute path. */
  teamRoot: string;
  /** The harness's name. */
  harness: string;
  /** The resolved writable folders, absolute. */
  folders: string[];
  /** Resolved `.git` directories of linked repositories the seat commits into, when the
   *  caller knows them. Coverage of these is an inference-flagged warning, not an error. */
  gitDirs?: string[];
  /** The outcome of the sandbox setup step (e.g. a profile-file write), when the harness
   *  has one. 'failed' refuses the launch: fail-closed, never an unsandboxed fallback. */
  setup?: 'ok' | 'failed';
  /** Why setup failed, surfaced in the refusal. */
  setupReason?: string;
  /** The folder the launcher kind passed as the sandbox root. A writable folder
   *  outside it is refused. Absent: this check is not applied. */
  sandboxRoot?: string;
};

function covers(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/**
 * Checks a resolved writable-folder set against the harness's capability and the required
 * worktree coverage. Returns diagnostics; any error severity refuses the seat.
 */
export function checkSandbox(ctx: SandboxContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const capability = SANDBOX_CAPABILITIES[ctx.harness] ?? { kind: 'unknown' as const };

  if (ctx.setup === 'failed') {
    diagnostics.push({
      code: 'E_SANDBOX_SETUP',
      severity: 'error',
      message: `sandbox setup failed (${ctx.setupReason ?? 'no reason given'}); the launch is refused — never an unsandboxed fallback`,
    });
    return diagnostics;
  }

  if (capability.kind === 'unknown') {
    diagnostics.push({
      code: 'E_SANDBOX_UNSUPPORTED',
      severity: 'error',
      message: `no verified sandbox mapping for harness "${ctx.harness}"; the seat is refused rather than launched with an unvalidated boundary`,
    });
    return diagnostics;
  }

  // Worktree coverage is a property of an enforceable sandbox. An unenforced harness has no
  // boundary to exclude the worktree from; its verdict is decided above/below instead.
  if (capability.kind === 'supported' || capability.kind === 'workspace_only') {
    const worktreeCovered = ctx.folders.some((folder) => covers(folder, ctx.teamRoot));
    if (!worktreeCovered) {
      diagnostics.push({
        code: 'E_SANDBOX_EXCLUDES_WORKTREE',
        severity: 'error',
        message: `the writable set does not cover the team worktree ${ctx.teamRoot}; team check refuses this seat`,
      });
    }
  }

  if (capability.kind === 'workspace_only') {
    for (const folder of ctx.folders) {
      if (!covers(ctx.cwd, folder) && folder !== ctx.cwd) {
        diagnostics.push({
          code: 'E_SANDBOX_UNSUPPORTED',
          severity: 'error',
          message: `harness "${ctx.harness}" (${capability.mechanism}) cannot map ${folder} outside the workspace at launch; the seat is refused`,
        });
      }
    }
  }

  if (ctx.sandboxRoot !== undefined) {
    const root = ctx.sandboxRoot;
    if (!ctx.folders.some((folder) => covers(folder, root))) {
      diagnostics.push({
        code: 'E_SANDBOX_EXCLUDES_WORKTREE',
        severity: 'error',
        message: `the sandbox does not include ${root}; the launcher kind did not pass it`,
      });
    }
    for (const folder of ctx.folders) {
      if (!covers(root, folder)) {
        diagnostics.push({
          code: 'E_SANDBOX_OUTSIDE_ROOT',
          severity: 'error',
          message: `team check refuses ${folder}: the sandbox root ${root} does not include it`,
        });
      }
    }
  }

  if (capability.kind === 'unenforced') {
    if (ctx.folders.length > 0) {
      diagnostics.push({
        code: 'E_SANDBOX_UNSUPPORTED',
        severity: 'error',
        message: `harness "${ctx.harness}" cannot enforce the ${ctx.folders.length} declared writable folder(s) (${capability.mechanism}); the seat is refused rather than launched with unenforced folders`,
      });
    } else {
      diagnostics.push({
        code: 'W_SANDBOX_UNENFORCED',
        severity: 'warning',
        message: `harness "${ctx.harness}" has no local filesystem sandbox and declares no writable folders (${capability.mechanism})`,
      });
    }
  }

  for (const git of ctx.gitDirs ?? []) {
    if (!ctx.folders.some((folder) => covers(folder, git))) {
      diagnostics.push({
        code: 'W_GIT_STORAGE_UNCOVERED',
        severity: 'warning',
        message: `${git} is outside the writable set; committing from a linked worktree writes the main repository's .git (inference, not vendor-documented)`,
      });
    }
  }

  return diagnostics;
}
