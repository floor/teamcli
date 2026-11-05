// The machine's own accounts: the subscriptions the owner pays for, read once from the owner's
// config, and the account each seat draws on — decided by the seat's CLI and launcher, never by
// the vendor string a file happens to carry. Read-only like the rest of the information layer:
// this writes nothing, runs nothing and opens no pane.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, type YamlNode, type YamlScalar } from '../yaml.ts';

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

/** The plan each account runs on, in the owner's own words: an optional `plans:` map in the same
 *  machine file, keyed by account name (`plans: { google-antigravity: Google AI Ultra }`). No
 *  CLI prints the plan a subscription is on, so this is the one place it comes from — an entry
 *  the owner writes once — and an account with no entry keeps its own name as its label. The map
 *  is empty when the file is absent, does not parse or carries no `plans:` key; an entry that is
 *  no non-empty string is skipped, never guessed. */
export function machinePlansOf(home: string): Map<string, string> {
  const plans = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(machineAccountsPath(home), 'utf8');
  } catch {
    return plans;
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return plans;
  }
  if (root.kind !== 'map') return plans;
  const node = root.entries.find((entry) => entry.key === 'plans')?.value;
  if (node === undefined || node.kind !== 'map') return plans;
  for (const entry of node.entries) {
    if (entry.key === '' || entry.value.kind !== 'scalar' || typeof entry.value.value !== 'string') continue;
    const plan = entry.value.value.trim();
    if (plan !== '') plans.set(entry.key, plan);
  }
  return plans;
}

/** One account's credit figures, as the owner writes them down: the money available to pay usage
 *  past the plan's limit, its currency, and — when the owner wrote them — the monthly overage cap
 *  the credits may be spent to and whether the account reloads its credit automatically. No CLI
 *  prints these figures, so the machine file is the one source; a console page the owner read
 *  them from is never opened by this tool. */
export type MachineCredit = {
  available: number;
  currency: string;
  cap?: number;
  autoReload?: boolean;
};

/** The credits the owner wrote down: an optional top-level `credits:` map in the same machine
 *  file, keyed by account name, each entry a map of `available` (required), `currency` (required,
 *  three letters) and optionally `cap` and `autoReload`
 *  (`credits: { anthropic: { available: 260.50, currency: EUR, cap: 300, autoReload: false } }`).
 *  The map is empty when the file is absent, does not parse or carries no `credits:` map; an
 *  entry that names no available amount or no currency is skipped, never guessed, and an optional
 *  field that is no figure is left out while the rest of the entry still reads. */
export function machineCreditsOf(home: string): Map<string, MachineCredit> {
  const credits = new Map<string, MachineCredit>();
  let text: string;
  try {
    text = readFileSync(machineAccountsPath(home), 'utf8');
  } catch {
    return credits;
  }
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return credits;
  }
  if (root.kind !== 'map') return credits;
  const node = root.entries.find((entry) => entry.key === 'credits')?.value;
  if (node === undefined || node.kind !== 'map') return credits;
  for (const entry of node.entries) {
    if (entry.key === '' || entry.value.kind !== 'map') continue;
    const fields = new Map<string, YamlScalar>();
    for (const field of entry.value.entries) {
      if (field.value.kind === 'scalar') fields.set(field.key, field.value.value);
    }
    const available = fields.get('available');
    const currency = fields.get('currency');
    if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) continue;
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) continue;
    const one: MachineCredit = { available, currency: currency.trim().toUpperCase() };
    const cap = fields.get('cap');
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) one.cap = cap;
    const autoReload = fields.get('autoReload');
    if (typeof autoReload === 'boolean') one.autoReload = autoReload;
    credits.set(entry.key, one);
  }
  return credits;
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

/** The lab whose model a running seat's own line names — its banner or live model text, as the
 *  watch holds it on the pane (`Claude Opus 5.5 default`, `DeepSeek V4.1 Flash default`). The
 *  owner's rule: a seat's lab comes from the model the seat RUNS, never from the CLI's name.
 *  Undefined when the line names no maker this mapping knows: the caller then falls back to what
 *  it knows of the launcher, never to a guess. */
export function labOfRunningModel(line: string | undefined): string | undefined {
  if (line === undefined || line === '') return undefined;
  const text = line.toLowerCase();
  if (/\bdeepseek\b/.test(text)) return 'deepseek';
  if (/\bglm\b|\bzai\b|zhipu/.test(text)) return 'zai';
  if (/\bgrok\b/.test(text)) return 'xai';
  if (/\bgemini\b/.test(text)) return 'google-gemini';
  if (/\bgpt\b|\bcodex\b|\bopenai\b/.test(text)) return 'openai';
  if (/\bmuse\b/.test(text)) return 'meta';
  if (/\bcursor\b/.test(text)) return 'cursor';
  if (/\bclaude\b|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b/.test(text)) return 'anthropic';
  return undefined;
}

/** The lab a claude-family seat's running model names: only a Claude Code seat can run another
 *  maker's model on a subscription its CLI does not name, so only there does the running line
 *  refine the lab. Every other CLI's lab is the subscription that pays it, whatever model text
 *  it shows. */
function runningLabOf(seat: SeatLike, runningModel: string | undefined): string | undefined {
  return seat.cli === 'claude-code' ? labOfRunningModel(runningModel) : undefined;
}

/** The account that pays for a seat: the model it RUNS when its own line names one, else the
 *  CLI it runs and the launcher that runs it — never the vendor string. A seat that names its
 *  own `account:` spends that one, as the counting rule always had it (`budgets/gate.ts:31`);
 *  every other seat maps by its CLI, and a claude-code seat's running model line (its banner or
 *  status row) tells the subscriptions apart before the launcher does. A CLI the mapping does
 *  not know keeps the vendor, so an unmapped CLI is attributed, never dropped. */
export function payingAccountOf(seat: SeatLike, runningModel?: string): string {
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
    case 'claude-code': {
      const running = runningLabOf(seat, runningModel);
      if (running !== undefined) return running;
      // The launcher answers only when the running line names no maker: a stale file's launcher
      // is the last resort, not the first answer.
      if (/\bclaude-glm\.sh\b/.test(seat.launch)) return 'zai';
      if (/\bclaude-deepseek\.sh\b/.test(seat.launch)) return 'deepseek';
      return 'anthropic';
    }
    default:
      return seat.vendor;
  }
}

/** The lab a seat's block belongs under: the running model's lab when its line names one for a
 *  claude-family seat, else the vendor the file records. */
export function labOfSeat(seat: SeatLike, runningModel?: string): string {
  return runningLabOf(seat, runningModel) ?? seat.vendor;
}
