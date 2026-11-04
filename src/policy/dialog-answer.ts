// Load-time rules for `seat.dialog.answer`. The watchdog never answers a dialog. This is
// the catalogue the later dialog step reads: release default answers nothing, a lower level
// may only drop a scope, and a loosening needs a fresh owner proof.

import { normalize, sep } from 'node:path';
import { resolvePolicy } from './resolve.ts';
import { parseDialogAnswer, type Policy, type PolicyLevel } from './types.ts';

export type DialogAnswer = {
  trust: readonly string[];
  permission: readonly string[];
  login: 'never';
};

export type DialogLevel = {
  value: readonly string[];
  proofAt?: string;
  expiry?: string | null;
};

/** A trust folder is one of the entity's roots, or a folder inside one. */
export function trustInside(folder: string, roots: readonly string[]): boolean {
  const clean = normalize(folder);
  if (clean.split(sep).includes('..')) return false;
  return roots.some((root) => {
    const base = normalize(root);
    const prefix = base.endsWith(sep) ? base : base + sep;
    return clean === base || clean.startsWith(prefix);
  });
}

function interpret(tokens: readonly string[]): DialogAnswer {
  return {
    trust: tokens.filter((token) => token.startsWith('trust:')).map((token) => token.slice('trust:'.length)),
    permission: tokens.filter((token) => token.startsWith('permission:')).map((token) => token.slice('permission:'.length)),
    login: 'never',
  };
}

/** Resolves the chain. A trust folder outside the entity's roots is refused before the chain
 *  runs. Login set to anything, or any other class, is not a value. */
export function loadDialogAnswer(input: {
  now: Date;
  roots: readonly string[];
  levels: Partial<Record<PolicyLevel, DialogLevel>>;
}): { ok: true; answer: DialogAnswer } | { ok: false; why: string } {
  const declarations: Policy[] = [];
  for (const level of ['entity', 'project', 'team', 'seat'] as const) {
    const declared = input.levels[level];
    if (declared === undefined) continue;
    const parsed = parseDialogAnswer([...declared.value]);
    if (parsed === null) return { ok: false, why: 'login is never, and no other class is a value' };
    for (const token of parsed) {
      if (!token.startsWith('trust:')) continue;
      if (!trustInside(token.slice('trust:'.length), input.roots)) {
        return { ok: false, why: `${level}: a trust folder is outside the entity's roots` };
      }
    }
    declarations.push({
      name: 'seat.dialog.answer',
      value: parsed,
      level,
      setter: 'owner',
      date: input.now.toISOString(),
      expiry: declared.expiry ?? null,
      kind: 'enforced',
      ...(declared.proofAt === undefined ? {} : { proofAt: declared.proofAt }),
    });
  }
  const resolved = resolvePolicy<readonly string[]>('seat.dialog.answer', declarations, { now: input.now });
  if (!resolved.ok) return { ok: false, why: resolved.refusals[0]?.message ?? 'refused at load' };
  const value = resolved.effective.value;
  if (!Array.isArray(value)) return { ok: false, why: 'the value is not a list' };
  return { ok: true, answer: interpret(value) };
}
