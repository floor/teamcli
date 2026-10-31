// The sign-method value: sparse class choices and monotonically raised proof floors.
// Keep the signed value as a canonical string list, using the existing policy wire shape.
export const SIGN_CLASSES = ['grant', 'revoke', 'publish', 'spend', 'policy', 'go'] as const;
export const SIGN_PROOFS = ['terminal', 'touch-id', 'phone'] as const;
export type SignClass = (typeof SIGN_CLASSES)[number];
export type SignProof = (typeof SIGN_PROOFS)[number];
export type SignMethod = 'none' | SignProof | `any-of(${string})` | `all-of(${string})`;
export type SignChoice = { method?: SignMethod; floor?: SignMethod };
export type SignChoices = Partial<Record<SignClass, SignChoice>>;

function items(raw: unknown): string[] | null {
  const inputs = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (inputs === null || inputs.length === 0) return null;
  const out: string[] = [];
  for (const input of inputs) {
    if (typeof input !== 'string') return null;
    let start = 0;
    let depth = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '(' && ++depth > 1) return null;
      if (input[i] === ')' && --depth < 0) return null;
      if (input[i] === ',' && depth === 0) {
        out.push(input.slice(start, i).trim());
        start = i + 1;
      }
    }
    if (depth !== 0) return null;
    out.push(input.slice(start).trim());
  }
  return out.some((part) => part === '') ? null : out;
}

function methodOf(raw: string, floor: boolean): SignMethod | null {
  if (raw === 'none') return floor ? null : 'none';
  if ((SIGN_PROOFS as readonly string[]).includes(raw)) return raw as SignProof;
  const match = /^(any-of|all-of)\(([^()]*)\)$/.exec(raw);
  if (match === null) return null;
  const members = match[2]!.split(',').map((value) => value.trim());
  if (members.length < 2) return null;
  if (!members.every((value) => (SIGN_PROOFS as readonly string[]).includes(value))) return null;
  return `${match[1]}(${members.sort((a, b) => SIGN_PROOFS.indexOf(a as SignProof) - SIGN_PROOFS.indexOf(b as SignProof)).join(', ')})` as SignMethod;
}

/** Each alternative is one set of proofs that can complete the method. */
export function signMethodAlternatives(method: SignMethod): readonly (readonly SignProof[])[] {
  if (method === 'none') return [[]];
  if ((SIGN_PROOFS as readonly string[]).includes(method)) return [[method as SignProof]];
  const members = [...new Set(method.slice(method.indexOf('(') + 1, -1).split(',').map((part) => part.trim() as SignProof))];
  return method.startsWith('any-of(') ? members.map((proof) => [proof]) : [members];
}

/** The same implication defines method satisfaction and floor raising. */
export function signMethodSatisfies(method: SignMethod, floor: SignMethod | undefined): boolean {
  if (floor === undefined) return true;
  return signMethodAlternatives(method).every((alternative) =>
    signMethodAlternatives(floor).some((required) => required.every((proof) => alternative.includes(proof))),
  );
}

function choicesOf(value: readonly string[]): SignChoices {
  const out: SignChoices = {};
  for (const item of value) {
    const match = /^([a-z]+)(>=|=)(.*)$/.exec(item)!;
    const action = match[1] as SignClass;
    const choice = out[action] ??= {};
    choice[match[2] === '>=' ? 'floor' : 'method'] = match[3] as SignMethod;
  }
  return out;
}

function canonical(choices: SignChoices): readonly string[] {
  return SIGN_CLASSES.flatMap((action) => {
    const choice = choices[action];
    return [
      ...(choice?.method === undefined ? [] : [`${action}=${choice.method}`]),
      ...(choice?.floor === undefined ? [] : [`${action}>=${choice.floor}`]),
    ];
  });
}

