// The machine's own accounts: the subscriptions the owner pays for, read once from the owner's
// config, and the account each seat draws on — decided by the seat's CLI and launcher, never by
// the vendor string a file happens to carry. Read-only like the rest of the information layer:
// this writes nothing, runs nothing and opens no pane.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, type YamlNode } from '../yaml.ts';

/** The owner's subscriptions, one file for the machine: `<home>/.config/team/accounts.yaml`,
 *  a `accounts:` list of account names. Every team on the machine draws on it, and a team
 *  file's own `budgets.accounts` overrides an entry of the same name. */
export function machineAccountsPath(home: string): string {
  return join(home, '.config', 'team', 'accounts.yaml');
}

/** The machine's account names, sorted, or [] when the file is absent or does not read as one
 *  `accounts:` list. The file is the owner's own; a file that does not read as the list reads
 *  as no machine accounts — every team's own `budgets.accounts` still counts. */
export function machineAccountsOf(home: string): string[] {
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
  if (accounts === undefined || accounts.value.kind !== 'seq') return [];
  const names: string[] = [];
  for (const item of accounts.value.items) {
    if (item.kind !== 'scalar' || typeof item.value !== 'string' || item.value.length === 0) continue;
    if (!names.includes(item.value)) names.push(item.value);
  }
  return names.sort();
}

/** The seat-shaped input the mapping reads: the four fields it needs off a `Seat`. */
export type SeatLike = { cli: string; launch: string; account?: string; vendor: string };

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
      // One subscription; its pools (Gemini on the one hand, Claude/GPT on the other) are the
      // vendor's own split of the same account, and no CLI screen reports a figure for either.
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
