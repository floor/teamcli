import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { BudgetAccount, BudgetSource, TeamFile } from '../types.ts';
import { measureSchema, DURATION, PERCENT } from './units.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import { defaultWatch, type Watched } from './watch.ts';

/** What the budgets section hands the rest of the file: its value, and the account names it declares. */
export interface Budgeted {
  budgets: TeamFile['budgets'];
  /** Every name the accounts map writes, whether or not the account itself reads cleanly. */
  declared: Set<string>;
}

export const budgets: Section = {
  name: 'budgets',
  owner: true,
  after: ['watch'],
  validate(entry, ctx) {
    const watched = valueOf<Watched>(ctx, 'watch');
    return readBudgets(entry, ctx.check, watched.watch.quotaMarks, watched.legacyMarks);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      stale_after: measureSchema(DURATION),
      check_every: measureSchema(DURATION),
      marks: { type: 'array', minItems: 1, items: { type: 'number', exclusiveMinimum: 0, maximum: 100 } },
      accounts: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { enum: ['subscription', 'spend'] },
            shared: { type: 'boolean' },
            reserve: measureSchema(PERCENT),
            floor: { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]{1,4})? [A-Z]{3}$' },
            sources: { type: 'array', minItems: 1, items: { enum: ['check', 'status_line'] } },
            check: { type: 'string', pattern: '^\\S+$' },
          },
          required: ['kind'],
          allOf: [
            {
              if: { properties: { kind: { const: 'subscription' } }, required: ['kind'] },
              then: { required: ['reserve'] },
              else: { required: ['floor'] },
            },
          ],
        },
        $comment: 'a subscription has a reserve, a spend account a floor; a spend account never reads a screen',
      },
    },
  },
};

/**
 * The budget values a file that sets none runs with — and, since the section is the owner's, the
 * values a file runs with until the owner approves what it sets instead. No accounts: nothing is
 * budgeted until the owner names one.
 */
export function defaultBudgets(): TeamFile['budgets'] {
  return { staleAfter: 30 * 60, checkEvery: 10 * 60, marks: defaultWatch().quotaMarks, accounts: {} };
}

function readBudgets(
  entry: YamlEntry | undefined,
  check: Check,
  fallbackMarks: number[],
  legacyMarks: boolean,
): Budgeted {
  const base = { ...defaultBudgets(), marks: fallbackMarks };
  if (!entry) return { budgets: base, declared: new Set() };
  const fields = check.fields(entry.value, 'budgets', ['stale_after', 'check_every', 'marks', 'accounts']);
  // Every name the accounts map writes, whether or not the account itself reads cleanly: a seat
  // naming one of these is not also told it named nothing.
  const accounts = fields.get('accounts');
  const declared = new Set(accounts?.value.kind === 'map' ? accounts.value.entries.map((account) => account.key) : []);
  const marks = percentList(fields.get('marks'), 'budgets.marks', check);
  if (marks && legacyMarks) {
    check.warnings.push({ line: fields.get('marks')?.line ?? entry.line, message: 'budgets.marks replaces watch.quota_marks' });
  }
  // A pause of zero is not a pause: it would run the check commands on every pass. Zero falls
  // back to the default like an unmeasurable value — the fail has already invalidated the file.
  const checkEvery = check.measure(fields.get('check_every'), 'budgets.check_every', DURATION, '10m');
  if (checkEvery === 0) {
    check.fail(fields.get('check_every')?.value.line ?? entry.value.line, 'budgets.check_every must be greater than zero');
  }
  return {
    budgets: {
      staleAfter: check.measure(fields.get('stale_after'), 'budgets.stale_after', DURATION, '30m') ?? base.staleAfter,
      checkEvery: checkEvery !== undefined && checkEvery > 0 ? checkEvery : base.checkEvery,
      marks: marks ?? fallbackMarks,
      accounts: readAccounts(fields.get('accounts'), check),
    },
    declared,
  };
}

function percentList(entry: YamlEntry | undefined, name: string, check: Check): number[] | null {
  if (!entry) return null;
  const node = entry.value;
  const numbers = node.kind === 'seq' ? node.items.map((item) => (item.kind === 'scalar' ? item.value : null)) : null;
  if (numbers && numbers.length > 0 && numbers.every((n): n is number => typeof n === 'number' && n > 0 && n <= 100)) return numbers;
  check.fail(node.line, `${name} must be a list of percentages, such as [50, 75, 90]`);
  return null;
}