/** Reject unknown words, repeated parts, nested combinations and contradictory local choices. */
export function parseSignMethodValue(raw: unknown): readonly string[] | null {
  const parts = items(raw);
  if (parts === null) return null;
  const choices: SignChoices = {};
  for (const part of parts) {
    const match = /^([a-z]+)\s*(>=|=)\s*(.+)$/.exec(part);
    if (match === null || !(SIGN_CLASSES as readonly string[]).includes(match[1]!)) return null;
    const action = match[1] as SignClass;
    const key = match[2] === '>=' ? 'floor' : 'method';
    const method = methodOf(match[3]!.trim(), key === 'floor');
    const choice = choices[action] ??= {};
    if (method === null || choice[key] !== undefined) return null;
    choice[key] = method;
  }
  for (const choice of Object.values(choices)) {
    if (choice.method !== undefined && !signMethodSatisfies(choice.method, choice.floor)) return null;
  }
  return canonical(choices);
}

export function signMethodValueProblem(raw: unknown): string | null {
  return parseSignMethodValue(raw) !== null ? null
    : 'policy "sign-method" requires distinct class=method or class>=floor items; classes: grant, revoke, publish, spend, policy, go; proofs: terminal, touch-id, phone, any-of or all-of with at least two proofs; none is a method alone and cannot satisfy a floor';
}

/** Keep explicit methods separate from floors so an inherited default cannot become a choice. */
export function inheritSignMethod(higher: readonly string[], lower: readonly string[]): readonly string[] {
  const choices = choicesOf(higher);
  for (const [action, choice] of Object.entries(choicesOf(lower))) {
    choices[action as SignClass] = { ...choices[action as SignClass], ...choice };
  }
  return canonical(choices);
}

/** The resolver hands in the merged lower value, and supplies both levels in any refusal. */
export function signMethodWithin(lower: readonly string[], higher: readonly string[]): boolean {
  return signMethodConflictField(lower, higher) === null;
}

export function signMethodFields(value: readonly string[]): string[] {
  return value.map((item) => item.replace(/(>=|=).*/, (operator) => operator.startsWith('>=') ? '.floor' : '.method'));
}

/** Which inherited field supplies the bound a merged declaration violates. */
export function signMethodConflictField(lower: readonly string[], higher: readonly string[]): string | null {
  const lo = choicesOf(lower);
  const hi = choicesOf(higher);
  for (const action of SIGN_CLASSES) {
    const floor = lo[action]?.floor;
    const inheritedFloor = hi[action]?.floor;
    if (inheritedFloor !== undefined && (floor === undefined || !signMethodSatisfies(floor, inheritedFloor))) return `${action}.floor`;
    const method = lo[action]?.method ?? floor ?? 'terminal';
    if (!signMethodSatisfies(method, floor)) return `${action}.${inheritedFloor === undefined ? 'method' : 'floor'}`;
  }
  return null;
}

export function signMethodWithinProblem(lower: readonly string[], higher: readonly string[]): string | null {
  const lo = choicesOf(lower);
  const hi = choicesOf(higher);
  for (const action of SIGN_CLASSES) {
    const floor = lo[action]?.floor;
    const inheritedFloor = hi[action]?.floor;
    if (inheritedFloor !== undefined && (floor === undefined || !signMethodSatisfies(floor, inheritedFloor))) {
      return `class ${action}: floor ${floor ?? 'absent'} does not raise inherited floor ${inheritedFloor}`;
    }
    const method = lo[action]?.method ?? floor ?? 'terminal';
    if (!signMethodSatisfies(method, floor)) return `class ${action}: method ${method} does not satisfy floor ${floor}`;
  }
  return null;
}

/** Effective defaults are derived, never written into the sparse declaration. */
export function signMethodsOf(value: readonly string[]): Record<SignClass, { method: SignMethod; floor: SignMethod | null }> {
  const choices = choicesOf(value);
  return Object.fromEntries(SIGN_CLASSES.map((action) => [action, {
    method: choices[action]?.method ?? choices[action]?.floor ?? 'terminal',
    floor: choices[action]?.floor ?? null,
  }])) as Record<SignClass, { method: SignMethod; floor: SignMethod | null }>;
}
