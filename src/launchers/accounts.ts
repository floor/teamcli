// Provider launch accounts (specs/accounts-and-gates.md §3.3): one file per entity,
// `<home>/.config/team/entities/<entity>/accounts.yaml`, outside every repository. A seat on the
// claude-code launcher names one with `account:` (or, when it names none, its vendor), and the
// account says where the CLI connects, which keychain item holds the key, and which models and
// limits apply. The file holds no secret: only the item's name. It is read as the launch is
// planned; a file that is a link, writable by others, or unreadable is not used.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, toValue } from '../yaml.ts';

export type LaunchAccount = {
  name: string;
  provider: string;
  endpoint: string;
  keychain: string;
  defaultModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  fableModel?: string;
  subagentModel?: string;
  effortDefault?: string;
  autoCompactWindow?: number;
  maxContextTokens?: number;
  timeoutMs?: number;
};

/** Vendor words seats already carry, mapped to the spec's provider account names. */
const VENDOR_ACCOUNT: Readonly<Record<string, string>> = { deepseek: 'deepseek', moonshot: 'kimi', kimi: 'kimi', zai: 'glm', glm: 'glm' };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_WORD = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\/-]*)?$/;
const MODEL_WORD = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

export function launchAccountsPath(home: string, entity: string): string {
  return join(home, '.config', 'team', 'entities', entity, 'accounts.yaml');
}

/** The account a seat launches with, or null when the entity's file names none for it.
 *  `named` is the seat's own `account:`; without one, its vendor picks the account. */
export function launchAccountFor(home: string, entity: string | null | undefined, named: string | undefined, vendor: string | undefined): LaunchAccount | null {
  if (entity === null || entity === undefined || !NAME.test(entity)) return null;
  const key = named ?? (vendor === undefined ? undefined : VENDOR_ACCOUNT[vendor]);
  if (key === undefined) return null;
  const all = readAccounts(launchAccountsPath(home, entity));
  return all[key] ?? null;
}

function readAccounts(path: string): Record<string, LaunchAccount> {
  let text: string;
  try {
    const info = lstatSync(path);
    // Never a link, never writable by group or others: what the file names is what a seat runs.
    if (!info.isFile() || (info.mode & 0o022) !== 0) return {};
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let root: unknown;
  try {
    root = toValue(parseYaml(text));
  } catch {
    return {};
  }
  const accounts = (root as { accounts?: unknown } | null)?.accounts;
  if (accounts === null || typeof accounts !== 'object') return {};
  const out: Record<string, LaunchAccount> = {};
  for (const [name, raw] of Object.entries(accounts as Record<string, unknown>)) {
    const found = accountOf(name, raw);
    if (found !== null) out[name] = found;
  }
  return out;
}

function text(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** One account, or null when a required word is missing or not a plain word: every value
 *  ends up on a launch line, so nothing a shell would read twice is accepted. */
function accountOf(name: string, raw: unknown): LaunchAccount | null {
  if (!NAME.test(name) || raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = text(r.provider, NAME);
  const endpoint = text(r.endpoint, URL_WORD);
  const keychain = text(r.keychain, NAME);
  if (provider === undefined || endpoint === undefined || keychain === undefined) return null;
  const account: LaunchAccount = { name, provider, endpoint, keychain };
  const models: [keyof LaunchAccount, string][] = [
    ['defaultModel', 'default_model'], ['opusModel', 'opus_model'], ['sonnetModel', 'sonnet_model'],
    ['haikuModel', 'haiku_model'], ['fableModel', 'fable_model'], ['subagentModel', 'subagent_model'],
  ];
  for (const [field, key] of models) {
    const value = text(r[key], MODEL_WORD);
    if (value !== undefined && value !== '$model') (account as Record<string, unknown>)[field] = value;
  }
  const effort = text(r.effort_default, /^[a-z]+$/);
  if (effort !== undefined) account.effortDefault = effort;
  const window = count(r.auto_compact_window);
  if (window !== undefined) account.autoCompactWindow = window;
  const context = count(r.max_context_tokens);
  if (context !== undefined) account.maxContextTokens = context;
  const timeout = count(r.timeout_ms);
  if (timeout !== undefined) account.timeoutMs = timeout;
  return account;
}