function readAccounts(entry: YamlEntry | undefined, check: Check): Record<string, BudgetAccount> {
  const accounts: Record<string, BudgetAccount> = {};
  if (!entry) return accounts;
  if (entry.value.kind !== 'map') {
    check.fail(entry.value.line, 'budgets.accounts must be a map');
    return accounts;
  }
  for (const account of entry.value.entries) {
    const fields = check.fields(account.value, `budgets.accounts.${account.key}`, ['kind', 'shared', 'reserve', 'floor', 'sources', 'check']);
    const kind = check.oneOf(fields.get('kind'), `budgets.accounts.${account.key}.kind`, ['subscription', 'spend']);
    if (!kind) {
      check.fail(account.line, `budgets.accounts.${account.key} needs kind`);
      continue;
    }
    const command = check.text(fields.get('check'), `budgets.accounts.${account.key}.check`) ?? null;
    if (command && /\s/.test(command)) {
      check.fail(fields.get('check')?.line ?? account.line, `budgets.accounts.${account.key}.check names one command, with no arguments; use a wrapper`);
    }
    const sources = sourcesOf(fields.get('sources'), account.key, kind, Boolean(command) && !/\s/.test(command ?? ''), check, account.line);
    if (sources.includes('check') && !command) check.fail(account.line, `budgets.accounts.${account.key} needs check`);
    if (command && !/\s/.test(command) && !sources.includes('check')) {
      check.fail(fields.get('check')?.line ?? account.line, `budgets.accounts.${account.key}.check needs sources to list check`);
    }
    const measured = kind === 'subscription'
      ? check.measure(fields.get('reserve'), `budgets.accounts.${account.key}.reserve`, PERCENT, '20%')
      : undefined;
    const reserve = measured !== undefined && measured > 0 && measured <= 100 ? measured : null;
    if (kind === 'subscription' && measured !== undefined && (measured <= 0 || measured > 100)) {
      check.fail(fields.get('reserve')?.line ?? account.line, `budgets.accounts.${account.key}.reserve must be a percentage above 0 and at most 100, such as 20%`);
    }
    if (kind === 'subscription' && !fields.get('reserve')) check.fail(account.line, `budgets.accounts.${account.key} needs reserve`);
    if (kind === 'spend' && fields.get('reserve')) check.fail(fields.get('reserve')?.line ?? account.line, 'a spend account has a floor, not a reserve');
    const floor = kind === 'spend' ? money(fields.get('floor'), account.key, check) : null;
    if (kind === 'spend' && !fields.get('floor')) check.fail(account.line, `budgets.accounts.${account.key} needs floor`);
    if (kind === 'subscription' && fields.get('floor')) check.fail(fields.get('floor')?.line ?? account.line, 'a subscription has a reserve, not a floor');
    accounts[account.key] = {
      kind,
      shared: check.flag(fields.get('shared'), `budgets.accounts.${account.key}.shared`),
      reserve,
      floor,
      sources,
      check: command,
    };
  }
  return accounts;
}

function sourcesOf(
  entry: YamlEntry | undefined,
  account: string,
  kind: 'subscription' | 'spend',
  hasCheck: boolean,
  check: Check,
  line: number,
): BudgetSource[] {
  if (!entry) {
    if (hasCheck) return ['check'];
    if (kind === 'subscription') return ['status_line'];
    check.fail(line, `budgets.accounts.${account} needs check`);
    return [];
  }
  const items = check.list(entry, `budgets.accounts.${account}.sources`);
  if (items.length === 0) {
    check.fail(entry.line, `budgets.accounts.${account} needs a source`);
    return [];
  }
  const sources: BudgetSource[] = [];
  for (const item of items) {
    if (item.value !== 'check' && item.value !== 'status_line') {
      check.fail(item.line, `budgets.accounts.${account}.sources must be check or status_line`);
      continue;
    }
    if (kind === 'spend' && item.value === 'status_line') {
      check.fail(item.line, 'a spend account never reads a screen');
      continue;
    }
    if (sources.includes(item.value)) check.fail(item.line, `budgets.accounts.${account}.sources lists ${item.value} twice`);
    else sources.push(item.value);
  }
  return sources;
}

function money(entry: YamlEntry | undefined, account: string, check: Check): { amount: number; currency: string } | null {
  if (!entry) return null;
  const raw = entry.value.kind === 'scalar' ? entry.value.raw : '';
  const match = /^([0-9]+(?:\.[0-9]{1,4})?) ([A-Z]{3})$/.exec(raw);
  if (!match || match[1] === undefined || match[2] === undefined) {
    check.fail(entry.line, `budgets.accounts.${account}.floor is an amount and a currency, such as 5 USD`);
    return null;
  }
  return { amount: Number(match[1]), currency: match[2] };
}
