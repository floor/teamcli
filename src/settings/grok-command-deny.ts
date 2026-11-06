// Pure adapter inputs. The caller supplies the seat's folder when it places a config; none of
// these generators reads or writes a CLI home or guesses a shared launch folder.
export const GROK_COMMAND_DENY_VALUES = ['off', 'git', 'git-and-tests'] as const;
export type GrokCommandDeny = (typeof GROK_COMMAND_DENY_VALUES)[number];

export function parseGrokCommandDeny(raw: unknown): GrokCommandDeny | null {
  return typeof raw === 'string' && (GROK_COMMAND_DENY_VALUES as readonly string[]).includes(raw)
    ? raw as GrokCommandDeny : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cursorCommandDenyRules(mode: GrokCommandDeny): string[] {
  if (mode === 'off') return [];
  return mode === 'git' ? ['Shell(git)'] : ['Shell(git)', 'Shell(bun test)'];
}

/** Merge only the requested denies. A malformed prior config is refused, never replaced with
 *  an empty one. `off` contributes nothing and never removes a deny another setting installed. */
export function cursorCommandDenyConfig(mode: GrokCommandDeny, original: unknown = {}): Record<string, unknown> {
  if (!object(original)) throw new Error('the Cursor CLI config must be an object');
  const permissions = original.permissions;
  if (permissions !== undefined && !object(permissions)) throw new Error('Cursor permissions must be an object');
  for (const key of ['allow', 'deny']) {
    const rules = permissions?.[key];
    if (rules !== undefined && (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))) {
      throw new Error(`Cursor permissions.${key} must be a list of strings`);
    }
  }
  if (mode === 'off') return { ...original };
  const deny = permissions?.deny as string[] | undefined;
  return {
    ...original,
    permissions: { ...permissions, deny: [...new Set([...(deny ?? []), ...cursorCommandDenyRules(mode)])] },
  };
}

/** Repeatable native Grok launch options. Each argument is a separate word; the launcher must
 *  place and quote them as CLI options, never concatenate them after a positional delimiter. */
export function grokCommandDenyArgs(mode: GrokCommandDeny): string[] {
  if (mode === 'off') return [];
  const rules = ['Bash(git)', 'Bash(git *)'];
  if (mode === 'git-and-tests') rules.push('Bash(bun test)', 'Bash(bun test *)');
  return rules.flatMap((rule) => ['--deny', rule]);
}
