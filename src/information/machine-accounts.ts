// The machine's own accounts: the subscriptions the owner pays for, read once from the owner's
// config, and the account each seat draws on — decided by the seat's CLI and launcher, never by
// the vendor string a file happens to carry. Read-only like the rest of the information layer:
// this writes nothing, runs nothing and opens no pane.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, type YamlNode } from '../yaml.ts';

/** The owner's subscriptions, one file for the machine: `<home>/.config/team/accounts.yaml`, an
 *  `accounts:` list of account names — or, since entities, a map from entity to the accounts it
 *  pays for. Every team on the machine draws on it, and a team file's own `budgets.accounts`
 *  overrides an entry of the same name. */
export function machineAccountsPath(home: string): string {
  return join(home, '.config', 'team', 'accounts.yaml');
}

/** One entity's accounts, as the file writes them: the map form's key, or null for the file's
 *  flat `accounts:` list — one unnamed entity, the shape every file had before entities. */
export type EntityAccounts = { entity: string | null; accounts: string[] };

/** The account names one list item set carries: the string scalars, once each, sorted. */
function namesOf(items: readonly YamlNode[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.kind !== 'scalar' || typeof item.value !== 'string' || item.value.length === 0) continue;
    if (!names.includes(item.value)) names.push(item.value);
  }
  return names.sort();
}

/** The machine's accounts keyed by entity, in the file's own order: the `accounts:` map form,
 *  one entry per key whose value is a list of account names (`northwind: [anthropic-max]`).
 *  Two older shapes keep reading exactly as they did: a flat `accounts:` sequence is one unnamed
 *  entity (`entity: null`), and a map entry whose value is no list keeps the older reading — the
 *  key is itself an account name, unnamed. A file that is absent, does not parse, or carries no
 *  `accounts:` key reads as no entities, as before. The ownership rule the reading feeds: the
 *  first entry in this order to claim a name owns it (`ownerEntityOf`). */
export function machineAccountsByEntityOf(home: string): EntityAccounts[] {
  let text: string;
  try {
    text = readFileSync(machineAccountsPath(home), 'utf8');
  } catch {
    return [];
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return [];
  }
  if (root.kind !== 'map') return [];
  const accounts = root.entries.find((entry) => entry.key === 'accounts');
  if (accounts === undefined) return [];
  if (accounts.value.kind === 'seq') {
    const names = namesOf(accounts.value.items);
    return names.length === 0 ? [] : [{ entity: null, accounts: names }];
  }
  if (accounts.value.kind !== 'map') return [];
  const entities: EntityAccounts[] = [];
  let unnamed: EntityAccounts | null = null;
  for (const entry of accounts.value.entries) {
    if (entry.value.kind === 'seq') {
      const names = namesOf(entry.value.items);
      const known = entities.find((one) => one.entity === entry.key);
      if (known === undefined) entities.push({ entity: entry.key, accounts: names });
      else known.accounts = [...new Set([...known.accounts, ...names])].sort();
      continue;
    }
    if (unnamed === null) {
      unnamed = { entity: null, accounts: [] };
      entities.push(unnamed);
    }
    if (!unnamed.accounts.includes(entry.key)) unnamed.accounts.push(entry.key);
  }
  for (const one of entities) one.accounts.sort();
  return entities;
}

/** The machine's account names, sorted, or [] when the file is absent or does not read as one
 *  `accounts:` list. The file is the owner's own; a file that does not read as the list reads
 *  as no machine accounts — every team's own `budgets.accounts` still counts. */
export function machineAccountsOf(home: string): string[] {
  return [...new Set(machineAccountsByEntityOf(home).flatMap((one) => one.accounts))].sort();
}

/** Which entity owns each account, the file's own order deciding a name two entities claim: the
 *  first entry to list it owns it. An unnamed entry (`null`) owns nothing to name — its accounts
 *  are today's unnamed entity, counted and never borrowing. */
export function ownerEntityOf(entities: readonly EntityAccounts[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const one of entities) {
    if (one.entity === null) continue;
    for (const account of one.accounts) if (!owners.has(account)) owners.set(account, one.entity);
  }
  return owners;
}

/** The seat-shaped input the mapping reads: the four fields it needs off a `Seat`. */
export type SeatLike = { cli: string; launch: string; account?: string; vendor: string; model?: string };

export function payingPoolOf(seat: SeatLike): 'gemini' | 'claude-gpt' | undefined {
  if (seat.cli !== 'antigravity' && seat.cli !== 'agy') return undefined;
  if (/gemini/i.test(seat.model ?? '')) return 'gemini';
  if (/claude|gpt|opus|sonnet|haiku/i.test(seat.model ?? '')) return 'claude-gpt';
  return undefined;
}

/** The account that pays for a seat, by the CLI it runs and the launcher that runs it — not the
 *  vendor string. A seat that names its own `account:` spends that one, as the counting rule
 *  always had it (`budgets/gate.ts:31`); every other seat maps by its CLI, and a claude-code
 *  seat's launcher tells the two subscriptions apart. A CLI the mapping does not know keeps the
 *  vendor, so an unmapped CLI is attributed, never dropped. */
export function payingAccountOf(seat: SeatLike): string {
  if (seat.account !== undefined) return seat.account;
  switch (seat.cli) {
    case 'grok':
      return 'xai';
    case 'antigravity':
    case 'agy':
      return 'google-antigravity';
    case 'gemini':
      return 'google-gemini';
    case 'codex':
      return 'openai';
    case 'cursor':
      return 'cursor';
    case 'claude-code':
      if (/\bclaude-glm\.sh\b/.test(seat.launch)) return 'zai';
      if (/\bclaude-deepseek\.sh\b/.test(seat.launch)) return 'deepseek';
      return 'anthropic';
    default:
      return seat.vendor;
  }
}
