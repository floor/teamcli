// The folder a launcher kind passes as the sandbox root. On the first minute the
// workspace is shared, so the root is the project. Worktree mode passes the worktree.
// Slice 3's inside-the-root trust rule is not this function.

const PRESET_CLIS = ['grok', 'cursor', 'claude-code', 'codex'] as const;

export function sandboxRootFor(input: {
  mode: 'shared' | 'worktree';
  projectRoot: string;
  worktree?: string | null;
}): { ok: true; root: string } | { ok: false; problem: string } {
  if (input.mode === 'shared') return { ok: true, root: input.projectRoot };
  if (input.worktree === undefined || input.worktree === null || input.worktree === '') {
    return { ok: false, problem: 'worktree mode has no worktree to pass as the sandbox root' };
  }
  return { ok: true, root: input.worktree };
}

function covers(root: string, folder: string): boolean {
  return folder === root || folder.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** A preset may staff one of the four when doctor --login shows that CLI signed in
 *  and the sandbox root contains the folder. */
export function presetMayStaff(input: {
  cli: string;
  loggedIn: boolean;
  sandboxRoot: string;
  folder: string;
}): boolean {
  if (!(PRESET_CLIS as readonly string[]).includes(input.cli)) return false;
  if (!input.loggedIn) return false;
  return covers(input.sandboxRoot, input.folder);
}
